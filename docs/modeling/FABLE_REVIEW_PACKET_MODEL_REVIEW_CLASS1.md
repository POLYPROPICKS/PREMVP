# Fable Review Packet — Model_Review_Class1

Prepared: 2026-07-09, branch `claude/dqa-r1-baseline-verify-itidmp`,
HEAD `3647d2a`.

## 1. Fable role

Fable is an **external critical reviewer**. Its job on this workstream is to
stress-test methodology, hunt for data leakage, judge ROI validity
preconditions, evaluate the DQA gating design, and check that every model /
strategy classification is honest (declared behavior matches implementing
source). Fable must **not implement code** — its output is analysis,
verdicts, risks, and a recommendation for the single next patch.

## 2. Context summary

PolyProPicks generates sports prediction-market signals whose resolved
outcomes accumulate in a `generated_signal_pairs` table. The founder wants a
trustworthy way to compare selection strategies (score thresholds, league
exclusions, one-per-event dedup, formula-version cohorts) before any ROI
claims or live promotion. Historically this comparison logic was scattered
across ad-hoc scripts with inconsistent formulas, dedup keys, and dataset
choices — which is exactly what this workstream fixes.

The work so far, in order:

**DQA baseline (Phases 3B).** Four pure, DB-independent dataset audits now
exist under `lib/modeling/datasetAudit/`: DQA-R1 (result label vs won-flag
consistency), DQA-R2 (realized return vs the canonical win/loss formula:
win = `((1 - entry_price) / entry_price) * 100`, loss = `-100`), DQA-R3
(created_at vs resolved_at window membership), and DQA-R4 (see below). Each
has an advisory read-only SQL contract under
`modeling/sql_registry/dataset_audits/`.

**Registries (Phase 3C).** `modeling/model_registry/` contains a dataset
registry (9 tables classified FULL / PARTIAL / DISPLAY_ONLY /
EXECUTION_ONLY; `generated_signal_pairs` is the sole canonical full
model-audit source) and a model strategy registry separating
CONTEXT_CONTOUR / FORMULA_MODEL / STRATEGY_POLICY / EXECUTION_POLICY /
DQA_AUDIT. Names that exist only in founder screenshots (e.g.
`SCORE_GE_50_ALL`) are recorded as missing/artifact-only rather than
invented.

**Line verification (Phase 3D.1).** Strategy filters were verified against
actual source lines, not names. This surfaced real conflicts: two strategies
(`ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH`, `ALT3_V1_AVOID_NBA_NHL`) have
TypeScript and Python implementations that disagree with each other **and
with their own names**; `ALT_SM_GUARD_ON_PRIMARY` turned out to be a log
label, not code. These are frozen as BLOCKED_SOURCE_CONFLICT pending a
founder decision.

**Declarations + evaluator (Phases 3D.2A-3D.2E).** Five JSON strategy
declarations exist under `scripts/modeling/strategies/declarations/`, each
carrying exact file:line evidence. A pure evaluator
(`lib/modeling/strategyEvaluator.ts`) applies declared filters to in-memory
rows; it refuses non-READY declarations and refuses one-per-event selection
unless the caller supplies an explicit comparator (no hidden ranking). The
one-per-event dedup key (`event_group_key`, a 7-field fallback chain) was
extracted into `lib/modeling/eventGroupSelection.ts` and wired into the
existing backtest path with regression tests proving zero behavior change.

**Founder override (Phase 3D.2G).** The founder mandated restoring
`trusted-initial-formula-v1.1` — a real production formula-version constant
(`lib/feed/types.ts:5`) whose strong 30D performance appeared in a July 8
report that is **not** in the repository (screenshot/chat evidence only).
The honest implementation is `FORMULA_TRUSTED_INITIAL_V1_1_ALL`: a
**formula-version cohort wrapper** that selects rows whose formula-version
field exactly equals the constant. It does not reimplement the formula's
algorithm. It carries `requiredForComparison: true` (every default
comparison run includes it) and explicit `promotionBlockedReasons` (no live
promotion without fresh 7D/14D windows, DQA-clean comparison, and founder
approval).

**Comparison runner + export contract + DQA-R4 (Phases 3D.2H-3D.2K).**
A local read-only CLI (`scripts/modeling/strategies/run-readonly-comparison.ts`)
takes a local JSON array of rows, runs the declared strategies, and prints
per-strategy selection counts — no DB, no env, no ROI. An export contract
(`lib/modeling/generatedSignalPairsExportContract.ts`) structurally
validates a local export (formula-version presence, score/coverage/event
fields, quirk risk). DQA-R4
(`lib/modeling/datasetAudit/outcomeResolutionConsistency.ts`) formally
audits the known **outcome quirk**: in
`lib/modeling/onePerMatchBacktest.ts`, a win-labelled row with neither a
valid entry price nor a valid realized return silently resolves to
`won: null` (unresolved) — an asymmetric bias, since loss rows resolve fine
without a price. DQA-R4 **detects** this (blocking when
`winWithoutPriceOrReturnCount > 0`); the quirk itself is deliberately
unfixed pending review. The CLI exposes it via `--include-dqa-r4`.

Current state: 120/120 tests pass, TypeScript clean, everything read-only.
ROI is intentionally **not computed anywhere** in the new stack yet; the
planned sequence (export spec → real validation run → ROI contract →
DQA-gated ROI CLI → comparator contract → all-ready run) is written up in
`docs/modeling/MODEL_REVIEW_CLASS1_EXECUTION_ROADMAP.md`, with your review
(Phase 3F) gating the first post-review patch.

## 3. Current commits and artifacts

| Commit | What it added |
|---|---|
| `82c29f6` | Mandatory trusted formula strategy (`FORMULA_TRUSTED_INITIAL_V1_1_ALL` declaration, `formulaVersionEquals` evaluator filter, registry entries) |
| `ad9d608` | Read-only strategy comparison runner (`strategyComparison.ts` + CLI) |
| `e00ccb1` | generated_signal_pairs export contract (`generatedSignalPairsExportContract.ts`, `--input-format`) |
| `f3475cb` | DQA-R4 outcome resolution audit (module + tests + advisory SQL) |
| `3647d2a` | Optional DQA-R4 CLI output (`--include-dqa-r4`) |

Earlier foundation commits on the same branch: `fe6f87e` (DQA-R1/R2/R3
baseline), `0ab8ed8`/`91afca8` (registries), `8bc9ebb` (declarations),
`3caab29`/`3ba9dab` (event-group helper + wiring), `5483e5c` (evaluator).

## 4. What Fable must review

1. **Is the formula-version cohort wrapper methodologically acceptable?**
   `FORMULA_TRUSTED_INITIAL_V1_1_ALL` selects by a version-string field
   rather than reimplementing the scoring algorithm. Is that an honest,
   useful unit of comparison, or does it smuggle in survivorship /
   composition bias (e.g. the cohort's composition depends on when that
   formula version was live)?
2. **Is DQA-R4 gating sufficient before ROI?** Blocking is currently
   triggered only by `winWithoutPriceOrReturnCount > 0`. Should other
   conditions block (e.g. high `rowsMissingResultLabelCount`, R2 recompute
   mismatches, R3 window divergence)?
3. **What leakage risks remain?** Candidates to examine: selection filters
   that peek at realized outcomes; the `outcome()` quirk asymmetrically
   dropping winners; comparing a frozen-CSV-era policy against a live-corpus
   cohort; formula-version cohorts spanning different market epochs.
4. **What data fields are mandatory before ROI?** Given the export
   contract's alias sets, which fields must be present and verified against
   the real schema before an ROI number is meaningful?
5. **What would make ROI invalid?** Enumerate concrete invalidators beyond
   the current DQA gates.
6. **Should the one-event comparator be required before the all-ready
   comparison?** Two READY strategies need a comparator; running
   `--all-ready` without one just marks them refused. Is that acceptable, or
   should Phase 3E.3 precede 3E.4 strictly?
7. **Are the observed screenshot models safe to include as watchlist only?**
   (`FORMULA::v2-lite-growth-safe`, `FORMULA::shadow-strategic-sports-v1`,
   `SCORE_*_ALL` names with no repo evidence.)
8. **What should be the next single patch?** One narrow, TDD-first patch.

## 5. What Fable must not do

- No live promotion of any strategy or formula.
- No DB writes, no requests for production credentials.
- No guaranteed-profit language, in either direction.
- No broad rewrite proposals — one minimal next patch only.
- No production claims ("this ROI is real") — everything remains
  local-research-grade until the roadmap's own gates pass.
- No fabricated ROI numbers; if a number is not derivable from the provided
  artifacts, say so.

## 6. Evidence to provide Fable

- `docs/modeling/MODEL_REVIEW_CLASS1_EXECUTION_ROADMAP.md`
- `scripts/modeling/strategies/README.md`
- `scripts/modeling/strategies/run-readonly-comparison.ts`
- `lib/modeling/strategyEvaluator.ts`
- `lib/modeling/strategyComparison.ts`
- `lib/modeling/generatedSignalPairsExportContract.ts`
- `lib/modeling/datasetAudit/outcomeResolutionConsistency.ts`
- `tests/modeling/runReadonlyComparisonCli.test.ts`
- `tests/modeling/outcomeResolutionConsistency.test.ts`
- `scripts/modeling/strategies/declarations/*.json` (all five) and
  `scripts/modeling/strategies/strategy_declarations.schema.json`
- `modeling/model_registry/model_strategy_registry.md` and `.json`

Optional deeper context: `lib/modeling/onePerMatchBacktest.ts` (the
`outcome()` quirk lives here), `lib/modeling/eventGroupSelection.ts`,
`lib/modeling/datasetAudit/*` (DQA-R1/R2/R3).

## 7. Required Fable output format

Fable must return, in this order:

1. `VERDICT:` one of `APPROVE` / `APPROVE_WITH_CONDITIONS` / `BLOCK`
2. **Top 10 risks**, ranked, each with severity and the file/decision it
   attaches to
3. **Must-fix before ROI** (checklist)
4. **Must-fix before live** (checklist; may be "not reviewable yet")
5. Explicit answer: is `FORMULA_TRUSTED_INITIAL_V1_1_ALL` acceptable as a
   required comparison wrapper — yes/no/conditions
6. Explicit answer: must DQA-R4 block ROI — yes/no, and whether the blocking
   condition set should expand
7. **Recommended next patch** — exactly one, narrow, with target files and
   the failing test to write first
8. **One-page executive summary** for the founder
9. No code unless explicitly asked in a follow-up.

## 8. Copy-paste Fable prompt

```
You are Fable, an external critical reviewer for the PolyProPicks
Model_Review_Class1 workstream. You review methodology, data leakage, ROI
validity preconditions, DQA gating, and honesty of model/strategy
classification. You do NOT write code, you do NOT promote anything to live,
you do NOT make production or profit claims, and you never fabricate
numbers.

Repository: PREMVP, branch claude/dqa-r1-baseline-verify-itidmp,
HEAD 3647d2a. Read first:
- docs/modeling/FABLE_REVIEW_PACKET_MODEL_REVIEW_CLASS1.md (this packet)
- docs/modeling/MODEL_REVIEW_CLASS1_EXECUTION_ROADMAP.md
Then inspect the evidence files listed in the packet's section 6.

Key facts you must verify rather than trust:
1. FORMULA_TRUSTED_INITIAL_V1_1_ALL is a formula-version cohort wrapper
   (filters.formulaVersionEquals === "trusted-initial-formula-v1.1"), not a
   reimplementation of the formula. Its 30D performance basis is a founder
   screenshot; no July 8 report exists in the repo.
2. DQA-R4 (lib/modeling/datasetAudit/outcomeResolutionConsistency.ts)
   detects but does not fix the outcome() quirk in
   lib/modeling/onePerMatchBacktest.ts, where win-labelled rows lacking both
   a valid entry price and a valid realized return silently become
   unresolved. Loss rows are unaffected — the bias is asymmetric.
3. The comparison CLI computes selection counts only. No ROI/PnL exists
   anywhere in the new stack yet, by design.
4. Two strategies are BLOCKED_SOURCE_CONFLICT because their implementations
   contradict their names; several founder-named strategies have no repo
   code at all and are watchlist/artifact-only.

Answer the eight review questions in the packet's section 4. Respect the
constraints in section 5. Return your findings in exactly the format of
section 7 (VERDICT first, then Top 10 risks, must-fix-before-ROI,
must-fix-before-live, the two explicit answers, one recommended next patch,
and a one-page executive summary). Do not include code.
```
