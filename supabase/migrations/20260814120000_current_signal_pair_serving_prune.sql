-- Bounded lifecycle maintenance for the replaceable HOT serving projection.
-- Historical generated_signal_pairs lineage is never mutated or scanned broadly.

-- The producer-owned expiry batch reads the current serving projection in expiry
-- order. `now()` stays in the function predicate because it is not indexable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_csps_prune_expired_active
  ON public.current_signal_pair_serving (expires_at ASC)
  WHERE projection_status = 'ACTIVE'
    AND expires_at IS NOT NULL;

-- p_resolved_source_generated_signal_pair_ids is used only by the resolver
-- after its guarded historical update returns exact changed IDs. The join is
-- therefore an exact primary-key lookup, never a historical GSP sweep.
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
  IF p_batch_size < 1 OR p_batch_size > 25 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 25';
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
