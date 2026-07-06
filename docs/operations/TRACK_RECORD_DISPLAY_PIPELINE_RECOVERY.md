# Track Record / WhyTrust Display Pipeline — Recovery Runbook (PR45–PR52)

Status: recovery documentation, repo-backed. Companion to
`TRACK_RECORD_REFRESH_RUNBOOK.md` (window read-model refresh) and
`docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md` (resolver flow). This
doc covers the display-source materialization + daily automation layer that
sits upstream of the window refresh.

## 1. Recovery Summary

- **Original outage**: `track_record_display_signals` (the display-source
  table WhyTrust/Track Record reads from) went stale after 2026-07-01 — no
  new rows were being materialized into it.
- **PR45–PR49**: created and hardened the repo-owned
  `track-record:display:materialize` script/command so display rows can be
  rebuilt from source data with a dry-run-by-default, schema-safe,
  stale-guarded materializer (fixed `created_at` payload and
  `odds_source_path` constraint issues along the way).
- **PR50**: added `track-record:display:daily:write`, the single daily
  command that chains materialize → resolve → refresh.
- **PR51**: added the priority resolver step into the daily command so
  displayed/shown signals get resolved with priority before the read-model
  refresh runs.
- **PR52**: added a same-day insertion cap and near-expiry /
  resolver-identity-first candidate ordering to stop same-day
  over-insertion into `track_record_display_signals`.
- **Result as of `origin/main = 59bfb2719e7ace9aa0f62a06f3c5ceeab1b418a7`**:
  display/source freshness is restored, and WhyTrust API/UI freshness is
  restored. Pending-signal count is **not** fully eliminated (see §8).

## 2. Current Production Pipeline

```
npm run track-record:display:daily:write
  = track-record:display:materialize -- --write      (materialize display rows)
    → resolve:signals --priority-track-record-display  (priority resolve displayed rows)
      → refresh:track-record:write                      (refresh track-record read model)
```

This is the exact chain defined by the `track-record:display:daily:write`
npm script (`package.json`).

## 3. Railway Job

- Service/job: `track-record-display-daily`
- Command: `npm run track-record:display:daily:write`
- Cron: `30 20 * * *`
- Env: production
- **Must not** use the old `track-record:daily:write` script (pre-PR50,
  materialize-less path) — it is superseded by
  `track-record:display:daily:write` and left in `package.json` only for
  reference/rollback, not for scheduled use.

## 4. Important Commands

Safe dry-run (never writes):

```bash
npm run track-record:display:materialize
```

Manual resolver sweep — **only when explicitly founder-authorized**:

```bash
npm run resolve:signals -- --write --priority-track-record-display --dedupe-strict --limit=500 --max-updates=200 && npm run refresh:track-record:write
```

Forbidden without explicit founder approval (all are write-mode / mutate
production state):

```bash
npm run track-record:daily:write
npm run track-record:display:daily:write
npm run track-record:display:materialize -- --write
npm run refresh:track-record:write
```

## 5. Test Inventory

- File: `tests/signals/trackRecordDisplayMaterializer.test.ts`
- Run: `node --import tsx --test tests/signals/trackRecordDisplayMaterializer.test.ts`
- Expected as of PR52: **31 pass / 0 fail**
- Categories covered:
  - dry-run no write
  - stale guard
  - schema-safe source select
  - created_at payload
  - odds_source_path constraint
  - daily script contract
  - resolver step in daily command
  - same-day cap
  - partial capacity
  - source-id idempotency
  - near-expiry ordering
  - identity-complete candidate priority
- No UI tests were added for this recovery — no UI code changed. UI
  acceptance is manual/API proof (WhyTrust reading fresh data via
  `GET /api/signals/resolved?mode=latest&days=14`).

## 6. Runtime Evidence / Logs

Raw Railway logs are **not** committed to this repo. References only:

- Railway run logs live under the Railway UI for the
  `track-record-display-daily` service/job.
- Refresh report path pattern:
  `/app/reports/track-record-refresh/refresh-YYYY-MM-DDTHH-MM-SS-sssZ.json`
  (see `TRACK_RECORD_REFRESH_RUNBOOK.md` §6 for report schema).

Known example report files:

```
/app/reports/track-record-refresh/refresh-2026-07-06T07-27-29-270Z.json
/app/reports/track-record-refresh/refresh-2026-07-06T08-15-03-583Z.json
/app/reports/track-record-refresh/refresh-2026-07-06T10-17-02-331Z.json
```

Manual run summary (2026-07-06): manual run inserted 2026-07-06 rows and
refresh completed.

- Resolver priority run proof (later sweep):
  `loaded=213 eligible=62 selected=62 updated=0 unresolved=18 errors=0`
- Earlier PR51 run proof: `updated=31 rows_updated=3115` (Brazil/Norway
  markets resolved).
- PR52 dry-run proof (same-day cap in effect):
  `existingCountForBatchWindow=50 remainingCapacity=0 plannedCount=0 insertedCount=0`

## 7. Next Verification SQL

Run against Supabase (SELECT-only, no writes):

```sql
SELECT
  batch_day,
  window_days,
  count(*) AS rows_count,
  count(DISTINCT source_row_id) AS unique_source_rows
FROM public.track_record_display_signals
WHERE batch_day >= DATE '2026-07-06'
GROUP BY batch_day, window_days
ORDER BY batch_day DESC;

SELECT
  window_days,
  status,
  raw_shown_rows,
  unique_matches,
  resolved_unique_rows,
  pending_unique_rows,
  wins_count,
  losses_count,
  net_pnl_usd,
  net_return_pct,
  generated_at
FROM public.track_record_window_summary
ORDER BY window_days;
```

Expected after the next scheduled day:

- 2026-07-07 should have max 25 rows (per PR52 same-day cap).
- 2026-07-06 should not grow beyond the existing 50 manual-run rows.
- Pending should not inflate; resolved should increase as markets settle.

## 8. Known Remaining Issues

- High pending count remains under observation — not yet fully resolved.
- No historical backfill exists for 2026-07-03/2026-07-04: the
  display-source was stale during that window, so no rows were
  materialized for those days.
- Some Gamma markets may remain `active_unresolved` or `lookup_failed`
  after a resolver sweep.
- UI tests were not added because no UI code changed for this recovery;
  UI acceptance is manual/API proof only.

## 9. Do Not Do

- Do not rerun `track-record:display:daily:write` (or any write-mode
  command in §4) manually unless explicitly founder-authorized.
- Do not fake-resolve signals based on match score.
- Do not patch UI to hide pending counts.
- Do not use the old `track-record:daily:write` script for scheduled or
  manual production runs — use `track-record:display:daily:write`.
