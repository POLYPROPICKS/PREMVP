# Canonical P50_52 football reconciliation — Review A2

The exact executable source is `scripts/modeling/football-verification-review-a.ts` at PR #396 head `8c8b714f164717e27dfe18a4440a361eca3309ca`. It reuses the selector and settlement functions without changing them. Its source query is `fetchRows()` in `scripts/modeling/tennis-safe-comparable-leaderboard.ts`: read `research_model_ready_rows.canonical_row` for every Minsk model date from 2026-08-04 through 2026-09-20, ordered by `population_id`, `condition_id`, `selected_token_id`, `decision_at`, with paging within each date. The bound `resolveDb()` accepts only the research-clone project.

The canonical reconciliation is this exact sequence from the tracked runner (names shortened only for the local intermediate variables):

```ts
const { candidates, settlementByCandidateIdentity } =
  toDecisionTimeSelectionInput(await fetchRows());
const reconciled = applyReconciledAuthority(
  candidates, loadReconciledClassificationMap(),
);
const tennisConditionIds = reconciled.eligible
  .filter((e) => e.sportFamily === "tennis")
  .map((e) => e.ref).filter(Boolean);
const identityLookup = await fetchTennisIdentityLookup(
  await resolveDb(), tennisConditionIds,
);
const { safeUniverse } = buildSafeUniverse(
  reconciled.eligible, identityLookup,
);
const p5052 = runStandaloneStrict(
  safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52,
);
const football = p5052.filter((e) => e.sportFamily === SOCCER_FAMILY);
const baseline = referenceEconomics(
  football, settlementByCandidateIdentity,
);
```

The all-sport SAFE selection happens **before** the football subset is taken. A football-first filter before `runStandaloneStrict` is a separate diagnostic path and can select different physical events. Settlement is joined only after selection by `candidateIdentity = conditionId + selectedTokenId + decisionAt`. `referenceEconomics` counts WIN/LOSS/VOID as terminal and OPEN as unresolved, with one unit staked at the recorded entry price. The required frozen result is `football.length=1015`, `baseline.TERMINAL_N=716`, `baseline.UNRESOLVED_N=299`, `baseline.REFERENCE_PNL_U=131.79`; `EXACT_SCORE_SELECTED_N=0` and the frozen football denominator is 4694.

The discarded architect aggregate (`N=1016`, terminal=671, unresolved=345) was a different, non-authoritative calculation with no preserved query or selected-identity list. It is closed as an authority dispute. The canonical runner had **more terminal** and **fewer unresolved** than that aggregate. The Polymarket backfill applies only to the runner's exact 299 OPEN identities.
