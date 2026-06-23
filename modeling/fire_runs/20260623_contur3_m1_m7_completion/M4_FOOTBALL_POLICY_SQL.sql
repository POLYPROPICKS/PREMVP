-- M4 Football / Soccer Policy SQL Pack
-- Generated: 2026-06-23
-- ALL QUERIES ARE READ-ONLY. No INSERT/UPDATE/DELETE.

-- ─── 1. Football/soccer execution queue by market_family ─────────────────────

SELECT
  eq.sport,
  eq.market_family,
  eq.tier,
  count(*) AS total,
  count(CASE WHEN eq.status = 'EXECUTED' THEN 1 END) AS executed,
  count(CASE WHEN eq.status = 'SKIPPED' THEN 1 END) AS skipped,
  count(CASE WHEN eq.status = 'FAILED' THEN 1 END) AS failed,
  count(CASE WHEN eq.status = 'EXPIRED' THEN 1 END) AS expired,
  avg(eq.score) AS avg_score
FROM event_execution_queue eq
WHERE eq.sport IN ('WC', 'SOCCER')
   OR eq.sport ILIKE '%soccer%'
   OR eq.sport ILIKE '%football%'
GROUP BY 1, 2, 3
ORDER BY total DESC;

-- ─── 2. Halftime / first-half contamination check ────────────────────────────
-- Should return 0 rows if blocking is working correctly.

SELECT
  eq.market_slug,
  eq.market_family,
  eq.sport,
  eq.status,
  eq.queued_at
FROM event_execution_queue eq
WHERE eq.market_slug ILIKE '%halftime%'
   OR eq.market_slug ILIKE '%first-half%'
   OR eq.market_slug ILIKE '%first_half%'
   OR eq.market_slug ILIKE '%ht%'
   OR eq.market_slug ILIKE '%second-half%'
ORDER BY eq.queued_at DESC
LIMIT 50;

-- ─── 3. WC vs general soccer profitability ────────────────────────────────────

SELECT
  CASE
    WHEN sp.event_slug ILIKE 'fifwc%' THEN 'WC'
    WHEN sp.sport = 'WC' THEN 'WC'
    ELSE 'GENERAL_SOCCER'
  END AS soccer_category,
  sp.market_family,
  count(*) AS n,
  count(CASE WHEN sp.resolved_outcome IS NOT NULL THEN 1 END) AS resolved_n,
  sum(CASE WHEN sp.resolved_outcome = sp.selected_outcome THEN 1 ELSE 0 END)::float
    / NULLIF(count(CASE WHEN sp.resolved_outcome IS NOT NULL THEN 1 END), 0) AS win_rate,
  sum(CASE WHEN sp.resolved_outcome = sp.selected_outcome
    THEN sp.stake_usd * (sp.selected_price - 1)
    ELSE -sp.stake_usd END) AS net_pnl
FROM generated_signal_pairs sp
WHERE sp.sport IN ('WC', 'SOCCER')
   OR sp.sport ILIKE '%soccer%'
   OR sp.sport ILIKE '%football%'
   OR sp.event_slug ILIKE 'fifwc%'
GROUP BY 1, 2
ORDER BY n DESC;

-- ─── 4. Single-team weak spread detection ────────────────────────────────────

SELECT
  eq.match_family_key,
  eq.event_slug,
  eq.market_slug,
  eq.market_family,
  eq.sport,
  eq.side,
  eq.token_id,
  eq.condition_id,
  eq.status
FROM event_execution_queue eq
WHERE (eq.market_slug ILIKE '%spread%' OR eq.market_family ILIKE '%spread%')
  AND (eq.event_slug IS NULL OR eq.event_slug = '')
ORDER BY eq.queued_at DESC
LIMIT 50;

-- ─── 5. Football identity quality distribution ────────────────────────────────

SELECT
  CASE
    WHEN sp.event_slug ILIKE 'fifwc%' THEN 'WC_CANONICAL'
    WHEN sp.event_slug IS NOT NULL AND sp.event_slug <> '' THEN 'HAS_SLUG'
    ELSE 'NO_SLUG'
  END AS identity_tier,
  sp.market_family,
  count(*) AS n,
  count(CASE WHEN sp.token_id IS NOT NULL AND sp.token_id <> '' THEN 1 END) AS has_token,
  count(CASE WHEN sp.condition_id IS NOT NULL AND sp.condition_id <> '' THEN 1 END) AS has_condition
FROM generated_signal_pairs sp
WHERE sp.sport IN ('WC', 'SOCCER')
   OR sp.sport ILIKE '%soccer%'
   OR sp.sport ILIKE '%football%'
GROUP BY 1, 2
ORDER BY n DESC;

-- ─── 6. Corners / exact score / goalscorer contamination check ───────────────
-- Should be zero in execution queue; expected only in signal corpus.

SELECT
  'execution_queue' AS table_name,
  count(*) AS rows_with_prop_family
FROM event_execution_queue
WHERE market_slug ILIKE '%corner%'
   OR market_slug ILIKE '%exact%score%'
   OR market_slug ILIKE '%goalscorer%'
   OR market_slug ILIKE '%scorer%'
   OR market_family IN ('corners', 'exact_score', 'goalscorer')

UNION ALL

SELECT
  'signal_corpus' AS table_name,
  count(*) AS rows_with_prop_family
FROM generated_signal_pairs
WHERE market_slug ILIKE '%corner%'
   OR market_slug ILIKE '%exact%score%'
   OR market_slug ILIKE '%goalscorer%'
   OR market_slug ILIKE '%scorer%'
   OR market_family IN ('corners', 'exact_score', 'goalscorer');
