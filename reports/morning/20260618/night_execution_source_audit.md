# Night execution source audit - 2026-06-18

Source of truth: Supabase `public.executor_order_events`, read by `scripts/morning-model-report.ts::fetchNightExecutionSlice`.

Window used for the morning package: `2026-06-17T15:00:00.000Z` through `2026-06-18T04:00:00.000Z` (Minsk battle window).

Outputs:
- Truth CSV: `reports/morning/20260618/night_execution_truth_from_existing_sources.csv`
- Existing reconciliation: `reports/morning/20260618/night_execution_xlsx_reconciliation.md`

Counts from trusted source:
- total source rows: 12
- real live rows: 3
- dry-run rows: 9
- matched/filled rows proven by source response status: 3
- unique event/market/side rows: 7

Root cause found:
- The old workbook was generated from a rolling `now - 12h` window, so it only captured the late Uzbekistan vs Colombia rows.
- The existing source was correct, but the report window was wrong. That dropped 10 source rows, including live bets outside the rolling 12h slice.
- The generator previously appeared to duplicate Uzbekistan/Colombia because the report slice no longer contained the earlier source rows.

Generator responsible:
- `scripts/morning-model-report.ts::fetchNightExecutionSlice`
- `scripts/morning-model-report.ts::buildNightExecutionRows`

Current status:
- The existing truth source is `TRUSTED_USED_NOW`.
- Reconciliation after the existing window repair reports `truth rows=12`, `xlsx data rows=12`, `missing_truth_rows=0`, `extra_xlsx_rows=0`.
- Hard gate status: `NIGHT_EXECUTION_XLSX_RECONCILIATION_PASS`.
- Ghana vs Panama parser gate: `Total Corners 8.5`.
- Workflow verdict: `SOURCE_MAP_AND_MINIMAL_REPAIR_READY`; reporting data-truth PASS, pending founder manual cron/email gate.
