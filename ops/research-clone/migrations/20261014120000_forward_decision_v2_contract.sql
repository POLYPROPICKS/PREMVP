-- DBCLONE ONLY: nppznoujvnyjargjkmnv. Additive FORWARD_DECISION_V2 contract on the EXISTING prospective_selection_shadow_runtime ledger.
-- No competing ledger. Legacy (contract_version IS NULL) and FORWARD_BET_V1 rows are never rewritten and keep their semantics.
-- V2 admits decision_kind BET (virtual 5-share fill) in the existing ledger, and SKIP (the model's own evaluation evidence) in the
-- append-only sibling forward_decision_v2_skip: the legacy shadow cycle reads EVERY LEDGER row as a bet and counts UNQUERIED rows as
-- unresolved, so an evidence-only SKIP in that table would corrupt legacy economics. BLOCKED / NOT_APPLICABLE are not model decisions
-- and have no persistence path. The DB owns first_persisted_at (clock_timestamp()), all timing classes, lags and T-90 lead.
do $$
begin
  if current_setting('lock_timeout') <> '5s' or current_setting('statement_timeout') <> '45s' then
    raise exception 'FORWARD_DECISION_V2_MIGRATION_TIMEOUTS_NOT_ACTIVE';
  end if;
  if to_regclass('public.prospective_selection_shadow_runtime') is null then
    raise exception 'FORWARD_DECISION_V2_REQUIRES_SHADOW_RUNTIME_TABLE';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.prospective_selection_shadow_runtime'::regclass
      and conname = 'prospective_shadow_forward_contract_ck') then
    raise exception 'FORWARD_DECISION_V2_REQUIRES_FORWARD_BET_V1_CHECK';
  end if;
  if to_regclass('public.prospective_shadow_economic_unit_uidx') is null then
    raise exception 'FORWARD_DECISION_V2_REQUIRES_FORWARD_BET_V1_UNIQUE_INDEX';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.prospective_selection_shadow_runtime'::regclass
      and tgname = 'prospective_selection_shadow_guard_row_trg' and tgenabled <> 'D') then
    raise exception 'FORWARD_DECISION_V2_REQUIRES_FORWARD_BET_V1_GUARD_TRIGGER';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'prospective_selection_shadow_runtime' and column_name = 'model_version') then
    raise exception 'FORWARD_DECISION_V2_REQUIRES_FORWARD_BET_V1_COLUMNS';
  end if;
end;
$$;

alter table public.prospective_selection_shadow_runtime
  add column if not exists definition_digest text,
  add column if not exists source_sha text,
  add column if not exists source_ingested_at timestamptz,
  add column if not exists source_observation_id text,
  add column if not exists source_item_observation_id text,
  add column if not exists virtual_shares numeric,
  add column if not exists virtual_fill_vwap numeric,
  add column if not exists virtual_gross_cost_usd numeric,
  add column if not exists venue_min_order_size numeric,
  add column if not exists fee_state text,
  add column if not exists net_state text,
  add column if not exists t90_cutoff_at timestamptz,
  add column if not exists minutes_to_start numeric,
  add column if not exists t90_lead_seconds numeric,
  add column if not exists start_verification_state text,
  add column if not exists evaluation_evidence jsonb;

-- V1 CHECK: identical V1 branch; a V2 row is delegated to its own CHECK below. Re-adding validates EVERY existing row against
-- the unchanged V1 branch, so the migration aborts (and rolls back) if any historical row would no longer satisfy it.
alter table public.prospective_selection_shadow_runtime
  drop constraint if exists prospective_shadow_forward_contract_ck;
alter table public.prospective_selection_shadow_runtime
  add constraint prospective_shadow_forward_contract_ck check (
    contract_version is null
    or contract_version = 'FORWARD_DECISION_V2'
    or (
      contract_version = 'FORWARD_BET_V1'
      and row_kind = 'LEDGER'
      and coalesce(decision_kind = 'BET', false)
      and (game_identity_basis is null or game_identity_basis in ('PROVIDER_ROOT_CONFIRMED', 'TEAM_PAIR_START_DEDUP', 'PROVIDER_EVENT_ONLY'))
      and ((provider_root_game_id is null) = (game_identity_basis is distinct from 'PROVIDER_ROOT_CONFIRMED'))
      and ((provider_root_game_id is null) = (provider_root_game_source is null))
      and (provider_root_game_source is null or provider_root_game_source in ('POLYMARKET_GAMMA_GAME_ID'))
      and ((authoritative_start_at is null) = (authoritative_start_source is null))
      and (authoritative_start_source is null or authoritative_start_source in ('OFFICIAL_SOURCE_CONFIRMED_START', 'PROVIDER_PUBLISHED_ACTUAL_START'))
      and (scope_basis is null or scope_basis in ('STRUCTURED_MONEYLINE', 'TEXT_HEURISTIC'))
      and (reference_price is null or (reference_price > 0 and reference_price < 1))
      and ((executable_buy_price is null) = (executable_price_authority is null))
      and ((executable_buy_price is null) = (executable_quote_at is null))
      and (executable_buy_price is null or (executable_buy_price > 0 and executable_buy_price < 1))
      and (executable_price_authority is null or executable_price_authority in ('CLOB_BEST_ASK', 'CLOB_DEPTH_VWAP'))
      and (timing_class is null or timing_class in ('PRE_START_AUTHORITATIVE', 'PRE_START_SCHEDULED_ONLY', 'LATE_OR_REPLAY', 'TIMING_UNPROVEN'))
      and (timing_detail is null or timing_detail in ('LATE_SCHEDULED', 'LATE_AUTHORITATIVE', 'HISTORICAL_REPLAY', 'START_UNKNOWN'))
      and (verification_status is null or verification_status = 'VERIFIED' or verification_status like 'UNVERIFIED:%')
    )
  );

-- V2 CHECK. Fee and net profitability are NOT_EVALUATED by contract (never assumed zero). Virtual size is exactly 5 shares.
alter table public.prospective_selection_shadow_runtime
  drop constraint if exists prospective_shadow_forward_v2_ck;
alter table public.prospective_selection_shadow_runtime
  add constraint prospective_shadow_forward_v2_ck check (
    contract_version is distinct from 'FORWARD_DECISION_V2'
    or (
      row_kind = 'LEDGER'
      and model_id is not null and physical_event_key is not null
      and definition_digest ~ '^[0-9a-f]{64}$'
      and model_version = 'def-sha256:' || definition_digest
      and source_sha ~ '^[0-9a-f]{40}$'
      and fee_state = 'NOT_EVALUATED' and net_state = 'NOT_EVALUATED'
      and scheduled_start_at is not null
      and authoritative_start_at is null and authoritative_start_source is null
      and event_start is not distinct from scheduled_start_at
      and observed_at is not null and source_ingested_at is not null and decision_generated_at is not null
      and evaluation_evidence is not null and jsonb_typeof(evaluation_evidence) = 'object'
      and evaluation_evidence ?& array['cohort', 'model', 'pick', 'fill', 'fees']
      and decision_kind = 'BET'
      and condition_id is not null and selected_token_id is not null
      and source_observation_id is not null and source_item_observation_id is not null
      and economic_unit_key = 'PE:' || physical_event_key
      and entry_price > 0 and entry_price < 1
      and game_identity_basis = 'PROVIDER_ROOT_CONFIRMED'
      and provider_root_game_source = 'POLYMARKET_GAMMA_GAME_ID'
      and nullif(btrim(provider_root_game_id), '') is not null
      and canonical_game_key = sport_family || ':root:' || provider_root_game_id
      and physical_event_key = canonical_game_key
      and virtual_shares = 5
      and virtual_fill_vwap > 0 and virtual_fill_vwap < 1
      and virtual_gross_cost_usd > 0
      and abs(virtual_gross_cost_usd - virtual_fill_vwap * virtual_shares) <= 0.000001
      and venue_min_order_size is not null and venue_min_order_size > 0 and venue_min_order_size <= virtual_shares
      and executable_price_authority = 'CLOB_DEPTH_VWAP'
      and executable_buy_price = virtual_fill_vwap
      and executable_quote_at is not null
    )
  );

-- Race-proof uniqueness (the guard also takes an advisory lock so the cross-contract existence check cannot race).
-- APPLY PROCEDURE: this file has no BEGIN/COMMIT; it MUST run as ONE transaction (the registered runner wraps it, with local lock/statement timeouts).
create unique index if not exists prospective_shadow_v2_bet_uidx
  on public.prospective_selection_shadow_runtime (model_id, physical_event_key)
  where row_kind = 'LEDGER' and contract_version = 'FORWARD_DECISION_V2' and decision_kind = 'BET';

-- The DB clock as the single source of decision-generation time for the research writer.
create or replace function public.forward_decision_v2_clock()
returns timestamptz language sql volatile as $$ select clock_timestamp() $$;
revoke all on function public.forward_decision_v2_clock() from public, anon, authenticated;
grant execute on function public.forward_decision_v2_clock() to service_role;

-- Evidence is additive: historical ledger rows are never backfilled. Multiple different roots
-- for one exact event are retained as a contradiction, not overwritten by the latest reader.
create table if not exists public.forward_decision_v2_identity_witness (
  provider_event_id text not null check (provider_event_id ~ '^[0-9]+$'),
  provider_root_game_id text not null check (provider_root_game_id ~ '^[0-9]+$'),
  identity_source text not null check (identity_source = 'POLYMARKET_GAMMA_EXACT_ID'),
  acquired_at timestamptz not null,
  receipt_digest text not null check (receipt_digest ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null check (coalesce(evidence ->> 'id' = provider_event_id and evidence ->> 'gameId' = provider_root_game_id, false)),
  primary key (provider_event_id, provider_root_game_id, receipt_digest)
);
alter table public.forward_decision_v2_identity_witness enable row level security;
revoke all on public.forward_decision_v2_identity_witness from public, anon, authenticated;
grant select, insert on public.forward_decision_v2_identity_witness to service_role;

create table if not exists public.forward_decision_v2_cutover (
  model_id text primary key check (model_id in ('P50_52_SAFE','TENNIS_P50_52_SAFE','PORTFOLIO_BROAD_SAFE','QUALITY_FILL_A_SAFE','QUALITY_FILL_D_SAFE')),
  writer_mode text not null check (writer_mode in ('LEGACY','V2'))
);
insert into public.forward_decision_v2_cutover (model_id, writer_mode)
values ('P50_52_SAFE','LEGACY'),('TENNIS_P50_52_SAFE','LEGACY'),('PORTFOLIO_BROAD_SAFE','LEGACY'),('QUALITY_FILL_A_SAFE','LEGACY'),('QUALITY_FILL_D_SAFE','LEGACY')
on conflict (model_id) do nothing;
alter table public.forward_decision_v2_cutover enable row level security;
revoke all on public.forward_decision_v2_cutover from public, anon, authenticated, service_role;
grant select on public.forward_decision_v2_cutover to service_role;

-- Only the authorized migration owner can change mode; it takes the same lock as every
-- ledger insertion. Consequently an in-flight legacy batch finishes before V2 can begin.
create or replace function public.forward_decision_v2_cutover_guard()
returns trigger language plpgsql as $$
begin
  if tg_op <> 'UPDATE' or new.model_id is distinct from old.model_id then
    raise exception 'FORWARD_V2_CUTOVER_IDENTITY_IMMUTABLE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('FWD_MODEL|' || old.model_id, 0));
  if old.writer_mode = 'V2' and new.writer_mode <> 'V2' then
    raise exception 'FORWARD_V2_CUTOVER_NO_REVERSE';
  end if;
  return new;
end; $$;
revoke all on function public.forward_decision_v2_cutover_guard() from public, anon, authenticated;
drop trigger if exists forward_decision_v2_cutover_guard_trg on public.forward_decision_v2_cutover;
create trigger forward_decision_v2_cutover_guard_trg before update or delete on public.forward_decision_v2_cutover
for each row execute function public.forward_decision_v2_cutover_guard();

create or replace function public.forward_decision_v2_witness_guard()
returns trigger language plpgsql as $$
begin
  if tg_op <> 'INSERT' then raise exception 'IMMUTABLE_FORWARD_IDENTITY_WITNESS'; end if;
  -- Identity receipts cannot change while a model's collision decision is being made.
  perform pg_advisory_xact_lock(hashtextextended('FWD_IDENTITY_WITNESSES', 0));
  if new.acquired_at > clock_timestamp() then raise exception 'IDENTITY_WITNESS_IN_FUTURE'; end if;
  return new;
end; $$;
revoke all on function public.forward_decision_v2_witness_guard() from public, anon, authenticated;
drop trigger if exists forward_decision_v2_witness_guard_trg on public.forward_decision_v2_identity_witness;
create trigger forward_decision_v2_witness_guard_trg before insert or update or delete on public.forward_decision_v2_identity_witness
for each row execute function public.forward_decision_v2_witness_guard();
drop trigger if exists forward_decision_v2_witness_truncate_trg on public.forward_decision_v2_identity_witness;
create trigger forward_decision_v2_witness_truncate_trg before truncate on public.forward_decision_v2_identity_witness
for each statement execute function public.forward_decision_v2_witness_guard();

-- Advisory preflight for the reviewed writer. The trigger repeats the decision after
-- acquiring locks: this RPC alone is never the concurrency authority.
create or replace function public.forward_decision_v2_admission(p_model text, p_root text)
returns text language sql volatile as $$
  select case
    when not exists (select 1 from public.forward_decision_v2_cutover c where c.model_id=p_model and c.writer_mode='V2')
      then 'FORWARD_V2_CUTOVER_NOT_ACTIVE'
    when exists (select 1 from public.prospective_selection_shadow_runtime r
      where r.row_kind='LEDGER' and r.model_id=p_model and (
        r.provider_root_game_id=p_root or exists (select 1 from public.forward_decision_v2_identity_witness w
          where w.provider_event_id=coalesce(r.provider_event_id,r.physical_event_key) and w.provider_root_game_id=p_root)))
      then 'DUPLICATE_ECONOMIC_UNIT'
    when exists (select 1 from public.prospective_selection_shadow_runtime r
      where r.row_kind='LEDGER' and r.model_id=p_model and (
        (nullif(btrim(r.provider_root_game_id),'') is null and
          (select count(distinct w.provider_root_game_id) from public.forward_decision_v2_identity_witness w
            where w.provider_event_id=coalesce(r.provider_event_id,r.physical_event_key)) <> 1)
        or exists (select 1 from public.forward_decision_v2_identity_witness w
          where w.provider_event_id=coalesce(r.provider_event_id,r.physical_event_key)
            and r.provider_root_game_id is not null and w.provider_root_game_id<>r.provider_root_game_id)))
      then 'HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN'
    else 'ADMISSIBLE' end
$$;
revoke all on function public.forward_decision_v2_admission(text,text) from public,anon,authenticated;
grant execute on function public.forward_decision_v2_admission(text,text) to service_role;

create or replace function public.prospective_selection_shadow_guard()
returns trigger language plpgsql as $$
declare
  persisted timestamptz;
  missing text[];
  unproven text[];
  lag_seconds numeric;
  cutoff timestamptz;
  earliest_start timestamptz;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'IMMUTABLE_SHADOW_LEDGER_TRUNCATE';
  end if;
  if tg_op = 'DELETE' then
    if old.row_kind = 'LEDGER' then
      raise exception 'IMMUTABLE_SHADOW_CHOICE';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.row_kind = 'LEDGER' then
      -- A model-wide lock serializes every alias, definition and contract version.
      perform pg_advisory_xact_lock(hashtextextended('FWD_MODEL|' || coalesce(new.model_id, ''), 0));
      persisted := clock_timestamp();
      new.first_persisted_at := persisted;
      if new.contract_version is null then
        if num_nonnulls(new.canonical_game_key, new.game_identity_basis, new.provider_root_game_id, new.provider_root_game_source, new.scope_basis, new.provider_event_id, new.market_family, new.market_type,
          new.line_value, new.period_scope, new.selected_outcome, new.observed_at, new.decision_generated_at,
          new.scheduled_start_at, new.authoritative_start_at, new.reference_price, new.executable_buy_price,
          new.model_version, new.selection_reason, new.decision_kind, new.economic_unit_key, new.timing_class,
          new.timing_detail, new.contract_status, new.verification_status,
          new.definition_digest, new.source_sha, new.source_ingested_at, new.virtual_shares, new.fee_state,
          new.net_state, new.start_verification_state, new.evaluation_evidence) > 0 then
          raise exception 'FORWARD_FIELDS_REQUIRE_CONTRACT_VERSION';
        end if;
        -- Preserve deployed legacy behavior until the five-model handover. No V2 SAFE
        -- claim can exist before that handover. Pause only these legacy inserts after it.
        if exists (select 1 from public.forward_decision_v2_cutover c
          where c.model_id = new.model_id and c.writer_mode = 'V2') then return null; end if;
        if exists (select 1 from public.prospective_selection_shadow_runtime r
          where r.row_kind = 'LEDGER' and r.model_id = new.model_id
            and r.physical_event_key = new.physical_event_key) then return null; end if;
      elsif new.contract_version = 'FORWARD_BET_V1' then
        if exists (select 1 from public.forward_decision_v2_cutover c
          where c.model_id = new.model_id and c.writer_mode = 'V2') then
          raise exception 'FORWARD_V2_LEGACY_CONTRACT_PAUSED';
        end if;
        if exists (select 1 from public.prospective_selection_shadow_runtime r
          where r.row_kind = 'LEDGER' and r.model_id = new.model_id
            and (r.physical_event_key = new.physical_event_key
              or (new.canonical_game_key is not null and r.canonical_game_key = new.canonical_game_key)
              or (new.provider_root_game_id is not null and r.provider_root_game_id = new.provider_root_game_id))) then
          raise exception using errcode = '23505', message = 'DUPLICATE_ECONOMIC_UNIT';
        end if;
        -- All definitions and contracts must prove the competing claims distinct before a new alias may BET.
        if exists (select 1 from public.prospective_selection_shadow_runtime r
          where r.row_kind = 'LEDGER' and r.model_id = new.model_id) then
          if new.game_identity_basis is distinct from 'PROVIDER_ROOT_CONFIRMED'
            or new.provider_root_game_source is distinct from 'POLYMARKET_GAMMA_GAME_ID'
            or nullif(btrim(new.provider_root_game_id), '') is null
            or exists (select 1 from public.prospective_selection_shadow_runtime r
              where r.row_kind = 'LEDGER' and r.model_id = new.model_id
                and (r.game_identity_basis is distinct from 'PROVIDER_ROOT_CONFIRMED'
                  or r.provider_root_game_source is distinct from 'POLYMARKET_GAMMA_GAME_ID'
                  or nullif(btrim(r.provider_root_game_id), '') is null)) then
            raise exception 'HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN';
          end if;
        end if;
        if new.decision_generated_at is null or new.observed_at is null then
          raise exception 'FORWARD_DECISION_TIMES_REQUIRED';
        end if;
        if new.decision_generated_at > persisted + interval '60 seconds' then
          raise exception 'DECISION_TIME_IN_FUTURE';
        end if;
        if new.observed_at > new.decision_generated_at + interval '60 seconds' then
          raise exception 'OBSERVATION_AFTER_DECISION';
        end if;
        lag_seconds := extract(epoch from (persisted - new.observed_at));
        new.observation_lag_seconds := lag_seconds;
        new.lead_time_scheduled_seconds := case when new.scheduled_start_at is null then null
          else extract(epoch from (new.scheduled_start_at - persisted)) end;
        new.lead_time_authoritative_seconds := case when new.authoritative_start_at is null then null
          else extract(epoch from (new.authoritative_start_at - persisted)) end;
        -- Five separate facts: DB first persistence (first_persisted_at), scheduled-only, authoritative, late/replay, unproven.
        -- An authoritative start needs a registered independent source (CHECK); a scheduled time can never stand in for it.
        new.timing_class := case
          when lag_seconds > 7200 then 'LATE_OR_REPLAY'
          when new.authoritative_start_at is not null and persisted < new.authoritative_start_at then 'PRE_START_AUTHORITATIVE'
          when new.authoritative_start_at is not null then 'LATE_OR_REPLAY'
          when new.scheduled_start_at is not null and persisted < new.scheduled_start_at then 'PRE_START_SCHEDULED_ONLY'
          when new.scheduled_start_at is not null then 'LATE_OR_REPLAY'
          else 'TIMING_UNPROVEN' end;
        new.timing_detail := case
          when lag_seconds > 7200 then 'HISTORICAL_REPLAY'
          when new.authoritative_start_at is not null and persisted >= new.authoritative_start_at then 'LATE_AUTHORITATIVE'
          when new.authoritative_start_at is null and new.scheduled_start_at is not null and persisted >= new.scheduled_start_at then 'LATE_SCHEDULED'
          when new.authoritative_start_at is null and new.scheduled_start_at is null then 'START_UNKNOWN'
          else null end;
        missing := array_remove(array[
          case when new.canonical_game_key is null then 'canonical_game_key' end,
          case when new.game_identity_basis is null then 'game_identity_basis' end,
          case when new.scope_basis is null then 'scope_basis' end,
          case when new.provider_event_id is null then 'provider_event_id' end,
          case when new.condition_id is null then 'condition_id' end,
          case when new.selected_token_id is null then 'selected_token_id' end,
          case when new.market_family is null then 'market_family' end,
          case when new.market_type is null then 'market_type' end,
          case when new.period_scope is null then 'period_scope' end,
          case when new.selected_outcome is null then 'selected_outcome' end,
          case when new.line_value is null and new.market_family in ('SPREAD', 'TOTAL', 'HANDICAP') then 'line_value' end,
          case when new.reference_price is null then 'reference_price' end,
          case when new.reference_price_source is null then 'reference_price_source' end,
          case when new.reference_price_type is null then 'reference_price_type' end,
          case when new.reference_price_acquired_at is null then 'reference_price_acquired_at' end,
          case when new.model_version is null then 'model_version' end,
          case when new.decision_kind is null then 'decision_kind' end,
          case when new.selection_reason is null then 'selection_reason' end,
          case when new.economic_unit_key is null then 'economic_unit_key' end
        ], null);
        new.contract_status := case when array_length(missing, 1) is null then 'COMPLETE'
          else 'INCOMPLETE:' || array_to_string(missing, ',') end;
        -- VERIFIED only when timing, physical-game identity and market scope are each independently proven; otherwise the
        -- first unproven links are named. A complete contract is NOT a verified BET.
        unproven := array_remove(array[
          case when new.contract_status <> 'COMPLETE' then 'contract_incomplete' end,
          case new.timing_class when 'PRE_START_SCHEDULED_ONLY' then 'timing_scheduled_only' when 'LATE_OR_REPLAY' then 'timing_late_or_replay'
            when 'TIMING_UNPROVEN' then 'timing_unproven' else null end,
          case new.game_identity_basis when 'TEAM_PAIR_START_DEDUP' then 'game_identity_dedup_only'
            when 'PROVIDER_ROOT_CONFIRMED' then null else 'game_identity_provider_event_only' end,
          case when new.scope_basis is distinct from 'STRUCTURED_MONEYLINE' then 'scope_text_heuristic' end
        ], null);
        new.verification_status := case when array_length(unproven, 1) is null then 'VERIFIED'
          else 'UNVERIFIED:' || array_to_string(unproven, ',') end;
      elsif new.contract_version = 'FORWARD_DECISION_V2' then
        if not exists (select 1 from public.forward_decision_v2_cutover c
          where c.model_id = new.model_id and c.writer_mode = 'V2') then
          raise exception 'FORWARD_V2_CUTOVER_NOT_ACTIVE';
        end if;
        perform pg_advisory_xact_lock(hashtextextended('FWD_IDENTITY_WITNESSES', 0));
        if exists (select 1 from public.forward_decision_v2_identity_witness w
          where w.provider_event_id = new.provider_event_id and w.provider_root_game_id <> new.provider_root_game_id) then
          raise exception 'IDENTITY_WITNESS_CONTRADICTION';
        end if;
        if nullif(btrim(new.provider_root_game_id), '') is null
          or new.game_identity_basis is distinct from 'PROVIDER_ROOT_CONFIRMED'
          or new.provider_root_game_source is distinct from 'POLYMARKET_GAMMA_GAME_ID'
          or new.canonical_game_key is distinct from new.sport_family || ':root:' || new.provider_root_game_id
          or new.physical_event_key is distinct from new.canonical_game_key then
          raise exception 'PROVIDER_ROOT_GAME_ID_UNPROVEN';
        end if;
        -- Serialise every claim/decision on (model_id, physical event) so the cross-contract existence check cannot race.
        perform pg_advisory_xact_lock(hashtextextended('FWD_MODEL|' || coalesce(new.model_id, ''), 0));
        -- The authoritative instant is taken AFTER any lock wait, so a waiter never carries a stale first_persisted_at.
        persisted := clock_timestamp();
        new.first_persisted_at := persisted;
        -- A BET claims the event for model_id across legacy, V1 and V2 regardless of model_version.
        if exists (select 1 from public.prospective_selection_shadow_runtime r
          where r.row_kind = 'LEDGER' and r.model_id = new.model_id
            and r.row_key <> new.row_key
            and (r.physical_event_key = new.physical_event_key
              or (new.canonical_game_key is not null and r.canonical_game_key = new.canonical_game_key))) then
          raise exception using errcode = '23505', message = 'DUPLICATE_ECONOMIC_UNIT';
        end if;
        -- Resolve each exact historical event via immutable external evidence, without
        -- modifying its ledger row. Unknown or conflicting evidence remains blocked.
        if exists (select 1 from public.prospective_selection_shadow_runtime r
          where r.row_kind = 'LEDGER' and r.model_id = new.model_id
            and nullif(btrim(r.provider_root_game_id), '') is null
            and (select count(distinct w.provider_root_game_id) from public.forward_decision_v2_identity_witness w
              where w.provider_event_id = coalesce(r.provider_event_id, r.physical_event_key)) <> 1) then
          raise exception 'HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN';
        end if;
        if exists (select 1 from public.prospective_selection_shadow_runtime r
          where r.row_kind = 'LEDGER' and r.model_id = new.model_id
            and (r.provider_root_game_id = new.provider_root_game_id or exists (
              select 1 from public.forward_decision_v2_identity_witness w
              where w.provider_event_id = coalesce(r.provider_event_id, r.physical_event_key)
                and w.provider_root_game_id = new.provider_root_game_id))) then
          raise exception using errcode = '23505', message = 'DUPLICATE_ECONOMIC_UNIT';
        end if;
        if public.forward_decision_v2_admission(new.model_id,new.provider_root_game_id) <> 'ADMISSIBLE' then
          raise exception 'HISTORICAL_ALIAS_EQUIVALENCE_UNPROVEN';
        end if;
        -- Price authority is the picked frozen tier, never source entryPrice alone or VWAP alone.
        if coalesce(new.evaluation_evidence #>> '{fill,price_authority,rule}', '') <> 'FOUNDER_P538_SAME_SELECTED_TIER_WORST_ASK'
          or coalesce(new.evaluation_evidence #>> '{fill,price_authority,model_id}', '') <> new.model_id then
          raise exception 'QUOTE_EXECUTION_PRICE_AUTHORITY_UNPROVEN';
        end if;
        declare
          tier integer := (new.evaluation_evidence #>> '{fill,price_authority,picked_tier}')::integer;
          worst numeric := (new.evaluation_evidence #>> '{fill,worst_ask}')::numeric;
          lower_price numeric;
          upper_price numeric;
        begin
          if new.model_id in ('P50_52_SAFE', 'TENNIS_P50_52_SAFE') and tier = 1
            or new.model_id = 'PORTFOLIO_BROAD_SAFE' and tier in (1,2)
            or new.model_id in ('QUALITY_FILL_A_SAFE','QUALITY_FILL_D_SAFE') and tier in (1,3) then
            lower_price := 0.50; upper_price := 0.52;
          elsif new.model_id = 'PORTFOLIO_BROAD_SAFE' and tier = 3 then
            lower_price := 0.52; upper_price := 0.54;
          elsif new.model_id in ('QUALITY_FILL_A_SAFE','QUALITY_FILL_D_SAFE') and tier = 2 then
            lower_price := 0.50; upper_price := 0.54;
          elsif new.model_id = 'QUALITY_FILL_D_SAFE' and tier = 4 then
            lower_price := 0.54; upper_price := 0.60;
          else raise exception 'QUOTE_EXECUTION_PRICE_AUTHORITY_UNPROVEN'; end if;
          if worst is null or not (worst >= lower_price and worst < upper_price)
            or worst < new.virtual_fill_vwap
            or new.entry_price < lower_price or new.entry_price >= upper_price then
            raise exception 'QUOTE_OUTSIDE_SELECTED_FROZEN_TIER';
          end if;
        end;
        -- DB-owned timing. Nothing client-supplied can backdate first_persisted_at or the lead.
        if new.observed_at > new.source_ingested_at then
          raise exception 'FORWARD_V2_OBSERVED_AFTER_INGEST';
        end if;
        if new.source_ingested_at > new.decision_generated_at then
          raise exception 'FORWARD_V2_DECISION_BEFORE_SOURCE_INGEST';
        end if;
        if new.decision_generated_at > persisted then
          raise exception 'FORWARD_V2_DECISION_AFTER_PERSIST';
        end if;
        if persisted - new.decision_generated_at > interval '300 seconds' then
          raise exception 'FORWARD_V2_DECISION_STALE';
        end if;
        lag_seconds := extract(epoch from (persisted - new.observed_at));
        if lag_seconds > 7200 then
          raise exception 'FORWARD_V2_OBSERVATION_STALE';
        end if;
        if new.executable_quote_at > persisted then
          raise exception 'FORWARD_V2_QUOTE_AFTER_PERSIST';
        end if;
        if persisted - new.executable_quote_at > interval '600 seconds' then
          raise exception 'FORWARD_V2_QUOTE_STALE';
        end if;
        earliest_start := least(new.scheduled_start_at, coalesce(new.authoritative_start_at, new.scheduled_start_at));
        cutoff := earliest_start - interval '90 minutes';
        if not (persisted < cutoff) then
          raise exception 'FORWARD_V2_NOT_BEFORE_T90';
        end if;
        new.t90_cutoff_at := cutoff;
        new.minutes_to_start := extract(epoch from (earliest_start - persisted)) / 60;
        new.t90_lead_seconds := extract(epoch from (cutoff - persisted));
        new.observation_lag_seconds := lag_seconds;
        new.lead_time_scheduled_seconds := extract(epoch from (new.scheduled_start_at - persisted));
        new.lead_time_authoritative_seconds := case when new.authoritative_start_at is null then null
          else extract(epoch from (new.authoritative_start_at - persisted)) end;
        new.timing_class := case when new.authoritative_start_at is not null then 'PRE_START_AUTHORITATIVE' else 'PRE_START_SCHEDULED_ONLY' end;
        new.timing_detail := null;
        new.start_verification_state := case when new.authoritative_start_at is not null then 'VERIFIED_ACTUAL_START' else 'PROVISIONAL_SCHEDULED_ONLY' end;
        new.contract_status := 'COMPLETE';
        new.verification_status := case when new.authoritative_start_at is not null then 'VERIFIED' else 'UNVERIFIED:timing_scheduled_only' end;
      else
        raise exception 'UNKNOWN_CONTRACT_VERSION';
      end if;
    end if;
    return new;
  end if;
  if old.row_kind = 'SNAPSHOT' and new.row_kind = 'LEDGER' then
    raise exception 'SNAPSHOT_CANNOT_BECOME_LEDGER';
  end if;
  if old.row_kind = 'LEDGER' and
    (new.row_key, new.row_kind, new.model_id, new.decision_date,
     new.candidate_identity, new.physical_event_key, new.decision_timestamp,
     new.event_start, new.entry_price, new.sport_family, new.condition_id,
     new.selected_token_id, new.pre_event_score, new.data_coverage,
     new.first_persisted_at, new.contract_version, new.canonical_game_key,
     new.game_identity_basis, new.provider_root_game_id, new.provider_root_game_source, new.scope_basis,
     new.provider_event_id, new.market_family, new.market_type, new.line_value,
     new.period_scope, new.selected_outcome, new.observed_at, new.decision_generated_at,
     new.scheduled_start_at, new.authoritative_start_at, new.authoritative_start_source,
     new.reference_price, new.reference_price_source, new.reference_price_type,
     new.reference_price_acquired_at, new.provider_quote_at, new.executable_buy_price,
     new.executable_price_authority, new.executable_quote_at, new.model_version,
     new.selection_reason, new.decision_kind, new.economic_unit_key,
     new.observation_lag_seconds, new.lead_time_scheduled_seconds,
     new.lead_time_authoritative_seconds, new.timing_class, new.timing_detail, new.contract_status, new.verification_status,
     new.definition_digest, new.source_sha, new.source_ingested_at, new.source_observation_id, new.source_item_observation_id,
     new.virtual_shares, new.virtual_fill_vwap, new.virtual_gross_cost_usd, new.venue_min_order_size,
     new.fee_state, new.net_state, new.t90_cutoff_at, new.minutes_to_start, new.t90_lead_seconds,
     new.start_verification_state, new.evaluation_evidence)
    is distinct from
    (old.row_key, old.row_kind, old.model_id, old.decision_date,
     old.candidate_identity, old.physical_event_key, old.decision_timestamp,
     old.event_start, old.entry_price, old.sport_family, old.condition_id,
     old.selected_token_id, old.pre_event_score, old.data_coverage,
     old.first_persisted_at, old.contract_version, old.canonical_game_key,
     old.game_identity_basis, old.provider_root_game_id, old.provider_root_game_source, old.scope_basis,
     old.provider_event_id, old.market_family, old.market_type, old.line_value,
     old.period_scope, old.selected_outcome, old.observed_at, old.decision_generated_at,
     old.scheduled_start_at, old.authoritative_start_at, old.authoritative_start_source,
     old.reference_price, old.reference_price_source, old.reference_price_type,
     old.reference_price_acquired_at, old.provider_quote_at, old.executable_buy_price,
     old.executable_price_authority, old.executable_quote_at, old.model_version,
     old.selection_reason, old.decision_kind, old.economic_unit_key,
     old.observation_lag_seconds, old.lead_time_scheduled_seconds,
     old.lead_time_authoritative_seconds, old.timing_class, old.timing_detail, old.contract_status, old.verification_status,
     old.definition_digest, old.source_sha, old.source_ingested_at, old.source_observation_id, old.source_item_observation_id,
     old.virtual_shares, old.virtual_fill_vwap, old.virtual_gross_cost_usd, old.venue_min_order_size,
     old.fee_state, old.net_state, old.t90_cutoff_at, old.minutes_to_start, old.t90_lead_seconds,
     old.start_verification_state, old.evaluation_evidence) then
    raise exception 'IMMUTABLE_SHADOW_CHOICE';
  end if;
  return new;
end;
$$;

revoke all on function public.prospective_selection_shadow_guard() from public, anon, authenticated;
drop trigger if exists prospective_selection_shadow_guard_row_trg on public.prospective_selection_shadow_runtime;
create trigger prospective_selection_shadow_guard_row_trg
before insert or update or delete on public.prospective_selection_shadow_runtime
for each row execute function public.prospective_selection_shadow_guard();
drop trigger if exists prospective_selection_shadow_guard_truncate_trg on public.prospective_selection_shadow_runtime;
create trigger prospective_selection_shadow_guard_truncate_trg
before truncate on public.prospective_selection_shadow_runtime
for each statement execute function public.prospective_selection_shadow_guard();
revoke delete, truncate on public.prospective_selection_shadow_runtime from service_role;

-- ── V2 SKIP: append-only, one immutable decision per (model_id, definition digest, physical event) ───────────────────────────
-- Evidence only. It claims nothing, so a SKIP never blocks a later BET by any definition; a BET already claimed for the same
-- model_id and event (legacy, V1 or V2) rejects the SKIP. Not a ledger row: legacy readers never see it.
create table if not exists public.forward_decision_v2_skip (
  skip_id bigint generated always as identity primary key,
  row_key text not null unique,
  contract_version text not null check (contract_version = 'FORWARD_DECISION_V2'),
  decision_kind text not null check (decision_kind = 'SKIP'),
  model_id text not null,
  model_version text not null,
  definition_digest text not null check (definition_digest ~ '^[0-9a-f]{64}$'),
  source_sha text not null check (source_sha ~ '^[0-9a-f]{40}$'),
  check (model_version = 'def-sha256:' || definition_digest),
  physical_event_key text not null,
  cohort_physical_event_id text not null,
  sport_family text not null,
  skip_reason text not null check (skip_reason in ('MODEL_PREDICATE_EVALUATED_NOT_SELECTED', 'MODEL_GATE_EVALUATED_REJECTED', 'MODEL_SELECTED_DAILY_CAP_SPENT')),
  observed_at timestamptz not null,
  source_ingested_at timestamptz not null,
  decision_generated_at timestamptz not null,
  scheduled_start_at timestamptz not null,
  authoritative_start_at timestamptz,
  authoritative_start_source text,
  check (authoritative_start_at is null and authoritative_start_source is null),
  fee_state text not null check (fee_state = 'NOT_EVALUATED'),
  net_state text not null check (net_state = 'NOT_EVALUATED'),
  evaluation_evidence jsonb not null check (jsonb_typeof(evaluation_evidence) = 'object' and evaluation_evidence ?& array['cohort', 'model', 'evaluation']),
  first_persisted_at timestamptz,
  t90_cutoff_at timestamptz,
  minutes_to_start numeric,
  t90_lead_seconds numeric,
  observation_lag_seconds numeric,
  timing_class text,
  start_verification_state text,
  unique (model_id, model_version, physical_event_key)
);

create or replace function public.forward_decision_v2_skip_guard()
returns trigger language plpgsql as $$
declare
  persisted timestamptz;
  earliest_start timestamptz;
  cutoff timestamptz;
begin
  if tg_op <> 'INSERT' then
    raise exception 'IMMUTABLE_FORWARD_SKIP';
  end if;
  persisted := clock_timestamp();
  new.first_persisted_at := persisted;
  perform pg_advisory_xact_lock(hashtextextended('FWD_MODEL|' || new.model_id, 0));
  if not exists (select 1 from public.forward_decision_v2_cutover c
    where c.model_id = new.model_id and c.writer_mode = 'V2') then
    raise exception 'FORWARD_V2_CUTOVER_NOT_ACTIVE';
  end if;
  persisted := clock_timestamp();
  new.first_persisted_at := persisted;
  if exists (select 1 from public.prospective_selection_shadow_runtime r
    where r.row_kind = 'LEDGER' and r.model_id = new.model_id and (r.physical_event_key = new.physical_event_key
      or r.evaluation_evidence #>> '{cohort,physical_event_id}' = new.cohort_physical_event_id)) then
    raise exception using errcode = '23505', message = 'SKIP_AFTER_BET_CLAIM';
  end if;
  if new.observed_at > new.source_ingested_at then
    raise exception 'FORWARD_V2_OBSERVED_AFTER_INGEST';
  end if;
  if new.source_ingested_at > new.decision_generated_at then
    raise exception 'FORWARD_V2_DECISION_BEFORE_SOURCE_INGEST';
  end if;
  if new.decision_generated_at > persisted then
    raise exception 'FORWARD_V2_DECISION_AFTER_PERSIST';
  end if;
  if persisted - new.decision_generated_at > interval '300 seconds' then
    raise exception 'FORWARD_V2_DECISION_STALE';
  end if;
  new.observation_lag_seconds := extract(epoch from (persisted - new.observed_at));
  if new.observation_lag_seconds > 7200 then
    raise exception 'FORWARD_V2_OBSERVATION_STALE';
  end if;
  earliest_start := least(new.scheduled_start_at, coalesce(new.authoritative_start_at, new.scheduled_start_at));
  cutoff := earliest_start - interval '90 minutes';
  if not (persisted < cutoff) then
    raise exception 'FORWARD_V2_NOT_BEFORE_T90';
  end if;
  new.t90_cutoff_at := cutoff;
  new.minutes_to_start := extract(epoch from (earliest_start - persisted)) / 60;
  new.t90_lead_seconds := extract(epoch from (cutoff - persisted));
  new.timing_class := case when new.authoritative_start_at is not null then 'PRE_START_AUTHORITATIVE' else 'PRE_START_SCHEDULED_ONLY' end;
  new.start_verification_state := case when new.authoritative_start_at is not null then 'VERIFIED_ACTUAL_START' else 'PROVISIONAL_SCHEDULED_ONLY' end;
  return new;
end;
$$;

revoke all on function public.forward_decision_v2_skip_guard() from public, anon, authenticated;
drop trigger if exists forward_decision_v2_skip_guard_row_trg on public.forward_decision_v2_skip;
create trigger forward_decision_v2_skip_guard_row_trg
before insert or update or delete on public.forward_decision_v2_skip
for each row execute function public.forward_decision_v2_skip_guard();
drop trigger if exists forward_decision_v2_skip_guard_truncate_trg on public.forward_decision_v2_skip;
create trigger forward_decision_v2_skip_guard_truncate_trg
before truncate on public.forward_decision_v2_skip
for each statement execute function public.forward_decision_v2_skip_guard();

alter table public.forward_decision_v2_skip enable row level security;
revoke all on public.forward_decision_v2_skip from public, anon, authenticated;
grant select, insert on public.forward_decision_v2_skip to service_role;
grant usage on sequence public.forward_decision_v2_skip_skip_id_seq to service_role;
