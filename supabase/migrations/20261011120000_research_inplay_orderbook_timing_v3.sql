-- INPLAY_ORDERBOOK_TIMING_V3 (TELEMETRY-06): three additive nullable timestamptz columns holding the per-token
-- CLOB /book request interval and the validated provider snapshot time. No backfill (history stays NULL), no new
-- index, no change to caps, retention, the deterministic id, observed_at or the writer RPC. The row-typed writer
-- RPC picks the columns up from the table type; its pg_column_size(p_row) > 1000 guard is untouched. Worst case
-- adds 24 bytes of fixed-width data plus at most 8 bytes alignment padding to the largest stored row (608 bytes).
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS orderbook_fetch_started_at timestamptz;
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS orderbook_fetch_completed_at timestamptz;
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS orderbook_provider_timestamp_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inplay_orderbook_interval_valid'
                 AND conrelid = 'public.research_inplay_core_path_observations'::regclass) THEN
    ALTER TABLE public.research_inplay_core_path_observations ADD CONSTRAINT inplay_orderbook_interval_valid CHECK (
      (orderbook_fetch_started_at IS NULL) = (orderbook_fetch_completed_at IS NULL)
      AND (orderbook_fetch_started_at IS NULL OR orderbook_fetch_completed_at >= orderbook_fetch_started_at)
      AND (orderbook_provider_timestamp_at IS NULL OR orderbook_fetch_started_at IS NOT NULL));
  END IF;
END $$;
COMMENT ON COLUMN public.research_inplay_core_path_observations.orderbook_fetch_started_at IS
  'Collector wall clock immediately before this token''s own CLOB /book request. NULL for failed fetches and for rows before TELEMETRY-06.';
COMMENT ON COLUMN public.research_inplay_core_path_observations.orderbook_fetch_completed_at IS
  'Collector wall clock when this token''s /book body was parsed and accepted. Bounds quote freshness only; not an atomic-execution claim.';
COMMENT ON COLUMN public.research_inplay_core_path_observations.orderbook_provider_timestamp_at IS
  'Provider /book snapshot timestamp (epoch ms), kept only when inside [started-60s, completed+2s]; otherwise NULL.';
