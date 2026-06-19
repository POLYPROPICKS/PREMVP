-- sql_id: tiered_live_contour_v1
-- purpose: Tier1/Tier2/Tier3 fallback live contour model
-- source_tables: public.generated_signal_pairs,public.executor_audit_events
-- output_grain: tiered selected candidate
-- expected_columns: model_id,tier,fixture_key,condition_id,selected_token_id,stake_usd,pnl
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'tiered_live_contour_v1' as sql_id;
