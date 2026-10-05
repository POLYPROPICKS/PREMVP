-- PREMVP_APPLICATION_MIGRATION_V1
-- research_evidence_page_v3 — ITEM-LEVEL cursor over the flattened research
-- projection of primary_evidence_outbox.
--
-- Why v3: v1/v2 paginate by ENVELOPE cursor (observed_at, observation_id) while
-- returning FLATTENED item rows. A response that ends inside an envelope makes
-- the client advance past the whole envelope, so that envelope's remaining items
-- become unreachable (measured: ~6.98% of Sep09-Sep19 item rows missing while
-- every envelope was present). v3 pages by the triplet
-- (observed_at, observation_id, item_observation_id) with a hard flattened-ROW
-- bound, so a page can end mid-envelope and the next call resumes inside it.
--
-- Additive only:
--   * public.research_evidence_page (v1) and public.research_evidence_page_v2
--     are NOT dropped, altered, revoked or replaced.
--   * No index is created: the composite envelope index
--     idx_primary_evidence_outbox_observed (observed_at, observation_id) already
--     exists and serves the envelope lookup below.
--   * No table is rewritten; no money-path function is referenced.
--
-- Contract:
--   * p_until is REQUIRED (NULL rejected, never widened to "everything");
--   * the envelope lookup starts AT the cursor envelope (>=), so remaining items
--     of a partially returned envelope are reachable, and is bounded to 20
--     envelopes internally;
--   * only items strictly greater than the (envelope, item) triplet are returned,
--     ordered by observed_at, observation_id, item_observation_id;
--   * at most 500 flattened rows per call, clamped server-side (ROW bound);
--   * items without an item_observation_id are not returned (clone identity
--     requires it; no identity is invented);
--   * statement_timeout pinned to 5s; STABLE + SECURITY INVOKER; no OFFSET;
--   * evidence_rows itself is never returned.
CREATE OR REPLACE FUNCTION public.research_evidence_page_v3(
  p_after_observed_at timestamptz,
  p_after_observation_id uuid,
  p_after_item_observation_id uuid,
  p_until timestamptz,
  p_max_rows integer DEFAULT 500
)
RETURNS TABLE (
  observation_id uuid,
  observed_at timestamptz,
  item_observation_id uuid,
  condition_id text,
  selected_token_id text,
  metric_formula_version text,
  entry_price_num numeric,
  signal_confidence_num numeric,
  signal_result text,
  formula_version text,
  pre_event_score_num numeric,
  provider_event_id text,
  provider_sport_code text,
  provider_sport_family text,
  market_family text,
  market_type text,
  game_start_iso text,
  volume_usd numeric,
  volume_semantic text,
  selected_outcome text,
  data_coverage numeric
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
    RAISE EXCEPTION 'research_evidence_page_v3 requires an explicit p_until upper time bound';
  END IF;

  RETURN QUERY
  WITH env AS (
    SELECT o.observation_id AS env_id, o.observed_at AS env_at, o.evidence_rows AS env_rows
    FROM public.primary_evidence_outbox o
    WHERE (o.observed_at, o.observation_id) >= (v_after_at, v_after_env)
      AND o.observed_at < p_until
    ORDER BY o.observed_at, o.observation_id
    LIMIT 20
  ),
  flat AS (
    SELECT
      n.env_id,
      n.env_at,
      e.item AS item,
      NULLIF(e.item->>'observation_id', '')::uuid AS item_id
    FROM env n
    CROSS JOIN LATERAL jsonb_array_elements(n.env_rows) AS e(item)
  )
  SELECT
    f.env_id,
    f.env_at,
    f.item_id,
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
    COALESCE(
      NULLIF(f.item->'diagnostics'->'providerEventContext'->>'marketType', ''),
      NULLIF(f.item->'diagnostics'->>'marketType', '')
    ),
    NULLIF(f.item->'diagnostics'->>'gameStartIso', ''),
    COALESCE(
      NULLIF(f.item->'diagnostics'->>'parentEventVolume24hr', '')::numeric,
      NULLIF(f.item->'diagnostics'->>'volumeUsd', '')::numeric
    ),
    CASE
      WHEN NULLIF(f.item->'diagnostics'->>'parentEventVolume24hr', '') IS NOT NULL
        THEN 'primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr'
      WHEN NULLIF(f.item->'diagnostics'->>'volumeUsd', '') IS NOT NULL
        THEN 'primary_evidence_outbox.evidence_rows[].diagnostics.volumeUsd'
      ELSE NULL
    END,
    NULLIF(f.item->>'selected_outcome', ''),
    NULLIF(f.item->'diagnostics'->>'dataCoverage', '')::numeric
  FROM flat f
  WHERE f.item_id IS NOT NULL
    AND (f.env_at, f.env_id, f.item_id) > (v_after_at, v_after_env, v_after_item)
  ORDER BY f.env_at, f.env_id, f.item_id
  LIMIT LEAST(GREATEST(COALESCE(p_max_rows, 500), 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION public.research_evidence_page_v3(timestamptz, uuid, uuid, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_evidence_page_v3(timestamptz, uuid, uuid, timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.research_evidence_page_v3(timestamptz, uuid, uuid, timestamptz, integer) IS
  'Read-only bounded narrow research projection of primary_evidence_outbox with an item-level (observed_at, observation_id, item_observation_id) cursor. Max 500 flattened rows per call, 5s statement timeout, explicit upper time bound required. Never returns evidence_rows.';
