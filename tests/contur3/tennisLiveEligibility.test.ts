// TENNIS LIVE MONEY ELIGIBILITY — the shared gate applied before Reservation.
//   node --import tsx --test tests/contur3/tennisLiveEligibility.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTennisMoneyEligibility } from "../../lib/executor/tennisLiveEligibility";

const ELIGIBLE_ATP = {
  structuredMarketType: "moneyline",
  marketText: "ATP Rome, Main Draw: Moneyline: Carlos Alcaraz vs Jannik Sinner",
  eventIdentityText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
};

test("TENNIS-1: structured moneyline market_type + visible identity + no excluded level is eligible", () => {
  const decision = resolveTennisMoneyEligibility(ELIGIBLE_ATP);
  assert.equal(decision.eligible, true);
  assert.equal(decision.reasonCode, "TENNIS_MONEY_ELIGIBLE");
});

test("TENNIS-2: structured tennis_completed_match is always rejected, even with Moneyline-looking text, and never eligible via the completed-match proposition", () => {
  const decision = resolveTennisMoneyEligibility({
    ...ELIGIBLE_ATP,
    structuredMarketType: "tennis_completed_match",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_COMPLETED_MATCH_MARKET_REJECTED");
});

test("TENNIS-2b: tennis_completed_match is rejected even when its own display text says 'Completed Match'", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: "tennis_completed_match",
    marketText: "ATP Rome, Main Draw: Completed Match: Carlos Alcaraz vs Jannik Sinner",
    eventIdentityText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_COMPLETED_MATCH_MARKET_REJECTED");
});

test("TENNIS-3: no structured moneyline authority fails closed -- 'Completed Match' text never restores eligibility", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: null,
    marketText: "ATP Rome, Main Draw: Completed Match: Carlos Alcaraz vs Jannik Sinner",
    eventIdentityText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_MARKET_TYPE_NOT_MONEYLINE");
});

test("TENNIS-4: no structured type and no Completed Match text is rejected", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: null,
    marketText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner - Moneyline",
    eventIdentityText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_MARKET_TYPE_NOT_MONEYLINE");
});

test("TENNIS-5: a missing visible event identity is rejected even when the market type is exact moneyline", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: "moneyline",
    marketText: "Moneyline: Player A vs Player B",
    eventIdentityText: null,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_NO_EVENT_IDENTITY");
});

const EXCLUDED_LEVELS = ["M15", "M25", "W15", "W35", "W50"];
for (const level of EXCLUDED_LEVELS) {
  test(`TENNIS-6 (${level}): an excluded ITF level is rejected even on a structured moneyline market`, () => {
    const decision = resolveTennisMoneyEligibility({
      structuredMarketType: "moneyline",
      marketText: `${level} Reus, Main Draw: Moneyline: Player A vs Player B`,
      eventIdentityText: `${level} Reus: Player A vs Player B`,
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL");
  });
}

test("TENNIS-7: a Juniors draw is rejected", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: "moneyline",
    marketText: "Wimbledon Juniors, Moneyline: Player A vs Player B",
    eventIdentityText: "Wimbledon Juniors: Player A vs Player B",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL");
});

test("TENNIS-8: an explicit Qualifying draw is rejected", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: "moneyline",
    marketText: "ATP Rome, Qualifying: Moneyline: Player A vs Player B",
    eventIdentityText: "ATP Rome Qualifying: Player A vs Player B",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL");
});

const OTHER_TENNIS_PROP_TYPES = [
  "tennis_set_winner",
  "tennis_first_set_winner",
  "tennis_totals",
  "tennis_handicap",
  "tennis_exact_score",
];
for (const propType of OTHER_TENNIS_PROP_TYPES) {
  test(`TENNIS-9 (${propType}): non-moneyline tennis market types remain rejected`, () => {
    const decision = resolveTennisMoneyEligibility({
      structuredMarketType: propType,
      marketText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
      eventIdentityText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reasonCode, "TENNIS_MARKET_TYPE_NOT_MONEYLINE");
  });
}
