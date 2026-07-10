# Strategy Scripts — Rules and Read-Only Reuse Pattern (Phase 3C.2 / 3D.2A / 3D.2H / 3D.2I)

This directory contains a local, read-only strategy comparison CLI (Phase
3D.2H) plus docs defining the rules future strategy scripts must follow. It
does not contain a live strategy runner, a backtest, or anything that reads
the database or computes ROI/PnL.

## Read-only local comparison runner (Phase 3D.2H)

```
node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input ./path/to/export.json --required-only
```

- `--input <path>` (required): a local JSON file containing an array of row
  objects. There is no database read here -- the caller must already have
  exported/prepared this file.
- `--required-only` (default): runs only declarations with
  `requiredForComparison: true`. Today that means
  `FORMULA_TRUSTED_INITIAL_V1_1_ALL` runs by default.
- `--all-ready`: runs every loaded `READY_TO_NORMALIZE` declaration (one-event
  declarations without a caller-supplied comparator are still refused, not
  silently skipped -- they appear in the output with a non-null `error`).
- `--strategy <id[,id2]>`: runs only the named strategy id(s), overriding the
  required/all-ready selection.
- `--input-format <loose|generated_signal_pairs>` (default `loose`): see
  below.

Output is a single JSON object printed to stdout (per-strategy
`strategyId`/`status`/`requiredForComparison`/`inputRows`/`selectedRows`/
`rejectedByFilter`/`error`). Errors go to stderr only; the process exits
non-zero on invalid args or an unreadable/invalid `--input` file.

**This is explicitly NOT a backtest, NOT ROI/PnL, and NOT live execution.**
It computes selection counts only -- how many input rows each strategy's
filters would keep, given rows the caller already has in hand. It reads no
environment variable and imports no database client. See
`lib/modeling/strategyComparison.ts` for the underlying pure comparison
function.

## Local generated_signal_pairs export contract (Phase 3D.2I)

```
node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input ./export.json --required-only \
  --input-format generated_signal_pairs
```

Passing `--input-format generated_signal_pairs` runs the rows through
`validateGeneratedSignalPairsExportRows()`
(`lib/modeling/generatedSignalPairsExportContract.ts`) in addition to the
normal strategy comparison, and adds an `inputValidation` object to the
output with:

- `totalRows` / `rowsWithFormulaVersion` / `rowsMissingFormulaVersion` --
  whether formula-version filtering (e.g.
  `FORMULA_TRUSTED_INITIAL_V1_1_ALL`) can work on this export at all.
- `rowsWithScore` / `rowsWithCoverage` / `rowsWithEventGroupCandidate` --
  whether future score/coverage/one-event-grouping strategies would have the
  fields they need on this export.
- `outcomeQuirkRiskRows` -- rows whose result is a win label
  (win/won/hit/correct/yes) but that have neither a valid entry price nor a
  valid realized return. These are the rows that would silently lose their
  "won" resolution under `lib/modeling/onePerMatchBacktest.ts`'s current
  `outcome()` logic (the Phase 3D.2D-documented quirk). **This flag only
  detects the risk -- it does not fix the quirk, and it does not filter or
  alter any row.**
- `uniqueStrictDedupKeys` / `duplicateStrictKeyRows` /
  `rowsMissingStrictDedupKey` / `hasDuplicateStrictKeyRisk` (Phase 3D.2L) --
  duplicate detection on the strict dedup key (`condition_id` + `token_id`,
  the same identity pair `onePerMatchBacktest.ts`'s `strictKey()` uses).
  **This only detects duplicates -- the CLI still does not deduplicate any
  row.** See `docs/modeling/GENERATED_SIGNAL_PAIRS_EXPORT_SPEC.md` for the
  full export spec: duplicates block ROI/PnL work until resolved or
  explicitly accepted by the founder.
- `notes` -- plain-language summary of the above.

This is structural validation only: no rows are ever rejected, filtered, or
modified as a result of running with `--input-format generated_signal_pairs`
-- the strategy comparison itself runs identically either way.

## Strict dedup projection policy (Phase 3D.2N)

```
node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input ./export.json --required-only \
  --input-format generated_signal_pairs --include-dqa-r4 \
  --dedup-policy strict_latest_created_before_resolved
```

The first real local export was `BLOCKED_BY_DUPLICATES` (66 unique strict
keys out of 5000 raw rows). `--dedup-policy strict_latest_created_before_resolved`
runs `projectGeneratedSignalPairsStrictDedup()`
(`lib/modeling/generatedSignalPairsDedupPolicy.ts`) and adds a top-level
`dedupProjection` diagnostics object (no raw row payloads) to the output:

- `inputValidation` (when `--input-format generated_signal_pairs` is used)
  is always computed on the **raw** rows, regardless of `--dedup-policy`.
- `dedupProjection` reports the projection diagnostics: `rawRows`,
  `dedupRows`, `uniqueStrictDedupKeys`, `droppedDuplicateRows`,
  `rowsMissingStrictDedupKey`, `keysWithDuplicates`,
  `rowsCreatedAfterResolved`, `keysWithNoCreatedAtBeforeResolved`,
  `hasDuplicateStrictKeyRisk`.
- `strategies` (and `dqaR4`, if `--include-dqa-r4` is also passed) run on
  the **deduped** rows only when `--dedup-policy` is present. Without the
  flag, the default/loose behavior is unchanged -- strategies always run on
  raw rows.
- ROI is still not computed anywhere in this stack.

`--dedup-policy` requires `--input-format generated_signal_pairs` (the CLI
exits non-zero otherwise), same as `--include-dqa-r4`.

**Next phase:** Phase 3D.2O -- rerun the real local export with the dedup
projection applied and report the resulting dataset counts.

## Phase 3D.2Ob — One-command Supabase export runner (preferred)

Preferred founder workflow -- no clipboard, no cell-copy, no manual file
editing:

```
scripts\modeling\strategies\run-3d2o-from-supabase.cmd
```

This single command:

1. Captures `exportCutoffResolvedAt` (the current time) once, at export
   start.
2. Fetches **all** resolved rows (`resolved_at is not null` and
   `resolved_at <= exportCutoffResolvedAt`, ordered by `resolved_at`
   descending) by paginated `Range`-header GET requests (`select=*`) --
   there is no default dataset cap, and, as of Phase 3E.2b, no exact-count
   request either. Completeness is proven by exhaustive pagination: the
   exporter keeps fetching until a page comes back shorter than the
   requested page size, or empty.
3. Normalizes schema drift in code (e.g. `selected_token_id` /
   `diagnostics.selectedTokenId` -> `token_id`, `diagnostics.entryPrice` ->
   `entry_price_num`, `pre_event_score_num` -> `score`).
4. Writes `modeling\local_exports\generated_signal_pairs_export.json`.
5. **Fails fast** if the export step failed or the export file is missing
   -- it will not proceed to comparison on a broken/partial export (Phase
   3E.2a).
6. Runs the existing read-only dedup comparison CLI
   (`--input-format generated_signal_pairs --include-dqa-r4 --dedup-policy
   strict_latest_created_before_resolved`).
7. Writes and prints `modeling\local_exports\3d2o_dedup_report.json`. Any
   stale report from a previous run is deleted before this step, so a
   failed run never leaves behind a report that looks like a fresh success.

**Windows-safe transport (Phase 3E.2a):** the exporter reads via a plain
read-only GET request against Supabase's PostgREST REST endpoint (using the
platform `fetch`, with a `Range` header for pagination) instead of the
`@supabase/supabase-js` client's count/head-select path. The client's
count/head path was observed to crash on Windows with a native libuv
assertion failure (`Assertion failed: !(handle->flags &
UV_HANDLE_CLOSING)`) -- a runtime/platform issue, not a query logic bug.
The REST/`fetch` transport has no equivalent failure mode. No manual
fallback or Supabase cell copy is required because of this change -- the
one-command workflow is unaffected.

**No count dependency (Phase 3E.2b):** a real founder run showed that even
the REST exact-count request itself is fragile (an HTTP 500 was observed
from a real Supabase project on that request). The default exporter no
longer makes any row-count request at all. Instead of comparing
`fetchedRows` against a pre-fetched total, completeness is proven by
**pagination-until-exhaustion**: the exporter pages through
`resolved_at <= exportCutoffResolvedAt` until a page comes back shorter
than `pageSize` or empty, which is the only way the server can say "there
is nothing left."

**Keyset pagination, not OFFSET (Phase 3E.2d):** a real founder run also
failed deep into a paginated sweep (`Export failed (page 20): HTTP 500`) --
deep OFFSET/`Range`-based pagination is a known Postgres/PostgREST
performance and failure mode at scale, independent of the count-request
issue above. The exporter no longer uses OFFSET or a `Range` header at
all. It uses composite **keyset (seek) pagination** on `resolved_at DESC,
id DESC`: the first page has no cursor; every page after that carries a
cursor built from the *last row of the previous page* and filters to rows
strictly after it in that same order (`resolved_at < lastResolvedAt OR
(resolved_at = lastResolvedAt AND id < lastId)`). This never re-scans
skipped rows and has no "deep offset" degradation mode. `resolved_at`
alone is never used as the cursor, so rows sharing a `resolved_at` value
are still traversed correctly (via the `id DESC` tiebreak) instead of
being skipped or duplicated across a page boundary. If a full page's last
row is missing valid cursor fields, or the next cursor fails to advance,
the export fails safely (`KEYSET_CURSOR_FIELDS_MISSING` /
`CURSOR_DID_NOT_ADVANCE`) instead of looping or silently under-reporting.

**Dataset completeness contract (Phase 3D.2P, updated 3E.2b/3E.2d):**

- `--page-size` (default 1000) is a **transport batch size only** -- it
  controls how many rows are fetched per Supabase request, not how many
  rows are fetched in total. The preferred runner always uses it this way.
- `--max-rows` (and the deprecated alias `--limit`) is a **debug-only cap**.
  It must never be added to the default operator runner
  (`run-3d2o-from-supabase.cmd`), and any export produced with it is marked
  `exportMode: "DEBUG_CAPPED"` / `exportCompleteness:
  "INTENTIONALLY_CAPPED"` in the exporter summary -- it must not be used
  for a model-review or ROI gate.
- The exporter summary reports `fetchedRows`, `pageSize`, `pagesFetched`,
  `exportMode` (`"FULL_RESOLVED_BY_EXHAUSTION" | "DEBUG_CAPPED"`),
  `exportCompleteness` (`"COMPLETE_BY_EXHAUSTION" | "INTENTIONALLY_CAPPED"`),
  `completionProof` (`"LAST_PAGE_SHORT" | "EMPTY_PAGE" | null` -- `null`
  only in `DEBUG_CAPPED` mode, where completeness is not claimed),
  `exportCutoffResolvedAt` (the ISO timestamp captured at export start),
  `paginationMode` (always `"KEYSET_RESOLVED_AT_ID"`), and `missingRows`
  (always `0` -- there is no longer a pre-fetched total to compute a gap
  against; `completionProof` is the completeness signal instead).
  **`exportCompleteness` must be `"COMPLETE_BY_EXHAUSTION"` before any
  ROI/model-review gate treats the export as the full dataset.**

**Explicit SELECT and canonical filter encoding (Phase 3E.2e, physical
schema in 3E.2f):** the exporter no longer sends `select=*`. **Physical
Supabase source schema != normalized export compatibility schema** -- the
live REST `select=` uses `GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS` (the
exact 27 columns verified against `information_schema.columns` on the real
table), which is a separate, narrower list from
`NORMALIZER_COMPAT_FIELDS` (every field name `normalizeGeneratedSignalPairRow()`
understands, including legacy/offline-fixture aliases like `token_id`,
`signal_score`, `coverage`, `result`, `outcome_status`, `entry_price` that
do **not** exist as physical columns today). A real founder REST probe
failed with `HTTP 400 postgrestCode=42703: column
generated_signal_pairs.token_id does not exist` because an earlier version
of this exporter selected the broader compat list directly -- an alias
must never be added to the live REST select unless it physically exists;
it stays normalization-only otherwise. The cutoff filter is now one canonical
`and=(resolved_at.not.is.null,resolved_at.lte.<cutoff>)` parameter instead
of two duplicate `resolved_at` query keys, built safely with
`URLSearchParams`. On a failed request, the exporter reports a bounded
(≤800 characters), redacted diagnostic -- HTTP status plus, if the
response body is valid PostgREST-shaped JSON, its `code`/`message`/
`details`/`hint` fields -- with any JWT/bearer/apikey/URL-looking substring
redacted and no raw response body or credential ever surfaced.

**Truthful Windows fail-fast (Phase 3E.2e):** a real founder run showed
`%ERRORLEVEL%` is not reliable after the exporter exits -- a native libuv
teardown assertion has been observed to interfere with Windows exit-code
propagation, even when the exporter itself correctly detected and reported
its failure. Both runners now delete all stale artifacts (export file,
summary file, and a success sentinel) before invoking the exporter, pass
`--sentinel-output` so the exporter writes the sentinel only after the
export (and summary, if requested) finish writing successfully, and
require every expected artifact to exist before proceeding -- they no
longer claim "exporter reported success" based on a clean errorlevel
alone.

- **No clipboard/cell-copy required.** The founder does not touch Supabase's
  SQL Editor UI or the clipboard at all for this workflow.
- **Generated files are git-ignored** (`modeling/local_exports/.gitignore`)
  -- local operator working files, never committed.
- **Requires local Supabase read env/config**: `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` (the same convention `lib/supabase/server.ts`
  uses), available to the process (e.g. via `.env.local`, already the repo
  convention -- this script does not create or edit any env file).
- **Does not write to the database.** Read-only `select` only -- no insert,
  update, delete, upsert, or rpc calls.
- **Does not compute ROI.** Same read-only `run-readonly-comparison.ts` used
  throughout this workstream -- selection counts, dedup diagnostics, and
  DQA-R4 audit output only.
- Produces the same Phase 3D.2O report shape as the clipboard workflow
  below.

If Supabase env/config access is unavailable in the founder's shell, fall
back to the clipboard workflow (Phase 3D.2Oa) below. **This clipboard
fallback should not be used in the normal operator path** -- it exists only
for the rare case where env/config access genuinely is not available.

## Phase 3D.2Oa — Operator local export materializer (fallback only)

**Fallback only if env/config access is unavailable** -- prefer Phase
3D.2Ob (`run-3d2o-from-supabase.cmd`) above when Supabase read env/config is
available. Do not use this clipboard/cell-copy path as the default
workflow.

Founder workflow (no repo edits, no `git pull` timing issues, no manually
recreating `tmp_generated_signal_pairs_export.json`):

1. Run the schema-safe Supabase query that produces the
   `generated_signal_pairs_export` result.
2. Copy either just the `generated_signal_pairs_export` cell, or the whole
   Supabase JSON wrapper result, to the clipboard.
3. Run:
   ```
   scripts\modeling\strategies\run-3d2o-from-clipboard.cmd
   ```
4. The report appears at:
   ```
   modeling\local_exports\3d2o_dedup_report.json
   ```
   and is also printed to the console at the end of the run.

This creates three local files under `modeling/local_exports/`:
`supabase_clipboard_raw.txt` (raw clipboard capture),
`generated_signal_pairs_export.json` (normalized row array), and
`3d2o_dedup_report.json` (the read-only comparison + dedup + DQA-R4 report).

- **These files are intentionally git-ignored** (`modeling/local_exports/.gitignore`)
  -- they are local operator working files, not repo artifacts, and must
  never be committed.
- **This does not query Supabase.** The `.cmd` only reads the clipboard
  (already-copied text) and local files; it never opens a database
  connection.
- **This does not compute ROI.** The final step is the same read-only
  `run-readonly-comparison.ts` used throughout this workstream --
  selection counts, dedup diagnostics, and DQA-R4 audit output only.
- This only prepares Phase 3D.2O dataset counts (the first real local
  export run) for inspection -- it is not itself Phase 3D.2O.

Manual equivalent (Node CLI, useful for non-Windows or scripted runs):

```
node --import tsx scripts/modeling/strategies/materialize-generated-signal-pairs-export.ts \
  --input <path-to-raw-clipboard-or-file> \
  --output modeling/local_exports/generated_signal_pairs_export.json

node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input modeling/local_exports/generated_signal_pairs_export.json \
  --required-only --input-format generated_signal_pairs --include-dqa-r4 \
  --dedup-policy strict_latest_created_before_resolved \
  > modeling/local_exports/3d2o_dedup_report.json
```

The materializer accepts either a plain JSON array of rows, or a Supabase
SQL-editor "wrapper" result (an object, or single-element array of an
object, with a `generated_signal_pairs_export` field holding the row array
as a JSON string or an already-parsed array).

## DQA-R4: outcome resolution consistency audit (Phase 3D.2J)

`lib/modeling/datasetAudit/outcomeResolutionConsistency.ts`
(`auditOutcomeResolutionConsistency`) is the formal DQA audit for the same
outcome-resolution quirk that the export contract above only flags
informally via `outcomeQuirkRiskRows`. It counts win/loss-labelled rows,
which win rows have a valid entry price or realized return, and which
win-labelled rows have neither (`winWithoutPriceOrReturnCount`) --
`hasBlockingViolations` is true whenever that count is greater than zero.

**DQA-R4 detects this outcome quirk risk. It does not fix outcome behavior**
-- `lib/modeling/onePerMatchBacktest.ts`'s `outcome()` function is untouched
by this audit and by this whole phase. Advisory SQL contract:
`modeling/sql_registry/dataset_audits/05_outcome_resolution_consistency.sql`.

**ROI/PnL comparison work is blocked** until DQA-R1 (`resultFieldConsistency`),
DQA-R2 (`returnFormulaConsistency`), DQA-R3 (`dateModeConsistency`), and
DQA-R4 (`outcomeResolutionConsistency`) all report no blocking violations on
the real dataset in question, or a blocking violation is explicitly accepted
by the founder with a documented reason. The local comparison CLI's
`--input-format generated_signal_pairs` flag surfaces the same
outcome-quirk risk at the individual-export level for a quick local sanity
check; DQA-R4 is the formal, registry-tracked audit that governs promotion
decisions.

### Optional DQA-R4 output in the local CLI (Phase 3D.2K)

```
node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input ./export.json --required-only \
  --input-format generated_signal_pairs --include-dqa-r4
```

Passing `--include-dqa-r4` (requires `--input-format generated_signal_pairs`
-- the CLI exits non-zero otherwise) runs
`auditOutcomeResolutionConsistency()` over the same input rows and adds a
top-level `dqaR4` object to the output, alongside the existing
`inputValidation` and `strategies` sections. `dqaR4` is audit-only: it does
not change which rows any strategy selects, and it does not touch
`lib/modeling/onePerMatchBacktest.ts`'s outcome-resolution logic. When
`dqaR4.hasBlockingViolations` is `true`, that means win-labelled rows exist
in this export that would silently resolve as unresolved under the current
`outcome()` logic -- ROI/PnL comparison should not proceed on this dataset
until that risk is fixed or explicitly accepted by the founder.

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

### Mandatory comparison declarations (Phase 3D.2G)

- `scripts/modeling/strategies/declarations/trusted_initial_formula_v1_1_all.json`
  — `FORMULA_TRUSTED_INITIAL_V1_1_ALL`, a founder-mandated declaration with
  `requiredForComparison: true`.

This is a **formula-version cohort wrapper**, not a live strategy and not a
reimplementation of the internal formula algorithm: it selects all rows whose
formula-version field equals `trusted-initial-formula-v1.1` (via
`filters.formulaVersionEquals`, matched exactly against `formula_version` /
`metric_formula_version` / `formulaVersion` / `diagnostics.formulaVersion` /
`diagnostics.formula_version`). A future read-only comparison runner **must
include `requiredForComparison` strategies by default**. It is **not
live-approved** — see its `promotionBlockedReasons`.

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

## Phase 3E.1 — ROI contract status

- A **pure ROI/PnL module exists**: `lib/modeling/roiPnlContract.ts`
  (`classifyResolvedOutcome`, `computeRowReturnPct`,
  `computeFlatStakeRoiSummary`), tested in
  `tests/modeling/roiPnlContract.test.ts` against synthetic rows only.
- **CLI integration lands in Phase 3E.2 (below).** The contract itself is
  math only and does not gate anything.
- **Do not run or claim performance manually from the exported JSON.** The
  only sanctioned path from a local export to an ROI figure is the gated
  `--include-roi` CLI (Phase 3E.2) -- any ROI/PnL number produced by
  hand-running this module against
  `modeling/local_exports/generated_signal_pairs_export.json` is not a
  validated or reportable result.

## Phase 3E.2 — one-command gated ROI report

Preferred one-command gated ROI audit (no clipboard, no manual file
editing):

```
scripts\modeling\strategies\run-3e2-roi-from-supabase.cmd
```

This command:

1. Runs the full read-only Supabase export (all resolved rows, paginated,
   no cap, via the Windows-safe REST transport) **and** writes an export
   summary sidecar.
2. **Fails fast** if the export step failed, or if the export file or
   summary sidecar is missing -- it will not run the ROI comparison on a
   broken/partial export (Phase 3E.2a).
3. Runs `run-readonly-comparison.ts` with `--include-roi` behind the full
   gate set (`--input-format generated_signal_pairs --include-dqa-r4
   --dedup-policy strict_latest_created_before_resolved --export-summary`).
4. Writes and prints the gated ROI report. Any stale report from a
   previous run is deleted before this step (and again if the comparison
   step itself fails), so a failed run never leaves behind a report that
   looks like a fresh success.

Generated (git-ignored) outputs under `modeling/local_exports/`:

- `generated_signal_pairs_export.json` — the full resolved export.
- `generated_signal_pairs_export_summary.json` — completeness summary
  sidecar (counts only, no rows).
- `3e2_roi_report.json` — the gated ROI audit report.

Notes:

- The old `run-3d2o-from-supabase.cmd` remains the **dataset / DQA / dedup**
  report (no ROI). `run-3e2-roi-from-supabase.cmd` is the **gated ROI
  audit** report. Both are read-only, both fail fast, and both use the
  Windows-safe REST export transport.
- ROI is computed only when `roiGate.status === "READY"`. The gate accepts
  **either** completeness shape the exporter can produce (Phase 3E.2b
  compat):
  - **legacy exact-count complete**: `exportCompleteness === "COMPLETE"`
    with `missingRows === 0`; or
  - **exhaustion complete** (current exporter default):
    `exportCompleteness === "COMPLETE_BY_EXHAUSTION"`, `exportMode ===
    "FULL_RESOLVED_BY_EXHAUSTION"`, a valid `completionProof`
    (`"LAST_PAGE_SHORT"` or `"EMPTY_PAGE"`), and a non-empty
    `exportCutoffResolvedAt`, with `missingRows === 0`.

  Either way, the export summary's `fetchedRows` must match the analyzed
  rows, the strict dedup projection must have no rows missing a strict key,
  DQA-R4 must be non-blocking, and at least one strategy must have selected
  rows. A `DEBUG_CAPPED` / `INTENTIONALLY_CAPPED` export summary is always
  blocked (`EXPORT_INTENTIONALLY_CAPPED`) -- a debug-capped export never
  satisfies the ROI gate. Otherwise `roiGate.status === "BLOCKED"` with
  machine-readable `reasons` (e.g. `EXPORT_NOT_COMPLETE`,
  `EXPORT_COMPLETENESS_PROOF_MISSING`, `EXPORT_CUTOFF_MISSING`,
  `EXPORT_FETCHED_ROWS_MISMATCH`, `EXPORT_INTENTIONALLY_CAPPED`), and **no
  per-strategy ROI is emitted**.
- ROI is computed on the **selected deduped rows only**, never on raw
  duplicates; selected row objects are never emitted in the output.
- **No DB writes. No deploy. No product/profit claims.** ROI here is a local
  model-audit metric only.
- **No manual fallback or Supabase cell copy required.** Both runners are
  fully automated; the clipboard workflow (Phase 3D.2Oa) remains available
  only as a last-resort fallback, not part of the normal operator path.
