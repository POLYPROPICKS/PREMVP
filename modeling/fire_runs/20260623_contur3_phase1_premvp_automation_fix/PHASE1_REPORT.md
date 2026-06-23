# PHASE 1 / STEP 1.1 — PREMVP Automation Fix — Report

**Date:** 2026-06-23  
**HEAD before patch:** ffff635  
**Build:** PASS

---

## Target Audit Results

| Target | Description | Status | Notes |
|--------|-------------|--------|-------|
| A | Doctor script `scripts/contur3_premvp_doctor.sh` | ✅ CREATED | Verifies 401 gates, reservations, rebalance dryRun, queue contract, night-plan safety |
| B | Rebalance response completeness | ✅ ALREADY COMPLETE | all required fields present: due_count, queued_count, skipped_count, already_queued_count, expired_count, next_due_iso, next_check_after_seconds, next_due_reservations, outcomes, founder_action_required, ireland_autostart_expected |
| C | Reservation status truth | ✅ PATCHED | Added queued_count, skipped_count, expired_count, bad_market_level_count derived from result.reservations statuses |
| D | Night email runtime link | ✅ ALREADY COMPLETE | source: "night_event_reservations", plan_run_id, reserved_count in response; reads from DB via ensureAndLoadReservations |
| E | Queue-only contract | ✅ ALREADY COMPLETE | source="event_execution_queue", ireland_contract with do_not_rank/do_not_pull_broad_candidates/do_not_apply_tier2_tier3, diagnostics with ready_rows_total/in_window_count/pending_window_count, next_due_iso, next_due_reservation |
| F | night-plan safety | ✅ ALREADY COMPLETE | candidates: never[] (empty), diagnostic_only: true, executable_source: "/api/executor/queue", executable_candidates_warning present |

---

## Files Changed

| File | Change |
|------|--------|
| `app/api/cron/night-event-reservations/route.ts` | +13 lines: status bucket counting → queued_count, skipped_count, expired_count, bad_market_level_count in response |
| `package.json` | +1 script: `contur3:doctor` → `bash scripts/contur3_premvp_doctor.sh` |
| `scripts/contur3_premvp_doctor.sh` | NEW: production health doctor script |

---

## Architecture Verification

**Split-brain risk: ELIMINATED**
- `/api/executor/night-plan` → `candidates: never[]`, `diagnostic_only: true` — cannot feed Ireland
- `/api/executor/queue` → only source, reads only from `event_execution_queue` table
- No broad candidate pull in queue route (confirmed: does NOT call `buildFireModelCandidates`)
- Rebalance does call `buildFireModelCandidates` — this is correct (it selects the best market per already-reserved event)
- Ireland contract embedded in queue response

**Rebalance `buildFireModelCandidates` call is intentional and correct:**
`eventExecutionQueue.ts` line 317 calls `buildFireModelCandidates` to get the live universe,
then filters it to only events already in `night_event_reservations` (RESERVED/REBALANCE_PENDING).
This is the canonical "market selection for already-reserved events" — not broad candidate pull.

**`ireland_autostart_expected` logic:**
- Rebalance: `queued_count > 0 || already_queued_count > 0` — correct
- Reservations: hardcoded `true` — acceptable (reservation cron running means the pipeline is active)
- Night-plan-email: hardcoded `true` — acceptable (informational only, does not gate Ireland)

---

## Gate 1 Verdict

| Check | Result |
|-------|--------|
| Git tracked dirty unexpected | CLEAN (only allowed files) |
| Build | PASS |
| Allowed files only | PASS |
| `/api/executor/queue` queue-only | PASS |
| `/api/executor/night-plan` diagnostic-only | PASS |
| Rebalance no Tier2/Tier3/halftime | PASS (EXECUTABLE_TIER=TIER1 enforced in eventExecutionQueue) |
| Reservation event-level only | PASS (MARKET_LEVEL_KEY_RE filters in nightEventReservations) |

**Gate 1: PASS**
