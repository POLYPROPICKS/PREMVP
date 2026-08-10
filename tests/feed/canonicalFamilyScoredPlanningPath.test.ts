import { test } from "node:test";
import assert from "node:assert/strict";

// ── Canonical-family-only event: raw provider inventory → scored intake →
//    scored carrier → persisted Signal Pair → CONTRACT_A_PLANNING_V1 ─────────
//
// Every stage below is REAL production code, starting BEFORE the broken
// persistence boundary (the provider's own /sports tag metadata) and ending at
// the live Contract A Planning selector. Nothing is mocked.
//
// Production shape under test: a provider event whose structured tags expose a
// canonical sport family but NO unique raw league code (one tennis tag mapping
// to both atp and wta). `hasStructuredScoredSportAuthority` already treats that
// row as authoritative, but the scored intake required the raw code, so the row
// never became a scored row and never reached Planning at all.
//
// Run with: node --import tsx --test tests/feed/canonicalFamilyScoredPlanningPath.test.ts

// The producer/planning modules import the Supabase client module, which asserts
// credential PRESENCE at import time. This regression never performs a database
// call (every row is supplied in-memory), so a placeholder keeps it runnable in
// any environment without weakening what is proven.
process.env.SUPABASE_URL ??= "http://placeholder.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-not-a-real-key";

import type { ParentEventMeta } from "../../lib/feed/buildLandingCards";
import type { LandingCardPair, ResearchNestedMarket } from "../../lib/feed/types";

// Loaded after the placeholders above are set. These are the real production
// modules; only the credential presence check is satisfied.
async function production() {
  const [discover, landing, cache, ownership, planning] = await Promise.all([
    import("../../lib/feed/discoverSportsMarkets"),
    import("../../lib/feed/buildLandingCards"),
    import("../../lib/feed/cacheGeneratedSignals"),
    import("../../lib/feed/sportScoreOwnership"),
    import("../../lib/executor/buildFireModelCandidates"),
  ]);
  return { ...discover, ...landing, ...cache, ...ownership, ...planning };
}

const NOW = Date.parse("2026-08-10T14:00:00.000Z");
const START = "2026-08-10T19:00:00.000Z";
/** Display text only. It must never carry structured sport identity. */
const DISPLAY_LEAGUE = "Display League Text";

/** The provider's own /sports payload: one tag structurally maps to two codes. */
const AMBIGUOUS_TAG_SPORTS_RAW = [
  { sport: "atp", tags: "950" },
  { sport: "wta", tags: "950" },
];
const PROVIDER_TAGS = [{ id: "950", slug: "tennis" }];

/** Stage 1-2, verbatim: what the real provider resolvers return for this event. */
async function resolveProviderSport() {
  const p = await production();
  const resolution = p.resolveOfficialSportCode(
    ["950"],
    p.buildProviderSportMetadataMap(AMBIGUOUS_TAG_SPORTS_RAW),
  );
  return {
    providerSportCode: resolution.providerSportCode,
    providerSportSource: resolution.providerSportSource,
    providerSportFamily: p.resolveStructuredSportFamily(PROVIDER_TAGS, resolution.providerSportCode),
  };
}

async function researchMarket(): Promise<ResearchNestedMarket> {
  const p = await production();
  const { providerSportCode, providerSportFamily } = await resolveProviderSport();
  return {
    eventId: "provider-event-901",
    eventTitle: DISPLAY_LEAGUE,
    eventSlug: "event-901",
    eventStartIso: START,
    marketId: "provider-market-901",
    marketQuestion: "Will side A win?",
    marketEndIso: START,
    marketFamily: DISPLAY_LEAGUE,
    leagueName: DISPLAY_LEAGUE,
    sportsMarketType: "moneyline",
    familySource: "provider_structured_sports_metadata",
    conditionId: "condition-901",
    selectedTokenId: "token-901",
    opposingTokenId: "opposing-901",
    selectedPriceNum: 0.4,
    opposingPriceNum: 0.6,
    publicFeedExposed: false,
    selectedOutcomeName: "A",
    opposingOutcomeName: "B",
    gameStartTimeIso: START,
    providerSportCode,
    providerSportFamily: providerSportFamily as string,
    providerSportSource: "structured_sports_tag",
    providerSportTagIds: ["950"],
    providerSeriesIds: [],
    scoreOwnership: p.scoreOwnershipForSportFamily(providerSportFamily),
  };
}

/** Stage 3-5: real scored adapter + real structured carrier + real scored writer. */
async function persistedScoredRow(): Promise<Record<string, unknown>> {
  const p = await production();
  const rm = await researchMarket();
  const adapted = p.researchNestedMarketToCandidate(rm);
  assert.ok(adapted, "the real scored adapter must accept a canonical-family-only market");
  const parentMeta = (adapted.candidate.market as unknown as Record<string, unknown>)
    ._parentMeta as unknown as ParentEventMeta;
  const structuredDiagnostics = p.buildStructuredProviderDiagnostics(
    parentMeta,
    adapted.candidate.market,
    adapted.candidate.event.endDate,
  );
  const pair = {
    premiumSignal: {
      eventTitle: DISPLAY_LEAGUE,
      marketQuestion: "Will side A win?",
      winProbability: 64,
      profit: "+12%",
      metrics: [],
    },
    marketSource: { headline: "Will side A win?" },
    diagnostics: {
      conditionId: rm.conditionId,
      selectedTokenId: rm.selectedTokenId,
      selectedOutcome: "A",
      currentPrice: rm.selectedPriceNum,
      dataCoverage: 40,
      gameStartIso: rm.gameStartTimeIso,
      ...structuredDiagnostics,
    },
  } as unknown as LandingCardPair;

  const [writerRow] = p.buildFireModel1_1ResearchRows([pair], "2026-08-12T19:00:00.000Z");
  // Only the database-assigned columns are added; the writer owns everything else.
  return {
    ...writerRow,
    id: "00000000-0000-4000-8000-000000000901",
    created_at: "2026-08-10T13:30:00.000Z",
    signal_result: null,
  } as unknown as Record<string, unknown>;
}

test("a canonical-family-only provider event is admitted into the scored universe", async () => {
  const p = await production();
  const { providerSportCode, providerSportSource, providerSportFamily } = await resolveProviderSport();

  // The exact production precondition: no unique raw league code exists.
  assert.equal(providerSportCode, null);
  assert.equal(providerSportSource, "ambiguous_multi_tag");
  assert.equal(providerSportFamily, "tennis");

  // The canonical family alone carries score ownership and intake admission.
  assert.equal(p.scoreOwnershipForSportFamily(providerSportFamily), "SUPPORTED_BY_SCORE_MODEL");
  assert.equal(p.admitsResearchIntakeSportIdentity("provider-event-901", providerSportFamily), true);

  // Fail-closed: no provider event id and no canonical family are not admitted.
  assert.equal(p.admitsResearchIntakeSportIdentity("", providerSportFamily), false);
  assert.equal(p.admitsResearchIntakeSportIdentity("provider-event-901", null), false);
  assert.equal(p.admitsResearchIntakeSportIdentity("provider-event-901", "   "), false);
  // Display text is never a scored sport: admission alone never grants ownership.
  assert.equal(p.scoreOwnershipForSportFamily(DISPLAY_LEAGUE), "INTENTIONALLY_UNSCORED");
  assert.equal(p.resolveStructuredSportFamily([{ slug: DISPLAY_LEAGUE }], null), null);

  // Admitted rows reach the real scorer routing.
  const selected = p.selectResearchMarketsForScoring([await researchMarket()], new Set(), 5, 0);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].eventId, "provider-event-901");
});

test("the scored carrier keeps structured identity and never substitutes display text", async () => {
  const p = await production();
  const row = await persistedScoredRow();
  const diagnostics = row.diagnostics as Record<string, unknown>;
  const context = diagnostics.providerEventContext as Record<string, unknown>;

  assert.equal(diagnostics.providerSportFamily, "tennis");
  assert.equal(diagnostics.providerSportCode, null);
  assert.equal(context.sportFamily, "tennis");
  // The raw code is absent, NOT backfilled from the display league name.
  assert.equal(context.league, undefined);
  for (const field of [
    context.sportFamily,
    context.league,
    diagnostics.providerSportFamily,
    diagnostics.providerSportCode,
  ]) {
    assert.notEqual(field, DISPLAY_LEAGUE, "display text must never carry structured sport identity");
  }
  // The exact equality hasStructuredScoredSportAuthority enforces on the raw code.
  assert.equal(context.league ?? null, diagnostics.providerSportCode ?? null);

  // The persisted row therefore carries scorer authority.
  assert.equal(p.hasStructuredScoredSportAuthority(diagnostics), true);
});

test("all four exact provider identity fields survive into CONTRACT_A_PLANNING_V1", async () => {
  const p = await production();
  const row = await persistedScoredRow();
  const diagnostics = row.diagnostics as Record<string, unknown>;

  // 1-4: the exact fields hasExactStructuredProviderContractAIdentity requires.
  assert.equal(diagnostics.providerEventId, "provider-event-901");
  assert.equal(diagnostics.providerMarketId, "provider-market-901");
  assert.equal(row.condition_id, "condition-901");
  assert.equal(diagnostics.gameStartIso, START);
  assert.ok(Number.isFinite(Date.parse(diagnostics.gameStartIso as string)));

  const built = await p.buildFireModelCandidates(100, "all", true, [row], "CONTRACT_A_PLANNING_V1", NOW);
  assert.equal(
    built.rawDiagnostics?.rejected_before_planning_by_reason.MISSING_EXACT_PROVIDER_IDENTITY,
    undefined,
  );
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].strategic_scope, "TENNIS");
  assert.equal(built.candidates[0].condition_id, "condition-901");
  assert.equal(built.candidates[0].diagnostics.legacy_text_fallback_used, false);
  assert.equal(built.rawDiagnostics?.rows_using_legacy_text_fallback, 0);
});

test("incomplete or malformed exact provider identity stays fail-closed at Planning", async () => {
  const p = await production();
  const base = await persistedScoredRow();
  const mutate = (
    diagnosticsPatch: Record<string, unknown>,
    rowPatch: Record<string, unknown> = {},
  ) => ({
    ...base,
    ...rowPatch,
    diagnostics: { ...(base.diagnostics as Record<string, unknown>), ...diagnosticsPatch },
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing provider event id", mutate({ providerEventId: null })],
    ["blank provider market id", mutate({ providerMarketId: "  " })],
    ["missing game start", mutate({ gameStartIso: null })],
    ["stringified null game start", mutate({ gameStartIso: "null" })],
    ["blank condition id", mutate({}, { condition_id: "" })],
  ];

  for (const [label, row] of cases) {
    const built = await p.buildFireModelCandidates(100, "all", true, [row], "CONTRACT_A_PLANNING_V1", NOW);
    assert.equal(built.candidates.length, 0, `${label} must not produce a Planning candidate`);
    assert.equal(
      built.rawDiagnostics?.rejected_before_planning_by_reason.MISSING_EXACT_PROVIDER_IDENTITY,
      1,
      `${label} must be rejected as MISSING_EXACT_PROVIDER_IDENTITY`,
    );
  }
});
