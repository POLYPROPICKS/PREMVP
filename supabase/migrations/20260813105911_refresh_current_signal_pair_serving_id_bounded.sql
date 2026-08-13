-- Bound incremental projection refreshes to the supplied source rows. The NULL
-- path intentionally retains full-corpus recovery semantics.
CREATE OR REPLACE FUNCTION public.refresh_current_signal_pair_serving(
  p_source_generated_signal_pair_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (source_generated_signal_pair_id uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_source_generated_signal_pair_ids IS NOT NULL THEN
    RETURN QUERY
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
      FROM public.generated_signal_pairs source
      WHERE source.id = ANY(p_source_generated_signal_pair_ids)
        AND source.condition_id IS NOT NULL
        AND source.selected_token_id IS NOT NULL
        AND source.metric_formula_version IS NOT NULL
        AND source.expires_at > now()
        AND source.signal_result IS NULL
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
  ELSE
    RETURN QUERY
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
      FROM public.generated_signal_pairs source
      WHERE source.condition_id IS NOT NULL
        AND source.selected_token_id IS NOT NULL
        AND source.metric_formula_version IS NOT NULL
        AND source.expires_at > now()
        AND source.signal_result IS NULL
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
  END IF;
END;
$$;
