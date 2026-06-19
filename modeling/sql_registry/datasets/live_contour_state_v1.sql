-- sql_id: live_contour_state_v1
-- purpose: Live contour audit state
-- source_tables: public.executor_audit_events
-- output_grain: executor audit event
-- expected_columns: created_at,run_id,trace_id,stage,event_slug,market_slug,condition_id,token_id,tier,stake_usd,live_eligible,status,reason,payload_json
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'live_contour_state_v1' as sql_id;
