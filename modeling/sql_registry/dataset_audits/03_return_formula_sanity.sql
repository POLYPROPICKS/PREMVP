-- sql_id: return_formula_sanity_v1
-- purpose: DQA-R2 -- read-only audit of realized_return_pct vs canonical win/loss formula
-- source_tables: public.generated_signal_pairs
-- output_grain: single diagnostic summary row
-- expected_columns: total_rows,resolved_rows,valid_reconciled_rows,recompute_mismatch_rows,missing_realized_return_rows,invalid_entry_price_rows,sign_conflict_rows,unresolved_excluded_rows
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-07-09T00:00:00.000Z

-- DQA-R2: READ-ONLY. No writes, no migrations. Advisory contract only.
-- Canonical formula: win_return_pct = ((1 - entry_price_num) / entry_price_num) * 100
--                     loss_return_pct = -100
-- Valid entry price: numeric and 0 < entry_price_num < 1. Tolerance: 0.5 pct points.
-- Canonical logic lives in lib/modeling/datasetAudit/returnFormulaConsistency.ts
-- (auditReturnFormulaConsistency), which is the runtime source of truth. This
-- query mirrors that contract for an eventual SQL adapter, avoiding expensive
-- JSON scans -- all comparisons are plain numeric/text column comparisons.
select
  count(*) as total_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
  ) as resolved_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
      and realized_return_pct is not null
      and entry_price_num is not null and entry_price_num > 0 and entry_price_num < 1
      and abs(
        realized_return_pct - (
          case when lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success')
            then ((1 - entry_price_num) / entry_price_num) * 100
            else -100
          end
        )
      ) <= 0.5
  ) as valid_reconciled_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
      and realized_return_pct is not null
      and entry_price_num is not null and entry_price_num > 0 and entry_price_num < 1
      and abs(
        realized_return_pct - (
          case when lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success')
            then ((1 - entry_price_num) / entry_price_num) * 100
            else -100
          end
        )
      ) > 0.5
  ) as recompute_mismatch_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
      and realized_return_pct is null
  ) as missing_realized_return_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
      and realized_return_pct is not null
      and not (entry_price_num is not null and entry_price_num > 0 and entry_price_num < 1)
  ) as invalid_entry_price_rows,
  count(*) filter (
    where lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
      and realized_return_pct is not null
      and entry_price_num is not null and entry_price_num > 0 and entry_price_num < 1
      and sign(realized_return_pct) <> 0
      and sign(realized_return_pct) <> (case when lower(signal_result) in ('won', 'win', 'hit', 'resolved_win', 'success') then 1 else -1 end)
  ) as sign_conflict_rows,
  count(*) filter (
    where signal_result is null
       or lower(signal_result) not in ('won', 'win', 'hit', 'resolved_win', 'success', 'lost', 'loss', 'miss', 'resolved_loss', 'failed')
  ) as unresolved_excluded_rows
from public.generated_signal_pairs;
