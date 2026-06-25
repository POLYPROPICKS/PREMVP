# Blue Model 3 — Battle Contour Reliability Roadmap

_Created: 2026-06-25. Author: forensic reconstruction from git history and overnight ops session._

---

## 1. Executive Verdict

**Status as of 2026-06-25:** Contur3 reservation underfill is **fixed and deployed** (commit `78b192f`, HEAD is `26a01a3`). Production confirmed `reserved_count=7`. However, the 22:00 Minsk matches on 2026-06-24 **did not produce live orders** because reservations did not exist at signal time for those specific matches. No end-to-end order/ledger proof has been obtained. Blue Model 3 defines the gates, tooling, and invariants required to close that gap.

---

## 2. What Happened Overnight (2026-06-24 → 2026-06-25)

| Time (Minsk) | Event |
|---|---|
| Pre-night | Capacity audit revealed `RESERVATION_UNDERFILL_CONFIRMED`: 7 should-have-reservation Tier1 matches, only 2 reservations, 5 gaps |
| Session | Root cause identified: `.limit(300)` cap in `buildFireModelCandidates` + `PLAN_POOL=200` slice caused most physical matches to never reach grouping |
| Fix applied | Commit `78b192f`: full-pagination planning, uncapped `PLAN_POOL`, canonical `physical_match_key`, weak single-team key merge, representative title contamination guard |
| Production deploy | `78b192f` deployed to Railway PREMVP, `EXECUTOR_CANDIDATES_SECRET_PRESENT` confirmed |
| Night run | `npm run contur3:night-reservations` → HTTP 200, `reserved_count=6` initial, then `reserved_count=7` after refresh |
| Rebalance check | `npm run contur3:event-rebalance` before due-window: `due_count=0`, `queued_count=0`, `next_due_iso=2026-06-24T20:50:00Z` |
| Ireland/Lightsail | Confirmed running: `PRE_FLIGHT_GO`, `trusted_puller_pid`, `live_loop_pid`, `CONFIRM_LIVE_ORDER=YES`, `live_enabled=YES`, `all_sports=YES` |
| 22:00 matches | **Two Minsk matches failed.** `generated_signal_pairs` had rows, but `night_event_reservations=0`, `executor_candidate_queue=0`, `order/ledger=0` |
| Root cause (22:00) | Those specific matches were NOT covered by the reservation plan executed that day. Reservation existed for 7 other matches; these 2 were outside scope or not matched by the canonical key |
| Pagination proof | Full-pagination forensic run confirmed capped audit verdicts were invalid; full corpus required for accurate counts |
| Railway active deploy | Later UI/SMS bridge commit (`26a01a3`) became the active Railway deploy; Contur3 fix remains in history |
| ops-report-email-cron | Crashed/failed state as of session end |

**Verdict: `SIGNALS_EXISTED_BUT_NO_RESERVATION_FOR_22_MATCHES`**

---

## 3. What Was Fixed

All fixes are committed and deployed:

| Fix | Commit | File(s) |
|---|---|---|
| Contur3 reservation underfill — `.limit(300)` row cap removed | `78b192f` | `lib/executor/buildFireModelCandidates.ts` |
| Full-pagination planning (72h `created_at` lookback) | `78b192f` | `lib/executor/buildFireModelCandidates.ts` |
| Canonical `physical_match_key` — collapses pair/raw/order-variant | `78b192f` | `lib/executor/nightEventReservations.ts` |
| Weak single-team keys merged (never discarded) | `78b192f` | `lib/executor/nightEventReservations.ts` |
| Representative title contamination guard | `78b192f` | `lib/executor/nightEventReservations.ts` |
| `PLAN_POOL` uncapped ceiling | `78b192f` | `lib/executor/nightEventReservations.ts` |
| Invariant counters: `tier1PhysicalMatchesSeen/Planned/GapsAfterBuild`, `weakKeysMerged`, `representativeTitleReplaced`, `underfillInvariantPass` | `78b192f` | `lib/executor/nightEventReservations.ts` |
| Producer dry-run verified locally (`underfillInvariantPass=true`, `tier1ReservationGapsAfterBuild=0`) | `78b192f` | roadmap only |
| Production reservation run: `reserved_count=7` | — | verified in prod |

---

## 4. What Failed / Remains Unresolved

| Failure | Status |
|---|---|
| 22:00 Minsk matches had signals but no reservations | Root cause: those matches not in the reservation plan for that night. Needs per-match post-mortem tooling to diagnose at-time coverage |
| Rebalance had no queue — because reservations didn't exist for those matches | Consequence of #1 |
| No end-to-end order/ledger proof | No Polymarket order row confirmed; no ledger entry; live bet placement unverified |
| Logs and artifacts scattered | No automatic artifact collector; ops session relied on manual Railway console + one-off scripts |
| Railway active deploy moved beyond Contur3 commit | Current active deploy is `26a01a3` (UI/SMS bridge); Contur3 code is present in repo but later commit is the Railway label |
| `ops-report-email-cron` crashed | Root cause unknown; separate incident; blocking automated daily ops visibility |
| No operator-friendly single-command battle gate | `blue2-battle-gate` referenced in BLUE_MODEL2_ROADMAP but no committed script with that name in `scripts/contur3/` |

---

## 5. Permanent Invariants

These are non-negotiable. Any audit, verdict, or battle report that violates them is **invalid**.

1. **No Tier1 for a real football/WC match = P0 anomaly** — until full-pagination raw DB proof says otherwise.
2. **Reservations fewer than physical Tier1 matches = P0 anomaly** — until full-pagination raw DB proof says otherwise.
3. **Capped corpus verdicts are invalid.** Any audit that uses `.limit(N)` without paginating the full corpus cannot assert "no gaps."
4. **Fuzzy match cannot be used as proof.** "Both say Arsenal" is not evidence of correct key collapse; canonical `physical_match_key` must be used.
5. **Every battle report must show four layers:**
   - `generated_signal_pairs` count
   - `night_event_reservations` count and coverage
   - `executor_candidate_queue` rows with stake
   - `order/ledger` rows in Polymarket + internal ledger
6. **No verdict of "working" without layer 4 (order/ledger) proof.**
7. **Rebalance dry-run before due-window is not a substitute for order proof.** `due_count=0` only means nothing was ready at check time; it does not prove placement.

---

## 6. Required Blue Model 3 Gates

Gates must be met in sequence before any "live battle succeeded" claim.

| Gate | Check | Pass Condition |
|---|---|---|
| **Gate A** | Full-pagination signal census | `generated_signal_pairs` ≥ expected Tier1 matches, paginated corpus |
| **Gate B** | Reservation coverage table | One reservation row per physical Tier1 match; `tier1ReservationGapsAfterBuild=0`; `underfillInvariantPass=true` |
| **Gate C** | Due-window rebalance proof | At T-30/T-4, `due_count` ≥ 1 for each upcoming match; `queued_count` ≥ 1 |
| **Gate D** | Executor queue row with stake | `executor_candidate_queue` has a row with `stake_usdc > 0` for the match |
| **Gate E** | Ireland puller CLAIMED/SENT proof | Ireland log shows `CLAIMED` or `SENT` for the order |
| **Gate F** | Polymarket order/ledger proof | Polymarket API or ledger shows the order row; internal ledger updated |
| **Gate G** | Postmortem artifact written automatically | `/modeling/fire_runs/contur3-battle-YYYYMMDD.json` exists with all 6 gate verdicts |

A "battle succeeded" verdict requires Gates A–F all PASS. Gate G is a process gate (artifact must exist).

---

## 7. Required Tooling (Not Yet Built)

These scripts do not yet exist in `scripts/contur3/`. Each should be a standalone `.mjs`, safe (read-only unless explicitly documented), and committable.

| Script | Purpose | Priority |
|---|---|---|
| `battle-gate.mjs` | Single-command: runs all 7 gates, prints stage table | P0 |
| `match-forensic.mjs` | Given a match slug/date, shows: signals generated, reservation found, queue row, order row | P0 |
| `ireland-readiness.mjs` | SSH-free: polls Ireland health endpoint or reads last-known artifact | P1 |
| `queue-order-ledger.mjs` | Shows `executor_candidate_queue` + `order` + `ledger` for last N hours | P0 |
| `cron-health.mjs` | Lists all cron job last-run timestamps and status from Railway or local diagnostics | P1 |
| `artifact-collector.mjs` | At battle end, gathers all diagnostics into `/modeling/fire_runs/contur3-battle-YYYYMMDD.json` | P1 |
| `ops-report-email-debug.mjs` | Diagnose `ops-report-email-cron` crash root cause | P1 |

---

## 8. Next Implementation Steps

**Rule: short, bounded patches only. No broad rewrite. No live run without queue/ledger visibility.**

### Step 1 — Fix `ops-report-email-cron` (separate incident)
- Inspect crash logs in Railway for the cron job
- Do not conflate with Contur3 fixes
- Fix in isolation; commit separately

### Step 2 — Build `battle-gate.mjs` (single-command gate)
- Aggregates Gates A–G
- Prints stage table
- Read-only: no DB writes
- Add `package.json` entry: `"contur3:battle-gate": "node scripts/contur3/battle-gate.mjs"`

### Step 3 — Build `match-forensic.mjs`
- Input: match slug (e.g. `minsk-vs-x 2026-06-24`)
- Queries: `generated_signal_pairs`, `night_event_reservations`, `executor_candidate_queue`, `order/ledger`
- Output: per-layer table showing why a match did or did not execute

### Step 4 — Build `queue-order-ledger.mjs`
- Shows last N hours of queue rows, orders, and ledger entries
- Allows confirming end-to-end chain without Railway console

### Step 5 — Add commit/deploy visibility to `/api/health`
- Include `GIT_SHA` or `RAILWAY_GIT_COMMIT_SHA` in health response
- Allows confirming which code is running without Railway UI

### Step 6 — Run next battle with all gates
- Do NOT declare victory until Gate F (Polymarket order/ledger) is confirmed
- Use `battle-gate.mjs` output as the proof package

---

## 9. Operator Rules

1. **Max 1–2 commands per decision.** No multi-step manual procedures.
2. **Commands must be paste-safe.** No heredocs in Railway console unless confirmed safe for length.
3. **Use file-write scripts** to avoid Railway console truncation on long outputs.
4. **Every final report must include a stage table** (Gates A–G, PASS/FAIL/UNKNOWN).
5. **No "done" without proof.** Proof = layer table showing `generated_signal_pairs` → `night_event_reservations` → `executor_candidate_queue` → `order/ledger`.
6. **Do not conflate Railway deploy label with code correctness.** Active deployment label is not a gate; gate is the code behavior.
7. **Ireland readiness check before any live battle.** Confirm `PRE_FLIGHT_GO` and `CONFIRM_LIVE_ORDER=YES`.

---

## 10. Current Blockers (as of 2026-06-25)

| Blocker | Severity | Owner |
|---|---|---|
| No end-to-end order/ledger proof for any match | P0 | Blue Model 3 Step 4 |
| `ops-report-email-cron` crashed | P1 | Step 1 |
| `battle-gate.mjs` does not exist | P0 | Step 2 |
| `match-forensic.mjs` does not exist | P0 | Step 3 |
| Active Railway deploy label is `26a01a3` (UI/SMS), not Contur3-specific | Info | Step 5 |
| 22:00 Minsk match failure root cause not forensically confirmed at match-level | P0 | Step 3 |

---

_This file is the single source of truth for Blue Model 3 status. Update after each battle session._
