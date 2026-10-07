import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFireModelCandidates,
  resolveUpstreamMarketPolicy,
  type FireModelCandidate,
  type MarketPolicyProbe,
} from "../../lib/executor/buildFireModelCandidates";
import { anchorDecisionForCandidate, buildContractAReservationPlan } from "../../lib/executor/nightEventReservations";
import { buildContractAPlanningDecision } from "../../lib/executor/contractADecisions";
import { classifyMarketText, isExactFullMatchTotalCorners, resolveMarketAnchorDecision } from "../../lib/contur3/taxonomy";
import { selectRecoverablePrimaryMarket } from "../../lib/feed/buildLandingCards";
import type { CandidateMarket } from "../../lib/feed/buildLandingCards";
import type { ResearchNestedMarket } from "../../lib/feed/types";

// SOCCER_FULL_MATCH_TOTAL_CORNERS_V1: exact full-match TOTAL_CORNERS is allowed;
// corner derivatives and ambiguous corners stay forbidden. T40 / T20 / economics /
// Queue for TOTAL_CORNERS are proven by the pre-existing suites
// (precontractT20Research, reservationMarketBaseline, eventExecutionQueue.rebalanceScheduler
// T10-R / T10-T) and are deliberately untouched here.
//
// Run: node --import tsx --test tests/contur3/fullMatchTotalCornersAdmission.test.ts

const QUESTION = "Match Total Corners O/U 9.5";
const SLUG = "epl-ars-che-2026-10-10-total-corners-9pt5";

function probe(over: Partial<MarketPolicyProbe> = {}): MarketPolicyProbe {
  return {
    market_slug: SLUG,
    event_slug: "epl-ars-che-2026-10-10",
    match_family_key: "epl-ars-che-2026-10-10",
    inferred_sport: "soccer",
    activity_label_detected: false,
    providerMarketQuestion: QUESTION,
    providerEventTitle: "Arsenal vs. Chelsea",
    providerEventId: "evt-1",
    providerMarketId: "corners-market",
    providerMarketType: "total_corners",
    conditionId: "corners-market",
    condition_id: "corners-market",
    token_id: "corners-over-token",
    side: "Over",
    ...over,
  };
}

// 1 ─ Planning
test("1. exact structured full-match TOTAL_CORNERS is ALLOWED at Planning with its own market class", () => {
  const v = resolveUpstreamMarketPolicy(probe());
  assert.equal(v.allowed, true);
  assert.equal(v.market_class, "allowed_fullmatch_total_corners");
  assert.equal(v.event_scope, "full_match");
  assert.equal(v.anchor_kind, "EXECUTABLE_MARKET");
  assert.deepEqual(v.exact_identity, { condition_id: "corners-market", token_id: "corners-over-token", side: "Over" });
  for (const q of ["Total Corners O/U 8.5", "Arsenal vs. Chelsea: O/U 9.5 Total Corners"]) {
    assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketQuestion: q })).allowed, true, q);
  }
});

// 7-13 ─ derivatives
test("7-13. corner derivatives are BLOCKED at Planning (team, home/away, halves, first/last, race, odd/even)", () => {
  const cases: Array<[string, Partial<MarketPolicyProbe>]> = [
    ["team total corners (question)", { providerMarketQuestion: "Arsenal Team Total Corners O/U 4.5" }],
    ["team total corners (slug)", { market_slug: "epl-ars-che-2026-10-10-team-total-corners-4pt5" }],
    ["home corners", { providerMarketQuestion: "Home Total Corners O/U 4.5" }],
    ["away corners", { providerMarketQuestion: "Away Total Corners O/U 4.5" }],
    ["first-half total corners", { providerMarketQuestion: "1st Half Total Corners O/U 4.5" }],
    ["first-half total corners (slug)", { market_slug: "epl-ars-che-first-half-total-corners-4pt5" }],
    ["second-half total corners", { providerMarketQuestion: "Second Half Total Corners O/U 4.5" }],
    ["halftime total corners", { providerMarketQuestion: "Halftime Total Corners O/U 4.5" }],
    ["first corner", { providerMarketQuestion: "First Corner Total Corners" }],
    ["last corner", { providerMarketQuestion: "Last Corner Total Corners" }],
    ["corner race", { providerMarketQuestion: "Race to 5 Total Corners" }],
    ["odd/even corners", { providerMarketQuestion: "Total Corners Odd/Even" }],
    ["derivative structured type", { providerMarketType: "soccer_team_total_corners" }],
    ["cards bundled with corners", { providerMarketQuestion: "Total Corners and Cards O/U 9.5" }],
  ];
  for (const [name, over] of cases) {
    assert.equal(resolveUpstreamMarketPolicy(probe(over)).allowed, false, name);
  }
});

// 14 ─ ambiguous
test("14. ambiguous / text-only / identity-incomplete corners are BLOCKED", () => {
  assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketType: null })).allowed, false, "no structured type");
  assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketType: "" })).allowed, false);
  assert.equal(resolveUpstreamMarketPolicy(probe({ token_id: null })).allowed, false, "no token");
  assert.equal(resolveUpstreamMarketPolicy(probe({ condition_id: null })).allowed, false, "no condition");
  assert.equal(resolveUpstreamMarketPolicy(probe({ side: null })).allowed, false, "no side");
  assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketId: null })).allowed, false, "no market id");
  assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketQuestion: null })).allowed, false, "no question");
  assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketQuestion: "O/U 9.5 Corners" })).allowed, false, "not a total-corners line");
  assert.equal(resolveUpstreamMarketPolicy(probe({ inferred_sport: "basketball" })).allowed, false, "not soccer");
  assert.equal(resolveUpstreamMarketPolicy(probe({ activity_label_detected: true })).allowed, false, "activity label");
  // text-only taxonomy never allows corners
  assert.equal(classifyMarketText(QUESTION), "forbidden_corners");
  assert.equal(resolveMarketAnchorDecision({ providerMarketQuestion: QUESTION }).allowed, false);
  assert.equal(isExactFullMatchTotalCorners({ structuredType: null, question: QUESTION }), false);
  assert.equal(isExactFullMatchTotalCorners({ structuredType: "total_corners", question: null }), false);
});

// 15 ─ unchanged families
test("15. moneyline / spreads / ordinary totals are unchanged", () => {
  const base = { market_slug: "m", providerMarketId: "m1", conditionId: "m1", condition_id: "m1", token_id: "t", side: "Arsenal" };
  const ml = resolveUpstreamMarketPolicy(probe({ ...base, providerMarketType: "moneyline", providerMarketQuestion: "Will Arsenal win?" }));
  assert.equal(ml.allowed, true);
  assert.equal(ml.market_class, "allowed_fullmatch_moneyline");
  const sp = resolveUpstreamMarketPolicy(probe({ ...base, providerMarketType: "spreads", providerMarketQuestion: "Spread: Arsenal (-1.5)" }));
  assert.equal(sp.allowed, true);
  assert.equal(sp.market_class, "allowed_fullmatch_spread");
  const tot = resolveUpstreamMarketPolicy(probe({ ...base, providerMarketType: "totals", providerMarketQuestion: "Arsenal vs. Chelsea: O/U 2.5" }));
  assert.equal(tot.allowed, true);
  assert.equal(tot.market_class, "allowed_fullmatch_total");
  assert.equal(resolveUpstreamMarketPolicy(probe({ ...base, providerMarketType: "totals", providerMarketQuestion: "1st Half O/U 0.5" })).allowed, false);
});

// 2 ─ Reservation (source row → Planning candidate → Planning decision → Reservation)
function sourceRow(over: { id: string; condition: string; token: string; type: string; question: string }) {
  const start = "2026-10-10T12:00:00.000Z";
  return {
    id: over.id, condition_id: over.condition, selected_token_id: over.token, selected_outcome: "Over",
    score: 80, signal_confidence_num: 70, smart_money_score_num: null, entry_price_num: 0.51,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-10-10T02:30:00.000Z", expires_at: start,
    signal_result: null,
    event_slug: "epl-ars-che-2026-10-10",
    market_slug: SLUG,
    diagnostics: {
      gameStartIso: start, dataCoverage: 60, shadowScope: "soccer",
      eventTitle: "Arsenal vs. Chelsea", marketTitle: over.question,
      providerEventContext: {
        v: "v1", provider: "polymarket", eventId: "evt-1", eventStartIso: start,
        providerMarketId: over.condition, marketType: over.type, sportFamily: "soccer", league: "soccer",
        marketQuestion: over.question, eventTitle: "Arsenal vs. Chelsea",
      },
    },
  };
}

test("2. the same exact TOTAL_CORNERS candidate passes Planning and CREATES a Reservation; the legacy corners guard does not veto it", async () => {
  const row = sourceRow({ id: "00000000-0000-4000-8000-0000000c0001", condition: "corners-market", token: "corners-over-token", type: "total_corners", question: QUESTION });
  const now = Date.parse("2026-10-10T05:00:00.000Z");
  const result = await buildFireModelCandidates(100_000, "all", true, [row], "CONTRACT_A_PLANNING_V1", now);
  assert.equal(result.candidates.length, 1, JSON.stringify(result.diagnostics ?? {}).slice(0, 400));
  const cand = result.candidates[0] as FireModelCandidate;
  assert.equal(cand.diagnostics.market_policy?.allowed, true);
  assert.equal(cand.diagnostics.market_policy?.market_class, "allowed_fullmatch_total_corners");
  assert.equal(anchorDecisionForCandidate(cand).allowed, true, "Reservation consumes the Planning verdict");

  const planning = buildContractAPlanningDecision(cand, row.diagnostics);
  assert.equal(planning.accepted, true, JSON.stringify(planning).slice(0, 400));
  const plan = await buildContractAReservationPlan(Date.parse("2026-10-10T07:00:00.000Z"), {
    fetchSourceRows: async () => [row],
    produceDecisions: async () => [planning],
  });
  assert.equal(plan.reservations.length, 1, "Reservation CREATED");
  assert.equal(plan.reservations[0].diagnostics.planning_policy_verdict?.market_class, "allowed_fullmatch_total_corners");
  assert.equal(plan.reservations[0].diagnostics.planning_final_identity_evidence?.condition_id, "corners-market");
});

test("2b. a derivative corners source row never reaches Planning", async () => {
  const row = sourceRow({ id: "00000000-0000-4000-8000-0000000c0002", condition: "team-corners", token: "tc-over", type: "total_corners", question: "Arsenal Team Total Corners O/U 4.5" });
  const result = await buildFireModelCandidates(100_000, "all", true, [row], "CONTRACT_A_PLANNING_V1", Date.parse("2026-10-10T05:00:00.000Z"));
  assert.equal(result.candidates.length, 0);
});

// Recovery / fanout
const START = "2026-10-10T15:00:00.000Z";
function exactScoreCandidate(siblings: unknown[] = []): CandidateMarket {
  const market: Record<string, unknown> = {
    id: "cond-xs", conditionId: "cond-xs", question: "Exact Score: Arsenal 2 - 3 Chelsea?",
    slug: "ars-che-exact-score", active: true, closed: false,
    outcomes: ["Yes", "No"], outcomePrices: [0.019, 0.981], clobTokenIds: ["xs-yes", "xs-no"],
  };
  market._parentMeta = { id: "851822", providerEventId: "851822", title: "Exact Score", slug: "ars-che-exact-score", startDate: START };
  return {
    event: { id: "851822", title: "Exact Score", slug: "ars-che-exact-score", active: true, closed: false, markets: [], endDate: START, category: "sports" },
    market: market as unknown as CandidateMarket["market"],
    rejectionReasons: [], warnings: [], isSportsRelated: true, isEnded: false,
    sportsMatchedKeyword: "sports-discovery",
    siblingMarketsRaw: siblings as CandidateMarket["siblingMarketsRaw"],
  };
}
function rnm(conditionId: string, question: string, type = "total_corners"): ResearchNestedMarket {
  return {
    eventId: `evt-${conditionId}`, eventTitle: "Arsenal vs. Chelsea", eventSlug: "ars-che", eventStartIso: START, gameStartTimeIso: START,
    marketId: `mkt-${conditionId}`, marketQuestion: question, marketEndIso: START, conditionId,
    marketFamily: "Soccer", leagueName: "EPL", familySource: "provider_structured_sports_metadata",
    selectedTokenId: `${conditionId}-o`, opposingTokenId: `${conditionId}-u`, selectedPriceNum: 0.45, opposingPriceNum: 0.55,
    publicFeedExposed: false, selectedOutcomeName: "Over", opposingOutcomeName: "Under",
    providerSportCode: "epl", providerSportFamily: "soccer", providerSportSource: "structured_sports_tag",
    providerSportTagIds: ["1"], providerSeriesIds: [], scoreOwnership: "SUPPORTED_BY_SCORE_MODEL",
    sportsMarketType: type,
  } as unknown as ResearchNestedMarket;
}

test("D. recovery admits exact full-match total_corners and rejects every derivative", () => {
  const ok = selectRecoverablePrimaryMarket(exactScoreCandidate(), [rnm("cond-ok", "Arsenal vs. Chelsea: O/U 9.5 Total Corners")]);
  assert.ok(ok, "exact full-match total corners recovered");
  assert.equal(ok!.candidate.market.conditionId, "cond-ok");
  for (const q of [
    "Arsenal Team Total Corners O/U 4.5", "Home Total Corners O/U 4.5", "Away Total Corners O/U 4.5",
    "1st Half Total Corners O/U 4.5", "Second Half Total Corners O/U 4.5", "First Corner",
    "Last Corner", "Race to 5 Corners", "Total Corners Odd/Even", "O/U 9.5 Corners",
  ]) {
    assert.equal(selectRecoverablePrimaryMarket(exactScoreCandidate(), [rnm("cond-bad", q)]), null, q);
  }
  assert.equal(selectRecoverablePrimaryMarket(exactScoreCandidate(), [rnm("cond-bad", "Arsenal Total Corners O/U 4.5", "soccer_team_total_corners")]), null);
});

test("D2. same-shard sibling total_corners is recovered only when exact", () => {
  const exact = { outcomes: ["Over", "Under"], outcomePrices: [0.44, 0.56], clobTokenIds: ["c1", "c2"], question: "Match Total Corners O/U 9.5", sportsMarketType: "total_corners", conditionId: "cond-c" };
  const team = { ...exact, question: "Arsenal Team Total Corners O/U 4.5", conditionId: "cond-t" };
  assert.ok(selectRecoverablePrimaryMarket(exactScoreCandidate([exact]), []));
  assert.equal(selectRecoverablePrimaryMarket(exactScoreCandidate([team]), []), null);
});
