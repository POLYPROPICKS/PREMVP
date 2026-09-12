import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runPrimaryCandidateLoop,
  PRIMARY_LOOP_DEFAULT_BUDGET_MS,
  type CandidateMarket,
  type PrimaryCandidateLoopParams,
} from "../../lib/feed/buildLandingCards";
import type { LandingCardPair } from "../../lib/feed/types";

// MISSION: SCORER_INPUT_FANOUT_ONLY_V1 — canonical-primary identity lineage.
//
// Each attempted scorer input carries its own (condition_id, selected_token_id)
// identity. Multiple identity-scoped attempts for the SAME physical event must
// run independently through the unchanged scorer path, and a returned pair may
// only enter `canonicalPrimaryPairs` when its returned condition_id/token
// identity matches the identity THIS candidate attempted — never a
// cross-identity substitute picked up by the (unchanged) primary
// representative-market recovery fallback. This guards against score/pair
// copying across fan-out identities of the same event.
//
// Run: node --import tsx --test tests/feed/canonicalPrimaryIdentityLineage.test.ts

function fanoutCandidate(conditionId: string): CandidateMarket {
  return {
    event: { id: `evt-shared-physical-event`, title: "Team A vs Team B", markets: [] } as unknown as CandidateMarket["event"],
    market: {
      id: `mkt-${conditionId}`,
      conditionId,
      question: "Team A vs Team B",
      slug: `slug-${conditionId}`,
    } as unknown as CandidateMarket["market"],
    rejectionReasons: [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
    sportsMatchedKeyword: "sports-discovery",
  };
}

function baseParams(candidates: CandidateMarket[], deps: Partial<PrimaryCandidateLoopParams["deps"]>): PrimaryCandidateLoopParams {
  return {
    candidates,
    limit: 15,
    minDataCoverage: 40,
    excludeEnded: true,
    evaluateFullPrimaryPopulation: true,
    budgetGuard: { isExhausted: () => false, elapsedMs: () => 0, budgetMs: PRIMARY_LOOP_DEFAULT_BUDGET_MS } as PrimaryCandidateLoopParams["budgetGuard"],
    collectResearchSnapshots: false,
    isResearchCapReached: () => true,
    pinnedKeysForPersistCheck: new Set<string>(),
    rejected: [],
    researchFunnel: {
      candidatesSeen: 0, rejectedPreResearchCandidateReasons: 0, enrichmentNull: 0,
      attempted: 0, rejectedMissingConditionOrSelectedToken: 0, rejectedNoBinaryGuard: 0,
      rejectedMissingOpposingToken: 0, rejectedInvalidPrice: 0, rejectedOddsBelowMin: 0,
      rejectedOddsAboveMax: 0, eligible: 0, execFetchAttempted: 0,
      execFetchOk: 0, execFetchEmptyBook: 0, execFetchFailed: 0,
    },
    seenPairIds: new Set<string>(),
    seenMarketKeys: new Set<string>(),
    deps: {
      enrichMarket: async () => null,
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: () => null,
      computeCandidateProviderEventKey: () => null,
      captureResearchSnapshot: async () => {},
      ...deps,
    },
  };
}

test("1. two independent fan-out identities of the SAME physical event both qualify with distinct scores (no copying)", async () => {
  const candidates = [fanoutCandidate("cond-moneyline"), fanoutCandidate("cond-spread")];
  const scoreByCondition: Record<string, number> = { "cond-moneyline": 61, "cond-spread": 74 };

  const r = await runPrimaryCandidateLoop(
    baseParams(candidates, {
      enrichMarket: async (_event, market) => ({
        diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: market.conditionId },
      } as unknown as Awaited<ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>>),
      generateLandingCardPair: (enriched) => {
        const cid = (enriched as unknown as { diagnostics: { conditionId: string } }).diagnostics.conditionId;
        return {
          id: `pair-${cid}`,
          premiumSignal: { winProbability: scoreByCondition[cid], time: "3h" },
          diagnostics: { conditionId: cid, selectedTokenId: `tok-${cid}` },
        } as unknown as LandingCardPair;
      },
    }),
  );

  assert.equal(r.canonicalPrimaryPairs.length, 2, "both identity-scoped attempts qualify independently");
  const byId = new Map(r.canonicalPrimaryPairs.map((p) => [p.diagnostics.conditionId, p]));
  assert.equal(byId.get("cond-moneyline")!.premiumSignal.winProbability, 61);
  assert.equal(byId.get("cond-spread")!.premiumSignal.winProbability, 74);
  assert.notEqual(
    byId.get("cond-moneyline")!.premiumSignal.winProbability,
    byId.get("cond-spread")!.premiumSignal.winProbability,
    "distinct scores prove the second attempt was independently scored, not copied from the first",
  );
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED, 2);
});

test("2. a pair recovered under a DIFFERENT identity than attempted is rejected, not admitted into canonicalPrimaryPairs", async () => {
  const candidates = [fanoutCandidate("cond-attempted")];

  const r = await runPrimaryCandidateLoop(
    baseParams(candidates, {
      // The candidate's own market fails to enrich...
      enrichMarket: async (_event, market) => {
        if (market.conditionId === "cond-attempted") return null;
        return { diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: market.conditionId } } as unknown as Awaited<
          ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>
        >;
      },
      // ...and physical-event-scoped recovery substitutes a DIFFERENT identity
      // (exactly today's `selectRecoverablePrimaryMarket` shape: real, valid,
      // successfully-enrichable market, just not the one this candidate attempted).
      selectRecoverablePrimaryMarket: () => ({
        candidate: fanoutCandidate("cond-recovered-substitute"),
        forcedOutcome: { selectedTokenId: "tok-recovered", selectedPriceNum: 0.45 },
        recoverySource: "same-provider-event",
      }),
      generateLandingCardPair: (enriched) => {
        const cid = (enriched as unknown as { diagnostics: { conditionId: string } }).diagnostics.conditionId;
        return {
          id: `pair-${cid}`,
          premiumSignal: { winProbability: 70, time: "3h" },
          diagnostics: { conditionId: cid, selectedTokenId: `tok-${cid}` },
        } as unknown as LandingCardPair;
      },
    }),
  );

  assert.equal(r.canonicalPrimaryPairs.length, 0, "cross-identity recovery substitute never enters canonicalPrimaryPairs");
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_REJECTED_IDENTITY_MISMATCH, 1);
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED, undefined);
});

test("3. recovery that resolves back to the SAME attempted identity still qualifies normally", async () => {
  const candidates = [fanoutCandidate("cond-attempted")];
  let enrichCallCount = 0;

  const r = await runPrimaryCandidateLoop(
    baseParams(candidates, {
      enrichMarket: async (_event, market) => {
        enrichCallCount++;
        // First attempt (no forcedOutcome) fails; recovery retries the SAME
        // conditionId with a forced outcome and succeeds.
        if (enrichCallCount === 1) return null;
        return { diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: market.conditionId } } as unknown as Awaited<
          ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>
        >;
      },
      selectRecoverablePrimaryMarket: () => ({
        candidate: fanoutCandidate("cond-attempted"),
        forcedOutcome: { selectedTokenId: "tok-attempted", selectedPriceNum: 0.45 },
        recoverySource: "same-provider-event",
      }),
      generateLandingCardPair: (enriched) => {
        const cid = (enriched as unknown as { diagnostics: { conditionId: string } }).diagnostics.conditionId;
        return {
          id: `pair-${cid}`,
          premiumSignal: { winProbability: 70, time: "3h" },
          diagnostics: { conditionId: cid, selectedTokenId: `tok-${cid}` },
        } as unknown as LandingCardPair;
      },
    }),
  );

  assert.equal(r.canonicalPrimaryPairs.length, 1);
  assert.equal(r.canonicalPrimaryPairs[0].diagnostics.conditionId, "cond-attempted");
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED, 1);
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_REJECTED_IDENTITY_MISMATCH, undefined);
});

test("4. two scored tokens of one condition survive post-scorer dedup, while a repeated exact token is skipped", async () => {
  const side = (token: string, price: number): CandidateMarket => ({
    ...fanoutCandidate("cond-binary"),
    forcedOutcome: { selectedTokenId: token, selectedOutcomeName: token, selectedOutcomeIndex: token === "tok-a" ? 0 : 1, selectedPriceNum: price },
  });
  const candidates = [side("tok-a", 0.45), side("tok-b", 0.55), side("tok-a", 0.45)];
  const attempts: Array<{ token: string; price: number }> = [];

  const r = await runPrimaryCandidateLoop(
    baseParams(candidates, {
      enrichMarket: async (_event, _market, _warnings, forced) => {
        attempts.push({ token: forced!.selectedTokenId, price: forced!.selectedPriceNum });
        return { diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: "cond-binary", token: forced!.selectedTokenId, price: forced!.selectedPriceNum } } as never;
      },
      generateLandingCardPair: (enriched) => {
        const d = (enriched as unknown as { diagnostics: { token: string; price: number } }).diagnostics;
        return {
          // Deliberately identical presentation id: only the economic identity may dedup.
          id: "same-condition-presentation",
          premiumSignal: { winProbability: d.token === "tok-a" ? 66 : 74, time: "3h" },
          diagnostics: { conditionId: "cond-binary", selectedTokenId: d.token, currentPrice: d.price },
        } as unknown as LandingCardPair;
      },
    }),
  );

  assert.deepEqual(attempts, [
    { token: "tok-a", price: 0.45 },
    { token: "tok-b", price: 0.55 },
    { token: "tok-a", price: 0.45 },
  ]);
  assert.equal(r.canonicalPrimaryPairs.length, 2);
  assert.deepEqual(
    r.canonicalPrimaryPairs.map((p) => [p.diagnostics.selectedTokenId, p.diagnostics.currentPrice]),
    [["tok-a", 0.45], ["tok-b", 0.55]],
  );
  assert.deepEqual(r.canonicalPrimaryPairs.map((p) => p.premiumSignal.winProbability), [66, 74]);
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_REJECTED_DUPLICATE, 1);
});
