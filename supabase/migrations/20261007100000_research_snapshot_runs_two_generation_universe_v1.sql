-- PREMVP_APPLICATION_MIGRATION_V1
-- R1_TWO_COMPLETE_GENERATION_EVENT_UNIVERSE_V1: bound the T20 event universe to the TWO most recent COMPLETED research
-- snapshot generations. A generation is "completed" only when the producer wrote its durable marker AFTER every GSRS chunk
-- persisted. Fewer than two completed runs -> the RPC returns ZERO candidates (fail closed, no daily-history fallback).
-- Research authority only: never authorizes Contract A / Reservation / Queue / execution.

CREATE TABLE IF NOT EXISTS public.research_snapshot_runs (
  snapshot_run_id uuid PRIMARY KEY,
  snapshot_at     timestamptz NOT NULL,
  completed_at    timestamptz NOT NULL DEFAULT now(),
  row_count       integer NOT NULL CHECK (row_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_research_snapshot_runs_recent
  ON public.research_snapshot_runs (completed_at DESC, snapshot_at DESC, snapshot_run_id DESC);

ALTER TABLE public.research_snapshot_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_snapshot_runs FROM anon, authenticated;
GRANT SELECT, INSERT ON public.research_snapshot_runs TO service_role;

COMMENT ON TABLE public.research_snapshot_runs IS
  'R1_TWO_COMPLETE_GENERATION_EVENT_UNIVERSE_V1. Durable marker that a research snapshot generation finished persisting every GSRS chunk. Research freshness authority only; never authorizes a money-path action. Insert-only (no UPDATE/DELETE path).';

-- Same signature and return columns as 20261007090000; ONLY the freshness predicate changes.
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
  run_gate AS (
    SELECT count(*) = 2 AS ok FROM completed_runs
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
    WHERE g.snapshot_run_id IN (SELECT c.snapshot_run_id FROM completed_runs c)
      AND (SELECT ok FROM run_gate)
      AND g.game_start_iso >= p_from AND g.game_start_iso < p_to
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

REVOKE ALL ON FUNCTION public.research_precontract_t20_event_candidates(timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_precontract_t20_event_candidates(timestamptz, timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.research_precontract_t20_event_candidates(timestamptz, timestamptz, integer) IS
  'R1_TWO_COMPLETE_GENERATION_EVENT_UNIVERSE_V1. Read-only event-level aggregation of generated_signal_research_snapshots restricted to the two most recent completed research snapshot runs (exactly two required, else zero rows); one row per physical event, newest snapshot_at within that window. Output capped at p_ceiling+1 (<=901) rows; the runtime fails closed above p_ceiling.';
