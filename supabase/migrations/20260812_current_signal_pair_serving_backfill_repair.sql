-- MISSION_2 repair: backfill only currently eligible sources, matching the
-- serving contract. Historical/research rows remain untouched and excluded.

CREATE OR REPLACE FUNCTION public.backfill_current_signal_pair_serving(
  p_batch_size integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  checkpoint public.current_signal_pair_serving_backfill_checkpoint%ROWTYPE;
  source_ids uuid[];
  tail_created_at timestamptz;
  tail_id uuid;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 10000';
  END IF;
  SELECT * INTO checkpoint
  FROM public.current_signal_pair_serving_backfill_checkpoint
  WHERE checkpoint_name = 'generated_signal_pairs_v1'
  FOR UPDATE;

  WITH batch AS (
    SELECT source.id, source.created_at
    FROM public.generated_signal_pairs source
    WHERE source.condition_id IS NOT NULL
      AND source.selected_token_id IS NOT NULL
      AND source.metric_formula_version IS NOT NULL
      AND source.expires_at > now()
      AND source.signal_result IS NULL
      AND (checkpoint.last_source_created_at IS NULL
        OR (source.created_at, source.id) > (checkpoint.last_source_created_at, checkpoint.last_source_generated_signal_pair_id))
    ORDER BY source.created_at ASC, source.id ASC
    LIMIT p_batch_size
  )
  SELECT array_agg(id ORDER BY created_at ASC, id ASC), max(created_at),
    (array_agg(id ORDER BY created_at DESC, id DESC))[1]
  INTO source_ids, tail_created_at, tail_id
  FROM batch;

  IF source_ids IS NULL THEN RETURN 0; END IF;
  PERFORM public.refresh_current_signal_pair_serving(source_ids);
  UPDATE public.current_signal_pair_serving_backfill_checkpoint
  SET last_source_created_at = tail_created_at,
      last_source_generated_signal_pair_id = tail_id,
      updated_at = now()
  WHERE checkpoint_name = checkpoint.checkpoint_name;
  RETURN cardinality(source_ids);
END;
$$;

UPDATE public.current_signal_pair_serving_backfill_checkpoint
SET last_source_created_at = NULL,
    last_source_generated_signal_pair_id = NULL,
    updated_at = now()
WHERE checkpoint_name = 'generated_signal_pairs_v1';
