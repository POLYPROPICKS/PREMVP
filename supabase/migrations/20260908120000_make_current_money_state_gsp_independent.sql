-- PREMVP_APPLICATION_MIGRATION_V1
-- Direct, atomic current-money publication. Historical GSP remains available
-- to legacy cohorts but is no longer a synchronous prerequisite.
ALTER TABLE public.current_signal_pair_serving
  ALTER COLUMN source_generated_signal_pair_id DROP NOT NULL;

ALTER TABLE public.current_signal_pair_serving
  DROP CONSTRAINT IF EXISTS current_signal_pair_serving_source_generated_signal_pair_id_fkey;

ALTER TABLE public.current_signal_pair_serving
  ADD COLUMN IF NOT EXISTS observation_id uuid,
  ADD COLUMN IF NOT EXISTS observed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_current_signal_pair_serving_observed
  ON public.current_signal_pair_serving (observed_at DESC, observation_id DESC);

CREATE TABLE public.primary_evidence_outbox (
  observation_id uuid PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  evidence_rows jsonb NOT NULL,
  evidence_row_count integer NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(evidence_rows) = 'array'),
  CHECK (evidence_row_count BETWEEN 1 AND 300),
  CHECK (jsonb_array_length(evidence_rows) = evidence_row_count)
);

COMMENT ON TABLE public.primary_evidence_outbox IS
  'Durable exact primary money evidence only; excludes shadow, research, and inventory populations.';

ALTER TABLE public.primary_evidence_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.primary_evidence_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.primary_evidence_outbox TO service_role;

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
  IF row_n < 1 OR row_n > 300 THEN
    RAISE EXCEPTION 'primary observation row count must be between 1 and 300';
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
