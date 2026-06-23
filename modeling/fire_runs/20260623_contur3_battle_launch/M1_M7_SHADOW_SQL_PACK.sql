-- M1–M7 Shadow SQL Pack — Contur3 Battle 2026-06-23
-- READ-ONLY queries. No writes. Defensive style.
-- Run against Supabase (postgres) to gather data for M1–M7 analysis.

-- ─────────────────────────────────────────────────────
-- M1: Unknown/Weak market counts
-- ─────────────────────────────────────────────────────

-- Count market_family labels in queue
SELECT
  market_family,
  COUNT(*) AS cnt,
  COUNT(CASE WHEN status = 'READY' THEN 1 END) AS ready_cnt,
  COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END) AS executed_cnt
FROM event_execution_queue
GROUP BY market_family
ORDER BY cnt DESC;

-- Unknown/null market families
SELECT
  id, match_family_key, event_title, market_slug, market_family, sport, tier, status
FROM event_execution_queue
WHERE market_family IS NULL
   OR LOWER(market_family) IN ('unknown', 'weak', 'other', '')
ORDER BY queued_at DESC
LIMIT 100;

-- Activity label from reservations
SELECT
  sport,
  COUNT(*) AS total,
  COUNT(CASE WHEN status = 'QUEUED' THEN 1 END) AS queued,
  COUNT(CASE WHEN status = 'EXPIRED' THEN 1 END) AS expired,
  COUNT(CASE WHEN status = 'SKIPPED' THEN 1 END) AS skipped
FROM night_event_reservations
WHERE plan_date_minsk >= '2026-06-01'
GROUP BY sport
ORDER BY total DESC;

-- ─────────────────────────────────────────────────────
-- M2: eSports rows
-- ─────────────────────────────────────────────────────

-- eSports in queue
SELECT
  market_family,
  market_slug,
  COUNT(*) AS cnt,
  COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END) AS executed
FROM event_execution_queue
WHERE LOWER(sport) LIKE '%esport%'
   OR LOWER(event_title) LIKE '%esport%'
   OR LOWER(market_slug) LIKE '%esport%'
   OR LOWER(market_family) LIKE '%cs%'
   OR LOWER(market_family) LIKE '%dota%'
   OR LOWER(market_family) LIKE '%lol%'
   OR LOWER(market_family) LIKE '%valorant%'
GROUP BY market_family, market_slug
ORDER BY cnt DESC;

-- eSports reservations
SELECT
  sport, event_title, market_slug, status, game_start_iso
FROM night_event_reservations
WHERE LOWER(sport) LIKE '%esport%'
   OR LOWER(event_title) LIKE '%esport%'
ORDER BY game_start_iso DESC
LIMIT 50;

-- ─────────────────────────────────────────────────────
-- M3: MLB rows
-- ─────────────────────────────────────────────────────

SELECT
  sport, market_family, market_slug,
  COUNT(*) AS cnt,
  COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END) AS executed,
  COUNT(CASE WHEN status = 'SKIPPED' THEN 1 END) AS skipped
FROM event_execution_queue
WHERE LOWER(sport) IN ('baseball', 'mlb')
   OR LOWER(event_title) LIKE '%mlb%'
   OR LOWER(event_title) LIKE '%baseball%'
GROUP BY sport, market_family, market_slug
ORDER BY cnt DESC;

-- Other sports breakdown
SELECT
  COALESCE(sport, 'null') AS sport,
  COUNT(*) AS total_queue,
  COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END) AS executed
FROM event_execution_queue
GROUP BY sport
ORDER BY total_queue DESC;

-- ─────────────────────────────────────────────────────
-- M4: Football market families
-- ─────────────────────────────────────────────────────

SELECT
  market_family,
  market_slug,
  COUNT(*) AS cnt,
  COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END) AS executed,
  COUNT(CASE WHEN status = 'SKIPPED' THEN 1 END) AS skipped
FROM event_execution_queue
WHERE LOWER(sport) IN ('football', 'soccer', 'american_football', 'nfl', 'american-football')
   OR LOWER(event_title) LIKE '%football%'
   OR LOWER(event_title) LIKE '%soccer%'
GROUP BY market_family, market_slug
ORDER BY cnt DESC;

-- Halftime markets (should be 0 after P0E fix)
SELECT
  id, match_family_key, market_slug, market_family, status
FROM event_execution_queue
WHERE LOWER(market_slug) ~ 'halftime|half.time|first.half|1st.half'
   OR LOWER(market_family) ~ 'halftime|half.time|first.half|1st.half';

-- ─────────────────────────────────────────────────────
-- M5: Timing buckets
-- ─────────────────────────────────────────────────────

-- Entry timing relative to game start (only rows with both timestamps)
SELECT
  CASE
    WHEN EXTRACT(EPOCH FROM (game_start_iso::timestamptz - preferred_entry_iso::timestamptz)) / 60 >= 55 THEN 'T-60+'
    WHEN EXTRACT(EPOCH FROM (game_start_iso::timestamptz - preferred_entry_iso::timestamptz)) / 60 >= 40 THEN 'T-45 (40-55m)'
    WHEN EXTRACT(EPOCH FROM (game_start_iso::timestamptz - preferred_entry_iso::timestamptz)) / 60 >= 25 THEN 'T-30 (25-40m)'
    WHEN EXTRACT(EPOCH FROM (game_start_iso::timestamptz - preferred_entry_iso::timestamptz)) / 60 >= 0  THEN 'T-5 (0-25m)'
    ELSE 'LATE'
  END AS timing_bucket,
  COUNT(*) AS cnt,
  COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END) AS executed
FROM event_execution_queue
WHERE preferred_entry_iso IS NOT NULL
  AND game_start_iso IS NOT NULL
GROUP BY 1
ORDER BY 1;

-- ─────────────────────────────────────────────────────
-- M6: Queue-to-outcome linkage
-- ─────────────────────────────────────────────────────

-- Queue rows with mark history (Ireland callback)
SELECT
  q.id,
  q.match_family_key,
  q.plan_run_id,
  q.rebalance_run_id,
  q.status,
  q.condition_id,
  q.order_key,
  q.diagnostics->'mark_history' AS mark_history
FROM event_execution_queue q
WHERE q.status IN ('EXECUTED', 'CLAIMED')
ORDER BY q.queued_at DESC
LIMIT 50;

-- executor_order_events: real live confirms
SELECT
  id, event_type, source, order_status, live_confirm,
  executor_meta->>'order_id' AS order_id,
  executor_meta->>'queue_id' AS queue_id,
  created_at
FROM executor_order_events
WHERE live_confirm = true
ORDER BY created_at DESC
LIMIT 50;

-- ─────────────────────────────────────────────────────
-- M7: Founder report data
-- ─────────────────────────────────────────────────────

-- Night plan summary (most recent plan_run_id)
SELECT
  plan_run_id,
  plan_date_minsk,
  COUNT(*) AS total,
  COUNT(CASE WHEN status = 'QUEUED' THEN 1 END) AS queued,
  COUNT(CASE WHEN status = 'RESERVED' THEN 1 END) AS reserved,
  COUNT(CASE WHEN status = 'EXPIRED' THEN 1 END) AS expired,
  COUNT(CASE WHEN status = 'SKIPPED' THEN 1 END) AS skipped,
  MIN(game_start_iso) AS first_game,
  MAX(game_start_iso) AS last_game
FROM night_event_reservations
WHERE plan_date_minsk >= '2026-06-23'
GROUP BY plan_run_id, plan_date_minsk
ORDER BY plan_date_minsk DESC, plan_run_id DESC
LIMIT 5;

-- Morning execution summary
SELECT
  DATE(queued_at) AS battle_date,
  COUNT(*) AS total_queued,
  COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END) AS executed,
  COUNT(CASE WHEN status = 'SKIPPED' THEN 1 END) AS skipped,
  COUNT(CASE WHEN status = 'FAILED' THEN 1 END) AS failed,
  COUNT(CASE WHEN status = 'EXPIRED' THEN 1 END) AS expired,
  SUM(CASE WHEN status = 'EXECUTED' THEN stake_usd ELSE 0 END) AS total_staked_usd
FROM event_execution_queue
WHERE queued_at >= '2026-06-23 00:00:00+00'
GROUP BY DATE(queued_at)
ORDER BY battle_date DESC;
