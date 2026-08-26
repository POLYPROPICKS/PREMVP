import { test } from "node:test";
import assert from "node:assert/strict";

import { selectResearchMarketsForScoring } from "../../lib/feed/buildLandingCards";
import { scoreOwnershipForSportFamily } from "../../lib/feed/sportScoreOwnership";
import type { ResearchNestedMarket } from "../../lib/feed/types";

// P1A regression: the fixed 200-market research-scorer selection ceiling silently
// discarded every scorer-eligible event beyond the 200th (observed production run:
// 781 eligible -> 200 selected -> 581 lost purely to the constant).
//
// Run with: node --import tsx --test tests/feed/researchScorerCapacity.test.ts

const START = "2026-08-10T19:00:00.000Z";

function research(
  eventId: string,
  conditionId: string,
  family = "soccer",
  overrides: Partial<ResearchNestedMarket> = {},
): ResearchNestedMarket {
  return {
    eventId,
    eventTitle: "Display text deliberately carries no sport name",
    eventSlug: `event-${eventId}`,
    eventStartIso: START,
    marketId: `market-${conditionId}`,
    marketQuestion: "Will side A win?",
    marketEndIso: START,
    marketFamily: "Display League",
    leagueName: "Display League",
    sportsMarketType: "moneyline",
    familySource: "provider_structured_sports_metadata",
    conditionId,
    selectedTokenId: `token-${conditionId}`,
    opposingTokenId: `opposing-${conditionId}`,
    selectedPriceNum: 0.4,
    opposingPriceNum: 0.6,
    publicFeedExposed: false,
    selectedOutcomeName: "A",
    opposingOutcomeName: "B",
    providerSportCode: family === "soccer" ? "ucl" : family,
    providerSportFamily: family,
    providerSportSource: "structured_sports_tag",
    providerSportTagIds: ["1", `family-${family}`],
    providerSeriesIds: [`series-${family}`],
    scoreOwnership: scoreOwnershipForSportFamily(family),
    ...overrides,
  };
}

/** 500 eligible events, two markets each — deliberately above the old 200 ceiling. */
function wideUniverse(eventCount: number): ResearchNestedMarket[] {
  const rows: ResearchNestedMarket[] = [];
  for (let i = 0; i < eventCount; i++) {
    const e = `event-${String(i).padStart(4, "0")}`;
    rows.push(research(e, `${e}-m1`));
    rows.push(research(e, `${e}-m2`, "soccer", {
      marketId: `market-${e}-m2`,
      sportsMarketType: "moneyline",
    }));
  }
  return rows;
}

const eligibleEvents = (rows: readonly ResearchNestedMarket[]) =>
  new Set(rows.map((row) => `${row.eventId}::${row.eventStartIso}`)).size;

test("the historical fixed limit is exactly what dropped eligible events above the ceiling", () => {
  const universe = wideUniverse(500);
  const selected = selectResearchMarketsForScoring(universe, new Set(), 200, 0);

  assert.equal(eligibleEvents(universe), 500);
  assert.equal(selected.length, 200);
  const capacityExcluded = eligibleEvents(universe) - eligibleEvents(selected);
  assert.equal(capacityExcluded, 300, "fixed limit is the sole cause of this loss");
});

test("with no fixed ceiling every scorer-eligible event receives a scoring opportunity", () => {
  const universe = wideUniverse(500);
  const selected = selectResearchMarketsForScoring(universe, new Set(), null, 0);

  // TERMINAL INVARIANT: capacity_excluded_due_only_to_fixed_limit === 0
  assert.equal(eligibleEvents(selected), eligibleEvents(universe));
  assert.equal(eligibleEvents(universe) - eligibleEvents(selected), 0);
  // One canonical market per event; no duplicate identities.
  assert.equal(selected.length, 500);
  assert.equal(
    new Set(selected.map((row) => `${row.conditionId}::${row.selectedTokenId}`)).size,
    500,
  );
});

test("unbounded selection still excludes unsupported sports and keeps public rows", () => {
  const universe = [
    ...wideUniverse(250),
    research("unsupported-a", "u-1", "table-tennis"),
    research("unsupported-b", "u-2", "rugby-sevens"),
  ];
  const publicRow = universe[0];
  const publicSet = new Set([`${publicRow.conditionId}::${publicRow.selectedTokenId}`]);

  const selected = selectResearchMarketsForScoring(universe, publicSet, null, 7);

  assert.ok(selected.every((row) => row.scoreOwnership === "SUPPORTED_BY_SCORE_MODEL"));
  assert.ok(
    selected.some(
      (row) => `${row.conditionId}::${row.selectedTokenId}` === `${publicRow.conditionId}::${publicRow.selectedTokenId}`,
    ),
    "public-feed-exposed rows are never dropped",
  );
  assert.equal(eligibleEvents(selected), 250);
});

test("rotation offset does not change coverage when the ceiling is removed", () => {
  const universe = wideUniverse(300);
  const a = selectResearchMarketsForScoring(universe, new Set(), null, 0);
  const b = selectResearchMarketsForScoring(universe, new Set(), null, 137);

  assert.equal(eligibleEvents(a), 300);
  assert.equal(eligibleEvents(b), 300);
  assert.deepEqual(
    new Set(a.map((row) => row.conditionId)),
    new Set(b.map((row) => row.conditionId)),
    "no event is reachable only at a particular 30-minute rotation bucket",
  );
});
