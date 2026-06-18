# Morning Report Trusted Sources

## Purpose

The morning report is a data-truth workflow. XLSX workbooks are outputs only. The source of truth is the existing reporting script, Supabase execution tables, and modeling artifacts produced by the resolver/modeling pipeline.

The primary generator is `scripts/morning-model-report.ts`.

## Daily generation flow

1. Overnight resolver/model refresh completes first.
2. The morning report job runs after the fresh resolved/model dataset is available.
3. The job reads trusted sources and validates workbook gates.
4. The job writes exactly three XLSX files into the morning report run folder.
5. The job sends email only if gates pass. Manual dry-runs must use `--dry-run` and must not send email.

## Required email attachments

1. `polypropicks_morning_report_YYYYMMDD.xlsx`
2. `ceo_dashboard_details_YYYYMMDD.xlsx`
3. `ice_four_models_counterfactual_YYYYMMDD.xlsx`

Root XLSX templates must not be attached directly.

## Trusted sources and invariants

### Main report generator

- Script: `scripts/morning-model-report.ts`
- Output: `modeling/morning_model_report/YYYYMMDD_0600UTC/polypropicks_morning_report_YYYYMMDD.xlsx`

### Night Execution

- Source: Supabase `public.executor_order_events`
- Functions: `fetchNightExecutionSlice` and `buildNightExecutionRows`
- Invariants:
  - workbook source rows must equal truth source rows
  - dry-run rows are not live orders
  - `LIVE_SENT` is not filled unless the source proves fill/match
  - every data row has `source_ref`
  - no live bet may be dropped from the workbook

Reference validation for `20260618`: `12` source rows, `3` live rows, `9` dry-run rows. Ghana vs Panama must display `Total Corners 8.5`, not `Total Goals`.

### Model Ranking / CEO Decision

- Source logic: accepted counterfactual simulation in `scripts/morning-model-report.ts::buildCounterfactualResult`
- Standalone reference: `scripts/modeling/counterfactual-four-models-simulation.ts`
- Artifact reference: `reports/modeling/one_per_match_backtest/counterfactual_four_models_simulation.csv`
- Policy mapper: `scripts/morning-model-report.ts::buildAcceptedCounterfactualPolicyRows`
- Invariants:
  - model rows must not collapse to copied Primary metrics
  - one-match accepted ranking values must differ by model
  - reference `20260618` 7d ROI: Primary COV_CAP around `28.08%`, Score/ALT1 around `14.96%`, ALT3 around `14.18%`

### Current Base Model Details

- Output: `ceo_dashboard_details_YYYYMMDD.xlsx`
- Generator: `scripts/morning-model-report.ts::writeDashboardDetailsWorkbook`
- Source selection: `buildCounterfactualResult -> buildCounterfactualPolicies -> Primary COV_CAP -> selectCounterfactualOnePerEvent`
- Base model: `Primary COV_CAP`
- Mode: `one-match`
- Required sheets:
  - `00_ReadMe_Current_Dataset`
  - `03_Category Summary`
  - `04_Score Calibration`
  - `06_Recent Volume Proxy`
  - `07_Timing Proxy OBS`
  - `08_Market Families`
  - `99_Source Audit`
- Invariants:
  - workbook status is `CURRENT_BASE_MODEL_RECALCULATED`
  - no legacy `238` / `223` current KPI values
  - supported tabs are recalculated from the current base dataset

### ICE Four Models

- Output: `ice_four_models_counterfactual_YYYYMMDD.xlsx`
- Source: the ICE/current resolved corpus used by `buildCounterfactualResult`
- Reference input for `20260618`: `modeling/ice1_modeling_20260617_post_resolver_707plus/input/ice1_resolved_post_resolver_707plus.csv`
- Invariants for `20260618`:
  - `707` resolved strict rows
  - `501` event groups
  - `SIMULATION_SANITY_PASS`
  - Simulation Table values match accepted counterfactual source

## Hard gates before sending

- `npm run build` passes
- `npm run morning:model-report -- --dry-run --email=alexgrushin@gmail.com` passes
- exactly three XLSX attachment paths are produced
- all attachments are non-empty
- Night Execution row count equals source truth
- reference validation: `12` source rows / `3` live / `9` dry-run for `20260618`
- Ghana vs Panama is `Total Corners 8.5`
- Model Ranking is not collapsed
- Current Base Model Details has only current tabs plus optional source audit
- no executor runtime touched
- no orders placed

## Founder production gate

Founder manually triggers the cron/Railway job after commit/deploy. Acceptance requires:

1. Morning email arrives at `alexgrushin@gmail.com`.
2. Email has exactly three XLSX attachments.
3. `05_Night_Execution` is sourced from execution truth rows.
4. Current Base Model Details workbook includes the current dashboard tabs.
5. If all checks pass, the reporting workflow is accepted.
