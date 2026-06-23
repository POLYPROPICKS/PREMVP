-- M5 Timing Framework SQL Pack
-- Generated: 2026-06-23
-- ALL QUERIES ARE READ-ONLY. No INSERT/UPDATE/DELETE.
-- Run after first live execution rows exist.

-- ─── 1. Timing bucket distribution from queue ─────────────────────────────────

SELECT
  eq.sport,
  CASE
    WHEN EXTRACT(EPOCH FROM (eq.game_start_iso::timestamptz - eq.queued_at::timestamptz)) / 60 < 30
      THEN 'T_0_30M'
    WHEN EXTRACT(EPOCH FROM (eq.game_start_iso::timestamptz - eq.queued_at::timestamptz)) / 60 < 60
      THEN 'T_30_60M'
    WHEN EXTRACT(EPOCH FROM (eq.game_start_iso::timestamptz - eq.queued_at::timestamptz)) / 60 < 120
      THEN 'T_1_2H'
    WHEN EXTRACT(EPOCH FROM (eq.game_start_iso::timestamptz - eq.queued_at::timestamptz)) / 60 < 360
      THEN 'T_2_6H'
    WHEN eq.queued_at::timestamptz >= eq.game_start_iso::timestamptz
      THEN 'LATE_OR_AFTER'
    ELSE 'T_6H_PLUS'
  END AS timing_bucket,
  eq.market_family,
  count(*) AS n,
  count(CASE WHEN eq.status = 'EXECUTED' THEN 1 END) AS executed,
  count(CASE WHEN eq.status = 'SKIPPED' THEN 1 END) AS skipped
FROM event_execution_queue eq
GROUP BY 1, 2, 3
ORDER BY n DESC;

-- ─── 2. Reservation → queue lead time (how early was event locked) ────────────

SELECT
  r.sport,
  avg(
    EXTRACT(EPOCH FROM (r.game_start_iso::timestamptz - r.reserved_at::timestamptz)) / 3600
  ) AS avg_hours_before_start,
  min(
    EXTRACT(EPOCH FROM (r.game_start_iso::timestamptz - r.reserved_at::timestamptz)) / 3600
  ) AS min_hours,
  max(
    EXTRACT(EPOCH FROM (r.game_start_iso::timestamptz - r.reserved_at::timestamptz)) / 3600
  ) AS max_hours,
  count(*) AS n
FROM night_event_reservations r
WHERE r.reserved_at IS NOT NULL
GROUP BY 1
ORDER BY n DESC;

-- ─── 3. Claim-to-send latency (from mark_history JSONB) ──────────────────────
-- Measures Ireland response speed: how fast does it claim and send?

SELECT
  eq.sport,
  eq.market_family,
  -- claimed_at from mark_history[0]
  (eq.diagnostics->'mark_history'->0->>'marked_at_iso') AS first_mark_iso,
  eq.preferred_entry_iso,
  eq.game_start_iso,
  eq.status
FROM event_execution_queue eq
WHERE eq.diagnostics->'mark_history' IS NOT NULL
  AND jsonb_array_length(eq.diagnostics->'mark_history') > 0
ORDER BY eq.queued_at DESC
LIMIT 100;

-- ─── 4. Execution slippage proxy (preferred vs actual entry time) ─────────────

SELECT
  eq.sport,
  eq.market_family,
  eq.preferred_entry_iso,
  eq.latest_entry_iso,
  eq.game_start_iso,
  -- Minutes between preferred and actual claim (first mark)
  CASE WHEN eq.diagnostics->'mark_history'->0->>'marked_at_iso' IS NOT NULL THEN
    EXTRACT(EPOCH FROM (
      (eq.diagnostics->'mark_history'->0->>'marked_at_iso')::timestamptz
      - eq.preferred_entry_iso::timestamptz
    )) / 60
  END AS minutes_late_from_preferred,
  eq.status
FROM event_execution_queue eq
WHERE eq.status IN ('EXECUTED', 'CLAIMED')
ORDER BY eq.queued_at DESC
LIMIT 100;

-- ─── 5. Queue-to-execution timeline ──────────────────────────────────────────

SELECT
  eq.match_family_key,
  eq.sport,
  eq.market_family,
  eq.queued_at,
  eq.preferred_entry_iso,
  eq.latest_entry_iso,
  eq.game_start_iso,
  eq.status,
  eq.diagnostics->'mark_history'->-1->>'status' AS last_mark_status,
  eq.diagnostics->'mark_history'->-1->>'marked_at_iso' AS last_marked_at
FROM event_execution_queue eq
ORDER BY eq.queued_at DESC
LIMIT 100;
