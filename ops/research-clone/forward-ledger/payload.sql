-- Blind forward virtual-bet Ledger + independent Box B join (Research DBClone ONLY, v1).
-- Issue #532. NOT applied by the author: DBClone nppznoujvnyjargjkmnv was not reachable from the
-- authoring session. Apply only through the project-bound Architect route, as one multi-statement
-- simple-protocol query (one implicit transaction). Requires Box B (market_outcome_current) to exist.
-- Never touches bet_execution_ledger, blind_obs.*, Production, or any existing table.

do $$
begin
  if to_regclass('public.market_outcome_current') is null then
    raise exception 'Box B (public.market_outcome_current) missing: refuse to apply';
  end if;
  if to_regclass('public.blind_forward_decision_ledger') is not null then
    raise exception 'blind_forward_decision_ledger already exists: refuse to re-apply';
  end if;
end;
$$;

create table public.blind_forward_decision_ledger (
  decision_key        text        primary key,
  model_id            text        not null check (length(model_id) > 0),
  model_version       text        not null check (length(model_version) > 0),
  model_hash          text        not null check (model_hash ~ '^[0-9a-f]{64}$'),
  observation_id      text        not null check (length(observation_id) > 0),
  observed_at         timestamptz not null,
  as_of               timestamptz not null,
  condition_id        text        not null check (condition_id ~ '^0x[0-9a-f]{64}$'),
  token_id            text        not null check (length(token_id) > 0),
  decision            text        not null check (decision in ('BET', 'SKIP')),
  skip_reason         text,
  entry_price         numeric,
  entry_vwap          numeric,
  max_size_usdc       numeric,
  entry_fee_usdc      numeric,
  entry_fee_authority text,
  frozen_at           timestamptz not null default clock_timestamp(),
  record_digest       text        not null,
  constraint bfdl_time_order_ck check (observed_at <= as_of and as_of <= frozen_at),
  constraint bfdl_decision_key_ck check (decision_key = encode(sha256(convert_to(
    concat_ws('|', model_hash, observation_id, condition_id, token_id), 'UTF8')), 'hex')),
  constraint bfdl_bet_economics_ck check (decision <> 'BET' or (
    skip_reason is null
    and entry_price is not null and entry_price > 0 and entry_price <= 1
    and entry_vwap is not null and entry_vwap > 0 and entry_vwap <= 1
    and max_size_usdc is not null and max_size_usdc > 0
    and entry_fee_authority is not null
    and entry_fee_authority in ('POLYMARKET_FEE_SCHEDULE', 'ZERO_FEE_VERIFIED', 'UNKNOWN')
    and (entry_fee_authority = 'UNKNOWN' or (entry_fee_usdc is not null and entry_fee_usdc >= 0)))),
  constraint bfdl_skip_ck check (decision <> 'SKIP' or (
    skip_reason is not null and entry_price is null and entry_vwap is null
    and max_size_usdc is null and entry_fee_usdc is null and entry_fee_authority is null))
);
create index bfdl_condition_idx on public.blind_forward_decision_ledger (condition_id, token_id);

-- Append-only + server-stamped frozen_at + digest + no-hindsight guard.
create function public.blind_forward_ledger_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp set row_security = off as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'blind_forward_decision_ledger is append-only (%)', tg_op using errcode = '23000';
  end if;
  new.frozen_at := clock_timestamp();
  if new.observed_at > new.frozen_at or new.as_of > new.frozen_at then
    raise exception 'observation is in the future relative to frozen_at' using errcode = '23514';
  end if;
  -- Hindsight guard, run as definer so the model role never needs Box B access: refuse any decision
  -- on a market whose Box B outcome is already known, so no resolved market can be passed off as forward.
  -- Checks EVER-resolved (any revision), so a later FINAL->PENDING regression cannot re-open a market.
  -- row_security = off makes this error out rather than silently see zero rows if the owner lacks RLS bypass.
  if exists (select 1 from public.market_outcome_revisions o
              where o.condition_id = new.condition_id
                and o.outcome_status in ('FINAL', 'VOID', 'CONFLICT')) then
    raise exception 'market already has a non-PENDING Box B outcome: not forward' using errcode = '23514';
  end if;
  -- Canonical, session-independent digest: JSON array (unambiguous field boundaries), UTC timestamps.
  new.record_digest := encode(sha256(convert_to(jsonb_build_array(new.decision_key, new.model_id,
    new.model_version, new.model_hash, new.observation_id,
    to_char(new.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    to_char(new.as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), new.condition_id,
    new.token_id, new.decision, new.skip_reason, new.entry_price, new.entry_vwap, new.max_size_usdc,
    new.entry_fee_usdc, new.entry_fee_authority,
    to_char(new.frozen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))::text, 'UTF8')), 'hex');
  return new;
end;
$$;
create trigger bfdl_guard_ins before insert on public.blind_forward_decision_ledger
  for each row execute function public.blind_forward_ledger_guard();
create trigger bfdl_guard_mut before update or delete on public.blind_forward_decision_ledger
  for each row execute function public.blind_forward_ledger_guard();
create trigger bfdl_guard_trunc before truncate on public.blind_forward_decision_ledger
  for each statement execute function public.blind_forward_ledger_guard();

-- Independent fixed join Ledger -> Box B by exact condition_id + token_id. BET rows only.
create view public.blind_forward_ledger_box_b_join_v1 with (security_invoker = true) as
select l.decision_key, l.model_id, l.model_version, l.model_hash, l.observation_id, l.as_of,
       l.condition_id, l.token_id, l.entry_vwap, l.max_size_usdc, l.entry_fee_usdc,
       l.entry_fee_authority, l.frozen_at,
       o.outcome_status as box_b_status, o.resolved_at,
       j.join_state,
       case when j.join_state in ('FINAL_WIN', 'FINAL_LOSS') then substr(j.join_state, 7) end as outcome_result
  from public.blind_forward_decision_ledger l
  left join public.market_outcome_current o on o.condition_id = l.condition_id
 cross join lateral (select case
         when o.outcome_status = 'CONFLICT' then 'CONFLICT'
         when o.outcome_status = 'VOID' then 'VOID'
         when o.outcome_status = 'FINAL' and l.frozen_at >= o.resolved_at then 'NOT_FORWARD'
         when o.outcome_status = 'FINAL' and l.entry_fee_authority = 'UNKNOWN' then 'UNKNOWN_FEE_AUTHORITY'
         when o.outcome_status = 'FINAL' and o.winner_token_id = l.token_id then 'FINAL_WIN'
         when o.outcome_status = 'FINAL' then 'FINAL_LOSS'
         when exists (select 1 from public.market_outcome_revisions f
                       where f.condition_id = l.condition_id and f.outcome_status = 'LOOKUP_FAILED')
              and o.condition_id is null then 'LOOKUP_FAILED'
         else 'PENDING'
       end as join_state) j
 where l.decision = 'BET';

-- Counts only. No ROI is computed here: Net ROI stays NOT_PROVEN (numeric net economics is the next roadmap step).
create view public.blind_forward_scoreboard_v1 with (security_invoker = true) as
select model_hash, join_state, count(*) as bets, 'NOT_PROVEN'::text as net_roi
  from public.blind_forward_ledger_box_b_join_v1
 group by model_hash, join_state;

-- ACL: the model role may only INSERT decisions; reconciliation (Box B) is service_role only.
revoke all on public.blind_forward_decision_ledger from public, anon, authenticated;
revoke all on public.blind_forward_ledger_box_b_join_v1 from public, anon, authenticated;
revoke all on public.blind_forward_scoreboard_v1 from public, anon, authenticated;
revoke all on function public.blind_forward_ledger_guard() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'blind_model_reader') then
    execute 'revoke all on public.blind_forward_decision_ledger from blind_model_reader';
    execute 'revoke all on public.blind_forward_ledger_box_b_join_v1 from blind_model_reader';
    execute 'revoke all on public.blind_forward_scoreboard_v1 from blind_model_reader';
    execute 'revoke all on function public.blind_forward_ledger_guard() from blind_model_reader';
  end if;
  if exists (select 1 from pg_roles where rolname = 'blind_model_writer') then
    execute 'revoke all on public.blind_forward_ledger_box_b_join_v1 from blind_model_writer';
    execute 'revoke all on public.blind_forward_scoreboard_v1 from blind_model_writer';
    execute 'revoke all on function public.blind_forward_ledger_guard() from blind_model_writer';
    execute 'revoke all on public.market_outcome_current from blind_model_writer';
    execute 'revoke all on public.market_outcome_revisions from blind_model_writer';
    execute 'revoke all on public.market_outcome_provider_receipts from blind_model_writer';
    execute 'grant insert on public.blind_forward_decision_ledger to blind_model_writer';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on public.blind_forward_decision_ledger from service_role';
    execute 'revoke all on public.blind_forward_ledger_box_b_join_v1 from service_role';
    execute 'revoke all on public.blind_forward_scoreboard_v1 from service_role';
    execute 'revoke all on function public.blind_forward_ledger_guard() from service_role';
    execute 'grant select on public.blind_forward_decision_ledger to service_role';
    execute 'grant select on public.blind_forward_ledger_box_b_join_v1 to service_role';
    execute 'grant select on public.blind_forward_scoreboard_v1 to service_role';
  end if;
end;
$$;
