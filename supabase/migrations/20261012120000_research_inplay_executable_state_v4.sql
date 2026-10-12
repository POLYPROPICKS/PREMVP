-- INPLAY_EXECUTABLE_STATE_V4 (TELEMETRY-09): five additive nullable columns that make a NULL BUY/SELL quote
-- explainable (typed full-stake executable state, typed taker-fee state/reason) and bound quote freshness per
-- capture cycle (leg count and earliest-request-start to latest-response-completion span). No backfill (history
-- stays NULL), no new index, no change to caps, retention, the deterministic id, observed_at or the writer RPC.
-- The row-typed writer RPC picks the columns up from the table type; its pg_column_size(p_row) > 1000 guard is
-- untouched. Worst case adds at most about 100 bytes to the largest stored row (about 640 bytes with TELEMETRY-06).
-- Release order: DBClone DDL first, then this Production DDL, then the collector. Rows from INPLAY_CORE_PATH_V2
-- on walk BUY asks to 0.99 (V1 rows used the pre-game Queue cap 0.555).
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS executable_full_stake_state text;
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS taker_fee_state text;
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS taker_fee_reason text;
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS quote_cycle_legs smallint;
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS quote_cycle_span_ms integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inplay_executable_state_valid'
                 AND conrelid = 'public.research_inplay_core_path_observations'::regclass) THEN
    ALTER TABLE public.research_inplay_core_path_observations ADD CONSTRAINT inplay_executable_state_valid CHECK (
      (executable_full_stake_state IS NULL OR executable_full_stake_state IN ('EXECUTABLE', 'NOT_EXECUTABLE_MIN_ORDER_SIZE',
        'NOT_EXECUTABLE_DEPTH_AT_CAP', 'UNKNOWN_BOOK_UNAVAILABLE', 'UNKNOWN_MIN_ORDER_SIZE', 'UNKNOWN_TELEMETRY_COMPUTE_FAILED'))
      AND (taker_fee_state IS NULL OR taker_fee_state IN ('KNOWN', 'UNKNOWN'))
      AND (quote_cycle_legs IS NULL OR quote_cycle_legs BETWEEN 1 AND 16)
      AND (quote_cycle_span_ms IS NULL OR (quote_cycle_span_ms >= 0 AND quote_cycle_legs IS NOT NULL)));
  END IF;
END $$;
COMMENT ON COLUMN public.research_inplay_core_path_observations.executable_full_stake_state IS
  'Typed outcome of the full-stake BUY walk. full_stake_executable_vwap/full_stake_shares are non-NULL for NOT_EXECUTABLE_MIN_ORDER_SIZE and UNKNOWN_MIN_ORDER_SIZE too; only EXECUTABLE means the stake clears the book and the minimum order. NULL for rows before TELEMETRY-09.';
COMMENT ON COLUMN public.research_inplay_core_path_observations.taker_fee_state IS
  'KNOWN when the provider fee schedule was fetched for this token, else UNKNOWN (reason in taker_fee_reason). taker_fee_usd is NULL for UNKNOWN; it is never imputed as zero.';
COMMENT ON COLUMN public.research_inplay_core_path_observations.quote_cycle_legs IS
  'Tokens whose /book was requested in this capture cycle (all legs of the selected markets), including legs not persisted as rows. NULL before TELEMETRY-09.';
COMMENT ON COLUMN public.research_inplay_core_path_observations.quote_cycle_span_ms IS
  'Earliest /book request start to latest response completion across ALL legs of the cycle; NULL unless every leg has a validated acquisition window. Bounds quote freshness only; not an atomic-execution claim.';
