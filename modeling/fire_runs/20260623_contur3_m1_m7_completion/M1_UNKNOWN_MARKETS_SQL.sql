-- M1 Unknown / Weak / Activity Markets SQL Pack
-- Generated: 2026-06-23
-- ALL QUERIES ARE READ-ONLY (SELECT only). Do not run INSERT/UPDATE/DELETE.
-- Run against Supabase prod DB (read replica preferred).

-- ─── 1. Count by warning code / sport / market_family ────────────────────────
-- Uses diagnostics JSONB column on event_execution_queue.
-- Warning codes are stored as keys in diagnostics->>'identity_warning_codes' or
-- as blocking reasons in diagnostics->>'block_reasons' depending on schema version.

SELECT
  d.block_reason,
  eq.sport,
  eq.market_family,
  count(*) AS cnt
FROM event_execution_queue eq
CROSS JOIN LATERAL (
  SELECT jsonb_array_elements_text(
    COALESCE(eq.diagnostics->'block_reasons', '[]'::jsonb)
  ) AS block_reason
) d
GROUP BY 1, 2, 3
ORDER BY cnt DESC;

-- ─── 2. Weak-match-family-key candidates in reservations ─────────────────────
-- Finds reservations where event_slug is missing (forcing condition_id-backed key).

SELECT
  r.plan_run_id,
  r.match_family_key,
  r.event_slug,
  r.event_title,
  r.sport,
  r.game_start_iso,
  r.status,
  r.diagnostics->>'selection_reason' AS selection_reason
FROM night_event_reservations r
WHERE r.event_slug IS NULL
   OR r.event_slug = ''
ORDER BY r.game_start_iso DESC
LIMIT 100;

-- ─── 3. Top 50 potentially recoverable markets ───────────────────────────────
-- Criteria: token_id present, side present, not halftime, weak identity only
-- (no token/condition gap, no activity-label block)

SELECT
  eq.id AS queue_id,
  eq.plan_run_id,
  eq.match_family_key,
  eq.event_slug,
  eq.event_title,
  eq.sport,
  eq.market_slug,
  eq.market_family,
  eq.condition_id,
  eq.token_id,
  eq.side,
  eq.tier,
  eq.stake_usd,
  eq.status,
  eq.diagnostics->>'selection_reason' AS selection_reason
FROM event_execution_queue eq
WHERE eq.token_id IS NOT NULL
  AND eq.token_id <> ''
  AND eq.side IS NOT NULL
  AND eq.side <> ''
  AND eq.condition_id IS NOT NULL
  AND eq.condition_id <> ''
  -- Exclude activity-label blocked (halftime/props hard-blocked)
  AND NOT (
    eq.market_slug ILIKE '%halftime%'
    OR eq.market_slug ILIKE '%first-half%'
    OR eq.market_slug ILIKE '%first_half%'
    OR eq.market_slug ILIKE '%corner%'
    OR eq.market_slug ILIKE '%yellow%'
  )
ORDER BY eq.preferred_entry_iso ASC
LIMIT 50;

-- ─── 4. Activity-label contamination in signal corpus ────────────────────────
-- Identifies rows where activity_label_detected may be contaminating market_slug

SELECT
  sp.market_slug,
  sp.event_slug,
  sp.sport,
  sp.market_family,
  sp.selected_outcome,
  sp.metric_formula_version,
  count(*) AS cnt
FROM generated_signal_pairs sp
WHERE sp.market_slug ILIKE '%halftime%'
   OR sp.market_slug ILIKE '%first-half%'
   OR sp.market_slug ILIKE '%first_half%'
   OR sp.market_slug ILIKE '%corner%'
   OR sp.market_slug ILIKE '%yellow%'
   OR sp.market_slug ILIKE '%player%'
   OR sp.market_slug ILIKE '%scorer%'
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY cnt DESC
LIMIT 100;

-- ─── 5. Markets missing identity fields in most recent plan ──────────────────

SELECT
  eq.match_family_key,
  eq.event_slug,
  eq.sport,
  eq.market_family,
  CASE WHEN eq.token_id IS NULL OR eq.token_id = '' THEN 'MISSING' ELSE 'PRESENT' END AS token_id_status,
  CASE WHEN eq.condition_id IS NULL OR eq.condition_id = '' THEN 'MISSING' ELSE 'PRESENT' END AS condition_id_status,
  CASE WHEN eq.side IS NULL OR eq.side = '' THEN 'MISSING' ELSE 'PRESENT' END AS side_status,
  eq.status
FROM event_execution_queue eq
WHERE eq.token_id IS NULL
   OR eq.token_id = ''
   OR eq.condition_id IS NULL
   OR eq.condition_id = ''
   OR eq.side IS NULL
   OR eq.side = ''
ORDER BY eq.queued_at DESC
LIMIT 100;
