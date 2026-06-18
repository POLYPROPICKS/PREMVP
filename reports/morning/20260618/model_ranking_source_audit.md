# Model ranking source audit - 2026-06-18

Correct accepted source:
- `reports/modeling/one_per_match_backtest/counterfactual_four_models_simulation.csv`
- Equivalent generation logic: `scripts/modeling/counterfactual-four-models-simulation.ts`
- Morning workbook implementation: `scripts/morning-model-report.ts::buildCounterfactualResult` and `writeCounterfactualWorkbook`

Wrong current source path:
- `scripts/morning-model-report.ts::buildAcceptedCounterfactualPolicyRows`

Bug:
- The function built one `windowRows` map from `Primary COV_CAP (все)` and reused it for `SCORE_GE_72`, `ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE`, and `ALT3_FLAT10_RAW_PROFIT_APPROX`.
- This caused `02_Model_Ranking`, `04_Recent_Windows`, and `00_CEO_Decision` ALT lines to inherit Primary COV_CAP 24h/7d values.

Required one-match accepted values:
- Score >=72 7d ROI: 14.96%; 24h ROI: -0.18%
- Primary COV_CAP 7d ROI: 28.08%; 24h ROI: 17.34%
- ALT1 Best Coverage 7d ROI: 14.96%; 24h ROI: -0.18%
- ALT3 Avoid NBA/NHL 7d ROI: 14.18%; 24h ROI: 16.06%

Final status:
- `buildAcceptedCounterfactualPolicyRows` now selects windows by model-specific `Model (mode)` one-match labels.
- Model ranking source classification after patch: `TRUSTED_USED_NOW`.
- Regenerated workbook verification:
  - Primary COV_CAP one-match: N=201, 24h ROI=17.3%, 7d ROI=28.1%.
  - Score >=72 one-match: N=297, 24h ROI=-0.2%, 7d ROI=15.0%.
  - ALT1 Best Coverage one-match: N=297, 24h ROI=-0.2%, 7d ROI=15.0%.
  - ALT3 Avoid NBA/NHL one-match: N=396, 24h ROI=16.1%, 7d ROI=14.2%.
- Hard gate: `MODEL_RANKING_COLLAPSE_BUG_FIXED`.

Workflow verdict: `SOURCE_MAP_AND_MINIMAL_REPAIR_READY`; reporting data-truth PASS, pending founder manual cron/email gate.
