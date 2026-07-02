# Real Resolved Track Record Flow — Resolver Timeout Incident

## Confirmed root cause

`npm run resolve:signals:cron` (Railway `signal-resolve-cron`) fails before it
resolves any rows:

```
[resolve-signals] === START mode=write limit=500 maxUpdates=50 order=oldest onlyExpired=true dedupeStrict=true priorityLiveLedger=false expiredCutoff=2026-07-02T06:03:33.773Z ===
[resolve-signals] BOUNDED_SCAN created_after=2026-06-02T06:03:33.773Z
[resolve-signals] DB select failed: canceling statement due to statement timeout
[resolve-signals] Job run recorded (error, updated=0)
```

`scripts/resolve-signals.ts`'s pending-resolution SELECT filters on
`signal_result IS NULL`, `condition_id/selected_token_id/entry_price_num/
metric_formula_version IS NOT NULL`, `expires_at < expired_cutoff`,
`created_at >= created_after`, ordered by `expires_at ASC, created_at ASC`.
No index in `public.generated_signal_pairs` supported this predicate/order
combination, so Postgres fell back to a full sequential scan + sort over the
unresolved backlog as it grew, exceeding the statement timeout. The job
exits with `updated=0` every run — expired rows never get resolved, not
because of resolver eligibility logic, but because the discovery query never
completes.

## Concrete stuck row

- `generated_signal_pairs.id`: `71133492-e81c-4373-b25a-9b702edd8c85`
- event: Valorant: Crest Gaming Zst vs Insomnia (BO3)
- `condition_id`: `0xaf318a24691530b1a8dadbcdad027f2cc4742b514f4d3cfa717dc69642b22469`
- `selected_token_id`: `86709938698828930887404798600628041803434316051109258637816146177749787028460`
- `selected_outcome`: `Crest Gaming Zst`
- `entry_price_num`: `0.725`
- `metric_formula_version`: `shadow-strategic-sports-v1`
- `expires_at`: `2026-06-25 16:00:00+00` (past, eligible for `--only-expired`)
- `signal_result` / `resolved_at`: `NULL`

This row passes every resolver eligibility predicate (all required fields
present, `metric_formula_version` set, market expired). It was never
unreachable by resolver *logic* — it was unreachable because the SELECT that
finds it never returns before timing out.

## Why the API fallback is not the fix

`app/api/signals/resolved/route.ts` only reads rows that already have
`signal_result` set. Patching it to synthesize or infer a result for
unresolved rows would fabricate an outcome instead of using a confirmed
market settlement — forbidden by the no-fake-result rule. The correct fix is
making the resolver's own discovery query actually complete so it can write
the real Gamma/CLOB-confirmed outcome.

## Resolver query/index fix

- `scripts/resolve-signals.ts`: extracted the pending-resolution filter/order
  set into `buildPendingResolutionQuerySpec()` (single source of truth for
  the query, the regression test, and this doc), added SELECT timing/count
  logging (`SELECT_MODE`, `SELECT_OK`, and richer `DB select failed` context
  on error), and a stable `id` order tiebreaker. The CLI entrypoint is now
  guarded by `require.main === module` so the query-spec helpers can be
  imported by tests without running the live script.
- `supabase/migrations/20260702_generated_signal_pairs_pending_resolution_index.sql`:
  adds `idx_gsp_pending_resolution`, a partial index on
  `generated_signal_pairs (expires_at ASC, created_at ASC, id ASC)` whose
  `WHERE` clause matches the resolver's exact eligibility predicate, so the
  planner can satisfy the scan via an index instead of a full-table sort.

## Post-fix DB verification needed

Run in Supabase after the migration is applied and a resolver cron cycle has
completed:

```sql
-- Confirm the stuck row resolved, and that the pending-resolution scan is
-- no longer timing out (row exists with signal_result/resolved_at set).
SELECT id, condition_id, selected_token_id, signal_result, resolved_at, winning_outcome
FROM public.generated_signal_pairs
WHERE id = '71133492-e81c-4373-b25a-9b702edd8c85';
```

```sql
-- Confirm the index is in place and used by the planner for the resolver's
-- pending-resolution predicate.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, expires_at, event_slug, condition_id, selected_outcome,
       selected_token_id, entry_price_num
FROM public.generated_signal_pairs
WHERE signal_result IS NULL
  AND condition_id IS NOT NULL
  AND selected_token_id IS NOT NULL
  AND entry_price_num IS NOT NULL
  AND metric_formula_version IS NOT NULL
  AND expires_at < now()
  AND created_at >= now() - interval '30 days'
ORDER BY expires_at ASC, created_at ASC, id ASC
LIMIT 500;
```

## Update: index fixed the timeout, but display rows still weren't resolving

After `idx_gsp_pending_resolution` shipped, the statement-timeout crash was
gone — but rows actually shown in `public.track_record_display_signals`
still weren't resolving. SQL evidence showed why: the generic backlog is
ordered oldest-expires-first with a bounded `--limit=500` per cron run, and
the specific displayed rows sit far deeper in that queue than any single run
reaches:

| case | event | resolver_rank | should_be_selected_by_current_cron |
|---|---|---|---|
| 1 | Valorant: Crest Gaming Zst vs Insomnia (`71133492-e81c-4373-b25a-9b702edd8c85`) | 18,508 | false |
| 2 | Colombia vs. Portugal | 31,245 | false |
| 3 | Valorant: Enterprise Esports vs Barça eSports | 91,527 | false |

All three pass every resolver eligibility check and have zero resolved rows
sharing their `condition_id`/`selected_token_id` — this is queue starvation,
not an identity, fallback, or eligibility bug. The generic `--limit=500
--order=oldest` queue would need ~183 consecutive runs to reach rank 91,527
with no other rows arriving in between, which never happens in practice.

## Targeted track-record priority mode

Added `--priority-track-record-display` to `scripts/resolve-signals.ts`,
mirroring the existing `--priority-live-ledger` pattern:

```bash
tsx scripts/resolve-signals.ts --write --priority-track-record-display --dedupe-strict --limit=100 --max-updates=100
```

Behavior:

1. Reads `source_row_id, window_days, score_rank` from
   `public.track_record_display_signals` (read-only from the resolver's
   perspective — this repo does not own or migrate that table).
2. Fetches only the referenced `generated_signal_pairs` rows (`id IN
   (...source_row_id)`) that pass the eligibility spec built by
   `buildTrackRecordEligibilityQuerySpec()`: `resolved_at IS NULL`,
   `signal_result IS NULL OR NOT IN ('won','lost')`, `condition_id` /
   `selected_token_id` / `entry_price_num` / `metric_formula_version` all
   NOT NULL, `expires_at <= now()`, `created_at >= now() - 30 days`.
3. Orders eligible rows with `sortTrackRecordPriorityCandidates()`:
   `window_days` desc, `score_rank` asc (nulls last), `expires_at` asc,
   `created_at` asc, `id` asc — then applies `--limit`.
4. Feeds the selected rows through the same
   `fetchGammaMarketByConditionId` / `resolveSignalOutcome` path as the
   generic and live-priority queues — no new outcome logic, no fabricated
   results.
5. Logs `TRACK_RECORD_PRIORITY_LOADED` (count, eligible, first/last
   `score_rank`, first/last `expires_at`), per-row
   `TRACK_RECORD_PRIORITY_SKIP` / `_WOULD` / `_WRITE` / `_NOOP` /
   `_ERROR`, and a `TRACK_RECORD_PRIORITY_SUMMARY` totals line.
6. When the flag is absent, behavior is byte-for-byte unchanged — this is
   an additive branch, not a rewrite of the generic or live-priority paths.

## Post-run SQL verification (track-record priority mode)

```sql
-- Confirm the three known-starved rows resolved after running
-- --priority-track-record-display.
SELECT id, condition_id, selected_token_id, signal_result, resolved_at, winning_outcome
FROM public.generated_signal_pairs
WHERE id = '71133492-e81c-4373-b25a-9b702edd8c85'
   OR id IN (
     SELECT source_row_id FROM public.track_record_display_signals
     WHERE score_rank IS NOT NULL
   );
```

```sql
-- Confirm no track_record_display_signals row referencing an expired,
-- identity-complete generated_signal_pairs row remains unresolved.
SELECT d.source_row_id, d.window_days, d.score_rank, g.expires_at, g.signal_result, g.resolved_at
FROM public.track_record_display_signals d
JOIN public.generated_signal_pairs g ON g.id = d.source_row_id
WHERE g.resolved_at IS NULL
  AND (g.signal_result IS NULL OR g.signal_result NOT IN ('won','lost'))
  AND g.expires_at <= now()
  AND g.condition_id IS NOT NULL
  AND g.selected_token_id IS NOT NULL
  AND g.entry_price_num IS NOT NULL
  AND g.metric_formula_version IS NOT NULL
ORDER BY d.window_days DESC, d.score_rank ASC NULLS LAST;
```
