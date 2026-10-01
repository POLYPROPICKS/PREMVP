-- PREMVP_APPLICATION_MIGRATION_V1
-- Widen reservation_strategy_observations.strategy_variant CHECK to accept the
-- forward A/B telemetry variants. Existing three values preserved; no other change.
ALTER TABLE public.reservation_strategy_observations
  DROP CONSTRAINT IF EXISTS reservation_strategy_observations_strategy_variant_check;

ALTER TABLE public.reservation_strategy_observations
  ADD CONSTRAINT reservation_strategy_observations_strategy_variant_check
  CHECK (
    strategy_variant IN (
      'S1_TAKER_HOLD',
      'S2_FIXED_MAKER_HOLD',
      'S3_MAKER_VALUE_BAND_HOLD',
      'A_CURRENT_CONTROL',
      'B_FOUR_MARKET_PRIORITY_V1'
    )
  );
