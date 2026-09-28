import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitResearchMarketsByScorerScope,
  s2WideScorerEvidenceFields,
  s2WideScorerCanonicalScore,
} from "../../lib/feed/buildLandingCards";
import { scoreOwnershipForSportFamily } from "../../lib/feed/sportScoreOwnership";
import type { LandingCardDiagnostics, ResearchNestedMarket } from "../../lib/feed/types";

// RESEARCH_FOOTBALL_SCORER_COMPLETENESS_V1 regression:
//
// Broken edge 1 — the shared all-sport wide scorer budget starved soccer
// (652 attempted / 3167 budget-exhausted out of 3819 eligible identities).
// splitResearchMarketsByScorerScope lets a research-only run target the
// scorer at one sportFamily without shrinking selectedResearch itself (the
// #404 sibling-selector output persistence/sibling-capture/lineage-capture
// depend on).
//
// Broken edge 2 — the wide scorer already computes rich enrichMarket()
// evidence (trade cash, holder concentration, formulaAudit...) but the S2
// snapshot builder discarded it back to null. s2WideScorerEvidenceFields and
// s2WideScorerCanonicalScore carry the exact already-computed values through
// instead of recomputing or fabricating them.
//
// Run with: node --import tsx --test tests/feed/researchScorerFootballCompleteness.test.ts

const START = "2026-08-10T19:00:00.000Z";

function research(overrides: Partial<ResearchNestedMarket> = {}): ResearchNestedMarket {
  const family = overrides.providerSportFamily ?? "soccer";
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
    providerSportFamily: family,
    providerSportSource: "structured_sports_tag",
    providerSportTagIds: ["1", `family-${family}`],
    providerSeriesIds: [`series-${family}`],
    scoreOwnership: scoreOwnershipForSportFamily(family),
    ...overrides,
  };
}

test("with no sport filter, scorer membership is unchanged: every selected row goes to forScoring", () => {
  const rows = [
    research({ conditionId: "c1", selectedTokenId: "t1", providerSportFamily: "soccer" }),
    research({ conditionId: "c2", selectedTokenId: "t2", providerSportFamily: "tennis" }),
    research({ conditionId: "c3", selectedTokenId: "t3", providerSportFamily: "esports" }),
  ];

  const { forScoring, scopeFiltered } = splitResearchMarketsByScorerScope(rows, null);

  assert.equal(forScoring.length, 3);
  assert.equal(scopeFiltered.length, 0);
  assert.deepEqual(forScoring, rows);
});

test("with sportFamily='soccer', soccer rows are scored and other families are scope-filtered, not dropped", () => {
  const soccer = research({ conditionId: "c1", selectedTokenId: "t1", providerSportFamily: "soccer" });
  const tennis = research({ conditionId: "c2", selectedTokenId: "t2", providerSportFamily: "tennis" });
  const esports = research({ conditionId: "c3", selectedTokenId: "t3", providerSportFamily: "esports" });
  const rows = [soccer, tennis, esports];

  const { forScoring, scopeFiltered } = splitResearchMarketsByScorerScope(rows, "soccer");

  assert.deepEqual(forScoring, [soccer]);
  assert.deepEqual(scopeFiltered, [tennis, esports]);
  // Critical semantic requirement: the filter never shrinks the original
  // selectedResearch population — persistence/sibling capture still see all 3.
  assert.equal(rows.length, 3);
});

test("scope-filtered identities never enter the scorer loop, so they can never be counted as budget-exhausted", () => {
  const soccer = research({ conditionId: "c1", selectedTokenId: "t1", providerSportFamily: "soccer" });
  const tennis = research({ conditionId: "c2", selectedTokenId: "t2", providerSportFamily: "tennis" });

  const { forScoring, scopeFiltered } = splitResearchMarketsByScorerScope([soccer, tennis], "soccer");

  // The budget-exhaustion branch only ever iterates `forScoring`. A row that
  // never appears there structurally cannot be attributed to budget exhaustion.
  assert.equal(scopeFiltered.some((r) => forScoring.includes(r)), false);
  assert.equal(scopeFiltered[0].conditionId, "c2");
});

test("family filter is case/whitespace-insensitive, matching providerSportFamily normalization elsewhere", () => {
  const soccer = research({ conditionId: "c1", selectedTokenId: "t1", providerSportFamily: "Soccer " });
  const { forScoring } = splitResearchMarketsByScorerScope([soccer], "soccer");
  assert.deepEqual(forScoring, [soccer]);
});

function diagnosticsFixture(overrides: Partial<LandingCardDiagnostics> = {}): LandingCardDiagnostics {
  return {
    conditionId: "cond-1",
    providerEventContext: undefined,
    selectedTokenId: "tok-1",
    selectedOutcome: "A",
    currentPrice: 0.4,
    price1hAgo: null,
    price6hAgo: null,
    delta1hPp: null,
    delta6hPp: 3.2,
    spread: 0.02,
    openInterest: 5000,
    recentTradeCash: 1200.5,
    maxTradeCash: 4300,
    selectedTradeCount: 7,
    totalTradeCount: 11,
    holderConcentrationScore: 0.31,
    dataCoverage: 62,
    formulaUsed: "trusted-initial-formula-1.1",
    rejectionReasons: [],
    formulaAudit: {
      v: "v1",
      oddsFit: 0.5,
      smartMoneyVal: 0.2,
      pubWhaleVal: 0.1,
      preEventVal: 0.3,
      signalV2Raw: 55,
      signalCap: 80,
      noTradeData: false,
      finalSignalV2: 63.4,
      selectedOdds: 2.1,
    },
    ...overrides,
  } as LandingCardDiagnostics;
}

test("a synthetic scored S2 outcome with non-null enriched diagnostics persists the exact values", () => {
  const diag = diagnosticsFixture();
  const fields = s2WideScorerEvidenceFields(diag);

  assert.equal(fields.delta6hPp, 3.2);
  assert.equal(fields.recentTradeCash, 1200.5);
  assert.equal(fields.maxTradeCash, 4300);
  assert.equal(fields.selectedTradeCount, 7);
  assert.equal(fields.formulaAudit?.finalSignalV2, 63.4);
});

test("missing evidence remains null — never fabricated as zero", () => {
  const fields = s2WideScorerEvidenceFields(null);

  assert.equal(fields.delta1hPp, null);
  assert.equal(fields.delta6hPp, null);
  assert.equal(fields.recentTradeCash, null);
  assert.equal(fields.maxTradeCash, null);
  assert.equal(fields.selectedTradeCount, null);
  assert.equal(fields.holderConcentrationScore, null);
  assert.equal("formulaAudit" in fields, false);
});

test("a genuinely zero evidence value is preserved as zero, not treated as missing", () => {
  const diag = diagnosticsFixture({ recentTradeCash: 0, selectedTradeCount: 0 });
  const fields = s2WideScorerEvidenceFields(diag);
  assert.equal(fields.recentTradeCash, 0);
  assert.equal(fields.selectedTradeCount, 0);
});

test("canonical score capture uses the already-computed formulaAudit.finalSignalV2; no new formula", () => {
  const diag = diagnosticsFixture();
  assert.equal(s2WideScorerCanonicalScore(diag, 10), 63.4);
});

test("canonical score falls back to the legacy formulaScore only when formulaAudit is absent", () => {
  const diag = diagnosticsFixture({ formulaAudit: undefined });
  assert.equal(s2WideScorerCanonicalScore(diag, 41.5), 41.5);
});

test("canonical score is null when neither formulaAudit nor a legacy score exists", () => {
  assert.equal(s2WideScorerCanonicalScore(null, null), null);
});
