// TENNIS LIVE MONEY ELIGIBILITY — the shared gate applied before Reservation.
//   node --import tsx --test tests/contur3/tennisLiveEligibility.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTennisMoneyEligibility } from "../../lib/executor/tennisLiveEligibility";

const ELIGIBLE_ATP = {
  structuredMarketType: "tennis_completed_match",
  marketText: "ATP Rome, Main Draw: Completed Match: Carlos Alcaraz vs Jannik Sinner",
  eventIdentityText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
};

test("TENNIS-1: exact structured market_type + visible identity + no excluded level is eligible", () => {
  const decision = resolveTennisMoneyEligibility(ELIGIBLE_ATP);
  assert.equal(decision.eligible, true);
  assert.equal(decision.reasonCode, "TENNIS_MONEY_ELIGIBLE");
});

test("TENNIS-2: a structured market_type other than tennis_completed_match is rejected, even with Completed Match text", () => {
  const decision = resolveTennisMoneyEligibility({
    ...ELIGIBLE_ATP,
    structuredMarketType: "tennis_moneyline",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_MARKET_TYPE_NOT_COMPLETED_MATCH");
});

test("TENNIS-3: text fallback accepts Completed Match wording only when structured type is absent", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: null,
    marketText: "ATP Rome, Main Draw: Completed Match: Carlos Alcaraz vs Jannik Sinner",
    eventIdentityText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reasonCode, "TENNIS_MONEY_ELIGIBLE");
});

test("TENNIS-4: no structured type and no Completed Match text is rejected", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: null,
    marketText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner - Moneyline",
    eventIdentityText: "ATP Rome: Carlos Alcaraz vs Jannik Sinner",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_MARKET_TYPE_NOT_COMPLETED_MATCH");
});

test("TENNIS-5: a missing visible event identity is rejected even when the market type is exact", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: "tennis_completed_match",
    marketText: "Completed Match: Player A vs Player B",
    eventIdentityText: null,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_NO_EVENT_IDENTITY");
});

const EXCLUDED_LEVELS = ["M15", "M25", "W15", "W35", "W50"];
for (const level of EXCLUDED_LEVELS) {
  test(`TENNIS-6 (${level}): an excluded ITF level is rejected`, () => {
    const decision = resolveTennisMoneyEligibility({
      structuredMarketType: "tennis_completed_match",
      marketText: `${level} Reus, Main Draw: Completed Match: Player A vs Player B`,
      eventIdentityText: `${level} Reus: Player A vs Player B`,
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL");
  });
}

test("TENNIS-7: a Juniors draw is rejected", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: "tennis_completed_match",
    marketText: "Wimbledon Juniors, Completed Match: Player A vs Player B",
    eventIdentityText: "Wimbledon Juniors: Player A vs Player B",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL");
});

test("TENNIS-8: an explicit Qualifying draw is rejected", () => {
  const decision = resolveTennisMoneyEligibility({
    structuredMarketType: "tennis_completed_match",
    marketText: "ATP Rome, Qualifying: Completed Match: Player A vs Player B",
    eventIdentityText: "ATP Rome Qualifying: Player A vs Player B",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL");
});
