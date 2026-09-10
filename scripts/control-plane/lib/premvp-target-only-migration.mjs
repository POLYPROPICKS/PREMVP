/**
 * premvp-target-only-migration.mjs
 *
 * Target-only mode for the EXISTING registered PREMVP approved-migration lifecycle
 * (scripts/control-plane/apply-premvp-approved-migration.mjs). It lets exactly one
 * already-reviewed migration be applied when the production Supabase migration ledger is
 * missing historical entries — WITHOUT replaying or repairing any historical migration.
 *
 * How: build a temporary isolated `supabase/migrations/` view containing
 *   (a) exactly the migration files the REMOTE ledger already records (so the CLI stays
 *       consistent and never raises LegacyDbPushMissingLocalError), copied verbatim and
 *       never executed because the CLI sees them as already-applied; plus
 *   (b) exactly the requested target migration — the sole new pending file.
 * Then `supabase db push --linked --dry-run` from that view must report exactly one
 * pending migration and it must be the target. Anything else fails closed.
 *
 * This module is pure: no shell, no network, no fs writes beyond the caller's control.
 * It only plans the view and classifies CLI output.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TARGET_ONLY_MODE = 'PREMVP_APPLICATION_SCHEMA_MIGRATION_TARGET_ONLY';

/** PREMVP production Supabase project refs — the only allowlisted targets. */
export const PREMVP_PRODUCTION_PROJECT_REFS = Object.freeze(['nbnldzfsxffztsfrrxqy']);

// Hashes are computed over LF-normalized content so a migration's pin is stable
// regardless of the checkout's autocrlf setting (matches the git blob hash for text).
export function sha256OfText(text) {
  return crypto.createHash('sha256').update(Buffer.from(String(text).replace(/\r\n/g, '\n'), 'utf8')).digest('hex');
}

export function sha256OfFile(absPath) {
  return sha256OfText(fs.readFileSync(absPath, 'utf8'));
}

/** Validate the target-only fields on the declaration (on top of the base validator). */
export function validateTargetOnlyDeclaration(declaration) {
  const errors = [];
  if (!declaration || typeof declaration !== 'object') return { ok: false, errors: ['DECLARATION_NOT_OBJECT'] };
  if (declaration.target_only !== true) errors.push('TARGET_ONLY_FLAG_REQUIRED');
  const files = declaration.migration_files;
  if (!Array.isArray(files) || files.length !== 1) errors.push('TARGET_ONLY_EXACTLY_ONE_MIGRATION_FILE_REQUIRED');
  else if (!/^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/.test(String(files[0]))) errors.push(`TARGET_ONLY_PATH_INVALID: ${files[0]}`);
  if (typeof declaration.target_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(declaration.target_sha256)) errors.push('TARGET_SHA256_REQUIRED');
  if (!PREMVP_PRODUCTION_PROJECT_REFS.includes(declaration.project_ref)) errors.push('PROJECT_REF_NOT_ALLOWLISTED');
  if (declaration.include_all === true) errors.push('INCLUDE_ALL_FORBIDDEN');
  return { ok: errors.length === 0, errors };
}

/**
 * From `supabase migration list --linked` rows, the version tokens the REMOTE database
 * already records.
 */
export function trackedRemoteVersions(migrationListRows) {
  const list = Array.isArray(migrationListRows)
    ? migrationListRows
    : Array.isArray(migrationListRows?.migrations) ? migrationListRows.migrations : [];
  const out = [];
  for (const r of list) {
    const remote = r?.remote ? String(r.remote) : '';
    if (remote) out.push(remote);
  }
  return [...new Set(out)].sort();
}

/**
 * Map each tracked remote version to the local migration file that provides it. A tracked
 * remote version with no local file is a hard fail (the CLI would raise
 * LegacyDbPushMissingLocalError and we must not guess).
 */
export function resolveTrackedLocalFiles(trackedVersions, migrationsDirAbs) {
  const localFiles = fs.existsSync(migrationsDirAbs)
    ? fs.readdirSync(migrationsDirAbs).filter((f) => f.endsWith('.sql'))
    : [];
  const resolved = [];
  const missing = [];
  for (const version of trackedVersions) {
    const match = localFiles.find((f) => f === `${version}.sql` || f.startsWith(`${version}_`) || f.startsWith(`${version}`));
    if (match) resolved.push(match);
    else missing.push(version);
  }
  return { resolved: [...new Set(resolved)].sort(), missing };
}

/**
 * Materialize the isolated view under `viewRootAbs` (caller owns creation/cleanup):
 *   <viewRootAbs>/supabase/migrations/<trackedFiles...> + <targetBasename>
 * plus the linked-project state copied from <repoRootAbs>/supabase/.temp and config.toml.
 * Returns the list of files placed in the view. Refuses to place any file that is not a
 * tracked-remote file or the exact target.
 */
export function materializeIsolatedView({ repoRootAbs, viewRootAbs, trackedFiles, targetBasename }) {
  const srcMigrations = path.join(repoRootAbs, 'supabase', 'migrations');
  const dstMigrations = path.join(viewRootAbs, 'supabase', 'migrations');
  fs.mkdirSync(dstMigrations, { recursive: true });
  const allowed = new Set([...trackedFiles, targetBasename]);
  const placed = [];
  for (const f of allowed) {
    const src = path.join(srcMigrations, f);
    if (!fs.existsSync(src)) throw new Error(`ISOLATED_VIEW_SOURCE_MISSING: ${f}`);
    fs.copyFileSync(src, path.join(dstMigrations, f));
    placed.push(f);
  }
  const tempSrc = path.join(repoRootAbs, 'supabase', '.temp');
  if (fs.existsSync(tempSrc)) fs.cpSync(tempSrc, path.join(viewRootAbs, 'supabase', '.temp'), { recursive: true });
  const configSrc = path.join(repoRootAbs, 'supabase', 'config.toml');
  if (fs.existsSync(configSrc)) fs.copyFileSync(configSrc, path.join(viewRootAbs, 'supabase', 'config.toml'));
  const onDisk = fs.readdirSync(dstMigrations).sort();
  const unexpected = onDisk.filter((f) => !allowed.has(f));
  if (unexpected.length) throw new Error(`ISOLATED_VIEW_UNEXPECTED_FILE: ${unexpected.join(',')}`);
  return placed.sort();
}

const LEGACY_ERROR_MARKERS = ['LegacyDbPushMissingRemoteError', 'LegacyDbPushMissingLocalError'];
const INCLUDE_ALL_MARKERS = ['--include-all', 'include-all', 'Rerun the command with --include-all'];

/**
 * Classify a `supabase db push --linked --dry-run` result from the isolated view.
 * Passes ONLY when the CLI reports exactly one pending migration and it is the target.
 */
export function classifyTargetOnlyDryRun({ stdout = '', stderr = '', exitCode = 0, targetBasename }) {
  const text = `${stdout}\n${stderr}`;
  if (LEGACY_ERROR_MARKERS.some((m) => text.includes(m))) {
    return { ok: false, verdict: 'LEGACY_DB_PUSH_ERROR', pending: null, reason: LEGACY_ERROR_MARKERS.find((m) => text.includes(m)) };
  }
  if (INCLUDE_ALL_MARKERS.some((m) => text.includes(m))) {
    return { ok: false, verdict: 'INCLUDE_ALL_REQUIRED', pending: null, reason: 'CLI requested --include-all' };
  }
  let parsed = null;
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('{')) { try { parsed = JSON.parse(line); break; } catch { /* keep scanning */ } }
  }
  if (!parsed || !Array.isArray(parsed.migrations)) {
    return { ok: false, verdict: 'DRY_RUN_OUTPUT_UNPARSEABLE', pending: null, reason: `exit ${exitCode}` };
  }
  const pending = parsed.migrations.map(String);
  if (pending.length !== 1) {
    return { ok: false, verdict: 'PENDING_MIGRATION_COUNT_NOT_ONE', pending, reason: `pending=${pending.length}` };
  }
  if (pending[0] !== targetBasename) {
    return { ok: false, verdict: 'PENDING_MIGRATION_NOT_TARGET', pending, reason: pending[0] };
  }
  return { ok: exitCode === 0, verdict: exitCode === 0 ? 'TARGET_ONLY_PENDING_CONFIRMED' : 'DRY_RUN_NONZERO_EXIT', pending, reason: null };
}

/** Guard: an argv passed to `supabase db push` must never carry --include-all. */
export function assertNoIncludeAll(argv) {
  if (Array.isArray(argv) && argv.some((a) => String(a).toLowerCase().replace(/^--/, '') === 'include-all')) {
    throw new Error('TARGET_ONLY_INCLUDE_ALL_FORBIDDEN');
  }
  return true;
}

export function buildTargetOnlyEvidence({ mode, declaration, targetBasename, isolatedFiles, dryRun, applied = false, ledgerAfter = null }) {
  return {
    command_id: 'premvp.command.release_pipeline.v1',
    lifecycle: 'apply-premvp-approved-migration.mjs',
    mode,
    schema: TARGET_ONLY_MODE,
    project_ref: declaration?.project_ref ?? null,
    target_migration: targetBasename,
    target_sha256: declaration?.target_sha256 ?? null,
    isolated_view_file_n: isolatedFiles?.length ?? 0,
    isolated_view_files: isolatedFiles ?? [],
    dry_run_pending: dryRun?.pending ?? null,
    dry_run_verdict: dryRun?.verdict ?? null,
    exactly_one_pending_is_target: dryRun?.ok === true,
    legacy_db_push_error: dryRun?.verdict === 'LEGACY_DB_PUSH_ERROR',
    include_all_required: dryRun?.verdict === 'INCLUDE_ALL_REQUIRED',
    include_all_used: false,
    historical_migration_replayed: false,
    ledger_repair_used: false,
    applied,
    ledger_after: ledgerAfter,
    fail_closed: true,
  };
}
