# Morning Model Report Spec

## Purpose

Send a founder-readable daily morning report that freezes the latest resolved strict-token corpus, reruns Ice1 KPI analysis, and summarizes the current model decision state.

## Schedule

- Local target: 09:00 Minsk
- UTC target: 06:00 UTC
- Cron: `0 6 * * *`

## Runtime Flow

1. Read the latest DB state.
2. Build a strict-deduped resolved freeze using `condition_id::selected_token_id`.
3. Save the freeze at `modeling/morning_model_report/YYYYMMDD_0600UTC/input/resolved_freeze.csv`.
4. Re-run the existing Ice1 freeze analysis against that input.
5. Write local reports and tables under the same timestamped folder.
6. Email the founder when the runner is invoked in send mode.

## Email Sections

- Corpus summary
- Latest resolver job health
- Latest signal-cache job health
- Model KPI highlights
- Decision summary
- Night Battle Look placeholder

## Outputs

- `MORNING_REPORT.md`
- `reports/00_input_freeze_summary.md`
- `reports/01_policy_kpis.md`
- `reports/02_cohorts.md`
- `reports/03_bankroll_simulations.md`
- `reports/04_decision_board.md`
- `tables/policy_kpis.csv`
- `tables/decision_board.csv`
- `tables/bankroll_simulations.csv`
- `tables/run_summary.json`

## Cron Command

- `npm run morning:model-report -- --send-test`

## TODO

- Add founder night battle detail table format later.
