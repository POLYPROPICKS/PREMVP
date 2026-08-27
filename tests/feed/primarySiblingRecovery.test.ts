import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sampleToCandidateMarket,
  selectRecoverablePrimarySibling,
} from "../../lib/feed/buildLandingCards";
import type { CandidateMarket } from "../../lib/feed/buildLandingCards";
import type { SportsDiscoverySample } from "../../lib/feed/types";

type SiblingRaw = NonNullable<SportsDiscoverySample["marketsRaw"]>[number];

function moneyline(conditionId: string, prices: number[], opts?: Partial<SiblingRaw>): SiblingRaw {
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
    event: {
      id: "provider-event-1",
      title: "Team A vs Team B",
      slug: "team-a-vs-team-b",
      active: true,
      closed: false,
      markets: [],
      category: "sports",
    },
    market: {
      // representative that is unusable (lopsided, outside corridor)
      id: "cond-primary",
      conditionId: "cond-primary",
      question: "Team A vs Team B",
      slug: "team-a-vs-team-b",
      active: true,
      closed: false,
      outcomes: ["Team A", "Team B"] as unknown as never,
      outcomePrices: [0.97, 0.03] as unknown as never,
      clobTokenIds: ["cond-primary-tokA", "cond-primary-tokB"] as unknown as never,
    },
    rejectionReasons: [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
    sportsMatchedKeyword: "sports-discovery",
    siblingMarketsRaw: siblings,
  };
}

test("A. recovers a same-event full-match sibling with valid identity and corridor outcome", () => {
  const candidate = primaryCandidate([
    moneyline("cond-primary", [0.97, 0.03]), // the representative itself — must be skipped
    moneyline("cond-ml-sibling", [0.45, 0.55]),
  ]);

  const recovered = selectRecoverablePrimarySibling(candidate);
  assert.ok(recovered, "expected a recovered sibling candidate");
  assert.equal(recovered!.market.conditionId, "cond-ml-sibling");
  assert.equal(recovered!.market.id, "cond-ml-sibling");
  // event identity is preserved from the authoritative physical event
  assert.equal(recovered!.event.id, "provider-event-1");
  assert.ok(recovered!.warnings.includes("primary-sibling-recovery"));
});

test("B. fails closed when no sibling satisfies product policy / identity / corridor", () => {
  // partial-event types with perfectly good corridor prices — still excluded
  const partialOnly = primaryCandidate([
    moneyline("cond-half", [0.45, 0.55], { sportsMarketType: "halftime" }),
    moneyline("cond-spread", [0.5, 0.5], { sportsMarketType: "spread" }),
    moneyline("cond-total", [0.48, 0.52], { sportsMarketType: "total" }),
  ]);
  assert.equal(selectRecoverablePrimarySibling(partialOnly), null);

  // full-match sibling but outcome outside the existing price corridor
  const outOfCorridor = primaryCandidate([moneyline("cond-ml-lopsided", [0.96, 0.04])]);
  assert.equal(selectRecoverablePrimarySibling(outOfCorridor), null);

  // full-match sibling but non-binary identity
  const nonBinary = primaryCandidate([
    {
      outcomes: ["Team A", "Draw", "Team B"],
      outcomePrices: [0.4, 0.3, 0.3],
      clobTokenIds: ["t1", "t2", "t3"],
      question: "Team A vs Team B",
      sportsMarketType: "moneyline",
      conditionId: "cond-3way",
    } as SiblingRaw,
  ]);
  assert.equal(selectRecoverablePrimarySibling(nonBinary), null);

  // full-match sibling but missing token identity
  const noTokens = primaryCandidate([
    moneyline("cond-ml-notoken", [0.45, 0.55], { clobTokenIds: ["", ""] }),
  ]);
  assert.equal(selectRecoverablePrimarySibling(noTokens), null);

  // no sibling data at all
  assert.equal(selectRecoverablePrimarySibling(primaryCandidate(undefined)), null);
});

test("C. policy preservation — a partial market is never chosen over a full-match sibling", () => {
  const candidate = primaryCandidate([
    moneyline("cond-1h", [0.45, 0.55], { sportsMarketType: "1st_half" }),
    moneyline("cond-ml-ok", [0.5, 0.5]),
  ]);
  const recovered = selectRecoverablePrimarySibling(candidate);
  assert.ok(recovered);
  assert.equal(recovered!.market.conditionId, "cond-ml-ok");
});

test("sampleToCandidateMarket carries sibling markets from the discovery sample", () => {
  const sample = {
    title: "Team A vs Team B",
    slug: "team-a-vs-team-b",
    gameId: "game-1",
    eventVolumeUsd: 100000,
    resolvedGameTimeIso: "2026-08-28T18:00:00.000Z",
    gameTimeSource: "test",
    gameTimeConfidence: "high",
    marketCount: 2,
    strategy: "markets-first",
    primaryMarketRaw: {
      outcomes: ["Team A", "Team B"],
      outcomePrices: [0.97, 0.03],
      clobTokenIds: ["p-tokA", "p-tokB"],
      question: "Team A vs Team B",
      sportsMarketType: "moneyline",
      conditionId: "cond-primary",
    },
    marketsRaw: [
      {
        outcomes: ["Team A", "Team B"],
        outcomePrices: [0.45, 0.55],
        clobTokenIds: ["s-tokA", "s-tokB"],
        question: "Team A vs Team B",
        sportsMarketType: "moneyline",
        conditionId: "cond-ml-sibling",
      },
    ],
  } as unknown as SportsDiscoverySample;

  const candidate = sampleToCandidateMarket(sample);
  assert.ok(candidate);
  assert.ok(Array.isArray(candidate!.siblingMarketsRaw));
  assert.equal(candidate!.siblingMarketsRaw!.length, 1);

  const recovered = selectRecoverablePrimarySibling(candidate!);
  assert.ok(recovered);
  assert.equal(recovered!.market.conditionId, "cond-ml-sibling");
});
