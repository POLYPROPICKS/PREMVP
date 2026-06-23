# Blue_model / Contur3 Daily Operations Runbook

**Last updated:** 2026-06-23
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

Required env vars for ops email cron (Railway → service → Variables):
- `EXECUTOR_CANDIDATES_SECRET` (or `EXECUTOR_SECRET` / `PPP_SECRET`) — runner gate
- `RESEND_API_KEY` — Resend API key for email transport
- `EMAIL_FROM` — verified sender address (e.g. `noreply@yourdomain.com`)
- `MORNING_MODEL_EMAIL_TO` or `FOUNDER_EMAIL_TO` — optional; defaults to `alexgrushin@gmail.com`
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — required by resolver sub-scripts

If email fails, inspect saved JSON report:
```
modeling/fire_runs/contur3-blue-model/<timestamp>_ops_report_email.json
```
The report includes exit_code, stdout, stderr, and missing_env_names.

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
| `BLUE_MODEL_ARMED_WAITING` | 0 candidates but next_due_iso present | Normal — wait for game window |
| `BLUE_MODEL_NO_GO` | Endpoint error OR source ≠ event_execution_queue OR contract missing | STOP. Investigate before any live run. |

---

## Allowed Markets (current contract)

- **Tier 1 only** — no Tier2, no Tier3
- **Full-match / game-level only**
- **No halftime**, no first-half
- **No corners**, no props, no futures, no outrights
- Kalshi soccer markets for WC 2026 events in the planning horizon

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
