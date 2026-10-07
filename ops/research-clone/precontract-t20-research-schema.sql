-- Research clone only (nppznoujvnyjargjkmnv). NEVER apply to production (nbnldzfsxffztsfrrxqy).
-- R2_PRECONTRACT_T20_PRODUCTION_TO_DBCLONE_TRANSPORT_V1: durable scalar copy of production
-- research_precontract_t20_observations (migration 20261007090000). Same persisted column types and the
-- same identity constraint. The production candidate RPC is intentionally NOT created here: the clone needs
-- durable observations, not production event selection.
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
  provider_sport_source        text NULL,

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

-- Sync watermark keyset (observed_at, id).
CREATE INDEX IF NOT EXISTS research_precontract_t20_observations_watermark_idx
  ON public.research_precontract_t20_observations (observed_at, id);
CREATE INDEX IF NOT EXISTS research_precontract_t20_observations_event_start_idx
  ON public.research_precontract_t20_observations (event_start_iso);

ALTER TABLE public.research_precontract_t20_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_precontract_t20_observations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_precontract_t20_observations TO service_role;
