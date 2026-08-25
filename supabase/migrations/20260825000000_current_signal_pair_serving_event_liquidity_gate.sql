-- PRE-MODEL liquidity gate. The diagnostic value is the canonical aggregate
-- event volume recorded by the producer; missing or malformed evidence fails closed.
DELETE FROM public.current_signal_pair_serving AS serving
USING public.generated_signal_pairs AS source
WHERE source.id = serving.source_generated_signal_pair_id
  AND COALESCE(
    CASE WHEN source.diagnostics ->> 'eventVolumeUsd' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (source.diagnostics ->> 'eventVolumeUsd')::numeric END,
    CASE WHEN source.diagnostics ->> 'parentEventVolume24hr' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (source.diagnostics ->> 'parentEventVolume24hr')::numeric END
  , -1) < 1000;

CREATE OR REPLACE FUNCTION public.refresh_current_signal_pair_serving(
  p_source_generated_signal_pair_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (source_generated_signal_pair_id uuid)
LANGUAGE sql
AS $$
  WITH latest_source AS (
    SELECT DISTINCT ON (
      source.condition_id,
      source.selected_token_id,
      source.metric_formula_version
    )
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
    FROM public.generated_signal_pairs AS source
    WHERE (p_source_generated_signal_pair_ids IS NULL
      OR source.id = ANY(p_source_generated_signal_pair_ids))
      AND source.condition_id IS NOT NULL
      AND source.selected_token_id IS NOT NULL
      AND source.metric_formula_version IS NOT NULL
      AND source.expires_at > now()
      AND source.signal_result IS NULL
      AND COALESCE(
        CASE WHEN source.diagnostics ->> 'eventVolumeUsd' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (source.diagnostics ->> 'eventVolumeUsd')::numeric END,
        CASE WHEN source.diagnostics ->> 'parentEventVolume24hr' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (source.diagnostics ->> 'parentEventVolume24hr')::numeric END
      ) >= 1000
    ORDER BY
      source.condition_id,
      source.selected_token_id,
      source.metric_formula_version,
      source.created_at DESC,
      source.id DESC
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
$$;
