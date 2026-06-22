# CURRENT_PIPELINE_MAP — Contur3 Sleep-Safe Audit
Generated: 2026-06-23 04:30 Minsk (01:30 UTC)

## Canonical Contur3 Flow

```
~17:00 Minsk
    │
    ▼
POST /api/cron/night-event-reservations
    │  builds ReservationPlan from FireModel universe (TIER1 events only)
    │  writes night_event_reservations rows (status=RESERVED)
    │  idempotent: if plan_run_id exists + !force → returns DB-backed rows (FIXED)
    │
    ▼  every ~5-10 min (T-60 → T-5 per event)
POST /api/cron/event-rebalance
    │  queries night_event_reservations WHERE status IN ('RESERVED','REBALANCE_PENDING')
    │  filters due: minutesToStart ∈ (LATEST_ENTRY=5, REBALANCE_OPEN=60]
    │  marks expired rows EXPIRED in write mode (ADDED)
    │  loads FireModel universe → selects ONE best TIER1 market per due event
    │  on success → inserts event_execution_queue row (status=READY)
    │                marks reservation status=QUEUED
    │  on fail    → marks reservation status=SKIPPED
    │  returns: due_count, queued_count, skipped_count, expired_count (ADDED)
    │            next_due_iso, next_check_after_seconds (ADDED)
    │            next_due_reservations[] (ADDED)
    │            ireland_autostart_expected: true ONLY when queued_count>0 (FIXED)
    │
    ▼
GET /api/executor/queue
    │  reads event_execution_queue WHERE status=READY AND latest_entry_iso > now
    │  returns candidates[] with entry_state=IN_WINDOW|PENDING_WINDOW
    │  returns next_due_iso, next_check_after_seconds (ADDED)
    │  returns next_due_reservation { match_family_key, game_start_iso, rebalance_starts_iso } (ADDED)
    │  Ireland reads ONLY this endpoint — never broad candidates
    │
    ▼
Ireland tick loop
    │  calls /queue every cycle
    │  if candidate_count > 0 AND entry_state=IN_WINDOW → execute at stake=$7
    │  if next_check_after_seconds → sleep that long before calling /rebalance
    │  NEVER calls /candidates, /night-plan, or broad FireModel
```

## Timing Constants (nightWindow.ts — LOCKED)

| Constant | Value | Meaning |
|---|---|---|
| REBALANCE_MINUTES_BEFORE_START | 60 | Rebalance window opens at T-60m |
| LATEST_ENTRY_MINUTES_BEFORE | 5 | Hard cutoff at T-5m |
| PREFERRED_ENTRY_MINUTES_BEFORE | 45 | Ireland preferred entry T-45m |
| NIGHT_PLAN_ANCHOR_HOUR_MINSK | 17 | Reservation plan built at 17:00 Minsk |
| NIGHT_OPERATION_END_HOUR_MINSK | 8 | Operational window closes 08:00 Minsk |

## Reservation Status Lifecycle

```
RESERVED
  → (at T-60) QUEUED (rebalance success) or SKIPPED (no executable market)
  → (past T-5) EXPIRED (write mode, missed window — ADDED)
REBALANCE_PENDING → same transitions as RESERVED
QUEUED → row in event_execution_queue (status=READY)
SKIPPED → no row written; blocked_candidates[] available in rebalance response
EXPIRED → missed rebalance window; no row written
```

## Queue Row Lifecycle

```
READY → Ireland reads; Ireland claims → CLAIMED → Ireland sends → SENT
```

## Architectural Gap A (NOT FIXABLE IN CODE)

**There is no Railway/Vercel automatic cron trigger configured for `/api/cron/event-rebalance`.**
The endpoint is correct and idempotent. It must be called externally.

Options:
1. Configure Railway cron: `*/5 * * * *` → `POST PREMVP_URL/api/cron/event-rebalance -H "x-executor-secret: $SECRET"`
2. Ireland tick script calls PREMVP rebalance endpoint on each loop (see IRELAND_QUEUE_ONLY_SLEEP_COMMAND.sh)

## Files Changed This Audit

| File | Change |
|---|---|
| `lib/executor/eventExecutionQueue.ts` | Added `expired_count`, `next_due_reservations`, `next_check_after_seconds` to `RebalanceRunResult`; compute expired/upcoming from reservation rows; mark EXPIRED in write mode |
| `app/api/cron/event-rebalance/route.ts` | Expose new fields; fix `ireland_autostart_expected` to be conditional on queued_count |
| `lib/executor/nightEventReservations.ts` | `persistReservationPlan` now returns DB-backed rows (with real statuses) when `already_exists=true` |
| `app/api/executor/queue/route.ts` | Add `next_due_iso`, `next_check_after_seconds`, `next_due_reservation` from `night_event_reservations` |
