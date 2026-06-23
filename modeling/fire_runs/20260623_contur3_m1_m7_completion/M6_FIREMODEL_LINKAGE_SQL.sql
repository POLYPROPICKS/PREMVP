-- M6 FireModel Linkage SQL Pack
-- Generated: 2026-06-23
-- ALL QUERIES ARE READ-ONLY. No INSERT/UPDATE/DELETE.
-- Parameterize :plan_run_id with the actual plan_run_id from tonight's reservation.

-- ─── 1. Full linkage chain for a given plan_run_id ────────────────────────────

SELECT
  r.id                                                    AS reservation_id,
  r.plan_run_id,
  r.match_family_key,
  r.sport,
  r.event_slug,
  r.event_title,
  r.game_start_iso,
  r.status                                                AS reservation_status,
  eq.id                                                   AS queue_id,
  eq.rebalance_run_id,
  eq.order_key,
  eq.idempotency_key,
  eq.condition_id,
  eq.token_id,
  eq.side,
  eq.stake_usd,
  eq.market_family,
  eq.market_slug,
  eq.tier,
  eq.score,
  eq.preferred_entry_iso,
  eq.latest_entry_iso,
  eq.status                                               AS queue_status,
  eq.diagnostics->'mark_history'->-1->>'status'          AS last_mark_status,
  eq.diagnostics->'mark_history'->-1->>'polymarket_order_id' AS polymarket_order_id,
  eq.diagnostics->'mark_history'->-1->>'tx_hash'         AS tx_hash,
  eq.diagnostics->'mark_history'->-1->>'marked_at_iso'   AS last_marked_at,
  sp.signal_id,
  sp.metric_formula_version,
  sp.resolved_outcome,
  sp.selected_outcome,
  sp.selected_price
FROM night_event_reservations r
LEFT JOIN event_execution_queue eq
  ON eq.plan_run_id = r.plan_run_id
  AND eq.match_family_key = r.match_family_key
LEFT JOIN generated_signal_pairs sp
  ON sp.condition_id = eq.condition_id
  AND sp.token_id = eq.token_id
-- WHERE r.plan_run_id = 'night-plan:2026-06-23:1700-minsk'
ORDER BY r.game_start_iso;

-- ─── 2. Execution queue mark_history audit ────────────────────────────────────

SELECT
  eq.id AS queue_id,
  eq.match_family_key,
  eq.sport,
  eq.order_key,
  eq.status,
  jsonb_array_elements(eq.diagnostics->'mark_history') AS mark_event
FROM event_execution_queue eq
WHERE eq.diagnostics->'mark_history' IS NOT NULL
  AND jsonb_array_length(eq.diagnostics->'mark_history') > 0
ORDER BY eq.queued_at DESC
LIMIT 100;

-- ─── 3. Realized PnL proxy (using signal corpus resolved_outcome) ─────────────
-- Only meaningful after resolved_outcome is populated in signal corpus.

SELECT
  eq.plan_run_id,
  eq.sport,
  eq.market_family,
  eq.stake_usd,
  eq.status AS execution_status,
  sp.selected_outcome,
  sp.resolved_outcome,
  sp.selected_price,
  CASE
    WHEN sp.resolved_outcome = sp.selected_outcome
      THEN eq.stake_usd * (sp.selected_price - 1)
    WHEN sp.resolved_outcome IS NOT NULL
      THEN -eq.stake_usd
    ELSE NULL
  END AS realized_pnl_usd
FROM event_execution_queue eq
LEFT JOIN generated_signal_pairs sp
  ON sp.condition_id = eq.condition_id
  AND sp.token_id = eq.token_id
WHERE eq.status = 'EXECUTED'
ORDER BY eq.queued_at DESC;

-- ─── 4. Orphaned queue rows (no matching reservation) ────────────────────────

SELECT
  eq.id AS queue_id,
  eq.plan_run_id,
  eq.match_family_key,
  eq.status,
  eq.queued_at
FROM event_execution_queue eq
LEFT JOIN night_event_reservations r
  ON r.plan_run_id = eq.plan_run_id
  AND r.match_family_key = eq.match_family_key
WHERE r.id IS NULL
ORDER BY eq.queued_at DESC
LIMIT 50;

-- ─── 5. Reserved events with no queue row (rebalance missed them) ─────────────

SELECT
  r.id AS reservation_id,
  r.plan_run_id,
  r.match_family_key,
  r.sport,
  r.game_start_iso,
  r.status AS reservation_status
FROM night_event_reservations r
LEFT JOIN event_execution_queue eq
  ON eq.plan_run_id = r.plan_run_id
  AND eq.match_family_key = r.match_family_key
WHERE eq.id IS NULL
  AND r.status IN ('RESERVED', 'REBALANCE_PENDING')
ORDER BY r.game_start_iso DESC
LIMIT 50;
