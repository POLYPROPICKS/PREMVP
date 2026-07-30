-- Broad sports event/market inventory (P0-A — Option B).
-- Captures every confirmed-sports provider event and ALL of its nested
-- markets immediately after discovery, BEFORE the 24h research horizon,
-- odds corridor, two-outcome restriction, groupMarketsByGame/primaryMarket
-- selection, ranking, or product-feed limit run against it.
--
-- This table is inventory only. It carries no eligibility decision and must
-- never be read as a candidate list -- filtering happens downstream, with
-- explicit reason codes, in a later task.
--
-- New table only. No existing table is altered.

CREATE TABLE IF NOT EXISTS public.sports_event_market_inventory (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  provider              text NOT NULL,
  provider_event_id     text NOT NULL,
  provider_event_slug   text NULL,
  provider_market_id    text NOT NULL,
  provider_market_slug  text NULL,

  event_title           text NULL,
  market_question       text NULL,
  event_start_iso       timestamptz NOT NULL,
  market_end_iso        timestamptz NULL,

  condition_id          text NULL,
  clob_token_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcomes              jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome_prices        jsonb NOT NULL DEFAULT '[]'::jsonb,

  provider_tags         jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_category          text NULL,
  league_hint           text NULL,
  sports_market_type    text NULL,

  volume_usd            numeric NULL,
  volume_24hr_usd       numeric NULL,

  sibling_market_count  integer NOT NULL,
  snapshot_run_id       uuid NOT NULL,

  first_observed_at     timestamptz NOT NULL DEFAULT now(),
  last_observed_at      timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,

  -- Occurrence-safe identity: one physical occurrence of one provider market
  -- maps to exactly one row. Never merged, never fuzzy-matched.
  CONSTRAINT uq_seminv_provider_event_market_start
    UNIQUE (provider, provider_event_id, provider_market_id, event_start_iso)
);

-- Bounded indexes for future planning reads only. No planning code reads
-- this table yet -- that repoint is a separate, later task.
CREATE INDEX IF NOT EXISTS idx_seminv_event_start_iso
  ON public.sports_event_market_inventory (event_start_iso);

CREATE INDEX IF NOT EXISTS idx_seminv_provider_event_id
  ON public.sports_event_market_inventory (provider_event_id);

CREATE INDEX IF NOT EXISTS idx_seminv_expires_at
  ON public.sports_event_market_inventory (expires_at);

CREATE INDEX IF NOT EXISTS idx_seminv_condition_id
  ON public.sports_event_market_inventory (condition_id);

-- Enable Row Level Security.
-- No public anon or authenticated policies are added.
-- service_role bypasses RLS by default and retains full write access.
-- This table is never exposed through public API routes or UI.
ALTER TABLE public.sports_event_market_inventory
  ENABLE ROW LEVEL SECURITY;
