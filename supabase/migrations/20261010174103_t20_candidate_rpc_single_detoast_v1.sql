-- PREMVP_APPLICATION_MIGRATION_V1
-- T20_CANDIDATE_RPC_SINGLE_DETOAST_V1: performance-only rewrite of how research_precontract_t20_event_candidates reads
-- generated_signal_research_snapshots.diagnostics. Production EXPLAIN ANALYZE of the RPC: 12634.821 ms (T20 hard deadline 8000 ms).
-- Cause: the src CTE evaluated 7 jsonb accessors (->, ->>) directly on the TOASTed diagnostics column. PostgreSQL detoasts and
-- decompresses the whole document once per accessor call, i.e. 7x per source row, for every row of the two current generations.
-- Fix: materialize the detoasted document once per row (g.diagnostics || '{}'::jsonb, fenced with OFFSET 0 so the planner cannot
-- inline it back into each accessor) and read all 7 scalars from that in-memory copy. '|| {}' returns an object unchanged and
-- makes non-object documents (scalar, array, null) yield NULL accessors, exactly like the previous direct accessors.
-- Unchanged: signature, return columns, filters (game_start_iso range, two completed runs, count = 2 fail-closed gate), physical
-- key, newest-snapshot selection, aggregation, volume/contradiction rules, ORDER BY, p_ceiling clamp and +1 sentinel, grants.
-- No index, no table change, no data change. Research-only: no Contract A / Reservation / Queue / stake / execution / Ireland authority.

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
      NULLIF(btrim(x.d -> 'providerEventContext' ->> 'eventId'), '') AS event_id,
      NULLIF(btrim(x.d -> 'providerEventContext' ->> 'gameId'), '')  AS game_id,
      CASE WHEN btrim(x.d ->> 'parentEventVolume24hr') ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]{1,3})?$'
           THEN btrim(x.d ->> 'parentEventVolume24hr')::numeric END AS vol,
      NULLIF(lower(btrim(x.d ->> 'providerSportFamily')), '') AS fam,
      NULLIF(btrim(x.d ->> 'providerSportCode'), '')   AS code,
      NULLIF(btrim(x.d ->> 'providerSportSource'), '') AS src_kind
    FROM public.generated_signal_research_snapshots g
    CROSS JOIN LATERAL (SELECT g.diagnostics || '{}'::jsonb AS d OFFSET 0) x
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
