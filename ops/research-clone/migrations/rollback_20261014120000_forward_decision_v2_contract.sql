-- DBCLONE ONLY rollback of 20261014120000_forward_decision_v2_contract. Refuses once any V2 decision exists (that would destroy evidence).
-- After this file, re-apply the deployed 20261012180000_virtual_bet_forward_contract_v1.sql (idempotent) to restore the V1 guard
-- function and V1 CHECK; the added nullable columns are inert and are intentionally left in place.
do $$
begin
  if exists (select 1 from public.prospective_selection_shadow_runtime where contract_version = 'FORWARD_DECISION_V2') then
    raise exception 'FORWARD_DECISION_V2_ROLLBACK_REFUSED_BET_ROWS_EXIST';
  end if;
  if to_regclass('public.forward_decision_v2_skip') is not null and exists (select 1 from public.forward_decision_v2_skip) then
    raise exception 'FORWARD_DECISION_V2_ROLLBACK_REFUSED_SKIP_ROWS_EXIST';
  end if;
end;
$$;
drop table if exists public.forward_decision_v2_skip;
drop function if exists public.forward_decision_v2_skip_guard();
drop function if exists public.forward_decision_v2_clock();
drop index if exists public.prospective_shadow_v2_bet_uidx;
alter table public.prospective_selection_shadow_runtime drop constraint if exists prospective_shadow_forward_v2_ck;
