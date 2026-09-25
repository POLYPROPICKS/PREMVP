import { test } from "node:test";
import assert from "node:assert/strict";

import { generateLandingCardPair } from "../../lib/feed/buildLandingCards";
import { buildResearchScoreObservation } from "../../lib/feed/researchScoreObservation";

// S2_WIDE_SCORER_SCORE_OBSERVATION_FIX_V1 — regression proof.
//
// scoreOneResearchMarket() (buildLandingCards.ts) computes `score` from
// enrichedResearch.diagnostics.formulaAudit.finalSignalV2 — the field that
// generateLandingCardPair() actually mutates onto diagnostics — and feeds it
// into buildResearchScoreObservation() for S2_WIDE_SCORER rows. It is not
// exported, so this test exercises the exact same two calls in the exact
// same order to prove the plumbing survives end to end.
//
// Run: node --import tsx --test tests/feed/wideScorerScoreObservationPlumbing.test.ts

type Enriched = Parameters<typeof generateLandingCardPair>[0];

function baseEnriched(overrides: {
  price: number;
  dataCoverage: number | null;
  maxTradeCash?: number | null;
  recentTradeCash?: number | null;
  selectedTradeCount?: number | null;
  delta6hPp?: number | null;
}): Enriched {
  const {
    price,
    dataCoverage,
    maxTradeCash = null,
    recentTradeCash = null,
    selectedTradeCount = null,
    delta6hPp = 0,
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
      holderConcentrationScore: null,
      dataCoverage,
    },
    warnings: [],
  } as unknown as Enriched;
}

test("S2_WIDE_SCORER: a genuinely computed score survives into scoreObservation.scoreValue", () => {
  const enriched = baseEnriched({
    price: 0.45,
    dataCoverage: 75,
    maxTradeCash: 15000,
    recentTradeCash: 60000,
    selectedTradeCount: 20,
    delta6hPp: 5,
  });

  const pair = generateLandingCardPair(enriched);
  assert.ok(pair, "expected a scored pair, not a null result");

  // Mirrors scoreOneResearchMarket()'s exact accessor after the fix.
  const score =
    typeof enriched.diagnostics.formulaAudit?.finalSignalV2 === "number"
      ? enriched.diagnostics.formulaAudit.finalSignalV2
      : null;
  assert.equal(typeof score, "number");
  assert.ok((score as number) > 0);

  const obs = buildResearchScoreObservation({
    scoreValue: score,
    metricFormulaVersion: "v2-lite-growth-safe",
    snapshotAt: "2026-09-02T12:00:00.000Z",
    snapshotRunId: "run-wide-1",
    conditionId: "condition-1",
    selectedTokenId: "token-1",
    sourceLineage: "S2_WIDE_SCORER",
  });

  assert.equal(obs.scoreValue, score);
  assert.equal(obs.sourceLineage, "S2_WIDE_SCORER");
  assert.equal(obs.scoreKind, "FIRE_MODEL_FINAL_SIGNAL_V2");
  assert.equal(obs.metricFormulaVersion, "v2-lite-growth-safe");
  assert.equal(obs.featureObservedAt, "2026-09-02T12:00:00.000Z");
  assert.equal(obs.sourceCreatedAt, "2026-09-02T12:00:00.000Z");
  assert.equal(obs.conditionId, "condition-1");
  assert.equal(obs.selectedTokenId, "token-1");
});

test("S2_WIDE_SCORER: the stale diagnostics.formulaScore accessor (pre-fix) never carries the value", () => {
  const enriched = baseEnriched({
    price: 0.45,
    dataCoverage: 75,
    maxTradeCash: 15000,
    recentTradeCash: 60000,
    selectedTradeCount: 20,
    delta6hPp: 5,
  });
  generateLandingCardPair(enriched);
  // Regression guard: generateLandingCardPair mutates .formulaAudit, never a
  // top-level .formulaScore. If this ever starts being set, the pre-fix
  // accessor would silently work again and mask a future regression there.
  assert.equal((enriched.diagnostics as unknown as Record<string, unknown>).formulaScore, undefined);
});

test("S2_WIDE_SCORER: a genuinely absent score (no fm11 pair) produces an explicit null, never fabricated", () => {
  // dataCoverage/price combination that makes computeBandedSignalScore return
  // null (band rejection) so generateLandingCardPair itself returns null —
  // the NOT_SCORED_PAIR_GENERATION_FAILED path in scoreOneResearchMarket.
  const enriched = baseEnriched({ price: 0.05, dataCoverage: 25 });
  const pair = generateLandingCardPair(enriched);
  assert.equal(pair, null);

  const obs = buildResearchScoreObservation({
    scoreValue: null,
    metricFormulaVersion: null,
    snapshotAt: "2026-09-02T12:00:00.000Z",
    snapshotRunId: "run-wide-2",
    conditionId: "condition-1",
    selectedTokenId: "token-1",
    sourceLineage: "S2_DIRECT_UNSCORED",
  });
  assert.equal(obs.scoreValue, null);
  assert.equal(obs.sourceLineage, "S2_DIRECT_UNSCORED");
});
