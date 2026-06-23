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

Required env var (Railway): `EXECUTOR_CANDIDATES_SECRET` (or `EXECUTOR_SECRET` / `PPP_SECRET`).

---

## npm Commands

```bash
# Status check (read-only, safe to run anytime)
npm run contur3:blue-status

# Manually trigger night reservations (CEO_APPROVED)
npm run contur3:night-reservations

# Manually trigger event rebalance (live, dryRun=false)
npm run contur3:event-rebalance
```

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
