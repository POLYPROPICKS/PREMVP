# Model_Review_Class1 Dataset Build Audit

## Accepted findings

- `generated_signal_pairs` is the canonical full candidate/resolved model
  audit dataset.
- `track_record_*` tables are display/read-model layers, not full-model
  audit datasets.
- Build flow writes candidate/generated rows into `generated_signal_pairs`.
- Resolver later writes `signal_result`, `resolved_at`, `winning_outcome`,
  and `realized_return_pct` back onto those rows.

## Main risks

- Result casing mismatch: lowercase `won`/`lost` vs uppercase `WIN`/`LOSS`
  used elsewhere.
- Divergent PnL formulas across scripts/consumers.
- `created_at` vs `resolved_at` ambiguity when defining a review window.
- Strict token dedup vs one-event/one-match dedup divergence producing
  different sample counts and win rates.
- One-per-match engine writes to DB without dry-run.
- Score null / confidence fallback risk skewing ranking-based comparisons.
- `formula_version` vs `metric_formula_version` confusion when attributing
  results to a model version.
- Sport/league heuristic and `UNKNOWN_OR_SPORTS` leakage contaminating
  sport-scoped comparisons.

## State

No V2 model selection (PRIMARY/ALT/SHADOW/KILL) until P0/P1 dataset risks
listed in `dataset_bug_backlog.md` are fixed or explicitly controlled.
