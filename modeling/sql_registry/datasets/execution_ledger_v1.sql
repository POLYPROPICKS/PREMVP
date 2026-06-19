-- sql_id: execution_ledger_v1
-- purpose: Execution/order ledger state
-- source_tables: public.executor_order_events
-- output_grain: order event
-- expected_columns: created_at,run_id,trace_id,event_slug,market_slug,condition_id,token_id,stake_usd,status,reason,payload_json
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'execution_ledger_v1' as sql_id;
