-- PREMVP_APPLICATION_MIGRATION_V1
-- Founder Mission 1: UTC stage 200 / 40,000 rows / 40 MB. Stage 300 is NOT activated.
CREATE OR REPLACE FUNCTION public.research_insert_inplay_core_path(p_row public.research_inplay_core_path_observations)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_day timestamptz := date_trunc('day', p_row.observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_events integer;
  v_rows integer;
  v_event_rows integer;
  v_tokens integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('research_inplay_core_path:' || v_day::text, 0));
  IF p_row.observed_at > now() + interval '1 minute' OR p_row.observed_at < now() - interval '10 minutes'
     OR pg_column_size(p_row) > 1000 THEN RAISE EXCEPTION 'INPLAY_STORAGE_BUDGET_EXCEEDED'; END IF;
  IF EXISTS (SELECT 1 FROM public.research_inplay_core_path_observations WHERE id = p_row.id) THEN RETURN false; END IF;
  SELECT count(*) INTO v_rows FROM public.research_inplay_core_path_observations
   WHERE observed_at >= v_day AND observed_at < v_day + interval '1 day';
  IF v_rows >= 40000 THEN RAISE EXCEPTION 'INPLAY_STORAGE_BUDGET_EXCEEDED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.research_inplay_core_path_observations WHERE physical_event_id = p_row.physical_event_id
                 AND observed_at >= v_day AND observed_at < v_day + interval '1 day') THEN
    SELECT count(DISTINCT physical_event_id) INTO v_events FROM public.research_inplay_core_path_observations
     WHERE observed_at >= v_day AND observed_at < v_day + interval '1 day';
    IF v_events >= 200 THEN RAISE EXCEPTION 'INPLAY_STORAGE_BUDGET_EXCEEDED'; END IF;
  END IF;
  SELECT count(*), count(DISTINCT token_id) INTO v_event_rows, v_tokens
    FROM public.research_inplay_core_path_observations WHERE physical_event_id = p_row.physical_event_id;
  IF v_event_rows >= 192 THEN RAISE EXCEPTION 'INPLAY_STORAGE_BUDGET_EXCEEDED'; END IF;
  IF p_row.persistence_reason <> 'FINAL_STATE' AND v_event_rows >= 176 THEN
    RAISE EXCEPTION 'INPLAY_STORAGE_BUDGET_EXCEEDED';
  END IF;
  IF v_tokens >= 16 AND NOT EXISTS (SELECT 1 FROM public.research_inplay_core_path_observations
    WHERE physical_event_id = p_row.physical_event_id AND token_id = p_row.token_id) THEN
    RAISE EXCEPTION 'INPLAY_STORAGE_BUDGET_EXCEEDED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.research_inplay_core_path_observations
    WHERE physical_event_id = p_row.physical_event_id AND token_id = p_row.token_id
    AND observed_at = p_row.observed_at AND persistence_reason = p_row.persistence_reason) THEN RETURN false; END IF;
  p_row.sequence_in_event := v_event_rows + 1;
  p_row.created_at := now();
  INSERT INTO public.research_inplay_core_path_observations SELECT (p_row).*;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.research_insert_inplay_core_path(public.research_inplay_core_path_observations) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.research_insert_inplay_core_path(public.research_inplay_core_path_observations) TO service_role;
