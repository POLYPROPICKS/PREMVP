-- Fix: writeStrategicShadowPairs() dedup reads against public.generated_signal_pairs
-- are unindexed on condition_id. Measured directly against production
-- (2026-08-05): 372,302 shadow rows, single condition_id equality lookup ~5.1s,
-- a 200-id .in() chunk exceeds the statement timeout entirely. A full broad
-- batch (~18k distinct condition IDs, ~90 chunks) cannot complete inside the
-- cron's budget, which is why the writer fails closed above
-- SHADOW_DEDUP_MAX_QUERIES (see lib/feed/writeBatching.ts).
--
-- Fix: a covering index on the writer's exact dedup predicate
-- (metric_formula_version equality + condition_id IN (...), selected_token_id
-- read alongside to avoid a heap fetch) so dedup chunks resolve via an index
-- scan instead of a sequential scan over the whole table.
--
-- Idempotent — safe to run multiple times. No uniqueness constraint: shadow
-- rows are not proven unique on this tuple and this index must not change
-- write semantics, only read cost.
--
-- Rollback: DROP INDEX IF EXISTS idx_gsp_shadow_dedup;

CREATE INDEX IF NOT EXISTS idx_gsp_shadow_dedup
  ON public.generated_signal_pairs (metric_formula_version, condition_id, selected_token_id);
