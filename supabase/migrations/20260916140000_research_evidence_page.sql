-- PREMVP_APPLICATION_MIGRATION_V1
-- Bounded additive research export projection.
--
-- Purpose: give research a bounded, narrow, server-side projection of
-- primary_evidence_outbox so the research lineage never again transfers full
-- operational evidence_rows envelopes across the network.
--
-- Measured justification (bounded read-only production proof, 2026-09-16, no
-- mutation): the 2026-09-14 Minsk day holds 179 envelopes / 26,515 evidence
-- rows. One evidence item serializes to ~5.3 KB, so a full-envelope client-side
-- transfer of that single day is ~140 MB, of which research consumes 18 fields.
-- Envelope-level metadata for the same day reads in ~175 ms.
--
-- LOCK / LOAD CHARACTERISTICS (explicit, not inferred from tests):
--   * CREATE INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE on
--     primary_evidence_outbox. It does NOT block INSERT from
--     publish_primary_signal_observation, and does NOT block SELECT. It does
--     block other DDL and VACUUM on that table for its duration. It performs
--     two table passes and cannot run inside a transaction block: this file
--     MUST be applied outside an explicit transaction.
--     If it fails it can leave an INVALID index; recovery is handled outside
--     this admission migration.
--   * The index is on (observed_at, observation_id) only — two fixed-width
--     columns, no TOAST traffic. On the current table size the build is
--     expected to be sub-second and the on-disk cost is a few hundred KB.
--   * CREATE FUNCTION takes no lock on any table. research_evidence_page is
--     STABLE, SECURITY INVOKER, and reads exactly one table.
--   * No table is rewritten. No existing row is read-modified-written. No
--     existing function is replaced — research_evidence_page is a new name and
--     publish_primary_signal_observation is not referenced here.
--
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_primary_evidence_outbox_observed
  ON public.primary_evidence_outbox (observed_at, observation_id);

-- Bounded narrow research page.
--
-- Contract:
--   * cursor is the row-value pair (observed_at, observation_id), strictly
--     greater than the caller's last position — no OR-composed keyset, no
--     OFFSET, so the index above serves it as a single range scan;
--   * p_until is a REQUIRED explicit upper time bound — a NULL is rejected,
--     never silently widened to "everything";
--   * at most 20 envelopes per call, clamped server-side so no client can ask
--     for more;
--   * statement_timeout is pinned to 5s for this function only;
--   * returns only the fields the research/model-ready pipeline actually reads
--     (see lib/research-clone/researchEvidenceExport.ts) — evidence_rows itself
--     is never returned;
--   * STABLE + SECURITY INVOKER; the body has no data-changing statements.
CREATE FUNCTION public.research_evidence_page(
  p_after_observed_at timestamptz,
  p_after_observation_id uuid,
  p_until timestamptz,
  p_max_envelopes integer DEFAULT 20
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
BEGIN
  IF p_until IS NULL THEN
    RAISE EXCEPTION 'research_evidence_page requires an explicit p_until upper time bound';
  END IF;

  RETURN QUERY
  WITH bounded AS (
    SELECT o.observation_id AS env_id, o.observed_at AS env_at, o.evidence_rows AS env_rows
    FROM public.primary_evidence_outbox o
    WHERE (o.observed_at, o.observation_id)
            > (COALESCE(p_after_observed_at, '-infinity'::timestamptz),
               COALESCE(p_after_observation_id, '00000000-0000-0000-0000-000000000000'::uuid))
      AND o.observed_at < p_until
    ORDER BY o.observed_at, o.observation_id
    LIMIT LEAST(GREATEST(COALESCE(p_max_envelopes, 20), 1), 20)
  )
  SELECT
    b.env_id,
    b.env_at,
    NULLIF(e.item->>'observation_id', '')::uuid,
    NULLIF(e.item->>'condition_id', ''),
    NULLIF(e.item->>'selected_token_id', ''),
    NULLIF(e.item->>'metric_formula_version', ''),
    NULLIF(e.item->>'entry_price_num', '')::numeric,
    NULLIF(e.item->>'signal_confidence_num', '')::numeric,
    NULLIF(e.item->>'signal_result', ''),
    NULLIF(e.item->>'formula_version', ''),
    NULLIF(e.item->>'pre_event_score_num', '')::numeric,
    NULLIF(e.item->'diagnostics'->>'providerEventId', ''),
    NULLIF(e.item->'diagnostics'->>'providerSportCode', ''),
    NULLIF(e.item->'diagnostics'->>'providerSportFamily', ''),
    NULLIF(e.item->'diagnostics'->>'marketFamily', ''),
    COALESCE(
      NULLIF(e.item->'diagnostics'->'providerEventContext'->>'marketType', ''),
      NULLIF(e.item->'diagnostics'->>'marketType', '')
    ),
    NULLIF(e.item->'diagnostics'->>'gameStartIso', ''),
    COALESCE(
      NULLIF(e.item->'diagnostics'->>'parentEventVolume24hr', '')::numeric,
      NULLIF(e.item->'diagnostics'->>'volumeUsd', '')::numeric
    ),
    CASE
      WHEN NULLIF(e.item->'diagnostics'->>'parentEventVolume24hr', '') IS NOT NULL
        THEN 'primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr'
      WHEN NULLIF(e.item->'diagnostics'->>'volumeUsd', '') IS NOT NULL
        THEN 'primary_evidence_outbox.evidence_rows[].diagnostics.volumeUsd'
      ELSE NULL
    END,
    NULLIF(e.item->>'selected_outcome', ''),
    NULLIF(e.item->'diagnostics'->>'dataCoverage', '')::numeric
  FROM bounded b
  CROSS JOIN LATERAL jsonb_array_elements(b.env_rows) AS e(item)
  ORDER BY b.env_at, b.env_id, (e.item->>'observation_id');
END;
$$;

REVOKE ALL ON FUNCTION public.research_evidence_page(timestamptz, uuid, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_evidence_page(timestamptz, uuid, timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.research_evidence_page(timestamptz, uuid, timestamptz, integer) IS
  'Read-only bounded narrow research projection of primary_evidence_outbox. Max 20 envelopes per call, 5s statement timeout, explicit upper time bound required. Never returns evidence_rows.';
