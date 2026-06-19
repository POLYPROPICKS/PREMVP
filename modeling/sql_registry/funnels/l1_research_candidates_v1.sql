-- sql_id: l1_research_candidates_v1
-- purpose: Research candidate funnel level
-- source_tables: public.generated_signal_research_snapshots
-- output_grain: unique research candidate
-- expected_columns: rows,fixtures,distinct_condition_id,distinct_token_id,coverage_pct,unresolved_count,warnings
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'l1_research_candidates_v1' as sql_id;
