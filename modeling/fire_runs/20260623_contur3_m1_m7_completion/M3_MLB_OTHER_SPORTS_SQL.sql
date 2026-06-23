-- M3 MLB / Other Sports Profitability SQL Pack
-- Generated: 2026-06-23
-- ALL QUERIES ARE READ-ONLY. No INSERT/UPDATE/DELETE.

-- ─── 1. Non-soccer/non-esports sports universe in execution queue ─────────────

SELECT
  eq.sport,
  eq.market_family,
  eq.tier,
  count(*) AS total,
  count(CASE WHEN eq.status = 'EXECUTED' THEN 1 END) AS executed,
  count(CASE WHEN eq.status = 'SKIPPED' THEN 1 END) AS skipped,
  avg(eq.score) AS avg_score,
  avg(eq.stake_usd) AS avg_stake
FROM event_execution_queue eq
WHERE eq.sport NOT IN ('WC', 'SOCCER', 'ESPORT')
  AND eq.sport NOT ILIKE '%soccer%'
  AND eq.sport NOT ILIKE '%football%'
  AND eq.sport NOT ILIKE '%esport%'
GROUP BY 1, 2, 3
ORDER BY total DESC;

-- ─── 2. MLB profitability from signal corpus ──────────────────────────────────

SELECT
  sp.sport,
  sp.market_family,
  count(*) AS n,
  count(CASE WHEN sp.resolved_outcome IS NOT NULL THEN 1 END) AS resolved_n,
  sum(CASE WHEN sp.resolved_outcome = sp.selected_outcome THEN 1 ELSE 0 END)::float
    / NULLIF(count(CASE WHEN sp.resolved_outcome IS NOT NULL THEN 1 END), 0) AS win_rate,
  sum(CASE WHEN sp.resolved_outcome = sp.selected_outcome
    THEN sp.stake_usd * (sp.selected_price - 1)
    ELSE -sp.stake_usd END) AS net_pnl,
  avg(sp.score) AS avg_score,
  avg(sp.coverage) AS avg_coverage
FROM generated_signal_pairs sp
WHERE sp.sport ILIKE '%baseball%'
   OR sp.sport ILIKE '%mlb%'
GROUP BY 1, 2
ORDER BY n DESC;

-- ─── 3. Other sports profitability (non-WC/soccer/esport/baseball) ────────────

SELECT
  sp.sport,
  sp.market_family,
  count(*) AS n,
  count(CASE WHEN sp.resolved_outcome IS NOT NULL THEN 1 END) AS resolved_n,
  sum(CASE WHEN sp.resolved_outcome = sp.selected_outcome THEN 1 ELSE 0 END)::float
    / NULLIF(count(CASE WHEN sp.resolved_outcome IS NOT NULL THEN 1 END), 0) AS win_rate,
  sum(CASE WHEN sp.resolved_outcome = sp.selected_outcome
    THEN sp.stake_usd * (sp.selected_price - 1)
    ELSE -sp.stake_usd END) AS net_pnl
FROM generated_signal_pairs sp
WHERE sp.sport NOT IN ('WC', 'SOCCER', 'ESPORT')
  AND sp.sport NOT ILIKE '%soccer%'
  AND sp.sport NOT ILIKE '%football%'
  AND sp.sport NOT ILIKE '%esport%'
  AND sp.sport NOT ILIKE '%baseball%'
  AND sp.sport NOT ILIKE '%mlb%'
GROUP BY 1, 2
HAVING count(*) >= 3
ORDER BY n DESC;

-- ─── 4. Timing bucket by sport ────────────────────────────────────────────────

SELECT
  eq.sport,
  CASE
    WHEN EXTRACT(EPOCH FROM (eq.game_start_iso::timestamptz - eq.queued_at::timestamptz)) / 60 < 30 THEN 'T_0_30M'
    WHEN EXTRACT(EPOCH FROM (eq.game_start_iso::timestamptz - eq.queued_at::timestamptz)) / 60 < 60 THEN 'T_30_60M'
    WHEN EXTRACT(EPOCH FROM (eq.game_start_iso::timestamptz - eq.queued_at::timestamptz)) / 60 < 120 THEN 'T_1_2H'
    WHEN EXTRACT(EPOCH FROM (eq.game_start_iso::timestamptz - eq.queued_at::timestamptz)) / 60 < 360 THEN 'T_2_6H'
    ELSE 'T_6H_PLUS'
  END AS timing_bucket,
  count(*) AS n
FROM event_execution_queue eq
WHERE eq.sport NOT IN ('WC', 'SOCCER', 'ESPORT')
GROUP BY 1, 2
ORDER BY eq.sport, n DESC;

-- ─── 5. Identity quality by sport (signal corpus) ────────────────────────────

SELECT
  sp.sport,
  CASE
    WHEN sp.event_slug IS NOT NULL AND sp.event_slug <> '' THEN 'HAS_EVENT_SLUG'
    ELSE 'MISSING_EVENT_SLUG'
  END AS identity_status,
  CASE
    WHEN sp.token_id IS NOT NULL AND sp.token_id <> '' THEN 'HAS_TOKEN'
    ELSE 'MISSING_TOKEN'
  END AS token_status,
  count(*) AS n
FROM generated_signal_pairs sp
WHERE sp.sport NOT IN ('WC', 'SOCCER', 'ESPORT')
GROUP BY 1, 2, 3
ORDER BY n DESC;

-- ─── 6. One-per-fixture audit (execution queue) ───────────────────────────────
-- Confirms PREMVP rebalance writes at most one READY row per match_family_key.

SELECT
  match_family_key,
  count(*) AS queue_rows,
  count(CASE WHEN status = 'READY' THEN 1 END) AS ready_count
FROM event_execution_queue
GROUP BY match_family_key
HAVING count(*) > 1
ORDER BY queue_rows DESC
LIMIT 50;
