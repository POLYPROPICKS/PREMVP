# Contur3 — Live Funnel G2 Rollup (last 24h / yesterday / day-before, Minsk)

Generated: 2026-06-25T18:24:34.716Z
Minsk today: 2026-06-25  yesterday: 2026-06-24  day-before: 2026-06-23
Machine verdict: STOPPED_DB_ENV_MISSING

## Funnel totals (rolling 24h window)
| stage | count |
|---|---|
| source rows (generated_signal_pairs) | - |
| reservations | - |
| queued | - |
| order events | - |
| audit events | - |
| missed matches (allowed anchor, no reservation) | - |

## Comparison with previously known failures
| known failure | present now |
|---|---|
| 22:00 missed matches | null |
| 01:00 due-window issue | null |
| Curaçao missing reservation | false |
| raw allowed fullmatch but no builder fullmatch | false |

## Anomalies (with command/action)
- [P0] EXECUTOR_SECRET_MISSING → `Run on Railway /app where Supabase read env is present: npm run contur3:live-funnel-log`
