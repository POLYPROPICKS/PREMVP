-- Additive modeling feature contract v1.
-- Adds 6 nullable research columns to generated_signal_research_snapshots.
-- No change to production feed scoring, ranking, or eligibility.
-- Idempotent — safe to run multiple times.

ALTER TABLE public.generated_signal_research_snapshots
  ADD COLUMN IF NOT EXISTS event_id                  TEXT    NULL,
  ADD COLUMN IF NOT EXISTS formula_feature_version   TEXT    NULL,
  ADD COLUMN IF NOT EXISTS hours_until_start_num     NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS signal_phase_at_snapshot  TEXT    NULL,
  ADD COLUMN IF NOT EXISTS odds_band_label            TEXT    NULL,
  ADD COLUMN IF NOT EXISTS opposing_price_num        NUMERIC NULL;

CREATE INDEX IF NOT EXISTS idx_gsrs_signal_phase
  ON public.generated_signal_research_snapshots (signal_phase_at_snapshot);
