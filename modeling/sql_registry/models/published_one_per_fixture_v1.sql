-- sql_id: published_one_per_fixture_v1
-- purpose: One best published signal per fixture model
-- source_tables: public.generated_signal_pairs
-- output_grain: one selected candidate per fixture
-- expected_columns: model_id,fixture_key,condition_id,selected_token_id,score,coverage,pnl
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'published_one_per_fixture_v1' as sql_id;
