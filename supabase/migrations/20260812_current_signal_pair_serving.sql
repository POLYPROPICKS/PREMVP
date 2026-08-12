-- Canonical bounded serving projection for current operational Signal Pair reads.
-- generated_signal_pairs remains the retained historical/research corpus.

CREATE TABLE IF NOT EXISTS public.current_signal_pair_serving (
  condition_id text NOT NULL,
  selected_token_id text NOT NULL,
  metric_formula_version text NOT NULL,
  source_generated_signal_pair_id uuid NOT NULL REFERENCES public.generated_signal_pairs(id),
  selected_outcome text,
  diagnostics jsonb,
  event_slug text,
  market_slug text,
  entry_price_num numeric,
  signal_confidence_num numeric,
  expires_at timestamptz,
  signal_result text,
  source_created_at timestamptz NOT NULL,
  served_at timestamptz NOT NULL DEFAULT now(),
  projection_status text NOT NULL DEFAULT 'ACTIVE',
  projection_error text,
  PRIMARY KEY (condition_id, selected_token_id, metric_formula_version),
  UNIQUE (source_generated_signal_pair_id),
  CHECK (projection_status IN ('ACTIVE', 'PENDING'))
);

COMMENT ON TABLE public.current_signal_pair_serving IS
  'Replaceable current operational projection. Historical authority remains generated_signal_pairs.';

CREATE TABLE IF NOT EXISTS public.current_signal_pair_serving_backfill_checkpoint (
  checkpoint_name text PRIMARY KEY,
  last_source_created_at timestamptz,
  last_source_generated_signal_pair_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (last_source_created_at IS NULL AND last_source_generated_signal_pair_id IS NULL)
    OR (last_source_created_at IS NOT NULL AND last_source_generated_signal_pair_id IS NOT NULL)
  )
);

INSERT INTO public.current_signal_pair_serving_backfill_checkpoint (checkpoint_name)
VALUES ('generated_signal_pairs_v1')
ON CONFLICT (checkpoint_name) DO NOTHING;

-- Reconciles either a supplied source batch (writer path) or the complete current
-- corpus (deterministic backfill). DISTINCT ON establishes the accepted latest
-- (created_at, id) winner before the conflict upsert, so a replay is idempotent.
CREATE OR REPLACE FUNCTION public.refresh_current_signal_pair_serving(
  p_source_generated_signal_pair_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (source_generated_signal_pair_id uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH impacted_keys AS (
    SELECT DISTINCT source.condition_id, source.selected_token_id, source.metric_formula_version
    FROM public.generated_signal_pairs source
    WHERE (p_source_generated_signal_pair_ids IS NULL OR source.id = ANY(p_source_generated_signal_pair_ids))
      AND source.condition_id IS NOT NULL
      AND source.selected_token_id IS NOT NULL
      AND source.metric_formula_version IS NOT NULL
  ), latest_source AS (
    SELECT DISTINCT ON (source.condition_id, source.selected_token_id, source.metric_formula_version)
      source.id,
      source.condition_id,
      source.selected_token_id,
      source.metric_formula_version,
      source.selected_outcome,
      source.diagnostics,
      source.event_slug,
      source.market_slug,
      source.entry_price_num,
      source.signal_confidence_num,
      source.expires_at,
      source.signal_result,
      source.created_at
    FROM public.generated_signal_pairs source
    JOIN impacted_keys key ON key.condition_id = source.condition_id
      AND key.selected_token_id = source.selected_token_id
      AND key.metric_formula_version = source.metric_formula_version
    WHERE source.condition_id IS NOT NULL
      AND source.selected_token_id IS NOT NULL
      AND source.metric_formula_version IS NOT NULL
      AND source.expires_at > now()
      AND source.signal_result IS NULL
    ORDER BY source.condition_id, source.selected_token_id, source.metric_formula_version,
      source.created_at DESC, source.id DESC
  ), applied AS (
    INSERT INTO public.current_signal_pair_serving (
      condition_id, selected_token_id, metric_formula_version,
      source_generated_signal_pair_id, selected_outcome, diagnostics, event_slug,
      market_slug, entry_price_num, signal_confidence_num, expires_at, signal_result,
      source_created_at, served_at, projection_status, projection_error
    )
    SELECT
      condition_id, selected_token_id, metric_formula_version,
      id, selected_outcome, diagnostics, event_slug, market_slug, entry_price_num,
      signal_confidence_num, expires_at, signal_result, created_at, now(), 'ACTIVE', NULL
    FROM latest_source
    ON CONFLICT (condition_id, selected_token_id, metric_formula_version) DO UPDATE
      SET source_generated_signal_pair_id = EXCLUDED.source_generated_signal_pair_id,
          selected_outcome = EXCLUDED.selected_outcome,
          diagnostics = EXCLUDED.diagnostics,
          event_slug = EXCLUDED.event_slug,
          market_slug = EXCLUDED.market_slug,
          entry_price_num = EXCLUDED.entry_price_num,
          signal_confidence_num = EXCLUDED.signal_confidence_num,
          expires_at = EXCLUDED.expires_at,
          signal_result = EXCLUDED.signal_result,
          source_created_at = EXCLUDED.source_created_at,
          served_at = EXCLUDED.served_at,
          projection_status = 'ACTIVE',
          projection_error = NULL
      WHERE (EXCLUDED.source_created_at, EXCLUDED.source_generated_signal_pair_id)
          > (current_signal_pair_serving.source_created_at, current_signal_pair_serving.source_generated_signal_pair_id)
    RETURNING current_signal_pair_serving.source_generated_signal_pair_id
  )
  SELECT applied.source_generated_signal_pair_id FROM applied;
END;
$$;

-- Processes one deterministic committed source batch. The checkpoint moves only
-- after refresh succeeds, so replay after an interrupted run is idempotent.
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
      OR (source.created_at, source.id) > (checkpoint.last_source_created_at, checkpoint.last_source_generated_signal_pair_id)
      )
    ORDER BY source.created_at ASC, source.id ASC
    LIMIT p_batch_size
  )
  SELECT array_agg(id ORDER BY created_at ASC, id ASC), max(created_at), (array_agg(id ORDER BY created_at DESC, id DESC))[1]
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
