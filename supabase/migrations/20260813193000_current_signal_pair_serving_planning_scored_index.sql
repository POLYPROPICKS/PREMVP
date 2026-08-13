-- Recover the exact CONTRACT_A_PLANNING_V1 scored-serving read without
-- changing its eligibility, identity, ordering, or fail-closed row limit.
--
-- Production EXPLAIN at origin/main 94eccb0 proved that the query used a
-- sequential scan plus sort because current_signal_pair_serving had only its
-- primary key and source-id unique index. These static predicates and this
-- ordering exactly match fetchContractAPlanningServingRowSets(). expires_at
-- remains a recheck because now() cannot appear in an index predicate.
--
-- CONCURRENTLY preserves Producer writes while the index is built. Apply this
-- migration outside an explicit transaction block.
-- Rollback:
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_csps_planning_scored_rows;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_csps_planning_scored_rows
  ON public.current_signal_pair_serving
    (source_created_at DESC, source_generated_signal_pair_id DESC)
  WHERE projection_status = 'ACTIVE'
    AND signal_result IS NULL
    AND entry_price_num IS NOT NULL
    AND signal_confidence_num >= 50
    AND metric_formula_version IN ('v2-lite-growth-safe', 'shadow-firemodel1_1_research_v0');
