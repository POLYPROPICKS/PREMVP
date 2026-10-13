-- =====================================================================================================================
-- DBCLONE-ONLY OPERATOR SCRIPT: BLIND_MODEL_INPUT_AUTHORITY_V1 (migration 20261012200000_blind_model_input_authority)
-- Run ONCE, as the project owner role, in the Supabase SQL Editor of project nppznoujvnyjargjkmnv (Research DBClone, PostgreSQL 17.x).
-- Confirm the project ref in the browser URL first. NEVER run on nbnldzfsxffztsfrrxqy (Production): the target guard below aborts
-- unless the migration ledger is exactly the DBClone history observed before this release.
-- Reviewed migration SHA-256: 2eaf16c933f51f51036faee38d9b247dd04b727f94a0ad9a8c9796125f6bdf18  (PR #528; body below is byte-identical to the Git file)
-- Atomic: any failed guard or assertion rolls back everything (roles, schema, views, ACL change). No data row is read or written.
-- Limitation (not a registered release): the SQL Editor creates no registered migration receipt and this script writes nothing to
-- supabase_migrations. Reconcile the receipt later through the registered --clone-blind-input mode (the body is re-runnable until a
-- restricted LOGIN credential is deployed; reconcile BEFORE deploying it).
-- Result: the last statement returns one row of effective-privilege counts; every value must equal the expected proof (see the PR).
-- =====================================================================================================================
begin;
set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $$
declare
  expected constant text[] := array['20260812152531', '20260812152539', '20260812154439', '20260813111146', '20260814083257', '20260907090854', '20260907090911', '20260916182024', '20260919072722', '20260923104049', '20260923121955', '20260924192128', '20260924201147', '20260925052246', '20260925071724', '20260925072111', '20260925092253', '20260925092300', '20260925133329', '20260925133336', '20260930081720', '20260930104845', '20260930120158', '20261007125949', '20261010093450', '20261011075303', '20261011075337', '20261011075355', '20261011173709', '20261012081337', '20261012091611', '20261012150000', '20261012180000', '20261012190000'];
  actual text[];
begin
  if current_setting('server_version_num')::int < 170000 then raise exception 'OPERATOR_TARGET_NOT_POSTGRES_17'; end if;
  select coalesce(array_agg(version order by version), array[]::text[]) into actual from supabase_migrations.schema_migrations;
  if actual is distinct from expected then raise exception 'OPERATOR_LEDGER_DRIFT_NOT_DBCLONE_OR_CHANGED:%', coalesce(array_length(actual, 1), 0); end if;
  if exists (select 1 from pg_namespace where nspname = 'blind_obs')
     or exists (select 1 from pg_roles where rolname in ('blind_model_reader', 'blind_horizon_writer', 'research_ledger_writer', 'research_settlement_authority')) then
    raise exception 'OPERATOR_ALREADY_APPLIED_OR_PARTIAL';
  end if;
  if to_regclass('public.reservation_market_observations') is null or to_regclass('public.research_precontract_t20_observations') is null
     or to_regclass('public.research_inplay_core_path_observations') is null then
    raise exception 'OPERATOR_RAW_OBSERVATION_TABLE_MISSING';
  end if;
end;
$$;

-- DBCLONE ONLY: nppznoujvnyjargjkmnv. BLIND_MODEL_INPUT_AUTHORITY_V1. NEVER apply to production (nbnldzfsxffztsfrrxqy).
-- Purpose: a restricted model-reader role that can read allow-listed, as-of-bounded, outcome-free projections of the
-- EXISTING raw observation tables, and nothing else. No data is copied, moved, rewritten or deleted.
-- Semantics (deliberate, see docs/modeling/BLIND_RESEARCH_DATA_CONTRACT_V1.md):
--   * views are DEFINER views (no security_invoker): the reader needs SELECT on the views only, never on the base tables;
--   * security_barrier = true: a reader-supplied (leaky) predicate can never run before the as-of filter;
--   * the as-of horizon is a DB-owned single row the reader can neither read nor write; no row = no visible observation;
--   * no password and no LOGIN is created here: credential deployment is a separate, later, founder-held stage;
--   * rows are selected by observed_at <= horizon, but observed_at alone is not proof the row was available at decision time:
--     asof_evidence = CREATED_AT_LE_HORIZON only when the row's own ingestion timestamp is also <= horizon, otherwise OBSERVED_AT_ONLY
--     (historical row kept, but not forward-input evidence; T20 has no ingestion timestamp, so it is always OBSERVED_AT_ONLY).
do $$
begin
  if current_setting('lock_timeout') <> '5s' or current_setting('statement_timeout') <> '45s' then
    raise exception 'BLIND_MIGRATION_TIMEOUTS_NOT_ACTIVE';
  end if;
end;
$$;

do $$
declare
  r text;
begin
  foreach r in array array['blind_model_reader', 'blind_horizon_writer', 'research_ledger_writer', 'research_settlement_authority'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls', r);
    end if;
  end loop;
end;
$$;

alter role blind_model_reader set default_transaction_read_only = on;
alter role blind_model_reader set statement_timeout = '60s';
alter role blind_model_reader set search_path = blind_obs, pg_catalog;

create schema if not exists blind_obs;
revoke all on schema blind_obs from public, anon, authenticated, service_role;

create table if not exists blind_obs.model_horizon (
  singleton boolean primary key default true check (singleton),
  as_of timestamptz not null,
  set_by text not null default session_user,
  set_at timestamptz not null default clock_timestamp()
);
revoke all on blind_obs.model_horizon from public, anon, authenticated, service_role;

create or replace view blind_obs.prematch_observations_v1 with (security_barrier = true) as
select
  o.id, o.physical_event_id, o.provider_event_id, o.event_start_iso, o.observation_phase, o.observed_at,
  o.minutes_to_start, o.condition_id, o.token_id, o.side, o.outcome, o.canonical_market_family,
  o.canonical_market_type, o.provider_market_type_raw, o.market_slug, o.best_bid, o.best_ask, o.mid_price,
  o.bid_decimal_odds, o.ask_decimal_odds, o.spread_abs, o.spread_bps, o.bid_depth_relevant_usd,
  o.ask_depth_relevant_usd, o.tick_size, o.minimum_order_size, o.orderbook_fetch_latency_ms,
  o.orderbook_fetch_status, o.orderbook_failure_reason, o.source_version, o.created_at, o.reference_entry_price,
  o.execution_price_cap, o.requested_stake_usd, o.full_stake_executable_vwap, o.executable_telemetry_version,
  o.executable_full_stake, o.executable_full_stake_state, o.full_stake_shares, o.full_stake_worst_ask_price,
  o.taker_fee_state, o.taker_fee_reason, o.taker_fee_rate, o.taker_fee_usd, o.taker_effective_cost_per_share,
  o.taker_fee_formula_version,
  case when o.created_at <= h.as_of then 'CREATED_AT_LE_HORIZON' else 'OBSERVED_AT_ONLY' end as asof_evidence
from public.reservation_market_observations o
join blind_obs.model_horizon h on h.singleton
where o.observed_at <= h.as_of and o.observed_at < o.event_start_iso;
revoke all on blind_obs.prematch_observations_v1 from public, anon, authenticated, service_role;

create or replace view blind_obs.t20_observations_v1 with (security_barrier = true) as
select
  o.id, o.physical_event_id, o.provider_game_id, o.provider_event_id, o.source_id, o.source_version,
  o.event_start_iso, o.observed_at, o.observation_phase, o.provider_start_iso, o.provider_start_acquired_at,
  o.provider_start_source, o.parent_event_volume_24h, o.daily_volume_rank, o.sampling_bucket,
  o.provider_sport_family, o.provider_sport_code, o.provider_sport_source, o.condition_id, o.token_id, o.side,
  o.canonical_market_family, o.canonical_market_type, o.provider_market_type_raw, o.market_slug, o.best_bid,
  o.best_ask, o.tick_size, o.minimum_order_size, o.orderbook_fetch_status, o.requested_stake_usd,
  o.execution_price_cap, o.ask_depth_relevant_usd, o.full_stake_executable_vwap, o.full_stake_shares,
  o.executable_full_stake, o.executable_full_stake_state, o.taker_fee_state, o.taker_fee_usd,
  'OBSERVED_AT_ONLY'::text as asof_evidence
from public.research_precontract_t20_observations o
join blind_obs.model_horizon h on h.singleton
where o.observed_at <= h.as_of and o.observed_at < o.event_start_iso;
revoke all on blind_obs.t20_observations_v1 from public, anon, authenticated, service_role;

create or replace view blind_obs.inplay_observations_v1 with (security_barrier = true) as
select
  o.id, o.physical_event_id, o.provider_game_id, o.provider_event_id, o.provider_sport_family,
  o.provider_sport_code, o.provider_sport_source, o.event_start_iso, o.observed_at, o.source_version,
  o.event_live_status, o.state_authority, o.state_phase, o.state_period_num, o.state_clock_seconds_remaining,
  o.state_clock_seconds_elapsed, o.state_received_at, o.side_a_score, o.side_b_score, o.side_a_red_cards,
  o.side_b_red_cards, o.condition_id, o.token_id, o.side, o.canonical_market_family, o.canonical_market_type,
  o.provider_market_type_raw, o.market_slug, o.best_bid, o.best_ask, o.mid_price, o.spread_abs, o.tick_size,
  o.minimum_order_size, o.bid_depth_relevant_usd, o.ask_depth_relevant_usd, o.full_stake_executable_vwap,
  o.full_stake_shares, o.full_stake_exit_vwap, o.full_stake_exit_fully_filled, o.taker_fee_usd,
  o.orderbook_fetch_status, o.orderbook_fetch_started_at, o.orderbook_fetch_completed_at,
  o.orderbook_provider_timestamp_at, o.executable_full_stake_state, o.taker_fee_state, o.taker_fee_reason,
  o.quote_cycle_legs, o.quote_cycle_span_ms, o.persistence_reason, o.sequence_in_event, o.created_at,
  case when o.created_at <= h.as_of then 'CREATED_AT_LE_HORIZON' else 'OBSERVED_AT_ONLY' end as asof_evidence
from public.research_inplay_core_path_observations o
join blind_obs.model_horizon h on h.singleton
where o.observed_at <= h.as_of;
revoke all on blind_obs.inplay_observations_v1 from public, anon, authenticated, service_role;

grant usage on schema blind_obs to blind_model_reader;
grant select on blind_obs.prematch_observations_v1 to blind_model_reader;
grant select on blind_obs.t20_observations_v1 to blind_model_reader;
grant select on blind_obs.inplay_observations_v1 to blind_model_reader;
grant usage on schema blind_obs to blind_horizon_writer;
grant select, insert, update on blind_obs.model_horizon to blind_horizon_writer;

-- ACL correction for ONE existing DBClone object. Independent read-only preflight (PostgreSQL 17.6) found
-- public.record_football_execution_matrix_s1s2s3_evidence(jsonb) is SECURITY DEFINER with EXECUTE granted to PUBLIC plus explicit
-- grants to anon / authenticated / service_role; every new role inherits PUBLIC, so the assertion below would (correctly) abort.
-- Only PUBLIC is revoked, only for this exact function. The explicit grants of the existing consumers are required to exist before
-- the revoke and to still hold after it; nothing is granted here and the assertion below is unchanged and not whitelisted.
do $$
declare
  f constant oid := 'public.record_football_execution_matrix_s1s2s3_evidence(jsonb)'::regprocedure::oid;
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (
      select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles x on x.oid = a.grantee
      where p.oid = f and x.rolname = r and a.privilege_type = 'EXECUTE'
    ) then
      raise exception 'BLIND_EXISTING_CONSUMER_GRANT_NOT_EXPLICIT:%', r;
    end if;
  end loop;
end;
$$;

revoke execute on function public.record_football_execution_matrix_s1s2s3_evidence(jsonb) from public;

do $$
declare
  f constant oid := 'public.record_football_execution_matrix_s1s2s3_evidence(jsonb)'::regprocedure::oid;
  r text;
begin
  if exists (select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid = f and a.grantee = 0) then
    raise exception 'BLIND_PUBLIC_EXECUTE_NOT_REVOKED';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not has_function_privilege(r, f, 'EXECUTE') then
      raise exception 'BLIND_EXISTING_CONSUMER_GRANT_LOST:%', r;
    end if;
  end loop;
end;
$$;

-- Fail-closed effective-privilege assertion. Any violation raises, and the whole migration (roles included) rolls back.
-- These are PostgreSQL's own effective-privilege functions, so PUBLIC grants, role membership and column ACLs are included.
do $$
declare
  roles constant text[] := array['blind_model_reader', 'blind_horizon_writer', 'research_ledger_writer', 'research_settlement_authority'];
  views constant text[] := array['prematch_observations_v1', 't20_observations_v1', 'inplay_observations_v1'];
  r text;
  v text;
  found_list text;
begin
  perform 1 from pg_roles
  where rolname = any (roles) and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication or rolinherit or rolcanlogin);
  if found then raise exception 'BLIND_ROLE_ATTRIBUTES_UNSAFE'; end if;

  foreach r in array roles loop
    perform 1 from pg_roles x where x.rolname <> r and pg_has_role(r, x.oid, 'MEMBER');
    if found then raise exception 'BLIND_ROLE_MEMBERSHIP_PRESENT:%', r; end if;

    select string_agg(format('%I.%I:%s', n.nspname, c.relname, p.priv), ', ' order by n.nspname, c.relname, p.priv) into found_list
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      and n.nspname !~ '^pg_(toast_)?temp_'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
      and case when p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
            then has_any_column_privilege(r, c.oid, p.priv) else has_table_privilege(r, c.oid, p.priv) end
      and not (n.nspname = 'blind_obs' and (
            (r = 'blind_model_reader' and c.relname = any (views) and p.priv = 'SELECT')
         or (r = 'blind_horizon_writer' and c.relname = 'model_horizon' and p.priv in ('SELECT', 'INSERT', 'UPDATE'))));
    if found_list is not null then raise exception 'BLIND_RELATION_EXPOSURE:%:%', r, left(found_list, 600); end if;

    select string_agg(format('%I.%I', n.nspname, c.relname), ', ') into found_list
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      and (has_sequence_privilege(r, c.oid, 'USAGE') or has_sequence_privilege(r, c.oid, 'SELECT') or has_sequence_privilege(r, c.oid, 'UPDATE'));
    if found_list is not null then raise exception 'BLIND_SEQUENCE_EXPOSURE:%:%', r, left(found_list, 600); end if;

    select string_agg(format('%I.%I', n.nspname, p.proname), ', ' order by n.nspname, p.proname) into found_list
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege(r, p.oid, 'EXECUTE');
    if found_list is not null then raise exception 'BLIND_DEFINER_FUNCTION_EXPOSURE:%:%', r, left(found_list, 600); end if;

    select string_agg(n.nspname, ', ') into found_list
    from pg_namespace n
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and has_schema_privilege(r, n.oid, 'CREATE');
    if found_list is not null then raise exception 'BLIND_SCHEMA_CREATE_EXPOSURE:%:%', r, found_list; end if;
    if has_database_privilege(r, current_database(), 'CREATE') then raise exception 'BLIND_DATABASE_CREATE_EXPOSURE:%', r; end if;
  end loop;

  select count(*) into found_list from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'blind_obs' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S');
  if found_list::int <> 4 then raise exception 'BLIND_SCHEMA_CONTENT_UNEXPECTED:%', found_list; end if;

  foreach v in array views loop
    perform 1 from pg_class c
    where c.oid = to_regclass('blind_obs.' || v) and c.relkind = 'v'
      and c.relowner = (select oid from pg_roles where rolname = current_user)
      and 'security_barrier=true' = any (c.reloptions)
      and not exists (select 1 from unnest(c.reloptions) o where o like 'security_invoker%');
    if not found then raise exception 'BLIND_VIEW_PROPERTIES_UNSAFE:%', v; end if;
  end loop;

  perform 1 from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'blind_obs' and c.relkind = 'v' and a.attnum > 0 and not a.attisdropped
    and (a.atttypid in ('json'::regtype, 'jsonb'::regtype) or a.attname ~* '(settlement|label|winner|pnl|result)');
  if found then raise exception 'BLIND_VIEW_OUTCOME_SHAPED_COLUMN'; end if;

  -- PUBLIC / API roles must hold nothing in blind_obs (relacl NULL = owner only).
  perform 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'blind_obs' and c.relacl is not null
    and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')));
  if found then raise exception 'BLIND_PUBLIC_OR_API_GRANT_PRESENT'; end if;
  perform 1 from pg_namespace n where n.nspname = 'blind_obs' and n.nspacl is not null
    and exists (select 1 from aclexplode(n.nspacl) a where a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')));
  if found then raise exception 'BLIND_PUBLIC_OR_API_SCHEMA_GRANT_PRESENT'; end if;

  -- Definer views only return rows if the executing owner can actually read the raw tables (RLS owner bypass included).
  perform 1 from pg_class c
  where c.oid in (to_regclass('public.reservation_market_observations'), to_regclass('public.research_precontract_t20_observations'), to_regclass('public.research_inplay_core_path_observations'))
    and not (has_table_privilege(current_user, c.oid, 'SELECT') and not c.relforcerowsecurity
      and (not c.relrowsecurity or c.relowner = (select oid from pg_roles where rolname = current_user)
           or (select rolbypassrls or rolsuper from pg_roles where rolname = current_user)));
  if found then raise exception 'BLIND_VIEW_OWNER_CANNOT_READ_RAW_TABLES'; end if;
  if (select count(*) from pg_class c where c.oid in (to_regclass('public.reservation_market_observations'), to_regclass('public.research_precontract_t20_observations'), to_regclass('public.research_inplay_core_path_observations'))) <> 3 then
    raise exception 'BLIND_RAW_OBSERVATION_TABLE_MISSING';
  end if;
end;
$$;

commit;

with r(role_name) as (values ('blind_model_reader'), ('blind_horizon_writer'), ('research_ledger_writer'), ('research_settlement_authority')),
rel as (
  select c.oid, c.relname, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname !~ '^pg_(toast_)?temp_'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
select
  (select count(*) from pg_roles x join r on r.role_name = x.rolname)::int as roles_present_n,
  (select count(*) from pg_roles x join r on r.role_name = x.rolname
    where x.rolsuper or x.rolbypassrls or x.rolcreaterole or x.rolcreatedb or x.rolreplication or x.rolinherit)::int as roles_unsafe_n,
  (select count(*) from r join pg_roles x on x.rolname <> r.role_name where pg_has_role(r.role_name, x.oid, 'MEMBER'))::int as role_membership_n,
  (select count(*) from r cross join rel join pg_class c on c.oid = rel.oid cross join priv
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and case when priv.p in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
            then has_any_column_privilege(r.role_name, rel.oid, priv.p) else has_table_privilege(r.role_name, rel.oid, priv.p) end
      and not (rel.nspname = 'blind_obs' and (
            (r.role_name = 'blind_model_reader' and rel.relname in ('prematch_observations_v1', 't20_observations_v1', 'inplay_observations_v1') and priv.p = 'SELECT')
         or (r.role_name = 'blind_horizon_writer' and rel.relname = 'model_horizon' and priv.p in ('SELECT', 'INSERT', 'UPDATE')))))::int as relation_exposure_n,
  (select count(*) from r cross join rel join pg_class c on c.oid = rel.oid
    where c.relkind = 'S' and (has_sequence_privilege(r.role_name, rel.oid, 'USAGE') or has_sequence_privilege(r.role_name, rel.oid, 'SELECT') or has_sequence_privilege(r.role_name, rel.oid, 'UPDATE')))::int as sequence_exposure_n,
  (select count(*) from r cross join pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege(r.role_name, p.oid, 'EXECUTE'))::int as definer_function_exposure_n,
  (select count(*) from r cross join pg_namespace n
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and has_schema_privilege(r.role_name, n.oid, 'CREATE'))::int
    + (select count(*) from r where has_database_privilege(r.role_name, current_database(), 'CREATE'))::int as schema_create_exposure_n,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'blind_obs' and c.relkind = 'v' and 'security_barrier=true' = any (c.reloptions)
      and not exists (select 1 from unnest(c.reloptions) o where o like 'security_invoker%'))::int as views_ok_n,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'blind_obs' and c.relkind = 'v' and has_table_privilege('blind_model_reader', c.oid, 'SELECT'))::int as reader_view_select_n,
  (select count(*) from unnest(array['public.research_model_ready_rows', 'public.research_model_ready_days', 'public.research_model_economics',
      'public.research_t10_sibling_offpolicy_rows', 'public.prospective_selection_shadow_runtime', 'public.reservation_market_observations',
      'public.research_precontract_t20_observations', 'public.research_inplay_core_path_observations', 'public.research_strategy_selected_bets',
      'public.virtual_bet_settlement_authority', 'public.research_inplay_paper_settlement_reports']) t(name)
    where to_regclass(t.name) is not null
      and (has_any_column_privilege('blind_model_reader', to_regclass(t.name), 'SELECT') or has_any_column_privilege('blind_model_reader', to_regclass(t.name), 'INSERT')
        or has_any_column_privilege('blind_model_reader', to_regclass(t.name), 'UPDATE') or has_table_privilege('blind_model_reader', to_regclass(t.name), 'DELETE')))::int as reader_forbidden_named_n,
  (select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'blind_obs' and c.relkind = 'v' and a.attnum > 0 and not a.attisdropped
      and (a.atttypid in ('json'::regtype, 'jsonb'::regtype) or a.attname ~* '(settlement|label|winner|pnl|result)'))::int as view_json_or_outcome_columns_n,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'blind_obs' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S'))::int as blind_schema_relations_n,
  ((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'blind_obs' and c.relacl is not null
        and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))))
   + (select count(*) from pg_namespace n where n.nspname = 'blind_obs' and n.nspacl is not null
      and exists (select 1 from aclexplode(n.nspacl) a where a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')))))::int as blind_public_or_api_grants_n;
