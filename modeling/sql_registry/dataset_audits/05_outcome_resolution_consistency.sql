-- sql_id: outcome_resolution_consistency_v1
-- purpose: DQA-R4 -- read-only audit of outcome-resolution quirk risk (win-labelled rows that would silently resolve as unresolved for lack of a valid entry price or realized return)
-- source_tables: public.generated_signal_pairs
-- output_grain: single diagnostic summary row
-- expected_columns: total_rows,win_label_rows,loss_label_rows,win_without_price_or_return_rows,loss_without_entry_price_rows
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-07-09T00:00:00.000Z

-- DQA-R4: READ-ONLY. No writes, no migrations. Advisory contract only.
--
-- This audits (does NOT fix) the outcome-resolution quirk documented in
-- lib/modeling/onePerMatchBacktest.ts's outcome(): a win-labelled row with
-- neither a valid entry_price_num (> 0) nor a valid realized_return_pct
-- silently resolves to won: null (unresolved) under that function's
-- current logic, instead of keeping its known "won" result. Loss-labelled
-- rows are never at risk of this quirk (their resolution path does not
-- require a price).
--
-- Canonical logic lives in
-- lib/modeling/datasetAudit/outcomeResolutionConsistency.ts
-- (auditOutcomeResolutionConsistency), which is the runtime source of
-- truth. This query mirrors that contract for an eventual SQL adapter,
-- avoiding expensive JSON scans -- all comparisons are plain text/numeric
-- column comparisons.
--
-- TODO: the exact production column names/types for entry price and
-- realized return on public.generated_signal_pairs have not been verified
-- against a live schema in this task (read-only, no DB access). This query
-- assumes entry_price_num (numeric) and realized_return_pct (numeric)
-- based on the naming already used by DQA-R1/R2/R3 in this same registry
-- (see 02_result_field_consistency.sql, 03_return_formula_sanity.sql). If
-- the live schema differs, update the column references here before
-- treating this file as anything other than an advisory contract.
select
  count(*) as total_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'correct', 'yes')
  ) as win_label_rows,
  count(*) filter (
    where lower(signal_result) in ('lost', 'loss', 'miss', 'incorrect', 'no')
  ) as loss_label_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'correct', 'yes')
      and not (entry_price_num is not null and entry_price_num > 0)
      and realized_return_pct is null
  ) as win_without_price_or_return_rows,
  count(*) filter (
    where lower(signal_result) in ('lost', 'loss', 'miss', 'incorrect', 'no')
      and not (entry_price_num is not null and entry_price_num > 0)
  ) as loss_without_entry_price_rows
from public.generated_signal_pairs;
