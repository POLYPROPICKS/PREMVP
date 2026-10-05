-- Research clone only (nppznoujvnyjargjkmnv). Lifetime narrow telemetry copy.
CREATE TABLE IF NOT EXISTS public.reservation_market_capture_runs (
  id uuid PRIMARY KEY, reservation_id uuid NOT NULL, plan_run_id text NOT NULL,
  physical_event_id text NOT NULL, provider_event_id text, event_start_iso timestamptz NOT NULL,
  observation_phase text NOT NULL, observed_at timestamptz NOT NULL, minutes_to_start numeric NOT NULL,
  source_version text NOT NULL, source_observed_at timestamptz,
  markets_discovered_n integer NOT NULL, market_tokens_expected_n integer NOT NULL,
  market_tokens_observed_n integer NOT NULL, orderbooks_success_n integer NOT NULL,
  orderbooks_failed_n integer NOT NULL, capture_complete boolean NOT NULL,
  capture_status text NOT NULL, failure_reason text, created_at timestamptz NOT NULL,
  UNIQUE (reservation_id, observation_phase, source_version)
);
CREATE INDEX IF NOT EXISTS reservation_market_capture_runs_watermark_idx
  ON public.reservation_market_capture_runs (observed_at, id);
ALTER TABLE public.reservation_market_capture_runs ENABLE ROW LEVEL SECURITY;
-- CLONE_PARITY_REPAIR_V1: same meaning as production; nullable JSONB.
ALTER TABLE public.reservation_market_capture_runs
  ADD COLUMN IF NOT EXISTS discovery_audit_v1 jsonb;
REVOKE ALL ON public.reservation_market_capture_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservation_market_capture_runs TO service_role;

CREATE TABLE IF NOT EXISTS public.reservation_market_observations (
  id uuid PRIMARY KEY, capture_run_id uuid NOT NULL, reservation_id uuid NOT NULL,
  physical_event_id text NOT NULL, provider_event_id text, event_start_iso timestamptz NOT NULL,
  observation_phase text NOT NULL, observed_at timestamptz NOT NULL, minutes_to_start numeric NOT NULL,
  condition_id text NOT NULL, token_id text NOT NULL, side text NOT NULL, outcome text,
  canonical_market_family text, canonical_market_type text, provider_market_type_raw text,
  market_slug text, live_policy_eligibility boolean, live_policy_rejection_reason text,
  best_bid numeric, best_ask numeric, mid_price numeric, bid_decimal_odds numeric,
  ask_decimal_odds numeric, spread_abs numeric, spread_bps numeric,
  bid_depth_relevant_usd numeric, ask_depth_relevant_usd numeric,
  tick_size numeric, minimum_order_size numeric,
  orderbook_fetch_latency_ms integer, orderbook_fetch_status text NOT NULL,
  orderbook_failure_reason text, source_version text NOT NULL, created_at timestamptz NOT NULL,
  reference_entry_price numeric, execution_price_cap numeric,
  requested_stake_usd numeric, full_stake_executable_vwap numeric,
  UNIQUE (capture_run_id, condition_id, token_id, side)
);
CREATE INDEX IF NOT EXISTS reservation_market_observations_watermark_idx
  ON public.reservation_market_observations (observed_at, id);
CREATE INDEX IF NOT EXISTS reservation_market_observations_run_idx
  ON public.reservation_market_observations (capture_run_id);
ALTER TABLE public.reservation_market_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_market_observations
  ADD COLUMN IF NOT EXISTS reference_entry_price numeric,
  ADD COLUMN IF NOT EXISTS execution_price_cap numeric,
  ADD COLUMN IF NOT EXISTS requested_stake_usd numeric,
  ADD COLUMN IF NOT EXISTS full_stake_executable_vwap numeric;
-- T10_EXECUTABLE_SIBLING_TELEMETRY_V1: same meaning as production; nullable, additive, evidence-only.
-- APPLY THIS ON THE CLONE BEFORE the sync projection that selects these columns is deployed.
ALTER TABLE public.reservation_market_observations
  ADD COLUMN IF NOT EXISTS executable_telemetry_version text,
  ADD COLUMN IF NOT EXISTS executable_full_stake boolean,
  ADD COLUMN IF NOT EXISTS executable_full_stake_state text,
  ADD COLUMN IF NOT EXISTS full_stake_shares numeric,
  ADD COLUMN IF NOT EXISTS full_stake_worst_ask_price numeric,
  ADD COLUMN IF NOT EXISTS taker_fee_state text,
  ADD COLUMN IF NOT EXISTS taker_fee_reason text,
  ADD COLUMN IF NOT EXISTS taker_fee_rate numeric,
  ADD COLUMN IF NOT EXISTS taker_fee_usd numeric,
  ADD COLUMN IF NOT EXISTS taker_effective_cost_per_share numeric,
  ADD COLUMN IF NOT EXISTS taker_fee_formula_version text,
  ADD COLUMN IF NOT EXISTS p_buy_max numeric,
  ADD COLUMN IF NOT EXISTS p_buy_max_state text,
  ADD COLUMN IF NOT EXISTS p_buy_max_source_key text;
REVOKE ALL ON public.reservation_market_observations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservation_market_observations TO service_role;

CREATE TABLE IF NOT EXISTS public.reservation_strategy_observations (
  id uuid PRIMARY KEY, market_observation_id uuid NOT NULL, capture_run_id uuid NOT NULL,
  reservation_id uuid NOT NULL, physical_event_id text NOT NULL, condition_id text NOT NULL,
  token_id text NOT NULL, side text NOT NULL, observation_phase text NOT NULL,
  evaluated_at timestamptz NOT NULL, minutes_to_start numeric NOT NULL,
  strategy_variant text NOT NULL, strategy_version text, evaluation_state text NOT NULL,
  eligible boolean, rejection_reason text, available_best_ask numeric,
  available_decimal_odds numeric, spread_abs numeric, executable_depth_usd numeric,
  maker_target_price numeric, maker_target_decimal_odds numeric, maker_target_state text,
  target_policy_version text, target_touched boolean,
  maker_band_min_price numeric, maker_band_max_price numeric,
  maker_band_min_odds numeric, maker_band_max_odds numeric,
  maker_band_state text, maker_band_version text, acceptable_band_observed boolean,
  created_at timestamptz NOT NULL,
  UNIQUE (market_observation_id, strategy_variant)
);
CREATE INDEX IF NOT EXISTS reservation_strategy_observations_watermark_idx
  ON public.reservation_strategy_observations (evaluated_at, id);
CREATE INDEX IF NOT EXISTS reservation_strategy_observations_market_idx
  ON public.reservation_strategy_observations (market_observation_id);
ALTER TABLE public.reservation_strategy_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reservation_strategy_observations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservation_strategy_observations TO service_role;
