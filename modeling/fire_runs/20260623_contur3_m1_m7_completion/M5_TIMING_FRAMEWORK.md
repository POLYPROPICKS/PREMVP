# M5 — Timing Framework

Generated: 2026-06-23. Framework only — no live execution data available yet.

---

## Purpose

Define timing analysis structure for T-60/T-45/T-30/T-5 PnL without requiring live results.
Founders must not invent timing conclusions from empty data.

---

## Required Fields

| Field | Source Table | Status |
|---|---|---|
| reservation_time | `night_event_reservations.reserved_at` | Present |
| plan_run_id | `night_event_reservations.plan_run_id` | Present |
| game_start_iso | `night_event_reservations.game_start_iso` | Present |
| rebalance_time | `event_execution_queue.queued_at` | Present |
| rebalance_run_id | `event_execution_queue.rebalance_run_id` | Present |
| preferred_entry_iso | `event_execution_queue.preferred_entry_iso` | Present |
| latest_entry_iso | `event_execution_queue.latest_entry_iso` | Present |
| actual claim time | `event_execution_queue.diagnostics.mark_history[].marked_at_iso` (CLAIMED) | Present (in JSONB) |
| actual send time | `event_execution_queue.diagnostics.mark_history[].sent_at_iso` | Present (in JSONB) |
| order confirmed time | `event_execution_queue.diagnostics.mark_history[].executed_at_iso` | Present (in JSONB) |
| market price at queue | Not stored separately | **SCHEMA_GAP** — price at queued_at not captured |
| market price at send | Not stored separately | **SCHEMA_GAP** — price at send_at not captured |
| result / outcome | Not stored in queue | **SCHEMA_GAP** — resolved_outcome must join signal corpus |

---

## Schema Gaps (Append-Only Proposals — Do Not Apply)

```sql
-- Gap 1: price at queue time
ALTER TABLE event_execution_queue
  ADD COLUMN IF NOT EXISTS price_at_queue numeric(10,4);

-- Gap 2: price at send time (can be set via /api/executor/queue/mark payload)
-- No schema change needed — already captured in diagnostics.mark_history

-- Gap 3: resolved outcome linkage
-- Requires join between event_execution_queue and generated_signal_pairs
-- on condition_id + token_id, then to Polymarket resolution API.
-- No migration needed for the join — missing column is resolved_outcome on queue row.
ALTER TABLE event_execution_queue
  ADD COLUMN IF NOT EXISTS resolved_outcome text;

ALTER TABLE event_execution_queue
  ADD COLUMN IF NOT EXISTS resolved_at_iso timestamptz;

ALTER TABLE event_execution_queue
  ADD COLUMN IF NOT EXISTS realized_pnl_usd numeric(10,4);
```

**Do not apply these migrations without explicit founder approval and Supabase migration PR.**

---

## Timing Buckets

| Bucket | Definition | Relative to game_start_iso |
|---|---|---|
| `T_0_30M` | Last 30 min before start | game_start - 30m to game_start |
| `T_30_60M` | 30–60 min before start | game_start - 60m to game_start - 30m |
| `T_1_2H` | 1–2 hours before | game_start - 2h to game_start - 1h |
| `T_2_6H` | 2–6 hours before | game_start - 6h to game_start - 2h |
| `T_6H_PLUS` | More than 6 hours | before game_start - 6h |
| `LATE / AFTER` | At or after start | queued_at >= game_start_iso |

---

## Current Policy (from nightWindow.ts)

```
REBALANCE_MINUTES_BEFORE_START = 60   (rebalance opens at T-60)
PREFERRED_ENTRY_MINUTES_BEFORE = 45   (preferred: T-45)
LATEST_ENTRY_MINUTES_BEFORE    = 5    (cutoff: T-5)
```

All current queue candidates are in the `T_30_60M` or `T_0_30M` bucket.

---

## Future Metrics (Available After Live Resolved Data)

| Metric | Formula |
|---|---|
| Fill rate | EXECUTED / (CLAIMED + EXECUTED) |
| Skip rate | SKIPPED / total candidates |
| Execution slippage | price_at_send - price_at_queue (when gap filled) |
| Realized ROI | sum(realized_pnl_usd) / sum(stake_usd) |
| Max drawdown | max cumulative loss streak |
| Event family stability | % of reservations that reach QUEUED status |

---

## No Fake Conclusions

**Do not draw timing-bucket PnL conclusions until live resolved data exists.**
Current state: framework only.
