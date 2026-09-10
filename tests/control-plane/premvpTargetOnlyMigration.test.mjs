// Target-only mode of the registered PREMVP approved-migration lifecycle — unit tests
//   node --test tests/control-plane/premvpTargetOnlyMigration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TARGET_ONLY_MODE,
  PREMVP_PRODUCTION_PROJECT_REFS,
  sha256OfText,
  validateTargetOnlyDeclaration,
  trackedRemoteVersions,
  resolveTrackedLocalFiles,
  materializeIsolatedView,
  classifyTargetOnlyDryRun,
  assertNoIncludeAll,
  buildTargetOnlyEvidence,
} from '../../scripts/control-plane/lib/premvp-target-only-migration.mjs';

const root = process.cwd();
// Re-stamped above the live production ledger head (20260909123000); DDL and
// sha256 unchanged from the original 20260909120000 file.
const TARGET = '20260910120000_executor_wallet_observation_columns.sql';
const REF = PREMVP_PRODUCTION_PROJECT_REFS[0];

function decl(overrides = {}) {
  return {
    mode: 'PREMVP_APPLICATION_SCHEMA_MIGRATION_V1',
    migration_files: [`supabase/migrations/${TARGET}`],
    safety_class: 'ADDITIVE_COMPATIBLE',
    direct_raw_mutation: false,
    rollback_strategy: 'COMPATIBILITY_RETAINED',
    target_only: true,
    target_sha256: 'a'.repeat(64),
    project_ref: REF,
    ...overrides,
  };
}

// ── declaration validation ────────────────────────────────────────────────

test('declaration: a well-formed target-only declaration validates', () => {
  assert.equal(validateTargetOnlyDeclaration(decl()).ok, true);
});

test('declaration: TARGET_PATH_REQUIRED / TARGET_HASH_REQUIRED / project allowlist / include_all', () => {
  assert.match(validateTargetOnlyDeclaration(decl({ migration_files: [] })).errors.join(','), /EXACTLY_ONE_MIGRATION_FILE/);
  assert.match(validateTargetOnlyDeclaration(decl({ migration_files: ['supabase/migrations/nope.sql'] })).errors.join(','), /PATH_INVALID/);
  assert.match(validateTargetOnlyDeclaration(decl({ target_sha256: 'short' })).errors.join(','), /TARGET_SHA256_REQUIRED/);
  assert.match(validateTargetOnlyDeclaration(decl({ project_ref: 'someother' })).errors.join(','), /PROJECT_REF_NOT_ALLOWLISTED/);
  assert.match(validateTargetOnlyDeclaration(decl({ include_all: true })).errors.join(','), /INCLUDE_ALL_FORBIDDEN/);
  assert.match(validateTargetOnlyDeclaration(decl({ target_only: false })).errors.join(','), /TARGET_ONLY_FLAG_REQUIRED/);
});

// ── remote-ledger-matching view ──────────────────────────────────────────

test('trackedRemoteVersions: only versions with a non-empty remote entry', () => {
  const rows = { migrations: [
    { local: '20260518', remote: '' },
    { local: '20260908120000', remote: '20260908120000' },
    { local: '20260812152531', remote: '20260812152531' },
    { local: '20260909120000', remote: '' },
  ] };
  assert.deepEqual(trackedRemoteVersions(rows), ['20260812152531', '20260908120000']);
});

test('resolveTrackedLocalFiles: maps versions to files and reports any missing locally', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  writeFileSync(path.join(dir, '20260908120000_make_current_money_state_gsp_independent.sql'), '-- x');
  writeFileSync(path.join(dir, '20260812152531_current_signal_pair_serving.sql'), '-- x');
  const { resolved, missing } = resolveTrackedLocalFiles(['20260812152531', '20260908120000', '20260999999999'], dir);
  assert.deepEqual(resolved, ['20260812152531_current_signal_pair_serving.sql', '20260908120000_make_current_money_state_gsp_independent.sql']);
  assert.deepEqual(missing, ['20260999999999']);
  rmSync(dir, { recursive: true, force: true });
});

test('materializeIsolatedView: places exactly trackedFiles + target, never anything else', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  mkdirSync(path.join(repo, 'supabase', 'migrations'), { recursive: true });
  for (const f of ['20260908120000_x.sql', '20260909120000_target.sql', '20260518_historical.sql']) {
    writeFileSync(path.join(repo, 'supabase', 'migrations', f), `-- ${f}`);
  }
  const view = mkdtempSync(path.join(os.tmpdir(), 'view-'));
  const placed = materializeIsolatedView({
    repoRootAbs: repo, viewRootAbs: view,
    trackedFiles: ['20260908120000_x.sql'], targetBasename: '20260909120000_target.sql',
  });
  assert.deepEqual(placed, ['20260908120000_x.sql', '20260909120000_target.sql']);
  const onDisk = readdirSync(path.join(view, 'supabase', 'migrations')).sort();
  assert.deepEqual(onDisk, ['20260908120000_x.sql', '20260909120000_target.sql']);
  assert.equal(onDisk.includes('20260518_historical.sql'), false, 'historical file must never enter the view');
  rmSync(repo, { recursive: true, force: true });
  rmSync(view, { recursive: true, force: true });
});

// ── dry-run classification (fail-closed) ─────────────────────────────────

test('classifyTargetOnlyDryRun: PASS only for exactly one pending migration == target', () => {
  const r = classifyTargetOnlyDryRun({
    stdout: 'DRY RUN\n{"upToDate":false,"dryRun":true,"migrations":["' + TARGET + '"],"seeds":[],"roles":[],"message":"Finished supabase db push."}',
    exitCode: 0, targetBasename: TARGET,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'TARGET_ONLY_PENDING_CONFIRMED');
  assert.deepEqual(r.pending, [TARGET]);
});

test('classifyTargetOnlyDryRun: FAILS CLOSED on LegacyDbPushMissingRemoteError / MissingLocalError', () => {
  for (const marker of ['LegacyDbPushMissingRemoteError', 'LegacyDbPushMissingLocalError']) {
    const r = classifyTargetOnlyDryRun({ stdout: `{"_tag":"Error","error":{"code":"${marker}"}}`, exitCode: 1, targetBasename: TARGET });
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'LEGACY_DB_PUSH_ERROR');
  }
});

test('classifyTargetOnlyDryRun: FAILS CLOSED when --include-all is requested', () => {
  const r = classifyTargetOnlyDryRun({ stdout: 'Rerun the command with --include-all flag to apply these migrations:', exitCode: 1, targetBasename: TARGET });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'INCLUDE_ALL_REQUIRED');
});

test('classifyTargetOnlyDryRun: FAILS CLOSED on more than one pending / a non-target pending', () => {
  const many = classifyTargetOnlyDryRun({ stdout: `{"migrations":["${TARGET}","20260518_historical.sql"]}`, exitCode: 0, targetBasename: TARGET });
  assert.equal(many.verdict, 'PENDING_MIGRATION_COUNT_NOT_ONE');
  const other = classifyTargetOnlyDryRun({ stdout: '{"migrations":["20260518_historical.sql"]}', exitCode: 0, targetBasename: TARGET });
  assert.equal(other.verdict, 'PENDING_MIGRATION_NOT_TARGET');
});

test('assertNoIncludeAll: throws for --include-all / include-all', () => {
  assert.equal(assertNoIncludeAll(['db', 'push', '--linked', '--dry-run']), true);
  assert.throws(() => assertNoIncludeAll(['db', 'push', '--linked', '--include-all']));
  assert.throws(() => assertNoIncludeAll(['db', 'push', 'include-all']));
});

test('buildTargetOnlyEvidence: records fail_closed, no include-all, no replay, no repair', () => {
  const ev = buildTargetOnlyEvidence({
    mode: 'dry_run', declaration: decl(), targetBasename: TARGET,
    isolatedFiles: ['20260908120000_x.sql', TARGET],
    dryRun: { ok: true, verdict: 'TARGET_ONLY_PENDING_CONFIRMED', pending: [TARGET] },
  });
  assert.equal(ev.schema, TARGET_ONLY_MODE);
  assert.equal(ev.exactly_one_pending_is_target, true);
  assert.equal(ev.include_all_used, false);
  assert.equal(ev.historical_migration_replayed, false);
  assert.equal(ev.ledger_repair_used, false);
  assert.equal(ev.fail_closed, true);
  assert.equal(ev.command_id, 'premvp.command.release_pipeline.v1');
});

// ── lifecycle wiring ─────────────────────────────────────────────────────

test('wiring: apply-premvp-approved-migration.mjs has a --target-only branch that reuses the approved-migration validator', () => {
  const src = readFileSync(path.join(root, 'scripts/control-plane/apply-premvp-approved-migration.mjs'), 'utf8');
  assert.match(src, /--target-only/);
  assert.match(src, /premvp-target-only-migration\.mjs/);
  assert.match(src, /readAndValidateMigration\(root, declaration\)/);
  assert.match(src, /TARGET_ONLY_HASH_MISMATCH/);
  assert.match(src, /assertNoIncludeAll/); // guarded on every supabase invocation
  assert.doesNotMatch(src, /'--include-all'/); // never passed as an argv token
});

test('wiring: the real merged target file hashes to the value the wallet migration PR shipped', () => {
  const sql = readFileSync(path.join(root, 'supabase/migrations', TARGET), 'utf8');
  assert.equal(sha256OfText(sql), '319c4fc024c194d10aa078460a76ec4101d0915ce31cfca637f6fc48ddeb16cf');
});
