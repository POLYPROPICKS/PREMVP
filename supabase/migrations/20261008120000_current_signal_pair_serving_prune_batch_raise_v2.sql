-- PREMVP_APPLICATION_MIGRATION_V1
-- Raise the bounded prune batch ceiling for current_signal_pair_serving to 500.
--
-- Production still enforces the 25-row ceiling because the legacy raise
-- (20260918160000) never reached the Production ledger. This migration is the
-- registered-lifecycle replacement: it only replaces the function body with the
-- same predicates, ordering, FOR UPDATE SKIP LOCKED, return type and grants, and
-- raises the maximum p_batch_size from 25 to 500. The default stays 25. It
-- executes no data DELETE itself, adds no index and mutates no table.
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
  IF p_batch_size < 1 OR p_batch_size > 500 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 500';
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
