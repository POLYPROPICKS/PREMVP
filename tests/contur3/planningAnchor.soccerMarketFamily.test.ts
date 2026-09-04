import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveMarketAnchorDecision } from "../../lib/contur3/taxonomy";
import {
  resolvePlanningAnchorDecision,
  type StructuredPlanningIdentity,
} from "../../lib/executor/planningAnchor";

// EXPAND_ALLOWED_SOCCER_MARKET_UNIVERSE_V1 — Contract A boundary. Proves a
// correctly persisted soccer_exact_score / soccer_first_to_score candidate is
// no longer rejected solely because its market family was unsupported, while
// every other family (corners, both-teams-to-score, other scorer markets)
// stays exactly as fail-closed as before this mission -- no economic
// threshold (score/price/confidence/coverage/timing) is touched here.

const COMPLETE_IDENTITY_BASE: StructuredPlanningIdentity = {
  providerEventId: "evt-1",
  providerEventStartIso: "2026-09-10T18:00:00.000Z",
  providerMarketId: "mkt-1",
  conditionId: "0xabc",
  providerSportCode: "soccer",
};

test("soccer_exact_score with complete structured identity is admitted at Contract A", () => {
  const canonical = resolveMarketAnchorDecision({
    providerMarketQuestion: "Exact Score: Toulouse FC 2 - 1 Lille OSC?",
  });
  assert.equal(canonical.allowed, false); // canonical text classifier still rejects it -- unchanged
  assert.equal(canonical.market_class, "forbidden_exact_score");

  const decision = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput: { providerMarketQuestion: "Exact Score: Toulouse FC 2 - 1 Lille OSC?" },
    sport: "soccer",
    structuredIdentity: { ...COMPLETE_IDENTITY_BASE, providerMarketType: "soccer_exact_score" },
  });
  assert.equal(decision.allowed_for_planning, true);
  assert.equal(decision.anchor_kind, "APPROVED_SOCCER_MARKET_FAMILY");
  assert.equal(decision.reason_code, "SOCCER_MARKET_FAMILY_APPROVED_SOCCER_EXACT_SCORE");
});

test("soccer_first_to_score with complete structured identity is admitted at Contract A", () => {
  const canonical = resolveMarketAnchorDecision({
    providerMarketQuestion: "Toulouse FC to score first vs. Lille OSC?",
  });
  assert.equal(canonical.allowed, false); // falls through to UNKNOWN_MARKET_CLASS today -- unchanged
  assert.equal(canonical.market_class, "unknown");

  const decision = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput: { providerMarketQuestion: "Toulouse FC to score first vs. Lille OSC?" },
    sport: "soccer",
    structuredIdentity: { ...COMPLETE_IDENTITY_BASE, providerMarketType: "soccer_first_to_score" },
  });
  assert.equal(decision.allowed_for_planning, true);
  assert.equal(decision.anchor_kind, "APPROVED_SOCCER_MARKET_FAMILY");
  assert.equal(decision.reason_code, "SOCCER_MARKET_FAMILY_APPROVED_SOCCER_FIRST_TO_SCORE");
});

test("soccer_exact_score is rejected when structured identity is incomplete (missing conditionId)", () => {
  const canonical = resolveMarketAnchorDecision({ providerMarketQuestion: "Exact Score: Any Other Score?" });
  const decision = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput: { providerMarketQuestion: "Exact Score: Any Other Score?" },
    sport: "soccer",
    structuredIdentity: { ...COMPLETE_IDENTITY_BASE, conditionId: null, providerMarketType: "soccer_exact_score" },
  });
  assert.equal(decision.allowed_for_planning, false);
  assert.equal(decision.anchor_kind, "REJECTED");
});

test("both-teams-to-score is NOT admitted by this boundary even with complete structured identity", () => {
  const canonical = resolveMarketAnchorDecision({
    providerMarketQuestion: "Burnley FC vs. Middlesbrough FC: Both Teams to Score",
  });
  assert.equal(canonical.market_class, "forbidden_props");
  const decision = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput: { providerMarketQuestion: "Burnley FC vs. Middlesbrough FC: Both Teams to Score" },
    sport: "soccer",
    structuredIdentity: { ...COMPLETE_IDENTITY_BASE, providerMarketType: "both_teams_to_score" },
  });
  assert.equal(decision.allowed_for_planning, false);
  assert.equal(decision.anchor_kind, "REJECTED");
});

test("corners is NOT admitted by this boundary even with complete structured identity", () => {
  const canonical = resolveMarketAnchorDecision({
    providerMarketQuestion: "Toulouse FC vs. Lille OSC: Total Corners O/U 9.5",
  });
  assert.equal(canonical.market_class, "forbidden_corners");
  const decision = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput: { providerMarketQuestion: "Toulouse FC vs. Lille OSC: Total Corners O/U 9.5" },
    sport: "soccer",
    structuredIdentity: { ...COMPLETE_IDENTITY_BASE, providerMarketType: "total_corners" },
  });
  assert.equal(decision.allowed_for_planning, false);
  assert.equal(decision.anchor_kind, "REJECTED");
});

test("a partial-event-scope exact-score-typed market is never rescued (e.g. first-half exact score)", () => {
  const canonical = resolveMarketAnchorDecision({
    providerMarketQuestion: "First Half Exact Score: Toulouse FC 1 - 0 Lille OSC?",
  });
  assert.equal(canonical.event_scope, "first_half");
  const decision = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput: { providerMarketQuestion: "First Half Exact Score: Toulouse FC 1 - 0 Lille OSC?" },
    sport: "soccer",
    structuredIdentity: { ...COMPLETE_IDENTITY_BASE, providerMarketType: "soccer_exact_score" },
  });
  assert.equal(decision.allowed_for_planning, false);
});

test("existing moneyline STRUCTURED_FULLMATCH_EVENT admission is unaffected by this change", () => {
  const canonical = resolveMarketAnchorDecision({ providerMarketQuestion: "Toulouse FC vs. Lille OSC" });
  const decision = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput: { providerMarketQuestion: "Toulouse FC vs. Lille OSC" },
    sport: "soccer",
    structuredIdentity: { ...COMPLETE_IDENTITY_BASE, providerMarketType: "moneyline" },
  });
  assert.equal(decision.allowed_for_planning, true);
  assert.equal(decision.anchor_kind, "STRUCTURED_FULLMATCH_EVENT");
});
