-- PREMVP_APPLICATION_MIGRATION_V1
-- T10_DISCOVERY_AUDIT_AND_TOTAL_CORNERS_PROOF_V1: bounded pre-filter same-game
-- provider discovery audit (compact counts/classifications only, no raw payloads).
-- Nullable: historical capture runs are not backfilled and keep NULL.
ALTER TABLE public.reservation_market_capture_runs
  ADD COLUMN IF NOT EXISTS discovery_audit_v1 jsonb;

ALTER TABLE public.reservation_market_capture_runs
  DROP CONSTRAINT IF EXISTS reservation_market_capture_runs_discovery_audit_v1_object_check;
ALTER TABLE public.reservation_market_capture_runs
  ADD CONSTRAINT reservation_market_capture_runs_discovery_audit_v1_object_check
  CHECK (discovery_audit_v1 IS NULL OR jsonb_typeof(discovery_audit_v1) = 'object');
