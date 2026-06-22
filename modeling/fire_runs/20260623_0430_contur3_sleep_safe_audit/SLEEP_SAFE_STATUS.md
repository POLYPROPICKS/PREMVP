# SLEEP_SAFE_STATUS — Contur3 Overnight Readiness
Generated: 2026-06-23 04:30 Minsk / 01:30 UTC

## Summary

| Gap | Severity | Status |
|---|---|---|
| A: No Railway cron for event-rebalance | CRITICAL | OPEN — requires manual Railway config or Ireland tick |
| D: No next_due_iso when due=0 | HIGH | FIXED (this commit) |
| E: persistReservationPlan returns in-memory status | MEDIUM | FIXED (this commit) |
| F: ireland_autostart_expected always true | MEDIUM | FIXED (this commit) |
| G: Queue has no next_due_iso | HIGH | FIXED (this commit) |

## Gap A — Action Required Before Sleep

**Without a cron trigger OR Ireland tick script calling `/api/cron/event-rebalance`, future due events will NOT be queued automatically.**

Choose one:

### Option 1: Railway Cron (permanent fix)
In Railway PREMVP service → Settings → Cron Jobs:
```
Schedule: */5 * * * *
Command: curl -s -X POST "$PREMVP_URL/api/cron/event-rebalance" -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET"
```
This runs every 5 minutes 24/7. Safe: endpoint is idempotent; does nothing when no events are due.

### Option 2: Ireland Tick Script (session fix)
Run IRELAND_QUEUE_ONLY_SLEEP_COMMAND.sh on Ireland machine.
The script calls PREMVP rebalance + reads queue in a loop.
Uses `next_check_after_seconds` from both responses to sleep intelligently.

## Post-Fix Behavior (after this commit)

### When event-rebalance returns due_count=0
```json
{
  "due_count": 0,
  "queued_count": 0,
  "expired_count": 0,
  "next_due_iso": "2026-06-23T07:00:00.000Z",
  "next_check_after_seconds": 9300,
  "next_due_reservations": [
    {
      "match_family_key": "pair:france-vs-iraq:2026-06-23",
      "game_start_iso": "2026-06-23T08:00:00.000Z",
      "rebalance_starts_iso": "2026-06-23T07:00:00.000Z",
      "rebalance_ends_iso": "2026-06-23T07:55:00.000Z",
      "next_check_after_seconds": 9300
    }
  ],
  "ireland_autostart_expected": false
}
```

### When /queue returns 0 candidates
```json
{
  "candidate_count": 0,
  "candidates": [],
  "next_due_iso": "2026-06-23T07:00:00.000Z",
  "next_check_after_seconds": 9300,
  "next_due_reservation": {
    "match_family_key": "pair:france-vs-iraq:2026-06-23",
    "event_title": "France vs Iraq",
    "game_start_iso": "2026-06-23T08:00:00.000Z",
    "rebalance_starts_iso": "2026-06-23T07:00:00.000Z"
  }
}
```

### /night-event-reservations when already_exists=true
Returns DB-backed rows with real statuses (QUEUED, SKIPPED, EXPIRED) instead of always "RESERVED".

### Expired reservation marking
In write mode, any RESERVED/REBALANCE_PENDING row where `minutesToStart <= 5` is automatically marked EXPIRED. No manual cleanup needed.

## Locked Policy Reminders

- Stake: $7 (EXECUTABLE_STAKE_USD) — never changes without founder decision
- Tier: TIER1 only — never TIER2/TIER3
- Halftime: always blocked
- WEAK_IDENTITY: always blocked (no bypass)
- Ireland reads: /api/executor/queue ONLY
- /night-plan: candidates=[] always (diagnostic only)
- No push without explicit founder authorization
