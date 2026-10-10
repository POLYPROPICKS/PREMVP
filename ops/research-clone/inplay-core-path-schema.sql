-- INPLAY_CORE_PATH_TELEMETRY_V1. Research facts only; no money-path reader.
CREATE TABLE IF NOT EXISTS public.research_inplay_core_path_observations (
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
  state_clock_seconds_elapsed integer,
  state_received_at timestamptz,
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
-- INPLAY_STATE_FIELDS_V2: additive, applied to an already-created clone table.
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS state_clock_seconds_elapsed integer;
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS state_received_at timestamptz;
CREATE INDEX IF NOT EXISTS research_inplay_core_path_event_time_idx ON public.research_inplay_core_path_observations (physical_event_id, observed_at);
CREATE INDEX IF NOT EXISTS research_inplay_core_path_retention_idx ON public.research_inplay_core_path_observations (observed_at, id);
ALTER TABLE public.research_inplay_core_path_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_inplay_core_path_observations FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_inplay_core_path_observations TO service_role;
