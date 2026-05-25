-- Add metric_formula_version to distinguish v1.1 vs v2-lite snapshots for future formula comparison.
-- Idempotent — safe to run multiple times.

ALTER TABLE public.generated_signal_pairs
  ADD COLUMN IF NOT EXISTS metric_formula_version TEXT;
