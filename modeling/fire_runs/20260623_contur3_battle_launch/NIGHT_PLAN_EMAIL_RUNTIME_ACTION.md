# Night Plan Email — Railway Runtime Action

## Status: IMPLEMENTED (no code patch needed)

The `/api/cron/night-plan-email` route already reads from `night_event_reservations`
(frozen plan). It does NOT use the stateless planner. No patch required.

## Endpoint

```
GET /api/cron/night-plan-email?mode=plan&source=railway_night_plan_email
Header: x-executor-secret: <EXECUTOR_CANDIDATES_SECRET>
```

## Modes

| mode   | Trigger time (UTC / Minsk) | Behavior |
|--------|---------------------------|----------|
| `plan` | 13:40 UTC / 16:40 Minsk   | Freezes plan if not yet done, sends Night Portfolio email to founder |
| `alert`| 14:45 UTC / 17:45 Minsk   | Sends alert only if no reservations exist |

## Railway Cron Setup

### Option A — Add to existing `ops-report-email-cron` service (preferred)
If the existing ops-report cron already supports multiple curl calls, add:

```
# Night plan email (16:40 Minsk = 13:40 UTC)
curl -s -X GET "https://polypropicks.com/api/cron/night-plan-email?mode=plan&source=railway_night_plan_email" \
  -H "x-executor-secret: $EXECUTOR_CRON_SECRET"
```

Cron schedule: `40 13 * * *` (UTC)

### Option B — Separate Railway service (if ops-report doesn't support multi-call)

Create new Railway cron service:
- Name: `night-plan-email-cron`
- Schedule: `40 13 * * *` (UTC)  
- Command:
  ```bash
  curl -s -X GET "https://polypropicks.com/api/cron/night-plan-email?mode=plan&source=railway_night_plan_email" \
    -H "x-executor-secret: $EXECUTOR_CRON_SECRET"
  ```
- Env var: `EXECUTOR_CRON_SECRET` → same value as `EXECUTOR_CANDIDATES_SECRET` on PREMVP

**Do NOT** copy `SUPABASE_SERVICE_ROLE_KEY` into this service — not needed.

## Alert cron (optional)

Schedule: `45 14 * * *` (UTC) — calls `mode=alert`

## Verification

After Railway deploys, check:
```bash
curl -H "x-executor-secret: $SECRET" \
  "https://polypropicks.com/api/cron/night-plan-email?mode=plan&source=railway_night_plan_email"
```

Expected response: `{"ok":true,"sent":true,"mode":"plan",...}`
