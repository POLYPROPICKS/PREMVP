import { test } from "node:test";
import assert from "node:assert/strict";

import { runPrimaryCandidateLoop, sampleToCandidateMarkets, type PrimaryCandidateLoopParams } from "../../lib/feed/buildLandingCards";
import type { SportsDiscoverySample } from "../../lib/feed/types";

// MISSION: SCORER_INPUT_FANOUT_ONLY_V1
//
// `sampleToCandidateMarkets` expands ONE physical event (one discovery sample)
// into N independent `CandidateMarket`s — the pre-existing single primary
// representative PLUS every already-carried `sample.marketsRaw` sibling whose
// `sportsMarketType` is already authorized for recovery (moneyline / spread /
// total). No new source qualification, no new network fetch: this is strictly
// the EXISTING broad research carrier (`sample.marketsRaw`), the SAME
// `AUTHORIZED_RECOVERY_MARKET_TYPES` gate `selectRecoverablePrimaryMarket`
// already uses, now expressed as parallel scorer inputs instead of a
// single-pick enrichment fallback.
//
// Run: node --import tsx --test tests/feed/scorerInputFanoutOnly.test.ts

type SiblingRaw = NonNullable<SportsDiscoverySample["marketsRaw"]>[number];

function sib(conditionId: string, opts?: Partial<SiblingRaw>): SiblingRaw {
  return {
    outcomes: ["Team A", "Team B"],
    outcomePrices: [0.45, 0.55],
    clobTokenIds: [`${conditionId}-tokA`, `${conditionId}-tokB`],
    question: "Team A vs Team B",
    sportsMarketType: "moneyline",
    conditionId,
    ...opts,
  } as SiblingRaw;
}

function sample(marketsRaw: SiblingRaw[] | undefined, opts?: Partial<SportsDiscoverySample>): SportsDiscoverySample {
  return {
    title: "Team A vs Team B",
    slug: "team-a-vs-team-b",
    gameId: "game-1",
    eventVolumeUsd: 100000,
    resolvedGameTimeIso: "2026-09-11T18:00:00.000Z",
    gameTimeSource: "test",
    gameTimeConfidence: "high",
    marketCount: (marketsRaw?.length ?? 0) + 1,
    strategy: "markets-first",
    primaryMarketRaw: {
      outcomes: ["Team A", "Team B"],
      outcomePrices: [0.97, 0.03],
      clobTokenIds: ["cond-primary-tokA", "cond-primary-tokB"],
      question: "Team A vs Team B",
      sportsMarketType: "moneyline",
      conditionId: "cond-primary",
    },
    marketsRaw,
    ...opts,
  } as unknown as SportsDiscoverySample;
}

test("1. one physical event with a primary + two authorized siblings produces each two-sided token as a distinct scorer input", () => {
  const s = sample([
    sib("cond-spread", { sportsMarketType: "spreads", outcomePrices: [0.47, 0.53] }),
    sib("cond-total", { sportsMarketType: "totals", outcomePrices: [0.44, 0.56] }),
  ]);

  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 6, "three authorized two-sided markets emit six scorer inputs");

  const conditionIds = candidates.map((c) => c.market.conditionId);
  assert.deepEqual(new Set(conditionIds).size, 3, "physical provider markets remain distinct");
  assert.equal(new Set(candidates.map((c) => c.forcedOutcome?.selectedTokenId)).size, 6, "each scorer input owns one exact token");
  assert.deepEqual(
    candidates.map((c) => c.forcedOutcome?.selectedPriceNum).sort((a, b) => (a ?? 0) - (b ?? 0)),
    [0.03, 0.44, 0.47, 0.53, 0.56, 0.97],
  );
});

test("2. each fan-out candidate is keyed by its own distinct condition_id (identity, not a clone)", () => {
  const s = sample([sib("cond-spread", { sportsMarketType: "spreads", outcomePrices: [0.47, 0.53] })]);
  const candidates = sampleToCandidateMarkets(s);
  const primary = candidates.filter((c) => c.market.conditionId === "cond-primary");
  const spreadCandidate = candidates.filter((c) => c.market.conditionId === "cond-spread");

  assert.equal(primary.length, 2);
  assert.equal(spreadCandidate.length, 2);
  // Distinct market objects, distinct outcome/price/token payloads — not the
  // same object reused for two identities.
  assert.notEqual(primary[0].market, spreadCandidate[0].market);
  assert.notEqual(primary[0].market.conditionId, spreadCandidate[0].market.conditionId);
  assert.deepEqual(spreadCandidate[0].market.outcomePrices, [0.47, 0.53]);
});

test("3. unauthorized market families (corners / halftime) are excluded from fan-out — no new eligibility corridor", () => {
  const s = sample([
    sib("cond-corners", { sportsMarketType: "total_corners", outcomePrices: [0.44, 0.56] }),
    sib("cond-ht", { sportsMarketType: "soccer_halftime_result", outcomePrices: [0.45, 0.55] }),
  ]);
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 2, "only the primary's two identities — unauthorized siblings never become scorer inputs");
  assert.equal(candidates[0].market.conditionId, "cond-primary");
});

test("4. malformed / non-binary siblings are excluded (fail-closed, same guards as recovery)", () => {
  const s = sample([
    { outcomes: ["A", "Draw", "B"], outcomePrices: [0.4, 0.3, 0.3], clobTokenIds: ["t1", "t2", "t3"], question: "3-way", sportsMarketType: "moneyline", conditionId: "cond-3way" } as SiblingRaw,
    sib("cond-notoken", { clobTokenIds: ["", ""] }),
  ]);
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 2, "only the primary's two identities — malformed siblings never become scorer inputs");
});

test("5. the primary's own conditionId is never duplicated even if it also appears in marketsRaw", () => {
  const s = sample([
    sib("cond-primary"), // duplicate of the primary identity — must not double-count
    sib("cond-spread", { sportsMarketType: "spreads", outcomePrices: [0.47, 0.53] }),
  ]);
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 4, "two identities for each genuinely distinct authorized market");
  const conditionIds = candidates.map((c) => c.market.conditionId);
  assert.equal(conditionIds.filter((id) => id === "cond-primary").length, 2);
});

test("6. a single authorized two-sided market emits both identities rather than the legacy selected-outcome representative", () => {
  const s = sample(undefined);
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.forcedOutcome?.selectedTokenId).sort(), ["cond-primary-tokA", "cond-primary-tokB"]);
});

test("7. a sample whose primary cannot be built (no conditionId) still yields zero candidates — fail-closed, not widened", () => {
  const s = sample([sib("cond-spread", { sportsMarketType: "spreads" })], {
    primaryMarketRaw: { outcomes: [], outcomePrices: [], clobTokenIds: [], question: "x", conditionId: undefined },
  });
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 0, "no primary -> no fan-out; siblings are only ever considered alongside a real primary");
});

test("8. deterministic ordering — primary first, siblings lexicographic by conditionId", () => {
  const s = sample([
    sib("cond-z-total", { sportsMarketType: "totals", outcomePrices: [0.46, 0.54] }),
    sib("cond-a-spread", { sportsMarketType: "spreads", outcomePrices: [0.47, 0.53] }),
  ]);
  const candidates = sampleToCandidateMarkets(s);
  assert.deepEqual(
    candidates.map((c) => c.market.conditionId),
    ["cond-primary", "cond-primary", "cond-a-spread", "cond-a-spread", "cond-z-total", "cond-z-total"],
  );
});

test("9. 0.20/0.80 and 0.50/0.50 preserve both exact token/price identities with no tie collapse", () => {
  const asymmetric = sample(undefined, {
    primaryMarketRaw: {
      outcomes: ["Underdog", "Favorite"], outcomePrices: [0.20, 0.80], clobTokenIds: ["tok-20", "tok-80"],
      question: "A vs B", sportsMarketType: "moneyline", conditionId: "cond-asymmetric",
    },
  });
  const tied = sample(undefined, {
    primaryMarketRaw: {
      outcomes: ["Over", "Under"], outcomePrices: [0.50, 0.50], clobTokenIds: ["tok-over", "tok-under"],
      question: "Total", sportsMarketType: "totals", conditionId: "cond-tied",
    },
  });
  for (const [input, expected] of [[asymmetric, ["tok-20", "tok-80"]], [tied, ["tok-over", "tok-under"]]] as const) {
    const candidates = sampleToCandidateMarkets(input);
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((c) => c.forcedOutcome?.selectedTokenId).sort(), expected);
    assert.equal(new Set(candidates.map((c) => c.forcedOutcome?.selectedTokenId)).size, 2, "no same-token duplicate scorer input");
  }
});

test("10. the two identities invoke the existing scorer boundary independently with no score copy", async () => {
  const candidates = sampleToCandidateMarkets(sample(undefined, {
    primaryMarketRaw: {
      outcomes: ["Team A", "Team B"], outcomePrices: [0.45, 0.55], clobTokenIds: ["tok-a", "tok-b"],
      question: "Team A vs Team B", sportsMarketType: "moneyline", conditionId: "cond-scorer",
    },
  }));
  const attempts: Array<{ token: string; price: number }> = [];
  const params: PrimaryCandidateLoopParams = {
    candidates, limit: 15, minDataCoverage: 40, excludeEnded: true, evaluateFullPrimaryPopulation: true,
    budgetGuard: { isExhausted: () => false, elapsedMs: () => 0, budgetMs: 1 } as PrimaryCandidateLoopParams["budgetGuard"],
    collectResearchSnapshots: false, isResearchCapReached: () => true, pinnedKeysForPersistCheck: new Set(), rejected: [],
    researchFunnel: { candidatesSeen: 0, rejectedPreResearchCandidateReasons: 0, enrichmentNull: 0, attempted: 0, rejectedMissingConditionOrSelectedToken: 0, rejectedNoBinaryGuard: 0, rejectedMissingOpposingToken: 0, rejectedInvalidPrice: 0, rejectedOddsBelowMin: 0, rejectedOddsAboveMax: 0, eligible: 0, execFetchAttempted: 0, execFetchOk: 0, execFetchEmptyBook: 0, execFetchFailed: 0 },
    seenPairIds: new Set(), seenMarketKeys: new Set(),
    deps: {
      enrichMarket: async (_event, _market, _warnings, forced) => {
        attempts.push({ token: forced!.selectedTokenId, price: forced!.selectedPriceNum });
        return { diagnostics: { dataCoverage: 100, rejectionReasons: [], conditionId: "cond-scorer" } } as never;
      },
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: () => {
        const attempt = attempts[attempts.length - 1];
        return { id: `pair-${attempt.token}`, premiumSignal: { winProbability: 70, time: "3h" }, marketSource: { headline: attempt.token }, diagnostics: { conditionId: "cond-scorer", selectedTokenId: attempt.token } } as never;
      },
      computeCandidateProviderEventKey: () => null,
      captureResearchSnapshot: async () => {},
    },
  };
  const result = await runPrimaryCandidateLoop(params);
  assert.deepEqual(attempts, [{ token: "tok-a", price: 0.45 }, { token: "tok-b", price: 0.55 }]);

  // BOTH_SIDE_EVIDENCE_RELEASE_V1: both independently scored sides of the
  // SAME market (same conditionId, same market.id/undefined market key) must
  // both survive the primary-loop duplicate guard. Before the fix, the
  // second candidate was rejected as PRIMARY_REJECTED_DUPLICATE purely
  // because it shared the market-level key with the first.
  assert.equal(result.canonicalPrimaryPairs.length, 2, "both sides of the market must qualify, not just the first-processed one");
  assert.deepEqual(
    result.canonicalPrimaryPairs.map((p) => p.diagnostics.selectedTokenId).sort(),
    ["tok-a", "tok-b"],
  );
});

test("11. same-token duplicate (identical market.id + selected token processed twice) is still rejected", () => {
  const seenPairIds = new Set<string>();
  const seenMarketKeys = new Set<string>();
  const candidates = sampleToCandidateMarkets(sample(undefined, {
    primaryMarketRaw: {
      outcomes: ["Team A", "Team B"], outcomePrices: [0.45, 0.55], clobTokenIds: ["tok-a", "tok-b"],
      question: "Team A vs Team B", sportsMarketType: "moneyline", conditionId: "cond-dup",
    },
  }));
  // Duplicate the FIRST fan-out candidate (same token, same market) to simulate
  // the same exact economic identity being offered twice in one cycle.
  const duped = [candidates[0], candidates[0], candidates[1]];
  const attempts: string[] = [];
  const params: PrimaryCandidateLoopParams = {
    candidates: duped, limit: 15, minDataCoverage: 40, excludeEnded: true, evaluateFullPrimaryPopulation: true,
    budgetGuard: { isExhausted: () => false, elapsedMs: () => 0, budgetMs: 1 } as PrimaryCandidateLoopParams["budgetGuard"],
    collectResearchSnapshots: false, isResearchCapReached: () => true, pinnedKeysForPersistCheck: new Set(), rejected: [],
    researchFunnel: { candidatesSeen: 0, rejectedPreResearchCandidateReasons: 0, enrichmentNull: 0, attempted: 0, rejectedMissingConditionOrSelectedToken: 0, rejectedNoBinaryGuard: 0, rejectedMissingOpposingToken: 0, rejectedInvalidPrice: 0, rejectedOddsBelowMin: 0, rejectedOddsAboveMax: 0, eligible: 0, execFetchAttempted: 0, execFetchOk: 0, execFetchEmptyBook: 0, execFetchFailed: 0 },
    seenPairIds, seenMarketKeys,
    deps: {
      enrichMarket: async (_event, _market, _warnings, forced) => {
        attempts.push(forced!.selectedTokenId);
        return { diagnostics: { dataCoverage: 100, rejectionReasons: [], conditionId: "cond-dup" } } as never;
      },
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: () => {
        const token = attempts[attempts.length - 1];
        return { id: `pair-${token}`, premiumSignal: { winProbability: 70, time: "3h" }, marketSource: { headline: token }, diagnostics: { conditionId: "cond-dup", selectedTokenId: token } } as never;
      },
      computeCandidateProviderEventKey: () => null,
      captureResearchSnapshot: async () => {},
    },
  };
  const result = (async () => runPrimaryCandidateLoop(params))();
  return result.then((r) => {
    assert.equal(r.canonicalPrimaryPairs.length, 2, "exactly one row per distinct (condition,token); the repeated identity is deduped, not tripled");
    assert.deepEqual(r.canonicalPrimaryPairs.map((p) => p.diagnostics.selectedTokenId).sort(), ["tok-a", "tok-b"]);
  });
});
