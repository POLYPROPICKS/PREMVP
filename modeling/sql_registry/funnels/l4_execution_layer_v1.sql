-- sql_id: l4_execution_layer_v1
-- purpose: Execution audit funnel level
-- source_tables: public.executor_audit_events,public.executor_order_events
-- output_grain: execution audit row
-- expected_columns: rows,fixtures,distinct_condition_id,distinct_token_id,coverage_pct,unresolved_count,warnings
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'l4_execution_layer_v1' as sql_id;
