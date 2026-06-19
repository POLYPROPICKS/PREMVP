-- sql_id: golden_dataset_regression_v1
-- purpose: WC golden regression anchors for FireModel
-- source_tables: filesystem:modeling/wc_*
-- output_grain: golden check row
-- expected_columns: anchor_id,expected_roi,actual_roi,status
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-06-19T00:00:00.000Z

-- FireModel canonical query contract.
-- Runtime adapters must preserve this source table set, grain, and expected output columns.
-- Direct SQL execution is optional; trusted calculations must reference this sql_id and source hash.
select 'golden_dataset_regression_v1' as sql_id;
