import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  BLIND_APPLIED_AFTER_BASELINE, BLIND_EXPECTED_LEDGER, BLIND_CATALOG_EXPECTED, BLIND_CLONE_REF, BLIND_MIGRATION_FILE, BLIND_MIGRATION_MODE, BLIND_MIGRATION_SHA256,
  assertBlindSqlShape, evaluateBlindCatalog, runBlindInputMigration, validateBlindInputMigration,
} from '../../scripts/control-plane/lib/premvp-clone-blind-input-migration.mjs';
import {
  SHADOW_CLONE_LEDGER_BASELINE, SHADOW_CLONE_REF, SHADOW_MIGRATION_FILE, SHADOW_MIGRATION_MODE, validateShadowMigration,
} from '../../scripts/control-plane/lib/premvp-clone-shadow-migration.mjs';
import { BLIND_INPUT_CATALOG_SQL, assertCloneSqlSafe, lexSql, validateCloneSchemaDeclaration } from '../../scripts/control-plane/lib/premvp-migration-https-transport.mjs';
import { sha256OfText } from '../../scripts/control-plane/lib/premvp-target-only-migration.mjs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sql = read(BLIND_MIGRATION_FILE);
const declaration = {
  mode: BLIND_MIGRATION_MODE, project_ref: BLIND_CLONE_REF, migration_file: BLIND_MIGRATION_FILE,
  target_sha256: sha256OfText(sql), direct_raw_mutation: false, idempotent: true,
};
const PRODUCTION_REF = 'nbnldzfsxffztsfrrxqy';

test('reviewed delta is pinned and passes the exact-SQL validator', () => {
  assert.equal(sha256OfText(sql), BLIND_MIGRATION_SHA256);
  assert.deepEqual(validateBlindInputMigration(declaration, sql), { ok: true, errors: [] });
  assert.deepEqual(assertBlindSqlShape(sql), []);
  assert.match(BLIND_MIGRATION_FILE, /^ops\/research-clone\/migrations\/\d{14}_[a-z0-9_]+\.sql$/);
});

test('wrong project, production target, wrong file or mode and raw-mutation declarations are rejected', () => {
  for (const patch of [
    { project_ref: PRODUCTION_REF }, { project_ref: 'abcdefghijklmnopqrst' }, { project_ref: SHADOW_CLONE_REF + 'x' },
    { migration_file: 'ops/research-clone/migrations/20261012150000_prospective_shadow_first_persistence.sql' },
    { migration_file: 'supabase/migrations/20261012200000_blind_model_input_authority.sql' },
    { mode: 'PREMVP_CLONE_SHADOW_IMMUTABILITY_V1' }, { mode: undefined },
    { direct_raw_mutation: true }, { idempotent: false }, { target_sha256: 'f'.repeat(64) }, { target_sha256: 'short' },
  ]) assert.equal(validateBlindInputMigration({ ...declaration, ...patch }, sql).ok, false, JSON.stringify(patch));
});

test('any changed SQL byte is rejected, even with a matching declaration hash', () => {
  const mutations = [
    sql.replace('with (security_barrier = true)', 'with (security_invoker = true)'),
    sql.replace('with (security_barrier = true)', ''),
    sql.replace('nobypassrls', 'bypassrls'),
    sql.replace('nologin', 'login password \'x\''),
    sql.replace('o.observed_at <= h.as_of and o.observed_at < o.event_start_iso;', 'true;'),
    sql.replace('o.id, o.physical_event_id, o.provider_event_id, o.event_start_iso', 'o.*, o.physical_event_id, o.provider_event_id, o.event_start_iso'),
    sql + '\ndrop table public.research_inplay_core_path_observations;',
    sql + '\ndelete from public.research_precontract_t20_observations;',
    sql + '\nupdate public.reservation_market_observations set best_bid = null;',
    sql + '\ngrant select on public.research_model_ready_rows to blind_model_reader;',
    sql + '\ngrant blind_model_reader to service_role;',
    sql + '\nalter role blind_model_reader bypassrls;',
    sql + '\ncommit;',
    sql + "\nselect set_config('role', 'service_role', false);",
    sql.replace('grant select on blind_obs.t20_observations_v1 to blind_model_reader;', 'grant select on public.research_model_ready_rows to blind_model_reader;'),
    sql.replace("'T20'", "'T21'"),
  ];
  for (const altered of mutations) {
    if (altered === sql) continue;
    const verdict = validateBlindInputMigration({ ...declaration, target_sha256: sha256OfText(altered) }, altered);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.includes('BLIND_SQL_NOT_EXACT_REVIEWED_DELTA'));
  }
});

test('structural allow-list rejects out-of-scope SQL independently of the pin', () => {
  for (const extra of [
    'drop view blind_obs.t20_observations_v1;', 'truncate public.reservation_market_observations;',
    'insert into blind_obs.model_horizon(as_of) values (now());', 'create function blind_obs.f() returns int language sql as $$ select 1 $$;',
    'create role blind_login login password \'x\';', 'grant service_role to blind_model_reader;', 'alter table public.reservation_market_observations disable row level security;',
    'create or replace view blind_obs.t20_observations_v1 with (security_barrier = true) as select o.* from public.research_precontract_t20_observations o join blind_obs.model_horizon h on h.singleton where o.observed_at <= h.as_of;',
    'create or replace view blind_obs.x_v1 as select o.id from public.research_model_ready_rows o;',
  ]) assert.ok(assertBlindSqlShape(`${sql}\n${extra}`).length > 0, extra);
  const doTamper = sql.replace("raise exception 'BLIND_ROLE_ATTRIBUTES_UNSAFE';", "raise exception 'BLIND_ROLE_ATTRIBUTES_UNSAFE'; delete from public.research_model_ready_rows;");
  assert.ok(assertBlindSqlShape(doTamper).some((e) => e.startsWith('BLIND_SQL_DO_BODY_TOKEN_FORBIDDEN')));
});

test('SQL never touches raw telemetry except through the three SELECT-only projections', () => {
  const { code, statements } = lexSql(sql);
  assert.doesNotMatch(code, /\b(?:drop|delete|truncate|insert\s+into|copy|merge)\b/i);
  const referencing = statements.filter((s) => /\bpublic\.[a-z_]+/.test(s)).filter((s) => !/^revoke all on schema/.test(s));
  const acl = referencing.filter((st) => st.startsWith('revoke execute on function '));
  assert.deepEqual(acl, ['revoke execute on function public.record_football_execution_matrix_s1s2s3_evidence(jsonb) from public']);
  const views = referencing.filter((st) => !acl.includes(st));
  assert.equal(views.length, 3);
  for (const s of views) assert.match(s, /^create or replace view blind_obs\.[a-z0-9_]+_v1 with \(security_barrier = true\) as select /);
  // the ACL correction is exactly one function, revoke-only, from PUBLIC only: no grant to anything but the three blind roles
  assert.equal(statements.filter((st) => /^grant /.test(st) && !/ to (?:blind_model_reader|blind_horizon_writer)$/.test(st)).length, 0);
  assert.doesNotMatch(sql, /\balter table public\./i);
  assert.doesNotMatch(sql, /\b(?:research_model_ready_rows|research_model_ready_days|research_model_economics|research_t10_sibling_offpolicy_rows|settlement_label|frozenLabel|labelAsOf|canonical_row)\b/);
});

test('projection allow-lists exclude lineage, policy and outcome-bearing columns and use no wildcard or JSON', () => {
  const views = [...sql.matchAll(/create or replace view blind_obs\.([a-z0-9_]+) with \(security_barrier = true\) as\nselect\n([\s\S]*?)\nfrom public\./g)];
  assert.equal(views.length, 3);
  for (const [, name, list] of views) {
    const items = list.split(',').map((c) => c.trim()).filter(Boolean);
    const derived = items.filter((c) => !/^o\.[a-z0-9_]+$/.test(c));
    assert.equal(derived.length, 1, `${name} derived columns`);
    assert.match(derived[0], /^(?:case when o\.created_at <= h\.as_of then 'CREATED_AT_LE_HORIZON' else 'OBSERVED_AT_ONLY' end|'OBSERVED_AT_ONLY'::text) as asof_evidence$/);
    const columns = items.filter((c) => !derived.includes(c)).map((c) => c.replace(/^o\./, ''));
    assert.equal(new Set(columns).size, columns.length, `${name} duplicates`);
    for (const forbidden of ['reservation_id', 'capture_run_id', 'live_policy_eligibility', 'live_policy_rejection_reason'])
      assert.ok(!columns.includes(forbidden), `${name}.${forbidden}`);
    assert.ok(columns.every((c) => /^[a-z0-9_]+$/.test(c) && !/(settlement|label|winner|pnl|result|json|payload)/.test(c)), name);
    assert.ok(columns.includes('observed_at'));
  }
});

function ledgerOf(extra = BLIND_APPLIED_AFTER_BASELINE) { return [...SHADOW_CLONE_LEDGER_BASELINE, ...extra]; }
function fakeTransport({ ledger = ledgerOf(), catalog = { ...BLIND_CATALOG_EXPECTED } } = {}) {
  const calls = [];
  let applied = false;
  let fingerprintReads = 0;
  return {
    projectRef: BLIND_CLONE_REF, calls,
    async readLedger() { calls.push('ledger'); return applied ? [...ledger, '20261012200000'] : [...ledger]; },
    async readSchemaFingerprint() { calls.push('fingerprint'); return { fingerprint: ++fingerprintReads < 3 ? 'before' : 'after' }; },
    async proveTransactionSemantics() { calls.push('transaction'); },
    async dryRunExactSql(value) { assert.equal(value, sql); calls.push('dry_run'); },
    async applyNative({ sql: value, name, localTimeouts }) {
      assert.equal(value, sql); assert.equal(name, 'blind_model_input_authority'); assert.equal(localTimeouts, true);
      applied = true; calls.push('native_apply');
    },
    async readColumns(schema, table, columns) { calls.push('columns'); assert.equal(schema, 'blind_obs'); return columns.map((c) => ({ column_name: c, data_type: 'text', is_nullable: true })); },
    async readBlindInputCatalog() { calls.push('catalog'); return catalog; },
  };
}

test('dry-run proves rollback and never applies, never reads the catalog and never claims runtime proof', async () => {
  const transport = fakeTransport();
  const result = await runBlindInputMigration({ transport, declaration, sql });
  assert.equal(result.mode, 'dry_run');
  assert.equal(result.applied, false);
  assert.equal(result.dry_run.schema_unchanged, true);
  assert.equal(result.dry_run.ledger_unchanged, true);
  assert.equal(result.runtime_privilege_proof, 'RUNTIME_UNVERIFIED');
  assert.equal(transport.calls.includes('native_apply'), false);
  assert.equal(transport.calls.includes('catalog'), false);
});

test('ledger is accepted only as the exact observed DBClone history (baseline + 150000 + 180000 + 190000), in order', async () => {
  assert.deepEqual(BLIND_APPLIED_AFTER_BASELINE, ['20261012150000', '20261012180000', '20261012190000']);
  assert.equal(BLIND_EXPECTED_LEDGER.length, SHADOW_CLONE_LEDGER_BASELINE.length + 3);
  assert.ok(BLIND_MIGRATION_FILE.includes('20261012200000_') && '20261012200000' > BLIND_EXPECTED_LEDGER.at(-1), 'blind version sorts after the last applied one');
  await runBlindInputMigration({ transport: fakeTransport(), declaration, sql });
  const drift = (error) => error.code === 'TARGET_ONLY_REMOTE_TRACKED_FILE_MISSING_LOCALLY' && /BLIND_CLONE_LEDGER_DRIFT/.test(error.detail);
  const reject = async (ledger) => assert.rejects(runBlindInputMigration({ transport: fakeTransport({ ledger }), declaration, sql }), drift);
  await reject(ledgerOf([]));                                                                     // the old pre-shadow baseline
  await reject(ledgerOf(['20261012150000']));                                                     // the old baseline + shadow shape
  await reject(ledgerOf(['20261012150000', '20261012180000']));                                   // 190000 missing
  await reject(ledgerOf(['20261012150000', '20261012190000']));                                   // 180000 missing
  await reject(ledgerOf(['20261012150000', '20261012190000', '20261012180000']));                 // reordered
  await reject(ledgerOf([...BLIND_APPLIED_AFTER_BASELINE, '20261012195999']));                    // unknown extra
  await reject(ledgerOf([...BLIND_APPLIED_AFTER_BASELINE, '20261012200000']));                    // target already recorded
  await reject(ledgerOf().slice(1));                                                              // baseline entry dropped
});

test('transport bound to another project is refused before any call', async () => {
  const transport = { ...fakeTransport(), projectRef: PRODUCTION_REF };
  await assert.rejects(runBlindInputMigration({ transport, declaration, sql }), /BLIND_TRANSPORT_PROJECT_MISMATCH/);
  assert.deepEqual(transport.calls, []);
});

test('apply requires the catalog read-back to prove every expected effective-privilege count', async () => {
  const ok = await runBlindInputMigration({ transport: fakeTransport(), declaration, sql, apply: true });
  assert.equal(ok.applied, true);
  assert.equal(ok.runtime_privilege_proof, 'CATALOG_PROVEN_LOGIN_PROBE_PENDING');
  for (const key of Object.keys(BLIND_CATALOG_EXPECTED)) {
    const catalog = { ...BLIND_CATALOG_EXPECTED, [key]: BLIND_CATALOG_EXPECTED[key] + 1 };
    assert.deepEqual(evaluateBlindCatalog(catalog), [`BLIND_CATALOG_${key.toUpperCase()}`]);
    await assert.rejects(runBlindInputMigration({ transport: fakeTransport({ catalog }), declaration, sql, apply: true }), /BLIND_INPUT_CATALOG_NOT_PROVEN/);
  }
  assert.deepEqual(evaluateBlindCatalog(null), ['BLIND_CATALOG_MISSING']);
});

test('neither clone-schema nor clone-shadow can carry this change, and clone-shadow still rejects everything else', () => {
  assert.throws(() => assertCloneSqlSafe(sql), (error) => error.code === 'CLONE_SQL_STATEMENT_NOT_ALLOWED');
  assert.equal(validateCloneSchemaDeclaration({
    mode: 'PREMVP_RESEARCH_CLONE_SCHEMA_V1', schema_file: BLIND_MIGRATION_FILE, target_sha256: sha256OfText(sql), project_ref: BLIND_CLONE_REF,
    idempotent: true, direct_raw_mutation: false, verify_columns: [{ schema: 'blind_obs', table: 'x', columns: ['id'] }],
  }).ok, false);
  const shadowSql = read(SHADOW_MIGRATION_FILE);
  const shadowDeclaration = {
    mode: SHADOW_MIGRATION_MODE, project_ref: SHADOW_CLONE_REF, migration_file: SHADOW_MIGRATION_FILE,
    target_sha256: sha256OfText(shadowSql), direct_raw_mutation: false, idempotent: true,
  };
  assert.deepEqual(validateShadowMigration(shadowDeclaration, shadowSql), { ok: true, errors: [] });
  assert.equal(validateShadowMigration({ ...shadowDeclaration, migration_file: BLIND_MIGRATION_FILE, target_sha256: sha256OfText(sql) }, sql).ok, false);
  assert.equal(validateBlindInputMigration({ ...declaration, migration_file: SHADOW_MIGRATION_FILE, target_sha256: sha256OfText(shadowSql) }, shadowSql).ok, false);
});

test('adapter exposes exactly one blind-input entry and requires the two apply confirmations', () => {
  const adapter = read('scripts/control-plane/apply-premvp-approved-migration.mjs');
  assert.equal((adapter.match(/args\.includes\('--clone-blind-input'\)/g) ?? []).length, 1);
  assert.equal((adapter.match(/args\.includes\('--clone-shadow-immutability'\)/g) ?? []).length, 1);
  const body = adapter.slice(adapter.indexOf('async function runCloneBlindInput()'), adapter.indexOf('const migrationFile = readAndValidateMigration'));
  assert.match(body, /assertApplyConfirmation\(args, process\.env\)/);
  assert.match(body, /allowlist: PREMVP_RESEARCH_CLONE_PROJECT_REFS/);
  assert.doesNotMatch(body, /service_role|SUPABASE_CLONE_SERVICE_ROLE_KEY/);
});

test('the single operator script embeds the pinned migration byte-for-byte, guards the target, and is atomic', () => {
  const op = read('ops/research-clone/operator/20261012200000_blind_model_input_authority.operator.sql');
  assert.ok(op.includes(sql.trimEnd()), 'migration body is embedded verbatim');
  assert.ok(op.includes(BLIND_INPUT_CATALOG_SQL), 'catalog read-back is the fixed one');
  assert.ok(op.includes(`SHA-256: ${BLIND_MIGRATION_SHA256}`));
  const guard = op.slice(op.indexOf('begin;'), op.indexOf(sql.slice(0, 40)));
  for (const version of BLIND_EXPECTED_LEDGER) assert.ok(guard.includes(`'${version}'`), version);
  assert.equal((guard.match(/'\d{14}'/g) ?? []).length, BLIND_EXPECTED_LEDGER.length, 'exact ledger, nothing extra');
  assert.match(guard, /OPERATOR_LEDGER_DRIFT_NOT_DBCLONE_OR_CHANGED/);
  assert.match(guard, /OPERATOR_ALREADY_APPLIED_OR_PARTIAL/);
  assert.match(guard, /set local lock_timeout = '5s'/);
  assert.match(op, /nppznoujvnyjargjkmnv/);
  assert.equal(op.match(/\bcommit;/g).length, 1);
  const wrapper = lexSql(op.replace(sql.trimEnd(), '').replace(BLIND_INPUT_CATALOG_SQL, '')).code;
  assert.doesNotMatch(wrapper, /\b(?:insert|update|delete|drop|truncate|grant|revoke|create|alter)\b/i, 'wrapper adds no write statement of its own');
  assert.doesNotMatch(op, /supabase_migrations\.schema_migrations\s*\(|insert into supabase_migrations/i);
  assert.ok(!op.includes('nbnldzfsxffztsfrrxqy') || /NEVER run on nbnldzfsxffztsfrrxqy/.test(op));
});
