-- Fix: signal-resolve-cron ("resolve:signals:cron") DB select failed with
-- "canceling statement due to statement timeout" while scanning
-- public.generated_signal_pairs for pending-resolution rows.
--
-- Root cause: scripts/resolve-signals.ts filters on
--   signal_result IS NULL
--   AND condition_id IS NOT NULL
--   AND selected_token_id IS NOT NULL
--   AND entry_price_num IS NOT NULL
--   AND metric_formula_version IS NOT NULL
--   AND expires_at < :expired_cutoff   (--only-expired)
--   AND created_at >= :created_after   (--max-age-days bounded scan)
-- ordered by expires_at ASC, created_at ASC (--order=oldest), with no
-- supporting index. As the table grows, Postgres falls back to a full
-- sequential scan + sort over the unresolved backlog, which exceeds the
-- statement timeout before returning any rows — the whole cron job fails
-- with updated=0 even though eligible expired rows exist.
--
-- Fix: a partial index whose WHERE clause matches the resolver's exact
-- eligibility predicate and whose leading columns match its ORDER BY, so the
-- planner can satisfy the pending-resolution scan via an index scan instead
-- of a full-table sort. Idempotent — safe to run multiple times.

CREATE INDEX IF NOT EXISTS idx_gsp_pending_resolution
  ON public.generated_signal_pairs (expires_at ASC, created_at ASC, id ASC)
  WHERE signal_result IS NULL
    AND condition_id IS NOT NULL
    AND selected_token_id IS NOT NULL
    AND entry_price_num IS NOT NULL
    AND metric_formula_version IS NOT NULL;
