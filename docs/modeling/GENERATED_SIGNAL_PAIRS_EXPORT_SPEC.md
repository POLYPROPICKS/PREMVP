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

## Phase 3E.1 — ROI/PnL pure contract

`lib/modeling/roiPnlContract.ts` defines the pure ROI/PnL math contract
(`classifyResolvedOutcome`, `computeRowReturnPct`,
`computeFlatStakeRoiSummary`) for local modeling rows, with a dedicated
test suite (`tests/modeling/roiPnlContract.test.ts`).

- **ROI is not computed from the real dataset in Phase 3E.1.** This phase
  ships and tests the math only, against synthetic rows. No local export
  file (real or otherwise) is read by this module or its tests.
- **The contract is pure and tested**: no fs/env/DB/network access, no
  non-deterministic input, no mutation of input rows, no import of the
  legacy mixed backtest module's outcome-normalization helpers (which
  contain a documented quirk this contract must not inherit).
- **This module does not gate itself.** It defines return/PnL/ROI math
  only -- it does not decide whether a dataset is complete, deduplicated,
  or otherwise fit for a real ROI claim.
- **A real ROI run (Phase 3E.2+) requires all of the following on the input
  rows before any ROI/PnL figure from this contract is trusted**:
  - `exportCompleteness === "COMPLETE"` (see the automated Supabase export
    workflow above -- no `INCOMPLETE` or `INTENTIONALLY_CAPPED` export).
  - the strict dedup projection (`strict_latest_created_before_resolved`)
    applied.
  - `rowsMissingStrictDedupKey === 0` on the projected rows, or the gap
    explicitly explained.
  - DQA-R1/R2/R3/R4 all report no blocking violations
    (`hasBlockingViolations === false`).
  - the target strategy's `selectedRows > 0`.
- **No ROI/profit claim may be made from a partial sample.** A
  `computeFlatStakeRoiSummary()` result computed outside the gates above is
  local research output only, not a validated performance figure.

## Phase 3E.2 — gated local ROI comparison

Phase 3E.2 wires the pure ROI/PnL contract (Phase 3E.1) into the read-only
comparison CLI (`run-readonly-comparison.ts`) behind explicit gates.

- **ROI can be computed only by the CLI with `--include-roi`.** There is no
  other sanctioned path from a local export to an ROI figure.
- **`--include-roi` requires all of**: `--input-format
  generated_signal_pairs`, `--dedup-policy
  strict_latest_created_before_resolved`, `--include-dqa-r4`, and
  `--export-summary <path>` (the sidecar written by the exporter's
  `--summary-output`). Missing any of these exits non-zero before any ROI is
  computed.
- **The CLI reads the export summary from a local file only** -- it never
  queries the database, reads `process.env`, or performs a network request.
- **Gate conditions** (all must hold for `roiGate.status === "READY"`):
  - `exportSummary.exportCompleteness === "COMPLETE"`
  - `exportSummary.missingRows === 0`
  - `exportSummary.fetchedRows === inputValidation.totalRows` (the export
    that produced the summary is the export being analyzed)
  - the strict dedup projection exists and
    `dedupProjection.rowsMissingStrictDedupKey === 0`
  - DQA-R4 ran and `dqaR4.hasBlockingViolations === false`
  - at least one strategy has `selectedRows > 0`
- **If any gate fails**, the output carries top-level `roiGate.status =
  "BLOCKED"` with a machine-readable `reasons` array, and **no per-strategy
  ROI is computed** -- there is no fake zero-ROI fallback.
- **If the gate passes**, ROI is computed per selected strategy via
  `computeFlatStakeRoiSummary(selectedRows, { strict: true, stakeUnits: 1 })`
  on the **selected deduped rows only** -- never on raw duplicate rows. The
  selected row objects are never emitted in the CLI output.
- **ROI here is a local model-audit metric, not a product claim.** No
  ROI/profit claim may be made from a partial or incomplete export, and the
  gate is what enforces that at the tooling level.

## Phase 3E.2a — Windows-safe export transport and fail-fast runners

A real founder run of `run-3e2-roi-from-supabase.cmd` failed during the
count step with a native Windows libuv crash
(`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
src\win\async.c, line 76`) from the `@supabase/supabase-js` client's
count/head-select path, and the runner incorrectly proceeded into the ROI
comparison step afterward (which then failed separately on a missing
export summary file). This is not a valid ROI result, and it exposed two
gaps this phase closes:

- **Exporter transport**: `export-generated-signal-pairs-from-supabase.ts`
  no longer depends on the `@supabase/supabase-js` client for its default
  count/data path. It uses a read-only GET request against Supabase's
  PostgREST REST endpoint directly (the platform `fetch`, with `Prefer:
  count=exact` / `Range-Unit: items` / `Range: 0-0` for the count, and
  `Range: <from>-<to>` for each page), parsing the total row count from the
  `Content-Range` response header. This removes the Windows-specific
  crash surface entirely -- a plain GET request has no equivalent failure
  mode. The env convention (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`),
  CLI flags, normalization, and completeness-summary contract are all
  unchanged.
- **Runner fail-fast**: both `run-3d2o-from-supabase.cmd` and
  `run-3e2-roi-from-supabase.cmd` now check the exporter's exit code
  **and** verify the export file (and, for the ROI runner, the export
  summary sidecar) actually exist before running any comparison step. Any
  stale report file from a previous run is deleted before a new comparison
  runs (and again if the comparison itself fails), so a failed run can
  never leave behind a report that reads like a fresh success.
- **No manual fallback required by this change.** The one-command operator
  workflow (`run-3e2-roi-from-supabase.cmd` / `run-3d2o-from-supabase.cmd`)
  is unaffected -- founders still run a single command with no clipboard,
  no cell copy, and no manual file editing.

## Phase 3E.2b — pagination-until-exhaustion, no count dependency

A real founder run showed that even the REST exact-count request itself
(`Prefer: count=exact`) is fragile -- it returned an HTTP 500 from a real
Supabase project, a second Windows/Supabase-side failure mode after the
`@supabase/supabase-js` client's count/head path (Phase 3E.2a). The default
exporter now makes **no row-count request of any kind**.

- **Cutoff, not count**: at export start, the exporter captures
  `exportCutoffResolvedAt = new Date().toISOString()` once. Every page
  request filters to `resolved_at IS NOT NULL AND resolved_at <=
  exportCutoffResolvedAt`, ordered by `resolved_at` descending. This keeps
  the row set stable across the whole paginated fetch -- a row resolving
  after the export started can never appear mid-stream and shift
  pagination out from under the run.
- **Exhaustion is the completeness proof**: pages are fetched by `Range:
  0-999`, `1000-1999`, etc. (`pageSize`, default 1000) until a page comes
  back shorter than `pageSize` (`completionProof: "LAST_PAGE_SHORT"`) or an
  empty page (`completionProof: "EMPTY_PAGE"`, needed when the total row
  count happens to be an exact multiple of `pageSize`). There is no
  pre-fetched total to compare `fetchedRows` against -- the short/empty
  final page **is** the proof.
- **Updated summary contract**: `exportMode` is now
  `"FULL_RESOLVED_BY_EXHAUSTION"` by default (`"DEBUG_CAPPED"` with
  `--max-rows`); `exportCompleteness` is `"COMPLETE_BY_EXHAUSTION"` by
  default (`"INTENTIONALLY_CAPPED"` with `--max-rows`); `missingRows` is
  always `0` (there is no gap to compute without a count); `completionProof`
  is `null` only in `DEBUG_CAPPED` mode, where the exporter never claims
  exhaustion.
- **`--max-rows` remains debug-only**: it still stops the fetch at an
  explicit row cap rather than by exhaustion, and is still never used by
  the default operator runners.
- **Compatibility note (resolved in Phase 3E.2b-compat, see below)**: this
  changed the exact `exportCompleteness` / `exportMode` string values from
  Phase 3D.2P/3E.2a (`"COMPLETE"`/`"FULL_RESOLVED"`) to the exhaustion-based
  values above. The ROI gate in `run-readonly-comparison.ts` initially still
  checked only the literal old string and would have blocked every
  exhaustion-complete export; that gap is closed below.

## Phase 3E.2b-compat — ROI gate accepts exhaustion-complete exports

`run-readonly-comparison.ts`'s `--include-roi` gate now recognizes both
completeness shapes the exporter can produce, via a pure helper
(`evaluateExportCompletenessForRoi`):

- **Legacy exact-count complete** (Phase 3D.2P/3E.2a):
  `exportCompleteness === "COMPLETE"` with `missingRows === 0`.
- **Exhaustion complete** (Phase 3E.2b, current exporter default):
  `exportCompleteness === "COMPLETE_BY_EXHAUSTION"`, `exportMode ===
  "FULL_RESOLVED_BY_EXHAUSTION"`, a valid `completionProof`
  (`"LAST_PAGE_SHORT"` or `"EMPTY_PAGE"` -- any other value, including
  missing/null, is rejected), and a non-empty `exportCutoffResolvedAt`
  string, with `missingRows === 0`.

Either shape still requires the export summary's `fetchedRows` to match
`inputValidation.totalRows` on the analyzed rows. A `DEBUG_CAPPED` /
`INTENTIONALLY_CAPPED` export summary is unconditionally blocked
(`EXPORT_INTENTIONALLY_CAPPED`) regardless of which shape it otherwise
resembles -- a debug-capped export can never satisfy the ROI gate. Blocked
reasons are machine-readable strings (`EXPORT_NOT_COMPLETE`,
`EXPORT_COMPLETENESS_PROOF_MISSING`, `EXPORT_CUTOFF_MISSING`,
`EXPORT_FETCHED_ROWS_MISMATCH`, `EXPORT_INTENTIONALLY_CAPPED`, plus the
existing dedup/DQA-R4/selection reasons); when blocked, no per-strategy ROI
is computed and no raw rows are ever emitted.

This is still a **local model-audit metric, not a product claim** -- the
gate only decides whether the input dataset is trustworthy enough for a
local ROI figure to be computed at all, not whether that figure should be
presented as validated performance.

## Phase 3E.2d — keyset pagination (resolved_at DESC, id DESC)

A real founder run failed mid-export with `Export failed (page 20): HTTP
500` -- earlier pages succeeded, so deep OFFSET/`Range`-based pagination
(the transport used through Phase 3E.2b) is considered unsafe for a
full-corpus export. This is a distinct failure mode from the count-request
fragility fixed in Phase 3E.2b: it is Postgres/PostgREST degrading (or
outright failing) on a deep-OFFSET scan, independent of whether a count
was requested.

- **Fixed cutoff, stable order**: exactly as before, one
  `exportCutoffResolvedAt` is captured at export start and used for every
  page (`resolved_at IS NOT NULL AND resolved_at <=
  exportCutoffResolvedAt`). The order is now `resolved_at.desc,id.desc`
  (previously `resolved_at.desc` alone).
- **No OFFSET, ever**: the first page has no cursor. Every page after that
  carries a composite cursor -- the `(resolved_at, id)` pair of the last
  row of the *previous* page -- and filters to rows strictly after that
  point in the same order:
  `resolved_at < lastResolvedAt OR (resolved_at = lastResolvedAt AND id <
  lastId)`, encoded as a PostgREST `or=(...)` filter via `URLSearchParams`.
  This never re-scans or skips over previously-seen rows, and has no
  "the deeper the page, the slower/more failure-prone the query" mode --
  each page is an independent, bounded seek from a known point, not a scan
  from the start of the result set.
- **Page-boundary integrity**: `resolved_at` is never used alone as the
  cursor. Rows sharing an identical `resolved_at` are only disambiguated by
  the `id DESC` tiebreak, so a same-timestamp group can never be partially
  skipped (rows silently missing from the export) or duplicated
  (`realized_return_pct`/selection double-counted) across a page boundary.
- **Cursor field safety**: after fetching a full page that the exporter is
  about to use as the source of the next cursor, the last row must have a
  finite/non-empty `resolved_at` and a non-empty `id`. If not, the export
  fails with `KEYSET_CURSOR_FIELDS_MISSING` and does **not** report
  completeness -- a row with a null/missing `resolved_at` or `id` is a
  reason to stop and investigate, not to guess.
- **Cursor progress safety**: if the cursor computed from a new page is
  identical to the cursor that produced it, the export fails with
  `CURSOR_DID_NOT_ADVANCE` instead of looping -- this is the one condition
  that could otherwise cause an infinite re-fetch of the same rows.
- **Safe error diagnostics**: a failed page request's error message
  includes only the page number, the HTTP status, `paginationMode:
  KEYSET_RESOLVED_AT_ID`, and whether the request was the first page or a
  cursor page. It never includes the `apikey`/`Authorization` header
  values, the raw response body, the full raw cursor values, or row
  payloads.
- **Updated summary contract**: the exporter summary now always includes
  `paginationMode: "KEYSET_RESOLVED_AT_ID"` alongside the existing Phase
  3E.2b fields (`fetchedRows`, `pageSize`, `pagesFetched`, `exportMode`,
  `exportCompleteness`, `completionProof`, `exportCutoffResolvedAt`,
  `missingRows`). `--max-rows` (debug-only) is unaffected in meaning --
  it still reports `exportMode: "DEBUG_CAPPED"` /
  `exportCompleteness: "INTENTIONALLY_CAPPED"` and never claims
  `COMPLETE_BY_EXHAUSTION`.
- **Runner interface unchanged**: this is a transport-only change.
  `run-3e2-roi-from-supabase.cmd` and `run-3d2o-from-supabase.cmd` invoke
  the exporter with the exact same CLI flags as before (`--output`,
  `--summary-output`, `--page-size`) -- founders use the same one-command
  workflow.
