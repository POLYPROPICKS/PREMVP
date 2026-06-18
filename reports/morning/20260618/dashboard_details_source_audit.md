# CEO dashboard details source audit - 2026-06-18

Workbook: `ceo_dashboard_details_20260618.xlsx`

Current generator:
- `scripts/morning-model-report.ts::writeDashboardDetailsWorkbook`
- Template loader: `loadWorkbookTemplatePreservingSheets`
- Banner writer: `prependDashboardDatasetBanner`

Source classification:
- Structural source: `ceo_dashboard_details2.xlsx`
- Current appended sections: accepted counterfactual result and policy/window/night tables from the morning run
- Native template body: legacy/reference, not fully recalculated

Legacy values:
- Template contains historical `238` / `223` universe values and same-sample preview language.
- These are not current ICE 707/501 metrics.
- Sanitizer prefixes those values as `LEGACY_REFERENCE_ONLY`, but the dashboard is still not a fully current recalculation.

Truth status:
- Current ICE source rows: 707 resolved strict rows / 501 event groups.
- Score>=72 and Primary/ALT3 summaries are available from accepted counterfactual artifacts.
- Full recalculation of all 14 dashboard sheets was not found in the repo.

Final verdict:
- Legacy dashboard status is superseded by the current base model workbook.
- Current generator: `scripts/morning-model-report.ts::writeDashboardDetailsWorkbook`
- Current status: `CURRENT_BASE_MODEL_RECALCULATED`
- Required tabs: `00_ReadMe_Current_Dataset`, `03_Category Summary`, `04_Score Calibration`, `06_Recent Volume Proxy`, `07_Timing Proxy OBS`, `08_Market Families`, `99_Source Audit`

Required invariant:
- Do not present 238/223 as current.
- Preserve template structure, but mark template sections as legacy/reference unless a sheet-specific current recomputation source exists.

Patch status:
- `ceo_dashboard_details_YYYYMMDD.xlsx` is no longer generated from the 14-sheet legacy template.
- Legacy `238/223` values are omitted from current workbook outputs.
- Workflow verdict: `CURRENT_BASE_DASHBOARD_READY`; reporting data-truth PASS, pending founder manual cron/email gate.
