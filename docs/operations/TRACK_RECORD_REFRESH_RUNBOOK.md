# Track Record Window Refresh Runbook

Status: operational runbook, repo-backed contour. Migration exists in Git but
is **not applied** to any environment as of this runbook — see "Migration
apply requirement" below before any write run.

## 1. Purpose

The WhyTrust "Why Can I Trust This?" block reads a materialized read-model
(`track_record_window_results` / `track_record_window_summary`), not live
tables. That read-model goes stale unless it is refreshed after the priority
resolver runs. This runbook documents the full chain, the commands, the
report path, and the founder-approval boundary for write execution.

## 2. Full data-flow

```
track_record_display_signals   (current live/display-selected rows)
        │
        ▼
resolve-signals --priority-track-record-display   (resolves executed/shown
        │                                           signals with priority,
        │                                           see scripts/resolve-signals.ts)
        ▼
refresh_track_record_window_results()   (RPC, see
        │                                supabase/migrations/20260704_track_record_window_refresh_rpc.sql;
        │                                wraps the manual REFRESH block from
        │                                supabase/migrations/20260702_track_record_window_results.sql)
        ▼
track_record_window_results / track_record_window_summary   (read-model)
        │
        ▼
GET /api/signals/resolved?mode=latest&days=14   (app/api/signals/resolved/route.ts,
        │                                        weekResultsCard)
        ▼
WhyTrustSection   (components/why-trust/WhyTrustSection.tsx)
```

## 3. Dry-run command

```bash
npm run refresh:track-record
```

- Default mode. Never calls the RPC, never touches Supabase.
- Writes a JSON report to `reports/track-record-refresh/`.

## 4. Write command (requires founder approval)

```bash
npm run refresh:track-record:write
```

- Calls `refresh_track_record_window_results()` via the server Supabase
  admin client (`lib/supabase/server.ts`).
- Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to be present in
  the environment. Values are never printed or written to the report.
- **Must not be run without explicit founder approval**, and **must not be
  run before the RPC migration has been applied** (see section 11).

## 5. Daily command

```bash
npm run track-record:daily:write
```

Runs, in order:
1. `resolve-signals --write --priority-track-record-display ...` — priority
   resolver pass for shown/display signals.
2. `refresh:track-record:write` — read-model refresh via RPC.

This mirrors the ordering contract in `docs/RESOLVER_PIPELINE_CONTRACT.md`:
priority resolution must complete before the read-model is rebuilt from it.

## 6. Report path

```
reports/track-record-refresh/
```

Each run (dry-run or write) writes one JSON file:
`refresh-<ISO timestamp>.json` containing `startedAt`, `finishedAt`, `mode`,
`rpcName`, `reportPath`, `commandChain`, `intendedTables`, `status`, and a
redacted `error` field if the run failed. No secrets are ever included.

## 7. Read-only verification SELECTs

Run these against Supabase (SELECT-only, no writes) after a write run to
confirm freshness:

```sql
select window_days, status, generated_at, resolved_unique_rows, pending_unique_rows
from public.track_record_window_summary
order by window_days;

select window_days, max(resolved_at), max(shown_batch_day)
from public.track_record_window_results
group by window_days;
```

## 8. Stop conditions / rollback

- If `refresh:track-record:write` reports `status: "error"`, do not re-run
  blindly — read the redacted `error` field in the report first.
- The RPC function only rebuilds `track_record_window_results` /
  `track_record_window_summary` from `track_record_shown_signal_history` and
  `generated_signal_pairs` — it never mutates source tables. Rollback is
  re-running the RPC once the underlying data issue is fixed; there is no
  destructive state to revert.
- If the RPC migration has not been applied yet, `refresh:track-record:write`
  will fail with a Postgres "function does not exist" error — this is
  expected and safe; it means the apply step (section 11) has not happened.

## 9. No-secrets logging policy

The runner (`scripts/refresh-track-record-window-results.ts`) never logs or
writes `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or any other credential
value — only presence/absence is checked, and any secret-shaped text in an
error message is redacted (`redactSensitiveText`) before it reaches a report
or the console.

## 10. Pending-65 caveat

Do not interpret any specific "pending" count (including any single number
such as 65) as a data-quality signal until refresh evidence has actually been
collected via a completed write run and its report. A stale read-model can
show inflated or stale pending counts that a fresh refresh corrects.

## 11. Migration apply requirement before write runner

`supabase/migrations/20260704_track_record_window_refresh_rpc.sql` defines
`public.refresh_track_record_window_results()` but, as of this runbook, has
**not been applied** to any environment. Applying a migration is a separate,
explicitly founder-approved step (Supabase migration apply / deploy), not
part of running this runner. `refresh:track-record:write` will fail cleanly
until that apply step happens.
