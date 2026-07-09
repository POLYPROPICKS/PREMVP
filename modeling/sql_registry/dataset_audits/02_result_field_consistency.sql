-- sql_id: result_field_consistency_v1
-- purpose: DQA-R1 -- read-only audit of signal_result vs winning/selected outcome consistency
-- source_tables: public.generated_signal_pairs
-- output_grain: single diagnostic summary row
-- expected_columns: total_rows,resolved_signal_result_rows,unresolved_signal_result_rows,inferred_outcome_rows,conflict_rows,legacy_uppercase_rows
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-07-09T00:00:00.000Z

-- DQA-R1: READ-ONLY. No writes, no migrations. Advisory contract only.
-- Canonical logic lives in lib/modeling/datasetAudit/resultFieldConsistency.ts
-- (auditResultFieldConsistency), which is the runtime source of truth. This
-- query mirrors that contract for an eventual SQL adapter without expensive
-- JSON scans -- all comparisons are plain text/column comparisons.
select
  count(*) as total_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
  ) as resolved_signal_result_rows,
  count(*) filter (
    where signal_result is null
       or lower(signal_result) not in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
  ) as unresolved_signal_result_rows,
  count(*) filter (
    where winning_outcome is not null and selected_outcome is not null
  ) as inferred_outcome_rows,
  count(*) filter (
    where winning_outcome is not null
      and selected_outcome is not null
      and lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
      and (
        (lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success')) <> (winning_outcome = selected_outcome)
      )
  ) as conflict_rows,
  count(*) filter (
    where signal_result = upper(signal_result) and signal_result <> lower(signal_result)
  ) as legacy_uppercase_rows
from public.generated_signal_pairs;
