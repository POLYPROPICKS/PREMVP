-- PREMVP_APPLICATION_MIGRATION_V1
-- R1_TWO_COMPLETE_RESEARCH_GENERATIONS_FRESHNESS_V1: bounded freshness authority for the T20 research event universe.
-- (1) public.research_snapshot_runs: durable completion marker, one row per research snapshot run, written by the producer
--     ONLY after every snapshot chunk of that run persisted (row_count = 0 is a legitimate completed run).
-- (2) research_precontract_t20_event_candidates now reads ONLY the latest two completed runs and returns zero rows
--     while fewer than two completed runs exist (fail closed, no historical fallback, no age threshold, no backfill).
-- Research-only: no Contract A / Reservation / Queue / stake / execution / Ireland authority. Insert-only table.

CREATE TABLE IF NOT EXISTS public.research_snapshot_runs (
  snapshot_run_id uuid PRIMARY KEY,
  snapshot_at     timestamptz NOT NULL,
  completed_at    timestamptz NOT NULL DEFAULT now(),
  row_count       integer NOT NULL CHECK (row_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_research_snapshot_runs_completed
  ON public.research_snapshot_runs (completed_at DESC, snapshot_at DESC, snapshot_run_id DESC);

ALTER TABLE public.research_snapshot_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_snapshot_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.research_snapshot_runs TO service_role;

COMMENT ON TABLE public.research_snapshot_runs IS
  'R1 freshness authority. One row per research snapshot generation whose snapshot chunks were ALL persisted. Insert-only; no raw payload.';

-- Freshness authority: LATEST TWO completed generations (completed_at DESC, snapshot_at DESC, snapshot_run_id DESC).
-- Fewer than two completed generations -> zero candidates. Source rows are restricted to those two run ids BEFORE the
-- per-event newest-snapshot selection, so an event present only in an older generation can never appear.

-- EVENT-LEVEL daily candidate universe for the research sampler (read-only).
-- Reduces generated_signal_research_snapshots (many raw rows per event, many runs per day) to ONE scalar record per
-- physical event BEFORE anything is returned, so the runtime ranks the COMPLETE daily event universe and never a raw-row
-- slice. Physical grouping mirrors lib/executor/contractADecisions.ts physicalMatchId: provider gameId when present
-- (case-insensitive), else provider eventId, each with the UTC event date. No title/slug and no text sport classifier:
-- only exact structured scalars from diagnostics are read. Only the newest snapshot run per physical event is used.
-- Output is capped at p_ceiling + 1 rows (p_ceiling clamped to 1..900 so the +1 sentinel stays below the PostgREST
-- default 1000-row response cap): more than p_ceiling rows means the runtime must FAIL CLOSED, never silently cut the list off.
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
  WITH completed_runs AS (
    SELECT r.snapshot_run_id
    FROM public.research_snapshot_runs r
    ORDER BY r.completed_at DESC, r.snapshot_at DESC, r.snapshot_run_id DESC
    LIMIT 2
  ),
  src AS (
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
      AND (SELECT count(*) FROM completed_runs) = 2
      AND g.snapshot_run_id IN (SELECT c.snapshot_run_id FROM completed_runs c)
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
  'PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1. Read-only event-level aggregation of generated_signal_research_snapshots (one row per physical event, newest snapshot within the latest two completed runs). Output capped at p_ceiling+1 (<=901) rows; the runtime fails closed above p_ceiling.';
