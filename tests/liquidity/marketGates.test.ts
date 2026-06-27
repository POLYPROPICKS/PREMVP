import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyVolumeGateFailure,
  computeMarketFamilyGate,
  computeMarketVolumeGate,
  detectOutrightOrFuture,
  detectPropMarket,
  enforcePerSportCaps,
  enforcePerSportFamilyCaps,
  isVolumeGatePassed,
  normalizeMarketFamily,
  normalizeSport,
} from "../../lib/liquidity/marketGates";
import type { WatchlistCandidate } from "../../lib/liquidity/types";

test("normalizeSport across sports and UNKNOWN", () => {
  assert.equal(normalizeSport("EPL"), "soccer");
  assert.equal(normalizeSport("Soccer"), "soccer");
  assert.equal(normalizeSport("NBA"), "basketball");
  assert.equal(normalizeSport("MLB"), "baseball");
  assert.equal(normalizeSport("ATP"), "tennis");
  assert.equal(normalizeSport("NHL"), "hockey");
  assert.equal(normalizeSport("Cricket"), "cricket");
  assert.equal(normalizeSport("Formula 1"), "racing");
  assert.equal(normalizeSport("CS2"), "esports");
  assert.equal(normalizeSport("NFL"), "american_football");
  assert.equal(normalizeSport("underwater basket weaving"), "UNKNOWN");
  assert.equal(normalizeSport(null), "UNKNOWN");
});

test("normalizeMarketFamily aliases", () => {
  assert.equal(normalizeMarketFamily("match_winner"), "moneyline");
  assert.equal(normalizeMarketFamily("full_match_winner"), "moneyline");
  assert.equal(normalizeMarketFamily("game_winner"), "moneyline");
  assert.equal(normalizeMarketFamily("winner"), "moneyline");
  assert.equal(normalizeMarketFamily("handicap"), "spread");
  assert.equal(normalizeMarketFamily("point_spread"), "spread");
  assert.equal(normalizeMarketFamily("run_line"), "spread");
  assert.equal(normalizeMarketFamily("puck_line"), "spread");
  assert.equal(normalizeMarketFamily("over_under"), "total");
  assert.equal(normalizeMarketFamily("match_total"), "total");
  assert.equal(normalizeMarketFamily("game_total"), "total");
  assert.equal(normalizeMarketFamily("tournament_winner"), "UNKNOWN");
  assert.equal(normalizeMarketFamily("weird_market"), "UNKNOWN");
});

test("detectOutrightOrFuture and detectPropMarket", () => {
  assert.equal(detectOutrightOrFuture("tournament_winner"), true);
  assert.equal(detectOutrightOrFuture("season winner"), true);
  assert.equal(detectOutrightOrFuture("outright"), true);
  assert.equal(detectOutrightOrFuture("match_winner"), false);
  assert.equal(detectPropMarket("player_prop"), true);
  assert.equal(detectPropMarket("anytime_scorer"), true);
  assert.equal(detectPropMarket("moneyline"), false);
});

test("computeMarketFamilyGate classifies supported and excluded", () => {
  assert.deepEqual(computeMarketFamilyGate("moneyline"), { family: "moneyline", status: "SUPPORTED" });
  assert.equal(computeMarketFamilyGate("outright").status, "EXCLUDED_OUTRIGHT_FUTURE");
  assert.equal(computeMarketFamilyGate("player_prop").status, "EXCLUDED_PROP");
  assert.equal(computeMarketFamilyGate("correct_score").status, "EXCLUDED_EXACT_SCORE");
  assert.equal(computeMarketFamilyGate("politics").status, "EXCLUDED_NOVELTY_POLITICS");
  assert.equal(computeMarketFamilyGate("mystery").status, "EXCLUDED_UNKNOWN_FAMILY");
});

test("computeMarketVolumeGate hard threshold", () => {
  assert.equal(computeMarketVolumeGate({ volumeUsd: 50000 }).status, "PASS");
  assert.equal(computeMarketVolumeGate({ volumeUsd: 5000 }).status, "FAIL_BELOW_THRESHOLD");
  assert.equal(computeMarketVolumeGate({ volumeUsd: null }).status, "FAIL_MISSING_VOLUME");
  assert.equal(
    computeMarketVolumeGate({ volumeUsd: 50000, volumeAgeMinutes: 5000 }).status,
    "FAIL_STALE_VOLUME",
  );
  const ev = computeMarketVolumeGate({ volumeUsd: 50000, volumeScope: "event_level_not_market_level" });
  assert.equal(ev.status, "PASS_EVENT_LEVEL");
  assert.equal(isVolumeGatePassed(ev.status), true);
  assert.equal(isVolumeGatePassed("FAIL_BELOW_THRESHOLD"), false);
  assert.equal(classifyVolumeGateFailure("FAIL_BELOW_THRESHOLD"), "volume_below_threshold");
});

function cand(overrides: Partial<WatchlistCandidate>): WatchlistCandidate {
  return {
    conditionId: "c",
    tokenId: "t",
    opposingTokenId: null,
    eventSlug: null,
    marketSlug: null,
    selectedOutcome: null,
    rawSport: null,
    normalizedSport: "soccer",
    sportSource: null,
    rawSourceCategory: null,
    marketType: "moneyline",
    marketTypeSource: "researchContext.marketType",
    rawMarketFamily: "moneyline",
    normalizedMarketFamily: "moneyline",
    marketFamilyGate: "SUPPORTED",
    marketFamilyGateReason: null,
    isOutrightOrFuture: false,
    isProp: false,
    league: null,
    matchFamilyKey: null,
    gameStartIso: null,
    selectedPrice: null,
    volumeUsd: 10000,
    volumeSource: "source_column",
    volumeScope: "market_level",
    volumeGate: "PASS",
    volumeGateReason: null,
    volumeGateDb: "passed",
    priorityScore: 1,
    sourceTable: null,
    sourceRowId: null,
    sourceFormulaVersion: null,
    sourceScope: null,
    ...overrides,
  };
}

test("enforcePerSportCaps truncates per sport and isolates UNKNOWN", () => {
  const candidates = [
    cand({ tokenId: "a", normalizedSport: "soccer", priorityScore: 3 }),
    cand({ tokenId: "b", normalizedSport: "soccer", priorityScore: 2 }),
    cand({ tokenId: "c", normalizedSport: "soccer", priorityScore: 1 }),
    cand({ tokenId: "u", normalizedSport: "UNKNOWN", priorityScore: 9 }),
  ];
  const { kept, droppedByCap } = enforcePerSportCaps(candidates, {
    sportTokenLimit: 2,
    unknownSportLimit: 0,
  });
  const keptIds = kept.map((c) => c.tokenId).sort();
  assert.deepEqual(keptIds, ["a", "b"]);
  assert.ok(droppedByCap.some((c) => c.tokenId === "u"));
  assert.ok(droppedByCap.some((c) => c.tokenId === "c"));
});

test("enforcePerSportFamilyCaps truncates per (sport,family)", () => {
  const candidates = [
    cand({ tokenId: "m1", normalizedMarketFamily: "moneyline", priorityScore: 3 }),
    cand({ tokenId: "m2", normalizedMarketFamily: "moneyline", priorityScore: 2 }),
    cand({ tokenId: "s1", normalizedMarketFamily: "spread", priorityScore: 5 }),
  ];
  const { kept } = enforcePerSportFamilyCaps(candidates, {
    sportFamilyTokenLimit: 1,
    unknownFamilyLimit: 0,
  });
  const keptIds = kept.map((c) => c.tokenId).sort();
  assert.deepEqual(keptIds, ["m1", "s1"]);
});
