-- PREMVP_APPLICATION_MIGRATION_V1: additive strategy table and compatibility expansion of observation phases.
ALTER TABLE public.reservation_market_capture_runs
  DROP CONSTRAINT IF EXISTS reservation_market_capture_runs_observation_phase_check;
ALTER TABLE public.reservation_market_capture_runs
  ADD CONSTRAINT reservation_market_capture_runs_observation_phase_check
  CHECK (observation_phase IN ('RESERVATION_BASELINE', 'T_MINUS_30', 'T_MINUS_10', 'T_MINUS_3', 'LIVE_GUARD'));

ALTER TABLE public.reservation_market_observations
  DROP CONSTRAINT IF EXISTS reservation_market_observations_observation_phase_check;
ALTER TABLE public.reservation_market_observations
  ADD CONSTRAINT reservation_market_observations_observation_phase_check
  CHECK (observation_phase IN ('RESERVATION_BASELINE', 'T_MINUS_30', 'T_MINUS_10', 'T_MINUS_3', 'LIVE_GUARD'));

ALTER TABLE public.reservation_market_observations
  ADD COLUMN reference_entry_price numeric,
  ADD COLUMN execution_price_cap numeric,
  ADD COLUMN requested_stake_usd numeric,
  ADD COLUMN full_stake_executable_vwap numeric;

CREATE TABLE public.reservation_strategy_observations (
  id uuid PRIMARY KEY,
  market_observation_id uuid NOT NULL REFERENCES public.reservation_market_observations(id),
  capture_run_id uuid NOT NULL REFERENCES public.reservation_market_capture_runs(id),
  reservation_id uuid NOT NULL REFERENCES public.night_event_reservations(id),
  physical_event_id text NOT NULL,
  condition_id text NOT NULL,
  token_id text NOT NULL,
  side text NOT NULL,
  observation_phase text NOT NULL CHECK (observation_phase IN ('RESERVATION_BASELINE', 'T_MINUS_30', 'T_MINUS_10', 'T_MINUS_3', 'LIVE_GUARD')),
  evaluated_at timestamptz NOT NULL,
  minutes_to_start numeric NOT NULL,
  strategy_variant text NOT NULL CHECK (strategy_variant IN ('S1_TAKER_HOLD', 'S2_FIXED_MAKER_HOLD', 'S3_MAKER_VALUE_BAND_HOLD')),
  strategy_version text,
  evaluation_state text NOT NULL,
  eligible boolean,
  rejection_reason text,
  available_best_ask numeric,
  available_decimal_odds numeric,
  spread_abs numeric,
  executable_depth_usd numeric,
  maker_target_price numeric,
  maker_target_decimal_odds numeric,
  maker_target_state text,
  target_policy_version text,
  target_touched boolean,
  maker_band_min_price numeric,
  maker_band_max_price numeric,
  maker_band_min_odds numeric,
  maker_band_max_odds numeric,
  maker_band_state text,
  maker_band_version text,
  acceptable_band_observed boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_observation_id, strategy_variant)
);
CREATE INDEX reservation_strategy_observations_watermark_idx
  ON public.reservation_strategy_observations (evaluated_at, id);
CREATE INDEX reservation_strategy_observations_market_observation_idx
  ON public.reservation_strategy_observations (market_observation_id);
CREATE INDEX reservation_strategy_observations_reservation_variant_idx
  ON public.reservation_strategy_observations (reservation_id, strategy_variant, evaluated_at);
ALTER TABLE public.reservation_strategy_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reservation_strategy_observations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservation_strategy_observations TO service_role;
