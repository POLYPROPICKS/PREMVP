-- sql_id: date_mode_created_vs_resolved_v1
-- purpose: DQA-R3 -- read-only audit of created_at vs resolved_at window membership
-- source_tables: public.generated_signal_pairs
-- output_grain: one summary row per window (7D/14D/30D)
-- expected_columns: window_label,created_in_window,resolved_in_window,both_in_window,created_only,resolved_only,missing_created_at,missing_resolved_at
-- no_db_writes: true
-- version: 1.0.0
-- created_at: 2026-07-09T00:00:00.000Z

-- DQA-R3: READ-ONLY. No writes, no migrations. Advisory contract only.
-- Window is inclusive start, exclusive end: [window_start, window_end).
-- Canonical logic lives in lib/modeling/datasetAudit/dateModeConsistency.ts
-- (auditDateModeConsistency), which is the runtime source of truth. This
-- query mirrors that contract for an eventual SQL adapter, avoiding
-- expensive JSON scans -- all comparisons are plain timestamp comparisons.
with windows(window_label, window_start, window_end) as (
  values
    ('7D', now() - interval '7 days', now()),
    ('14D', now() - interval '14 days', now()),
    ('30D', now() - interval '30 days', now())
)
select
  w.window_label,
  count(*) filter (
    where g.created_at is not null and g.created_at >= w.window_start and g.created_at < w.window_end
  ) as created_in_window,
  count(*) filter (
    where g.resolved_at is not null and g.resolved_at >= w.window_start and g.resolved_at < w.window_end
  ) as resolved_in_window,
  count(*) filter (
    where g.created_at is not null and g.created_at >= w.window_start and g.created_at < w.window_end
      and g.resolved_at is not null and g.resolved_at >= w.window_start and g.resolved_at < w.window_end
  ) as both_in_window,
  count(*) filter (
    where g.created_at is not null and g.created_at >= w.window_start and g.created_at < w.window_end
      and not (g.resolved_at is not null and g.resolved_at >= w.window_start and g.resolved_at < w.window_end)
  ) as created_only,
  count(*) filter (
    where g.created_at is not null
      and not (g.created_at >= w.window_start and g.created_at < w.window_end)
      and g.resolved_at is not null and g.resolved_at >= w.window_start and g.resolved_at < w.window_end
  ) as resolved_only,
  count(*) filter (where g.created_at is null) as missing_created_at,
  count(*) filter (where g.resolved_at is null) as missing_resolved_at
from windows w
cross join public.generated_signal_pairs g
group by w.window_label, w.window_start, w.window_end
order by w.window_label;
