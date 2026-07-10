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

## Phase 3D.2N: strict dedup projection policy

The first real local export was found `BLOCKED_BY_DUPLICATES`
(66 unique strict keys across 5000 raw rows, 4934 duplicates, 0 rows
missing a strict key, DQA-R4 clean). A strict duplicate-projection policy
now exists to make progress possible without silently changing default
behavior:

- `lib/modeling/generatedSignalPairsDedupPolicy.ts`
  (`projectGeneratedSignalPairsStrictDedup`) collapses rows to one per
  strict dedup key (`condition_id` + `token_id`, reusing
  `getStrictDedupKeyForExportRow` from the export contract -- no
  reimplementation of key parsing).
- **The default CLI behavior remains raw rows.** Nothing is deduplicated
  unless the caller explicitly passes `--dedup-policy
  strict_latest_created_before_resolved`.
- **Selection policy**: for each strict key, prefer the row with the latest
  `created_at` that is still `<= resolved_at`; if no candidate satisfies
  that, fall back to the latest `created_at` overall (counted separately as
  `keysWithNoCreatedAtBeforeResolved`); ties break on lexicographically
  larger `id`, then on original row order (deterministic, stable).
- This is a **projection**, not a mutation: the original row array passed
  to the module is never changed. The CLI, when the flag is present, runs
  the strategy comparison (and DQA-R4, if `--include-dqa-r4` is also
  passed) against the projected (deduped) rows, while `inputValidation`
  keeps reporting on the raw rows unchanged.
- **This is still not ROI.** Deduplication only makes the row count honest
  for selection counting. ROI/PnL work (Phase 3E.1+) can only proceed once
  the dedup projection is applied (or duplicates are otherwise resolved)
  *and* the DQA audits report clean on the resulting rows.

## Automated read-only Supabase export workflow (Phase 3D.2Ob, preferred)

`scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts`
reads the latest resolved `generated_signal_pairs` rows directly from
Supabase and writes the local JSON export this spec's CLI commands expect,
with no clipboard step and no manual file editing.

- **Data path**: exact read-only count (`select("*", { count: "exact", head:
  true })`) of `public.generated_signal_pairs` rows with `resolved_at is not
  null`, then **all** of those rows fetched via paginated `.range()` reads
  (`select *`, ordered by `resolved_at` descending). Read-only -- no insert,
  update, delete, upsert, or rpc call exists anywhere in this module.

### Hidden dataset caps are forbidden in the model review path (Phase 3D.2P)

- There is **no default row cap**. `--page-size` (default 1000) is a
  transport batch size only -- it must never be read as a dataset limit.
- `--max-rows` (and the deprecated alias `--limit`) is an **explicit
  debug-only cap**. Any export produced with it is marked `exportMode:
  "DEBUG_CAPPED"` / `exportCompleteness: "INTENTIONALLY_CAPPED"` and **must
  not** be used to satisfy a model-review or ROI gate -- it is a sample,
  not a census.
- The preferred operator runner (`run-3d2o-from-supabase.cmd`) never passes
  `--max-rows`/`--limit`.
- The exporter always reports `availableResolvedRows` (exact count from
  Supabase) alongside `fetchedRows` (rows actually written to the local
  export), so a partial fetch is never silently indistinguishable from a
  full one.
- **ROI is blocked unless `exportCompleteness === "COMPLETE"`** (or the
  export is explicitly documented elsewhere as sample-only research, not a
  model-review input). An `"INCOMPLETE"` export -- `fetchedRows <
  availableResolvedRows` with no explicit cap -- means full-dataset
  coverage was not proven for that run; re-run before trusting any count
  derived from it. This directly prevents a repeat of the prior
  under-capture/partial-dataset failure mode this workstream exists to
  avoid.
- **Normalization**: schema drift (e.g. `selected_token_id` /
  `diagnostics.selectedTokenId` for `token_id`, `diagnostics.entryPrice` for
  `entry_price_num`, `pre_event_score_num` for `score`) is resolved in code,
  per row, without mutating the source row. No ROI/PnL/profit field is
  computed or added -- fields like `real_pnl_usd` / `realized_return_pct`
  are only passed through if already present on the source row.
- **Output path**: `modeling/local_exports/generated_signal_pairs_export.json`
  by default (overridable with `--output`), same path and shape as the
  Phase 3D.2Oa materializer's output.
- **Report path**: `modeling/local_exports/3d2o_dedup_report.json`, produced
  the same way as Phase 3D.2Oa -- piping through
  `run-readonly-comparison.ts` with `--input-format generated_signal_pairs
  --include-dqa-r4 --dedup-policy strict_latest_created_before_resolved`.
- **Env/config caveat**: requires `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` (the existing `lib/supabase/server.ts`
  convention) to be available to the process. No env value is ever logged;
  a missing-config error names only the missing variable names. This module
  never creates or edits any `.env*` file.
- **No manual cell copy in the preferred workflow**: see
  `scripts/modeling/strategies/README.md` "Phase 3D.2Ob" section for the
  one-command Windows workflow (`run-3d2o-from-supabase.cmd`). The
  clipboard-based Phase 3D.2Oa workflow remains available as a fallback only
  when Supabase env/config access is unavailable.
- **ROI remains `NOT_COMPUTED`**: this exporter changes only how the local
  export file is produced, not how it is used -- the same ROI discipline
  above applies unchanged.

## Local materialization workflow (Phase 3D.2Oa, fallback)

`scripts/modeling/strategies/materialize-generated-signal-pairs-export.ts`
turns raw text copied from Supabase into the local JSON file this spec's
CLI commands expect.

- **Accepted input formats**: a plain JSON array of row objects, or a
  Supabase SQL-editor "wrapper" result -- an object (or a single-element
  array containing one object) with a `generated_signal_pairs_export`
  field, whose value is either the row array already, or a JSON string that
  parses to the row array.
- **Output path**: `modeling/local_exports/generated_signal_pairs_export.json`
  by default (overridable with `--output`).
- **Report path**: `modeling/local_exports/3d2o_dedup_report.json`, produced
  by piping the existing `run-readonly-comparison.ts` CLI (with
  `--input-format generated_signal_pairs --include-dqa-r4 --dedup-policy
  strict_latest_created_before_resolved`) to that file.
- **No DB/env/live**: the materializer only reads local text (a file or
  stdin) and writes a local JSON file. It never imports a database client,
  never reads `process.env`, and never performs a network request.
- **Generated files are git-ignored**: everything under
  `modeling/local_exports/` except `.gitignore` itself is excluded from
  version control -- these are local operator working files, regenerated on
  demand, not repo artifacts.
- **Used for Phase 3D.2O and later local re-runs**: this materializer is
  the reusable on-ramp for every future local export/comparison cycle, not
  a one-off for this phase. See `scripts/modeling/strategies/README.md`
  "Phase 3D.2Oa" section for the exact Windows one-command workflow
  (`run-3d2o-from-clipboard.cmd`).
