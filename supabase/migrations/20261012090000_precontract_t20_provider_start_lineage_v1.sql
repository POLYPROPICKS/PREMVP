-- PREMVP_APPLICATION_MIGRATION_V1
-- TELEMETRY-08C / PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1: three additive nullable columns holding the VERIFIED CURRENT
-- provider start that decided the ACTUAL T20 window of a captured event, beside the immutable snapshot start. event_start_iso,
-- physical_event_id and source_id keep the snapshot lineage unchanged. No backfill (history stays NULL), no new index, no RPC
-- change, no change to caps, retention, the identity constraint or the deterministic row id. 3 nullable columns: <= 24 bytes
-- fixed-width data per row (<= 100 events/day x <= 128 rows, 7-day retention unchanged).
ALTER TABLE public.research_precontract_t20_observations ADD COLUMN IF NOT EXISTS provider_start_iso timestamptz;
ALTER TABLE public.research_precontract_t20_observations ADD COLUMN IF NOT EXISTS provider_start_acquired_at timestamptz;
ALTER TABLE public.research_precontract_t20_observations ADD COLUMN IF NOT EXISTS provider_start_source text;
COMMENT ON COLUMN public.research_precontract_t20_observations.provider_start_iso IS
  'Gamma''s CURRENT event start (event.startTime, fetched by exact persisted provider event id) at capture time. event_start_iso stays the immutable snapshot start. NULL for rows before TELEMETRY-08C.';
COMMENT ON COLUMN public.research_precontract_t20_observations.provider_start_acquired_at IS
  'Collector wall clock taken BEFORE the Gamma request that returned provider_start_iso (conservative freshness bound; <= 90s before the T20 decision).';
COMMENT ON COLUMN public.research_precontract_t20_observations.provider_start_source IS
  'Authority of provider_start_iso: gamma_events_batch:startTime, or gamma_events_batch:endDate_legacy_match when Gamma states no startTime and its endDate equals the snapshot start.';
