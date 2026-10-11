-- pg-delta: transaction=false
-- PREMVP_APPLICATION_MIGRATION_V1

-- MISSION T20-01 / PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1: early source restriction for
-- public.research_precontract_t20_event_candidates. The RPC only ever reads rows that carry a structured
-- providerEventContext.eventId (about 1-2% of each generation) from the latest two completed runs on one UTC game day.
-- This partial index lets the planner seek exactly those rows (run id + game_start_iso range) instead of heap-reading
-- and discarding every other row of both generations. Index only; no business semantics, no RPC change. The predicate is
-- the exact expression the RPC's `keyed` filter already applies (20261007174425_..._two_generation_freshness_v1.sql), so
-- the planner can prove the implication; if the RPC's eventId expression ever changes, this predicate must change with it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gsrs_t20_event_candidates
  ON public.generated_signal_research_snapshots (snapshot_run_id, game_start_iso)
  WHERE NULLIF(btrim(diagnostics -> 'providerEventContext' ->> 'eventId'), '') IS NOT NULL;
