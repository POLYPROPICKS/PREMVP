-- DBCLONE ONLY rollback of 20261014120000_forward_decision_v2_contract. Run as ONE transaction. Refuses once any V2 decision exists
-- (that would destroy evidence). It restores the deployed V1 CHECK itself, so no V2-labelled row can be inserted at any point.
-- Afterwards re-apply the deployed 20261012180000_virtual_bet_forward_contract_v1.sql (idempotent) to restore the V1 guard function;
-- the added nullable columns are inert and are intentionally left in place.
lock table public.prospective_selection_shadow_runtime in access exclusive mode;
do $$
begin
  if exists (select 1 from public.prospective_selection_shadow_runtime where contract_version = 'FORWARD_DECISION_V2') then
    raise exception 'FORWARD_DECISION_V2_ROLLBACK_REFUSED_BET_ROWS_EXIST';
  end if;
  if to_regclass('public.forward_decision_v2_skip') is not null then
    lock table public.forward_decision_v2_skip in access exclusive mode;
    if exists (select 1 from public.forward_decision_v2_skip) then
      raise exception 'FORWARD_DECISION_V2_ROLLBACK_REFUSED_SKIP_ROWS_EXIST';
    end if;
  end if;
end;
$$;
drop table if exists public.forward_decision_v2_skip;
drop function if exists public.forward_decision_v2_skip_guard();
drop function if exists public.forward_decision_v2_clock();
drop index if exists public.prospective_shadow_v2_bet_uidx;
alter table public.prospective_selection_shadow_runtime drop constraint if exists prospective_shadow_forward_v2_ck;
alter table public.prospective_selection_shadow_runtime drop constraint if exists prospective_shadow_forward_contract_ck;
alter table public.prospective_selection_shadow_runtime
  add constraint prospective_shadow_forward_contract_ck check (
    contract_version is null
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
