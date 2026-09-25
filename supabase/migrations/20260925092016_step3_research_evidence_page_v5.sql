-- PREMVP_APPLICATION_MIGRATION_V1
-- Additive v4-compatible narrow projection. v1/v2/v3/v4 remain untouched.
CREATE OR REPLACE FUNCTION public.research_evidence_page_v5(
  p_after_observed_at timestamptz,
  p_after_observation_id uuid,
  p_after_item_observation_id uuid,
  p_until timestamptz,
  p_max_rows integer DEFAULT 500
)
RETURNS TABLE (
  observation_id uuid, observed_at timestamptz, item_observation_id uuid,
  condition_id text, selected_token_id text, metric_formula_version text,
  entry_price_num numeric, signal_confidence_num numeric, signal_result text,
  formula_version text, pre_event_score_num numeric, provider_event_id text,
  provider_sport_code text, provider_sport_family text, market_family text,
  market_type text, event_title text, market_question text, game_start_iso text,
  volume_usd numeric, volume_semantic text, selected_outcome text, data_coverage numeric,
  league text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
SET statement_timeout = '5s'
AS $$
DECLARE
  v_after_at timestamptz := COALESCE(p_after_observed_at, '-infinity'::timestamptz);
  v_after_env uuid := COALESCE(p_after_observation_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_after_item uuid := COALESCE(p_after_item_observation_id, '00000000-0000-0000-0000-000000000000'::uuid);
BEGIN
  IF p_until IS NULL THEN
    RAISE EXCEPTION 'research_evidence_page_v5 requires an explicit p_until upper time bound';
  END IF;

  RETURN QUERY
  WITH env AS (
    SELECT o.observation_id AS env_id, o.observed_at AS env_at, o.evidence_rows AS env_rows
    FROM public.primary_evidence_outbox o
    WHERE (o.observed_at, o.observation_id) >= (v_after_at, v_after_env)
      AND o.observed_at < p_until
    ORDER BY o.observed_at, o.observation_id
    LIMIT 20
  ), flat AS (
    SELECT n.env_id, n.env_at, e.item AS item,
      NULLIF(e.item->>'observation_id', '')::uuid AS item_id
    FROM env n CROSS JOIN LATERAL jsonb_array_elements(n.env_rows) AS e(item)
  )
  SELECT
    f.env_id, f.env_at, f.item_id,
    NULLIF(f.item->>'condition_id', ''),
    NULLIF(f.item->>'selected_token_id', ''),
    NULLIF(f.item->>'metric_formula_version', ''),
    NULLIF(f.item->>'entry_price_num', '')::numeric,
    NULLIF(f.item->>'signal_confidence_num', '')::numeric,
    NULLIF(f.item->>'signal_result', ''),
    NULLIF(f.item->>'formula_version', ''),
    NULLIF(f.item->>'pre_event_score_num', '')::numeric,
    NULLIF(f.item->'diagnostics'->>'providerEventId', ''),
    NULLIF(f.item->'diagnostics'->>'providerSportCode', ''),
    NULLIF(f.item->'diagnostics'->>'providerSportFamily', ''),
    NULLIF(f.item->'diagnostics'->>'marketFamily', ''),
    COALESCE(NULLIF(f.item->'diagnostics'->'providerEventContext'->>'marketType', ''), NULLIF(f.item->'diagnostics'->>'marketType', '')),
    NULLIF(f.item->'diagnostics'->'providerEventContext'->>'eventTitle', ''),
    NULLIF(f.item->'diagnostics'->'providerEventContext'->>'marketQuestion', ''),
    NULLIF(f.item->'diagnostics'->>'gameStartIso', ''),
    COALESCE(NULLIF(f.item->'diagnostics'->>'parentEventVolume24hr', '')::numeric, NULLIF(f.item->'diagnostics'->>'volumeUsd', '')::numeric),
    CASE
      WHEN NULLIF(f.item->'diagnostics'->>'parentEventVolume24hr', '') IS NOT NULL
        THEN 'primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr'
      WHEN NULLIF(f.item->'diagnostics'->>'volumeUsd', '') IS NOT NULL
        THEN 'primary_evidence_outbox.evidence_rows[].diagnostics.volumeUsd'
      ELSE NULL
    END,
    NULLIF(f.item->>'selected_outcome', ''),
    NULLIF(f.item->'diagnostics'->>'dataCoverage', '')::numeric,
    NULLIF(f.item->'diagnostics'->'providerEventContext'->>'league', '')
  FROM flat f
  WHERE f.item_id IS NOT NULL
    AND (f.env_at, f.env_id, f.item_id) > (v_after_at, v_after_env, v_after_item)
  ORDER BY f.env_at, f.env_id, f.item_id
  LIMIT LEAST(GREATEST(COALESCE(p_max_rows, 500), 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION public.research_evidence_page_v5(timestamptz, uuid, uuid, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_evidence_page_v5(timestamptz, uuid, uuid, timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.research_evidence_page_v5(timestamptz, uuid, uuid, timestamptz, integer) IS
  'Read-only bounded narrow v5 projection of primary_evidence_outbox. Adds verbatim diagnostics.providerEventContext.league to the unchanged v4 contract.';
