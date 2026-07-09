# Model Strategy Registry — Phase 3C.2

## Purpose

This is the permanent, versioned record separating context contours, formula
models, strategy/filter policies, execution policies, dataset artifacts, and
DQA audits. Future model/strategy work MUST cite this registry instead of
relying on memory, screenshots, or ad-hoc SQL.

Companion machine-readable file: `modeling/model_registry/model_strategy_registry.json`

Source evidence: Phase 3C.1 inspect report (branch
`claude/dqa-r1-baseline-verify-itidmp`, HEAD `fe6f87e`).

## Categories

- `CONTEXT_CONTOUR` — a named project/roadmap phase or execution contour
  (FireModel, Contur3, Blue_model2, etc.), not itself an executable model.
- `FORMULA_MODEL` — a named PnL/return calculation formula or scoring
  version key.
- `STRATEGY_POLICY` — a named selection/filter policy applied to candidates.
- `EXECUTION_POLICY` — a named live-execution behavior (fallback tiers,
  contour routing).
- `DATASET_ARTIFACT` — a named SQL registry contract describing a dataset
  view/model definition.
- `DQA_AUDIT` — one of the DQA-R1/R2/R3 pure audit modules.
- `UNKNOWN` — name requested/expected but not found anywhere in the repo.

## Important registry truth (do not overstate reproducibility)

- `modeling/sql_registry/models/*.sql` files are **CONTRACT_STUB** files —
  each contains only metadata comments plus a placeholder
  `select '<sql_id>' as sql_id;`. They are NOT full executable strategy
  logic. Do not label them as implemented executable strategies.
- `scripts/modeling/analyze-ice1-freeze.py` is safe to reuse for backtest
  patterns because it reads a frozen local CSV (`ICE1_MODEL_INPUT_PATH`), not
  a live DB.
- `scripts/modeling/one-per-match-backtest.ts` reads `generated_signal_pairs`
  from the DB and has a persist/write path (`persistOnePerMatchBacktest`), so
  it is NOT safe to reuse as a read-only runner as-is.
- `lib/modeling/onePerMatchBacktest.ts` mixes pure backtest functions
  (`runOnePerMatchBacktestFromRows`) with persist/write functions
  (`persistOnePerMatchBacktest`, `writeOnePerMatchSummary`) in the same
  module; the pure function can be reused, but the module needs a refactor
  to separate read-only logic from write logic before it can be a safe
  backtest primitive.
- `scripts/fire-model/queryRunner.ts` is a good example of the read-only,
  registry-bound query pattern (`runRegisteredQuery`) — a reasonable model
  for how future strategy comparison runners should read data.

## Context Contours

| raw_name | category | status | evidence | notes |
|---|---|---|---|---|
| FireModel / FIREMODEL | CONTEXT_CONTOUR | baseline framework/research family | `modeling/fire_model_registry.json:1`; `modeling/sql_registry/README.md:1`; `scripts/firemodel1-*.ts` | Umbrella framework name for the modeling registry + FireModel1 script family. |
| Contur3 | CONTEXT_CONTOUR | live execution contour | `scripts/contur3/*`; `docs/operations/CONTUR3_*` | Live execution contour, not a modeling dataset or formula. |
| Blue_model2 | CONTEXT_CONTOUR | superseded | `docs/ops/BLUE_MODEL2_ROADMAP.md:1` | "Blue_model2 — Contur3 Producer Roadmap". |
| BLUE_MODEL3 | CONTEXT_CONTOUR | current/superseding roadmap | `docs/ops/BLUE_MODEL3_ROADMAP.md:4,30` | Explicitly supersedes Blue_model2 scope. |
| Ice1 | CONTEXT_CONTOUR | frozen research sprint | `scripts/modeling/analyze-ice1-freeze.py:714` | Frozen CSV-based research sprint, not live. |
| Ice1_M_Roadmap | UNKNOWN | not found | — | Requested name not present anywhere in the repo. |
| Model_Review_Class1 | UNKNOWN | roadmap label only | — | Used as a task-routing label in agent prompts; not a repo artifact. |

## Formula Models

| raw_name | category | status | evidence | notes |
|---|---|---|---|---|
| trusted-initial-formula-v1.1 | FORMULA_MODEL | status unknown, grep-hit only | repo-wide grep hits | Full computation logic not read line-by-line during Phase 3C.1; do not assume behavior beyond the name. |
| v2-lite-growth-safe | FORMULA_MODEL | status unknown, grep-hit only | repo-wide grep hits | Same caveat as above. |
| shadow-strategic-sports-v1 | FORMULA_MODEL | shadow/research, grep-hit only | repo-wide grep hits | Same caveat as above. |
| shadow-firemodel1_1_research_v0 | FORMULA_MODEL | shadow/research, grep-hit only | repo-wide grep hits | Same caveat as above. |
| realized-flat-stake-v1 | FORMULA_MODEL | live default for display window results | `supabase/migrations/20260702_track_record_window_results.sql` (`metric_formula_version DEFAULT 'realized-flat-stake-v1'`) | The only formula key confirmed live/default in this repo. |

## DQA Audits

| raw_name | category | status | evidence |
|---|---|---|---|
| DQA-R1 (resultFieldConsistency) | DQA_AUDIT | baseline, live in repo | `lib/modeling/datasetAudit/resultFieldConsistency.ts`; `modeling/sql_registry/dataset_audits/02_result_field_consistency.sql` |
| DQA-R2 (returnFormulaConsistency) | DQA_AUDIT | baseline, live in repo | `lib/modeling/datasetAudit/returnFormulaConsistency.ts`; `modeling/sql_registry/dataset_audits/03_return_formula_sanity.sql` |
| DQA-R3 (dateModeConsistency) | DQA_AUDIT | baseline, live in repo | `lib/modeling/datasetAudit/dateModeConsistency.ts`; `modeling/sql_registry/dataset_audits/04_date_mode_created_vs_resolved.sql` |

## Strategy Policies (found with source evidence)

| canonical_strategy_id | category | reproducibility | evidence | notes |
|---|---|---|---|---|
| BASELINE_V1_CONTROL | STRATEGY_POLICY | HAS_SCRIPT | `scripts/morning-model-report.ts:653,930,1342,1698` | Aliases: "0", "FLAT_ALL". |
| PRIMARY_V1_AVOID_NBA_NHL_COV_CAP | STRATEGY_POLICY | HAS_SCRIPT | `scripts/morning-model-report.ts:654,931,1245,1291,1331` | — |
| ALT_SM_GUARD / ALT_SM_GUARD_ON_PRIMARY / ALT_SM_GUARD_ON_PRIMARY_APPROX | STRATEGY_POLICY | HAS_SCRIPT | `scripts/firemodel1-decision-board.ts:197`; `scripts/modeling/analyze-ice1-freeze.py:390,663` | Bare `ALT_SM_GUARD` without suffix not found standalone; always appears with `_ON_PRIMARY[_APPROX]`. |
| ALT1_ONE_PER_EVENT_BEST_COVERAGE | STRATEGY_POLICY | HAS_SCRIPT | `scripts/morning-model-report.ts:655`; `scripts/modeling/analyze-ice1-freeze.py:392,436,664` | — |
| ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH | STRATEGY_POLICY | HAS_SCRIPT | `scripts/morning-model-report.ts:656,933` | — |
| ALT3_V1_AVOID_NBA_NHL | STRATEGY_POLICY | HAS_SCRIPT | `scripts/morning-model-report.ts:657,934,1334` | — |
| SCORE_GE_72_AVOID_6_24H | STRATEGY_POLICY | HAS_SCRIPT | `scripts/modeling/analyze-ice1-freeze.py:364` | Ice1 frozen-CSV script only. |
| SCORE_GE_72_AVOID_3_12H_LEGACY | STRATEGY_POLICY | HAS_SCRIPT | `scripts/modeling/analyze-ice1-freeze.py:368` | Ice1 frozen-CSV script only. |
| COVERAGE_GE_75_SCORE_GE_72 | STRATEGY_POLICY | HAS_SCRIPT | `scripts/modeling/analyze-ice1-freeze.py:370,373` | Ice1 frozen-CSV script only. |
| CHAMPION_CURRENT / champion_current_v1 | STRATEGY_POLICY | HAS_SQL (contract stub only) | `modeling/sql_registry/models/champion_current_v1.sql` | No executable selection logic present, only contract metadata. |
| PUBLISHED_ONE_PER_FIXTURE / published_one_per_fixture_v1 | STRATEGY_POLICY | HAS_SQL (contract stub only) | `modeling/sql_registry/models/published_one_per_fixture_v1.sql` | Same caveat. |
| FIRE_FAMILY_SELECTIVE / fire_family_selective_v1 | STRATEGY_POLICY | HAS_SQL (contract stub only) | `modeling/sql_registry/models/fire_family_selective_v1.sql` | Same caveat. |
| SAFETY_BASELINE / safety_baseline_v1 | STRATEGY_POLICY | HAS_SQL (contract stub only) | `modeling/sql_registry/models/safety_baseline_v1.sql` | Same caveat. |
| TIERED_LIVE_CONTOUR / tiered_live_contour_v1 | EXECUTION_POLICY | HAS_SQL (contract stub only) | `modeling/sql_registry/models/tiered_live_contour_v1.sql` | Execution-tier fallback policy, not a scoring strategy. |

## Strategy Policies (requested, NOT found — MISSING_SCRIPT)

| canonical_strategy_id | category | reproducibility | notes |
|---|---|---|---|
| ALT3_V1_AVOID_NBA_NHL_RAW_PROFIT | UNKNOWN | MISSING_SCRIPT | Not found anywhere in the repo. A differently-named sibling (`ALT3_FLAT10_RAW_PROFIT_APPROX`) exists but is not the same identifier. |
| ALT_AGGR_COVTIER_6_12 | UNKNOWN | MISSING_SCRIPT | Not found anywhere in the repo. |
| ALT_SM75_GATE_FLAT | UNKNOWN | MISSING_SCRIPT | Not found anywhere in the repo. |
| ALT_COV75_FIRST_SM_IGNORED | UNKNOWN | MISSING_SCRIPT | Not found anywhere in the repo. |
| SCORE_GE_50 | UNKNOWN | MISSING_SCRIPT | Not found anywhere in the repo. |
| SCORE_60_71 | UNKNOWN | MISSING_SCRIPT | Not found anywhere in the repo. |
| BLUE_MODEL2_SAFE_CORE_V1 | UNKNOWN | MISSING_SCRIPT | Not found anywhere in the repo. |
