import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runPrimaryCandidateLoop,
  PRIMARY_LOOP_DEFAULT_BUDGET_MS,
  PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON,
  type CandidateMarket,
  type PrimaryCandidateLoopParams,
} from "../../lib/feed/buildLandingCards";
import type { LandingCardPair } from "../../lib/feed/types";

// MISSION: primary dataCoverage is DIAGNOSTIC-ONLY — a low value (incl. < 25) no
// longer terminates an otherwise valid candidate. Coverage is still computed and
// carried; the candidate continues to the pair/model decision path.
//
// Run: node --import tsx --test tests/feed/primaryCoverageDiagnosticOnly.test.ts

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

// Per-candidate scenario keyed by market id suffix.
type S = { coverage: number; winProbability: number };
const SCEN = new Map<string, S>();

function candidate(i: number): CandidateMarket {
  const id = `c-${i}`;
  return {
    event: { id: `evt-${id}`, title: id, markets: [] } as unknown as CandidateMarket["event"],
    market: { id: `mkt-${id}`, conditionId: `cond-${id}`, question: `${id}?`, slug: `s-${id}` } as unknown as CandidateMarket["market"],
    rejectionReasons: [], warnings: [], isSportsRelated: true, isEnded: false, sportsMatchedKeyword: "sports-discovery",
  };
}

function params(candidates: CandidateMarket[], budgetGuard?: PrimaryCandidateLoopParams["budgetGuard"]): PrimaryCandidateLoopParams {
  return {
    candidates,
    limit: 15,
    minDataCoverage: 40, // UNCHANGED threshold — now diagnostic-only for the primary path
    excludeEnded: true,
    evaluateFullPrimaryPopulation: true,
    budgetGuard: budgetGuard ?? ({ isExhausted: () => false, elapsedMs: () => 0, budgetMs: PRIMARY_LOOP_DEFAULT_BUDGET_MS } as PrimaryCandidateLoopParams["budgetGuard"]),
    collectResearchSnapshots: false,
    isResearchCapReached: () => true,
    pinnedKeysForPersistCheck: new Set<string>(),
    rejected: [],
    researchFunnel: {
      candidatesSeen: 0, rejectedPreResearchCandidateReasons: 0, enrichmentNull: 0, attempted: 0,
      rejectedMissingConditionOrSelectedToken: 0, rejectedNoBinaryGuard: 0, rejectedMissingOpposingToken: 0,
      rejectedInvalidPrice: 0, rejectedOddsBelowMin: 0, rejectedOddsAboveMax: 0, eligible: 0,
      execFetchAttempted: 0, execFetchOk: 0, execFetchEmptyBook: 0, execFetchFailed: 0,
    },
    seenPairIds: new Set<string>(),
    seenMarketKeys: new Set<string>(),
    deps: {
      enrichMarket: async (_e, market) => {
        const key = String(market.id).replace("mkt-", "");
        const s = SCEN.get(key)!;
        return { diagnostics: { dataCoverage: s.coverage, rejectionReasons: [], conditionId: `cond-${key}` }, __key: key } as unknown as Awaited<ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>>;
      },
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: (enriched) => {
        const e = enriched as unknown as { __key: string; diagnostics: { dataCoverage: number } };
        const s = SCEN.get(e.__key)!;
        return {
          id: `pair-${e.__key}`,
          premiumSignal: { winProbability: s.winProbability, time: "3h" },
          marketSource: { headline: e.__key },
          // coverage value preserved verbatim on the produced pair's diagnostics
          diagnostics: { conditionId: `cond-${e.__key}`, selectedTokenId: `tok-${e.__key}`, dataCoverage: e.diagnostics.dataCoverage },
        } as unknown as LandingCardPair;
      },
      computeCandidateProviderEventKey: () => null,
      captureResearchSnapshot: async () => {},
    },
  };
}

test("coverage 25 and coverage < 25 both continue to semantic scoring; model can still reject", async () => {
  SCEN.clear();
  SCEN.set("c-0", { coverage: 25, winProbability: 70 });  // (1) continues -> qualifies
  SCEN.set("c-1", { coverage: 8, winProbability: 70 });   // (2) continues -> qualifies
  SCEN.set("c-2", { coverage: 5, winProbability: 40 });   // (4) continues -> rejected by the WIN_PROB model gate
  SCEN.set("c-3", { coverage: 90, winProbability: 70 });  // control

  const cands = [0, 1, 2, 3].map(candidate);
  const r = await runPrimaryCandidateLoop(params(cands));
  const c = r.primaryTerminalReasonCounts;

  // (1)+(2): low-coverage candidates reach qualification
  assert.equal(c.PRIMARY_QUALIFIED, 3, "coverage 25, 8 and 90 all qualified");
  assert.ok(r.canonicalPrimaryPairs.some((p) => p.id === "pair-c-0"));
  assert.ok(r.canonicalPrimaryPairs.some((p) => p.id === "pair-c-1"));

  // (4): normal model/pair rejection still applies to a low-coverage candidate
  assert.equal(c.PRIMARY_REJECTED_WIN_PROBABILITY_BELOW_52, 1);

  // coverage is NEVER a terminal reason anymore
  assert.equal(c.PRIMARY_REJECTED_DATA_COVERAGE_BELOW_THRESHOLD, undefined);

  // (3): coverage value preserved — collected below-threshold values + on the pair
  assert.deepEqual([...r.primaryCoverageRejectionValues].sort((a, b) => a - b), [5, 8, 25]);
  const p0 = r.canonicalPrimaryPairs.find((p) => p.id === "pair-c-0")!;
  assert.equal((p0.diagnostics as { dataCoverage?: number }).dataCoverage, 25);

  // (5): conservation exact
  assert.equal(sum(c), r.primaryCandidatesEntered);
  assert.equal(r.primaryCandidatesEntered, 4);
});

test("(6) 360s primary-loop guard unchanged and still fires with diagnostic-only coverage", async () => {
  assert.equal(PRIMARY_LOOP_DEFAULT_BUDGET_MS, 6 * 60_000); // 360s

  SCEN.clear();
  for (let i = 0; i < 10; i++) SCEN.set(`c-${i}`, { coverage: 5, winProbability: 70 }); // all low coverage
  let calls = 0;
  const guard = { isExhausted: () => calls++ >= 3, elapsedMs: () => 0, budgetMs: PRIMARY_LOOP_DEFAULT_BUDGET_MS } as PrimaryCandidateLoopParams["budgetGuard"];

  const r = await runPrimaryCandidateLoop(params([...Array(10)].map((_, i) => candidate(i)), guard));
  const c = r.primaryTerminalReasonCounts;
  assert.equal(c.PRIMARY_QUALIFIED, 3);
  assert.equal(c[PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON], 7);
  assert.equal(sum(c), r.primaryCandidatesEntered);
  assert.equal(r.primaryCandidatesEntered, 10);
});
