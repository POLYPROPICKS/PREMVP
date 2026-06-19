-- sql_id: all_sports_resolved_candidates_v1
-- purpose: Strict resolved all-sports candidate corpus
-- source_tables: public.generated_signal_pairs
-- output_grain: condition_id::selected_token_id
-- expected_columns: id,created_at,resolved_at,condition_id,selected_token_id,selected_outcome,market_slug,event_slug,signal_result,entry_price_num,signal_confidence_num,data_coverage_num,diagnostics
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'all_sports_resolved_candidates_v1' as sql_id;
