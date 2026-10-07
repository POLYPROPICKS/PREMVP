-- PREMVP_APPLICATION_MIGRATION_V1
-- PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1: ONE research-only carrier for a single T20 snapshot of at most
-- 100 high-liquidity physical sporting events per day, captured BEFORE Contract A / Reservation selection.
-- Independent of night_event_reservations: no reservation_id, no fake Reservation, no change to the reservation_*
-- tables. Scalar evidence only (no raw provider JSON, no raw orderbook JSON, no diagnostics blobs).
-- Observational only: nothing in Contract A, Reservation, rebalance, Queue, stake, execution or Ireland reads it.
-- Production storage is bounded: <=100 events/day x <=128 token rows/event, 7-day retention, bounded purge.

CREATE TABLE IF NOT EXISTS public.research_precontract_t20_observations (
  id                           uuid PRIMARY KEY,
  physical_event_id            text NOT NULL,
  provider_game_id             text NULL,
  provider_event_id            text NULL,
  source_id                    text NOT NULL,
  source_version               text NOT NULL,
  event_start_iso              timestamptz NOT NULL,
  observed_at                  timestamptz NOT NULL,
  observation_phase            text NOT NULL,

  parent_event_volume_24h      numeric NULL,
  daily_volume_rank            integer NULL,
  sampling_bucket              text NULL,
  provider_sport_family        text NULL,
  provider_sport_code          text NULL,

  condition_id                 text NOT NULL,
  token_id                     text NOT NULL,
  side                         text NOT NULL,

  canonical_market_family      text NULL,
  canonical_market_type        text NULL,
  provider_market_type_raw     text NULL,
  market_slug                  text NULL,

  best_bid                     numeric NULL,
  best_ask                     numeric NULL,
  tick_size                    numeric NULL,
  minimum_order_size           numeric NULL,
  orderbook_fetch_status       text NULL,

  requested_stake_usd          numeric NULL,
  execution_price_cap          numeric NULL,
  ask_depth_relevant_usd       numeric NULL,
  full_stake_executable_vwap   numeric NULL,
  full_stake_shares            numeric NULL,
  executable_full_stake        boolean NULL,
  executable_full_stake_state  text NULL,

  taker_fee_state              text NULL,
  taker_fee_usd                numeric NULL,

  CONSTRAINT uq_rp_t20_obs_identity UNIQUE (physical_event_id, condition_id, token_id, side)
);

CREATE INDEX IF NOT EXISTS idx_rp_t20_obs_observed_at
  ON public.research_precontract_t20_observations (observed_at);
CREATE INDEX IF NOT EXISTS idx_rp_t20_obs_event_start
  ON public.research_precontract_t20_observations (event_start_iso);

ALTER TABLE public.research_precontract_t20_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_precontract_t20_observations FROM anon, authenticated;

COMMENT ON TABLE public.research_precontract_t20_observations IS
  'PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1. Research-only, observational, pre-Contract-A. One T20 snapshot per physical event (<=100 events/day, <=128 token rows/event). 7-day production retention; bounded purge (<=1000 rows/call). Never authorizes a money-path action.';
