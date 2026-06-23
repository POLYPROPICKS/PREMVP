# scripts/contur3 — Blue_model / Contur3 Deterministic Runners

Repo-owned scripts that replace ad-hoc Railway UI / curl / CMD invocations.
All scripts require one of: `EXECUTOR_CANDIDATES_SECRET`, `EXECUTOR_SECRET`, `PPP_SECRET`.

## Scripts

| Script | npm alias | Description |
|---|---|---|
| `run-night-reservations.mjs` | `npm run contur3:night-reservations` | POST night-event-reservations (forceRebuild CEO_APPROVED) |
| `run-event-rebalance.mjs` | `npm run contur3:event-rebalance` | POST event-rebalance (dryRun: false) |
| `blue-model-status.mjs` | `npm run contur3:blue-status` | Read-only status check → GO/ARMED/NO_GO verdict |

## Output

All runs save JSON logs to:
```
modeling/fire_runs/contur3-blue-model/<timestamp>_<type>.json
```

## Verdicts from blue-status

| Verdict | Meaning |
|---|---|
| `BLUE_MODEL_GO_READY` | ≥1 candidate in queue, source=event_execution_queue, contract fields valid |
| `BLUE_MODEL_ARMED_WAITING` | Queue empty but next_due_iso exists — system healthy, waiting for game window |
| `BLUE_MODEL_NO_GO` | Endpoint error or source mismatch — investigate before live run |

## Railway Start Commands (copy-paste)

Night reservations cron:
```
node scripts/contur3/run-night-reservations.mjs
```

Event rebalance cron:
```
node scripts/contur3/run-event-rebalance.mjs
```

## Forbidden (hardcoded in scripts)

- No halftime / first-half / corners / props
- No Tier2 / Tier3 markets
- No secrets printed to stdout
- No forceRebuild in status check
