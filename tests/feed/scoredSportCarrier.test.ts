import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStructuredProviderDiagnostics,
  researchNestedMarketToCandidate,
  selectResearchMarketsForScoring,
} from "../../lib/feed/buildLandingCards";
import type { ParentEventMeta } from "../../lib/feed/buildLandingCards";
import { buildFireModel1_1ResearchRows } from "../../lib/feed/cacheGeneratedSignals";
import {
  resolveStructuredSportFamily,
  scoreOwnershipForSportFamily,
  hasStructuredScoredSportAuthority,
} from "../../lib/feed/sportScoreOwnership";
import type { LandingCardPair, ResearchNestedMarket } from "../../lib/feed/types";
import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";

const NOW = Date.parse("2026-08-10T14:00:00.000Z");
const START = "2026-08-10T19:00:00.000Z";

function persistedScoredRow(index: number, family: string, providerSportCode: string) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    source: "polymarket",
    formula_version: "shadow-firemodel1_1_research_v0",
    metric_formula_version: "shadow-firemodel1_1_research_v0",
    condition_id: `condition-${index}`,
    selected_token_id: `token-${index}`,
    selected_outcome: "A",
    signal_confidence_num: 64,
    entry_price_num: 0.35,
    created_at: "2026-08-10T13:30:00.000Z",
    expires_at: START,
    signal_result: null,
    event_slug: "display text with no league tokens",
    market_slug: "display text with no league tokens",
    diagnostics: {
      gameStartIso: START,
      dataCoverage: 40,
      providerSportCode,
      providerSportFamily: family,
      providerSportSource: "structured_sports_tag",
      providerEventId: `provider-event-${index}`,
      providerMarketId: `provider-market-${index}`,
      providerEventContext: {
        v: "v1", provider: "polymarket", eventId: `provider-event-${index}`,
        eventStartIso: START, providerMarketId: `provider-market-${index}`,
        marketType: "moneyline", sportFamily: family, league: providerSportCode,
      },
    },
  };
}

function research(eventId: string, conditionId: string, family = "soccer"): ResearchNestedMarket {
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
  };
}

test("structured tag authority resolves every currently authorized score family and excludes table tennis", () => {
  for (const family of ["soccer", "tennis", "baseball", "esports", "basketball", "cricket", "hockey", "mma"]) {
    assert.equal(resolveStructuredSportFamily([{ slug: family }], family), family);
    assert.equal(scoreOwnershipForSportFamily(family), "SUPPORTED_BY_SCORE_MODEL");
  }
  assert.equal(resolveStructuredSportFamily([{ slug: "table-tennis" }], "setkameua"), "table-tennis");
  assert.equal(scoreOwnershipForSportFamily("table-tennis"), "INTENTIONALLY_UNSCORED");
  assert.equal(scoreOwnershipForSportFamily("rugby-sevens"), "INTENTIONALLY_UNSCORED");
});

test("research selection gives each eligible supported event a real scorer attempt before extra markets", () => {
  const universe = [
    research("a", "a-1"), research("a", "a-2"), research("a", "a-3"),
    research("b", "b-1", "tennis"),
    research("c", "c-1", "baseball"),
    research("unsupported", "u-1", "table-tennis"),
  ];
  const selected = selectResearchMarketsForScoring(universe, new Set(), 3, 0);
  assert.deepEqual(new Set(selected.map((row) => row.eventId)), new Set(["a", "b", "c"]));
  assert.ok(selected.every((row) => row.scoreOwnership === "SUPPORTED_BY_SCORE_MODEL"));
});

test("scored carrier preserves provider event and sport authority into persisted research diagnostics", () => {
  const adapted = researchNestedMarketToCandidate(research("soccer-event", "soccer-condition"));
  assert.ok(adapted);
  const parentMeta = (adapted.candidate.market as unknown as Record<string, unknown>)._parentMeta as Record<string, unknown>;
  assert.equal(parentMeta.providerSportCode, "ucl");
  assert.equal(parentMeta.providerSportFamily, "soccer");
  assert.equal(parentMeta.providerEventId, "soccer-event");
  const structuredDiagnostics = buildStructuredProviderDiagnostics(
    parentMeta as unknown as ParentEventMeta,
    adapted.candidate.market,
    adapted.candidate.event.endDate,
  );

  const pair = {
    premiumSignal: {
      eventTitle: "Display text deliberately carries no sport name",
      marketQuestion: "Will side A win?",
      winProbability: 64,
      profit: "+12%",
      metrics: [],
    },
    marketSource: { headline: "Will side A win?" },
    diagnostics: {
      conditionId: "soccer-condition",
      selectedTokenId: "token-soccer-condition",
      selectedOutcome: "A",
      currentPrice: 0.4,
      dataCoverage: 40,
      gameStartIso: START,
      ...structuredDiagnostics,
    },
  } as unknown as LandingCardPair;

  const [row] = buildFireModel1_1ResearchRows([pair], "2026-08-12T19:00:00.000Z");
  assert.equal(row.signal_confidence_num, 64);
  assert.equal(row.metric_formula_version, "shadow-firemodel1_1_research_v0");
  assert.equal(row.diagnostics.providerSportCode, "ucl");
  assert.equal(row.diagnostics.providerSportFamily, "soccer");
  assert.equal(row.diagnostics.providerEventId, "soccer-event");
  assert.equal(hasStructuredScoredSportAuthority(row.diagnostics), true);
  assert.equal(hasStructuredScoredSportAuthority({
    ...row.diagnostics,
    providerSportCode: undefined,
    providerSportFamily: undefined,
  }), false);
  assert.equal(hasStructuredScoredSportAuthority({
    ...row.diagnostics,
    providerEventId: "mismatched-provider-event",
  }), false);
});

test("Contract A uses canonical structured soccer authority and ignores misleading display text", async () => {
  const persisted = persistedScoredRow(1, "soccer", "ucl");
  const built = await buildFireModelCandidates(100, "all", true, [persisted], "CONTRACT_A_PLANNING_V1", NOW);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].strategic_scope, "SOCCER");
  assert.equal(built.candidates[0].diagnostics.legacy_text_fallback_used, false);
  assert.equal(built.rawDiagnostics?.rows_using_legacy_text_fallback, 0);
});

test("production-shaped supported sports retain one score contract and structured Contract A authority", async () => {
  const cases = [
    ["soccer", "ucl", "SOCCER"],
    ["tennis", "tennis", "TENNIS"],
    ["baseball", "mlb", "MLB"],
    ["esports", "cs2", "ESPORT"],
    ["basketball", "wnba", "BASKETBALL"],
    ["cricket", "cricket", "CRICKET"],
    ["hockey", "nhl", "HOCKEY"],
    ["mma", "ufc", "MMA"],
  ] as const;
  const rows = cases.map(([family, code], index) => persistedScoredRow(index + 10, family, code));
  const built = await buildFireModelCandidates(100, "all", true, rows, "CONTRACT_A_PLANNING_V1", NOW);
  assert.equal(built.candidates.length, cases.length);
  assert.deepEqual(built.candidates.map((candidate) => candidate.strategic_scope), cases.map((entry) => entry[2]));
  assert.ok(built.candidates.every((candidate) => candidate.diagnostics.legacy_text_fallback_used === false));
  assert.equal(built.rawDiagnostics?.rows_using_legacy_text_fallback, 0);
  assert.ok(rows.every((row) => row.metric_formula_version === "shadow-firemodel1_1_research_v0"));
});
