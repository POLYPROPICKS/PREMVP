-- B7: current serving is sourced from observations/outbox, not GSP.
-- Preserve nullable historical lineage while removing its live FK dependency.
ALTER TABLE public.current_signal_pair_serving
  DROP CONSTRAINT IF EXISTS current_signal_pair_serving_source_generated_signal_pair_id_fkey;
