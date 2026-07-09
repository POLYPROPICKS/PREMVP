# Strategy Scripts — Read-Only Reuse Pattern (Phase 3C.2)

This directory does not yet contain a strategy runner implementation.
This README documents the pattern future strategy comparison scripts should
follow, based on what Phase 3C.1 inspect found in the existing codebase. It
does not implement anything itself.

## The core problem this pattern solves

Several existing modules mix pure, read-only backtest/scoring logic with
persist/write logic in the same file or function. That makes them unsafe to
reuse directly for read-only strategy comparison, because calling them can
have side effects (writing to the DB or to local report artifacts) that a
comparison run should not trigger.

## Reference examples found in the repo

- `lib/modeling/onePerMatchBacktest.ts` — contains a pure function,
  `runOnePerMatchBacktestFromRows`, alongside write functions
  (`persistOnePerMatchBacktest`, `writeOnePerMatchSummary`) in the same
  module. The pure function can in principle be reused for read-only
  comparison, but the module as a whole needs a refactor to cleanly separate
  the read-only computation from the write path before it should be treated
  as a safe backtest primitive.
- `scripts/modeling/one-per-match-backtest.ts` — the CLI entrypoint that
  fetches `generated_signal_pairs` and always calls the persist step. Not
  safe to reuse as a read-only runner as-is.
- `scripts/modeling/analyze-ice1-freeze.py` — reads a frozen local CSV
  (`ICE1_MODEL_INPUT_PATH`), not a live DB, and only writes local report
  markdown files. This is a safe pattern for backtest-style analysis because
  it has no live DB write path.
- `scripts/fire-model/queryRunner.ts` (`runRegisteredQuery`) — reads via a
  registry-bound, read-only Supabase REST query. This is a good reference
  pattern for how a future strategy comparison runner should source its
  data: a registered query contract (see `modeling/sql_registry/`), not an
  ad-hoc query.

## Recommended shape for a future strategy runner (not implemented here)

1. Read input rows via a registered, read-only query contract (pattern:
   `scripts/fire-model/queryRunner.ts`), sourced from `generated_signal_pairs`
   per `modeling/model_registry/dataset_registry.md`.
2. Run DQA-R1/R2/R3 (`lib/modeling/datasetAudit/*.ts`) against the input
   rows before applying any strategy filter, and stop/flag if
   `hasBlockingViolations` is true.
3. Apply a strategy filter/selection function that takes rows in and returns
   rows out, with no side effects (no persist, no file write) — modeled on
   `runOnePerMatchBacktestFromRows`'s pure computation, not its calling
   script's persist step.
4. Only after computation is complete, optionally hand the result to a
   separate, explicitly-named write/report step — never mix that into the
   same function as the selection logic.

## What is registered so far

See `modeling/model_registry/model_strategy_registry.md` and
`model_strategy_registry.json` for the full list of known strategy policy
names, their category, and their current reproducibility status
(`HAS_SCRIPT` / `HAS_SQL` contract-stub-only / `MISSING_SCRIPT`). Several
`modeling/sql_registry/models/*.sql` files are contract stubs only — they
document intent but contain no executable selection logic yet.
