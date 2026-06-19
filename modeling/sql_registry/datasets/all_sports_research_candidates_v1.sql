-- sql_id: all_sports_research_candidates_v1
-- purpose: Wide all-sports research snapshot candidate layer
-- source_tables: public.generated_signal_research_snapshots
-- output_grain: research snapshot row
-- expected_columns: id,created_at,snapshot_at,condition_id,token_id,selected_token_id,market_slug,event_slug,score,coverage,entry_price,diagnostics
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'all_sports_research_candidates_v1' as sql_id;
