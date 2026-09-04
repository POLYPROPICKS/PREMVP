import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectRecoverablePrimaryMarket,
  resolvePhysicalMatchIdentity,
} from "../../lib/feed/buildLandingCards";
import type { CandidateMarket } from "../../lib/feed/buildLandingCards";
import type { ResearchNestedMarket } from "../../lib/feed/types";
import {
  classifyMarketText,
  resolveMarketAnchorDecision,
} from "../../lib/contur3/taxonomy";

// MISSION: align physical-event recovery + Contract A on the Founder-authorized
// contour — moneyline / spreads / full-match totals, PLUS soccer_exact_score /
// soccer_first_to_score as of EXPAND_ALLOWED_SOCCER_MARKET_UNIVERSE_V1. Corners,
// halftime, half/team-half markets, both-teams-to-score and other scorer
// markets stay outside. Contract A must recognise a terse full-match total
// ("O/U 2.5").
//
// Run: node --import tsx --test tests/feed/primaryPhysicalEventRecovery.test.ts

const DAY = "2026-08-28";
const START = `${DAY}T19:00:00.000Z`;

function exactScoreCandidate(opts?: { title?: string; providerEventId?: string; siblings?: unknown[] }): CandidateMarket {
  const market: Record<string, unknown> = {
    id: "cond-xs", conditionId: "cond-xs",
    question: opts?.title ?? "Exact Score: Wrexham AFC 2 - 3 Birmingham City FC?",
    slug: "wrexham-birmingham-exact-score", active: true, closed: false,
    outcomes: ["Yes", "No"], outcomePrices: [0.019, 0.981],
    clobTokenIds: ["cond-xs-yes", "cond-xs-no"],
  };
  market._parentMeta = {
    id: opts?.providerEventId ?? "851822", providerEventId: opts?.providerEventId ?? "851822",
    title: opts?.title ?? "Exact Score: Wrexham AFC 2 - 3 Birmingham City FC?",
    slug: "wrexham-birmingham-exact-score", startDate: START,
  };
  return {
    event: { id: opts?.providerEventId ?? "851822", title: market.question as string, slug: "wrexham-birmingham-exact-score", active: true, closed: false, markets: [], endDate: START, category: "sports" },
    market: market as unknown as CandidateMarket["market"],
    rejectionReasons: [], warnings: [], isSportsRelated: true, isEnded: false,
    sportsMatchedKeyword: "sports-discovery",
    siblingMarketsRaw: (opts?.siblings as CandidateMarket["siblingMarketsRaw"]) ?? [],
  };
}

function rnm(o: Partial<ResearchNestedMarket> & Pick<ResearchNestedMarket, "eventId" | "conditionId" | "selectedTokenId" | "opposingTokenId" | "selectedPriceNum" | "sportsMarketType">): ResearchNestedMarket {
  return {
    eventTitle: "Wrexham AFC vs. Birmingham City FC", eventSlug: "wrexham-birmingham", eventStartIso: START, gameStartTimeIso: START,
    marketId: `mkt-${o.conditionId}`, marketQuestion: "Wrexham AFC vs. Birmingham City FC", marketEndIso: START,
    marketFamily: "Soccer", leagueName: "EFL Championship", familySource: "provider_structured_sports_metadata",
    opposingPriceNum: Number((1 - o.selectedPriceNum).toFixed(4)), publicFeedExposed: false,
    selectedOutcomeName: "Wrexham AFC", opposingOutcomeName: "Birmingham City FC",
    providerSportCode: "efl", providerSportFamily: "soccer", providerSportSource: "structured_sports_tag",
    providerSportTagIds: ["1"], providerSeriesIds: [], scoreOwnership: "SUPPORTED_BY_SCORE_MODEL",
    ...o,
  } as ResearchNestedMarket;
}

// ── 1. cross-provider-event MONEYLINE ────────────────────────────────────────
test("1. cross-provider-event MONEYLINE recovery still works", () => {
  const r = selectRecoverablePrimaryMarket(exactScoreCandidate(), [
    rnm({ eventId: "851801", conditionId: "cond-ml", selectedTokenId: "ml-a", opposingTokenId: "ml-b", selectedPriceNum: 0.445, sportsMarketType: "moneyline", marketQuestion: "Will Wrexham AFC win on 2026-08-28?" }),
  ]);
  assert.ok(r);
  assert.equal(r!.recoverySource, "cross-provider-event");
  assert.equal(r!.candidate.market.conditionId, "cond-ml");
  assert.equal(r!.forcedOutcome.selectedTokenId, "ml-a");
});

// ── 2. cross-provider-event SPREAD ───────────────────────────────────────────
test("2. cross-provider-event SPREAD recovery works", () => {
  const r = selectRecoverablePrimaryMarket(exactScoreCandidate(), [
    rnm({ eventId: "851815", conditionId: "cond-sp", selectedTokenId: "sp-a", opposingTokenId: "sp-b", selectedPriceNum: 0.44, sportsMarketType: "spreads", marketQuestion: "Spread: Wrexham AFC (-0.5)" }),
  ]);
  assert.ok(r);
  assert.equal(r!.candidate.market.conditionId, "cond-sp");
  assert.equal(r!.forcedOutcome.selectedPriceNum, 0.44);
});

// ── 3. cross-provider-event full-match TOTAL ─────────────────────────────────
test("3. cross-provider-event full-match TOTAL recovery works", () => {
  const r = selectRecoverablePrimaryMarket(exactScoreCandidate(), [
    rnm({ eventId: "851820", conditionId: "cond-tot", selectedTokenId: "tot-o", opposingTokenId: "tot-u", selectedPriceNum: 0.45, sportsMarketType: "totals", marketQuestion: "Wrexham AFC vs. Birmingham City FC: O/U 2.5" }),
  ]);
  assert.ok(r);
  assert.equal(r!.candidate.market.conditionId, "cond-tot");
  assert.equal(r!.forcedOutcome.selectedTokenId, "tot-o");
});

// ── 4. recovery NEVER selects corners / halftime / half-team-totals ──────────
test("4. recovery does NOT select corners / halftime / half-team-totals alternatives", () => {
  const universe: ResearchNestedMarket[] = [
    rnm({ eventId: "851829", conditionId: "cond-corners", selectedTokenId: "c-o", opposingTokenId: "c-u", selectedPriceNum: 0.45, sportsMarketType: "total_corners", marketQuestion: "Wrexham AFC vs. Birmingham City FC: O/U 9.5 Total Corners" }),
    rnm({ eventId: "851831", conditionId: "cond-ht", selectedTokenId: "h-a", opposingTokenId: "h-b", selectedPriceNum: 0.45, sportsMarketType: "soccer_halftime_result", marketQuestion: "Wrexham AFC leading at halftime?" }),
    rnm({ eventId: "851835", conditionId: "cond-hht", selectedTokenId: "hh-o", opposingTokenId: "hh-u", selectedPriceNum: 0.45, sportsMarketType: "soccer_first_half_team_totals", marketQuestion: "Wrexham AFC 1st Half O/U 0.5" }),
  ];
  assert.equal(selectRecoverablePrimaryMarket(exactScoreCandidate(), universe), null, "no authorized family present -> fail closed");

  // ...and when an authorized market IS present alongside them, only it is picked
  const withAuthorized = [...universe, rnm({ eventId: "851801", conditionId: "cond-ml", selectedTokenId: "ml-a", opposingTokenId: "ml-b", selectedPriceNum: 0.5, sportsMarketType: "moneyline" })];
  const r = selectRecoverablePrimaryMarket(exactScoreCandidate(), withAuthorized);
  assert.ok(r);
  assert.equal(r!.candidate.market.conditionId, "cond-ml");
});

// ── 4a. EXPAND_ALLOWED_SOCCER_MARKET_UNIVERSE_V1: recovery DOES now select
//        soccer_exact_score / soccer_first_to_score, but corners/halftime
//        siblings alongside them are still never picked ────────────────────
test("4a. recovery selects soccer_first_to_score when it is the only authorized family present", () => {
  const universe: ResearchNestedMarket[] = [
    rnm({ eventId: "851829", conditionId: "cond-corners", selectedTokenId: "c-o", opposingTokenId: "c-u", selectedPriceNum: 0.45, sportsMarketType: "total_corners", marketQuestion: "Wrexham AFC vs. Birmingham City FC: O/U 9.5 Total Corners" }),
    rnm({ eventId: "851833", conditionId: "cond-fts", selectedTokenId: "f-a", opposingTokenId: "f-b", selectedPriceNum: 0.45, sportsMarketType: "soccer_first_to_score", marketQuestion: "Wrexham AFC to score first?" }),
  ];
  const r = selectRecoverablePrimaryMarket(exactScoreCandidate(), universe);
  assert.ok(r);
  assert.equal(r!.candidate.market.conditionId, "cond-fts");
  assert.equal(r!.recoverySource, "cross-provider-event");
});

test("4a-ii. recovery selects soccer_exact_score when it is the only authorized family present", () => {
  const universe: ResearchNestedMarket[] = [
    rnm({ eventId: "851836", conditionId: "cond-xs2", selectedTokenId: "x-a", opposingTokenId: "x-b", selectedPriceNum: 0.45, sportsMarketType: "soccer_exact_score", marketQuestion: "Exact Score: Wrexham AFC 1 - 0 Birmingham City FC?" }),
  ];
  const r = selectRecoverablePrimaryMarket(exactScoreCandidate(), universe);
  assert.ok(r);
  assert.equal(r!.candidate.market.conditionId, "cond-xs2");
});

test("4b. same-shard corners/halftime siblings are also excluded", () => {
  const sibs = [
    { outcomes: ["Over", "Under"], outcomePrices: [0.44, 0.56], clobTokenIds: ["c1", "c2"], question: "O/U 9.5 Corners", sportsMarketType: "total_corners", conditionId: "cond-c" },
    { outcomes: ["Yes", "No"], outcomePrices: [0.45, 0.55], clobTokenIds: ["h1", "h2"], question: "leading at halftime", sportsMarketType: "soccer_halftime_result", conditionId: "cond-h" },
  ];
  assert.equal(selectRecoverablePrimaryMarket(exactScoreCandidate({ siblings: sibs }), []), null);
});

// ── 5. Contract A accepts a full-match terse "O/U 2.5" total ─────────────────
test("5. Contract A taxonomy accepts a full-match terse 'O/U 2.5' total", () => {
  assert.equal(classifyMarketText("Wrexham AFC vs. Birmingham City FC: O/U 2.5"), "allowed_fullmatch_total");
  const d = resolveMarketAnchorDecision({ providerMarketQuestion: "Wrexham AFC vs. Birmingham City FC: O/U 2.5" });
  assert.equal(d.allowed, true);
  assert.equal(d.market_class, "allowed_fullmatch_total");
  assert.equal(d.event_scope, "full_match");
});

// ── 6. Contract A still rejects corners + partial-event markets ──────────────
test("6. Contract A still rejects corners and partial-event markets", () => {
  const corners = resolveMarketAnchorDecision({ providerMarketQuestion: "Groningen vs. Sittard: O/U 9.5 Total Corners" });
  assert.equal(corners.allowed, false);
  assert.equal(corners.market_class, "forbidden_corners");

  const half = resolveMarketAnchorDecision({ providerMarketQuestion: "Korona Kielce 1st Half O/U 0.5" });
  assert.equal(half.allowed, false);
  assert.equal(half.reason_code, "FORBIDDEN_MARKET_CLASS");

  const htResult = resolveMarketAnchorDecision({ providerMarketQuestion: "Manchester City FC leading at halftime?" });
  assert.equal(htResult.allowed, false);

  // terse O/U does not rescue a forbidden class
  assert.equal(classifyMarketText("Wrexham 2nd Half O/U 0.5"), "forbidden_halftime");
});

// ── 7. physical-event contamination guards intact ───────────────────────────
test("7. physical-event isolation — different match never recovered", () => {
  const universe: ResearchNestedMarket[] = [
    rnm({ eventId: "999001", conditionId: "cond-other", selectedTokenId: "o-a", opposingTokenId: "o-b", selectedPriceNum: 0.45, sportsMarketType: "moneyline",
          eventTitle: "Real Madrid vs. FC Barcelona", eventSlug: "real-madrid-barcelona", marketQuestion: "Will Real Madrid win?" }),
    rnm({ eventId: "999002", conditionId: "cond-nextweek", selectedTokenId: "n-a", opposingTokenId: "n-b", selectedPriceNum: 0.45, sportsMarketType: "moneyline",
          eventStartIso: "2026-09-04T19:00:00.000Z", gameStartTimeIso: "2026-09-04T19:00:00.000Z" }),
  ];
  assert.equal(selectRecoverablePrimaryMarket(exactScoreCandidate(), universe), null);

  const id = resolvePhysicalMatchIdentity(exactScoreCandidate());
  assert.ok(id);
  assert.equal(id!.dayIso, DAY);
  assert.ok(id!.teamTokensA.includes("wrexham") && id!.teamTokensB.includes("birmingham"));
});

// ── 8. identity / side preservation + determinism ───────────────────────────
test("8. recovered market keeps its real condition_id / token_id / side; deterministic", () => {
  const universe: ResearchNestedMarket[] = [
    rnm({ eventId: "851840", conditionId: "0xREALCOND", selectedTokenId: "0xREALTOK", opposingTokenId: "0xOPP", selectedPriceNum: 0.4, sportsMarketType: "spreads", selectedOutcomeName: "Birmingham City FC" }),
    rnm({ eventId: "851841", conditionId: "cond-far", selectedTokenId: "far-a", opposingTokenId: "far-b", selectedPriceNum: 0.28, sportsMarketType: "moneyline" }),
  ];
  const r1 = selectRecoverablePrimaryMarket(exactScoreCandidate(), universe);
  const r2 = selectRecoverablePrimaryMarket(exactScoreCandidate(), universe);
  assert.equal(r1!.candidate.market.conditionId, "0xREALCOND"); // 0.4 closer to 0.45 than 0.28
  assert.equal(r1!.forcedOutcome.selectedTokenId, "0xREALTOK");
  assert.equal(r1!.forcedOutcome.selectedOutcomeName, "Birmingham City FC");
  assert.equal(r1!.candidate.market.conditionId, r2!.candidate.market.conditionId);
});
