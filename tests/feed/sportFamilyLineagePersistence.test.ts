import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildS2DirectProviderLineage,
  s2DirectSportBucket,
} from "../../lib/feed/buildLandingCards";
import { scoreOwnershipForSportFamily } from "../../lib/feed/sportScoreOwnership";
import type { ResearchNestedMarket } from "../../lib/feed/types";

// PERSIST_CANONICAL_SPORT_FAMILY_V1 regression:
//
// Production discrepancy this mission repairs — canonical soccer source
// identities (soccer.DISCOVERY_RESEARCH_ELIGIBLE_TOKEN_N) = 3923, but
// persisted rows keyed on the lossy display field league='Soccer' exposed
// only 340 rows / 17 physical events. providerSportFamily is the canonical
// sport authority end to end; league/marketFamily are display/taxonomy
// dimensions only and must never be substituted for it.
//
// Run with: node --import tsx --test tests/feed/sportFamilyLineagePersistence.test.ts

const START = "2026-08-10T19:00:00.000Z";

function research(overrides: Partial<ResearchNestedMarket> = {}): ResearchNestedMarket {
  return {
    eventId: "event-1",
    eventTitle: "Display text deliberately carries no sport name",
    eventSlug: "event-event-1",
    eventStartIso: START,
    marketId: "market-cond-1",
    marketQuestion: "Will side A win?",
    marketEndIso: START,
    marketFamily: "Sports",
    leagueName: null,
    sportsMarketType: "moneyline",
    familySource: "provider_structured_sports_metadata",
    conditionId: "cond-1",
    selectedTokenId: "token-cond-1",
    opposingTokenId: "opposing-cond-1",
    selectedPriceNum: 0.4,
    opposingPriceNum: 0.6,
    publicFeedExposed: false,
    selectedOutcomeName: "A",
    opposingOutcomeName: "B",
    providerSportCode: "ucl",
    providerSportFamily: "soccer",
    providerSportSource: "structured_sports_tag",
    providerSportTagIds: ["1", "family-soccer"],
    providerSeriesIds: ["series-soccer"],
    scoreOwnership: scoreOwnershipForSportFamily("soccer"),
    ...overrides,
  };
}

test("S2-direct lineage carries providerSportFamily unchanged even when league is generic 'Sports' and leagueName is null", () => {
  const rm = research();

  const lineage = buildS2DirectProviderLineage(rm);

  assert.equal(lineage.providerSportFamily, "soccer");
  assert.equal(lineage.providerSportCode, "ucl");
  assert.equal(lineage.providerSportSource, "structured_sports_tag");
  assert.deepEqual(lineage.providerSportTagIds, ["1", "family-soccer"]);
  assert.deepEqual(lineage.providerSeriesIds, ["series-soccer"]);
  assert.equal(lineage.providerEventId, "event-1");
  assert.equal(lineage.providerMarketId, "market-cond-1");

  // league is display/taxonomy only and may legitimately remain non-canonical
  // (rm.leagueName ?? rm.marketFamily === "Sports" !== "Soccer") without
  // affecting the persisted providerSportFamily identity above.
  assert.notEqual(rm.leagueName ?? rm.marketFamily, "Soccer");
});

test("fireModel.modelCandidate.sportBucket uses canonical providerSportFamily when available", () => {
  const rm = research();
  assert.equal(s2DirectSportBucket(rm), "soccer");
});

test("non-soccer family remains distinguishable and is not coerced to soccer", () => {
  const nba = research({
    eventId: "event-2",
    conditionId: "cond-2",
    marketFamily: "Sports",
    leagueName: null,
    providerSportCode: "nba",
    providerSportFamily: "basketball",
    providerSportTagIds: ["2", "family-basketball"],
    providerSeriesIds: ["series-basketball"],
    scoreOwnership: scoreOwnershipForSportFamily("basketball"),
  });

  const lineage = buildS2DirectProviderLineage(nba);
  assert.equal(lineage.providerSportFamily, "basketball");
  assert.notEqual(lineage.providerSportFamily, "soccer");
  assert.equal(s2DirectSportBucket(nba), "basketball");
});

test("sportBucket falls back to league/marketFamily only when providerSportFamily is absent", () => {
  const rm = research({
    providerSportFamily: undefined as unknown as string,
    leagueName: "Display League",
  });
  assert.equal(s2DirectSportBucket(rm), "Display League");
});
