# Blue_model / Contur3 Daily Operations Runbook

**Last updated:** 2026-06-24 (reservation anchor guard + positive admission audit)
**Canonical pipeline:** signal-cache → night_event_reservations → event_execution_queue → Ireland watcher

---

## Canonical Pipeline

```
signal-cache-cron
    └─► generated_signal_pairs (Supabase)
            └─► night-event-reservations cron (16:35 Minsk)
                    └─► night_event_reservations (Supabase)
                            └─► event-rebalance-cron (every 5 min in windows)
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
| Pre-kickoff windows | `contur3-event-rebalance-cron` runs every 5 min → fills `event_execution_queue` |
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
# Status check (read-only, safe to run anytime)
npm run contur3:blue-status

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
              → REBALANCE_NO_EXECUTABLE_MARKET   (rebalance found no due TIER1 live-eligible market)
                  → QUEUE_READY_BUT_IRELAND_NO_ORDER (Ireland not consuming queue)
                      → ORDERS_SENT
```

### Roadmap (P1 migration — durable audit)

**Durable Supabase battle audit with trace_id:** P1 migration task. Current battle log is local JSONL only (not persisted to Supabase). When trace_id column is added to `night_event_reservations` and `event_execution_queue`, each reservation can be linked to its rebalance queue row and order event for full funnel tracing without running scripts.

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
