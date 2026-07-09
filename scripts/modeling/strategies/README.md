# Strategy Scripts — Rules and Read-Only Reuse Pattern (Phase 3C.2 / 3D.2A)

This directory does not yet contain a strategy runner implementation.
This README is docs-only: it defines the rules future strategy scripts must
follow, and documents the reuse pattern found in the existing codebase. It
does not implement anything itself.

## Strategy declarations (Phase 3D.2A)

Schema: `scripts/modeling/strategies/strategy_declarations.schema.json`

**Declarations are not runners.** A declaration file under
`scripts/modeling/strategies/declarations/*.json` is a read-only contract
that documents, with exact source-line evidence, what a strategy's filters,
dedup key, stake mode, and data source actually are in the current
codebase. Declarations do not execute anything, do not read from the
database, and are not a substitute for the strategy runner planned in a
later phase.

First normalized declarations (Phase 3D.1 line-verified, `status:
READY_TO_NORMALIZE`):

- `scripts/modeling/strategies/declarations/baseline_v1_control.json`
- `scripts/modeling/strategies/declarations/primary_v1_avoid_nba_nhl_cov_cap.json`
- `scripts/modeling/strategies/declarations/alt1_one_per_event_best_coverage.json`
- `scripts/modeling/strategies/declarations/score_ge_72_family.json`

Blocked strategies pending founder decision (Phase 3D.1 found source
conflicts between the strategy's name and its actual implementation — see
`modeling/model_registry/model_strategy_registry.md` Phase 3D.1 section for
details — these do NOT have declaration files yet):

- `ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH`
- `ALT3_V1_AVOID_NBA_NHL`
- `ALT_SM_GUARD` / `ALT_SM_GUARD_ON_PRIMARY`

The next phase (Phase 3D.2B) is pure `event_group_key` helper extraction
from `lib/modeling/onePerMatchBacktest.ts` into a standalone, side-effect-free
module — not a database backtest run. No strategy declaration in this
directory authorizes running a backtest or querying live data.

## Phase 3D.2B: pure event group selection helper

`lib/modeling/eventGroupSelection.ts` is a pure, side-effect-free helper
extracted from the fallback-chain logic in
`lib/modeling/onePerMatchBacktest.ts`'s internal `eventGroup()` function. It
exports `EVENT_GROUP_KEY_FIELD_PRIORITY`, `buildEventGroupKey`,
`groupRowsByEventGroup`, and `selectFirstPerEventGroup`. It:

- does not run strategies or backtests;
- does not read from or write to any database;
- does not persist anything to disk;
- takes a caller-supplied ranking comparator rather than embedding any
  strategy-specific score/coverage logic itself.

It is **not yet wired into** `lib/modeling/onePerMatchBacktest.ts` or any
strategy declaration -- this phase only introduces the standalone, tested
module. A future runner should use this helper (not a re-implementation of
the fallback chain) for any one-event/one-match selection, so that the
canonical dedup key stays in one place instead of drifting across scripts.

`ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH`, `ALT3_V1_AVOID_NBA_NHL`, and
`ALT_SM_GUARD` / `ALT_SM_GUARD_ON_PRIMARY` remain blocked pending founder
decision (see the "Blocked strategies" list above) -- this phase does not
change their status.

## Rules for future strategy scripts

1. **Read-only by default.** A strategy script's selection/scoring logic
   must not write to the database or persist any artifact as a side effect
   of computing a selection. If a strategy needs to publish/persist a
   result, that must be a separate, explicitly-invoked step, not something
   that happens automatically when the selection function runs.
2. **Every strategy must declare, at minimum:**
   - `dataset` — which table/dataset it reads from (per
     `modeling/model_registry/dataset_registry.md`)
   - `formula model` — which return/PnL/score formula key it uses (per
     `modeling/model_registry/model_strategy_registry.md`)
   - `filters` — score thresholds, coverage thresholds/caps, league
     avoid-lists, smart-money guards, market class/tier filters,
     volume/liquidity filters, hours-before-start filters
   - `one-match key` — which field it uses for one-per-match/one-per-event
     dedup (see the "One-match dedup gap" note in
     `model_strategy_registry.md` — do not assume `match_family_key`,
     `event_group_key`, and `normalized_match_key` are interchangeable
     without checking)
   - `stake mode` — flat stake, proportional, or other
   - `date mode` — which date field (`created_at` vs `resolved_at`) anchors
     its window/selection logic
3. **No strategy can be promoted to live/primary status while its
   `reproducibilityStatus` is `MISSING_SCRIPT`, `DOC_ONLY`, or
   `CONTRACT_STUB`.** Only `HAS_SCRIPT` or `HAS_SQL` (with real, non-stub
   executable logic) are eligible for promotion consideration. See
   `modeling/model_registry/model_strategy_registry.json` for current status
   per strategy.
4. **Separate pure selection/backtest logic from persist/write logic.**
   Reference example in this repo: `lib/modeling/onePerMatchBacktest.ts`
   mixes the pure function `runOnePerMatchBacktestFromRows` with write
   functions (`persistOnePerMatchBacktest`, `writeOnePerMatchSummary`) in
   the same module — this is the pattern to avoid. A new strategy script
   should keep its selection function callable with zero side effects, and
   put any persistence in a distinctly named, separately invoked function.
5. **DQA must run before strategy comparison.** Run DQA-R1
   (`resultFieldConsistency`), DQA-R2 (`returnFormulaConsistency`), and
   DQA-R3 (`dateModeConsistency`) from `lib/modeling/datasetAudit/*.ts`
   against the input rows before applying any strategy filter or comparing
   strategies against each other. If any audit reports
   `hasBlockingViolations: true`, stop and resolve the data-quality issue
   before trusting a strategy comparison built on that data.

## Reference examples found in the repo

- `lib/modeling/onePerMatchBacktest.ts` — contains the pure function
  `runOnePerMatchBacktestFromRows` alongside write functions in the same
  module (see rule 4 above). The pure function can in principle be reused,
  but the module as a whole needs a refactor before it is a safe backtest
  primitive.
- `scripts/modeling/one-per-match-backtest.ts` — the CLI entrypoint that
  fetches `generated_signal_pairs` and always calls the persist step. Not
  safe to reuse as a read-only runner as-is.
- `scripts/modeling/analyze-ice1-freeze.py` — reads a frozen local CSV
  (`ICE1_MODEL_INPUT_PATH`), not a live DB, and only writes local report
  markdown files. Safe pattern for backtest-style analysis because it has no
  live DB write path.
- `scripts/fire-model/queryRunner.ts` (`runRegisteredQuery`) — reads via a
  registry-bound, read-only Supabase REST query. Good reference pattern for
  how a future strategy comparison runner should source its data: a
  registered query contract (see `modeling/sql_registry/`), not an ad-hoc
  query.

## What is registered so far

See `modeling/model_registry/model_strategy_registry.md` and
`model_strategy_registry.json` for the full list of known strategy policy
names, their category, and their current `reproducibilityStatus`
(`HAS_SCRIPT` / `HAS_SQL` / `CONTRACT_STUB` / `DOC_ONLY` / `MISSING_SCRIPT`
/ `UNKNOWN`). Several `modeling/sql_registry/models/*.sql` files are
`CONTRACT_STUB` — they document intent but contain no executable selection
logic yet, and per rule 3 above must not be promoted.
