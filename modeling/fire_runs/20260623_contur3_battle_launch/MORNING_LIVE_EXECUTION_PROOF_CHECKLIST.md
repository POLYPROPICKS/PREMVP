# Morning Live Execution Proof Checklist — Contur3 Battle 2026-06-23

## DB Tables to Inspect

### 1. `event_execution_queue`
Primary source of truth for battle execution.

```sql
SELECT
  id, match_family_key, event_title, sport,
  condition_id, token_id, side, stake_usd,
  preferred_entry_iso, latest_entry_iso,
  status, order_key, idempotency_key,
  queued_at, updated_at,
  diagnostics->>'mark_history' AS mark_history
FROM event_execution_queue
WHERE DATE(queued_at) = '2026-06-23'
ORDER BY preferred_entry_iso ASC;
```

Expected statuses after battle: `EXECUTED`, `SKIPPED`, `FAILED`, `EXPIRED`, `CLAIMED`

### 2. `executor_order_events`
Ireland writes order events here; PREMVP writes poll proofs.

```sql
SELECT
  id, event_type, source, order_status,
  success, live_confirm, dry_run,
  executor_meta, raw_event_json, created_at
FROM executor_order_events
WHERE created_at > '2026-06-23 19:00:00+00'   -- battle window start UTC
ORDER BY created_at ASC;
```

**Real execution proof**: rows where `live_confirm = true` AND `event_type` NOT `night_plan_poll`

### 3. `night_event_reservations`
The frozen plan that sourced queue candidates.

```sql
SELECT
  plan_run_id, match_family_key, event_title, sport,
  game_start_iso, status, selection_reason
FROM night_event_reservations
WHERE plan_date_minsk = '2026-06-23'
ORDER BY game_start_iso ASC;
```

Expected statuses: `QUEUED` (for executed events), `RESERVED` (not yet due), `EXPIRED`

## How to Prove a Real Order Was Sent

A live order is confirmed when `event_execution_queue` shows:

| Field | Required value |
|-------|---------------|
| `status` | `EXECUTED` |
| `diagnostics.mark_history[*].live_order_confirmed` | `true` |
| `diagnostics.mark_history[*].polymarket_order_id` | non-null |
| `diagnostics.mark_history[*].executed_at_iso` | non-null |

Cross-reference with Ireland local ledger: `logs/contur3_battle_watcher.log`
and Ireland `LIVE_ORDER_CONFIRMED_JSON` if available.

## What Morning Report Must Show

| Metric | Minimum proof |
|--------|--------------|
| `real_executor_rows` | > 0 (queue rows with EXECUTED) |
| `live_order_count` | > 0 (live_confirm=true executor_order_events) |
| `queue_source` | `event_execution_queue` (not night-plan) |
| `execution_period` | 22:00–07:00 Minsk |
| `skipped_reasons` | present if any SKIPPED rows |
| `failed_rows` | present if any FAILED rows |

Morning report is NOT valid if it only shows `alerts/plans` rows — must show real executor rows.

## Ireland Local Ledger Path

```
/home/ubuntu/polymarket-executor/logs/contur3_battle_watcher.log
```

Grep for EXECUTED lines:
```bash
grep "EXECUTED\|CLAIMED\|FAILED\|SKIPPED" logs/contur3_battle_watcher.log | tail -50
```

## Patch Note

No patch to morning report needed unless a specific field gap is proven from tonight's DB query.
Patch only if: morning report returns 0 executor rows while DB shows EXECUTED rows (join missing).
