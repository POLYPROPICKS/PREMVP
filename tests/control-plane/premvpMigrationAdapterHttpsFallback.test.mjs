// End-to-end: the REAL registered adapter script, spawned in a throwaway copy of scripts/control-plane, with
//  - a fake `npx` that emulates the Supabase CLI (direct DB reachable, unreachable, or auth-failing), and
//  - a preloaded in-memory fake of the Supabase Management API (no network, no real project).
// Proves ordering (CLI first), fallback eligibility, every preserved gate, secret redaction and the clone mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sqlCloneApply } from '../../scripts/control-plane/lib/premvp-migration-https-transport.mjs';
import { CLONE, COLS, PROD, TARGET_BASENAME, TARGET_SQL, TOKEN, VERIFY, sha256OfText } from './helpers/fakeManagementApi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const HELPER = path.join(here, 'helpers', 'fakeManagementApi.mjs');
const DB_PASSWORD = 'dbpw-SENTINEL-9f8e7d6c5b4a';
const CLONE_FILE = 'ops/research-clone/reservation-telemetry-schema.sql';
const CLONE_SQL = `CREATE TABLE IF NOT EXISTS public.reservation_market_observations (id uuid PRIMARY KEY);
ALTER TABLE public.reservation_market_observations
${COLS.map((c, i) => `  ADD COLUMN IF NOT EXISTS ${c} ${i === 2 ? 'numeric' : 'text'}${i === COLS.length - 1 ? ';' : ','}`).join('\n')}
`;
const skip = process.platform === 'win32' ? 'POSIX fake npx' : false;

function makeTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'premvp-adapter-e2e-'));
  fs.cpSync(path.join(repoRoot, 'scripts', 'control-plane'), path.join(tmp, 'scripts', 'control-plane'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'supabase', 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ops', 'research-clone'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'supabase', 'migrations', '20260930070000_existing.sql'), '-- PREMVP_APPLICATION_MIGRATION_V1\nselect 1;\n');
  fs.writeFileSync(path.join(tmp, 'supabase', 'migrations', TARGET_BASENAME), TARGET_SQL);
  fs.writeFileSync(path.join(tmp, CLONE_FILE), CLONE_SQL);
  fs.writeFileSync(path.join(tmp, 'bin', 'npx'), `#!/bin/sh
echo "$*" >> "$FAKE_NPX_LOG"
case "$FAKE_NPX_MODE" in
  transport_down) echo '{"_tag":"Error","error":{"code":"DbConnectError","message":"failed to connect to postgres: failed to connect to \`host=db.nbnldzfsxffztsfrrxqy.supabase.co user=postgres database=postgres\`: hostname resolving error"}}'; exit 1;;
  connection_terminated) echo '{"_tag":"Error","error":{"code":"DbConnectError","message":"failed to connect to postgres: Connection terminated unexpectedly"}}'; exit 1;;
  auth_fail) echo '{"_tag":"Error","error":{"code":"DbConnectError","message":"failed to connect to postgres: failed to connect to \`host=db.nbnldzfsxffztsfrrxqy.supabase.co user=postgres database=postgres\`: failed SASL auth (password authentication failed for user postgres)"}}'; exit 1;;
  direct_ok)
    case "$*" in
      *"migration list"*) echo '[{"remote":"20260930070000","local":"20260930070000"}]';;
      *"--dry-run"*) echo '{"migrations":["${TARGET_BASENAME}"]}';;
      *) echo '{"ok":true}';;
    esac; exit 0;;
esac
exit 9
`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'preload.mjs'), `import fs from 'node:fs';
import { fakeApi } from ${JSON.stringify(pathToFileURL(HELPER).href)};
const api = fakeApi(JSON.parse(process.env.FAKE_API_OPTIONS ?? '{}'));
globalThis.fetch = api.fetchImpl;
process.on('exit', () => fs.writeFileSync(process.env.FAKE_API_LOG, JSON.stringify(api.log.map((l) => ({ method: l.method, path: l.path, query: l.query })))));
`);
  return tmp;
}

const targetDecl = (over = {}) => ({
  mode: 'PREMVP_APPLICATION_SCHEMA_MIGRATION_V1', migration_files: [`supabase/migrations/${TARGET_BASENAME}`],
  safety_class: 'ADDITIVE_COMPATIBLE', direct_raw_mutation: false, rollback_strategy: 'COMPATIBILITY_RETAINED',
  target_only: true, target_sha256: sha256OfText(TARGET_SQL), project_ref: PROD, verify_columns: VERIFY, ...over,
});
const cloneDecl = (over = {}) => ({
  mode: 'PREMVP_RESEARCH_CLONE_SCHEMA_V1', schema_file: CLONE_FILE, target_sha256: sha256OfText(CLONE_SQL), project_ref: CLONE,
  idempotent: true, direct_raw_mutation: false, verify_columns: VERIFY, ...over,
});

function runAdapter(tmp, { decl, flags = ['--target-only'], npx = 'transport_down', env = {}, api = {} }) {
  const logFile = path.join(tmp, 'api.log.json');
  const npxLog = path.join(tmp, 'npx.log');
  fs.rmSync(logFile, { force: true });
  fs.rmSync(npxLog, { force: true });
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(tmp, 'preload.mjs')).href,
    path.join(tmp, 'scripts', 'control-plane', 'apply-premvp-approved-migration.mjs'), ...flags, '--declaration', JSON.stringify(decl)], {
    cwd: tmp, encoding: 'utf8', timeout: 60_000,
    env: {
      PATH: `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: tmp,
      SUPABASE_PROJECT_REF: PROD, SUPABASE_ACCESS_TOKEN: TOKEN, SUPABASE_DB_PASSWORD: DB_PASSWORD,
      FAKE_NPX_MODE: npx, FAKE_NPX_LOG: npxLog, FAKE_API_LOG: logFile, FAKE_API_OPTIONS: JSON.stringify(api), ...env,
    },
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    status: result.status, out: lines.length ? JSON.parse(lines.at(-1)) : null, stdout: result.stdout, stderr: result.stderr,
    requests: read(logFile) ? JSON.parse(read(logFile)) : [], npxCalls: read(npxLog).split('\n').filter(Boolean),
  };
}
const noSecrets = (r) => { for (const s of [TOKEN, DB_PASSWORD, 'Bearer']) assert.equal(`${r.stdout}\n${r.stderr}`.includes(s), false, `leaked ${s.slice(0, 8)}`); };
const withTree = (fn) => async () => { const tmp = makeTree(); try { await fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); } };

// ── direct path stays first choice and unchanged ─────────────────────────────

test('direct DB reachable: the CLI path runs exactly as before and NO HTTPS request is made', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl(), npx: 'direct_ok' });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.mode, 'dry_run');
  assert.equal(r.out.exactly_one_pending_is_target, true);
  assert.equal(r.out.transport, undefined, 'not the HTTPS transport');
  assert.equal(r.requests.length, 0);
  assert.ok(r.npxCalls.some((c) => c.includes('migration list')) && r.npxCalls.some((c) => c.includes('--dry-run')));
  noSecrets(r);
}));

test('migration-list direct connection termination selects the existing HTTPS fallback', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl(), npx: 'connection_terminated' });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.mode, 'dry_run');
  assert.equal(r.out.direct_path_unavailable, true);
  assert.equal(r.out.transport, 'SUPABASE_MANAGEMENT_API_HTTPS_V1');
  assert.ok(r.npxCalls.some((c) => c.includes('migration list')));
  assert.ok(r.requests.some((request) => request.path === '/migrations'));
  noSecrets(r);
}));

test('direct path fails for AUTHENTICATION: no fallback, fail closed, no HTTPS request', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl(), npx: 'auth_fail' });
  assert.equal(r.status, 1);
  assert.equal(r.out.reason, 'TARGET_ONLY_MIGRATION_LIST_FAILED');
  assert.equal(r.requests.length, 0);
  assert.ok(r.npxCalls.length > 0);
  noSecrets(r);
}));

// ── HTTPS fallback only after a proven transport failure ─────────────────────

test('transport unavailable: CLI is tried FIRST, then the HTTPS dry-run runs for real and mutates nothing', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl() });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.npxCalls.length > 0, 'the CLI path was attempted before any HTTPS request');
  assert.equal(r.out.ok, true);
  assert.equal(r.out.mode, 'dry_run');
  assert.equal(r.out.transport, 'SUPABASE_MANAGEMENT_API_HTTPS_V1');
  assert.equal(r.out.direct_path_unavailable, true);
  assert.equal(r.out.dry_run.schema_unchanged, true);
  assert.equal(r.out.dry_run.ledger_unchanged, true);
  assert.equal(r.out.dry_run.transaction_semantics_proven, true);
  assert.equal(r.out.applied, false);
  assert.equal(r.requests.some((q) => q.method === 'POST' && q.path === '/migrations'), false);
  assert.ok(r.requests.some((q) => q.method === 'GET' && q.path === '/migrations'), 'ledger read');
  noSecrets(r);
}));

test('apply requires BOTH confirmation gates; with only one of them no HTTPS request is made at all', { skip }, withTree((tmp) => {
  for (const [flags, env] of [
    [['--target-only', '--apply'], {}],
    [['--target-only', '--apply', '--confirm'], {}],
    [['--target-only', '--apply'], { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' }],
  ]) {
    const r = runAdapter(tmp, { decl: targetDecl(), flags, env });
    assert.equal(r.status, 1);
    assert.equal(r.out.reason, 'TARGET_ONLY_APPLY_CONFIRMATION_REQUIRED');
    assert.equal(r.requests.length, 0, 'refused before any request');
    noSecrets(r);
  }
}));

test('apply with both gates: exact reviewed SQL via the native endpoint, exact ledger version, 3/3 columns proven', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl(), flags: ['--target-only', '--apply', '--confirm'], env: { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' } });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.mode, 'applied');
  assert.equal(r.out.native_endpoint_used, true);
  assert.deepEqual(r.out.ledger_after, ['20260930070000', '20261005090000']);
  assert.equal(r.out.columns_proof[0].all_present_nullable, true);
  assert.equal(r.out.columns_proof[0].present_n, COLS.length);
  const applies = r.requests.filter((q) => q.method === 'POST' && q.path === '/migrations');
  assert.equal(applies.length, 1);
  assert.equal(applies[0].query, TARGET_SQL, 'only the exact reviewed file content is applied');
  assert.equal(r.out.historical_migration_replayed, false);
  assert.equal(r.out.include_all_used, false);
  noSecrets(r);
}));

test('server stamps its own version: the single new ledger entry is re-versioned to the repository file version', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl(), flags: ['--target-only', '--apply', '--confirm'], env: { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' }, api: { nativeVersion: 'timestamp' } });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.ledger_version_repaired, true);
  assert.deepEqual(r.out.ledger_after, ['20260930070000', '20261005090000']);
  noSecrets(r);
}));

test('an endpoint without transactional semantics fails closed: HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN, target SQL never sent', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl(), flags: ['--target-only', '--apply', '--confirm'], env: { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' }, api: { transactional: false } });
  assert.equal(r.status, 1);
  assert.equal(r.out.reason, 'HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN');
  assert.equal(r.requests.some((q) => (q.query ?? '').includes('ADD COLUMN')), false);
  assert.equal(r.requests.some((q) => q.path === '/migrations' && q.method === 'POST'), false);
  noSecrets(r);
}));

// ── preserved gates (all fire before any request) ────────────────────────────

test('wrong SHA, non-allowlisted project, env/declaration ref mismatch and missing token are all rejected', { skip }, withTree((tmp) => {
  let r = runAdapter(tmp, { decl: targetDecl({ target_sha256: 'a'.repeat(64) }) });
  assert.equal(r.out.reason, 'TARGET_ONLY_HASH_MISMATCH');
  assert.equal(r.requests.length + r.npxCalls.length, 0, 'wrong SHA: nothing contacted');

  r = runAdapter(tmp, { decl: targetDecl({ project_ref: CLONE }) });
  assert.equal(r.out.reason, 'TARGET_ONLY_DECLARATION_INVALID');
  assert.equal(r.requests.length + r.npxCalls.length, 0, 'clone ref is not a migration target: nothing contacted');

  r = runAdapter(tmp, { decl: targetDecl(), env: { SUPABASE_PROJECT_REF: CLONE } });
  assert.equal(r.out.reason, 'TARGET_ONLY_PROJECT_AUTHORITY_MISMATCH');
  assert.equal(r.requests.length + r.npxCalls.length, 0);

  r = runAdapter(tmp, { decl: targetDecl(), env: { SUPABASE_ACCESS_TOKEN: '' } });
  assert.equal(r.out.reason, 'HTTPS_ACCESS_TOKEN_MISSING');
  assert.equal(r.requests.length, 0, 'no token: no HTTPS request');
  noSecrets(r);
}));

test('a declaration cannot smuggle SQL: names, columns and file paths are validated, never executed', { skip }, withTree((tmp) => {
  let r = runAdapter(tmp, { decl: targetDecl({ verify_columns: [{ schema: 'public', table: 'reservation_market_observations', columns: ["a'; drop table x;--"] }] }) });
  assert.equal(r.status, 1);
  assert.equal(r.out.reason, 'TARGET_ONLY_VERIFY_COLUMNS_INVALID');
  assert.equal(r.requests.some((q) => /drop table/i.test(q.query ?? '')), false);
  r = runAdapter(tmp, { decl: targetDecl({ migration_files: ["supabase/migrations/20261005090000_x'; drop table y;--.sql"] }) });
  assert.equal(r.status, 1);
  assert.equal(r.requests.length, 0);
}));

test('the ledger already holding the target version fails closed (inconsistent state), nothing is applied', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl(), flags: ['--target-only', '--apply', '--confirm'], env: { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' }, api: { ledger: ['20260930070000', '20261005090000'] } });
  assert.equal(r.status, 1);
  assert.equal(r.out.reason, 'TARGET_VERSION_ALREADY_RECORDED');
  assert.equal(r.requests.some((q) => q.path === '/migrations' && q.method === 'POST'), false);
}));

// ── research-clone schema mode ───────────────────────────────────────────────

test('CLONE: dry-run then apply of the exact ops file on the allowlisted clone, columns proven, no ledger touched', { skip }, withTree((tmp) => {
  let r = runAdapter(tmp, { decl: cloneDecl(), flags: ['--clone-schema'] });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.mode, 'dry_run');
  assert.equal(r.out.dry_run.schema_unchanged, true);
  assert.equal(r.requests.some((q) => q.path === '/migrations'), false);
  assert.equal(r.npxCalls.length, 0, 'the clone lifecycle never uses the CLI');

  r = runAdapter(tmp, { decl: cloneDecl(), flags: ['--clone-schema', '--apply', '--confirm'], env: { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' } });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.mode, 'applied');
  assert.equal(r.out.columns_proof[0].all_present_nullable, true);
  assert.equal(r.out.statement_allowlist_enforced, true);
  assert.ok(r.out.statement_kinds.add_column_if_not_exists >= 1);
  assert.ok(r.requests.some((q) => q.query === sqlCloneApply(CLONE_SQL)), 'exact file in one transaction');
  assert.equal(r.requests.some((q) => q.path === '/migrations'), false, 'no ledger');
  noSecrets(r);
}));

test('CLONE: gates — confirmation, allowlist (production ref refused), exact SHA, token, file path', { skip }, withTree((tmp) => {
  let r = runAdapter(tmp, { decl: cloneDecl(), flags: ['--clone-schema', '--apply'] });
  assert.equal(r.out.reason, 'TARGET_ONLY_APPLY_CONFIRMATION_REQUIRED');
  assert.equal(r.requests.length, 0);
  r = runAdapter(tmp, { decl: cloneDecl({ project_ref: PROD }), flags: ['--clone-schema'] });
  assert.equal(r.out.reason, 'CLONE_SCHEMA_DECLARATION_INVALID');
  assert.equal(r.requests.length, 0);
  r = runAdapter(tmp, { decl: cloneDecl({ target_sha256: 'b'.repeat(64) }), flags: ['--clone-schema'] });
  assert.equal(r.out.reason, 'HTTPS_TARGET_SHA256_MISMATCH');
  assert.equal(r.requests.length, 0);
  r = runAdapter(tmp, { decl: cloneDecl(), flags: ['--clone-schema'], env: { SUPABASE_ACCESS_TOKEN: '' } });
  assert.equal(r.out.reason, 'HTTPS_ACCESS_TOKEN_MISSING');
  assert.equal(r.requests.length, 0);
  r = runAdapter(tmp, { decl: cloneDecl({ schema_file: 'ops/research-clone/../../scripts/x-schema.sql' }), flags: ['--clone-schema'] });
  assert.equal(r.out.reason, 'CLONE_SCHEMA_DECLARATION_INVALID');
  fs.writeFileSync(path.join(tmp, CLONE_FILE), `${CLONE_SQL}DROP TABLE public.x;\n`);
  r = runAdapter(tmp, { decl: cloneDecl({ target_sha256: sha256OfText(`${CLONE_SQL}DROP TABLE public.x;\n`) }), flags: ['--clone-schema'] });
  assert.equal(r.status, 1);
  assert.equal(r.out.reason, 'CLONE_SQL_STATEMENT_NOT_ALLOWED');
  assert.equal(r.requests.length, 0);
}));

test('apply over HTTPS without verify_columns is refused before any request (the column proof is mandatory on apply)', { skip }, withTree((tmp) => {
  const decl = targetDecl();
  delete decl.verify_columns;
  const r = runAdapter(tmp, { decl, flags: ['--target-only', '--apply', '--confirm'], env: { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' } });
  assert.equal(r.status, 1);
  assert.equal(r.out.reason, 'TARGET_ONLY_VERIFY_COLUMNS_REQUIRED');
  assert.equal(r.requests.length, 0);
  noSecrets(r);
}));

test('ledger recorded but DDL missing => the adapter exits non-zero with TARGET_ONLY_COLUMNS_NOT_PROVEN (never ok:true)', { skip }, withTree((tmp) => {
  const r = runAdapter(tmp, { decl: targetDecl(), flags: ['--target-only', '--apply', '--confirm'], env: { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' }, api: { nativeSkipsDdl: true } });
  assert.equal(r.status, 1);
  assert.equal(r.out.reason, 'TARGET_ONLY_COLUMNS_NOT_PROVEN');
  assert.equal(r.out.ok, false);
  noSecrets(r);
}));
