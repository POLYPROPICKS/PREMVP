import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectSoccerGroupCandidateMarkets,
  SOCCER_MULTI_MARKET_APPROVED_TYPES,
} from "../../lib/feed/discoverSportsMarkets";
import type { GameGroup, SportsMarketCandidate } from "../../lib/feed/types";

// EXPAND_ALLOWED_SOCCER_MARKET_UNIVERSE_V1 — minimum deterministic fixture:
// one soccer physical event carrying moneyline, spread, total, exact-score and
// first-to-score markets, exactly as required by the mission's test fixture.

function soccerMarket(overrides: {
  conditionId: string;
  sportsMarketType: string;
  question: string;
}): SportsMarketCandidate {
  return {
    id: overrides.conditionId,
    slug: `slug-${overrides.conditionId}`,
    question: overrides.question,
    conditionId: overrides.conditionId,
    active: true,
    closed: false,
    sportsMarketType: overrides.sportsMarketType,
    gameId: "game-1",
    outcomes: ["Yes", "No"],
    outcomePrices: [0.5, 0.5],
    shortOutcomes: ["Yes", "No"],
    clobTokenIds: [`${overrides.conditionId}-yes`, `${overrides.conditionId}-no`],
    volumeNum: 10_000,
    volume24hr: 10_000,
    volume24hrClob: 10_000,
    volumeClob: 10_000,
    liquidityNum: 5_000,
    liquidityClob: 5_000,
    bestBid: 0.5,
    bestAsk: 0.5,
    oneDayPriceChange: 0,
    oneHourPriceChange: 0,
    tagsText: [],
    raw: {
      events: [
        {
          id: "evt-1",
          providerSportCode: "epl",
          providerSportFamily: "soccer",
          providerSportSource: "structured_sports_tag",
          providerSportTagIds: ["100639"],
          providerSeriesIds: [],
        },
      ],
    },
  };
}

function baseballMarket(overrides: { conditionId: string; sportsMarketType: string; question: string }): SportsMarketCandidate {
  const m = soccerMarket(overrides);
  m.raw = {
    events: [{ id: "evt-mlb-1", providerSportCode: "mlb", providerSportFamily: "baseball", providerSportSource: "structured_sports_tag", providerSportTagIds: ["101"], providerSeriesIds: [] }],
  };
  return m;
}

function groupOf(markets: SportsMarketCandidate[], primaryMarket: SportsMarketCandidate | null = markets[0] ?? null): GameGroup {
  return {
    groupKey: "game:game-1",
    markets,
    gameId: "game-1",
    nestedEventId: "evt-1",
    teamAID: undefined,
    teamBID: undefined,
    resolvedGameTimeIso: "2026-09-10T18:00:00.000Z",
    gameTimeSource: "nestedEventStartTime",
    gameTimeConfidence: "high",
    eventVolumeUsd: 500_000,
    highestVolumeMarket: primaryMarket,
    primaryMarket,
  };
}

const moneyline = soccerMarket({ conditionId: "cid-moneyline", sportsMarketType: "moneyline", question: "Toulouse FC vs. Lille OSC: Match Winner" });
const spread = soccerMarket({ conditionId: "cid-spread", sportsMarketType: "spread", question: "Toulouse FC vs. Lille OSC: Spread" });
const total = soccerMarket({ conditionId: "cid-total", sportsMarketType: "totals", question: "Toulouse FC vs. Lille OSC: Total Goals O/U 2.5" });
const exactScore = soccerMarket({ conditionId: "cid-exact-score", sportsMarketType: "soccer_exact_score", question: "Exact Score: Toulouse FC 2 - 1 Lille OSC?" });
const firstToScore = soccerMarket({ conditionId: "cid-first-to-score", sportsMarketType: "soccer_first_to_score", question: "Toulouse FC to score first vs. Lille OSC?" });
const corners = soccerMarket({ conditionId: "cid-corners", sportsMarketType: "total_corners", question: "Toulouse FC vs. Lille OSC: Total Corners O/U 9.5" });

test("SOCCER_MULTI_MARKET_APPROVED_TYPES is exactly the 5-family universe", () => {
  assert.deepEqual(
    [...SOCCER_MULTI_MARKET_APPROVED_TYPES].sort(),
    ["moneyline", "soccer_exact_score", "soccer_first_to_score", "spread", "spreads", "total", "totals"].sort(),
  );
});

test("all 5 distinct soccer markets remain candidate identities before scoring when a newly-admitted family is present", () => {
  const group = groupOf([moneyline, spread, total, exactScore, firstToScore], moneyline);
  const selected = selectSoccerGroupCandidateMarkets(group);
  assert.deepEqual(
    selected.map((m) => m.conditionId).sort(),
    ["cid-exact-score", "cid-first-to-score", "cid-moneyline", "cid-spread", "cid-total"].sort(),
  );
});

test("exact score is not lost to representative-market collapse", () => {
  const group = groupOf([moneyline, exactScore], moneyline);
  const selected = selectSoccerGroupCandidateMarkets(group);
  assert.ok(selected.some((m) => m.conditionId === "cid-exact-score"));
});

test("first-to-score is not lost to representative-market collapse", () => {
  const group = groupOf([moneyline, firstToScore], moneyline);
  const selected = selectSoccerGroupCandidateMarkets(group);
  assert.ok(selected.some((m) => m.conditionId === "cid-first-to-score"));
});

test("an unapproved family (corners) is never implicitly admitted even alongside a newly-admitted family", () => {
  const group = groupOf([moneyline, exactScore, corners], moneyline);
  const selected = selectSoccerGroupCandidateMarkets(group);
  assert.equal(selected.some((m) => m.conditionId === "cid-corners"), false);
});

test("a soccer group with only pre-existing families (no exact score / first-to-score) keeps the single representative-market row unchanged", () => {
  const group = groupOf([moneyline, spread, total], moneyline);
  const selected = selectSoccerGroupCandidateMarkets(group);
  assert.deepEqual(selected, [moneyline]);
});

test("a non-soccer group is completely unaffected, even if it happened to carry an exact-score-labeled market", () => {
  const mlbMoneyline = baseballMarket({ conditionId: "cid-mlb-moneyline", sportsMarketType: "moneyline", question: "Yankees vs. Mets: Moneyline" });
  const mlbExactScoreLike = baseballMarket({ conditionId: "cid-mlb-exact-score", sportsMarketType: "soccer_exact_score", question: "irrelevant text" });
  const group = groupOf([mlbMoneyline, mlbExactScoreLike], mlbMoneyline);
  const selected = selectSoccerGroupCandidateMarkets(group);
  assert.deepEqual(selected, [mlbMoneyline]);
});

test("an empty group falls back to primaryMarket (defensive)", () => {
  const group = groupOf([], null);
  assert.deepEqual(selectSoccerGroupCandidateMarkets(group), []);
});
