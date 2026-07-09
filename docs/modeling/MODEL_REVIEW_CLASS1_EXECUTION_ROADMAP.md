# Model_Review_Class1 — Execution Roadmap

Status date: 2026-07-09 (after Phase 3D.2K).
This is a docs-only roadmap. It does not authorize any live execution, DB
write, deployment, or ROI claim.

## 1. Current verified state

- Branch: `claude/dqa-r1-baseline-verify-itidmp`
- Latest commit: `3647d2a Modeling: add optional DQA-R4 CLI output`
- Test suite: `npm run test:modeling` — **120/120 passing** (node:test via tsx)
- TypeScript: `npx tsc --noEmit` — clean
- CLI available now:

```
node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input ./export.json --required-only \
  --input-format generated_signal_pairs --include-dqa-r4
```

- **Non-live status:** everything on this branch is read-only research
  tooling. Nothing here reads or writes the production database, nothing
  executes orders, nothing computes ROI/PnL, and no strategy is
  live-approved. The mandatory `FORMULA_TRUSTED_INITIAL_V1_1_ALL` wrapper is
  approved for *read-only comparison inclusion only*.

## 2. Assets built so far

| Asset | Path | What it is |
|---|---|---|
| DQA-R1 result field consistency | `lib/modeling/datasetAudit/resultFieldConsistency.ts` + `modeling/sql_registry/dataset_audits/02_*.sql` | Pure audit: outcome_status vs won flag |
| DQA-R2 return formula consistency | `lib/modeling/datasetAudit/returnFormulaConsistency.ts` + `03_*.sql` | Pure audit: realized return vs canonical win/loss formula |
| DQA-R3 date mode consistency | `lib/modeling/datasetAudit/dateModeConsistency.ts` + `04_*.sql` | Pure audit: created_at vs resolved_at window membership |
| DQA-R4 outcome resolution consistency | `lib/modeling/datasetAudit/outcomeResolutionConsistency.ts` + `05_*.sql` | Pure audit: win-labelled rows that would silently resolve as unresolved (the `outcome()` quirk). Detects only, does not fix. |
| Dataset registry | `modeling/model_registry/dataset_registry.md/.json` | 9 core tables classified FULL / PARTIAL / DISPLAY_ONLY / EXECUTION_ONLY |
| Model strategy registry | `modeling/model_registry/model_strategy_registry.md/.json` | Taxonomy: CONTEXT_CONTOUR / FORMULA_MODEL / STRATEGY_POLICY / EXECUTION_POLICY / DQA_AUDIT, with line-verification and blocked/missing statuses |
| Observed model candidates / watchlist | **NOT YET CREATED** | Recommended in the Phase 3D.2F inspect report (`modeling/model_registry/observed_model_candidates.json`) but no file exists yet; watchlist candidates are currently tracked only in that report and in section 3 below |
| Strategy declarations (5) | `scripts/modeling/strategies/declarations/*.json` + schema | Read-only contracts with source-line evidence; not runners |
| Strategy evaluator | `lib/modeling/strategyEvaluator.ts` | Pure filter/selection evaluator; refuses non-READY declarations; no hidden comparator |
| Strategy comparison | `lib/modeling/strategyComparison.ts` | Pure multi-strategy comparison; requiredForComparison default |
| Export contract | `lib/modeling/generatedSignalPairsExportContract.ts` | Structural validation of local generated_signal_pairs JSON exports |
| Read-only comparison CLI | `scripts/modeling/strategies/run-readonly-comparison.ts` | Local JSON in, selection counts out; no DB/env/ROI |
| Optional DQA-R4 CLI output | `--include-dqa-r4` flag | Adds `dqaR4` audit block to CLI output; audit-only |
| Event group dedup helper | `lib/modeling/eventGroupSelection.ts` | Canonical `event_group_key` fallback chain, wired into the backtest path |

## 3. Model / strategy classification table

### READY / REQUIRED

| Strategy | Notes |
|---|---|
| `FORMULA_TRUSTED_INITIAL_V1_1_ALL` | Source type: **formula-version cohort wrapper** (selects rows whose formula-version field equals `trusted-initial-formula-v1.1`; it does NOT reimplement the formula algorithm). `requiredForComparison: true` — included in every default comparison run. Filter: `formulaVersionEquals: "trusted-initial-formula-v1.1"`. **Not live-approved**: promotion blocked pending fresh 7D/14D windows, DQA-clean comparison, and founder approval. |

### READY / NOT REQUIRED

| Strategy | Selection unit | Line-verified filters |
|---|---|---|
| `BASELINE_V1_CONTROL` | all rows | none (no-op control, flat $10 in source report) |
| `PRIMARY_V1_AVOID_NBA_NHL_COV_CAP` | one per event (needs comparator) | score>=72, avoid NBA/NHL, coverage 50-74 & price 0.44-0.58 bucket exclusion, avoid 6-24h window; source marks it APPROX / NEEDS_EXACT_RECON |
| `ALT1_ONE_PER_EVENT_BEST_COVERAGE` | one per event (needs comparator) | score>=72, coverage as ranking key; TS/Python dedup-key mismatch documented |
| `SCORE_GE_72_FAMILY` | all rows | score>=72; variants (AVOID_6_24H, AVOID_3_12H_LEGACY, COVERAGE_GE_75) are documented but not auto-applied |

### BLOCKED / SOURCE CONFLICT (no declarations; founder decision required)

| Strategy | Conflict |
|---|---|
| `ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH` | TS "APPROX" fallback does not implement the smart-money exclusion its name claims; only the Python version does |
| `ALT3_V1_AVOID_NBA_NHL` | Python fallback does not filter NBA/NHL despite its name; only the TS counterfactual path does |
| `ALT_SM_GUARD` / `ALT_SM_GUARD_ON_PRIMARY` | Bare name not implemented anywhere; non-APPROX name is a console.log label, not code |

### MISSING SCRIPT (registry stubs; no code anywhere in the repo)

- `SCORE_GE_50`
- `SCORE_60_71`
- `BLUE_MODEL2_SAFE_CORE_V1`
- `ALT3_V1_AVOID_NBA_NHL_RAW_PROFIT`
- `ALT_AGGR_COVTIER_6_12`
- `ALT_SM75_GATE_FLAT`
- `ALT_COV75_FIRST_SM_IGNORED`
- `Ice1_M_Roadmap` (context label, not a strategy)

### OBSERVED / WATCHLIST (founder-highlighted; not READY strategies)

| Candidate | Status |
|---|---|
| `FORMULA::trusted-initial-formula-v1.1` | Real production formula-version constant (`lib/feed/types.ts:5`). The raw formula stays classified FORMULA_MODEL; only the cohort *wrapper* above is READY. |
| `FORMULA::v2-lite-growth-safe` | Real allowed-version constant (`lib/executor/modelingData.ts:6`); algorithm not line-verified; watchlist only |
| `FORMULA::shadow-strategic-sports-v1` | Real shadow-version constant (`lib/executor/modelingData.ts:7`); explicitly shadow; watchlist only |
| `SCORE_GE_72_ALL` | Name not found anywhere in the repo; possibly an alias of bare SCORE_GE_72 from an uncommitted July 8 report; artifact-only |
| `SCORE_GE_50_ALL` | Name not found anywhere in the repo; artifact-only |
| `SCORE_60_71_ALL` | Name not found anywhere in the repo; artifact-only |

The July-8-dated model report these watchlist names came from does **not**
exist in the repository (verified in Phase 3D.2F); its performance figures
are founder screenshot/chat evidence only.

## 4. Remaining roadmap

### Phase 3D.2L — real local generated_signal_pairs export spec

- Output: an exact export JSON shape document (field names, types, which of
  the alias sets in `generatedSignalPairsExportContract.ts` the real export
  will populate), verified against the actual table schema rather than
  assumed.
- No DB writes. The export itself is produced by the founder or an existing
  read-only path; this phase only specifies the shape.
- No ROI.
- Deliverable includes the commands to run the local CLI against the export
  once it exists (see section 7).

### Phase 3D.2M — first real local export validation run

- Run the CLI on the real export with `--input-format generated_signal_pairs
  --include-dqa-r4`.
- Output to report: `totalRows`, `rowsWithFormulaVersion`,
  per-strategy `selectedRows` (at minimum for
  `FORMULA_TRUSTED_INITIAL_V1_1_ALL`), and the full `dqaR4` block.
- ROI: **blocked / not yet valid** — this phase produces selection counts
  and DQA state only.

### Checkpoint A (after 3D.2L + 3D.2M)

Required report fields:
- export file identity (date range, row count, source query description)
- `inputValidation` summary
- `dqaR4` result, especially `winWithoutPriceOrReturnCount` and
  `hasBlockingViolations`
- `selectedRows` for the trusted formula wrapper
- Decision: **can we proceed to the ROI contract — yes/no.** "No" if DQA-R4
  blocks and the founder has not explicitly accepted the risk with a
  documented reason.

### Phase 3E.1 — ROI/PnL calculation contract only

- Define the ROI/PnL formula as a pure, unit-tested module (expected to
  mirror the already-line-verified canonical formula: win return pct =
  `((1 - entry_price) / entry_price) * 100`, loss = `-100`, flat stake).
- Unit tests on fixtures only.
- No production claim, no DB, not wired into the CLI yet.

### Phase 3E.2 — local ROI comparison CLI, gated by DQA

- Compute ROI only on local JSON input.
- **Hard gate:** if DQA-R4 (or R1-R3 where applicable) reports blocking
  violations for the input, the ROI output must be explicitly marked
  invalid/blocked — never silently computed over quirk-affected rows.
- No live execution.

### Checkpoint B (after 3E.1 + 3E.2)

Required report fields:
- selected / won / lost / unresolved counts per strategy
- ROI/PnL figures **only if** the DQA gate passed; otherwise the invalid
  reason (e.g. `BLOCKED_BY_DQA: winWithoutPriceOrReturnCount=N`)
- Explicit statement: no model promotion happens at this checkpoint.

### Phase 3E.3 — one-event comparator contract

- Define and test the ranking comparator required by
  `PRIMARY_V1_AVOID_NBA_NHL_COV_CAP` and `ALT1_ONE_PER_EVENT_BEST_COVERAGE`.
- Comparator must be explicit and line-traceable to source evidence — no
  hidden/default ranking (this preserves the existing evaluator rule).
- Unit tests for the comparator itself.

### Phase 3E.4 — all-ready comparison run

- Run both `--required-only` and `--all-ready` modes on the real export.
- Refused strategies must appear in output with an explanatory `error`
  (missing comparator, source conflict) — never silently dropped.

### Checkpoint C (after 3E.3 + 3E.4)

Required report fields:
- per-strategy selected counts across all ready strategies
- list of refused strategies with reasons
- ROI figures only for DQA-clean rows
- shortlist of top candidates to hand to Fable review.

### Phase 3F — Fable review

- Fable (external critical reviewer) checks methodology, leakage risks,
  source identity (does each strategy's declaration match its implementing
  code), DQA gating sufficiency, and ROI math.
- Fable does not write code. See
  `docs/modeling/FABLE_REVIEW_PACKET_MODEL_REVIEW_CLASS1.md`.

### Checkpoint D (after Fable)

- Fable verdict (APPROVE / APPROVE_WITH_CONDITIONS / BLOCK)
- The single approved next patch
- Any blocked assumptions that must be resolved before further work.

### Phase 3G — one minimal patch based on Fable

- Exactly one narrow patch, TDD-first, no broad refactor.

### Phase 3H — PR / merge candidate

- Only after: full test suite green, local proof runs recorded, and explicit
  founder approval. Until then this branch remains a research branch.

## 5. Intermediate reporting rule

Every two phases must produce a report containing:

- model set evaluated (strategy ids)
- input rows (count + export identity)
- selected rows per strategy
- DQA state (R1-R4, blocking yes/no)
- ROI state — exactly one of:
  - `NOT_COMPUTED` (no ROI code ran)
  - `BLOCKED_BY_DQA` (ROI code exists but the gate refused)
  - `VALID_LOCAL_ONLY` (ROI computed on local DQA-clean JSON; still not a
    production/live claim)
- next decision required from the founder.

## 6. ROI discipline

- **Current ROI is not valid yet from the new runner.** The comparison CLI
  intentionally computes selection counts only.
- The strong-30D ROI figures behind the trusted formula's mandatory status
  are **historical founder evidence (screenshot/chat)** — the July 8 report
  is not in the repository and its numbers have not been reproduced.
- Any future ROI figure must come from: local JSON input + all four DQA
  audits clean (or explicitly accepted) + the unit-tested Phase 3E.1
  formula. Nothing else counts as ROI in this workstream.
- No document, report, or output in this workstream may claim guaranteed
  profit. Historical selection/ROI numbers, even when valid, do not
  guarantee future results.

## 7. Exact commands currently available

Required comparison (trusted formula wrapper only, default):

```
node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input ./export.json --required-only
```

With generated_signal_pairs structural validation:

```
node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input ./export.json --required-only \
  --input-format generated_signal_pairs
```

With the DQA-R4 outcome-resolution audit included:

```
node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
  --input ./export.json --required-only \
  --input-format generated_signal_pairs --include-dqa-r4
```

Test suite and type check:

```
npm run test:modeling
npx tsc --noEmit
```

## 8. Stop conditions

Work on any subsequent phase stops immediately when:

- DQA-R4 reports `hasBlockingViolations: true` on the target dataset and the
  founder has not explicitly accepted the risk in writing;
- a strategy's implementing source conflicts with its declared name/filters
  (new BLOCKED_SOURCE_CONFLICT discovery);
- the export lacks a recognizable formula-version field for rows the trusted
  formula wrapper is supposed to cohort;
- the git working tree is unexpectedly dirty at precheck;
- `npm run build` fails for a reason caused by the patch (env-only
  `SUPABASE_URL`-style failures after a clean TypeScript pass are exempt);
- a task turns out to require live execution, environment variables, or
  database access — those require a separate founder-authorized task with
  its own gates.
