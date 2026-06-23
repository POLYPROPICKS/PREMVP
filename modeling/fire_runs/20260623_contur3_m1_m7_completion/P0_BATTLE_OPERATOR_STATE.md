# P0 Battle Operator State — Canonical Reference

Generated: 2026-06-23.

---

## Git / Deployment State

| Field | Value |
|---|---|
| origin/main HEAD | `4a8e751 Ops: finalize Contur3 battle launch package` |
| Railway PREMVP deploy | Successful for 4a8e751 |
| PREMVP doctor sentinel | `ALL_PASS_CONTUR3_BATTLE_PREMVP` |
| Ireland verify sentinel | `ALL_PASS_IRELAND_BATTLE_QUEUE_ONLY_VERIFY` |

---

## Queue Source Contract (LOCKED)

| Field | Required Value |
|---|---|
| `source` | `event_execution_queue` |
| `ireland_contract.read_only_source` | `event_execution_queue` |
| `ireland_contract.do_not_rank` | `true` |
| `ireland_contract.do_not_pull_broad_candidates` | `true` |
| `ireland_contract.do_not_apply_tier2_tier3` | `true` |
| `max_stake_usd` | `7` |
| tier allowed | TIER1 only |
| halftime markets | hard-blocked upstream (never enter queue) |

---

## Hard-Stop State

- **Hard-stop is ON** as of 2026-06-23 battle launch
- Ireland watcher will not send live orders while hard-stop is active
- Only `--remove-hard-stop=CEO_APPROVED` removes it
- Rollback command: `touch /tmp/PPP_LIVE_HARD_STOP` on Ireland machine

---

## Next Due Logic

- Rebalance opens at T-60 min before game_start_iso
- Preferred entry at T-45 min
- Latest safe entry at T-5 min
- Queue fills when rebalance runs and RESERVED events enter the T-60 window
- next_due_iso returned by `/api/executor/queue?includeUpcoming=1` shows when next reservation enters rebalance window

---

## Ownership

| Role | Who | Constraint |
|---|---|---|
| Strategy (rank, select, tier, stake) | PREMVP | Decides everything upstream |
| Execution (validate, send, fail-close) | Ireland | Reads queue only, no ranking |
| Reservation plan | PREMVP cron at 17:00 Minsk | Writes `night_event_reservations` |
| Market selection | PREMVP rebalance cron | Writes `event_execution_queue` |
| Order send | Ireland watcher | Reads `event_execution_queue`, marks via `/api/executor/queue/mark` |

---

## Pipeline Flow

```
night_event_reservations  (PREMVP writes at 17:00 Minsk, event-level)
    ↓  T-60 before each game
event_execution_queue     (PREMVP rebalance writes, per-event single market)
    ↓  Ireland reads /api/executor/queue
Ireland watcher           (claims candidate, sends order, marks EXECUTED/FAILED)
    ↓  POST /api/executor/queue/mark
event_execution_queue     (status updated: CLAIMED → EXECUTED or FAILED)
```

---

## Key API Endpoints

| Endpoint | Role | Write? |
|---|---|---|
| `GET /api/cron/night-event-reservations?mode=status` | Plan health read | No |
| `GET /api/cron/event-rebalance?dryRun=1` | Rebalance dry-run | No |
| `POST /api/cron/event-rebalance` | Rebalance write | Yes (PREMVP only) |
| `GET /api/executor/queue?includeUpcoming=1` | Ireland queue read | No |
| `POST /api/executor/queue/mark` | Ireland lifecycle callback | Queue status only |
| `GET /api/executor/night-plan` | Diagnostic only | No (never executable) |
