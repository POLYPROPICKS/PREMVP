# Contur3 Diagnostics and Recovery Doctrine

## Overview

Blue_model (Contur3) is the deterministic event-first night execution framework. This document covers:
- The canonical execution pipeline
- How to interpret diagnostics when `candidate_count=0` or execution stalls
- Recovery procedures without manual JSON editing or ad-hoc queries

**Core principle:** Never guess at Contur3 state. Every cron run produces persistent diagnostics on the filesystem.

---

## Canonical Pipeline Map

```
17:00 Minsk
  ↓
  /api/cron/night-event-reservations
    (x-executor-secret: EXECUTOR_CANDIDATES_SECRET)
    ↓
    buildReservationPlan(nowMs)
      → buildFireModelCandidates(200, "all", planning=true)
      → filter: Tier1 events only, within 18h horizon
      → group by event (match_family_key)
      → rank cross-event by score/coverage
      → persist to night_event_reservations as RESERVED
    ↓
    persistReservationPlanDiagnostics()
      → Write JSON to modeling/fire_runs/contur3-reservations/
      → Includes: universe_size, reserved_count, by_sport, by_tier
    ↓
    Response includes diagnostic_report_path
    ↓
    Ireland auto-starts at 18:00 Minsk
    (or operator approves override)

Every 5-10 minutes (T-60 to T-30 before each event start):
  ↓
  /api/cron/event-rebalance
    (x-executor-secret: EXECUTOR_CANDIDATES_SECRET)
    ↓
    runEventRebalance(nowMs, {write: true})
      → Load RESERVED/REBALANCE_PENDING events
      → For each due event (within T-60..T-30 window):
        - Load current markets for that event
        - Filter: Tier1, live_eligible, no halftime, has condition_id + token_id + side
        - Select ONE best by score/coverage
        - Write READY row to event_execution_queue
        - Mark reservation QUEUED
      ↓
    persistRebalanceDiagnostics()
      → Write JSON to modeling/fire_runs/contur3-rebalance/
      → Includes: due_count, queued_count, skipped_count, outcomes
    ↓
    Response includes diagnostic_report_path

Ireland (not visible in these docs):
  /api/executor/queue
    → Reads event_execution_queue with status=READY
    → Places order only when due_window returns RESULT_GO
    → Updates status to SENT / FAILED / CANCELLED
```

---

## Authentication Map

| Endpoint | Secret Header | Environment Variable | Scope |
|---|---|---|---|
| `/api/cron/night-event-reservations` | `x-executor-secret` | `EXECUTOR_CANDIDATES_SECRET` | Event reservation, diagnostics write |
| `/api/cron/event-rebalance` | `x-executor-secret` | `EXECUTOR_CANDIDATES_SECRET` | Rebalance, market selection, queue write |
| `/api/executor/queue` | `x-executor-secret` | `EXECUTOR_CANDIDATES_SECRET` | Ireland read-only access to queue |
| `/api/executor/due-window` | `x-executor-secret` | `EXECUTOR_CANDIDATES_SECRET` | Ireland order-entry gate check |

---

## Symptom: `candidate_count=0` or No Reservations

### Root Cause Hierarchy

1. **`universe_size = 0`**
   - `buildFireModelCandidates(200, "all", planning=true)` returned zero candidates.
   - Check: Are there any rows in `generated_signal_pairs` from the last 36 hours?
   - Check: Does `generated_signal_pairs` have any rows with `status='ACTIVE'` and non-null `pair_* fields`?
   - **Action:** If `generated_signal_pairs` is empty, the signal feed is dead. Contact signal team.

2. **`universe_size > 0` but `reserved_count = 0`**
   - Candidates exist but all were filtered out at event level.
   - Check the diagnostics JSON for:
     - `skipped_non_tier1_event`: All candidates were Tier2/Tier3 only. Policy: reserve Tier1 only.
     - `skipped_outside_horizon`: All candidates' game_start_iso was outside the 17:00→08:00 window + 18h horizon.
     - `skipped_weak_key`: Event keys failed weak-key checks (unreliable match_family_key).
     - `market_level_keys_skipped`: Candidates were market-level props (halftime, o/u, etc.), not event-level.
   - **Action:** Check if intentional (e.g., all events are Tier2 for tonight). If Tier1 events should exist, check signal feed quality.

3. **`reserved_count > 0` but `queued_count = 0` at rebalance**
   - Reservations exist but rebalance found no executable markets.
   - Check the rebalance diagnostics JSON for each skipped outcome:
     - `NO_EXECUTABLE_TIER1_MARKET_AT_REBALANCE`: No Tier1 markets for that event in the live universe.
     - `NO_EXECUTABLE_TIER1_MARKET_AT_REBALANCE_SIDE_MISSING`: Tier1 markets exist but `side_mapping_status` is `UNKNOWN_BLOCKED`.
   - **Action:** Wait for next rebalance window (markets may still be loading). If persistent across 2+ rebalances, check Polymarket data sync.

---

## Finding Diagnostic Reports

### Reservation Diagnostics

```
modeling/fire_runs/contur3-reservations/
  plan_20250523_0170000_minsk_1700_1800_utc-3_timestamp.json
  plan_20250524_0170000_minsk_1700_1800_utc-3_timestamp.json
  ...
```

Each file contains:
```json
{
  "generated_at": "2025-05-23T14:00:00.000Z",
  "plan_run_id": "plan_20250523_0170000_minsk_1700_1800_utc-3",
  "plan_date_minsk": "2025-05-23",
  "commit": "abc123...",
  "diagnostics": {
    "universe_size": 200,
    "reserved_count": 12,
    "by_sport": {"SOCCER": 8, "AMERICAN_FOOTBALL": 4},
    "by_tier": {"TIER1": 12},
    "skipped_non_tier1_event": 45,
    "skipped_outside_horizon": 120,
    "skipped_weak_key": 5,
    "market_level_keys_skipped": 13
  },
  "reserved_events": [
    {
      "rank": 1,
      "event_title": "France vs Italy",
      "match_family_key": "pair:france-vs-italy:2025-05-23",
      "sport": "SOCCER",
      "tier": "TIER1",
      "score": 8.7
    },
    ...
  ]
}
```

### Rebalance Diagnostics

```
modeling/fire_runs/contur3-rebalance/
  rebalance_20250523_1400_timestamp.json
  rebalance_20250523_1415_timestamp.json
  ...
```

Each file contains:
```json
{
  "generated_at": "2025-05-23T14:15:00.000Z",
  "rebalance_run_id": "rebalance_20250523_1400",
  "commit": "abc123...",
  "due_count": 3,
  "queued_count": 2,
  "skipped_count": 1,
  "already_queued_count": 0,
  "expired_count": 0,
  "outcomes_summary": {
    "total": 3,
    "queued": 2,
    "skipped": 1,
    "already_queued": 0
  },
  "outcomes": [
    {
      "match_family_key": "pair:france-vs-italy:2025-05-23",
      "result": "QUEUED",
      "reason": "REBALANCE_SINGLE_BEST_MARKET",
      "queued_event": "France vs Italy",
      "skipped_candidate_count": 0
    },
    {
      "match_family_key": "pair:germany-vs-spain:2025-05-23",
      "result": "SKIPPED",
      "reason": "NO_EXECUTABLE_TIER1_MARKET_AT_REBALANCE: candidate_count=42 tier1_count=8 ...",
      "skipped_candidate_count": 5
    }
  ]
}
```

---

## Interpreting Key Diagnostics

| Field | Meaning | Normal Range |
|---|---|---|
| `universe_size` | Total candidates from `buildFireModelCandidates` | 150–200 |
| `reserved_count` | Events reserved after Tier1 + horizon filters | 5–20 (depends on schedule) |
| `skipped_non_tier1_event` | Candidates filtered because best candidate was not Tier1 | 0–80 |
| `skipped_outside_horizon` | Event groups filtered because game start was outside 18h horizon | 0–50 |
| `by_sport` | Count per sport (e.g., `{"SOCCER": 8, "AMERICAN_FOOTBALL": 4}`) | Varies |
| `by_tier` | Count per tier (e.g., `{"TIER1": 12}`) | Only Tier1 should appear for reservations |
| **Rebalance:** `due_count` | Events in RESERVED/REBALANCE_PENDING due for market selection | 0–20 |
| **Rebalance:** `queued_count` | Markets selected and written to queue | 0–`due_count` |
| **Rebalance:** `skipped_count` | Due events with no executable market | 0–`due_count` |
| **Rebalance:** `already_queued_count` | Due events already have READY/SENT queue row | 0–`due_count` |

---

## Strict Recovery Rules

### Rule 1: Never Unlock Tier2/Tier3

Tier2 and Tier3 are **permanently disabled** for auto-execution. To resume Tier1-only operations after an outage:

1. Verify `/api/cron/night-event-reservations?mode=status` shows `reserved_count > 0` with `by_tier: {"TIER1": N}`.
2. Verify `/api/cron/event-rebalance?dryRun=1` shows `queued_count > 0` (dry-run).
3. Check rebalance diagnostics JSON for `NO_EXECUTABLE_TIER1_MARKET` skips (expected; markets may still sync).

**Do NOT change `EXECUTABLE_TIER` from `"TIER1_CORE_STRICT_72_COV50"`.**

### Rule 2: Do NOT Manually Edit Diagnostics JSON

Diagnostics are read-only audit records. They are generated fresh each cron run and stored immutably.

**Correct action if diagnostics are wrong:**
- Stop the problematic cron handler (e.g., disable `/api/cron/event-rebalance`).
- Investigate root cause (signal feed, Polymarket sync, database).
- Fix the root cause (not the JSON).
- Trigger cron by hand with `?forceCreate=CEO_APPROVED` or `?dryRun=1` to verify.
- Re-enable cron.

### Rule 3: Operator Action Budget

When troubleshooting `candidate_count=0`:

| Action | How Many | Window |
|---|---|---|
| Status check (read-only cron) | Unlimited | Any time |
| Due-window check | 2–3 per hour | Respect API rate limits |
| Force-create or force-rebuild | 1 per incident | After root cause confirmed |
| Manual queue unlock | 1 per quarter | Emergency only; requires founder sign-off |

**Do NOT:**
- Curl the queue endpoint repeatedly to "poke" it.
- Insert test rows into `night_event_reservations` by hand.
- Modify `event_execution_queue` rows (except via the cron handlers).

---

## Diagnosing by Cron Response

### Night-Event-Reservations Response

```bash
curl -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET" \
  https://api.example.com/api/cron/night-event-reservations?mode=status
```

Key fields:
- `ok: true` — no errors.
- `reserved_count` — how many events were reserved.
- `diagnostics.universe_size` — candidates available.
- `diagnostics.skipped_non_tier1_event` — Tier2/Tier3 filtered out.
- `plan_health.queued_count` — after rebalance (may lag by 5–10 min).
- `diagnostic_report_path` — filesystem path to detailed JSON.

### Event-Rebalance Response

```bash
curl -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET" \
  https://api.example.com/api/cron/event-rebalance?dryRun=1
```

Key fields:
- `ok: true` — no errors.
- `due_count` — events ready for market selection.
- `queued_count` — markets written to queue (target: ≥ 1 if `due_count ≥ 1`).
- `skipped_count` — events with no executable market.
- `outcomes[].reason` — detailed skip reason for each skipped event.
- `diagnostic_report_path` — filesystem path to detailed JSON.

---

## Emergency Recovery Checklist

**Scenario: Irish order sender is stuck (no orders placed for 2+ hours) and due-window keeps returning `RESULT_FAIL_CONTRACT`.**

1. **Verify pipeline is running:**
   ```bash
   curl -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET" \
     /api/cron/night-event-reservations?mode=status
   ```
   Confirm `reserved_count > 0` and `in_creation_window: true`.

2. **Check rebalance is generating queue rows:**
   ```bash
   curl -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET" \
     /api/cron/event-rebalance?dryRun=1
   ```
   Confirm `queued_count > 0` (even in dry-run, the logic is identical).

3. **Read latest diagnostics files:**
   - `ls -lt modeling/fire_runs/contur3-reservations/ | head -1`
   - `ls -lt modeling/fire_runs/contur3-rebalance/ | head -1`
   - Open the JSONs and search for unusual counts or error reasons.

4. **If all crons report success but due-window still fails:**
   - The issue is in Ireland or the due-window itself, not in Contur3.
   - Escalate to order-sender team.

5. **If a cron is failing (error field is non-null):**
   - Check application logs for the endpoint (e.g., `[cron/night-event-reservations] Error: ...`).
   - Diagnostics are marked non-fatal; even if write fails, reservation logic should succeed.
   - If the error is in business logic (e.g., database), restart the app and re-run the cron.

---

## Notes for Operators

- **Diagnostics are durable:** Every cron run writes a JSON file. Keep a log of file paths for easy reference.
- **No manual JSON editing:** The JSON is the source of truth. If it looks wrong, the issue is in the code or data pipeline, not the JSON.
- **Commit hash included:** Each diagnostic JSON includes the deployed commit. If two runs have different commits, the app may have been re-deployed between them.
- **Filesystem-safe filenames:** `plan_run_id` and `rebalance_run_id` are sanitized for use in filenames.
- **Timestamps are ISO-8601:** All times are in UTC. Minsk time is documented in the plan_date_minsk or other fields.

---

## Policy Summary (Do Not Override)

| Policy | Reason | Override Cost |
|---|---|---|
| Tier1-only reservation | WC/premier league signals only; Tier2/3 are research | 2-week audit required |
| 18h horizon floor | Prevents stale market sync issues | New trading window required |
| No halftime markets | Excluded from live ordering; high churn | Compliance review required |
| Single market per event | Reduces correlated risk | Risk committee approval required |
| x-executor-secret auth | Prevents accidental Ireland start | Founder + ops sign-off |

---

## References

- [nightEventReservations.ts](../../lib/executor/nightEventReservations.ts)
- [eventExecutionQueue.ts](../../lib/executor/eventExecutionQueue.ts)
- [nightWindow.ts](../../lib/executor/nightWindow.ts)
- [buildFireModelCandidates.ts](../../lib/executor/buildFireModelCandidates.ts)
