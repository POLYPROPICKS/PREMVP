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

CREATE INDEX IF NOT EXISTS idx_rp_t20_obs_observed_at
  ON public.research_precontract_t20_observations (observed_at);
CREATE INDEX IF NOT EXISTS idx_rp_t20_obs_event_start
  ON public.research_precontract_t20_observations (event_start_iso);

ALTER TABLE public.research_precontract_t20_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_precontract_t20_observations FROM anon, authenticated;

COMMENT ON TABLE public.research_precontract_t20_observations IS
  'PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1. Research-only, observational, pre-Contract-A. One T20 snapshot per physical event (<=100 events/day, <=128 token rows/event). 7-day production retention; bounded purge (<=1000 rows/call). Never authorizes a money-path action.';

-- EVENT-LEVEL daily candidate universe for the research sampler (read-only).
-- Reduces generated_signal_research_snapshots (many raw rows per event, many runs per day) to ONE scalar record per
-- physical event BEFORE anything is returned, so the runtime ranks the COMPLETE daily event universe and never a raw-row
-- slice. Physical grouping mirrors lib/executor/contractADecisions.ts physicalMatchId: provider gameId when present
-- (case-insensitive), else provider eventId, each with the UTC event date. No title/slug and no text sport classifier:
-- only exact structured scalars from diagnostics are read. Only the newest snapshot run per physical event is used.
-- Output is capped at p_ceiling + 1 rows (p_ceiling clamped to 1..900 so the +1 sentinel stays below the PostgREST
-- default 1000-row response cap): more than p_ceiling rows means the runtime must FAIL CLOSED, never silently truncate.
CREATE OR REPLACE FUNCTION public.research_precontract_t20_event_candidates(
  p_from    timestamptz,
  p_to      timestamptz,
  p_ceiling integer DEFAULT 800
)
RETURNS TABLE (
  provider_event_id        text,
  provider_game_id         text,
  event_start_iso          timestamptz,
  snapshot_run_id          uuid,
  snapshot_at              timestamptz,
  source_row_n             bigint,
  provider_sport_family    text,
  provider_sport_family_n  bigint,
  provider_sport_code      text,
  provider_sport_code_n    bigint,
  provider_sport_source    text,
  provider_sport_source_n  bigint,
  parent_event_volume_24h  numeric,
  volume_contradiction     boolean
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH src AS (
    SELECT
      g.snapshot_run_id,
      g.snapshot_at,
      g.game_start_iso AS start_at,
      NULLIF(btrim(g.diagnostics -> 'providerEventContext' ->> 'eventId'), '') AS event_id,
      NULLIF(btrim(g.diagnostics -> 'providerEventContext' ->> 'gameId'), '')  AS game_id,
      CASE WHEN btrim(g.diagnostics ->> 'parentEventVolume24hr') ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]{1,3})?$'
           THEN btrim(g.diagnostics ->> 'parentEventVolume24hr')::numeric END AS vol,
      NULLIF(lower(btrim(g.diagnostics ->> 'providerSportFamily')), '') AS fam,
      NULLIF(btrim(g.diagnostics ->> 'providerSportCode'), '')   AS code,
      NULLIF(btrim(g.diagnostics ->> 'providerSportSource'), '') AS src_kind
    FROM public.generated_signal_research_snapshots g
    WHERE g.game_start_iso >= p_from AND g.game_start_iso < p_to
  ),
  keyed AS (
    SELECT s.*,
      CASE WHEN s.game_id IS NOT NULL THEN 'g:' || lower(s.game_id) ELSE 'e:' || lower(s.event_id) END
        || '|' || to_char(s.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS physical_key
    FROM src s
    WHERE s.event_id IS NOT NULL
  ),
  latest AS (
    SELECT DISTINCT ON (k.physical_key) k.physical_key, k.snapshot_run_id, k.snapshot_at
    FROM keyed k
    ORDER BY k.physical_key, k.snapshot_at DESC, k.snapshot_run_id DESC
  ),
  agg AS (
    SELECT
      min(k.event_id)  AS provider_event_id,
      min(k.game_id)   AS provider_game_id,
      min(k.start_at)  AS event_start_iso,
      l.snapshot_run_id,
      l.snapshot_at,
      count(*)         AS source_row_n,
      min(k.fam)       AS provider_sport_family,
      count(DISTINCT k.fam)      AS provider_sport_family_n,
      min(k.code)      AS provider_sport_code,
      count(DISTINCT k.code)     AS provider_sport_code_n,
      min(k.src_kind)  AS provider_sport_source,
      count(DISTINCT k.src_kind) AS provider_sport_source_n,
      CASE WHEN count(DISTINCT k.vol) = 1 THEN min(k.vol) END AS parent_event_volume_24h,
      count(DISTINCT k.vol) > 1  AS volume_contradiction,
      k.physical_key
    FROM keyed k
    JOIN latest l ON l.physical_key = k.physical_key AND l.snapshot_run_id = k.snapshot_run_id
    GROUP BY k.physical_key, l.snapshot_run_id, l.snapshot_at
  )
  SELECT a.provider_event_id, a.provider_game_id, a.event_start_iso, a.snapshot_run_id, a.snapshot_at, a.source_row_n,
         a.provider_sport_family, a.provider_sport_family_n, a.provider_sport_code, a.provider_sport_code_n,
         a.provider_sport_source, a.provider_sport_source_n, a.parent_event_volume_24h, a.volume_contradiction
  FROM agg a
  ORDER BY a.parent_event_volume_24h DESC NULLS LAST, a.event_start_iso ASC, a.physical_key ASC
  LIMIT least(greatest(p_ceiling, 1), 900) + 1;
$$;

REVOKE ALL ON FUNCTION public.research_precontract_t20_event_candidates(timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_precontract_t20_event_candidates(timestamptz, timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.research_precontract_t20_event_candidates(timestamptz, timestamptz, integer) IS
  'PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1. Read-only event-level aggregation of generated_signal_research_snapshots (one row per physical event, newest run). Output capped at p_ceiling+1 (<=901) rows; the runtime fails closed above p_ceiling.';
