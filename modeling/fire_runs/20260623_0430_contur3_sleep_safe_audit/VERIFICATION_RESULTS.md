# VERIFICATION_RESULTS — Contur3 Sleep-Safe Audit
Generated: 2026-06-23 04:30 Minsk / 01:30 UTC

## Gate 1 — Build

```
npm run build: PASS
Error output: none
Routes compiled:
  ƒ /api/cron/event-rebalance
  ƒ /api/cron/night-event-reservations
  ƒ /api/executor/queue
  ƒ /api/executor/night-plan
```

## Gate 1 — Files Changed

```
git diff --stat:
  app/api/cron/event-rebalance/route.ts  |  6 ++++
  app/api/executor/queue/route.ts        | 32 ++++++++++++++++++
  lib/executor/eventExecutionQueue.ts    | 59 ++++++++++++++++++++++++++++++++
  lib/executor/nightEventReservations.ts |  7 ++--
  4 files changed, 99 insertions(+), 5 deletions(-)
```

Gate 1 verdict: **PASS** — only allowed files changed, build clean.

## Patches Applied

### 1. lib/executor/eventExecutionQueue.ts

Old `RebalanceRunResult`:
```typescript
export interface RebalanceRunResult {
  rebalance_run_id: string;
  due_count: number;
  queued_count: number;
  skipped_count: number;
  already_queued_count: number;
  outcomes: RebalanceOutcome[];
  wrote: boolean;
}
```

New `RebalanceRunResult`:
```typescript
export interface NextDueReservation {
  match_family_key: string;
  game_start_iso: string;
  rebalance_starts_iso: string;
  rebalance_ends_iso: string;
  next_check_after_seconds: number;
}

export interface RebalanceRunResult {
  rebalance_run_id: string;
  due_count: number;
  queued_count: number;
  skipped_count: number;
  already_queued_count: number;
  expired_count: number;          // NEW
  outcomes: RebalanceOutcome[];
  wrote: boolean;
  next_due_reservations: NextDueReservation[];  // NEW
  next_check_after_seconds: number | null;      // NEW
}
```

New behavior in `runEventRebalance`:
- Computes `expired` rows (RESERVED where minutesToStart <= 5) and `upcoming` rows (minutesToStart > 60)
- In write mode, marks expired rows as EXPIRED in DB
- Returns `next_due_reservations[]` from upcoming rows (up to 3), each with `rebalance_starts_iso` and `next_check_after_seconds`
- Early return (due=0) now includes these fields instead of omitting them

### 2. app/api/cron/event-rebalance/route.ts

Old response:
- No `expired_count`, `next_due_iso`, `next_check_after_seconds`, `next_due_reservations`
- `ireland_autostart_expected: true` (always)

New response:
- `expired_count: result.expired_count`
- `next_due_iso: result.next_due_reservations[0]?.rebalance_starts_iso ?? null`
- `next_check_after_seconds: result.next_check_after_seconds`
- `next_due_reservations: result.next_due_reservations`
- `ireland_autostart_expected: result.queued_count > 0 || result.already_queued_count > 0`

### 3. lib/executor/nightEventReservations.ts

Old `persistReservationPlan` (already_exists=true branch):
```typescript
const { data: existing } = await supabaseAdmin
  .from("night_event_reservations")
  .select("id, match_family_key")   // ← sparse: no status
  .eq("plan_run_id", plan.plan_run_id);
...
return { ..., reservations: plan.reservations };  // ← in-memory, status always "RESERVED"
```

New:
```typescript
const { data: existing } = await supabaseAdmin
  .from("night_event_reservations")
  .select("*")                       // ← full rows
  .eq("plan_run_id", plan.plan_run_id)
  .order("reservation_rank", { ascending: true });
...
return { ..., reservations: existing as unknown as NightEventReservationRow[] };  // ← DB-backed
```

Effect: `/api/cron/night-event-reservations` now returns `reserved_events[].status` with real values
(RESERVED/QUEUED/SKIPPED/EXPIRED) instead of always "RESERVED".

### 4. app/api/executor/queue/route.ts

New behavior:
- Queries `night_event_reservations` for next upcoming reservation (game_start > now+60min)
- Computes `next_due_iso` (= game_start - 60min) and `next_check_after_seconds`
- Adds to response: `next_due_iso`, `next_check_after_seconds`, `next_due_reservation`

## Artifacts Created

| File | Purpose |
|---|---|
| CURRENT_PIPELINE_MAP.md | Full Contur3 flow diagram, timing constants, status lifecycle |
| SLEEP_SAFE_STATUS.md | Gap table, required founder action (Railway cron), post-fix behavior examples |
| PRODUCTION_VERIFY_COMMANDS_WINDOWS.cmd | Windows curl commands for post-deploy verification |
| IRELAND_QUEUE_ONLY_SLEEP_COMMAND.sh | Ireland tick loop — QUEUE ONLY, calls PREMVP rebalance each tick, sleeps next_check_after_seconds |
| VERIFICATION_RESULTS.md | This file |

## Founder Action Required

1. **Deploy**: Railway will auto-deploy this commit on push.
2. **Verify**: Run PRODUCTION_VERIFY_COMMANDS_WINDOWS.cmd after Railway shows "Deployment successful".
3. **Gap A** (CRITICAL — not fixed in code): Configure Railway cron OR run IRELAND_QUEUE_ONLY_SLEEP_COMMAND.sh before sleeping.
   See SLEEP_SAFE_STATUS.md → "Gap A — Action Required Before Sleep".
