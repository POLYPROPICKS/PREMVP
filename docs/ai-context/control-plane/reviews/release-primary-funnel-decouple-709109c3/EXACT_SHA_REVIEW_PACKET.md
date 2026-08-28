# EXACT-SHA REVIEW PACKET — Primary funnel decouple bundle

- **reviewed_sha**: `709109c3ebca81d14dc08efd08336c63ed203870`
- **expected_parent**: `2b24dff95259c447463fb4e6cc5ff18e9cd0689d` (live origin/main at review time)
- **required_ancestor**: `2eb18ccecaf5950fc322ee8bf92987fa0bb8e2bd` (PR #197 — prior primary-scorer wall-clock guard baseline)
- **risk_class**: R4_CONTUR_PRODUCTION_BOUNDARY
- **repository**: POLYPROPICKS/PREMVP

## Changed file list (`git diff --stat 2b24dff..709109c3`)

```
 lib/contur3/taxonomy.ts                             |   6 +-
 lib/feed/buildLandingCards.ts                       | 868 +++++++---
 lib/feed/persistPrimarySignalPopulation.ts          | 103 +  (new)
 lib/feed/types.ts                                   |   7 +
 scripts/generate-signals.ts                         |  43 +-
 tests/feed/canonicalPrimaryPopulationPersistence.test.ts | 138 +  (new)
 tests/feed/primaryCoverageDiagnosticOnly.test.ts    | 124 +  (new)
 tests/feed/primaryPhysicalEventRecovery.test.ts     | 170 +  (new)
 tests/feed/primaryPopulationDecoupling.test.ts      | 256 +  (new)
 tests/feed/primarySiblingRecovery.test.ts           | 163 +-  (rewritten)
```

No change to: DB/schema, migrations, Reservation/Rebalance/Queue, Ireland, Signal
Score formula (`scorePolymarket`), thresholds, liquidity floor, timing windows,
six-sport / non-esports policy, dataCoverage calculation.

## Bundled semantic changes

### 1. Public-15 / semantic-population decoupling
- `buildLandingCards` option `evaluateFullPrimaryPopulation` (default `false` → byte-identical legacy).
- `runPrimaryCandidateLoop` extracted (faithful): `publicPairs` hard-bounded to
  `limit` (`clamp(options.limit ?? 4, 1, 15)` unchanged); `canonicalPrimaryPairs`
  collects every `PRIMARY_QUALIFIED` outcome.
- `productCapReached` split → `publicCapReached` (only routes a qualified pair to
  the public array) + `semanticEvaluationSuppressed = publicCapReached && !evaluateFullPrimaryPopulation`
  (retains the exact legacy skip only when the flag is off).
- `PRIMARY_SCORER_PROVEN_CAPACITY = 254` and `PRIMARY_LOOP_DEFAULT_BUDGET_MS = 360000`
  (`createPrimaryLoopBudgetGuard` clamp `[1000, 1800000]`) — **unchanged**.
- Conservation: `sum(primaryTerminalReasonCounts) === primaryCandidatesEntered` preserved.

### 2. Canonical >15 persistence wiring
- New `lib/feed/persistPrimarySignalPopulation.ts` — `persistCanonicalPrimarySignalPopulation`
  writes `selectCanonicalPrimaryExtras(primaryQualifiedPairs, publicPairsToCache)`
  (identity-diff on `conditionId::selectedTokenId`) through the **existing**
  `writeGeneratedSignalPairs` (→ `generated_signal_pairs` +
  `current_signal_pair_serving` projection, `metric_formula_version = "v2-lite-growth-safe"`).
- Extras written FIRST so `readLatestGeneratedSignalPairs(<=15)` (public feed) is byte-identical.
- `scripts/generate-signals.ts` passes `evaluateFullPrimaryPopulation: true` and
  calls the new persist function in place of the single public `writeGeneratedSignalPairs`.
- `<=15` qualified → no extra write, public path byte-identical.

### 3. Physical-event-scoped market recovery
- `selectRecoverablePrimarySibling` → `selectRecoverablePrimaryMarket(candidate, physicalEventUniverse=[])`.
- `resolvePhysicalMatchIdentity` — teams (token overlap, both sides) + kickoff day
  from `_parentMeta.startDate` / market question / event title. Fail-closed on unparseable.
- Branch (1) same-provider-event siblings + branch (2) `discovery.researchEligibleMarkets`
  rows under a different `eventId` matching the physical identity. One deterministic
  pick (corridor outcome closest to 0.45 → same-event over cross → lexicographic).
- `researchNestedMarketToCandidate` reused for cross-shard; `forcedOutcome` carries
  real `conditionId` / `selectedTokenId` / side into `enrichMarket`.
- Never crosses physical-event identity (both team sets + same day). No provider/network call.

### 4. Authorized market contour for recovery
- `AUTHORIZED_RECOVERY_MARKET_TYPES = { moneyline, spread, spreads, total, totals }`
  — exact `sportsMarketType` match, applied to BOTH recovery branches.
- Excludes `total_corners`, `soccer_*_team_totals`, `soccer_halftime_result`,
  `soccer_first_to_score`, half markets.

### 5. Contract A terse O/U total recognition
- `lib/contur3/taxonomy.ts` `ALLOWED_TOTAL_TOKEN`: `+ \bo u \d` (joined surface).
- "O/U 2.5" → tokenizer splits the slash → `o u 2` → `allowed_fullmatch_total`.
- Forbidden classes (`FORBIDDEN_HALFTIME_SQ`, `FORBIDDEN_CORNERS_SQ`, …) still
  tested first → "1st Half O/U" / "O/U Total Corners" stay forbidden.
- No new market family authorized. Monitor parity audit (`contur3LiveFunnelMonitor.mjs`) unchanged.

### 6. Primary dataCoverage → diagnostic-only
- `runPrimaryCandidateLoop`: the `if (dataCoverage < minDataCoverage) { recordPrimaryTerminal("PRIMARY_REJECTED_DATA_COVERAGE_BELOW_THRESHOLD"); rejected.push(...); continue; }`
  hard gate → `if (dataCoverage < minDataCoverage) { primaryCoverageRejectionValues.push(v); }` (diagnostic only).
- `minDataCoverage` constant/clamp untouched; `enrichMarket` coverage calc untouched;
  `enriched.diagnostics.dataCoverage` still carried verbatim onto the pair; value
  still on `rf.primaryCoverageRejectionValues` + `rf.primaryCoverageThresholdApplied`.
- Candidate continues to `generateLandingCardPair` / winProbability / ended / dedupe.
- `PRIMARY_REJECTED_DATA_COVERAGE_BELOW_THRESHOLD` no longer emitted; grep confirms
  no downstream consumer of that label.

## Test evidence at reviewed_sha (`node --import tsx --test`)

```
tests/feed/primaryPopulationDecoupling.test.ts
tests/feed/canonicalPrimaryPopulationPersistence.test.ts
tests/feed/primaryPhysicalEventRecovery.test.ts
tests/feed/primarySiblingRecovery.test.ts
tests/feed/primaryCoverageDiagnosticOnly.test.ts
tests/feed/primaryLoopWallClockGuard.test.ts
tests/feed/primaryScorerPopulationCap.test.ts
tests/contur3/taxonomy.corpus.test.ts        (incl. legacy monitor parity audit)
tests/contur3/fullMatchAnchorScope.test.ts
-> ℹ tests 64  ℹ pass 64  ℹ fail 0
npx tsc --noEmit -> clean on all changed/new files
```

(`tests/contur3/buildFireModelCandidates.loaderBoundary.test.ts` fails 2/2 —
confirmed pre-existing on base `2eb18cc` with this bundle stashed; live-DB
dependent, unrelated to this change.)

## Release acceptance invariants

| invariant | evidence |
|---|---|
| `PUBLIC_FEED <= 15` | `limit = clamp(options.limit ?? 4, 1, 15)`; `publicPairs.push` gated `if (publicPairs.length < limit)`; `readLatestGeneratedSignalPairs(<=15)` unchanged; decoupling test PUBLIC_OUTPUT_COUNT = 15 with 20/22 qualified |
| `CANONICAL_PRIMARY_QUALIFIED_NOT_PUBLIC_CAP_LIMITED` | `canonicalPrimaryPairs` = full qualified set; persistence test CANONICAL_PERSISTED_COUNT = 22 (15 public + 7 extras), ranks 16–22 reach `writeGeneratedSignalPairs`, 0 duplicate identity |
| `RECOVERY_SCOPE = SAME_PHYSICAL_EVENT` | `resolvePhysicalMatchIdentity` + `rowIsSamePhysicalEvent` (both teams + day); contamination test: different-teams-same-day and same-teams-different-day both → `null` |
| `AUTHORIZED_MARKETS = MONEYLINE/SPREAD/FULL_MATCH_TOTAL` | `AUTHORIZED_RECOVERY_MARKET_TYPES` Set both branches; test 4/4b: corners/halftime/first-to-score/half-team-total → not selected |
| `LOW_COVERAGE_DOES_NOT_TERMINATE_PRIMARY_SCORING` | coverage 25 and 8 both reach `PRIMARY_QUALIFIED`; coverage 5 + winProb 40 → `PRIMARY_REJECTED_WIN_PROBABILITY_BELOW_52` (model still rejects); `PRIMARY_REJECTED_DATA_COVERAGE_BELOW_THRESHOLD` never emitted; conservation exact |

## Product semantic delta

Primary money-path candidate **population** widens (full 254-bounded semantic
evaluation; coverage no longer terminal; physical-event recovery) and more
canonical-qualified primary outcomes reach `generated_signal_pairs` /
`current_signal_pair_serving`. Downstream **policy** (Contract A B2 score >= 65,
price >= 0.30, liquidity >= $1000 aggregate physical event, six-sport,
non-esports, Reservation = one physical event, Rebalance, Queue) is unchanged and
still filters this larger population. Contract A market admission adds recognition
of the terse "O/U 2.5" wording for an already-authorized class (full-match total);
no new family. Public presentation cap of 15 unchanged.
