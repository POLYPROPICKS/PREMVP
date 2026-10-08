-- PREMVP_APPLICATION_MIGRATION_V1
-- INPLAY_CORE_PATH_TELEMETRY_V1. Research facts only; no money-path reader.
CREATE TABLE public.research_inplay_core_path_observations (
  id uuid PRIMARY KEY,
  physical_event_id text NOT NULL,
  provider_game_id text,
  provider_event_id text NOT NULL,
  provider_sport_family text NOT NULL,
  provider_sport_code text,
  provider_sport_source text NOT NULL,
  event_start_iso timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  source_version text NOT NULL,
  event_live_status text NOT NULL,
  state_authority text NOT NULL,
  state_phase text,
  state_period_num integer,
  state_clock_seconds_remaining integer,
  side_a_score numeric,
  side_b_score numeric,
  side_a_red_cards integer,
  side_b_red_cards integer,
  condition_id text NOT NULL,
  token_id text NOT NULL,
  side text NOT NULL,
  canonical_market_family text NOT NULL,
  canonical_market_type text NOT NULL,
  provider_market_type_raw text,
  market_slug text,
  best_bid numeric,
  best_ask numeric,
  mid_price numeric,
  spread_abs numeric,
  tick_size numeric,
  minimum_order_size numeric,
  bid_depth_relevant_usd numeric,
  ask_depth_relevant_usd numeric,
  full_stake_executable_vwap numeric,
  full_stake_shares numeric,
  full_stake_exit_vwap numeric,
  full_stake_exit_fully_filled boolean,
  taker_fee_usd numeric,
  orderbook_fetch_status text NOT NULL,
  persistence_reason text NOT NULL,
  sequence_in_event integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inplay_observation_size CHECK (octet_length(physical_event_id) <= 100
    AND octet_length(provider_event_id) <= 100 AND octet_length(token_id) <= 100
    AND octet_length(condition_id) <= 100 AND octet_length(side) <= 100
    AND (market_slug IS NULL OR octet_length(market_slug) <= 180))
);
CREATE INDEX research_inplay_core_path_event_time_idx ON public.research_inplay_core_path_observations (physical_event_id, observed_at);
CREATE INDEX research_inplay_core_path_retention_idx ON public.research_inplay_core_path_observations (observed_at, id);
ALTER TABLE public.research_inplay_core_path_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_inplay_core_path_observations FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.research_inplay_core_path_observations TO service_role;

-- Single writer gate under a transaction advisory lock. The deterministic UUID PK
-- represents (physical event, token, observed_at, reason), avoiding another index.
CREATE FUNCTION public.research_insert_inplay_core_path(p_row public.research_inplay_core_path_observations)
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
  IF v_rows >= 20000 THEN RAISE EXCEPTION 'INPLAY_STORAGE_BUDGET_EXCEEDED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.research_inplay_core_path_observations WHERE physical_event_id = p_row.physical_event_id
                 AND observed_at >= v_day AND observed_at < v_day + interval '1 day') THEN
    SELECT count(DISTINCT physical_event_id) INTO v_events FROM public.research_inplay_core_path_observations
     WHERE observed_at >= v_day AND observed_at < v_day + interval '1 day';
    IF v_events >= 100 THEN RAISE EXCEPTION 'INPLAY_STORAGE_BUDGET_EXCEEDED'; END IF;
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
