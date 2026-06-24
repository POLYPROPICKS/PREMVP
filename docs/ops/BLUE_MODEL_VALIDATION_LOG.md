# Blue_model / Contur3 Validation Log

---

## 2026-06-23 — V0 Supervised-Live Validation

**Validated by:** Claude Code (Sonnet 4.6), session 2026-06-23

### Repo State

| Field | Value |
|---|---|
| Repo | `C:\WORK\KalshiProPulse\sipropicks-premvp1-1` (PREMVP — correct repo) |
| Branch | `main` |
| HEAD | `7f60ea9ffaa4d21c4f72bd31c24f9e12f03e156f` |
| origin/main | `7f60ea9ffaa4d21c4f72bd31c24f9e12f03e156f` (in sync) |
| Key commits present | `7f60ea9` fix Blue_model status clean exit ✓ |
| | `deb13d6` add Blue_model deterministic Contur3 runners ✓ |
| | `32fade9` prevent halftime anchors blocking queue ✓ |
| | `6273711` fix Contur3 reservation funnel loss ✓ |
| | `dce2d18` persist Contur3 reservation diagnostics ✓ |

### Package Scripts

| Script | Status |
|---|---|
| `contur3:night-reservations` | ✓ present |
| `contur3:event-rebalance` | ✓ present |
| `contur3:blue-status` | ✓ present |
| `contur3:ops-report-email` | ✓ added this session |

### Blue-Status Code Validation

| Field | Value |
|---|---|
| Secret available locally | **NO** — `.env.local` has `PPP_SESSION_SECRET` but not `EXECUTOR_CANDIDATES_SECRET`/`EXECUTOR_SECRET`/`PPP_SECRET` |
| Secret in Railway | YES (runtime only) |
| libuv assertion | **ABSENT** — `process.exitCode` + `.unref()` timeout strategy used |
| `[object Object]` bug | **ABSENT** — `JSON.stringify(..., null, 2)` used for `next_due_reservation` and `ireland_contract` |
| ARMED_WAITING exit code | **0** (correct) |
| GO_READY exit code | **0** (correct) |
| NO_GO exit code | **1** (correct) |
| MISSING_SECRET exit code | **1** (correct) |
| Code-level verdict | **PASS** |

**Verdict: `BLUE_MODEL_V0_CODE_VALIDATED_SECRET_RUNTIME_PENDING`**

Runtime validation (with real secret) must be run from PREMVP repo on Railway or via Railway shell.

### Ireland Queue-Only Proof

From prior session evidence (grep on Ireland machine):

| Check | Result |
|---|---|
| Active path `/night-plan` | **ABSENT** |
| Active path `generated_signal` direct | **ABSENT** |
| Active path `choose_candidates`/`rank` | **ABSENT** |
| Active watcher reads | `/api/executor/queue?includeUpcoming=1` ✓ |
| Queue source expected | `event_execution_queue` |
| `do_not_rank=true` | enforced at queue-build layer |
| `do_not_pull_broad_candidates=true` | enforced at queue-build layer |

Ireland watcher: `contur3_battle_queue_only_watcher.py` — queue-only, no broad-pull, no rank, no night-plan call.

### Hard-Stop Status

Hard-stop files (`/tmp/PPP_LIVE_HARD_STOP`, `data/PPP_LIVE_HARD_STOP`) confirmed **ABSENT** — live armed mode is expected.

### Execution Contract (current)

- Tier 1 only — no Tier2/Tier3
- Full-match / game-level only
- No halftime, no first-half
- No corners, no props, no futures, no outrights
- Stake from queue only, cap $7/event
- `one_position_per_event=true`
- `do_not_rank=true`
- `do_not_pull_broad_candidates=true`

### Market Policy Notes

- **Portugal NO_GO** under current contract: only halftime Tier1 / corners side-market were strong; both are forbidden
- **WC side-market / corners policy** remains P2 backlog
- Do NOT enable Portugal/corners/side-market execution without explicit founder approval

### Ops Email Status

**2026-06-23 — pipeline sequence verified + executor secret gate removed (session 3)**

| Field | Value |
|---|---|
| Runner file | `scripts/contur3/run-ops-report-email.mjs` |
| Railway Start Command | `node scripts/contur3/run-ops-report-email.mjs` |
| Code syntax check | PASS |
| Build | PASS |
| Runtime verdict | `OPS_EMAIL_CODE_VALIDATED_RUNTIME_ENV_PENDING` |
| Missing env locally | `RESEND_API_KEY`, `EMAIL_FROM`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

**Root cause of Railway cron failure (confirmed):**
Runner previously required `EXECUTOR_CANDIDATES_SECRET`/`EXECUTOR_SECRET`/`PPP_SECRET` as preflight gate.
This secret is NOT present in `ops-report-email-cron` Railway service (only in execution service).
Pipeline failed at preflight — before any DB query or artifact was written.

**Pipeline sequence (verified filesystem-first):**
The `founder-email-dispatcher.ts --mode=morning` sequence is:
1. `resolve:signals:live-priority` → Supabase write (generated_signal_pairs)
2. `resolve:signals:cron` → Supabase write (expire/resolve signals)
3. `verify:resolver-pipeline` → read-only validation
4. `morning:model-report --send-test` → fetch DB → write CSV/MD/XLSX to `modeling/morning_model_report/<date>/` → send email via Resend

Email is always last. Artifacts are verified to be non-empty before send (dataset staleness check throws if rows ≤ baseline).

**Fix applied (session 3):**
- Removed `getSecret()` / executor secret gate from runner (wrong gate for email-only pipeline)
- Pre-flight checks now: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`
- `phase` field added to JSON report: `preflight_failed` / `pipeline_failed` / `complete`

---

## 2026-06-24 — Reservation Anchor Guard Fix

**Validated by:** Claude Code (Sonnet 4.6), session 2026-06-24

### Incident

After forceRebuild fix (commit b37b6d5), reservation planner created RESERVED rows with corners anchor:
- event_title: "Switzerland vs Canada: O/U 9.5 Total Corners"
- event_tier: TIER1, event_score: 82, status: RESERVED
- These rows were future reservations that would NEVER execute (rebalance guard would skip them)
- Audit was reporting ARMED_WAITING — masking the real funnel break

### Root Cause

`nightEventReservations.ts` (prior to this fix):
- `nonHalftimeRanked = ranked.filter(c => !isHalftimeMarket(c))` — filtered only halftime
- Corners/props/exact-score/goalscorer candidates could rank as `best` anchor
- Corners candidate was normalized into the event group via `canonical_event_key = pair:switzerland-vs-canada:...`
- Result: RESERVED reservation with a corners market anchor

`future_reservations > 0` was incorrectly treated as a GO/ARMED_WAITING signal.

### Fix Applied

| File | Change |
|---|---|
| `lib/executor/nightEventReservations.ts` | Added `isForbiddenAnchorMarket()` = halftime ∨ corners ∨ props. Replaced `nonHalftimeRanked`/`isHalftimeMarket` with `executableAnchorRanked`/`isForbiddenAnchorMarket`. If no executable anchor exists for an event group → skip with `skipped_no_executable_anchor`. |
| `scripts/contur3/run-overnight-battle-audit.mjs` | Added `classifyReservationAnchor()`, counts `future_forbidden_count` / `future_valid_executable_count`. New verdict: `BLUE_MODEL_NO_GO_FORBIDDEN_RESERVATION_MARKETS` when all future reservations have forbidden anchors. |
| `scripts/contur3/why-no-bets-last-night.mjs` | Added same classification + root_cause_stage `RESERVATIONS_FORBIDDEN_MARKET_ANCHORS`. |
| `scripts/contur3/verify-live-market-guards.mjs` | Extended to 20 test cases including Switzerland/Canada corners, exact score, goalscorer, telemetry false-positive guard. |
| `docs/ops/BLUE_MODEL_DAILY_RUNBOOK.md` | Added reservation anchor guard rule, incident note, roadmap P1 item. |

### Key Rule Added

**`future_reservations_count > 0` is NOT a GO signal.**
`future_valid_executable_reservations_count > 0` is required.

### Roadmap

**P1:** Durable Supabase battle audit with `trace_id` column in `night_event_reservations` and `event_execution_queue` — links each reservation to its rebalance queue row and order event. Currently battle log is local JSONL only.

---

## 2026-06-24 (session 2) — Positive Admission Audit + Hardened Funnel Diagnostics

**Validated by:** Claude Code (Sonnet 4.6), session 2026-06-24-2

### Incident Classification

**Positive admission risk after forbidden-anchor fix (ea8f444):**

After ea8f444 blocked corners/halftime/props as reservation anchors, a new risk class appeared:
valid full-match markets (spread/moneyline/total goals) might themselves be blocked BEFORE reaching
the reservation planner — e.g., by MISSING_GAME_START, UNKNOWN_SCOPE, BAD_BUCKET_COV_PRICE, or
shadow row fallback failures. The audit/diagnostic layer was not distinguishing this from
RESERVATIONS_MISSING, leading to an ambiguous NO_GO verdict.

### Changes Applied

| File | Change |
|---|---|
| `scripts/contur3/reservation-admission-audit.mjs` | NEW — positive admission audit script. Queries generated_signal_pairs, mirrors buildFireModelCandidates filter logic, classifies each candidate, groups by event, reports rejection histogram and future_valid_executable_event_count. |
| `scripts/contur3/verify-live-market-guards.mjs` | Extended to 26 test cases. Added 6 positive admission cases (pair spread, pair moneyline, pair total goals, pair winner, single-team spread resolved from eventTitle) and outright winner block. |
| `scripts/contur3/why-no-bets-last-night.mjs` | Added `VALID_MARKETS_FILTERED_BEFORE_RESERVATION` root cause stage. Distinguishes from RESERVATIONS_MISSING when football signals exist but 0 reservations. |
| `scripts/contur3/run-overnight-battle-audit.mjs` | Added `BLUE_MODEL_NO_GO_VALID_MARKETS_FILTERED` verdict. Detects football signals present + 0 reservations case. |
| `package.json` | Added `contur3:reservation-admission-audit` script. |
| `docs/ops/BLUE_MODEL_DAILY_RUNBOOK.md` | Added complete funnel stage map, valid-market admission audit section, full GO/NO_GO table with all 8 verdicts. |

### No Code Patch in buildFireModelCandidates / nightEventReservations

**Reason:** Code analysis confirms positive admission logic is already correct for valid markets.
`deriveMatchFamilyKey` already resolves single-team spreads via `diagnostics.eventTitle`.
`isForbiddenAnchorMarket` (ea8f444) correctly allows spread/moneyline/total.
Audit script will prove admission when run with Supabase access.

Known risk to verify at runtime: if production signals store game start as `game_start_iso`
(snake_case) instead of `gameStartIso` (camelCase), `MISSING_GAME_START` would block all WC rows.
The audit script checks BOTH field name variants.

### Key Rule

**Complete funnel verification required before declaring ARMED_WAITING:**
1. `future_valid_executable_event_count > 0` (from reservation-admission-audit)
2. `future_valid_executable_reservations > 0` (from overnight-battle-audit)
3. No forbidden active queue rows
- stdout/stderr captured and saved in JSON report

**Operator action required:**
1. In Railway → `ops-report-email-cron` → Variables: confirm `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EMAIL_FROM` are set (no executor secret needed)
2. Start Command must be: `node scripts/contur3/run-ops-report-email.mjs`
3. After next run, check `modeling/fire_runs/contur3-blue-model/<timestamp>_ops_report_email.json` for verdict and stdout/stderr

Email is a **monitoring rail**, not an execution gate. Ireland watcher is unaffected by email failures.

---

## 2026-06-24 (session 3) — Continuous Rebalance Window Hardening

**Validated by:** Claude Code (Sonnet 4.6), session 2026-06-24-3

### Risk Classification

**Event-rebalance-cron schedule gaps cause MISSED_REBALANCE_WINDOW.**

If the Railway cron for `contur3-event-rebalance-cron` runs only in certain daypart windows (e.g., every 5 min during pre-kickoff hours only), reservations expire without being queued. The `isDueForRebalance()` function has a T-70..T-5 window — a 65-minute gap is enough for one missed run to cause a full session blackout if the cron does not fire during that window.

### Changes Applied

| File | Change |
|---|---|
| `lib/executor/nightWindow.ts` | `REBALANCE_MINUTES_BEFORE_START`: 60 → 70. `LATEST_ENTRY_MINUTES_BEFORE`: 5 → 3. Due window is now T-70..T-3. Updated `isDueForRebalance` docstring. Added process schedule rule comment. |
| `lib/executor/eventExecutionQueue.ts` | Added `due_window_state: "BEFORE_WINDOW"` to `NextDueReservation` interface. Added `future_valid_reservations_count` to `RebalanceRunResult` interface and both return points. Updated header comment. |
| `scripts/contur3/run-event-rebalance.mjs` | Reads `expired_count` + `future_valid_reservations_count` from API response. Emits `REBALANCE_SCHEDULE_GAP_RISK` warning if `expired_count > 0`. Both added to battle log. |
| `scripts/contur3/blue-model-status.mjs` | Added `expired_count`, `future_valid_reservations_count`, `rebalance_schedule_gap_risk` to `rebalance_dry_run` report block. Prints `REBALANCE_SCHEDULE_GAP_RISK` warning when detected. |
| `scripts/contur3/run-overnight-battle-audit.mjs` | Added `missedRebalanceCount` (EXPIRED reservations). Added new verdict `BLUE_MODEL_NO_GO_REBALANCE_DUE_BUT_NO_QUEUE` with `rootCauseStage = MISSED_REBALANCE_WINDOW`. Added `missed_rebalance_count` + `rebalance_schedule_gap_risk` to battle log. |
| `scripts/contur3/why-no-bets-last-night.mjs` | Added `MISSED_REBALANCE_WINDOW` root cause (before `REBALANCE_QUEUE_MISSING`). Triggers when reservations exist, queue is empty, and EXPIRED reservations exist. |
| `scripts/contur3/rebalance-window-audit.mjs` | NEW — standalone audit. Queries all reservations, classifies each as BEFORE_WINDOW / IN_WINDOW / EXPIRED. Detects schedule gaps. Outputs JSON+MD. Exit 1 if gap risk. |
| `package.json` | Added `contur3:rebalance-window-audit` script. |
| `docs/ops/BLUE_MODEL_DAILY_RUNBOOK.md` | Added canonical cron schedule (`* * * * *`), T-70/T-3 rule, process vs. business window principle table, `MISSED_REBALANCE_WINDOW` funnel stage, `BLUE_MODEL_NO_GO_REBALANCE_DUE_BUT_NO_QUEUE` verdict, rebalance window audit section, updated pipeline diagram. |

### Key Rules Added

**Process schedule ≠ business entry window (LOCKED PRINCIPLE):**
- Process schedule: continuous 24/7 — Railway cron must be `* * * * *`
- Business entry window: T-70m to T-3m, enforced by `isDueForRebalance()` in code

If cron fires outside a game's T-70..T-3 window → `isDueForRebalance()` returns false → rebalance runs safely with 0 due events. No duplicate queue rows (idempotency via `alreadyQueued` set).

If cron has daypart gaps → reservations in that window expire → `MISSED_REBALANCE_WINDOW` → `BLUE_MODEL_NO_GO_REBALANCE_DUE_BUT_NO_QUEUE`.

### Operator Action Required

1. In Railway → `contur3-event-rebalance-cron` → Settings → Cron Schedule: set to `* * * * *`
2. Verify by running `npm run contur3:rebalance-window-audit` and confirming verdict `BEFORE_WINDOW_OK` or `IN_WINDOW_REBALANCE_EXPECTED` (not `REBALANCE_SCHEDULE_GAP_RISK`)

---

## 2026-06-23 — Live-priority ledger: Supabase source fix (session 4)

**Validated by:** Claude Code (Sonnet 4.6), session 2026-06-23

### Bug Found and Fixed

| Field | Value |
|---|---|
| Broken script | `scripts/resolve-signals.ts` — `--priority-live-ledger` path |
| Old wrong behavior | Read `modeling/morning_model_report/20260618_0600UTC/tables/night_execution_detail.csv` — a hardcoded old report OUTPUT used as INPUT |
| Failure on Railway | `LIVE_PRIORITY_LEDGER_ARTIFACT_MISSING` — Railway filesystem is ephemeral, old CSV never exists |
| New correct behavior | Query `executor_order_events` Supabase table, last 24h, `dry_run=false`, `live_confirm=true OR success=true` |

### Source of Truth

| Table | Purpose |
|---|---|
| `executor_order_events` | All order events from Ireland watcher. Live bets have `dry_run=false` and `live_confirm=true` or `success=true`. Columns: `token_id`, `order_status`, `market_slug`, `selected_side`, `candidate_snapshot_json` (has `condition_id`, `event_slug`). |

### Resolver Behavior After Fix

| Case | Log | Exit |
|---|---|---|
| Live bets found in last 24h | `LIVE_PRIORITY_LEDGER_SUPABASE_ROWS_LOADED count=<n>` | 0 |
| No live bets last 24h (ARMED_WAITING) | `LIVE_PRIORITY_LEDGER_SUPABASE_EMPTY_LAST_24H` | 0 |
| Supabase query failed | `LIVE_PRIORITY_LEDGER_SUPABASE_QUERY_FAILED: <msg>` | 1 |

### Bounded Test Result

```
npx tsx scripts/resolve-signals.ts --priority-live-ledger --dedupe-strict --limit=5 --max-updates=5
→ LIVE_PRIORITY_LEDGER_SUPABASE_EMPTY_LAST_24H  (ARMED_WAITING, no live bets yet)
→ EXIT 0
```
No `ARTIFACT_MISSING`. No old CSV reference.

### Fresh Artifact Generation (morning-model-report)

Confirmed: `morning-model-report.ts` fetches Supabase data (`fetchAllResolvedRows`), writes fresh CSV/MD/XLSX to `modeling/morning_model_report/<current_run>/`, then sends email. Email is always last. Old CSV is never an input.

### Build/Verification

| Check | Result |
|---|---|
| `npm run build` | PASS |
| `git diff --check` | PASS (LF/CRLF warnings only) |
| `node -c run-ops-report-email.mjs` | SYNTAX_OK |
| Bounded resolver test | EXIT 0 — correct Supabase path |

### Commit

`Ops: source email live priority from Supabase bets ledger`

### Next Railway Action

Deploy latest `main` → Railway `ops-report-email-cron` → **Run now** → inspect JSON report at `modeling/fire_runs/contur3-blue-model/<timestamp>_ops_report_email.json`.

### Final Verdict

```
BLUE_MODEL_V0_CODE_VALIDATED_SECRET_RUNTIME_PENDING
```

Meaning:
- Code is correct and safe for supervised daily live mode
- Runtime validation with real secret requires Railway environment
- NOT yet unattended/institutional-grade (P1/P2 backlog remains)

---

## 2026-06-23 — England vs Ghana incident: market guard hardening (session 5)

**Validated by:** Claude Code (Sonnet 4.6), session 2026-06-23

### Incident Summary

| Field | Value |
|---|---|
| Event | England vs Ghana, WC 2026 group stage |
| Expected selection | Spread: England (-1.5) — valid Tier1, full-match core spread |
| Actual selection | O/U 8.5 Total Corners — forbidden market |

### Root Causes (both fixed in commit 55844ac)

**Bug 1 — Full-JSON halftime scan false positive:**
`isHalftime()` scanned entire JSON including metric fields (`delta1hPp`, `price1hAgo`). "1hPp" triggered `\b1st[\s-]half` pattern. Result: spread candidate blocked with `HALFTIME_NOT_LIVE_EXECUTABLE`, corners candidate not blocked and selected by ranking.

**Fix:** `isHalftime()` now checks only market identity fields: `market_slug`, `event_slug`, `match_family_key`, `diagnostics.marketTitle/marketType/question/title`. No full JSON scan.

**Bug 2 — Corners filter ran after sort:**
`isCorners()` was missing entirely; halftime filter was the only gate. With spread falsely halftime-blocked, corners was the top-ranked surviving candidate.

**Fix:** Added `isCorners()`. `isExecutableMarket()` now returns `{executable, rejectReason}` and checks corners BEFORE ranking (filter runs before `.sort(compareCandidateQuality)`).

**Bug 3 — Single-team spread identity resolves WEAK:**
"Spread: England (-1.5)" has no "vs" in market title → `SINGLE_TEAM_SPREAD_RE` path → `WEAK` key → `WEAK_MATCH_FAMILY_KEY_LIVE_BLOCKED` → `live_eligible=false`. Spread removed before market selection.

**Fix:** `deriveMatchFamilyKey()` Priority 2b now checks `diagnostics.eventTitle` and `researchContext.eventTitle/eventSlug` for "vs" pair before falling to WEAK. If found → returns `pair:team1-vs-team2:date` (STRONG or MEDIUM key). "England vs Ghana" in diagnostics → `pair:england-vs-ghana:2026-06-23` → live eligible.

### Regression Guard

```bash
npm run contur3:verify-live-market-guards
```

8 test cases covering: England/Ghana spread (EXECUTABLE), corners (CORNERS_NOT_LIVE_EXECUTABLE), halftime variants (HALFTIME_NOT_LIVE_EXECUTABLE), moneyline (EXECUTABLE), metrics-in-diagnostics spread (EXECUTABLE).

### Files Changed

| File | Change |
|---|---|
| `lib/executor/eventExecutionQueue.ts` | `CORNERS_MARKET_RE`, `isCorners()`, `isHalftime()` identity-only, `isExecutableMarket()` returns `{executable, rejectReason}`, corners blocked before sort |
| `lib/executor/buildFireModelCandidates.ts` | Priority 2b: eventTitle "vs" pair check before WEAK fallback |
| `scripts/contur3/verify-live-market-guards.mjs` | New regression guard script |
| `scripts/contur3/run-event-rebalance.mjs` | Daily battle log JSONL |
| `scripts/contur3/run-night-reservations.mjs` | Daily battle log JSONL |
| `scripts/contur3/blue-model-status.mjs` | Daily battle log JSONL |
| `package.json` | `contur3:verify-live-market-guards` script |
| `docs/ops/BLUE_MODEL_DAILY_RUNBOOK.md` | Market guard rules, regression test, battle log docs |

### Build/Verification

| Check | Result |
|---|---|
| `npm run build` | PASS |
| `npm run contur3:verify-live-market-guards` | CONTUR3_MARKET_GUARD_REGRESSION_PASS (8/8) |

---

## Remaining Backlog

### P1

- [ ] Runtime validation of `contur3:blue-status` with real secret (Railway shell)
- [ ] Diagnose and fix `ops-report-email-cron` Railway failure (check RESEND_API_KEY, EMAIL_FROM env vars)
- [ ] `trace_id`/`run_id` chain for end-to-end audit
- [ ] Tighten 6273711 side-mapping (unknown block logging)

### P2

- [ ] WC side-market / corners policy (when to enable)
- [ ] Ice/Fire/Wise staking/vault integration
- [ ] Supabase durable audit tables for contur3 run history
- [ ] `contur3:night-reservations` dryRun support (endpoint pending)
- [ ] Richer queue diagnostics (market liquidity, time-to-close)
