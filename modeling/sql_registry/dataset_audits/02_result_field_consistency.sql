-- DQA-R1: signal_result casing/domain consistency audit
--
-- Purpose: detect legacy/domain synonym violations in `signal_result`
-- against the canonical two-value domain { 'won', 'lost' } (plus NULL
-- as an unresolved-outcome state). This is a READ-ONLY diagnostic
-- artifact -- it performs no writes, creates no temp tables, and must
-- not be executed against any table other than the source below.
--
-- Source: public.generated_signal_pairs
--
-- WARNING: track_record_* tables are FORBIDDEN as a source for this
-- audit. They are derived/aggregated views and do not represent the
-- full model dataset required for a DQA-R1 pass. Any audit run
-- against track_record_* instead of generated_signal_pairs is invalid.
--
-- This file is static SQL for manual/read-only execution. Do not wire
-- it into resolver/generator/backtest/live/cron paths.

-- 1. Counts by classification category
select
  count(*) filter (
    where signal_result in ('won', 'lost')
  ) as valid_canonical_count,
  count(*) filter (
    where signal_result is null
  ) as null_unresolved_count,
  count(*) filter (
    where lower(signal_result) in ('won', 'lost', 'win', 'loss')
      and signal_result not in ('won', 'lost')
  ) as casing_domain_violation_count,
  count(*) filter (
    where signal_result is not null
      and signal_result not in ('won', 'lost')
      and lower(signal_result) not in ('won', 'lost', 'win', 'loss')
  ) as unsupported_nonnull_count,
  count(*) as total_rows
from public.generated_signal_pairs;

-- 2. Raw value breakdown (for manual inspection of every distinct value)
select
  signal_result,
  count(*) as row_count
from public.generated_signal_pairs
group by signal_result
order by row_count desc;
