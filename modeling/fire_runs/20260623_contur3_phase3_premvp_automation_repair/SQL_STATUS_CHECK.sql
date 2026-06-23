-- SQL_STATUS_CHECK.sql
-- Contur3 Phase 3 — Supabase status queries (read-only)
-- Run in Supabase SQL Editor. No modifications.

-- ── 1. Current plan_run_id rows in night_event_reservations ─────────────────
SELECT
  plan_run_id,
  status,
  COUNT(*) AS cnt,
  MIN(game_start_iso) AS earliest_start,
  MAX(game_start_iso) AS latest_start
FROM night_event_reservations
WHERE plan_run_id LIKE 'night-plan:%'
GROUP BY plan_run_id, status
ORDER BY plan_run_id DESC, status;

-- ── 2. Active future reservations (should have rows ~17:00–08:00 Minsk) ──────
SELECT
  plan_run_id,
  match_family_key,
  event_title,
  game_start_iso,
  status
FROM night_event_reservations
WHERE status IN ('RESERVED', 'REBALANCE_PENDING', 'QUEUED')
  AND game_start_iso > NOW()
ORDER BY game_start_iso ASC;

-- ── 3. event_execution_queue READY rows ──────────────────────────────────────
SELECT
  plan_run_id,
  rebalance_run_id,
  match_family_key,
  side,
  stake_usd,
  tier,
  preferred_entry_iso,
  latest_entry_iso,
  status
FROM event_execution_queue
WHERE status = 'READY'
  AND latest_entry_iso > NOW()
ORDER BY preferred_entry_iso ASC;

-- ── 4. Check for bad market-level keys in reservations ───────────────────────
SELECT
  plan_run_id,
  match_family_key,
  event_title,
  status
FROM night_event_reservations
WHERE
  match_family_key ~* 'halftime|half.time|first.half|1st.half|o/u|over.under|corners|spread|moneyline|goalscorer'
ORDER BY plan_run_id DESC;

-- ── 5. Summary: is current plan expired-only? ────────────────────────────────
WITH current_plan AS (
  SELECT plan_run_id
  FROM night_event_reservations
  ORDER BY reserved_at DESC
  LIMIT 1
),
health AS (
  SELECT
    r.plan_run_id,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE r.status IN ('RESERVED','REBALANCE_PENDING','QUEUED') AND r.game_start_iso::timestamptz > NOW()) AS active_future,
    COUNT(*) FILTER (WHERE r.status = 'EXPIRED') AS expired
  FROM night_event_reservations r
  JOIN current_plan c ON r.plan_run_id = c.plan_run_id
  GROUP BY r.plan_run_id
)
SELECT
  plan_run_id,
  total,
  active_future,
  expired,
  CASE WHEN total > 0 AND active_future = 0 THEN 'YES — NEEDS REBUILD' ELSE 'OK' END AS is_expired_only
FROM health;
