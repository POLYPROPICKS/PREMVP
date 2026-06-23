-- M2 eSports Policy Audit SQL Pack
-- Generated: 2026-06-23
-- ALL QUERIES ARE READ-ONLY. No INSERT/UPDATE/DELETE.
-- Run after ≥10 resolved eSports execution rows exist.

-- ─── 1. eSports event + execution universe ───────────────────────────────────

SELECT
  eq.sport,
  eq.market_family,
  eq.tier,
  count(*) AS total_candidates,
  count(CASE WHEN eq.status = 'EXECUTED' THEN 1 END) AS executed,
  count(CASE WHEN eq.status = 'SKIPPED' THEN 1 END) AS skipped,
  count(CASE WHEN eq.status = 'FAILED' THEN 1 END) AS failed,
  count(CASE WHEN eq.status = 'EXPIRED' THEN 1 END) AS expired,
  avg(eq.score) AS avg_score,
  avg(eq.coverage) AS avg_coverage
FROM event_execution_queue eq
WHERE eq.sport ILIKE '%esport%'
   OR eq.sport ILIKE '%esports%'
   OR eq.sport = 'ESPORT'
GROUP BY 1, 2, 3
ORDER BY total_candidates DESC;

-- ─── 2. eSports profitability by game (from signal corpus) ───────────────────

SELECT
  sp.sport,
  sp.market_family,
  sp.metric_formula_version,
  count(*) AS n,
  avg(sp.score) AS avg_score,
  sum(CASE WHEN sp.resolved_outcome = sp.selected_outcome THEN 1 ELSE 0 END)::float
    / NULLIF(count(CASE WHEN sp.resolved_outcome IS NOT NULL THEN 1 END), 0) AS win_rate,
  sum(CASE WHEN sp.resolved_outcome = sp.selected_outcome
    THEN sp.stake_usd * (sp.selected_price - 1)
    ELSE -sp.stake_usd END) AS net_pnl
FROM generated_signal_pairs sp
WHERE sp.sport ILIKE '%esport%'
   OR sp.sport = 'ESPORT'
GROUP BY 1, 2, 3
HAVING count(*) >= 3
ORDER BY n DESC;

-- ─── 3. eSports timing bucket distribution ───────────────────────────────────

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
WHERE eq.sport ILIKE '%esport%'
   OR eq.sport = 'ESPORT'
GROUP BY 1, 2
ORDER BY n DESC;

-- ─── 4. eSports identity quality distribution ─────────────────────────────────

SELECT
  sp.sport,
  CASE
    WHEN sp.event_slug IS NOT NULL AND sp.event_slug <> '' THEN 'HAS_EVENT_SLUG'
    ELSE 'MISSING_EVENT_SLUG'
  END AS event_slug_status,
  CASE
    WHEN sp.selected_outcome IS NOT NULL THEN 'HAS_OUTCOME'
    ELSE 'MISSING_OUTCOME'
  END AS outcome_status,
  count(*) AS n
FROM generated_signal_pairs sp
WHERE sp.sport ILIKE '%esport%'
   OR sp.sport = 'ESPORT'
GROUP BY 1, 2, 3
ORDER BY n DESC;

-- ─── 5. eSports odds band distribution ───────────────────────────────────────

SELECT
  CASE
    WHEN sp.selected_price < 1.3 THEN 'HEAVY_FAVORITE (<1.3)'
    WHEN sp.selected_price < 1.6 THEN 'MODERATE_FAVORITE (1.3-1.6)'
    WHEN sp.selected_price < 2.0 THEN 'SLIGHT_FAVORITE (1.6-2.0)'
    WHEN sp.selected_price < 3.0 THEN 'UNDERDOG (2.0-3.0)'
    ELSE 'BIG_UNDERDOG (3.0+)'
  END AS odds_band,
  count(*) AS n,
  avg(sp.score) AS avg_score
FROM generated_signal_pairs sp
WHERE sp.sport ILIKE '%esport%'
   OR sp.sport = 'ESPORT'
GROUP BY 1
ORDER BY n DESC;
