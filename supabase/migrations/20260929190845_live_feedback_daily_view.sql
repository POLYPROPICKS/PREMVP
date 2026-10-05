-- One read-only accounting surface over the canonical execution ledger.
-- Day is the UTC execution day; created_at covers venue callbacks without a
-- separately reported filled_at timestamp.
create or replace view public.v_live_feedback_daily
with (security_invoker = true)
as
with execution_rows as (
  select
    (coalesce(filled_at, created_at) at time zone 'UTC')::date as execution_day_utc,
    model_name, model_variant, model_role, policy_version,
    raw_signal #>> '{queue_diagnostics,model_lineage_v1,contract_a_version}' as contract_a_version,
    raw_signal #>> '{queue_diagnostics,model_lineage_v1,contract_a_decision_version}' as contract_a_decision_version,
    raw_signal #>> '{queue_diagnostics,model_lineage_v1,allocation_policy_id}' as allocation_policy_id,
    raw_signal #>> '{queue_diagnostics,model_lineage_v1,portfolio_policy_id}' as portfolio_policy_id,
    raw_signal #>> '{queue_diagnostics,model_lineage_v1,portfolio_tier}' as portfolio_tier,
    raw_signal #>> '{queue_diagnostics,model_lineage_v1,strategic_scope}' as strategic_scope,
    coalesce(
      raw_signal #>> '{queue_diagnostics,model_lineage_v1,selected_score_contract_version}',
      raw_signal #>> '{queue_diagnostics,selected_score_contract_version}'
    ) as selected_score_contract_version,
    sport, market_family, bet_status, planned_stake, executed_stake,
    gross_pnl, fee_paid_real, real_slippage_cost, real_pnl,
    signal_entry_price, fill_price
  from public.bet_execution_ledger
)
select
  execution_day_utc,
  model_name, model_variant, model_role, policy_version,
  contract_a_version, contract_a_decision_version, allocation_policy_id,
  portfolio_policy_id, portfolio_tier, strategic_scope,
  selected_score_contract_version, sport, market_family,
  count(*) as bet_count,
  sum(planned_stake) as planned_stake,
  sum(executed_stake) as executed_stake,
  count(*) filter (where bet_status = 'WON') as won_n,
  count(*) filter (where bet_status = 'LOST') as lost_n,
  count(*) filter (where bet_status not in ('WON', 'LOST')) as open_n,
  sum(gross_pnl) as gross_pnl,
  count(fee_paid_real) as actual_fee_known_n,
  count(*) - count(fee_paid_real) as actual_fee_unknown_n,
  sum(fee_paid_real) as actual_fee_usd,
  count(real_slippage_cost) as actual_slippage_known_n,
  count(*) - count(real_slippage_cost) as actual_slippage_unknown_n,
  sum(real_slippage_cost) as actual_slippage_usd,
  count(real_pnl) as net_pnl_known_n,
  sum(real_pnl) as net_pnl_usd,
  100 * sum(real_pnl) /
    nullif(sum(executed_stake) filter (where real_pnl is not null), 0)
    as net_roi_on_executed_stake_pct,
  avg(signal_entry_price) as avg_signal_entry_price,
  avg(fill_price) as avg_fill_price,
  avg(fill_price - signal_entry_price) as avg_price_drift
from execution_rows
group by
  execution_day_utc,
  model_name, model_variant, model_role, policy_version,
  contract_a_version, contract_a_decision_version, allocation_policy_id,
  portfolio_policy_id, portfolio_tier, strategic_scope,
  selected_score_contract_version, sport, market_family;
