# Contur3 — Canonical Live Funnel Log

Generated: 2026-06-25T18:24:34.973Z
Minsk now: 25/06/2026, 21:24:34 (Europe/Minsk)
Branch: claude/contur3-fullmatch-reservation-coverage  HEAD: f886053  (Contur3: restore full-match live reservation coverage via Tier2/Tier3 slot-fill ladder)
origin/main: 39996e7
Window: 2026-06-24T18:24:34.973Z .. 2026-06-26T06:24:34.973Z (lookback 24h / next 12h)

## MACHINE VERDICT: STOPPED_DB_ENV_MISSING
hard_anomaly_count: 1

## Environment
| flag | present |
|---|---|
| has_supabase_url | false |
| has_service_role | false |
| has_executor_secret | false |
| railway | false |

> **STOPPED_DB_ENV_MISSING** — no Supabase read env in this context. This is the canonical log skeleton; the DB-backed funnel must be generated on Railway /app.

## Tables (paginated row counts)
| table | ok | rows | error |
|---|---|---|---|

## Summary
| metric | value |
|---|---|
| expected_physical_matches | null |
| reserved_physical_matches | null |
| missing_physical_matches | null |
| fallback_reserved_count | null |
| due_now | null |
| queued | null |
| executor_api_visible | null |
| orders | null |
| hard_anomaly_count | 1 |
| machine_verdict | STOPPED_DB_ENV_MISSING |

## Per physical match (source -> builder -> reservation -> queue -> order)
| match | raw | allowed_fm | forbidden | reserved | due | queue | api | orders | fallback | verdict |
|---|---|---|---|---|---|---|---|---|---|---|

## Anomalies
- **[P0] EXECUTOR_SECRET_MISSING** (source) — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absent in this execution context.
  - next: `Run on Railway /app where Supabase read env is present: npm run contur3:live-funnel-log`

## Next actions
- [Railway] `npm run contur3:live-funnel-log` — Generate the canonical DB-backed funnel log; local context has no Supabase env.
