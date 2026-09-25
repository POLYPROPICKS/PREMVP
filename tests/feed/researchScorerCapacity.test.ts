import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWideResearchBySportFamilyCounters,
  selectResearchMarketsForScoring,
} from "../../lib/feed/buildLandingCards";
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

test("the historical fixed limit is exactly what drops eligible events above the ceiling", () => {
  const universe = wideUniverse(500);
  const selected = selectResearchMarketsForScoring(universe, new Set(), 200, 0);

  assert.equal(eligibleEvents(universe), 500);
  assert.equal(selected.length, 200);
  assert.equal(eligibleEvents(universe) - eligibleEvents(selected), 300);
});

test("with no fixed ceiling every scorer-eligible event AND every distinct sibling identity is captured", () => {
  const universe = wideUniverse(500);
  const selected = selectResearchMarketsForScoring(universe, new Set(), null, 0);

  // TERMINAL INVARIANT: capacity_excluded_due_only_to_fixed_limit === 0
  assert.equal(eligibleEvents(selected), eligibleEvents(universe));
  assert.equal(eligibleEvents(universe) - eligibleEvents(selected), 0);
  // RESTORE_EVENT_SIBLING_RESEARCH_OPPORTUNITY_SET_V1: every distinct sibling
  // identity (2 per event) survives — no per-physical-event collapse.
  assert.equal(selected.length, 1000);
  assert.equal(
    new Set(selected.map((row) => `${row.conditionId}::${row.selectedTokenId}`)).size,
    1000,
  );
});

test("incident-sized multi-market universe captures every distinct sibling identity, not one representative per event", () => {
  const identityCount = 23_543;
  const eventCount = 343;
  const rows: ResearchNestedMarket[] = [];
  for (let i = 0; i < identityCount; i++) {
    const eventId = `incident-event-${String(i % eventCount).padStart(3, "0")}`;
    rows.push(research(eventId, `incident-condition-${String(i).padStart(5, "0")}`));
  }

  const selected = selectResearchMarketsForScoring(rows, new Set(), null, 0);
  assert.equal(rows.length, identityCount);
  assert.equal(eligibleEvents(rows), eventCount);
  // Full sibling opportunity set, not collapsed to one hidden representative.
  assert.equal(selected.length, identityCount);
  assert.equal(eligibleEvents(selected), eventCount);
  assert.equal(
    new Set(selected.map((row) => `${row.conditionId}::${row.selectedTokenId}`)).size,
    identityCount,
    "condition_id + selected_token_id identity dedupe still holds",
  );
  assert.deepEqual(buildWideResearchBySportFamilyCounters(rows).soccer, {
    DISCOVERY_RESEARCH_ELIGIBLE_MARKET_N: identityCount,
    DISCOVERY_RESEARCH_ELIGIBLE_TOKEN_N: identityCount,
    WIDE_SCORER_ATTEMPT_N: 0,
    WIDE_SCORE_50PLUS_N: 0,
    WIDE_GSP_PERSISTED_N: 0,
    BUDGET_EXHAUSTED_N: 0,
  });
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
  // wideUniverse(250) yields 2 distinct sibling identities per event (500 total).
  assert.equal(selected.length, 500);
  assert.equal(eligibleEvents(selected), 250);
});

test("distinct sibling market types from one physical event all survive simultaneously", () => {
  const eventId = "multi-sport-event";
  const siblings = [
    research(eventId, "cond-moneyline", "soccer", { marketId: "m-moneyline", sportsMarketType: "moneyline" }),
    research(eventId, "cond-spread", "soccer", { marketId: "m-spread", sportsMarketType: "spreads" }),
    research(eventId, "cond-totals", "soccer", { marketId: "m-totals", sportsMarketType: "totals" }),
    research(eventId, "cond-corners", "soccer", { marketId: "m-corners", sportsMarketType: "total_corners" }),
    research(eventId, "cond-exact-score", "soccer", { marketId: "m-exact-score", sportsMarketType: "exact_score" }),
  ];

  const selected = selectResearchMarketsForScoring(siblings, new Set(), null, 0);
  assert.deepEqual(
    new Set(selected.map((row) => row.marketId)),
    new Set(["m-moneyline", "m-spread", "m-totals", "m-corners", "m-exact-score"]),
    "every sibling market type from the same physical event is a distinct research candidate",
  );
  // Exact Score remains separately identifiable — its own market id/type, not
  // merged into or excluded because siblings are now persisted alongside it.
  const exactScoreRow = selected.find((row) => row.marketId === "m-exact-score");
  assert.ok(exactScoreRow);
  assert.equal(exactScoreRow?.sportsMarketType, "exact_score");
});

test("condition_id + selected_token_id duplicates are deduped even when siblings are otherwise allowed", () => {
  const eventId = "dup-event";
  const duplicateA = research(eventId, "cond-dup", "soccer", { marketId: "m-dup-a" });
  const duplicateB = research(eventId, "cond-dup", "soccer", { marketId: "m-dup-b" });
  const distinctSibling = research(eventId, "cond-other", "soccer", { marketId: "m-other" });

  const selected = selectResearchMarketsForScoring(
    [duplicateA, duplicateB, distinctSibling],
    new Set(),
    null,
    0,
  );
  assert.equal(
    selected.filter((row) => row.conditionId === "cond-dup" && row.selectedTokenId === duplicateA.selectedTokenId).length,
    1,
    "exact condition_id + selected_token_id identity is never duplicated",
  );
  assert.ok(selected.some((row) => row.marketId === "m-other"));
});

test("finite limit deterministically spreads breadth across events before spending on extra siblings", () => {
  const eventId = "wide-siblings-event";
  const siblings = [
    research(eventId, "cond-1", "soccer", { marketId: "m-1" }),
    research(eventId, "cond-2", "soccer", { marketId: "m-2" }),
    research(eventId, "cond-3", "soccer", { marketId: "m-3" }),
  ];
  const otherEvent = research("other-event", "cond-solo", "soccer", { marketId: "m-solo" });
  const universe = [...siblings, otherEvent];

  const selectedTwo = selectResearchMarketsForScoring(universe, new Set(), 2, 0);
  assert.deepEqual(
    new Set(selectedTwo.map((row) => row.eventId)),
    new Set([eventId, "other-event"]),
    "breadth across physical events is preferred before extra siblings within one event",
  );

  const runA = selectResearchMarketsForScoring(universe, new Set(), 2, 3);
  const runB = selectResearchMarketsForScoring(universe, new Set(), 2, 3);
  assert.deepEqual(runA, runB, "selection is deterministic for a fixed universe/limit/rotationOffset");
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
