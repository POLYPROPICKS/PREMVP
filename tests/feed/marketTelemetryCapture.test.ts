import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMarketTelemetryAtObservation,
  ODDS_DECIMAL_SEMANTIC,
  MARKET_TELEMETRY_CAPTURE_SOURCE,
  GAMMA_BBO_SEMANTIC,
} from "../../lib/feed/marketTelemetry";
import { sampleToCandidateMarket, sampleToCandidateMarkets } from "../../lib/feed/buildLandingCards";
import type { SportsDiscoverySample } from "../../lib/feed/types";

test("gamma market-level BBO survives with explicit non-token semantics", () => {
  const telemetry = buildMarketTelemetryAtObservation(
    { bestBid: 0.52, bestAsk: 0.56 },
    0.54
  );
  assert.equal(telemetry.v, "v1");
  assert.equal(telemetry.gamma_market_best_bid_num, 0.52);
  assert.equal(telemetry.gamma_market_best_ask_num, 0.56);
  assert.equal(telemetry.gamma_market_spread_num, 0.04);
  assert.equal(telemetry.gamma_bbo_semantic, GAMMA_BBO_SEMANTIC);
  assert.notEqual(GAMMA_BBO_SEMANTIC.includes("token_authority"), false);
  assert.equal(telemetry.odds_decimal_num, 1.8519);
  assert.equal(telemetry.odds_decimal_semantic, ODDS_DECIMAL_SEMANTIC);
  assert.equal(telemetry.capture_source, MARKET_TELEMETRY_CAPTURE_SOURCE);
});

test("gamma spread is derived only from one same-snapshot BBO pair and never invented", () => {
  assert.equal(buildMarketTelemetryAtObservation({ bestBid: 0.56, bestAsk: 0.52 }, 0.54).gamma_market_spread_num, null, "bestAsk < bestBid is not a quote");
  assert.equal(buildMarketTelemetryAtObservation({ bestBid: 0.52 }, 0.54).gamma_market_spread_num, null);
  assert.equal(buildMarketTelemetryAtObservation({}, 0.54).gamma_market_spread_num, null);
});

test("missing gamma BBO stays null and no token-level BBO is claimed", () => {
  const telemetry = buildMarketTelemetryAtObservation({}, 0.6);
  assert.equal(telemetry.gamma_market_best_bid_num, null);
  assert.equal(telemetry.gamma_market_best_ask_num, null);
  assert.equal(telemetry.gamma_market_spread_num, null);
  assert.equal(telemetry.gamma_bbo_semantic, GAMMA_BBO_SEMANTIC);
  assert.equal(telemetry.odds_decimal_num, 1.6667);
});

test("probability outside (0,1) never produces decimal odds", () => {
  assert.equal(buildMarketTelemetryAtObservation({}, 0).odds_decimal_num, null);
  assert.equal(buildMarketTelemetryAtObservation({}, 1).odds_decimal_num, null);
  assert.equal(buildMarketTelemetryAtObservation({}, -0.2).odds_decimal_num, null);
});

function realShapedSample(args: { bestBid: number | null; bestAsk: number | null; siblingBestBid?: number | null; siblingBestAsk?: number | null }): SportsDiscoverySample {
  return {
    title: "Team A vs. Team B",
    slug: "team-a-vs-team-b",
    eventVolumeUsd: 50000,
    resolvedGameTimeIso: "2026-09-26T18:00:00.000Z",
    gameTimeSource: "gamma-event-enddate",
    gameTimeConfidence: "medium",
    marketCount: 2,
    strategy: "markets-first",
    leagueName: "Soccer",
    primaryMarketRaw: {
      outcomes: ["Team A", "Team B"],
      outcomePrices: [0.54, 0.46],
      clobTokenIds: ["0xtok1", "0xtok2"],
      question: "Team A vs. Team B",
      sportsMarketType: "moneyline",
      conditionId: "0xcond1",
      volume24hr: 12000,
      providerMarketId: "qm-1",
      bestBid: args.bestBid,
      bestAsk: args.bestAsk,
    },
    marketsRaw: [
      {
        outcomes: ["Team A", "Team B"],
        outcomePrices: [0.3, 0.7],
        clobTokenIds: ["0xtok3", "0xtok4"],
        question: "Team A vs. Team B (total)",
        sportsMarketType: "total",
        conditionId: "0xcond3",
        volume24hr: 3000,
        bestBid: args.siblingBestBid ?? null,
        bestAsk: args.siblingBestAsk ?? null,
      },
    ],
  };
}

test("opposite-outcome fan-out shares gamma market BBO and labels it explicitly as market-level, never selected-token BBO", () => {
  const candidates = sampleToCandidateMarkets(
    realShapedSample({ bestBid: 0.52, bestAsk: 0.56, siblingBestBid: 0.3, siblingBestAsk: 0.31 })
  );
  const primaryIdentityCandidates = candidates.filter((c) => c.market.conditionId === "0xcond1");
  assert.ok(primaryIdentityCandidates.length >= 1, "primary candidate built from a real-shaped sample");
  for (const candidate of primaryIdentityCandidates) {
    const telemetry = buildMarketTelemetryAtObservation(candidate.market, 0.54);
    assert.equal(telemetry.gamma_market_best_bid_num, 0.52);
    assert.equal(telemetry.gamma_market_best_ask_num, 0.56);
    assert.equal(telemetry.gamma_bbo_semantic, GAMMA_BBO_SEMANTIC);
    assert.equal(
      GAMMA_BBO_SEMANTIC.includes("not_token_authority"),
      true,
      "shared market-level BBO can never be presented as selected-token BBO"
    );
  }
  assert.ok(
    primaryIdentityCandidates.length > 1 || primaryIdentityCandidates[0].forcedOutcome !== undefined,
    "fan-out actually produced independent outcome identities sharing one gamma quote"
  );
});

test("real-shaped primary sample: gamma bid/ask reach the telemetry carrier verbatim", () => {
  const candidate = sampleToCandidateMarket(
    realShapedSample({ bestBid: 0.52, bestAsk: 0.56 })
  );
  assert.ok(candidate, "primary candidate built from a real-shaped sample");
  const telemetry = buildMarketTelemetryAtObservation(candidate.market, 0.54);
  assert.equal(telemetry.gamma_market_best_bid_num, 0.52);
  assert.equal(telemetry.gamma_market_best_ask_num, 0.56);
});

test("real-shaped sibling market: gamma bid/ask survive the fan-out candidate rebuild", () => {
  const candidates = sampleToCandidateMarkets(
    realShapedSample({ bestBid: 0.52, bestAsk: 0.56, siblingBestBid: 0.3, siblingBestAsk: 0.31 })
  );
  const sibling = candidates.find((c) => c.market.conditionId === "0xcond3");
  assert.ok(sibling, "authorized sibling exists in fan-out output");
  assert.equal(buildMarketTelemetryAtObservation(sibling.market, null).gamma_market_best_bid_num, 0.3);
  assert.equal(buildMarketTelemetryAtObservation(sibling.market, null).gamma_market_best_ask_num, 0.31);
});

test("missing gamma bid/ask in the real path stays null and never blocks eligibility", () => {
  const candidate = sampleToCandidateMarket(
    realShapedSample({ bestBid: null, bestAsk: null })
  );
  assert.ok(candidate);
  const telemetry = buildMarketTelemetryAtObservation(candidate.market, 0.54);
  assert.equal(telemetry.gamma_market_best_bid_num, null);
  assert.equal(telemetry.gamma_market_best_ask_num, null);
  assert.equal(telemetry.gamma_market_spread_num, null);
  assert.equal(telemetry.odds_decimal_num, 1.8519);
});
