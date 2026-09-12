-- PREMVP_APPLICATION_MIGRATION_V1
-- RESERVATION_10AM_READINESS_AND_FIX_V1
--
-- Live evidence (job_runs, source=polymarket, 2026-09-12T05:00 and 05:30
-- cycles): PRIMARY_QUALIFIED_N reached 570 and 585, both above the prior
-- 508 ceiling. publish_primary_signal_observation rejects the WHOLE
-- observation atomically when it exceeds the cap (CHECK evidence_row_count
-- BETWEEN 1 AND N), so both cycles wrote ZERO serving rows for the
-- money-authoritative population (v2-lite-growth-safe) even though every
-- one of the 570/585 identities was independently, correctly qualified.
-- With no successful cycle since, and prior rows' expires_at elapsing,
-- current_signal_pair_serving now holds zero ACTIVE/unexpired
-- v2-lite-growth-safe rows -- an infrastructure drop of the entire current
-- money population, not a policy or business rejection.
--
-- The 508 bound (PRIMARY_SCORER_PROVEN_CAPACITY=254 samples * 2 sides) did
-- not account for BOUNDED_MULTI_IDENTITY_SOURCE_QUALIFICATION_V1's sibling
-- market fan-out (lib/feed/buildLandingCards.ts
-- fanOutAuthorizedTwoSidedOutcomeCandidates + sampleToCandidateMarkets):
-- each of the 254 sampled physical events can independently fan out across
-- up to 3 authorized market families (AUTHORIZED_RECOVERY_MARKET_TYPES:
-- moneyline, spread, total) * 2 sides each = 6 scorer-input identities per
-- physical event. The true bounded maximum producer population is
-- therefore 254 * 6 = 1524, not 254 * 2. This migration only widens the
-- existing finite guard to that derived bound; it does not remove the
-- guard, and no scoring, qualification, or policy logic changes.
ALTER TABLE public.primary_evidence_outbox
  DROP CONSTRAINT IF EXISTS primary_evidence_outbox_evidence_row_count_check;

ALTER TABLE public.primary_evidence_outbox
  ADD CONSTRAINT primary_evidence_outbox_evidence_row_count_check
  CHECK (evidence_row_count BETWEEN 1 AND 1524);

CREATE OR REPLACE FUNCTION public.publish_primary_signal_observation(
  p_observation_id uuid,
  p_observed_at timestamptz,
  p_rows jsonb
)
RETURNS TABLE (serving_projected_n integer, primary_evidence_captured_n integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  row_n integer;
  existing public.primary_evidence_outbox%ROWTYPE;
BEGIN
  IF p_observation_id IS NULL OR p_observed_at IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'invalid primary observation envelope';
  END IF;
  row_n := jsonb_array_length(p_rows);
  IF row_n < 1 OR row_n > 1524 THEN
    RAISE EXCEPTION 'primary observation row count must be between 1 and 1524';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS source(item)
    WHERE NULLIF(item->>'condition_id', '') IS NULL
       OR NULLIF(item->>'selected_token_id', '') IS NULL
       OR NULLIF(item->>'metric_formula_version', '') IS NULL
       OR NULLIF(item->>'observation_id', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'primary observation contains incomplete identity';
  END IF;

  INSERT INTO public.primary_evidence_outbox (
    observation_id, observed_at, evidence_rows, evidence_row_count
  ) VALUES (p_observation_id, p_observed_at, p_rows, row_n)
  ON CONFLICT (observation_id) DO NOTHING;

  SELECT * INTO existing
  FROM public.primary_evidence_outbox
  WHERE observation_id = p_observation_id;
  IF existing.observed_at IS DISTINCT FROM p_observed_at
     OR existing.evidence_rows IS DISTINCT FROM p_rows THEN
    RAISE EXCEPTION 'observation id replay payload mismatch';
  END IF;

  INSERT INTO public.current_signal_pair_serving (
    condition_id, selected_token_id, metric_formula_version,
    observation_id, observed_at, source_generated_signal_pair_id,
    selected_outcome, diagnostics, event_slug, market_slug,
    entry_price_num, signal_confidence_num, expires_at, signal_result,
    source_created_at, served_at, projection_status, projection_error
  )
  SELECT DISTINCT ON (
    item->>'condition_id', item->>'selected_token_id', item->>'metric_formula_version'
  )
    item->>'condition_id',
    item->>'selected_token_id',
    item->>'metric_formula_version',
    (item->>'observation_id')::uuid,
    p_observed_at,
    NULL,
    NULLIF(item->>'selected_outcome', ''),
    COALESCE(item->'diagnostics', '{}'::jsonb),
    NULLIF(item->>'event_slug', ''),
    NULLIF(item->>'market_slug', ''),
    NULLIF(item->>'entry_price_num', '')::numeric,
    NULLIF(item->>'signal_confidence_num', '')::numeric,
    NULLIF(item->>'expires_at', '')::timestamptz,
    NULLIF(item->>'signal_result', ''),
    p_observed_at,
    now(),
    'ACTIVE',
    NULL
  FROM jsonb_array_elements(p_rows) AS source(item)
  WHERE NULLIF(item->>'condition_id', '') IS NOT NULL
    AND NULLIF(item->>'selected_token_id', '') IS NOT NULL
    AND NULLIF(item->>'metric_formula_version', '') IS NOT NULL
  ORDER BY item->>'condition_id', item->>'selected_token_id', item->>'metric_formula_version'
  ON CONFLICT (condition_id, selected_token_id, metric_formula_version) DO UPDATE
  SET observation_id = EXCLUDED.observation_id,
      observed_at = EXCLUDED.observed_at,
      source_generated_signal_pair_id = NULL,
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
  WHERE (EXCLUDED.observed_at, EXCLUDED.observation_id) >=
        (COALESCE(current_signal_pair_serving.observed_at, current_signal_pair_serving.source_created_at),
         COALESCE(current_signal_pair_serving.observation_id,
                  current_signal_pair_serving.source_generated_signal_pair_id,
                  '00000000-0000-0000-0000-000000000000'::uuid));

  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM public.current_signal_pair_serving s
      WHERE s.observation_id IN (
        SELECT (item->>'observation_id')::uuid
        FROM jsonb_array_elements(p_rows) AS source(item)
      )),
    row_n;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_primary_signal_observation(uuid, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_primary_signal_observation(uuid, timestamptz, jsonb)
  TO service_role;
