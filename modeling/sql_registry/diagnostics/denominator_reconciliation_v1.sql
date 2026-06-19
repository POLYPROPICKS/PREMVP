-- sql_id: denominator_reconciliation_v1
-- purpose: Compare denominators across datasets/models/funnels
-- source_tables: public.generated_signal_pairs,public.generated_signal_research_snapshots
-- output_grain: diagnostic summary row
-- expected_columns: dataset_id,rows,fixtures,conditions,tokens,warnings
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'denominator_reconciliation_v1' as sql_id;
