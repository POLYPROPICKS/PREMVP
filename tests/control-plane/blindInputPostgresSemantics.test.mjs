// Real-PostgreSQL semantics for the blind-input migration. Opt-in: requires a scratch PostgreSQL where the caller is a
// superuser (BLIND_INPUT_PG_HOST = unix-socket dir or host, BLIND_INPUT_PG_PORT, optional BLIND_INPUT_PG_ADMIN).
// It never touches DBClone or Production. Without the env the suite is SKIPPED and the runtime claim stays RUNTIME_UNVERIFIED.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { BLIND_CATALOG_EXPECTED, BLIND_MIGRATION_FILE, evaluateBlindCatalog } from '../../scripts/control-plane/lib/premvp-clone-blind-input-migration.mjs';
import { BLIND_INPUT_CATALOG_SQL } from '../../scripts/control-plane/lib/premvp-migration-https-transport.mjs';

const HOST = process.env.BLIND_INPUT_PG_HOST;
const PORT = process.env.BLIND_INPUT_PG_PORT ?? '5432';
const ADMIN = process.env.BLIND_INPUT_PG_ADMIN ?? 'postgres';
const SKIP = HOST ? false : 'RUNTIME_UNVERIFIED: set BLIND_INPUT_PG_HOST to a scratch PostgreSQL superuser endpoint';
const root = (rel) => new URL(`../../${rel}`, import.meta.url);
const migrationSql = fs.readFileSync(root(BLIND_MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n');
const FIXTURE_DDL = ['precontract-t20-research-schema', 'inplay-core-path-schema', 'reservation-telemetry-schema', 'model-ready-schema', 't10-sibling-offpolicy-schema', 'prospective-selection-shadow-runtime-schema']
  .map((name) => fs.readFileSync(root(`ops/research-clone/${name}.sql`), 'utf8'));
const OWNER = 'sim_postgres';
const CLUSTER_ROLES = ['blind_model_reader', 'blind_horizon_writer', 'research_ledger_writer', 'research_settlement_authority', OWNER, 'anon', 'authenticated', 'service_role'];
const RAW = ['research_precontract_t20_observations', 'reservation_market_observations', 'research_inplay_core_path_observations'];

function psql(user, db, input) {
  const run = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', HOST, '-p', PORT, '-U', user, '-d', db], { input, encoding: 'utf8' });
  return { ok: run.status === 0, out: run.stdout.trim(), err: run.stderr.trim() };
}
const admin = (sql, db = 'postgres') => psql(ADMIN, db, sql);
const asOwner = (db, sql) => psql(OWNER, db, sql);
const asReader = (db, sql) => psql('blind_model_reader', db, sql);
const wrap = (sql, end) => `BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '45s';\n${sql}\n${end};`;
const dropClusterRoles = () => admin(CLUSTER_ROLES.map((r) => `drop role if exists ${r};`).join('\n'));

function freshDb(name, { prepare = '' } = {}) {
  admin(`drop database if exists ${name};`);
  dropClusterRoles();
  assert.ok(admin(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create role ${OWNER} createrole createdb login; create database ${name} owner ${OWNER};`).ok);
  // Supabase-like global default privileges: new tables/functions made by the owner are handed to the API roles.
  assert.ok(asOwner(name, `alter default privileges for role ${OWNER} grant all on tables to anon, authenticated, service_role;
    alter default privileges for role ${OWNER} grant execute on functions to anon, authenticated, service_role;`).ok);
  for (const ddl of FIXTURE_DDL) { const r = asOwner(name, ddl); assert.ok(r.ok, r.err); }
  if (prepare) { const r = admin(prepare, name); assert.ok(r.ok, r.err); }
  return name;
}

const seed = `
insert into public.research_precontract_t20_observations(id,physical_event_id,source_id,source_version,event_start_iso,observed_at,observation_phase,condition_id,token_id,side,best_ask) values
 (gen_random_uuid(),'e1','s','v','2026-10-01T12:00Z','2026-10-01T10:00Z','T20','c','t1','YES',0.40),
 (gen_random_uuid(),'e1','s','v','2026-10-01T12:00Z','2026-10-01T11:00Z','T20','c','t2','YES',0.41),
 (gen_random_uuid(),'e1','s','v','2026-10-01T12:00Z','2026-10-01T11:30Z','T20','c','t3','YES',0.42),
 (gen_random_uuid(),'e1','s','v','2026-10-01T12:00Z','2026-10-01T12:30Z','T20','c','t4','YES',0.99);
insert into public.reservation_market_observations(id,capture_run_id,reservation_id,physical_event_id,event_start_iso,observation_phase,observed_at,minutes_to_start,condition_id,token_id,side,orderbook_fetch_status,source_version,created_at,best_ask) values
 (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'e1','2026-10-01T12:00Z','T_MINUS_30','2026-10-01T10:00Z',120,'c','t1','YES','OK','v',now(),0.40),
 (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'e1','2026-10-01T12:00Z','T_MINUS_10','2026-10-01T11:00Z',60,'c','t2','YES','OK','v',now(),0.41),
 (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'e1','2026-10-01T12:00Z','LIVE_GUARD','2026-10-01T11:30Z',30,'c','t3','YES','OK','v',now(),0.42),
 (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'e1','2026-10-01T12:00Z','LIVE_GUARD','2026-10-01T12:30Z',-30,'c','t4','YES','OK','v',now(),0.99);
insert into public.research_inplay_core_path_observations(id,physical_event_id,provider_event_id,provider_sport_family,provider_sport_source,event_start_iso,observed_at,source_version,event_live_status,state_authority,condition_id,token_id,side,canonical_market_family,canonical_market_type,orderbook_fetch_status,persistence_reason,sequence_in_event,best_ask,side_a_score) values
 (gen_random_uuid(),'e1','p1','tennis','x','2026-10-01T12:00Z','2026-10-01T12:10Z','v','LIVE','a','c','t1','YES','M','ML','OK','r',1,0.50,0),
 (gen_random_uuid(),'e1','p1','tennis','x','2026-10-01T12:00Z','2026-10-01T12:20Z','v','LIVE','a','c','t1','YES','M','ML','OK','r',2,0.55,1),
 (gen_random_uuid(),'e1','p1','tennis','x','2026-10-01T12:00Z','2026-10-01T12:30Z','v','FINAL','a','c','t1','YES','M','ML','OK','r',3,0.99,2);
insert into public.research_model_ready_rows(model_date,population_id,condition_id,selected_token_id,decision_at,settlement_label,materializer_version,canonical_row,canonical_row_sha256)
 values ('2026-10-01','p','c','t1','2026-10-01T10:00Z','WIN','v','{"frozenLabel":"WIN","labelAsOf":"2026-10-02"}','x');`;
const checksum = (db) => asOwner(db, RAW.map((t) => `select '${t}', count(*), md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from public.${t} x;`).join('\n')).out;
const setHorizon = (db, iso) => assert.ok(admin(`insert into blind_obs.model_horizon(as_of) values ('${iso}') on conflict (singleton) do update set as_of = excluded.as_of;`, db).ok);
const counts = (db) => asReader(db, `select (select count(*) from prematch_observations_v1), (select count(*) from t20_observations_v1), (select count(*) from inplay_observations_v1);`).out;
const denied = (r, pattern) => { assert.equal(r.ok, false, `expected failure, got: ${r.out}`); assert.match(r.err, pattern); };
const rw = (sql) => `begin; set transaction read write; ${sql}; rollback;`;

describe('blind input authority on real PostgreSQL', { skip: SKIP }, () => {
  const DB = 'blind_sem_main';
  let before_checksum;
  before(() => {
    freshDb(DB);
    assert.ok(asOwner(DB, seed).ok);
    before_checksum = checksum(DB);
  });
  after(() => { admin(`drop database if exists ${DB};`); dropClusterRoles(); });

  test('dry run (BEGIN..ROLLBACK) leaves no role, schema or object behind', () => {
    const roles = () => admin(`select count(*) from pg_roles where rolname in ('blind_model_reader','blind_horizon_writer','research_ledger_writer','research_settlement_authority');`).out;
    const run = asOwner(DB, wrap(migrationSql, 'ROLLBACK'));
    assert.ok(run.ok, run.err);
    assert.equal(roles(), '0');
    assert.equal(admin(`select count(*) from pg_namespace where nspname = 'blind_obs';`, DB).out, '0');
  });

  test('applies under a NON-superuser CREATEROLE owner and the catalog read-back matches the expected proof exactly', () => {
    assert.equal(admin(`select rolsuper from pg_roles where rolname = '${OWNER}';`).out, 'f');
    const run = asOwner(DB, wrap(migrationSql, 'COMMIT'));
    assert.ok(run.ok, run.err);
    const parsed = JSON.parse(asOwner(DB, `select row_to_json(t) from (${BLIND_INPUT_CATALOG_SQL}) t;`).out);
    assert.deepEqual(evaluateBlindCatalog(parsed), []);
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(BLIND_CATALOG_EXPECTED).sort());
    const attrs = admin(`select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, rolcanlogin from pg_roles where rolname like 'blind_%' or rolname like 'research_%' order by 1;`).out;
    assert.match(attrs, /blind_model_reader\|f\|f\|f\|f\|f\|f\|f/);
    // deployment of the credential is a later stage: simulate it here, the migration itself created no LOGIN
    assert.ok(admin(`alter role blind_model_reader login; alter role blind_horizon_writer login;`).ok);
  });

  test('no horizon row = fail closed: the reader sees zero observations', () => {
    assert.equal(counts(DB), '0|0|0');
  });

  test('restricted reader reads sufficient observations, bounded by the DB-owned as-of horizon (no post-decision ticks)', () => {
    setHorizon(DB, '2026-10-01T10:30Z');
    assert.equal(counts(DB), '1|1|0');
    setHorizon(DB, '2026-10-01T11:45Z');
    assert.equal(counts(DB), '3|3|0');
    setHorizon(DB, '2026-10-01T12:25Z');
    assert.equal(counts(DB), '3|3|2');
    const maxima = asReader(DB, `select (select max(observed_at) from t20_observations_v1), (select max(observed_at) from inplay_observations_v1), (select count(*) from t20_observations_v1 where observed_at >= event_start_iso);`).out;
    assert.equal(maxima, '2026-10-01 11:30:00+00|2026-10-01 12:20:00+00|0');
    // the FINAL tick (score 2, price 0.99) is beyond the horizon and unreachable
    assert.equal(asReader(DB, `select count(*) from inplay_observations_v1 where event_live_status = 'FINAL' or best_ask >= 0.99;`).out, '0');
    setHorizon(DB, '2026-10-01T10:30Z');
  });

  test('direct, mixed, JSON, DDL and alternative-credential access to outcome-bearing objects is denied (also in read-write transactions)', () => {
    for (const table of ['research_model_ready_rows', 'research_model_ready_days', 'research_model_economics', 'research_t10_sibling_offpolicy_rows', 'prospective_selection_shadow_runtime', ...RAW])
      denied(asReader(DB, `select 1 from public.${table} limit 1;`), /permission denied for table/);
    denied(asReader(DB, `select t.id from t20_observations_v1 t join public.research_model_ready_rows m on m.condition_id = t.condition_id;`), /permission denied for table research_model_ready_rows/);
    denied(asReader(DB, `select canonical_row from t20_observations_v1;`), /column "canonical_row" does not exist/);
    denied(asReader(DB, `select settlement_label from t20_observations_v1;`), /column "settlement_label" does not exist/);
    denied(asReader(DB, `select 1 from blind_obs.model_horizon;`), /permission denied for table model_horizon/);
    denied(asReader(DB, rw(`insert into blind_obs.model_horizon(as_of) values (now())`)), /permission denied for table model_horizon/);
    denied(asReader(DB, rw(`update blind_obs.model_horizon set as_of = now()`)), /permission denied for table model_horizon/);
    denied(asReader(DB, rw(`insert into public.research_model_ready_rows(model_date) values (current_date)`)), /permission denied for table research_model_ready_rows/);
    denied(asReader(DB, rw(`create table public.stolen as select 1`)), /permission denied for schema public/);
    denied(asReader(DB, rw(`create table blind_obs.stolen as select 1`)), /permission denied for schema blind_obs/);
    denied(asReader(DB, rw(`create view blind_obs.v as select 1`)), /permission denied for schema blind_obs/);
    denied(asReader(DB, `set role service_role;`), /permission denied to set role/);
    denied(asReader(DB, `set session authorization ${ADMIN};`), /permission denied to set session authorization/);
    assert.equal(asReader(DB, `select count(*) from pg_roles r where pg_has_role('blind_model_reader', r.oid, 'MEMBER') and r.rolname <> 'blind_model_reader';`).out, '0');
    assert.equal(asReader(DB, `select count(*) from information_schema.columns where table_schema = 'blind_obs' and (data_type in ('json','jsonb') or column_name ~* '(settlement|label|winner|pnl|result)');`).out, '0');
  });

  test('an incorrect (newly label-bearing) base column or JSON blob can never appear through the explicit projections', () => {
    const baseColumns = () => asReader(DB, `select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'blind_obs' and table_name = 't20_observations_v1';`).out;
    const before_columns = baseColumns();
    assert.ok(admin(`alter table public.research_precontract_t20_observations add column label_json jsonb, add column settlement_label text;
      update public.research_precontract_t20_observations set label_json = '{"frozenLabel":"WIN","labelAsOf":"2026-10-09"}', settlement_label = 'WIN';`, DB).ok);
    assert.equal(baseColumns(), before_columns);
    denied(asReader(DB, `select label_json from t20_observations_v1;`), /column "label_json" does not exist/);
    assert.doesNotMatch(asReader(DB, `select row_to_json(t)::text from t20_observations_v1 t;`).out, /frozenLabel|labelAsOf|WIN|label_json|settlement/);
    assert.ok(admin(`alter table public.research_precontract_t20_observations drop column label_json, drop column settlement_label;`, DB).ok);
  });

  test('security_barrier is load-bearing: a reader-supplied leaky predicate cannot see rows beyond the as-of filter', () => {
    assert.ok(admin(`create schema blind_control; create view blind_control.t20_nobarrier as select o.id, o.observed_at, o.best_ask
      from public.research_precontract_t20_observations o join blind_obs.model_horizon h on h.singleton where o.observed_at <= h.as_of and o.observed_at < o.event_start_iso;
      grant usage on schema blind_control to blind_model_reader; grant select on blind_control.t20_nobarrier to blind_model_reader;`, DB).ok);
    const leak = (view) => asReader(DB, `begin; set transaction read write;
      create function pg_temp.leak(ts timestamptz) returns boolean language plpgsql cost 0.0000001 as $f$ begin raise notice 'LEAK %', ts; return true; end $f$;
      select count(*) from ${view} where pg_temp.leak(observed_at); rollback;`);
    const noBarrier = leak('blind_control.t20_nobarrier');
    const real = leak('blind_obs.t20_observations_v1');
    assert.ok(noBarrier.ok && real.ok, `${noBarrier.err}\n${real.err}`);
    const notices = (r) => (r.err.match(/LEAK /g) ?? []).length;
    assert.ok(notices(noBarrier) > 1, 'control view without security_barrier leaks future rows to the predicate (test is sensitive)');
    assert.equal(notices(real), 1, 'the barrier view only ever shows the one eligible row to the predicate');
    assert.doesNotMatch(real.err, /2026-10-01 (11|12):/);
    assert.ok(admin(`drop schema blind_control cascade;`, DB).ok);
  });

  test('changing outcome records cannot change deterministic selector input/output; identical input is bit-identical', () => {
    setHorizon(DB, '2026-10-01T12:25Z');
    const selector = `select md5(string_agg(id::text || ':' || coalesce(best_ask::text, ''), '|' order by id)) from (
      select id, best_ask from prematch_observations_v1 where best_ask < 0.5 union all select id, best_ask from t20_observations_v1 where best_ask < 0.5
      union all select id, best_ask from inplay_observations_v1) s;`;
    const first = asReader(DB, selector).out;
    assert.equal(asReader(DB, selector).out, first);
    assert.ok(admin(`update public.research_model_ready_rows set settlement_label = 'LOSS', canonical_row = '{"frozenLabel":"LOSS"}';
      insert into public.research_model_ready_rows(model_date,population_id,condition_id,selected_token_id,decision_at,settlement_label,materializer_version,canonical_row,canonical_row_sha256)
      values ('2026-10-02','p','c','t9','2026-10-02T10:00Z','WIN','v','{}','y');`, DB).ok);
    assert.equal(asReader(DB, selector).out, first);
    assert.ok(admin(`delete from public.research_model_ready_rows where selected_token_id = 't9';`, DB).ok);
  });

  test('original source rows are byte-identical after migration and every reader operation', () => {
    assert.equal(checksum(DB), before_checksum);
  });

  test('the horizon writer can write only the horizon, and nothing else', () => {
    assert.ok(psql('blind_horizon_writer', DB, `update blind_obs.model_horizon set as_of = as_of;`).ok);
    denied(psql('blind_horizon_writer', DB, `select 1 from public.research_model_ready_rows limit 1;`), /permission denied/);
    denied(psql('blind_horizon_writer', DB, `delete from blind_obs.model_horizon;`), /permission denied for table model_horizon/);
    denied(psql('blind_horizon_writer', DB, `select 1 from blind_obs.t20_observations_v1;`), /permission denied/);
  });
});

describe('fail-closed: unsafe environments abort the whole migration, leaving nothing behind', { skip: SKIP }, () => {
  const roleCount = () => admin(`select count(*) from pg_roles where rolname in ('blind_model_reader','blind_horizon_writer','research_ledger_writer','research_settlement_authority');`).out;
  const cases = [
    ['PUBLIC-executable SECURITY DEFINER RPC over outcomes', `create function public.leak_labels() returns setof text language sql security definer as $$ select settlement_label from public.research_model_ready_rows $$;
      grant execute on function public.leak_labels() to public;`, /BLIND_DEFINER_FUNCTION_EXPOSURE/],
    ['PUBLIC SELECT on an outcome table', `grant select on public.research_model_ready_rows to public;`, /BLIND_RELATION_EXPOSURE/],
    ['column-level SELECT granted to PUBLIC on an outcome column', `grant select (settlement_label) on public.research_model_ready_rows to public;`, /BLIND_RELATION_EXPOSURE/],
    ['PUBLIC CREATE on schema public', `grant create on schema public to public;`, /BLIND_SCHEMA_CREATE_EXPOSURE/],
    ['pre-existing BYPASSRLS reader role (even one the executor administers)', `create role blind_model_reader nologin bypassrls; grant blind_model_reader to ${OWNER} with admin option;`, /BLIND_ROLE_ATTRIBUTES_UNSAFE|permission denied to alter role/],
    ['pre-existing CREATEDB reader role the executor administers', `create role blind_model_reader nologin createdb; grant blind_model_reader to ${OWNER} with admin option;`, /BLIND_ROLE_ATTRIBUTES_UNSAFE/],
    ['pre-existing reader role that already has LOGIN', `create role blind_model_reader login; grant blind_model_reader to ${OWNER} with admin option;`, /BLIND_ROLE_ATTRIBUTES_UNSAFE/],
    ['PUBLIC USAGE on a sequence', `create sequence public.leaky_seq; grant usage on sequence public.leaky_seq to public;`, /BLIND_SEQUENCE_EXPOSURE/],
    ['PUBLIC CREATE on the database', `grant create on database blind_sem_neg to public;`, /BLIND_DATABASE_CREATE_EXPOSURE/],
    ['pre-existing reader already member of service_role', `create role blind_model_reader nologin noinherit in role service_role; grant blind_model_reader to ${OWNER} with admin option;`, /BLIND_ROLE_MEMBERSHIP_PRESENT/],
    ['foreign object already inside blind_obs', `create schema blind_obs authorization ${OWNER}; create table blind_obs.x(a int); alter table blind_obs.x owner to ${OWNER};`, /BLIND_SCHEMA_CONTENT_UNEXPECTED/],
  ];
  for (const [label, prepare, pattern] of cases) {
    test(label, () => {
      const db = freshDb('blind_sem_neg', { prepare });
      try {
        const run = asOwner(db, wrap(migrationSql, 'COMMIT'));
        assert.equal(run.ok, false, 'migration must abort');
        assert.match(run.err, pattern);
        if (!prepare.includes('create role blind_model_reader')) assert.equal(roleCount(), '0', 'roles roll back with the transaction');
        assert.equal(admin(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'blind_obs' and c.relkind = 'v';`, db).out, '0');
      } finally { admin('drop database if exists blind_sem_neg;'); dropClusterRoles(); }
    });
  }
  test('raw table the executor cannot read through RLS fails closed instead of producing silently empty views', () => {
    const db = freshDb('blind_sem_neg', { prepare: `alter table public.reservation_market_observations owner to ${ADMIN}; revoke all on public.reservation_market_observations from ${OWNER};` });
    try {
      const run = asOwner(db, wrap(migrationSql, 'COMMIT'));
      assert.equal(run.ok, false);
      assert.match(run.err, /BLIND_VIEW_OWNER_CANNOT_READ_RAW_TABLES|permission denied/);
      assert.equal(roleCount(), '0');
    } finally { admin('drop database if exists blind_sem_neg;'); dropClusterRoles(); }
  });
});
