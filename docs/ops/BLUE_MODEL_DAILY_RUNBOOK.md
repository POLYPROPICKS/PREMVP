# Blue_model / Contur3 Daily Operations Runbook

**Last updated:** 2026-06-24 (funnel trace audit + battle_trace_id in diagnostics + roadmap gate discipline)
**Canonical pipeline:** signal-cache → night_event_reservations → event_execution_queue → Ireland watcher

---

## Canonical Pipeline

```
signal-cache-cron
    └─► generated_signal_pairs (Supabase)
            └─► night-event-reservations cron (16:35 Minsk)
                    └─► night_event_reservations (Supabase)
                            └─► event-rebalance-cron (continuous 24/7 — * * * * *)
                                    └─► event_execution_queue (Supabase)
                                            └─► /api/executor/queue  ← Ireland watcher reads HERE
```

Ireland watcher (`contur3_battle_queue_only_watcher.py`) reads **only** `/api/executor/queue`.
It does NOT call night-reservations or rebalance directly.

---

## Daily Sequence

| Time (Minsk / UTC+3) | Action |
|---|---|
| Throughout day | `signal-cache-cron` refreshes `generated_signal_pairs` |
| ~16:35 | `contur3-night-reservations-cron` runs → populates `night_event_reservations` |
| ~17:00 | Planning window — verify with `npm run contur3:blue-status` |
| Continuous 24/7 | `contur3-event-rebalance-cron` polls every 1 min → fills `event_execution_queue` when events enter T-70..T-3 window |
| Execution | Ireland watcher polls `/api/executor/queue` and fires orders |

---

## Railway Start Commands

**Night reservations cron** (`contur3-night-reservations-cron`):
```
node scripts/contur3/run-night-reservations.mjs
```

**Event rebalance cron** (`contur3-event-rebalance-cron`):
```
node scripts/contur3/run-event-rebalance.mjs
```

**Canonical Railway cron schedule for `contur3-event-rebalance-cron`:**
```
* * * * *
```
(every 1 minute — continuous 24/7)

**CRITICAL PRINCIPLE — Process schedule vs. business entry window:**

| Concept | Rule |
|---|---|
| **Process schedule** | Continuous 24/7. Railway cron MUST be `* * * * *`. Do NOT restrict to daypart windows. |
| **Business entry window** | T-70m to T-3m before each game start. Enforced in code by `isDueForRebalance()` in `nightWindow.ts`. |

`isDueForRebalance()` returns true only when a reservation is between T-70m and T-3m from game start.
If the cron fires outside an event's window, the rebalance safely does nothing (no due reservations found).
Daypart-restricted cron schedules cause `MISSED_REBALANCE_WINDOW` — reservations expire before they are queued.

**Ops report email cron** (`ops-report-email-cron`):
```
node scripts/contur3/run-ops-report-email.mjs
```
(monitoring rail — email failure does not affect Ireland watcher)

**Pipeline sequence (deterministic, filesystem-first):**
```
1. resolve:signals:live-priority  — query executor_order_events (Supabase, last 24h)
                                     → prioritize resolving condition_id::token_id pairs
                                     → no bets last 24h: SUPABASE_EMPTY_LAST_24H, continue
2. resolve:signals:cron           — resolve expired signals from generated_signal_pairs
3. verify:resolver-pipeline       — validate resolver state (read-only)
4. morning:model-report           — fetch Supabase → write CSV/MD/XLSX under
                                     modeling/morning_model_report/<current_run>/
                                     → send email via Resend (LAST STEP)
```
Artifacts are always written to filesystem before email is sent.
Old report CSV is NEVER used as input. All data comes from Supabase.
If no live bets in last 24h: resolver continues with empty target list (not an error).

**Required Railway env vars** (ops-report-email-cron service → Variables):
- `SUPABASE_URL` — DB connection for signal resolver and report scripts
- `SUPABASE_SERVICE_ROLE_KEY` — DB service key
- `RESEND_API_KEY` — Resend API key for email transport
- `EMAIL_FROM` — verified sender address (e.g. `noreply@yourdomain.com`)
- `MORNING_MODEL_EMAIL_TO` or `FOUNDER_EMAIL_TO` — optional; defaults to `alexgrushin@gmail.com`

**No executor secret required.** The ops email pipeline is CLI-only and does not call any PREMVP executor endpoints.

**JSON report location:**
```
modeling/fire_runs/contur3-blue-model/<timestamp>_ops_report_email.json
```

**How to interpret runner output:**
| Verdict | Meaning |
|---|---|
| `OPS_REPORT_EMAIL_OK` | Pipeline ran, email sent |
| `OPS_REPORT_EMAIL_FAIL` | Pipeline ran but failed (see JSON report stdout/stderr) |
| `OPS_EMAIL_CODE_VALIDATED_RUNTIME_ENV_PENDING` | Missing env vars — check JSON `missing_env_names` |

Do NOT use `node -e` / ad-hoc curl snippets as permanent Railway cron commands.

---

## npm Commands

```bash
# ══ CANONICAL FORENSIC — run first when betting chain is unclear ══
npm run contur3:funnel-trace-audit
# → Answers "why did/didn't a bet happen?" in one command.
# → Outputs JSON/MD/CSV to modeling/fire_runs/contur3-blue-model/
# → Optional: CONTUR3_LOOKBACK_HOURS=48 CONTUR3_EVENT_FILTER=scotland npm run contur3:funnel-trace-audit

# Status check (read-only, safe to run anytime)
npm run contur3:blue-status

# Rebalance window audit (check for MISSED_REBALANCE_WINDOW / schedule gaps)
npm run contur3:rebalance-window-audit

# Why no bets last night? (lookback only — use funnel-trace-audit for forward + backward)
npm run contur3:why-no-bets-last-night

# Overnight battle audit (comprehensive — queue + orders + reservations + signals)
npm run contur3:overnight-battle-audit

# Reservation admission audit (why are signals not becoming reservations?)
npm run contur3:reservation-admission-audit

# Manually trigger night reservations (CEO_APPROVED)
npm run contur3:night-reservations

# Manually trigger event rebalance (live, dryRun=false)
npm run contur3:event-rebalance

# Ops report email (monitoring rail only — NOT an execution gate)
npm run contur3:ops-report-email

# Market guard regression test (run after any change to executor queue logic)
npm run contur3:verify-live-market-guards
```

### IMPORTANT: Local status must be run from PREMVP repo

Correct repo: `C:\WORK\KalshiProPulse\sipropicks-premvp1-1`

Do NOT run `npm run contur3:blue-status` from Ireland (`~/polymarket-executor`).
That repo has no PREMVP scripts — "Missing script: contur3:blue-status" is expected there, not a bug.

### ops-report-email is a monitoring rail, not an execution gate

- `npm run contur3:ops-report-email` spawns the morning email pipeline and saves a JSON log.
- If email fails, Ireland watcher continues unaffected — use filesystem reports and `npm run contur3:blue-status` instead.
- Do NOT use ad-hoc `node -e` / curl snippets as permanent Railway cron commands.
- Railway Green UI logs may be inaccessible; repo scripts save JSON reports to `modeling/fire_runs/contur3-blue-model/`.

---

## GO / NO_GO Rules

| Verdict | Condition | Action |
|---|---|---|
| `BLUE_MODEL_GO_READY` | ≥1 candidate, source=event_execution_queue, contract valid | Ireland watcher can fire |
| `BLUE_MODEL_ARMED_WAITING` | 0 candidates but next_due_iso present OR valid reservations exist | Normal — wait for game window |
| `BLUE_MODEL_NO_GO` | Endpoint error OR source ≠ event_execution_queue OR contract missing | STOP. Investigate. |
| `BLUE_MODEL_NO_GO_SIGNALS_MISSING` | 0 signals in generated_signal_pairs | Check signal ingestion cron |
| `BLUE_MODEL_NO_GO_VALID_MARKETS_FILTERED` | Signals exist but 0 reservations, valid markets may be blocked upstream | Run `contur3:reservation-admission-audit` |
| `BLUE_MODEL_NO_GO_RESERVATIONS_MISSING` | Signals exist, 0 future reservations | Run forceRebuild on night-reservations-cron |
| `BLUE_MODEL_NO_GO_FORBIDDEN_RESERVATION_MARKETS` | future_reservations > 0 but ALL have forbidden anchors | Deploy planner fix + forceRebuild |
| `BLUE_MODEL_NO_GO_REBALANCE_QUEUE_MISSING` | Valid reservations but 0 queue rows | Check rebalance cron timing |
| `BLUE_MODEL_NO_GO_REBALANCE_DUE_BUT_NO_QUEUE` | Reservations expired as MISSED_REBALANCE_WINDOW | Fix Railway cron → `* * * * *` |
| `BLUE_MODEL_NO_GO_FORBIDDEN_ACTIVE_QUEUE` | READY/CLAIMED/SENT queue rows have forbidden markets | Emergency stop + investigate |

---

## Allowed Markets (current contract)

- **Tier 1 only** — no Tier2, no Tier3
- **Full-match / game-level only**
- **No halftime**, no first-half
- **No corners**, no props, no futures, no outrights
- Kalshi soccer markets for WC 2026 events in the planning horizon

### Permanent Market Guard Rules (as of 2026-06-23)

**Halftime block** — `HALFTIME_MARKET_RE` applied to: `market_slug`, `event_slug`, `match_family_key`, `diagnostics.marketTitle/marketType/question/title` ONLY. Never scans full JSON (prevents false positives from metric field names like `delta1hPp`, `price1hAgo`).

**Corners block** — `CORNERS_MARKET_RE` applied to: `market_slug`, `event_slug`, `match_family_key`, `diagnostics.marketTitle/question`. Corners block runs **before** quality ranking so a corners market can never outrank a spread.

**England vs Ghana incident (2026-06-23):** Valid core spread "Spread: England (-1.5)" was blocked as WEAK identity because market title had no "vs". Fixed: `deriveMatchFamilyKey()` checks `diagnostics.eventTitle` for "vs" pair before falling to WEAK — upgrades to `pair:team1-vs-team2:date` key (STRONG/MEDIUM). Corners market was also selected over spread due to full-JSON halftime scan false-positive. Both fixed in commit 55844ac.

### Market Guard Regression Test

```bash
npm run contur3:verify-live-market-guards
```

Run this after any change to `lib/executor/eventExecutionQueue.ts`, `buildFireModelCandidates.ts`, or `nightEventReservations.ts`. Exit 0 = `CONTUR3_MARKET_GUARD_REGRESSION_PASS`. Exit 1 = fix before deploy. Currently 20 test cases.

**Blocked market categories (pre-ranking filter, applied at BOTH reservation planner and execution queue):**
1. `HALFTIME_NOT_LIVE_EXECUTABLE` — halftime, half-time, first half, 1st half
2. `CORNERS_NOT_LIVE_EXECUTABLE` — corners, total corners
3. `PROP_NOT_LIVE_EXECUTABLE` — exact score, goalscorer, player shots/assists, outrights

### Reservation Anchor Guard (CRITICAL — 2026-06-24 addition)

**Rule:** `future_reservations > 0` is NOT a GO signal alone. You must check `future_valid_executable_reservations > 0`.

**Incident (2026-06-24):** After forceRebuild was fixed, reservation planner created RESERVED rows with corners anchor ("Switzerland vs Canada: O/U 9.5 Total Corners", event_tier=TIER1, event_score=82). These reservations would never execute (rebalance skips forbidden markets) — but the audit was reporting ARMED_WAITING, masking the real funnel break.

**Root cause:** `nightEventReservations.ts` filtered only halftime from anchor candidates but NOT corners/props/exact-score. The corners candidate (normalized into the pair event group via `canonical_event_key`) could outrank a spread and become the reservation anchor.

**Fix (commit after b37b6d5):** `isForbiddenAnchorMarket()` replaces `isHalftimeMarket()` in anchor selection. If no executable anchor exists for an event group, the event is skipped with `NO_EXECUTABLE_RESERVATION_ANCHOR`. The forbidden anchor check inspects ONLY identity fields: `market_slug`, `event_slug`, `match_family_key`, `diagnostics.marketTitle`. Never full JSON.

**Verdict mapping for forbidden reservations:**
- `BLUE_MODEL_NO_GO_FORBIDDEN_RESERVATION_MARKETS` — future reservations exist but all have forbidden anchors
- root_cause_stage = `RESERVATIONS_FORBIDDEN_MARKET_ANCHORS`
- Action: run forceRebuild after planner fix is deployed

### Overnight Battle Audit

```bash
npm run contur3:overnight-battle-audit
```

Comprehensive one-command audit: queue status, forbidden active rows, order ledger, reservations, upcoming candidates. Writes JSON/CSV/MD + daily JSONL. Exit 0 = GO_READY or ARMED_WAITING.

**NO_FUTURE_RESERVATIONS warning:** If audit reports this, it means `night_event_reservations` has no future rows. Night-reservations cron must run before T-60 of the earliest upcoming match. Trigger via Railway "Run Now" on `contur3-night-reservations-cron`.

**FORBIDDEN_RESERVATION_ANCHORS warning:** If `future_forbidden_count > 0` and `future_valid_executable_count = 0`, the verdict is `BLUE_MODEL_NO_GO_FORBIDDEN_RESERVATION_MARKETS`. Deploy the planner fix, then run forceRebuild.

### Valid Market Admission Audit (P0 gate)

```bash
npm run contur3:reservation-admission-audit
```

One-command proof that valid markets (spread/moneyline/total) are admitted into the reservation planner. Run before any overnight session when reservations are missing. Outputs funnel matrix with per-candidate reject reasons and event group samples.

**Root cause stages reported:**

| Stage | Meaning |
|---|---|
| `ADMISSION_OK` | Valid executable anchors exist in future event groups — proceed |
| `VALID_MARKETS_FILTERED_BEFORE_RESERVATION` | Valid markets blocked upstream — check rejection histogram (MISSING_GAME_START / UNKNOWN_SCOPE / LOW_SCORE / BAD_BUCKET) |
| `SIGNALS_MISSING` | No signal rows at all |

**Key blockers to check in rejection histogram:**

- `MISSING_GAME_START` — `diagnostics.gameStartIso` missing or null for WC rows; check if stored as `game_start_iso` (snake_case) instead
- `UNKNOWN_SCOPE` — market can't be classified as WC/SOCCER; likely missing country pair text in identity fields
- `BAD_BUCKET_COV_PRICE` — entry_price in 0.44–0.58 AND coverage 50–74 together; signal model issue
- `SHADOW_FALLBACK_INCOMPLETE` — shadow-strategic-sports-v1 row missing `condition_id` / `selected_token_id` / game start

**Allowed anchor markets (must admit):**
- Full-match winner/moneyline: "Team A vs Team B: Winner", "Match Winner"
- Full-match spread: "Spread: Team A (-1.5)", "Team A vs Team B: Spread Team A -1.5"
- Full-match total goals: "Team A vs Team B: Total Goals Over 2.5"

**Forbidden anchor markets (must reject at reservation stage):**
- Halftime/1H: any halftime, half-time, first half, 1st half
- Corners: any O/U corners, total corners
- Props: exact score, goalscorer, anytime scorer, player props, outrights

### Funnel Stages (complete)

```
SIGNALS_MISSING
  → VALID_MARKETS_FILTERED_BEFORE_RESERVATION   (upstream filter in buildFireModelCandidates)
      → RESERVATIONS_MISSING                    (forceRebuild needed or cron not run)
          → RESERVATIONS_FORBIDDEN_MARKET_ANCHORS (all reservations are corners/halftime/props)
              → MISSED_REBALANCE_WINDOW          (reservations expired before rebalance ran — cron gap)
                  → REBALANCE_NO_EXECUTABLE_MARKET   (rebalance found no due TIER1 live-eligible market)
                      → QUEUE_READY_BUT_IRELAND_NO_ORDER (Ireland not consuming queue)
                          → ORDERS_SENT
```

### Rebalance Window Audit

```bash
npm run contur3:rebalance-window-audit
```

Checks whether all reservations have a valid rebalance window ahead. Run when `BLUE_MODEL_NO_GO_REBALANCE_DUE_BUT_NO_QUEUE` or `MISSED_REBALANCE_WINDOW` is detected.

**Verdicts:**

| Verdict | Meaning | Action |
|---|---|---|
| `BEFORE_WINDOW_OK` | All reservations have a future T-70..T-3 window | No action |
| `IN_WINDOW_REBALANCE_EXPECTED` | Event(s) currently in T-70..T-3 — rebalance should run | Verify cron fired or run manually |
| `REBALANCE_SCHEDULE_GAP_RISK` | Reservations expired without being queued | Fix Railway cron → `* * * * *` |

**Canonical cron schedule (LOCKED):**
```
* * * * *
```
Set in Railway → contur3-event-rebalance-cron → Settings → Cron Schedule.

**Root cause stages reported:**
- `MISSED_REBALANCE_WINDOW` — reservation expired (status=EXPIRED, reason=MISSED_REBALANCE_WINDOW) before rebalance ran
- `REBALANCE_SCHEDULE_GAP_RISK` — any expired count > 0 indicates a cron gap

---

## Forensic Architecture and Trace IDs

### Observability Storage Layers

| Layer | What it is | How to access |
|-------|-----------|--------------|
| **Filesystem JSONL** | Local battle log per day | `modeling/fire_runs/contur3-blue-model/contur3_battle_YYYY-MM-DD.jsonl` |
| **Filesystem JSON/MD/CSV** | Per-run audit artifacts | `modeling/fire_runs/contur3-blue-model/<timestamp>_*.{json,md,csv}` |
| **Railway logs** | HTTP-level cron stdout | Railway dashboard → service → logs |
| **Supabase (source of truth)** | Persistent state — reservations, queue, orders | `night_event_reservations`, `event_execution_queue`, `executor_order_events` |
| **Computed trace key** | Deterministic correlation key (not persisted) | Computed by `funnel-trace-audit.mjs` at read time |
| **Durable trace ID** | `battle_trace_id` in `diagnostics` JSON | Written by producer since 2026-06-24 — NO schema migration required |

### Trace ID Status (as of 2026-06-24)

**Durable `battle_trace_id` is now written to `diagnostics` JSON in both producer tables:**

| Table | When written | Format |
|-------|-------------|--------|
| `night_event_reservations` | At reservation creation | `contur3:<plan_run_id>:<match_family_key>:unknown:unknown` |
| `event_execution_queue` | At rebalance queue row creation | `contur3:<plan_run_id>:<match_family_key>:<condition_id>:<token_id>` |

**No schema migration was required** — both tables already had `diagnostics jsonb` column.

**Computed `battle_trace_key` (read-time, not persisted):**
```
contur3:<plan_run_id>:<match_family_key>:<condition_id_or_unknown>:<token_id_or_unknown>
```
Used by `funnel-trace-audit.mjs` for CSV grouping and MD trace examples.

**P1 migration (future — deferred):** Add a top-level `battle_trace_id` column to both tables for indexed lookup. Requires a proper schema migration. Document it as `TRACE_ID_SCHEMA_MIGRATION_REQUIRED` when needed.

### Canonical Forensic Command

```bash
npm run contur3:funnel-trace-audit
```

This is the **single source of truth** for answering "why did/didn't a bet happen?". Run it before any other investigation.

**Optional filters:**
```bash
CONTUR3_LOOKBACK_HOURS=48 npm run contur3:funnel-trace-audit
CONTUR3_EVENT_FILTER=scotland npm run contur3:funnel-trace-audit
CONTUR3_LOOKBACK_HOURS=72 CONTUR3_LOOKAHEAD_HOURS=48 npm run contur3:funnel-trace-audit
```

**Root cause stages (classified in priority order):**

| Stage | Meaning |
|-------|---------|
| `SIGNALS_MISSING` | 0 signals in `generated_signal_pairs` — data ingestion failed |
| `VALID_CANDIDATES_MISSING` | Signals exist but 0 pass allowed full-match filter |
| `RESERVATIONS_MISSING` | Allowed candidates exist but 0 reservations created |
| `RESERVATIONS_FORBIDDEN_MARKET_ANCHORS` | Future reservations exist but ALL are forbidden anchors |
| `VALID_RESERVATIONS_NOT_DUE_YET` | Valid future reservations exist but all BEFORE_WINDOW |
| `REBALANCE_DUE_BUT_NO_QUEUE` | Reservation(s) IN_WINDOW but queue is empty |
| `MISSED_REBALANCE_WINDOW` | Reservation(s) expired (EXPIRED status) without queue row |
| `QUEUE_READY_WAITING_FOR_IRELAND` | READY queue row exists but Ireland not consuming |
| `QUEUE_CLAIMED_NO_ORDER` | CLAIMED/SENT queue rows but no executor_order_events |
| `QUEUE_SENT_ORDER_MISSING` | Real order events but 0 live_confirmed |
| `ORDER_CONFIRMED` | Live order confirmed — chain worked |
| `AUDIT_PARTIAL_TABLE_READ_FAILURE` | Supabase read failed — check env vars |

### Gate Discipline (do not skip)

| Do not patch | Until |
|-------------|-------|
| **Ireland executor** | READY queue row proven to exist, Ireland not consuming it |
| **Email / ops pipeline** | Full betting chain RESERVED → ORDER_CONFIRMED is proven |
| **Rebalance cron** | DUE_NOW or MISSED_WINDOW with no queue is proven by funnel-trace-audit |
| **Reservation planner** | Valid candidates exist but future valid reservations are missing |
| **Stake policy** | Never — locked at $7 TIER1, do not change |
| **Market policy** | Never loosen — corners/halftime/props block is a hard gate |

### Roadmap (P1 migration — durable audit)

**Durable Supabase battle audit with trace_id:** P1 migration task. `battle_trace_id` is now written to `diagnostics` JSON (no schema migration needed). When a top-level indexed `battle_trace_id` column is added, cross-table SQL joins become trivial. Proposed SQL:

```sql
ALTER TABLE night_event_reservations ADD COLUMN battle_trace_id text;
ALTER TABLE event_execution_queue ADD COLUMN battle_trace_id text;
CREATE INDEX ON night_event_reservations (battle_trace_id);
CREATE INDEX ON event_execution_queue (battle_trace_id);
```

Status: `TRACE_ID_SCHEMA_MIGRATION_REQUIRED` — do not auto-apply. Requires explicit founder approval.

---

## CEO Status Summary

| Category | Status |
|---------|--------|
| Signal generation | Proven — `generated_signal_pairs` populated |
| Reservation creation | Proven — future reservations confirmed in Supabase |
| Valid market admission | Proven — forbidden anchor guard hardened (2026-06-24) |
| Rebalance → queue | Unproven — next proof window at T-70m before match start |
| Ireland order | Unproven — requires READY queue row first |
| End-to-end trace | Partial — `battle_trace_id` now in `diagnostics`; full indexed trace pending P1 schema migration |
| Canonical forensic | `npm run contur3:funnel-trace-audit` |

**Next runtime proof time:** Run `npm run contur3:funnel-trace-audit` at T-80m before the earliest reserved match. If `due_now_count > 0` and `queue_ready_count = 0`, run `npm run contur3:event-rebalance`.

**Operator actions required (max 3):**
1. At T-80m before match: run `npm run contur3:funnel-trace-audit` → confirm `VALID_RESERVATIONS_NOT_DUE_YET` transitions to `REBALANCE_DUE_BUT_NO_QUEUE` or `QUEUE_READY_WAITING_FOR_IRELAND`.
2. If `REBALANCE_DUE_BUT_NO_QUEUE`: verify Railway cron is `* * * * *` → run `npm run contur3:event-rebalance`.
3. If `QUEUE_READY_WAITING_FOR_IRELAND`: check Ireland executor is running and polling.

---

## Stake Policy

- Stake is provided by the queue (`stake_usd` field in `/api/executor/queue` response)
- Current cap: **$7 per event**
- Ireland watcher does NOT resize stakes
- No Ireland-side stake overrides

---

## Monitoring

```bash
# Primary: one-line status + JSON report
npm run contur3:blue-status
```

Reports saved to:
```
modeling/fire_runs/contur3-blue-model/<timestamp>_blue_model_status.json
modeling/fire_runs/contur3-blue-model/<timestamp>_night_reservations.json
modeling/fire_runs/contur3-blue-model/<timestamp>_event_rebalance.json
```

**Daily battle log** (one JSONL line per runner invocation):
```
modeling/fire_runs/contur3-blue-model/contur3_battle_YYYY-MM-DD.jsonl
```
Local file only — Railway filesystem is ephemeral. Supabase (`executor_order_events`) is the durable audit trail. The battle log is a session-scoped debugging aid.

---

## Emergency Rollback

```bash
# 1. Soft stop via filesystem flag
touch /tmp/PPP_LIVE_HARD_STOP
touch data/PPP_LIVE_HARD_STOP

# 2. Kill Ireland watcher process
pkill -f "[c]ontur3_battle_queue_only_watcher.py" || true
```

Railway: scale Ireland executor service to 0 replicas in Railway UI.

---

## Known Backlog

- [ ] WC side-market policy (when to enable 1X2 sides vs moneyline)
- [ ] Ops alert email cron (trigger on NO_GO verdict)
- [ ] Persistent Supabase audit table for contur3 run history
- [ ] Richer queue diagnostics (market liquidity, time-to-close)
- [ ] `contur3:night-reservations` dryRun support (endpoint pending)
