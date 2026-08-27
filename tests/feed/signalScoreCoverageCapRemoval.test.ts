import { test } from "node:test";
import assert from "node:assert/strict";

import { generateLandingCardPair } from "../../lib/feed/buildLandingCards";

// FOUNDER MISSION: dataCoverage must no longer impose a numerical ceiling on
// Signal Score. Coverage remains an explicit input feature (weighted 5-10%
// depending on component) and stays persisted separately in
// diagnostics.dataCoverage for eligibility/tier/policy. The independent
// noTradeData cap (68) and the odds-band display cap are unaffected.
//
// Live evidence this regresses against (2026-08-26 17:00 Minsk Reservation
// cohort): coverage-25 research candidates with raw scores ~63.9-66.9 and a
// rank-1/2 v2-lite-growth-safe pair with raw 78.9/85.1 at coverage 75 were all
// flattened toward 64 purely because of the coverage<50 -> max64 rule.

type Enriched = Parameters<typeof generateLandingCardPair>[0];

function baseEnriched(overrides: {
  price: number;
  dataCoverage: number | null;
  maxTradeCash?: number | null;
  recentTradeCash?: number | null;
  selectedTradeCount?: number | null;
  delta6hPp?: number | null;
  holderConcentrationScore?: number | null;
}): Enriched {
  const {
    price,
    dataCoverage,
    maxTradeCash = null,
    recentTradeCash = null,
    selectedTradeCount = null,
    delta6hPp = 0,
    holderConcentrationScore = null,
  } = overrides;

  return {
    event: {} as unknown,
    market: {
      id: "market-1",
      slug: "market-1",
      conditionId: "condition-1",
      question: "Will side A win?",
      volume: null,
      liquidity: null,
    },
    parentMeta: {
      slug: "event-1",
      category: "Sports",
      title: "Display Event",
      startDate: "2026-08-26T19:00:00.000Z",
      endDate: "2026-08-26T22:00:00.000Z",
      polymarketEventSlug: "event-1",
    },
    selectedOutcome: { name: "A", tokenId: "token-1", price },
    priceHistory: null,
    spread: null,
    orderBook: null,
    trades: null,
    holders: null,
    openInterest: null,
    gammaPriceChange: null,
    diagnostics: {
      conditionId: "condition-1",
      selectedTokenId: "token-1",
      selectedOutcome: "A",
      currentPrice: price,
      delta6hPp,
      delta1hPp: null,
      maxTradeCash,
      recentTradeCash,
      selectedTradeCount,
      holderConcentrationScore,
      dataCoverage,
    },
    warnings: [],
  } as unknown as Enriched;
}

test("coverage=25 no longer floors two differentiated raw scores to 64 (regression: Minsk cohort)", () => {
  // Strong real evidence: high trade cash/whale flow, favorable momentum.
  const strong = baseEnriched({
    price: 0.45,
    dataCoverage: 25,
    maxTradeCash: 15000,
    recentTradeCash: 60000,
    selectedTradeCount: 20,
    delta6hPp: 5,
  });
  // No trade evidence at all -> noTradeData=true, but still a real raw score,
  // representative of the ~66.4 research-candidate example in the mission.
  const noTradeEvidence = baseEnriched({
    price: 0.45,
    dataCoverage: 25,
    maxTradeCash: null,
    recentTradeCash: null,
    selectedTradeCount: null,
    delta6hPp: 0,
  });

  const strongPair = generateLandingCardPair(strong);
  const noTradePair = generateLandingCardPair(noTradeEvidence);
  assert.ok(strongPair);
  assert.ok(noTradePair);

  const strongAudit = strongPair!.diagnostics.formulaAudit as unknown as Record<string, number | boolean>;
  const noTradeAudit = noTradePair!.diagnostics.formulaAudit as unknown as Record<string, number | boolean>;

  // Raw model scores are genuinely different and both comfortably above 64.
  assert.ok((strongAudit.signalV2Raw as number) > 80, `expected strong raw > 80, got ${strongAudit.signalV2Raw}`);
  assert.ok((noTradeAudit.signalV2Raw as number) > 64, `expected noTrade raw > 64, got ${noTradeAudit.signalV2Raw}`);

  // Neither candidate collapses to the old coverage-cap value of 64.
  assert.notEqual(strongPair!.premiumSignal.winProbability, 64);
  assert.notEqual(noTradePair!.premiumSignal.winProbability, 64);

  // They remain differentiated from each other (not both flattened to one number).
  assert.notEqual(strongPair!.premiumSignal.winProbability, noTradePair!.premiumSignal.winProbability);

  // noTradeData cap (68) still applies to the no-evidence candidate -- unchanged rule.
  assert.ok(noTradePair!.premiumSignal.winProbability <= 68);
});

test("noTradeData cap (68) is unchanged and independent of coverage", () => {
  const fullCoverageNoTrade = baseEnriched({
    price: 0.45,
    dataCoverage: 100,
    maxTradeCash: null,
    recentTradeCash: null,
    selectedTradeCount: null,
    delta6hPp: 0,
  });
  const pair = generateLandingCardPair(fullCoverageNoTrade);
  assert.ok(pair);
  assert.equal(pair!.diagnostics.formulaAudit!.noTradeData, true);
  assert.ok(
    pair!.premiumSignal.winProbability <= 68,
    `expected noTradeData cap (<=68) to still bind even at full coverage, got ${pair!.premiumSignal.winProbability}`,
  );
});

test("odds-band display cap is unchanged regardless of coverage", () => {
  // Same odds band (2.20 < selectedOdds <= 2.70 -> max 74) at low vs full coverage;
  // the band cap must bind identically either way.
  const lowCoverage = baseEnriched({
    price: 0.45,
    dataCoverage: 25,
    maxTradeCash: 15000,
    recentTradeCash: 60000,
    selectedTradeCount: 20,
    delta6hPp: 5,
  });
  const fullCoverage = baseEnriched({
    price: 0.45,
    dataCoverage: 100,
    maxTradeCash: 15000,
    recentTradeCash: 60000,
    selectedTradeCount: 20,
    delta6hPp: 5,
  });

  const lowPair = generateLandingCardPair(lowCoverage);
  const fullPair = generateLandingCardPair(fullCoverage);
  assert.ok(lowPair);
  assert.ok(fullPair);

  assert.equal(lowPair!.diagnostics.formulaAudit!.oddsBandMax, 74);
  assert.equal(fullPair!.diagnostics.formulaAudit!.oddsBandMax, 74);
  assert.equal(lowPair!.premiumSignal.winProbability, 74);
  assert.equal(fullPair!.premiumSignal.winProbability, 74);
});

test("a genuinely lower raw score at coverage=25 remains lower and is not floor-raised to 64", () => {
  const weakEvidence = baseEnriched({
    price: 0.70,
    dataCoverage: 25,
    maxTradeCash: 100,
    recentTradeCash: 200,
    selectedTradeCount: 5,
    delta6hPp: -1,
  });
  const pair = generateLandingCardPair(weakEvidence);
  assert.ok(pair);

  const audit = pair!.diagnostics.formulaAudit as unknown as Record<string, number | boolean>;
  assert.ok((audit.signalV2Raw as number) < 64, `expected raw < 64, got ${audit.signalV2Raw}`);
  // Below the old floor-to-64 threshold: must stay at its own (lower) value, not be raised.
  assert.equal(pair!.premiumSignal.winProbability, Math.round(audit.signalV2Raw as number));
  assert.notEqual(pair!.premiumSignal.winProbability, 64);
});

test("coverage remains persisted on diagnostics for eligibility/tier/policy after scoring", () => {
  const enriched = baseEnriched({
    price: 0.45,
    dataCoverage: 25,
    maxTradeCash: 15000,
    recentTradeCash: 60000,
    selectedTradeCount: 20,
    delta6hPp: 5,
  });
  const pair = generateLandingCardPair(enriched);
  assert.ok(pair);
  // dataCoverage is untouched by the scoring path -- still readable downstream.
  assert.equal(pair!.diagnostics.dataCoverage, 25);
});
