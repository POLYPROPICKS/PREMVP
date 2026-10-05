// HTTPS fallback transport of the registered PREMVP approved-migration adapter.
// Every test runs against an in-memory fake of the Supabase Management API: no network, no real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpsTransportError, PREMVP_RESEARCH_CLONE_PROJECT_REFS, SQL_LEDGER_VERSIONS, SQL_SCHEMA_FINGERPRINT,
  SQL_TRANSACTION_PROBE, assertApplyConfirmation, assertCloneSqlSafe, assertHttpsPreconditions, assertNoTransactionControl,
  columnsProof, createHttpsMigrationTransport, isDirectTransportUnavailable, lexSql, parseMigrationHistory, parseTargetBasename,
  resolveTrackedStrict, runHttpsCloneSchema, runHttpsTargetOnly, sqlCloneApply, sqlColumnsProof, sqlDryRun, sqlRepairLedgerVersion,
  validateCloneSchemaDeclaration,
} from '../../scripts/control-plane/lib/premvp-migration-https-transport.mjs';

import {
  ALLOW, CLONE, COLS, PROD, TARGET_BASENAME, TARGET_SQL, TARGET_VERSION, TOKEN, VERIFY, fakeApi, sha256OfText,
} from './helpers/fakeManagementApi.mjs';

const tracked = (versions) => ({ resolved: versions.map((v) => `${v}_x.sql`), missing: [] });
const transportFor = (api, ref = PROD, allowlist = ALLOW, token = TOKEN) =>
  createHttpsMigrationTransport({ token, projectRef: ref, allowlist, fetchImpl: api.fetchImpl, redact: (t, secrets) => secrets.reduce((a, s) => a.split(s).join('***'), String(t)) });
const run = (api, extra = {}) => runHttpsTargetOnly({ transport: transportFor(api), targetBasename: TARGET_BASENAME, targetSql: TARGET_SQL, targetSha256: sha256OfText(TARGET_SQL), resolveTracked: tracked, verify: VERIFY, ...extra });

// ── fallback eligibility: the direct path stays first choice ─────────────────

test('fallback is eligible ONLY for a proven direct-transport failure', () => {
  const observed = { stdout: '{"_tag":"Error","error":{"code":"DbConnectError","message":"failed to connect to postgres: failed to connect to `host=db.nbnldzfsxffztsfrrxqy.supabase.co user=postgres database=postgres`: hostname resolving error"}}' };
  assert.equal(isDirectTransportUnavailable(observed), true);
  assert.equal(isDirectTransportUnavailable({ stderr: 'DbConnectError: dial tcp [2a05::1]:5432: connect: network is unreachable' }), true);
  assert.equal(isDirectTransportUnavailable({ message: 'failed to connect to postgres: dial tcp 1.2.3.4:5432: i/o timeout' }), true);
  // real gate failures are never routed around
  assert.equal(isDirectTransportUnavailable({ stdout: 'DbConnectError: failed to connect to postgres: password authentication failed for user "postgres"' }), false);
  assert.equal(isDirectTransportUnavailable({ stdout: 'DbConnectError ... hostname resolving error ... SASL authentication failed' }), false);
  // identity / authorization / policy-class connect failures are never routed around, even though they carry the generic pgx wrapper
  const wrapper = 'DbConnectError: failed to connect to postgres: failed to connect to `host=db.x.supabase.co user=postgres database=postgres`: ';
  for (const gate of ['failed to receive message (unexpected EOF) Tenant or user not found', 'no pg_hba.conf entry for host "1.2.3.4", user "postgres", SSL off',
    'Circuit breaker open: Too many authentication errors', 'role "postgres" does not exist', 'database "postgres" does not exist', 'tls error: certificate verify failed',
    'server error (FATAL: permission denied)']) {
    assert.equal(isDirectTransportUnavailable({ stdout: wrapper + gate }), false, gate);
  }
  // the generic wrapper alone (no transport cause) is NOT enough
  assert.equal(isDirectTransportUnavailable({ stdout: wrapper + 'unexpected message from server' }), false);
  assert.equal(isDirectTransportUnavailable({ stderr: 'LegacyDbPushMissingLocalError' }), false);
  assert.equal(isDirectTransportUnavailable({ stderr: 'unexpected token in migration' }), false);
  assert.equal(isDirectTransportUnavailable({}), false);
  assert.equal(isDirectTransportUnavailable(null), false);
});

// ── preconditions: project, hash, token, confirmation ────────────────────────

test('wrong project ref, wrong SHA and missing access token are rejected before any request', () => {
  const ok = { token: TOKEN, projectRef: PROD, allowlist: ALLOW, declaredProjectRef: PROD, expectedSha256: 'a'.repeat(64), actualSha256: 'a'.repeat(64) };
  assert.equal(assertHttpsPreconditions(ok), true);
  const code = (patch) => { try { assertHttpsPreconditions({ ...ok, ...patch }); } catch (e) { return e.code; } return 'NO_ERROR'; };
  assert.equal(code({ projectRef: 'zzzzzzzzzzzzzzzzzzzz', declaredProjectRef: 'zzzzzzzzzzzzzzzzzzzz' }), 'HTTPS_PROJECT_REF_NOT_ALLOWLISTED');
  assert.equal(code({ declaredProjectRef: CLONE }), 'HTTPS_PROJECT_REF_MISMATCH');
  assert.equal(code({ projectRef: 'not-a-ref' }), 'HTTPS_PROJECT_REF_INVALID');
  assert.equal(code({ actualSha256: 'b'.repeat(64) }), 'HTTPS_TARGET_SHA256_MISMATCH');
  assert.equal(code({ expectedSha256: 'xyz', actualSha256: 'xyz' }), 'HTTPS_TARGET_SHA256_MISMATCH');
  assert.equal(code({ token: '' }), 'HTTPS_ACCESS_TOKEN_MISSING');
  assert.equal(code({ token: undefined }), 'HTTPS_ACCESS_TOKEN_MISSING');
  const api = fakeApi();
  assert.throws(() => transportFor(api, PROD, ALLOW, ''), /HTTPS_ACCESS_TOKEN_MISSING/);
  assert.throws(() => transportFor(api, CLONE, ALLOW), /HTTPS_PROJECT_REF_NOT_ALLOWLISTED/);
  assert.throws(() => transportFor(api, 'short', ALLOW), /HTTPS_PROJECT_REF_INVALID/);
  assert.equal(api.log.length, 0, 'no request was made');
});

test('apply requires BOTH --apply --confirm AND PREMVP_TARGET_ONLY_APPLY_CONFIRM=1; dry-run needs neither', () => {
  assert.equal(assertApplyConfirmation(['--target-only'], {}), false);
  for (const [args, env] of [
    [['--apply'], {}], [['--apply', '--confirm'], {}], [['--apply'], { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' }],
    [['--apply', '--confirm'], { PREMVP_TARGET_ONLY_APPLY_CONFIRM: 'true' }],
  ]) assert.throws(() => assertApplyConfirmation(args, env), /TARGET_ONLY_APPLY_CONFIRMATION_REQUIRED/);
  assert.equal(assertApplyConfirmation(['--apply', '--confirm'], { PREMVP_TARGET_ONLY_APPLY_CONFIRM: '1' }), true);
});

// ── dry-run: real, rolled back, nothing persists ─────────────────────────────

test('DRY-RUN executes the exact SQL in BEGIN..ROLLBACK and proves schema + ledger are unchanged', async () => {
  const api = fakeApi();
  const before = [...api.state.schema];
  const evidence = await run(api);
  assert.equal(evidence.mode, 'dry_run');
  assert.equal(evidence.applied, false);
  assert.equal(evidence.dry_run.transaction_semantics_proven, true);
  assert.equal(evidence.dry_run.schema_unchanged, true);
  assert.equal(evidence.dry_run.ledger_unchanged, true);
  assert.equal(evidence.dry_run.executed_exact_sql_sha256, sha256OfText(TARGET_SQL));
  assert.equal(evidence.dry_run.schema_fingerprint_before, evidence.dry_run.schema_fingerprint_after);
  assert.deepEqual([...api.state.schema], before, 'target schema change is unapplied');
  assert.deepEqual(api.state.ledger.map((l) => l.version), ['20260930070000'], 'migration ledger unchanged');
  assert.equal(api.log.some((l) => l.path === '/migrations' && l.method === 'POST'), false, 'the native apply endpoint is never touched in dry-run');
  const dry = api.log.find((l) => l.query === sqlDryRun(TARGET_SQL));
  assert.ok(dry, 'the exact reviewed SQL ran wrapped in BEGIN..ROLLBACK');
  assert.match(dry.query, /^BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '45s';\n/, 'a DDL that cannot get its lock fails fast instead of queueing behind live traffic');
  assert.match(dry.query, /ROLLBACK;\nSELECT 'PREMVP_DRYRUN_COMPLETE' AS premvp_marker;$/);
  assert.equal(evidence.dry_run.script_completed, true);
});

test('ledger is checked BEFORE and AFTER the dry-run, and the probe precedes the target SQL', async () => {
  const api = fakeApi();
  await run(api);
  const idx = (pred) => api.log.findIndex(pred);
  const firstLedger = idx((l) => l.method === 'GET' && l.path === '/migrations');
  const lastLedger = api.log.map((l, i) => (l.method === 'GET' && l.path === '/migrations' ? i : -1)).filter((i) => i >= 0).at(-1);
  const probe = idx((l) => l.query === SQL_TRANSACTION_PROBE);
  const dry = idx((l) => l.query === sqlDryRun(TARGET_SQL));
  assert.ok(firstLedger >= 0 && firstLedger < probe && probe < dry && dry < lastLedger);
});

test('an endpoint that does NOT preserve explicit transactions fails closed and the target SQL is never sent', async () => {
  const api = fakeApi({ transactional: false });
  await assert.rejects(run(api), (e) => e instanceof HttpsTransportError && e.code === 'HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN');
  assert.equal(api.log.some((l) => (l.query ?? '').includes('ADD COLUMN')), false, 'target SQL never reached the endpoint');
  assert.equal(api.state.schema.size, 1);
});

test('if a dry-run ever persisted DDL the fingerprint check fails closed (defence in depth)', async () => {
  const api = fakeApi();
  // probe says "transactional" but the dry-run statement still persists: the post-dry-run proof must catch it
  const lying = { ...api, fetchImpl: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.query?.startsWith('BEGIN;\nSET LOCAL') && body.query.includes('ROLLBACK;\nSELECT')) { api.state.schema.add('public.reservation_market_observations.taker_fee_state'); return { ok: true, status: 201, text: async () => JSON.stringify([{ premvp_marker: 'PREMVP_DRYRUN_COMPLETE' }]) }; }
    return api.fetchImpl(url, init);
  } };
  await assert.rejects(run(lying), (e) => e.code === 'HTTPS_DRY_RUN_SCHEMA_NOT_ROLLED_BACK');
});

test('remote ledger gates: target already recorded, untracked remote version, disagreeing ledger sources', async () => {
  await assert.rejects(run(fakeApi({ ledger: ['20260930070000', TARGET_VERSION] })), (e) => e.code === 'TARGET_VERSION_ALREADY_RECORDED');
  await assert.rejects(run(fakeApi(), { resolveTracked: () => ({ resolved: [], missing: ['20260930070000'] }) }), (e) => e.code === 'TARGET_ONLY_REMOTE_TRACKED_FILE_MISSING_LOCALLY');
  await assert.rejects(run(fakeApi({ tableLedgerDiffers: true })), (e) => e.code === 'HTTPS_LEDGER_SOURCES_DISAGREE');
});

// ── apply: native endpoint, exact ledger version, fail closed ────────────────

test('APPLY via the native endpoint records the EXACT version and proves DDL + ledger + columns', async () => {
  const api = fakeApi();
  const evidence = await run(api, { apply: true });
  assert.equal(evidence.mode, 'applied');
  assert.equal(evidence.native_endpoint_used, true);
  assert.equal(evidence.ledger_version_repaired, false, 'no manual ledger write when the endpoint recorded the exact version');
  assert.equal(evidence.schema_changed, true);
  assert.deepEqual(evidence.ledger_after, ['20260930070000', TARGET_VERSION]);
  assert.equal(evidence.columns_proof[0].all_present_nullable, true);
  assert.equal(evidence.columns_proof[0].present_n, COLS.length);
  assert.equal(evidence.historical_migration_replayed, false);
  assert.equal(evidence.include_all_used, false);
  const native = api.log.filter((l) => l.method === 'POST' && l.path === '/migrations');
  assert.equal(native.length, 1);
  assert.equal(native[0].query, TARGET_SQL, 'only the exact reviewed SQL file is applied');
  assert.equal(native[0].name, 't10_executable_sibling_telemetry_v1');
  assert.equal(api.log.some((l) => (l.query ?? '').startsWith('update supabase_migrations')), false);
});

test('when the server stamps its own version, exactly that one new entry is re-versioned to the repository file version', async () => {
  const api = fakeApi({ nativeVersion: 'timestamp' });
  const evidence = await run(api, { apply: true });
  assert.equal(evidence.ledger_version_repaired, true);
  assert.deepEqual(api.state.ledger.map((l) => l.version), ['20260930070000', TARGET_VERSION]);
  assert.equal(api.state.ledger.find((l) => l.version === TARGET_VERSION).name, 't10_executable_sibling_telemetry_v1');
  const repair = api.log.filter((l) => (l.query ?? '').startsWith('update supabase_migrations'));
  assert.equal(repair.length, 1);
  assert.equal(repair[0].query, sqlRepairLedgerVersion('20261005162341', TARGET_VERSION, 't10_executable_sibling_telemetry_v1'));
});

test('an apply response error is recovered ONLY when the exact version was recorded; otherwise fail closed with state', async () => {
  const recovered = await run(fakeApi({ nativeFailsAfterApply: true }), { apply: true });
  assert.equal(recovered.apply_response_error_recovered, 'HTTPS_API_STATUS_500');
  await assert.rejects(run(fakeApi({ nativeFailsAfterApply: true, nativeVersion: 'timestamp' }), { apply: true }), (e) => e.code === 'HTTPS_APPLY_LEDGER_UNEXPECTED');
});

test('apply never happens without the dry-run having passed first', async () => {
  const api = fakeApi({ transactional: false });
  await assert.rejects(run(api, { apply: true }), (e) => e.code === 'HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN');
  assert.equal(api.log.some((l) => l.path === '/migrations' && l.method === 'POST'), false);
});

// ── only exact SQL, no injection, no generic execution ───────────────────────

test('every request body is a fixed template, a validated value, or the exact target file — nothing else', async () => {
  const api = fakeApi({ nativeVersion: 'timestamp' });
  await run(api, { apply: true });
  const allowed = (q) => q === SQL_LEDGER_VERSIONS || q === SQL_SCHEMA_FINGERPRINT || q === SQL_TRANSACTION_PROBE || q === sqlDryRun(TARGET_SQL) || q === TARGET_SQL ||
    q === sqlColumnsProof('public', 'reservation_market_observations', COLS) || q === sqlRepairLedgerVersion('20261005162341', TARGET_VERSION, 't10_executable_sibling_telemetry_v1');
  for (const l of api.log) if (l.query !== null) assert.ok(allowed(l.query), `unexpected SQL sent: ${l.query.slice(0, 80)}`);
  for (const l of api.log) assert.equal(l.headers.authorization, `Bearer ${TOKEN}`);
});

test('declaration-controlled values can never inject SQL', async () => {
  for (const bad of ["20261005090000_x'; drop table y;--.sql", '../20261005090000_x.sql', '20261005090000_X.sql', '2026_x.sql', '20261005090000_x.sql; select 1']) {
    assert.throws(() => parseTargetBasename(bad), /HTTPS_TARGET_BASENAME_INVALID/);
  }
  const api = fakeApi();
  await assert.rejects(run(api, { targetBasename: "20261005090000_x'; drop table y;--.sql" }), /HTTPS_TARGET_BASENAME_INVALID/);
  assert.equal(api.log.length, 0, 'rejected before any request');
  for (const bad of ["a'; drop table x;--", 'A', '1abc', 'x y', '']) {
    assert.throws(() => sqlColumnsProof('public', 'reservation_market_observations', [bad]), /HTTPS_VERIFY_COLUMNS_INVALID/);
    assert.throws(() => sqlColumnsProof(bad, 'reservation_market_observations', ['a']), /HTTPS_VERIFY_COLUMNS_INVALID/);
  }
  assert.throws(() => sqlRepairLedgerVersion("1'; drop", TARGET_VERSION, 'n'), /HTTPS_LEDGER_REPAIR_ARGS_INVALID/);
  assert.throws(() => sqlRepairLedgerVersion('20261005162341', TARGET_VERSION, "n'; drop"), /HTTPS_LEDGER_REPAIR_ARGS_INVALID/);
});

test('transaction-control guard is a faithful lexer: constructs that hide a COMMIT from regexes are caught (D1)', () => {
  const hidden = {
    'line comment containing /* hides nothing': '-- see /*\nCOMMIT;\n-- end */\nSELECT 1;',
    "E'' string with backslash-quote": "SELECT E'\\''; COMMIT; SELECT '';",
    'dollar signs inside a string': "SELECT '$$'; COMMIT; SELECT '$$';",
    'dollar signs inside a comment': '-- $$\nCOMMIT;\n-- $$\nSELECT 1;',
    'nested comment closed, real COMMIT after': '/* a /* b */ c */ COMMIT;',
    'dollar tag with digits then COMMIT': 'DO $a1$ BEGIN PERFORM 1; END $a1$; COMMIT;',
    'identifier containing $ is not a dollar quote': 'SELECT foo$bar$ FROM t; COMMIT;',
    'E after an identifier char is not an E-string': "SELECT ae'x'; COMMIT;",
    'plain COMMIT': 'ALTER TABLE t ADD COLUMN x int; COMMIT;', BEGIN: 'begin; select 1;', END: 'SELECT 1; END;', ROLLBACK: 'ROLLBACK', SAVEPOINT: 'SELECT 1; SAVEPOINT s;',
    'SET (session)': 'SET search_path = x; select 1;', RESET: 'RESET ALL;', 'START TRANSACTION': 'START TRANSACTION;', 'psql meta': '\\copy x',
    // R1: PostgreSQL's scanner ends a -- comment at \n OR \r (scan.l: newline [\n\r])
    'lone CR ends a line comment': 'SELECT 1; -- x\rCOMMIT;',
    'CR-only line endings': 'SELECT 1;\r-- c\rCOMMIT;\r',
    // R2: dollar-quote delimiters have no length limit
    'dollar tag of 79 chars': `SELECT $${'L'.repeat(79)}$ ' $${'L'.repeat(79)}$; COMMIT; SELECT $${'L'.repeat(79)}$ ' $${'L'.repeat(79)}$;`,
    'dollar tag of 100 chars': `SELECT $${'L'.repeat(100)}$ ' $${'L'.repeat(100)}$; COMMIT; SELECT $${'L'.repeat(100)}$ ' $${'L'.repeat(100)}$;`,
    'non-ASCII dollar tag': "SELECT $é日$ ' $é日$; COMMIT; SELECT $é日$ ' $é日$;",
    'back-to-back dollar quotes': 'SELECT $a$ x $a$||$b$ y $b$; COMMIT;',
    // every SET is refused (a file must not change lock/statement timeouts or string-lexing GUCs), as is set_config()
    'SET LOCAL': "SET LOCAL lock_timeout = '0'; select 1;",
    'SET LOCAL standard_conforming_strings': 'SET LOCAL standard_conforming_strings = off; select 1;',
    'set_config()': "SELECT set_config('lock_timeout', '0', true);",
    'quoted set_config call (N2)': 'SELECT "set_config"(\'lock_timeout\', \'0\', true);',
    'set_config inside a DO dollar body (N2)': "DO $$ BEGIN PERFORM set_config('lock_timeout', '0', true); END $$;",
    'set_config inside a DO string body (N2)': "DO 'BEGIN PERFORM set_config(''lock_timeout'', ''0'', true); END';",
    'set_config only in a comment (blanket refusal, documented over-block)': '/* set_config */ select 1;',
    'unicode-escaped identifier could spell set_config (N2)': `SELECT U&"set\\005fconfig"('a', 'b', true);`,
    'unicode-escape string': "SELECT U&'abc';",
  };
  for (const [label, sql] of Object.entries(hidden)) {
    assert.throws(() => assertNoTransactionControl(sql), /HTTPS_SQL_TRANSACTION_CONTROL_FORBIDDEN/, label);
  }
  const harmless = {
    'target-like file': TARGET_SQL,
    'COMMIT only as text in a string': "COMMENT ON COLUMN t.c IS 'commit; rollback; begin;';",
    'the word SET inside a comment/string': "COMMENT ON COLUMN t.c IS 'SET x'; -- SET y\nselect 1;",
    'long tag whose body is bait': `SELECT $${'L'.repeat(100)}$ '; COMMIT; --$${'L'.repeat(100)}$;`,
    'BEGIN/END inside a DO body': 'DO $x$ BEGIN PERFORM 1; END $x$; select 1;',
    'whole nested comment': '/* outer /* inner */ COMMIT; */ select 1;',
    'quoted identifier': 'SELECT 1 AS "commit;"; select 2;',
  };
  for (const [label, sql] of Object.entries(harmless)) assert.equal(assertNoTransactionControl(sql), true, label);
});

test('N1: a string continued across a newline (scan.l quotecontinue) is refused, never mis-lexed', () => {
  const continued = {
    'reviewer input: E-string continuation hides a COMMIT': "SELECT E'x'\n'\\''; COMMIT; -- '\nSELECT 1;\n",
    'standard continuation': "SELECT 'a'\n'b';",
    'CR continuation': "SELECT E'a'\r'\\'';\rCOMMIT;\r-- '\r",
    'CRLF continuation': "SELECT 'a'\r\n'b';",
    'continuation through a -- comment line': "SELECT 'a' -- c\n'b';",
    'continuation through blank lines and tabs': "SELECT 'a'\t\n\n  \f '\\'';",
    'bit string continuation': "SELECT B'1'\n'0';",
    'hex string continuation': "SELECT X'1'\n'0';",
    'national continuation': "SELECT N'a'\n'b';",
  };
  for (const [label, sql] of Object.entries(continued)) {
    assert.throws(() => assertNoTransactionControl(sql), (e) => e.code === 'HTTPS_SQL_STRING_CONTINUATION_UNSUPPORTED', label);
  }
  const fine = {
    'string then newline then statement end': "SELECT 'a'\n;",
    'string then comment line then semicolon': "COMMENT ON TABLE t IS 'a'\n-- c\n;",
    'strings separated by an operator on the next line': "SELECT 'a'\n|| 'b';",
    'doubled quote is not a continuation': "SELECT 'it''s'\n;",
    'block comment between segments is not a continuation': "SELECT 'a'\n/* c */ || 'b';",
    'same-line adjacency is a syntax error for Postgres, not a continuation': "SELECT 'a' || 'b';",
  };
  for (const [label, sql] of Object.entries(fine)) assert.equal(assertNoTransactionControl(sql), true, label);
});

test('lexer fails closed on anything unterminated (nothing would execute on the server either)', () => {
  for (const bad of ['/* never closed', "select 'never closed", 'select "never closed', 'DO $x$ never closed', 'select 1;\0commit;']) {
    assert.throws(() => lexSql(bad), (e) => e.code === 'HTTPS_SQL_LEX_UNTERMINATED', bad);
    assert.throws(() => assertNoTransactionControl(bad), (e) => e.code === 'HTTPS_SQL_LEX_UNTERMINATED', bad);
  }
  assert.deepEqual(lexSql("select 'a;b'; select 2 -- tail; x").statements, ["select ''", 'select 2']);
});

test('the transaction guard is enforced on the dry-run and apply PATHS, independent of the SHA pin', async () => {
  const evil = `${TARGET_SQL}SELECT E'\\''; COMMIT; SELECT '';\n`;
  const api = fakeApi();
  await assert.rejects(runHttpsTargetOnly({ transport: transportFor(api), targetBasename: TARGET_BASENAME, targetSql: evil, targetSha256: sha256OfText(evil), resolveTracked: tracked, verify: VERIFY }),
    (e) => e.code === 'HTTPS_SQL_TRANSACTION_CONTROL_FORBIDDEN');
  assert.equal(api.log.length, 0, 'refused before a single request, even with a matching SHA pin');
  const t = transportFor(api);
  await assert.rejects(t.dryRunExactSql(evil), /HTTPS_SQL_TRANSACTION_CONTROL_FORBIDDEN/);
  await assert.rejects(t.applyNative({ sql: evil, name: 'x' }), /HTTPS_SQL_TRANSACTION_CONTROL_FORBIDDEN/);
  assert.equal(api.log.length, 0);
});

test('no generic SQL surface is exported from the transport', async () => {
  const api = fakeApi();
  const transport = transportFor(api);
  assert.deepEqual(Object.keys(transport).sort(), ['applyCloneSql', 'applyNative', 'dryRunExactSql', 'projectRef', 'proveTransactionSemantics', 'readColumns', 'readLedger', 'readSchemaFingerprint', 'repairLedgerVersion']);
  const mod = await import('../../scripts/control-plane/lib/premvp-migration-https-transport.mjs');
  for (const name of Object.keys(mod)) assert.doesNotMatch(name, /^(run|exec|execute|query|sql)$/i);
});

// ── secrets ──────────────────────────────────────────────────────────────────

test('the access token never appears in errors, details or evidence', async () => {
  const api = fakeApi();
  const bad = createHttpsMigrationTransport({ token: 'sbp_WRONG_TOKEN_0123456789', projectRef: PROD, allowlist: ALLOW, fetchImpl: api.fetchImpl, redact: (t, s) => s.reduce((a, x) => a.split(x).join('***'), String(t)) });
  let caught;
  try { await bad.readLedger(); } catch (error) { caught = error; }
  assert.equal(caught.code, 'HTTPS_API_STATUS_401');
  const dump = `${caught.message} ${caught.detail} ${JSON.stringify(caught)} ${caught.stack}`;
  assert.equal(dump.includes('sbp_WRONG_TOKEN_0123456789'), false, 'the echoed wrong token is redacted');
  assert.equal(dump.includes(TOKEN), false);
  const ok = JSON.stringify(await run(fakeApi(), { apply: true }));
  assert.equal(ok.includes(TOKEN), false);
  assert.equal(/Bearer|sbp_/.test(ok), false);
  // a transport that echoes the real token in an error body still never leaks it
  const leaky = fakeApi({ secretEchoOn401: true });
  const t = createHttpsMigrationTransport({ token: TOKEN, projectRef: PROD, allowlist: ALLOW, redact: (x) => String(x),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => `boom ${TOKEN}` }) });
  let leakErr; try { await t.readLedger(); } catch (error) { leakErr = error; }
  assert.equal(`${leakErr.detail}`.includes(TOKEN), false, 'transport redacts the token itself even if the injected redactor does not');
  void leaky;
});

test('response shapes are parsed strictly and an unknown shape fails closed', () => {
  assert.deepEqual(parseMigrationHistory([{ version: '2' }, { version: '1' }, '1']), ['1', '2']);
  assert.deepEqual(parseMigrationHistory({ migrations: [{ version: 3 }] }), ['3']);
  for (const bad of [null, {}, 'x', [{ name: 'no-version' }], [{ version: 'abc' }]]) {
    assert.throws(() => parseMigrationHistory(bad), (e) => e.code === 'HTTPS_MIGRATION_HISTORY_SHAPE_UNKNOWN');
  }
});

// ── research-clone schema lifecycle ──────────────────────────────────────────

const CLONE_SQL = `CREATE TABLE IF NOT EXISTS public.reservation_market_observations (id uuid PRIMARY KEY);
ALTER TABLE public.reservation_market_observations
${COLS.map((c, i) => `  ADD COLUMN IF NOT EXISTS ${c} ${i === 2 ? 'numeric' : 'text'}${i === COLS.length - 1 ? ';' : ','}`).join('\n')}
REVOKE ALL ON public.reservation_market_observations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservation_market_observations TO service_role;
`;

test('CLONE: allowlisted ref, exact idempotent file, rolled-back dry-run, one transaction, column proof, no ledger', async () => {
  assert.deepEqual([...PREMVP_RESEARCH_CLONE_PROJECT_REFS], [CLONE]);
  const decl = { mode: 'PREMVP_RESEARCH_CLONE_SCHEMA_V1', schema_file: 'ops/research-clone/reservation-telemetry-schema.sql', target_sha256: sha256OfText(CLONE_SQL), project_ref: CLONE, idempotent: true, direct_raw_mutation: false, verify_columns: VERIFY };
  assert.deepEqual(validateCloneSchemaDeclaration(decl), { ok: true, errors: [] });
  const api = fakeApi();
  const transport = transportFor(api, CLONE, PREMVP_RESEARCH_CLONE_PROJECT_REFS);
  const dry = await runHttpsCloneSchema({ transport, schemaSql: CLONE_SQL, schemaSha256: decl.target_sha256, schemaFile: decl.schema_file, verify: VERIFY });
  assert.equal(dry.mode, 'dry_run');
  assert.equal(api.state.schema.size, 1, 'dry-run left the clone unchanged');
  const applied = await runHttpsCloneSchema({ transport, schemaSql: CLONE_SQL, schemaSha256: decl.target_sha256, schemaFile: decl.schema_file, apply: true, verify: VERIFY });
  assert.equal(applied.mode, 'applied');
  assert.equal(applied.schema_changed, true);
  assert.equal(applied.columns_proof[0].all_present_nullable, true);
  assert.equal(applied.production_rows_mutated, undefined, 'no unmeasured literal claims; "no row mutation" is structural (allow-list)');
  assert.equal(api.log.some((l) => l.path === '/migrations'), false, 'the clone schema never touches the migration ledger');
  assert.equal(api.log.some((l) => l.query === sqlCloneApply(CLONE_SQL)), true, 'exact file in one transaction');
  assert.deepEqual(applied.statement_kinds, { create_table_if_not_exists: 1, add_column_if_not_exists: 1, revoke: 1, grant_to_service_role: 1 });
  assert.equal(applied.statement_allowlist_enforced, true);
});

test('CLONE: wrong project, non-idempotent, traversal path, destructive SQL and unproven columns are rejected', async () => {
  const base = { mode: 'PREMVP_RESEARCH_CLONE_SCHEMA_V1', schema_file: 'ops/research-clone/reservation-telemetry-schema.sql', target_sha256: 'a'.repeat(64), project_ref: CLONE, idempotent: true, direct_raw_mutation: false, verify_columns: VERIFY };
  const errs = (patch) => validateCloneSchemaDeclaration({ ...base, ...patch }).errors;
  assert.ok(errs({ project_ref: PROD }).includes('PROJECT_REF_NOT_ALLOWLISTED'), 'production is not a clone target');
  assert.ok(errs({ idempotent: false }).includes('CLONE_SCHEMA_IDEMPOTENT_REQUIRED'));
  assert.ok(errs({ schema_file: 'ops/research-clone/../../.env' }).includes('CLONE_SCHEMA_FILE_INVALID'));
  assert.ok(errs({ schema_file: 'supabase/migrations/x.sql' }).includes('CLONE_SCHEMA_FILE_INVALID'));
  assert.ok(errs({ direct_raw_mutation: true }).includes('RAW_DATABASE_MUTATION_FORBIDDEN'));
  assert.ok(errs({ verify_columns: undefined }).includes('VERIFY_COLUMNS_REQUIRED'));
  assert.ok(errs({ verify_columns: [{ schema: 'public', table: 't', columns: ["a'; drop"] }] }).includes('VERIFY_COLUMNS_IDENTIFIER_INVALID'));
  for (const bad of ['DROP TABLE public.x;', 'TRUNCATE public.x;', 'DELETE FROM public.x;', 'GRANT ALL ON public.x TO anon;', 'COMMIT;']) {
    assert.throws(() => assertCloneSqlSafe(bad), (e) => e instanceof HttpsTransportError, bad);
  }
  // columns that are not actually present after apply fail closed
  const api = fakeApi();
  const transport = transportFor(api, CLONE, PREMVP_RESEARCH_CLONE_PROJECT_REFS);
  const noColumnSql = 'CREATE TABLE IF NOT EXISTS public.reservation_market_observations (id uuid PRIMARY KEY);\n';
  await assert.rejects(runHttpsCloneSchema({ transport, schemaSql: noColumnSql, schemaSha256: sha256OfText(noColumnSql), schemaFile: 'f', apply: true, verify: VERIFY }), (e) => e.code === 'CLONE_SCHEMA_COLUMNS_NOT_PROVEN');
  assert.deepEqual(columnsProof([{ column_name: 'a', data_type: 'text', is_nullable: false }], { schema: 's', table: 't', columns: ['a', 'b'] }).missing, ['b']);
});


// ── review fixes: probe control, completion proof, enforced columns, orchestrator-level SHA ──────────

test('D3: a request split across sessions fails the same-session positive control; target SQL never sent', async () => {
  const api = fakeApi({ sessionSplit: true });
  await assert.rejects(run(api), (e) => e.code === 'HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN');
  assert.equal(api.log.some((l) => (l.query ?? '').includes('ADD COLUMN')), false);
  assert.match(SQL_TRANSACTION_PROBE, /to_regclass\('pg_temp\.premvp_txn_probe'\) IS NULL THEN RAISE EXCEPTION/, 'positive control inside the transaction');
});

test('the dry-run response must prove the script ran to its end (completion marker), not merely a 2xx', async () => {
  await assert.rejects(run(fakeApi({ noCompletionMarker: true })), (e) => e.code === 'HTTPS_DRY_RUN_COMPLETION_NOT_PROVEN');
});

test('D6: apply ENFORCES the column proof (ledger recorded but DDL absent => fail closed with state) and REQUIRES verify columns', async () => {
  await assert.rejects(run(fakeApi({ nativeSkipsDdl: true }), { apply: true }), (e) => e.code === 'TARGET_ONLY_COLUMNS_NOT_PROVEN' && /ledger_recorded=true/.test(e.detail ?? ''));
  const api = fakeApi();
  await assert.rejects(run(api, { apply: true, verify: null }), (e) => e.code === 'TARGET_ONLY_VERIFY_COLUMNS_REQUIRED');
  await assert.rejects(run(api, { apply: true, verify: [] }), (e) => e.code === 'TARGET_ONLY_VERIFY_COLUMNS_REQUIRED');
  assert.equal(api.log.length, 0, 'refused before any request');
  const dry = await run(api, { verify: null });
  assert.equal(dry.mode, 'dry_run', 'a dry-run needs no verify list');
});

test('the SHA pin is re-enforced inside the orchestrators (defence in depth), not only in the adapter', async () => {
  const api = fakeApi();
  await assert.rejects(run(api, { targetSha256: 'a'.repeat(64) }), (e) => e.code === 'HTTPS_TARGET_SHA256_MISMATCH');
  const transport = transportFor(api, CLONE, PREMVP_RESEARCH_CLONE_PROJECT_REFS);
  await assert.rejects(runHttpsCloneSchema({ transport, schemaSql: CLONE_SQL, schemaSha256: 'a'.repeat(64), schemaFile: 'f', verify: VERIFY }), (e) => e.code === 'HTTPS_TARGET_SHA256_MISMATCH');
  assert.equal(api.log.length, 0);
});

test('remote ledger -> local file resolution is strict (no vacuous prefix matches)', () => {
  const files = ['20260930070000_a.sql', '20261001085007_b.sql'];
  assert.deepEqual(resolveTrackedStrict(['20260930070000'], files).missing, []);
  assert.deepEqual(resolveTrackedStrict(['2026'], files).missing, ['2026'], 'a short remote version must not match by prefix');
  assert.deepEqual(resolveTrackedStrict(['20260930070001'], files).missing, ['20260930070001']);
  assert.deepEqual(resolveTrackedStrict(['20261001085007'], ['20261001085007.sql']).missing, []);
});

test('CLONE SQL is an ALLOW-LIST of idempotent structural statements: DML, DROP, functions, policies and wide grants are refused', () => {
  for (const bad of [
    'INSERT INTO public.t VALUES (1);', 'UPDATE public.t SET a = 1;', ' DELETE FROM public.t;', 'TRUNCATE public.t;', 'DROP TABLE public.t;', 'DROP POLICY p ON public.t;',
    'DROP VIEW v;', 'ALTER TABLE public.t DROP COLUMN a;', 'ALTER TABLE public.t ADD COLUMN IF NOT EXISTS a int, DROP COLUMN b;', 'ALTER TABLE public.t ALTER COLUMN a TYPE text;',
    'ALTER TABLE public.t ADD COLUMN a int;', 'CREATE TABLE public.t (id int);', 'CREATE TABLE IF NOT EXISTS public.t AS SELECT 1;', 'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ select 1 $$ LANGUAGE sql;',
    'GRANT ALL ON public.t TO anon;', 'GRANT SELECT ON public.t TO authenticated;', 'COPY public.t FROM STDIN;', 'MERGE INTO public.t USING s ON true WHEN MATCHED THEN DELETE;',
    'DO $$ BEGIN DELETE FROM public.t; END $$;', 'CREATE INDEX ix ON public.t (a);',
  ]) {
    assert.throws(() => assertCloneSqlSafe(bad), (e) => e instanceof HttpsTransportError, bad);
  }
  const ok = assertCloneSqlSafe(`${CLONE_SQL}CREATE INDEX IF NOT EXISTS ix ON public.t (a);\nALTER TABLE public.t ENABLE ROW LEVEL SECURITY;\n-- DROP TABLE in a comment is fine\n`);
  assert.deepEqual(ok.statement_kinds, { create_table_if_not_exists: 1, add_column_if_not_exists: 1, revoke: 1, grant_to_service_role: 1, create_index_if_not_exists: 1, enable_row_level_security: 1 });
  assert.throws(() => assertCloneSqlSafe('-- only a comment\n'), /CLONE_SQL_EMPTY/);
});

test('F1: the lexer assumptions (standard_conforming_strings=on, UTF8) are PROVEN on the writer endpoint/role, else fail closed before target SQL', async () => {
  for (const options of [{ standardConformingStrings: 'off' }, { serverEncoding: 'LATIN1' }, { standardConformingStrings: null }]) {
    const api = fakeApi(options);
    await assert.rejects(run(api), (e) => e.code === 'HTTPS_SQL_LEXING_ASSUMPTIONS_NOT_PROVEN', JSON.stringify(options));
    assert.equal(api.log.some((l) => (l.query ?? '').includes('ADD COLUMN')), false, 'target SQL never sent');
  }
  assert.equal((await run(fakeApi({ serverEncoding: 'utf8' }))).mode, 'dry_run', 'encoding compare is case-insensitive');
  assert.match(SQL_TRANSACTION_PROBE, /current_setting\('standard_conforming_strings'\)/);
  assert.match(SQL_TRANSACTION_PROBE, /current_setting\('server_encoding'\)/);
});
