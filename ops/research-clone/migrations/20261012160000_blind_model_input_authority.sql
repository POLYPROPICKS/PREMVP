-- DBCLONE ONLY: nppznoujvnyjargjkmnv. BLIND_MODEL_INPUT_AUTHORITY_V1. NEVER apply to production (nbnldzfsxffztsfrrxqy).
-- Purpose: a restricted model-reader role that can read allow-listed, as-of-bounded, outcome-free projections of the
-- EXISTING raw observation tables, and nothing else. No data is copied, moved, rewritten or deleted.
-- Semantics (deliberate, see docs/modeling/BLIND_RESEARCH_DATA_CONTRACT_V1.md):
--   * views are DEFINER views (no security_invoker): the reader needs SELECT on the views only, never on the base tables;
--   * security_barrier = true: a reader-supplied (leaky) predicate can never run before the as-of filter;
--   * the as-of horizon is a DB-owned single row the reader can neither read nor write; no row = no visible observation;
--   * no password and no LOGIN is created here: credential deployment is a separate, later, founder-held stage.
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
  o.taker_fee_formula_version
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
  o.executable_full_stake, o.executable_full_stake_state, o.taker_fee_state, o.taker_fee_usd
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
  o.quote_cycle_legs, o.quote_cycle_span_ms, o.persistence_reason, o.sequence_in_event, o.created_at
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
  where rolname = any (roles) and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication or rolinherit);
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
