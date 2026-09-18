-- Raise the bounded prune batch ceiling for current_signal_pair_serving.
--
-- The prune batch size was fixed at 25 rows per call (roadmap step
-- 20260814120000). That predicate/index remain correct: ordered by
-- expires_at ASC, index-backed (idx_csps_prune_expired_active), FOR UPDATE
-- SKIP LOCKED, never a broad or unbounded scan. But 25 rows/call could not
-- keep pace with sustained ACTIVE-row accumulation on the production HOT
-- serving projection: by design every "money" generate-signals run prunes
-- exactly one 25-row batch (CURRENT_SERVING_PRUNE_BATCH_SIZE), and that
-- fixed ceiling -- not the predicate -- is why expired ACTIVE rows built up
-- over months (BATCH_LIMIT_STARVATION). This migration only raises the
-- per-call ceiling; it changes no predicate, no index, no historical data,
-- and performs no bulk delete itself.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';

CREATE OR REPLACE FUNCTION public.prune_current_signal_pair_serving(
  p_batch_size integer DEFAULT 25,
  p_resolved_source_generated_signal_pair_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 5000 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 5000';
  END IF;

  IF p_resolved_source_generated_signal_pair_ids IS NOT NULL THEN
    WITH candidates AS (
      SELECT serving.ctid
      FROM public.current_signal_pair_serving serving
      JOIN public.generated_signal_pairs source
        ON source.id = serving.source_generated_signal_pair_id
      WHERE serving.source_generated_signal_pair_id = ANY(p_resolved_source_generated_signal_pair_ids)
        AND source.signal_result IS NOT NULL
      ORDER BY serving.source_generated_signal_pair_id
      LIMIT p_batch_size
      FOR UPDATE OF serving SKIP LOCKED
    ), deleted AS (
      DELETE FROM public.current_signal_pair_serving serving
      USING candidates
      WHERE serving.ctid = candidates.ctid
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM deleted;
  ELSE
    WITH candidates AS (
      SELECT serving.ctid
      FROM public.current_signal_pair_serving serving
      WHERE serving.projection_status = 'ACTIVE'
        AND serving.expires_at <= now()
      ORDER BY serving.expires_at ASC
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    ), deleted AS (
      DELETE FROM public.current_signal_pair_serving serving
      USING candidates
      WHERE serving.ctid = candidates.ctid
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM deleted;
  END IF;

  RETURN deleted_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prune_current_signal_pair_serving(integer, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_current_signal_pair_serving(integer, uuid[]) TO service_role;
