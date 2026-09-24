# Review A2 — Adjudication of the PR #396 football result discrepancy

PR #396 head SHA: `d4461a9d809dfb1eb04de967e0c33f1e8d2e06a2`.
Frozen football denominator: `football-denominator-reconciliation-v1`, combined canonical soccer denominator = **4694** physical events (unchanged, not re-derived here).
Scope: research authority validation only — `PNL_CLASS=REFERENCE_PNL`, `PNL_AUTHORITY=NOT_EXECUTION_AUTHORITY`, `PRICE_INDEPENDENT_ALPHA_PROVEN=NO`.

## 1. Corrected documentation defect

`FOOTBALL_VERIFICATION.md`'s prior wording ("runner shows materially fewer terminal, more unresolved") had the direction backwards. The actual numbers:

| | Runner (canonical, PR #396) | Independent DB cross-check | Runner − Independent |
|---|---|---|---|
| P50_52 N | 1015 | 1016 | −1 |
| P50_52 terminal | 716 | 671 | **+45** |
| P50_52 unresolved | 299 | 345 | **−46** |
| P50_54 N | 1223 | 1225 | −2 |
| P50_54 terminal | 881 | 824 | **+57** |
| P50_54 unresolved | 342 | 401 | **−59** |

The runner reports **more** terminal and **fewer** unresolved than the independent cross-check, in both models. This is now stated correctly in `FOOTBALL_VERIFICATION.md` and `FOOTBALL_VERIFICATION_DATA.json`.

## 2. Selected-N delta (−1 / −2 events)

Cause identified exactly for P50_52: filtering all football-reconciled, price-band-qualifying candidate rows directly and grouping by `physicalEventKey` yields **1016** unique events (one more than the runner's 1015). The runner's `SELECTED_N` is not "count of football-qualifying events" — it is "count of events whose GLOBALLY first chronologically-qualifying observation (any sport) was selected AND whose winning row happens to be football" (`runStandaloneStrict` over the full SAFE universe, football filtered post-selection via `sportSplit`/`footballOnly`). This is the existing, unchanged, frozen physical-event selection semantics (reused verbatim, not part of Review A's scope) — sport is a reporting label on the winning row, not a selection gate for P50_52_SAFE/P50_54_SAFE (only QUALITY_FILL_A's live-mix football-first allocation gates on sport). One event's globally-first qualifying row is therefore classified non-football even though a later row for that same event is football-qualifying, dropping it from the runner's football-only N. This is **contract-conformant, not a defect** — it is a side effect of applying the frozen selection rule before the football reporting filter, exactly as designed. The 1-2 event gap is not a material cause of the terminal/unresolved swap (46/59 events).

## 3. First semantic divergence: mixed settlement status within one physical event

`scripts/modeling/football-verification-review-a-adjudication-check.ts` (read-only, reuses `fetchRows`/`toDecisionTimeSelectionInput`/`applyReconciledAuthority`/`classifyStatusForFinality` verbatim) measured, over all football-reconciled price-band-qualifying candidate rows grouped by `physicalEventKey`:

| | P50_52 | P50_54 |
|---|---|---|
| Unique football-qualifying events | 1016 | 1225 |
| Events with ≥2 qualifying candidate rows | 706 | 804 |
| Events with **mixed** settlement status across their own rows (≥1 terminal row AND ≥1 OPEN row) | 432 | 502 |
| Events where the FIRST vs LAST chronological qualifying row differ in status | 305 | 354 |

**Finding:** a large share of football physical events in this window carry multiple qualifying candidate rows (different market/token combinations on the same event, e.g. distinct structured markets that settle at different times), and a majority of those (432/706 ≈ 61% for P50_52, 502/804 ≈ 62% for P50_54) have **mixed** terminal/unresolved status across their own rows. This means: **which single row is picked to represent the event materially determines whether that event is counted terminal or unresolved.** This is exactly the class of hazard Review A item C (causal decision order / prefix invariance) exists to fix — a selection rule that is not frozen at the first qualifying observation (e.g. one that lets a later, more-likely-settled row override an earlier OPEN one) will report systematically fewer unresolved events than the frozen, prefix-invariant rule.

The observed first-vs-last flip counts (305/354) are larger in magnitude than the runner-vs-independent terminal/unresolved delta (46/59), so "last observation" is not a literal description of the independent method — but the underlying mechanism (row-selection-order-dependent terminal/unresolved classification) is proven to exist at a magnitude large enough to fully explain a swap of 46-59 events by any selection rule that is not identical to the runner's frozen first-qualifying-observation rule.

## 4. PnL / ROI / MaxDD delta

Not decomposed into named per-event causes: doing so requires the independent method's selected-identity list (bucket 5 in the mission's reconciliation plan), which was never captured. Qualitatively, PnL/ROI/MaxDD differences follow directly from §3: a different terminal/unresolved split changes which rows contribute realised PnL (`WIN`/`LOSS` rows only) versus which are excluded from the terminal ROI denominator, and MaxDD is computed over the ordered terminal sequence, so a different terminal subset produces a different drawdown path. No PnL/ROI/MaxDD formula was changed; both figures use `settleBetU`/`aggregateMetrics` verbatim.

## 5. Why full identity-level (buckets 1-5) reconciliation is not possible

The mission's required reconciliation buckets (selected-by-both / runner-only / crosscheck-only / same-identity-different-finality / same-terminal-identity-different-PnL) require the independent cross-check's actual selected `candidateIdentity` set or SQL query. Only final aggregate numbers were supplied in the mission prompt — no query, no methodology, no row-level output exists anywhere in this repository or its evidence artifacts to diff against. This is a genuine "calculation cannot be reproduced from available frozen evidence" condition **for the independent side only**. It does not block adjudication of the runner's own conformance (§6), which is fully reproducible.

## 6. Contract-conformance check (runner)

- `docs/modeling/RESEARCH_CORPUS_CONTRACT.md` §5.3: WIN/LOSS/VOID terminal, OPEN/NO_MATCH/AMBIGUOUS not — `classifyStatusForFinality` implements this verbatim. VOID_N=0 confirmed live (no VOID rows exist in this window for any `_SAFE` model, football or otherwise — checked directly against `LEADERBOARD_2026-08-04_2026-09-20.json`), so VOID handling is not a candidate cause here.
- `SELECTION_BEFORE_SETTLEMENT_V1` (PR #379, frozen, reused verbatim): candidate qualification/ordering never reads settlement; `settlementByCandidateIdentity` is joined only after `runStandaloneStrict` returns.
- Prefix invariance (Review A item C, this PR): `runPortfolioStrict`/`runStandaloneStrict` freeze each event's decision at its first chronologically-qualifying observation; a dedicated regression test (`tests/modeling/tennisSafeComparableLeaderboard.test.ts`, "PREFIX INVARIANCE") proves appending later observations never changes an already-made decision. Re-run in this session: **PASS**.
- Reproducibility: the runner was re-run against the live research clone in this session; `EXACT_SCORE_SELECTED_N=0` and `OVERLAY_MISS_N=0` reconfirmed.

No frozen contract clause was found that the runner violates. No contract clause or artifact exists to check the independent cross-check against, because its method is not on record.

## Conclusion

**CONTRACT_CONFORMANT_PATH = runner (PR #396 canonical `football-verification-review-a.ts` output).** This is not a default-to-canonical choice: it is the only side that is (a) reproducible from evidence in this repository, and (b) checked line-by-line against the frozen `RESEARCH_CORPUS_CONTRACT` and `SELECTION_BEFORE_SETTLEMENT_V1`/prefix-invariance contracts. The independent DB cross-check cannot be verified as contract-conformant or non-conformant because its method was never captured as evidence.

**Narrowest repair (not applied by this mission — read-only):** the independent cross-check's SQL/methodology and selected-identity list should be captured and attached to evidence before any future comparison, so buckets 1-5 can be run exactly. No runner code change is proposed or needed.
