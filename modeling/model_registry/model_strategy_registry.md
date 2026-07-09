# Model Strategy Registry — Phase 3C.2 / 3D.1 / 3D.2A / 3D.2G

## Purpose

This is the permanent, versioned record separating context contours, formula
models, strategy/filter policies, execution policies, dataset artifacts, and
DQA audits. Future model/strategy work MUST cite this registry instead of
relying on memory, screenshots, or ad-hoc SQL.

Companion machine-readable file: `modeling/model_registry/model_strategy_registry.json`

Source evidence: Phase 3C.1 inspect report (branch
`claude/dqa-r1-baseline-verify-itidmp`, HEAD `fe6f87e`).

## Founder mandatory comparison strategy (Phase 3D.2G)

- **`FORMULA_TRUSTED_INITIAL_V1_1_ALL`** (rawName `FORMULA::trusted-initial-formula-v1.1`)
  — a founder-mandated, mandatory-comparison strategy declaration
  (`requiredForComparison: true`,
  `scripts/modeling/strategies/declarations/trusted_initial_formula_v1_1_all.json`).

It is a **formula-version cohort wrapper**, not a reimplementation of the
internal formula algorithm: it selects all rows whose formula-version field
equals `trusted-initial-formula-v1.1` (`selectionUnit: "all rows"`,
`filters.formulaVersionEquals`). The raw formula itself remains classified as
a `FORMULA_MODEL` in the separate `trusted-initial-formula-v1.1` registry
entry, which is untouched by this promotion.

Future read-only comparison runners **must include** this strategy by default
because of its `requiredForComparison: true` flag. It is **not live-approved**:
per its `promotionBlockedReasons`, no live promotion may happen without fresh
7D/14D windows, a DQA-clean read-only comparison, and explicit founder
approval. The founder's strong-30D performance evidence is a screenshot/chat
artifact — no July-8-dated model report exists in this repo (Phase 3D.2F).

## Phase 3D.1 line-verification update

Phase 3D.1 line-verified (read actual source lines, not just grep hits) four
strategies against their implementing code:

- `BASELINE_V1_CONTROL`
- `PRIMARY_V1_AVOID_NBA_NHL_COV_CAP`
- `ALT1_ONE_PER_EVENT_BEST_COVERAGE`
- `SCORE_GE_72` family (`SCORE_GE_72_AVOID_6_24H`, `SCORE_GE_72_AVOID_3_12H_LEGACY`,
  `COVERAGE_GE_75_SCORE_GE_72`)

These four now have `lineVerified: true` and a `declarationPath` pointing at
a read-only JSON declaration under `scripts/modeling/strategies/declarations/`
(see Phase 3D.2A section below).

Line-verification also surfaced **source conflicts** (implementation
disagrees with the strategy's own name) for three strategies previously
marked `confidence: MEDIUM` / name-derived:

- `ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH` — the TypeScript "APPROX"
  fallback does NOT implement the smart-money exclusion its name claims;
  only the Python implementation does.
- `ALT3_V1_AVOID_NBA_NHL` — the Python fallback predicate does NOT filter
  NBA/NHL despite its name; only the TypeScript counterfactual path does.
- `ALT_SM_GUARD_ON_PRIMARY` — the bare `ALT_SM_GUARD` name is not
  implemented anywhere; `ALT_SM_GUARD_ON_PRIMARY` without the `_APPROX`
  suffix is only a text label inside a `console.log`, not executable logic.

These three are marked `status: BLOCKED_SOURCE_CONFLICT` in the JSON
registry and are **not** promoted to `READY_TO_NORMALIZE` declarations.
Resolving which implementation (or neither) is canonical requires a founder
decision, not further source reading alone.

## Phase 3D.2A: strategy declarations (this phase)

Read-only, non-executable strategy declarations now exist for the four
line-verified strategies above, under
`scripts/modeling/strategies/declarations/`, validated against
`scripts/modeling/strategies/strategy_declarations.schema.json`. See
`scripts/modeling/strategies/README.md` for the declaration rules and the
list of blocked strategies pending founder decision.

## Definitions

- **Context contour** — a named project/roadmap phase or execution
  environment (e.g. `FireModel`, `Contur3`, `Blue_model2`/`BLUE_MODEL3`,
  `Ice1`). A context contour is never itself an executable formula or
  selection rule — it is the umbrella label under which formulas, strategies,
  and execution policies exist.
- **Formula model** — a named PnL/return calculation or scoring version key
  (e.g. `realized-flat-stake-v1`, `trusted-initial-formula-v1.1`). A formula
  model answers "how is the return/score number computed?", not "which rows
  are selected?".
- **Strategy policy** — a named selection/filter rule applied to a set of
  candidate rows to decide which ones are bet on and how (e.g.
  `BASELINE_V1_CONTROL`, `ALT1_ONE_PER_EVENT_BEST_COVERAGE`). A strategy
  policy consumes a dataset and (usually) a formula model, and answers
  "which rows, filtered how, staked how?".
- **Execution policy** — a named live-execution behavior governing how an
  already-selected strategy is routed to real orders (e.g.
  `TIERED_LIVE_CONTOUR`'s tier fallback). Execution policy is downstream of
  strategy policy and is not itself a scoring or selection rule.

These four are distinct and must not be conflated: a context contour is not
a formula model; a formula model is not a strategy policy; a strategy policy
is not an execution policy. Mislabeling any of these in future work will
produce false claims of reproducibility.

## Contract-stub warning

`modeling/sql_registry/models/*.sql` files (`champion_current_v1.sql`,
`published_one_per_fixture_v1.sql`, `fire_family_selective_v1.sql`,
`safety_baseline_v1.sql`, `tiered_live_contour_v1.sql`) are
**CONTRACT_STUB** files — each contains only metadata comments (`sql_id`,
`purpose`, `source_tables`, `output_grain`, `expected_columns`) plus a
placeholder `select '<sql_id>' as sql_id;`. They are **NOT** full executable
strategy logic. Do not label them as implemented executable strategies, and
do not promote a strategy to live/primary status based on a contract stub
alone — see `scripts/modeling/strategies/README.md` promotion rule.

## One-match dedup gap

Multiple tables/scripts appear to represent "one row per match/event"
deduplication, but under different field names with no confirmed single
canonical key:

- `match_family_key` (used in `night_event_reservations`,
  `event_execution_queue`, `lib/modeling/onePerMatchBacktest.ts`)
- `event_group_key` (used in `lib/modeling/onePerMatchBacktest.ts`)
- `normalized_match_key` (used in `track_record_shown_signal_history`,
  `track_record_window_results`)

Whether these three keys are guaranteed to agree on the same physical
match/event across all tables has not been verified. This is an open gap:
any strategy claiming `oneMatchModeSupported: YES` must state which of these
keys it actually uses, and that key's cross-table consistency should be
checked (ideally via a future DQA rule) before being trusted for
one-per-match dedup guarantees.

## Model Name Taxonomy

| raw_name | category | role/status | reproducibility | evidence path | confidence |
|---|---|---|---|---|---|
| FireModel / FIREMODEL | CONTEXT_CONTOUR | baseline framework/research family | DOC_ONLY | `modeling/fire_model_registry.json:1`; `modeling/sql_registry/README.md:1` | HIGH |
| Contur3 | CONTEXT_CONTOUR | live execution contour | HAS_SCRIPT | `scripts/contur3/*`; `docs/operations/CONTUR3_*` | HIGH |
| Blue_model2 | CONTEXT_CONTOUR | superseded | DOC_ONLY | `docs/ops/BLUE_MODEL2_ROADMAP.md:1` | HIGH |
| BLUE_MODEL3 | CONTEXT_CONTOUR | current/superseding roadmap | DOC_ONLY | `docs/ops/BLUE_MODEL3_ROADMAP.md:4,30` | HIGH |
| Ice1 | CONTEXT_CONTOUR | frozen research sprint | HAS_SCRIPT | `scripts/modeling/analyze-ice1-freeze.py:714` | HIGH |
| Ice1_M_Roadmap | UNKNOWN | not found | MISSING_SCRIPT | — | HIGH |
| Model_Review_Class1 | UNKNOWN | roadmap label only | DOC_ONLY | — | MEDIUM |
| trusted-initial-formula-v1.1 | FORMULA_MODEL | unknown, grep-hit only | UNKNOWN | repo-wide grep hits | LOW |
| v2-lite-growth-safe | FORMULA_MODEL | unknown, grep-hit only | UNKNOWN | repo-wide grep hits | LOW |
| shadow-strategic-sports-v1 | FORMULA_MODEL | shadow/research, grep-hit only | UNKNOWN | repo-wide grep hits | LOW |
| shadow-firemodel1_1_research_v0 | FORMULA_MODEL | shadow/research, grep-hit only | UNKNOWN | repo-wide grep hits | LOW |
| realized-flat-stake-v1 | FORMULA_MODEL | live default for display window results | HAS_SQL | `supabase/migrations/20260702_track_record_window_results.sql` | HIGH |
| DQA-R1 (resultFieldConsistency) | DQA_AUDIT | baseline, live in repo | HAS_SCRIPT | `lib/modeling/datasetAudit/resultFieldConsistency.ts` | HIGH |
| DQA-R2 (returnFormulaConsistency) | DQA_AUDIT | baseline, live in repo | HAS_SCRIPT | `lib/modeling/datasetAudit/returnFormulaConsistency.ts` | HIGH |
| DQA-R3 (dateModeConsistency) | DQA_AUDIT | baseline, live in repo | HAS_SCRIPT | `lib/modeling/datasetAudit/dateModeConsistency.ts` | HIGH |
| CHAMPION_CURRENT | STRATEGY_POLICY | live (by name) | CONTRACT_STUB | `modeling/sql_registry/models/champion_current_v1.sql` | HIGH |
| PUBLISHED_ONE_PER_FIXTURE | STRATEGY_POLICY | challenger | CONTRACT_STUB | `modeling/sql_registry/models/published_one_per_fixture_v1.sql` | HIGH |
| FIRE_FAMILY_SELECTIVE | STRATEGY_POLICY | shadow | CONTRACT_STUB | `modeling/sql_registry/models/fire_family_selective_v1.sql` | HIGH |
| SAFETY_BASELINE | STRATEGY_POLICY | baseline | CONTRACT_STUB | `modeling/sql_registry/models/safety_baseline_v1.sql` | HIGH |
| TIERED_LIVE_CONTOUR | EXECUTION_POLICY | live | CONTRACT_STUB | `modeling/sql_registry/models/tiered_live_contour_v1.sql` | HIGH |

## Strategy Registry Draft

| canonical_strategy_id | aliases | category | one_match_mode | selection_unit | filters (name-derived unless noted) | source path | reproducibility |
|---|---|---|---|---|---|---|---|
| BASELINE_V1_CONTROL | "0", "FLAT_ALL" | STRATEGY_POLICY | UNKNOWN | all rows | none (control group) | `scripts/morning-model-report.ts` | HAS_SCRIPT |
| PRIMARY_V1_AVOID_NBA_NHL_COV_CAP | — | STRATEGY_POLICY | UNKNOWN | unknown | avoid NBA/NHL, coverage cap | `scripts/morning-model-report.ts` | HAS_SCRIPT |
| ALT_SM_GUARD_ON_PRIMARY | ALT_SM_GUARD, ALT_SM_GUARD_ON_PRIMARY_APPROX | STRATEGY_POLICY | UNKNOWN | unknown | smart-money guard | `scripts/firemodel1-decision-board.ts`, `scripts/modeling/analyze-ice1-freeze.py` | HAS_SCRIPT |
| ALT1_ONE_PER_EVENT_BEST_COVERAGE | — | STRATEGY_POLICY | YES (name-derived, key not verified) | one per event | best-coverage selection | `scripts/morning-model-report.ts`, `scripts/modeling/analyze-ice1-freeze.py` | HAS_SCRIPT |
| ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH | — | STRATEGY_POLICY | UNKNOWN | unknown | exclude high smart-money flow | `scripts/morning-model-report.ts` | HAS_SCRIPT |
| ALT3_V1_AVOID_NBA_NHL | — | STRATEGY_POLICY | UNKNOWN | unknown | avoid NBA/NHL | `scripts/morning-model-report.ts` | HAS_SCRIPT |
| SCORE_GE_72_AVOID_6_24H | — | STRATEGY_POLICY | UNKNOWN | unknown | score>=72, 6-24h avoid window | `scripts/modeling/analyze-ice1-freeze.py` | HAS_SCRIPT (frozen CSV only) |
| SCORE_GE_72_AVOID_3_12H_LEGACY | — | STRATEGY_POLICY | UNKNOWN | unknown | score>=72, 3-12h avoid window (legacy) | `scripts/modeling/analyze-ice1-freeze.py` | HAS_SCRIPT (frozen CSV only) |
| COVERAGE_GE_75_SCORE_GE_72 | — | STRATEGY_POLICY | UNKNOWN | unknown | score>=72, coverage>=75 | `scripts/modeling/analyze-ice1-freeze.py` | HAS_SCRIPT (frozen CSV only) |
| CHAMPION_CURRENT | champion_current_v1 | STRATEGY_POLICY | UNKNOWN | unknown | none encoded (stub) | `modeling/sql_registry/models/champion_current_v1.sql` | CONTRACT_STUB |
| PUBLISHED_ONE_PER_FIXTURE | published_one_per_fixture_v1 | STRATEGY_POLICY | YES (name-derived) | one per match | none encoded (stub) | `modeling/sql_registry/models/published_one_per_fixture_v1.sql` | CONTRACT_STUB |
| FIRE_FAMILY_SELECTIVE | fire_family_selective_v1 | STRATEGY_POLICY | UNKNOWN | unknown | none encoded (stub) | `modeling/sql_registry/models/fire_family_selective_v1.sql` | CONTRACT_STUB |
| SAFETY_BASELINE | safety_baseline_v1 | STRATEGY_POLICY | NO | all rows | none encoded (stub) | `modeling/sql_registry/models/safety_baseline_v1.sql` | CONTRACT_STUB |
| TIERED_LIVE_CONTOUR | tiered_live_contour_v1 | EXECUTION_POLICY | UNKNOWN | unknown | Tier1/2/3 fallback (name-derived) | `modeling/sql_registry/models/tiered_live_contour_v1.sql` | CONTRACT_STUB |

## Missing Strategy List

The following names were explicitly searched for and are **NOT FOUND**
anywhere in the repository. They must not be treated as implemented until a
script or SQL contract is added:

- `ALT3_V1_AVOID_NBA_NHL_RAW_PROFIT` (a differently-named sibling,
  `ALT3_FLAT10_RAW_PROFIT_APPROX`, exists but is not the same identifier)
- `ALT_AGGR_COVTIER_6_12`
- `ALT_SM75_GATE_FLAT`
- `ALT_COV75_FIRST_SM_IGNORED`
- `SCORE_GE_50`
- `SCORE_60_71`
- `BLUE_MODEL2_SAFE_CORE_V1`
