import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sampleToCandidateMarket,
  selectRecoverablePrimaryMarket,
} from "../../lib/feed/buildLandingCards";
import type { CandidateMarket } from "../../lib/feed/buildLandingCards";
import type { SportsDiscoverySample } from "../../lib/feed/types";

// Same-provider-event branch of the physical-event-scoped recovery
// (`selectRecoverablePrimaryMarket` with an empty universe). This branch
// SUBSUMES the former moneyline-only same-shard recovery: any binary sibling of
// the same provider event group is now eligible, still gated by the unchanged
// selectOutcome price corridor and binary token identity.

type SiblingRaw = NonNullable<SportsDiscoverySample["marketsRaw"]>[number];

function sib(conditionId: string, prices: number[], opts?: Partial<SiblingRaw>): SiblingRaw {
  return {
    outcomes: ["Team A", "Team B"],
    outcomePrices: prices,
    clobTokenIds: [`${conditionId}-tokA`, `${conditionId}-tokB`],
    question: "Team A vs Team B",
    sportsMarketType: "moneyline",
    conditionId,
    ...opts,
  } as SiblingRaw;
}

function primaryCandidate(siblings: SiblingRaw[] | undefined): CandidateMarket {
  return {
    event: { id: "provider-event-1", title: "Team A vs Team B", slug: "team-a-vs-team-b", active: true, closed: false, markets: [], category: "sports" },
    market: {
      id: "cond-primary", conditionId: "cond-primary", question: "Team A vs Team B", slug: "team-a-vs-team-b",
      active: true, closed: false,
      outcomes: ["Team A", "Team B"] as unknown as never,
      outcomePrices: [0.97, 0.03] as unknown as never,
      clobTokenIds: ["cond-primary-tokA", "cond-primary-tokB"] as unknown as never,
    },
    rejectionReasons: [], warnings: [], isSportsRelated: true, isEnded: false,
    sportsMatchedKeyword: "sports-discovery", siblingMarketsRaw: siblings,
  };
}

test("A. recovers a same-provider-event binary sibling with a corridor outcome; identity preserved", () => {
  const candidate = primaryCandidate([
    sib("cond-primary", [0.97, 0.03]),        // the representative — skipped
    sib("cond-ml-sibling", [0.45, 0.55]),
  ]);
  const r = selectRecoverablePrimaryMarket(candidate);
  assert.ok(r);
  assert.equal(r!.recoverySource, "same-provider-event");
  assert.equal(r!.candidate.market.conditionId, "cond-ml-sibling");
  assert.equal(r!.forcedOutcome.selectedTokenId, "cond-ml-sibling-tokA"); // 0.45 side, real token
  assert.equal(r!.forcedOutcome.selectedPriceNum, 0.45);
  assert.equal(r!.candidate.event.id, "provider-event-1");
  assert.ok(r!.candidate.warnings.includes("primary-sibling-recovery"));
});

test("B. authorized families (moneyline / spread / total) eligible; unauthorized + invalid rejected", () => {
  // authorized: full-match spread / total
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate([sib("cond-sp", [0.44, 0.56], { sportsMarketType: "spreads" })]))!.candidate.market.conditionId, "cond-sp");
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate([sib("cond-tot", [0.46, 0.54], { sportsMarketType: "totals" })]))!.candidate.market.conditionId, "cond-tot");

  // unauthorized families rejected even with a perfect corridor price
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate([sib("cond-corners", [0.44, 0.56], { sportsMarketType: "total_corners" })])), null, "corners not authorized");
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate([sib("cond-ht", [0.45, 0.55], { sportsMarketType: "soccer_halftime_result" })])), null, "halftime not authorized");
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate([sib("cond-tht", [0.45, 0.55], { sportsMarketType: "soccer_first_half_team_totals" })])), null, "half-team-total not authorized");

  // fail-closed cases unchanged:
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate([sib("cond-lopsided", [0.96, 0.04])])), null, "outside corridor");
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate([{
    outcomes: ["Team A", "Draw", "Team B"], outcomePrices: [0.4, 0.3, 0.3],
    clobTokenIds: ["t1", "t2", "t3"], question: "Team A vs Team B", sportsMarketType: "moneyline", conditionId: "cond-3way",
  } as SiblingRaw])), null, "non-binary");
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate([sib("cond-notoken", [0.45, 0.55], { clobTokenIds: ["", ""] })])), null, "missing tokens");
  assert.equal(selectRecoverablePrimaryMarket(primaryCandidate(undefined)), null, "no sibling data");
});

test("C. deterministic pick — corridor outcome closest to 0.45 wins among authorized families", () => {
  const candidate = primaryCandidate([
    sib("cond-ht", [0.45, 0.55], { sportsMarketType: "soccer_halftime_result" }), // dist 0.00 but UNAUTHORIZED
    sib("cond-sp", [0.47, 0.53], { sportsMarketType: "spreads" }),                 // dist 0.02, authorized
    sib("cond-ml", [0.5, 0.5]),                                                    // dist 0.05, authorized
  ]);
  const r = selectRecoverablePrimaryMarket(candidate);
  assert.ok(r);
  assert.equal(r!.candidate.market.conditionId, "cond-sp");
});

test("D. sampleToCandidateMarket carries siblings; recovery consumes them", () => {
  const sample = {
    title: "Team A vs Team B", slug: "team-a-vs-team-b", gameId: "game-1", eventVolumeUsd: 100000,
    resolvedGameTimeIso: "2026-08-28T18:00:00.000Z", gameTimeSource: "test", gameTimeConfidence: "high",
    marketCount: 2, strategy: "markets-first",
    primaryMarketRaw: { outcomes: ["Team A", "Team B"], outcomePrices: [0.97, 0.03], clobTokenIds: ["p-tokA", "p-tokB"], question: "Team A vs Team B", sportsMarketType: "moneyline", conditionId: "cond-primary" },
    marketsRaw: [{ outcomes: ["Team A", "Team B"], outcomePrices: [0.45, 0.55], clobTokenIds: ["s-tokA", "s-tokB"], question: "Team A vs Team B", sportsMarketType: "moneyline", conditionId: "cond-ml-sibling" }],
  } as unknown as SportsDiscoverySample;

  const candidate = sampleToCandidateMarket(sample);
  assert.ok(candidate);
  const r = selectRecoverablePrimaryMarket(candidate!);
  assert.ok(r);
  assert.equal(r!.candidate.market.conditionId, "cond-ml-sibling");
});
