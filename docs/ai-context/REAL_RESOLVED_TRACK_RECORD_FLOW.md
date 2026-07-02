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
