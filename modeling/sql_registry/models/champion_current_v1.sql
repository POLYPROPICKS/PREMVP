-- sql_id: champion_current_v1
-- purpose: Champion private trading model definition
-- source_tables: public.generated_signal_pairs
-- output_grain: model-selected candidate
-- expected_columns: model_id,dataset_id,fixture_key,pnl,roi,window
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'champion_current_v1' as sql_id;
