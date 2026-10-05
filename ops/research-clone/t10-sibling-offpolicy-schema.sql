-- Research clone only (nppznoujvnyjargjkmnv). T10_SIBLING_OFFPOLICY_V1: settled off-policy dataset over the exact
-- T_MINUS_10 siblings (one row per physical_event_id + condition_id + token_id + side per T10 capture). Idempotent;
-- written only by scripts/modeling/t10-sibling-offpolicy.ts --materialize. Research evidence: never read by live code.
CREATE TABLE IF NOT EXISTS public.research_t10_sibling_offpolicy_rows (
  dataset_version text NOT NULL,
  physical_event_id text NOT NULL,
  event_start_iso timestamptz NOT NULL,
  event_date_utc date NOT NULL,
  sport_family text,
  canonical_market_family text,
  canonical_market_type text,
  condition_id text NOT NULL,
  token_id text NOT NULL,
  side text NOT NULL,
  decision_at timestamptz NOT NULL,
  best_bid numeric,
  best_ask numeric,
  tick_size numeric,
  minimum_order_size numeric,
  orderbook_fetch_status text NOT NULL,
  ordinary_stake_usd numeric NOT NULL,
  hard_cap numeric NOT NULL,
  executability_state text NOT NULL,
  executability_source text NOT NULL,
  executability_conclusive boolean NOT NULL,
  offpolicy_entry_price numeric,
  offpolicy_entry_price_source text NOT NULL,
  fee_state text NOT NULL,
  fee_usd numeric,
  settlement_state text NOT NULL,
  settlement_reason text NOT NULL,
  winning_token_id text,
  offpolicy_gross_pnl_usd numeric,
  offpolicy_net_pnl_usd numeric,
  lineage jsonb NOT NULL,
  materialized_at timestamptz NOT NULL,
  PRIMARY KEY (dataset_version, physical_event_id, condition_id, token_id, side, decision_at)
);
CREATE INDEX IF NOT EXISTS research_t10_sibling_offpolicy_rows_date_idx
  ON public.research_t10_sibling_offpolicy_rows (event_date_utc, physical_event_id);
ALTER TABLE public.research_t10_sibling_offpolicy_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_t10_sibling_offpolicy_rows FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_t10_sibling_offpolicy_rows TO service_role;
