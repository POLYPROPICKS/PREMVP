# Current Base Model dashboard source audit - 2026-06-18

Status: `CURRENT_BASE_DASHBOARD_READY`

Workflow verdict: `SOURCE_MAP_AND_MINIMAL_REPAIR_READY`; reporting data-truth PASS, pending founder manual cron/email gate.

## Source

- Workbook output: `modeling/morning_model_report/20260618_0600UTC/ceo_dashboard_details_20260618.xlsx`
- Repaired copy: `modeling/morning_model_report/20260618_0600UTC/ceo_dashboard_details_20260618_repaired.xlsx`
- Generator: `scripts/morning-model-report.ts::writeDashboardDetailsWorkbook`
- Source file: `modeling/ice1_modeling_20260617_post_resolver_707plus/input/ice1_resolved_post_resolver_707plus.csv`
- Source selection path: `buildCounterfactualResult -> buildCounterfactualPolicies -> Primary COV_CAP -> selectCounterfactualOnePerEvent`
- Base model: `Primary COV_CAP`
- Mode: `one-match`
- Source resolved strict rows: 707
- Source event groups: 501
- Base-model rows/events used in dashboard: 201 / 201
- Corpus max resolved_at / anchor: `2026-06-17T09:01:31.130Z`
- Stake assumption: flat `$10`
- Legacy 238/223 values used: `NO`

## Recalculated tabs

| sheet | status | rows |
|---|---:|---:|
| 00_ReadMe_Current_Dataset | CURRENT_BASE_MODEL_RECALCULATED | metadata |
| 03_Category Summary | CURRENT_BASE_MODEL_RECALCULATED | 6 buckets |
| 04_Score Calibration | CURRENT_BASE_MODEL_RECALCULATED | 7 score bands |
| 06_Recent Volume Proxy | CURRENT_BASE_MODEL_RECALCULATED | 5 volume buckets |
| 07_Timing Proxy OBS | CURRENT_BASE_MODEL_RECALCULATED | 5 timing buckets |
| 08_Market Families | CURRENT_BASE_MODEL_RECALCULATED | 11 market-family buckets |
| 99_Source Audit | CURRENT_BASE_MODEL_RECALCULATED | source fields |

## Bucket counts

- Category / sport: Tennis 22; Sports 36; MLB 100; Esports 41; Champions League 1; World Cup 2026 1.
- Score: `<65` 0; `65-69` 0; `70-71` 0; `72-74` 106; `75-79` 20; `80-84` 74; `85+` 1.
- Recent volume proxy: `<$5K` 4; `$5K-10K` 11; `$10K-25K` 79; `$25K-50K` 66; `$50K+` 41; `MISSING_VOLUME` 0.
- Timing OBS: `<15m` 18; `15-59m` 35; `60-120m` 36; `120m+` 62; `MISSING_TIMING` 50.
- Market families: MONEYLINE 25; TOTAL_GOALS 0; TOTAL_POINTS 0; TOTAL_RUNS 0; TOTAL 21; SPREAD / HANDICAP 21; CORNERS 4; PROPS 0; FUTURES 1; OTHER 0; UNKNOWN_MARKET_FAMILY 129.
- `UNKNOWN_MARKET_FAMILY` remains material because many selected base-model rows expose only generic `$xxK matched activity` without a specific market family/title in the trusted row fields. Unknowns are counted explicitly and not dropped.

Unsupported legacy tabs intentionally omitted:
- `01_Shadow Strategies`
- `02_Next Models`
- old template-only dashboard tabs not listed above
