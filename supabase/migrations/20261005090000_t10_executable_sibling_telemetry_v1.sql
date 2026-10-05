-- PREMVP_APPLICATION_MIGRATION_V1
-- T10_EXECUTABLE_SIBLING_TELEMETRY_V1: additive, nullable, evidence-only columns on the existing canonical
-- per-sibling telemetry row (one row per physical_event_id + condition_id + token_id + side per capture run).
-- No new table. Historical rows are not backfilled and keep NULL. No CHECK constraints on purpose: a telemetry
-- value must never be able to fail the capture write that feeds the live T10 decision (states are typed in code).
-- The four reused columns (requested_stake_usd, execution_price_cap, ask_depth_relevant_usd,
-- full_stake_executable_vwap) already exist and keep their LIVE_GUARD meaning; they are now also filled for T_MINUS_10.
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

COMMENT ON COLUMN public.reservation_market_observations.executable_telemetry_version IS
  'T10_EXECUTABLE_SIBLING_TELEMETRY_V1 when the row carries ordinary-stake TAKER execution evidence (T_MINUS_10 only); NULL otherwise.';
COMMENT ON COLUMN public.reservation_market_observations.executable_full_stake IS
  'Ordinary $2.50 stake (requested_stake_usd) fully fillable as TAKER from asks <= execution_price_cap (0.54) AND >= minimum_order_size shares. TRUE/FALSE/NULL=unknown; see executable_full_stake_state.';
COMMENT ON COLUMN public.reservation_market_observations.executable_full_stake_state IS
  'EXECUTABLE | NOT_EXECUTABLE_MIN_ORDER_SIZE | NOT_EXECUTABLE_DEPTH_AT_CAP | UNKNOWN_BOOK_UNAVAILABLE | UNKNOWN_MIN_ORDER_SIZE | UNKNOWN_TELEMETRY_COMPUTE_FAILED.';
COMMENT ON COLUMN public.reservation_market_observations.full_stake_shares IS
  'Shares bought by the full-stake walk; NULL unless the full stake is fillable at the cap.';
COMMENT ON COLUMN public.reservation_market_observations.full_stake_worst_ask_price IS
  'Highest ask level consumed by the full-stake walk; the walk fits under any limit >= this price.';
COMMENT ON COLUMN public.reservation_market_observations.taker_fee_state IS
  'KNOWN only when the token-specific Gamma fee schedule was authoritative; otherwise UNKNOWN (fee is never assumed 0).';
COMMENT ON COLUMN public.reservation_market_observations.taker_fee_reason IS
  'Typed reason when taker_fee_state=UNKNOWN (e.g. FEE_HTTP_500, FEE_MARKET_NOT_FOUND, FEE_SCHEDULE_UNSUPPORTED, FEE_BUDGET_EXCEEDED, FEE_NOT_ATTEMPTED).';
COMMENT ON COLUMN public.reservation_market_observations.taker_fee_rate IS
  'Provider taker fee rate (0 only when the provider states feesEnabled=false); NULL when unknown.';
COMMENT ON COLUMN public.reservation_market_observations.taker_fee_usd IS
  'Total USDC taker fee of the full-stake walk (per-level ceil 1e-5); NULL unless fee known AND full stake fillable.';
COMMENT ON COLUMN public.reservation_market_observations.taker_effective_cost_per_share IS
  '(requested_stake_usd + taker_fee_usd) / full_stake_shares; NULL unless fee known AND full stake fillable.';
COMMENT ON COLUMN public.reservation_market_observations.p_buy_max IS
  'Context only: T30_EXACT_BID_ANCHOR_V1 P_BUY_MAX for this exact token when authoritative; NULL otherwise (see p_buy_max_state).';
COMMENT ON COLUMN public.reservation_market_observations.p_buy_max_source_key IS
  'T30_BOOK:<t30 capture_run_id>:<token_id>:<side> witness of p_buy_max; comparable with the Queue price_authority_observation_id.';
