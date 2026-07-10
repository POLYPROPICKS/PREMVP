# generated_signal_pairs Local Export Spec

Status: Phase 3D.2L. Docs-only. This spec describes the shape and
validation rules for a **local JSON export** of `generated_signal_pairs`
rows, produced outside this workstream, for use with the read-only
comparison CLI. It does not authorize any database write, any live
execution, or any ROI/PnL claim.

## Purpose

- Define exactly what a local export file must contain before it can be
  used for strategy comparison, and what it must contain before it can ever
  be used for ROI/PnL work.
- No DB writes -- this spec describes an input file the CLI reads; it does
  not describe how that file is produced (that remains a separate,
  founder-controlled export step).
- No live promotion -- passing every rule in this spec makes an export
  *usable for local, read-only research*, not a live model.

## Current rule: the export must be dedup-clean by strict key

The strict dedup key is `condition_id + token_id` (aliases `conditionId` /
`tokenId` accepted), the same identity pair
`lib/modeling/onePerMatchBacktest.ts`'s `strictKey()` uses to collapse
duplicate rows before backtest grouping.

- `validateGeneratedSignalPairsExportRows()`
  (`lib/modeling/generatedSignalPairsExportContract.ts`) **detects**
  duplicate strict keys via `duplicateStrictKeyRows`,
  `uniqueStrictDedupKeys`, `rowsMissingStrictDedupKey`, and
  `hasDuplicateStrictKeyRisk`. It does **not** deduplicate anything -- no
  row is ever dropped, merged, or reordered by this contract or by the CLI.
- If `duplicateStrictKeyRows > 0`, the export is not dedup-clean.
  **ROI work must not proceed on this export** until the duplicates are
  resolved (fixed in the export step) or the founder explicitly accepts the
  risk with a documented reason.
- `rowsMissingStrictDedupKey > 0` means some rows cannot even be checked for
  duplication (missing `condition_id` and/or `token_id`). This must be
  explained (why are they missing?) before ROI, not silently ignored.

## Required fields for future ROI

An export intended for eventual ROI/PnL work (Phase 3E.1+) should populate,
grouped by purpose:

- **Identity**: `id`, `condition_id` (or `conditionId`), `token_id` (or
  `tokenId`)
- **Timestamps**: `created_at`, `resolved_at`
- **Formula**: `formula_version` / `metric_formula_version` /
  `diagnostics.formulaVersion` (at least one)
- **Scoring**: `score` / `signal_score`
- **Coverage**: `coverage` / `coverage_score`
- **Outcome**: `signal_result` / `result` / `outcome_status`
- **Price/return**: `entry_price_num`, `realized_return_pct`
- **Event grouping**: `match_family_key`, `canonical_event_key`,
  `parent_event_key`, `event_slug`, `event_title`, `market_slug`
- **League/timing for future filters**: `league` (or equivalent),
  `hours_until_start` (or equivalent)

Missing any of these does not make an export invalid for structural
validation (`validateGeneratedSignalPairsExportRows` reports coverage of
each, it does not reject the file) -- but each gap narrows what can be
compared or later computed, and must be accounted for in any report that
uses the export.

## Blocking validation rules before ROI

All of the following must hold, or be explicitly accepted by the founder
with a documented reason, before any ROI/PnL figure is trusted:

1. DQA-R1 (`resultFieldConsistency`), DQA-R2 (`returnFormulaConsistency`),
   DQA-R3 (`dateModeConsistency`), and DQA-R4
   (`outcomeResolutionConsistency`) must all report no blocking violations
   on the export.
2. `duplicateStrictKeyRows` must be `0`.
3. `rowsMissingStrictDedupKey` must be explained (why those rows lack
   identity fields) or the export must be blocked from ROI use.
4. The export's time window (created_at/resolved_at range) must be stated
   explicitly in any report -- an unstated window is not acceptable.
5. Any formula-version cohort comparison (e.g.
   `FORMULA_TRUSTED_INITIAL_V1_1_ALL`) must be compared against other
   strategies over the **same time window**, not the full unbounded
   history, to avoid comparing different market regimes/epochs as if they
   were the same population.

## ROI discipline

- The current comparison CLI's ROI state is **`NOT_COMPUTED`** -- no ROI/PnL
  code exists in this stack. This is by design, not an oversight.
- Any historical ROI figure referenced in founder screenshots/chat is
  **historical founder evidence only** -- it has not been reproduced by this
  workstream and must not be presented as validated.
- The future ROI module (Phase 3E.1) must be a new, pure, unit-tested
  module. It **must NOT reuse `outcome()` or `normalizePick()` from
  `lib/modeling/onePerMatchBacktest.ts`** -- those functions contain the
  DQA-R4-documented quirk (a win-labelled row without a valid price or
  return silently becomes unresolved), and reusing them would let that
  quirk leak into a ROI figure that is otherwise presented as "clean."
- No document, report, or CLI output produced from this spec may state or
  imply a guaranteed profit, in either direction.

## Checkpoint A output template

Every report produced after running the CLI on a real local export must
include:

```
totalRows: <number>
uniqueStrictDedupKeys: <number>
duplicateStrictKeyRows: <number>
rowsMissingStrictDedupKey: <number>
rowsWithFormulaVersion: <number>
selectedRows (FORMULA_TRUSTED_INITIAL_V1_1_ALL): <number>
DQA-R4 hasBlockingViolations: <true|false>
ROI state: NOT_COMPUTED | BLOCKED_BY_DQA | BLOCKED_BY_DUPLICATES | VALID_LOCAL_ONLY
```

`ROI state` values:

- `NOT_COMPUTED` -- no ROI code has run yet (the current default; true until
  Phase 3E.1/3E.2 exist).
- `BLOCKED_BY_DQA` -- ROI code exists and ran, but DQA-R1/R2/R3/R4 reported a
  blocking violation on this export that was not explicitly accepted.
- `BLOCKED_BY_DUPLICATES` -- ROI code exists and ran, but
  `duplicateStrictKeyRows > 0` on this export and was not resolved/accepted.
- `VALID_LOCAL_ONLY` -- ROI computed on a DQA-clean, duplicate-clean local
  export using the tested Phase 3E.1 formula. Still not a production/live
  claim, and still not a guarantee of future performance.
