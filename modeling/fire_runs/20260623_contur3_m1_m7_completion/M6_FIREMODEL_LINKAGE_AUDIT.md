# M6 — FireModel Linkage Audit

Generated: 2026-06-23. No production changes made.

---

## Purpose

Ensure future reports can link model_id/run_id/queue/execution/outcome in a single chain.
Founders must be able to trace: FireModel run → reservation → queue → Ireland execution → Polymarket outcome.

---

## Linkage Chain

```
generated_signal_pairs (signal_id, metric_formula_version, plan_run_id)
    ↓  match on plan_run_id
night_event_reservations (id=reservation_id, plan_run_id, match_family_key, event_slug)
    ↓  match on reservation_id or match_family_key
event_execution_queue (id=queue_id, reservation_id, plan_run_id, rebalance_run_id, order_key)
    ↓  match on queue_id
executor_order_events / executor_audit_events (if exists)
    ↓  mark_history in diagnostics JSONB (CLAIMED→EXECUTED, polymarket_order_id)
Polymarket resolution (condition_id → resolved_outcome)
```

---

## Field Availability by Table

| Field | night_event_reservations | event_execution_queue | generated_signal_pairs |
|---|---|---|---|
| plan_run_id | ✅ | ✅ | ✅ (via reservation join) |
| reservation_id | ✅ (id) | ✅ | ✗ (join via plan_run_id + match_family_key) |
| queue_id | ✗ | ✅ (id) | ✗ |
| rebalance_run_id | ✗ | ✅ | ✗ |
| order_key | ✗ | ✅ | ✗ |
| idempotency_key | ✗ | ✅ | ✗ |
| condition_id | ✗ | ✅ | ✅ |
| token_id | ✗ | ✅ | ✅ |
| side | ✗ | ✅ | ✅ |
| stake_usd | ✗ | ✅ | ✅ |
| execution status | ✗ | ✅ (status) | ✗ |
| polymarket_order_id | ✗ | ✅ (in diagnostics JSONB) | ✗ |
| tx_hash | ✗ | ✅ (in diagnostics JSONB) | ✗ |
| resolved_outcome | ✗ | ✗ (**SCHEMA_GAP**) | ✅ (if resolved) |
| realized_pnl_usd | ✗ | ✗ (**SCHEMA_GAP**) | ✅ (calculable) |
| metric_formula_version | ✗ | ✗ | ✅ |

---

## Schema Gaps (Append-Only Proposals — Do Not Apply)

```sql
-- Resolve linkage gap: add resolved outcome to queue table
-- Run only after explicit founder approval + Supabase migration PR

ALTER TABLE event_execution_queue
  ADD COLUMN IF NOT EXISTS resolved_outcome text,
  ADD COLUMN IF NOT EXISTS resolved_at_iso timestamptz,
  ADD COLUMN IF NOT EXISTS realized_pnl_usd numeric(10,4),
  ADD COLUMN IF NOT EXISTS polymarket_resolution_confirmed boolean DEFAULT false;
```

**Do not apply without Supabase migration PR review.**

---

## Current Linkage Join (No Migration Needed)

The following join works today without schema changes:

```sql
SELECT
  sp.signal_id,
  sp.metric_formula_version,
  r.id AS reservation_id,
  r.plan_run_id,
  r.match_family_key,
  r.sport,
  r.game_start_iso,
  eq.id AS queue_id,
  eq.rebalance_run_id,
  eq.order_key,
  eq.condition_id,
  eq.token_id,
  eq.side,
  eq.stake_usd,
  eq.status AS execution_status,
  eq.diagnostics->'mark_history'->-1->>'status' AS last_mark_status,
  eq.diagnostics->'mark_history'->-1->>'polymarket_order_id' AS polymarket_order_id,
  sp.resolved_outcome
FROM night_event_reservations r
JOIN event_execution_queue eq
  ON eq.reservation_id = r.id
  OR (eq.plan_run_id = r.plan_run_id AND eq.match_family_key = r.match_family_key)
LEFT JOIN generated_signal_pairs sp
  ON sp.condition_id = eq.condition_id
  AND sp.token_id = eq.token_id
WHERE r.plan_run_id = :plan_run_id
ORDER BY r.game_start_iso;
```

---

## What Founder Can See Now (Pre-Live)

- Which events were reserved (night_event_reservations)
- Which market was selected per event (event_execution_queue)
- Which order_key / idempotency_key will be used
- Which signal backed the selection (via condition_id join)
- Queue lifecycle status (READY/CLAIMED/EXECUTED/FAILED)

## What Requires Live Data

- Actual polymarket_order_id (set in mark_history after EXECUTED)
- realized_pnl_usd (requires resolved_outcome + price data)
- Timing of actual claim/send/execute vs. preferred_entry_iso
