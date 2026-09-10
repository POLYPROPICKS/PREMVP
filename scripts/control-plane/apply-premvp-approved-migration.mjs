#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAndValidateMigration } from './lib/premvp-application-migration-release.mjs';
import { runDbPushWithFallback, redactSecrets } from './lib/premvp-migration-adapter-connection.mjs';
import { assertCleanMigrationDirectory } from './lib/migration-directory-preflight.mjs';
import { bridgePersistentUserEnv, describeBridge, SUPABASE_ENV_NAMES } from './lib/windows-user-env-bridge.mjs';
import {
  PREMVP_PRODUCTION_PROJECT_REFS,
  validateTargetOnlyDeclaration,
  sha256OfFile,
  trackedRemoteVersions,
  resolveTrackedLocalFiles,
  materializeIsolatedView,
  classifyTargetOnlyDryRun,
  assertNoIncludeAll,
  buildTargetOnlyEvidence,
} from './lib/premvp-target-only-migration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const index = args.indexOf('--declaration');
const raw = index >= 0 ? args[index + 1] : null;
if (!raw) throw new Error('MIGRATION_DECLARATION_REQUIRED');
const declaration = JSON.parse(raw);

// Static migration-directory hygiene — fail closed before any Supabase CLI invocation.
assertCleanMigrationDirectory(root);

// ── target-only mode ───────────────────────────────────────────────────────
// Applies exactly one reviewed migration through an isolated migrations view that
// matches the remote ledger + the single target — no historical replay, no repair,
// no --include-all. See lib/premvp-target-only-migration.mjs.
if (args.includes('--target-only')) {
  await runTargetOnly();
}

async function runTargetOnly() {
  const decl = validateTargetOnlyDeclaration(declaration);
  if (!decl.ok) { fail('TARGET_ONLY_DECLARATION_INVALID', decl.errors); }

  const migrationFileRel = readAndValidateMigration(root, declaration); // reuse the approved-migration validator
  const targetBasename = path.basename(migrationFileRel);
  const targetAbs = path.join(root, migrationFileRel);
  const actualSha = sha256OfFile(targetAbs);
  if (actualSha !== declaration.target_sha256) {
    fail('TARGET_ONLY_HASH_MISMATCH', { expected: declaration.target_sha256, actual: actualSha });
  }

  const bridge = bridgePersistentUserEnv({ names: SUPABASE_ENV_NAMES, baseEnv: process.env });
  const childEnv = bridge.env;
  // Authority = bridged SUPABASE_PROJECT_REF, or the proven linked-project state on disk.
  let linkedRef = null;
  try {
    const linkedPath = path.join(root, 'supabase', '.temp', 'project-ref');
    if (fs.existsSync(linkedPath)) linkedRef = fs.readFileSync(linkedPath, 'utf8').trim() || null;
  } catch { /* ignore */ }
  const observedRef = childEnv.SUPABASE_PROJECT_REF || linkedRef || null;
  if (!observedRef || !PREMVP_PRODUCTION_PROJECT_REFS.includes(observedRef) || observedRef !== declaration.project_ref) {
    fail('TARGET_ONLY_PROJECT_AUTHORITY_MISMATCH', { observed_ref_present: Boolean(observedRef), allowlist: PREMVP_PRODUCTION_PROJECT_REFS });
  }
  const secrets = [childEnv.SUPABASE_DB_PASSWORD, childEnv.SUPABASE_ACCESS_TOKEN, childEnv.SUPABASE_DB_URL].filter(Boolean);
  const sanitize = (t) => redactSecrets(String(t ?? ''), secrets);
  const supa = (cliArgs, cwd) => {
    assertNoIncludeAll(cliArgs);
    try {
      return process.platform === 'win32'
        ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx.cmd', '--yes', 'supabase@latest', ...cliArgs], { cwd, encoding: 'utf8', stdio: 'pipe', env: childEnv })
        : execFileSync('npx', ['--yes', 'supabase@latest', ...cliArgs], { cwd, encoding: 'utf8', stdio: 'pipe', env: childEnv });
    } catch (error) {
      return { __failed: true, stdout: sanitize(error?.stdout || ''), stderr: sanitize(error?.stderr || ''), status: error?.status ?? 1 };
    }
  };
  const firstJson = (text) => {
    for (const l of String(text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      if (l.startsWith('{') || l.startsWith('[')) { try { return JSON.parse(l); } catch { /* keep scanning */ } }
    }
    fail('TARGET_ONLY_MIGRATION_LIST_UNPARSEABLE', sanitize(text).slice(0, 300));
  };

  // 1. remote-ledger-tracked versions -> local files required for CLI consistency
  const listOut = supa(['migration', 'list', '--linked'], root);
  if (listOut && listOut.__failed) fail('TARGET_ONLY_MIGRATION_LIST_FAILED', listOut.stderr.slice(0, 300));
  const tracked = trackedRemoteVersions(firstJson(listOut));
  const { resolved: trackedFiles, missing } = resolveTrackedLocalFiles(tracked, path.join(root, 'supabase', 'migrations'));
  if (missing.length) fail('TARGET_ONLY_REMOTE_TRACKED_FILE_MISSING_LOCALLY', missing);

  // 2. isolated view = tracked files (never executed) + the single target
  const view = fs.mkdtempSync(path.join(os.tmpdir(), 'premvp-target-only-'));
  let isolatedFiles = [];
  try {
    isolatedFiles = materializeIsolatedView({ repoRootAbs: root, viewRootAbs: view, trackedFiles, targetBasename });

    // 3. dry-run gate
    const dryRaw = supa(['db', 'push', '--linked', '--dry-run'], view);
    const dry = classifyTargetOnlyDryRun({
      stdout: dryRaw && dryRaw.__failed ? dryRaw.stdout : String(dryRaw),
      stderr: dryRaw && dryRaw.__failed ? dryRaw.stderr : '',
      exitCode: dryRaw && dryRaw.__failed ? dryRaw.status : 0,
      targetBasename,
    });

    const wantApply = args.includes('--apply');
    if (!dry.ok) {
      const ev = buildTargetOnlyEvidence({ mode: 'dry_run', declaration, targetBasename, isolatedFiles, dryRun: dry });
      process.stdout.write(JSON.stringify({ ok: false, ...ev, env_bridge: describeBridge(bridge) }) + '\n');
      process.exit(2);
    }
    if (!wantApply) {
      const ev = buildTargetOnlyEvidence({ mode: 'dry_run', declaration, targetBasename, isolatedFiles, dryRun: dry });
      process.stdout.write(JSON.stringify({ ok: true, ...ev, env_bridge: describeBridge(bridge) }) + '\n');
      process.exit(0);
    }

    // 4. apply (only when a later mission explicitly gates it)
    if (!args.includes('--confirm') || process.env.PREMVP_TARGET_ONLY_APPLY_CONFIRM !== '1') {
      fail('TARGET_ONLY_APPLY_CONFIRMATION_REQUIRED', 'pass --confirm and set PREMVP_TARGET_ONLY_APPLY_CONFIRM=1');
    }
    const applyRaw = supa(['db', 'push', '--linked', '--yes'], view);
    if (applyRaw && applyRaw.__failed) fail('TARGET_ONLY_APPLY_FAILED', applyRaw.stderr.slice(0, 300));
    const afterList = trackedRemoteVersions(firstJson(supa(['migration', 'list', '--linked'], root)));
    const targetVersion = targetBasename.match(/^\d{14}/)?.[0];
    if (!afterList.includes(targetVersion)) fail('TARGET_ONLY_APPLY_NOT_RECORDED', targetVersion);
    const ev = buildTargetOnlyEvidence({ mode: 'applied', declaration, targetBasename, isolatedFiles, dryRun: dry, applied: true, ledgerAfter: afterList });
    process.stdout.write(JSON.stringify({ ok: true, ...ev, env_bridge: describeBridge(bridge) }) + '\n');
    process.exit(0);
  } finally {
    fs.rmSync(view, { recursive: true, force: true });
  }
}

function fail(reason, detail) {
  process.stdout.write(JSON.stringify({ ok: false, verdict: 'FAIL_CLOSED', reason, detail: detail ?? null }) + '\n');
  process.exit(1);
}

const migrationFile = readAndValidateMigration(root, declaration);

// Windows persistent-env bridge: source already-provisioned User Environment values into
// the child process when the current process env lacks them. Never prints or persists values.
const bridge = bridgePersistentUserEnv({ names: SUPABASE_ENV_NAMES, baseEnv: process.env });
const childEnv = bridge.env;

const secrets = [childEnv.SUPABASE_DB_PASSWORD, childEnv.SUPABASE_ACCESS_TOKEN, childEnv.SUPABASE_DB_URL].filter(Boolean);
const sanitize = (text) => redactSecrets(text, secrets);

const run = (cliArgs) => {
  try {
    return process.platform === 'win32'
      ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx.cmd', '--yes', 'supabase@latest', ...cliArgs], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: childEnv })
      : execFileSync('npx', ['--yes', 'supabase@latest', ...cliArgs], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: childEnv });
  } catch (error) {
    // Re-throw with secrets stripped from any captured output so a dry-run failure cause
    // stays visible without exposing the bridged values.
    if (error && (error.stdout || error.stderr)) {
      error.stdout = sanitize(error.stdout || '');
      error.stderr = sanitize(error.stderr || '');
    }
    throw error;
  }
};
const dbPush = (extraArgs) => runDbPushWithFallback({ run, extraArgs, env: childEnv });

const dry = dbPush(['--skip-vault', '--dry-run', '--yes']);
if (!dry.includes(path.basename(migrationFile))) throw new Error('MIGRATION_NOT_PENDING_ON_LINKED_PROJECT');
const localMigrations = [...dry.matchAll(/\d{14}_[a-z0-9_]+\.sql/gi)].map((match) => `supabase/migrations/${match[0]}`);
if ([...new Set(localMigrations)].some((file) => file !== migrationFile)) throw new Error('UNEXPECTED_PENDING_MIGRATION');
if (args.includes('--dry-run')) {
  process.stdout.write(JSON.stringify({ ok: true, mode: 'dry_run', migration_file: migrationFile, env_bridge: describeBridge(bridge) }) + '\n');
} else {
  dbPush(['--skip-vault', '--yes']);
  process.stdout.write(JSON.stringify({ ok: true, mode: 'applied', migration_file: migrationFile, env_bridge: describeBridge(bridge) }) + '\n');
}
