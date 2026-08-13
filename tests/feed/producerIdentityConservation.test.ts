import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Producer identity propagation + writer conservation ────────────────────
// Everything from the raw provider inventory row through normalization
// (buildBroadStructuredSportsShadowEntries) to the row objects handed to
// Supabase runs as REAL production code. Only the database boundary
// (@/lib/supabase/server) is replaced by an in-memory fake -- the producer
// logic under test is never mocked.
//
// Run with: node --experimental-test-module-mocks --import tsx --test \
//   tests/feed/producerIdentityConservation.test.ts

import type { SportsEventMarketInventoryRow } from "../../lib/feed/cacheSportsEventMarketInventory";
import {
  buildBroadStructuredSportsShadowEntries,
  buildProviderSportMetadataMap,
} from "../../lib/feed/discoverSportsMarkets";
import { hasStructuredScoredSportAuthority } from "../../lib/feed/sportScoreOwnership";
import type { LandingCardPair } from "../../lib/feed/types";

const OBSERVED_AT = "2030-01-01T00:00:00.000Z";
const START_ISO = "2030-01-02T18:30:00.000Z";

/** Raw /sports metadata: tag 301 structurally declares basketball. */
const SPORTS_RAW = [
  { sport: "basketball", tags: "301,1", series: "12001" },
  { sport: "soccer", tags: "302,1", series: "12002" },
];

function inventoryRow(
  n: number,
  overrides: Partial<SportsEventMarketInventoryRow> = {},
): SportsEventMarketInventoryRow {
  return {
    provider: "polymarket",
    providerEventId: `pm-event-${n}`,
    providerEventSlug: `event-slug-${n}`,
    providerMarketId: `pm-market-${n}`,
    providerMarketSlug: `market-slug-${n}`,
    eventTitle: `Team A${n} vs Team B${n}`,
    marketQuestion: `Will Team A${n} beat Team B${n}?`,
    eventStartIso: START_ISO,
    marketEndIso: "2030-01-02T21:30:00.000Z",
    conditionId: `cond-${n}`,
    clobTokenIds: [`tok-${n}-a`, `tok-${n}-b`],
    outcomes: ["Team A", "Team B"],
    outcomePrices: ["0.55", "0.45"],
    providerTags: [{ id: "301" }, { id: "1" }],
    rawCategory: "Sports",
    leagueHint: null,
    sportsMarketType: "moneyline",
    volumeUsd: 25000,
    volume24hrUsd: 5000,
    isConfirmedSports: true,
    sportsConfirmationSource: "specific_sports_tag",
    siblingMarketCount: 1,
    snapshotRunId: "run-1",
    observedAt: OBSERVED_AT,
    expiresAt: OBSERVED_AT,
    ...overrides,
  };
}

function buildEntries(rows: SportsEventMarketInventoryRow[]) {
  return buildBroadStructuredSportsShadowEntries(
    rows,
    buildProviderSportMetadataMap(SPORTS_RAW),
    new Map(),
  );
}

// ── Fake DB boundary ───────────────────────────────────────────────────────
let insertedRows: Record<string, unknown>[] = [];
type ServingRow = {
  condition_id: string;
  selected_token_id: string;
  metric_formula_version: string;
  diagnostics?: Record<string, unknown>;
  projection_status: string;
  signal_result: string | null;
  expires_at: string;
};
let historicalGspRows: ServingRow[] = [];
let servingRows: ServingRow[] = [];
let selectQueries: Array<{ table: string; columns: string; filters: Record<string, unknown> }> = [];
let projectedSourceIds: string[][] = [];
let insertShouldFail = false;
let nextInsertedId = 0;

mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const q: Record<string, unknown> = {};
        q.select = (columns: string) => {
          selectQueries.push({ table, columns, filters });
          return q;
        };
        q.in = (_col: string, chunk: string[]) => {
          filters[_col] = chunk;
          return q;
        };
        q.eq = (column: string, value: unknown) => {
          filters[column] = value;
          return q;
        };
        q.is = (column: string, value: unknown) => {
          filters[`${column}:is`] = value;
          return q;
        };
        q.gt = (column: string, value: unknown) => {
          filters[`${column}:gt`] = value;
          return q;
        };
        Object.defineProperty(q, "data", {
          get: () => {
            const rows = table === "current_signal_pair_serving" ? servingRows : historicalGspRows;
            return rows.filter((row) => {
              const conditionIds = filters.condition_id;
              if (Array.isArray(conditionIds) && !conditionIds.includes(row.condition_id)) return false;
              if (filters.metric_formula_version && row.metric_formula_version !== filters.metric_formula_version) return false;
              if (filters.projection_status && row.projection_status !== filters.projection_status) return false;
              if (Object.prototype.hasOwnProperty.call(filters, "signal_result:is") && row.signal_result !== filters["signal_result:is"]) return false;
              if (filters["expires_at:gt"] && row.expires_at <= filters["expires_at:gt"]) return false;
              return true;
            });
          },
        });
        q.error = null;
        q.insert = (chunk: Record<string, unknown>[]) => {
          if (insertShouldFail) return { error: { message: "db exploded" }, count: null };
          insertedRows.push(...chunk);
          const data = chunk.map(() => ({ id: `00000000-0000-4000-8000-${String(++nextInsertedId).padStart(12, "0")}` }));
          return { select: () => ({ data, error: null, count: chunk.length }) };
        };
        return q;
      },
      rpc(_fn: string, args: { p_source_generated_signal_pair_ids: string[] }) {
        projectedSourceIds.push(args.p_source_generated_signal_pair_ids);
        return { error: null };
      },
    },
  },
});

// Loaded lazily so the mocked DB boundary is bound before first import.
type CacheModule = typeof import("../../lib/feed/cacheGeneratedSignals");
let cacheModule: CacheModule | null = null;
async function cache(): Promise<CacheModule> {
  if (!cacheModule) cacheModule = await import("../../lib/feed/cacheGeneratedSignals");
  return cacheModule;
}

function reset() {
  insertedRows = [];
  historicalGspRows = [];
  servingRows = [];
  selectQueries = [];
  projectedSourceIds = [];
  insertShouldFail = false;
  nextInsertedId = 0;
}

function activeServingRow(
  conditionId: string,
  selectedTokenId: string,
  metricFormulaVersion: string,
  diagnostics: Record<string, unknown>,
  overrides: Partial<ServingRow> = {},
): ServingRow {
  return {
    condition_id: conditionId,
    selected_token_id: selectedTokenId,
    metric_formula_version: metricFormulaVersion,
    diagnostics,
    projection_status: "ACTIVE",
    signal_result: null,
    expires_at: "2030-01-03T00:00:00.000Z",
    ...overrides,
  };
}

function researchPair(n: number): LandingCardPair {
  const conditionId = `research-condition-${n}`;
  const selectedTokenId = `research-token-${n}`;
  const providerEventId = `research-event-${n}`;
  const providerMarketId = `research-market-${n}`;
  return {
    premiumSignal: {
      eventTitle: `Research event ${n}`,
      marketQuestion: "Will side A win?",
      winProbability: 64,
      profit: "+12%",
      metrics: [],
    },
    marketSource: { headline: "Will side A win?" },
    diagnostics: {
      conditionId,
      selectedTokenId,
      selectedOutcome: "A",
      currentPrice: 0.4,
      dataCoverage: 40,
      gameStartIso: START_ISO,
      providerSportCode: "ucl",
      providerSportFamily: "soccer",
      providerEventId,
      providerMarketId,
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: providerEventId,
        eventStartIso: START_ISO,
        providerMarketId,
        sportFamily: "soccer",
        league: "ucl",
      },
    },
  } as unknown as LandingCardPair;
}

test("exact provider identity survives normalization and reaches the emitted Signal Pair row", async () => {
  reset();
  const { entries } = buildEntries([inventoryRow(1)]);
  assert.equal(entries.length, 2, "a two-outcome market proposes two rows");

  await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });

  assert.equal(insertedRows.length, 2);
  for (const row of insertedRows) {
    const diag = row.diagnostics as Record<string, unknown>;
    const ctx = diag.providerEventContext as Record<string, unknown>;

    // REGRESSION: shadow-strategic-sports-v1 rows previously carried only a
    // FLAT `providerEventId`. exactProviderEventIdentity() /
    // providerContextOf() read ONLY the structured `providerEventContext`
    // object, so every broad row arrived downstream with no provider
    // identity and fell back to slug-derived identity.
    assert.ok(ctx, "emitted row must carry structured providerEventContext");
    assert.equal(ctx.v, "v1");
    assert.equal(ctx.provider, "polymarket");

    // Provider event ID and the authoritative event start, preserved exactly.
    assert.equal(ctx.eventId, "pm-event-1");
    assert.equal(ctx.eventStartIso, START_ISO);
    assert.equal(ctx.providerMarketId, "pm-market-1");
    assert.equal(ctx.marketType, "moneyline");
    assert.equal(diag.gameStartIso, START_ISO, "authoritative start is unchanged");

    // Structured official sport attribution, from the /sports tag map -- not
    // parsed out of the title or slug.
    assert.equal(ctx.sportFamily, "basketball");
    assert.equal(diag.providerSportCode, "basketball");
    assert.equal(diag.providerSportSource, "structured_sports_tag");

    // condition_id / token_id lineage.
    assert.equal(row.condition_id, "cond-1");
    assert.ok(String(row.selected_token_id).startsWith("tok-1-"));
    assert.equal(diag.conditionId, "cond-1");
    assert.equal(diag.providerMarketId, "pm-market-1");
    assert.equal(diag.providerEventId, "pm-event-1");
  }

  // Both provider outcomes are materialized -- no side is fabricated.
  assert.deepEqual(
    new Set(insertedRows.map((r) => r.selected_outcome)),
    new Set(["Team A", "Team B"]),
  );
});

test("canonical sport family survives the broad carrier, persistence, and scorer authority independently of raw provider code", async () => {
  reset();
  const cases = [
    { tagFamily: "soccer", code: "rus", expectedFamily: "soccer", supported: true },
    { tagFamily: "tennis", code: "atp", expectedFamily: "tennis", supported: true },
    { tagFamily: "baseball", code: "mlb", expectedFamily: "baseball", supported: true },
    { tagFamily: "esports", code: "lol", expectedFamily: "esports", supported: true },
    { tagFamily: "esports", code: "cs2", expectedFamily: "esports", supported: true },
    { tagFamily: "esports", code: "val", expectedFamily: "esports", supported: true },
    { tagFamily: "basketball", code: "wnba", expectedFamily: "basketball", supported: true },
    { tagFamily: "cricket", code: "international-cricket", expectedFamily: "cricket", supported: true },
    { tagFamily: "rugby", code: "rugby-sevens", expectedFamily: null, supported: false },
    { tagFamily: "table-tennis", code: "setkameua", expectedFamily: "table-tennis", supported: false },
  ] as const;
  const sportsRaw = cases.map(({ code }, index) => ({ sport: code, tags: String(700 + index) }));
  const rows = cases.map(({ tagFamily }, index) => inventoryRow(index + 100, {
    providerTags: [{ id: String(700 + index), slug: tagFamily }],
  }));
  const { entries } = buildBroadStructuredSportsShadowEntries(
    rows,
    buildProviderSportMetadataMap(sportsRaw),
    new Map(),
  );

  assert.equal(entries.length, cases.length * 2);
  await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });
  assert.equal(insertedRows.length, entries.length);

  for (const [index, expected] of cases.entries()) {
    const entry = entries[index * 2];
    const row = insertedRows[index * 2];
    const diagnostics = row.diagnostics as Record<string, unknown>;
    const providerContext = diagnostics.providerEventContext as Record<string, unknown>;

    assert.equal(entry.providerSportCode, expected.code);
    assert.equal(entry.providerSportFamily, expected.expectedFamily);
    assert.notEqual(entry.providerSportCode, entry.providerSportFamily, "raw code and canonical family stay distinct");
    assert.equal(diagnostics.providerSportCode, expected.code);
    assert.equal(diagnostics.providerSportFamily, expected.expectedFamily);
    assert.equal(providerContext.league, expected.code);
    assert.equal(providerContext.sportFamily ?? null, expected.expectedFamily);
    assert.equal(hasStructuredScoredSportAuthority(diagnostics), expected.supported);
  }
});

test("shadow writer rebuilds from empty current serving without historical GSP suppression and projects inserted IDs", async () => {
  reset();
  const { entries } = buildEntries([inventoryRow(1)]);
  const candidate = entries[0];
  historicalGspRows = [activeServingRow(
    candidate.conditionId,
    candidate.selectedTokenId,
    "shadow-strategic-sports-v1",
    {
      providerSportCode: candidate.providerSportCode,
      providerSportFamily: candidate.providerSportFamily,
      providerEventId: candidate.providerEventId,
      providerMarketId: candidate.providerMarketId,
      providerEventContext: {
        eventId: candidate.providerEventId,
        providerMarketId: candidate.providerMarketId,
        sportFamily: candidate.providerSportFamily,
        league: candidate.providerSportCode,
      },
    },
  )];

  const detail = await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });

  assert.equal(detail.inserted, 2, "historical GSP rows must not suppress an empty-serving rebuild");
  assert.deepEqual(projectedSourceIds.map((ids) => ids.length), [2], "insert-returned GSP IDs remain the serving lineage input");
  assert.equal(selectQueries.filter((query) => query.table === "generated_signal_pairs").length, 0);
  const servingRead = selectQueries.find((query) => query.table === "current_signal_pair_serving");
  assert.deepEqual(servingRead?.filters.condition_id, ["cond-1"]);
  assert.equal(servingRead?.filters.metric_formula_version, "shadow-strategic-sports-v1");
  assert.equal(servingRead?.filters.projection_status, "ACTIVE");
  assert.equal(servingRead?.filters["signal_result:is"], null);
  assert.equal(typeof servingRead?.filters["expires_at:gt"], "string");
});

test("shadow dedup suppresses only active unresolved unexpired current-serving carrier matches", async () => {
  reset();
  const { entries } = buildEntries([inventoryRow(1)]);
  const candidate = entries[0];
  const diagnostics = {
    providerSportCode: candidate.providerSportCode,
    providerSportFamily: candidate.providerSportFamily,
    providerEventId: candidate.providerEventId,
    providerMarketId: candidate.providerMarketId,
    providerEventContext: {
      eventId: candidate.providerEventId,
      providerMarketId: candidate.providerMarketId,
      sportFamily: candidate.providerSportFamily,
      league: candidate.providerSportCode,
    },
  };
  servingRows = [activeServingRow(candidate.conditionId, candidate.selectedTokenId, "shadow-strategic-sports-v1", diagnostics)];

  const detail = await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });
  assert.equal(detail.inserted, 1);
  assert.equal(detail.conservation.rowsDeduped, 1);

  reset();
  servingRows = [activeServingRow(candidate.conditionId, candidate.selectedTokenId, "shadow-strategic-sports-v1", diagnostics, {
    expires_at: "2020-12-31T00:00:00.000Z",
  })];
  const rebuiltAfterExpiry = await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });
  assert.equal(rebuiltAfterExpiry.inserted, 2, "expired serving rows must not poison a current rebuild");

  reset();
  servingRows = [activeServingRow(candidate.conditionId, candidate.selectedTokenId, "shadow-strategic-sports-v1", diagnostics, {
    signal_result: "WON",
  })];
  const rebuiltAfterResolution = await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });
  assert.equal(rebuiltAfterResolution.inserted, 2, "resolved serving rows must not poison a current rebuild");
});

test("research writer uses current serving authority for rebuild, active dedup, and expiry", async () => {
  reset();
  const pair = researchPair(1);
  const diagnostics = pair.diagnostics as unknown as Record<string, unknown>;
  const conditionId = diagnostics.conditionId as string;
  const selectedTokenId = diagnostics.selectedTokenId as string;
  historicalGspRows = [activeServingRow(conditionId, selectedTokenId, "shadow-firemodel1_1_research_v0", diagnostics)];

  assert.equal(await (await cache()).writeFireModel1_1ResearchPairs([pair], OBSERVED_AT), 1);
  assert.equal(selectQueries.filter((query) => query.table === "generated_signal_pairs").length, 0);
  assert.equal(projectedSourceIds.flat().length, 1, "research keeps exact inserted-GSP ID lineage");

  reset();
  servingRows = [activeServingRow(conditionId, selectedTokenId, "shadow-firemodel1_1_research_v0", diagnostics)];
  assert.equal(await (await cache()).writeFireModel1_1ResearchPairs([pair], OBSERVED_AT), 0);

  reset();
  servingRows = [activeServingRow(conditionId, selectedTokenId, "shadow-firemodel1_1_research_v0", diagnostics, {
    expires_at: "2020-12-31T00:00:00.000Z",
  })];
  assert.equal(await (await cache()).writeFireModel1_1ResearchPairs([pair], OBSERVED_AT), 1);
});

test("a preexisting row with a dropped family is repaired by one corrected duplicate instead of blocking persistence", async () => {
  reset();
  const { entries } = buildEntries([inventoryRow(1)]);
  servingRows = [{
    condition_id: entries[0].conditionId,
    selected_token_id: entries[0].selectedTokenId,
    metric_formula_version: "shadow-strategic-sports-v1",
    projection_status: "ACTIVE",
    signal_result: null,
    expires_at: "2030-01-03T00:00:00.000Z",
    diagnostics: {
      providerSportCode: "basketball",
      providerSportFamily: null,
      providerEventId: entries[0].providerEventId,
      providerMarketId: entries[0].providerMarketId,
      providerEventContext: {
        eventId: entries[0].providerEventId,
        providerMarketId: entries[0].providerMarketId,
        sportFamily: "basketball",
        league: "basketball",
      },
    },
  }];

  const detail = await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });
  assert.equal(detail.inserted, 2, "the malformed preexisting carrier must not dedup either real outcome");
  assert.equal(detail.conservation.rowsDeduped, 0);
  const repaired = insertedRows.find((row) => row.selected_token_id === entries[0].selectedTokenId);
  const diagnostics = repaired?.diagnostics as Record<string, unknown>;
  assert.equal(diagnostics.providerSportCode, "basketball");
  assert.equal(diagnostics.providerSportFamily, "basketball");
  assert.equal(hasStructuredScoredSportAuthority(diagnostics), true);
});

test("tennis family remains scorer-authoritative when structured tags map to multiple raw provider codes", async () => {
  reset();
  const row = inventoryRow(250, { providerTags: [{ id: "950", slug: "tennis" }] });
  const sportMeta = buildProviderSportMetadataMap([
    { sport: "atp", tags: "950" },
    { sport: "wta", tags: "950" },
  ]);
  const { entries } = buildBroadStructuredSportsShadowEntries([row], sportMeta, new Map());
  assert.equal(entries[0].providerSportCode, null);
  assert.equal(entries[0].providerSportFamily, "tennis");
  await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });
  const diagnostics = insertedRows[0].diagnostics as Record<string, unknown>;
  const context = diagnostics.providerEventContext as Record<string, unknown>;
  assert.equal(diagnostics.providerSportCode, null);
  assert.equal(diagnostics.providerSportFamily, "tennis");
  assert.equal(context.league, undefined);
  assert.equal(context.sportFamily, "tennis");
  assert.equal(hasStructuredScoredSportAuthority(diagnostics), true);
});

test("identity is derived from provider fields only -- never reconstructed from title or slug", async () => {
  const { buildShadowProviderEventContext } = await cache();
  // No provider event id => no identity. The title and slug are present and
  // are deliberately NOT used as a fallback authority.
  const noId = buildShadowProviderEventContext({
    conditionId: "c",
    selectedTokenId: "t",
    entryPriceNum: 0.5,
    tier: 0,
    marketQuestion: "Will A beat B?",
    selectedOutcome: "A",
    eventSlug: "a-vs-b",
    eventTitle: "A vs B",
    eventEndIso: null,
    gameStartIso: START_ISO,
    shadowScope: "basketball",
    shadowReason: "BROAD_STRUCTURED_SPORTS_V1",
    providerEventId: null,
  });
  assert.equal(noId, null, "a missing provider event id must not be papered over with a slug");

  // Present id but an unparseable start => no identity either.
  const badStart = buildShadowProviderEventContext({
    conditionId: "c",
    selectedTokenId: "t",
    entryPriceNum: 0.5,
    tier: 0,
    marketQuestion: "Will A beat B?",
    selectedOutcome: "A",
    eventSlug: "a-vs-b",
    eventTitle: "A vs B",
    eventEndIso: null,
    gameStartIso: "not-a-date",
    shadowScope: "basketball",
    shadowReason: "BROAD_STRUCTURED_SPORTS_V1",
    providerEventId: "pm-event-9",
  });
  assert.equal(badStart, null, "an unparseable authoritative start must not yield an identity");
});

test("an expanded producer workload reaches the writer intact and conserves every row", async () => {
  reset();
  // 300 official events -- a production-shaped batch well beyond any single
  // provider page -- each with a two-outcome full-match market.
  const rows = Array.from({ length: 300 }, (_, i) => inventoryRow(i));
  const { entries, diagnostics } = buildEntries(rows);

  assert.equal(entries.length, 600, "300 two-outcome markets propose 600 rows");
  assert.equal(diagnostics.materialization.eventsConsidered, 300);
  assert.equal(diagnostics.materialization.outcomes.MATERIALIZED, 300);

  const detail = await (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true });

  assert.equal(detail.inserted, 600, "the whole expanded workload must reach the writer");
  assert.equal(insertedRows.length, 600);

  const c = detail.conservation;
  assert.equal(c.rowsProposed, 600);
  assert.equal(c.rowsInserted, 600);
  assert.equal(c.rowsDeduped, 0);
  assert.equal(c.rowsExplicitlyRejected, 0);
  assert.equal(c.writeFailed, false);
  assert.equal(c.conservationOk, true);
  assert.equal(c.rowsMissingProviderEventContext, 0, "every row carries exact identity");

  // Every enumerated event has a terminal outcome; none vanished.
  assert.equal(detail.materializationRecords.length, 600);
});

test("deduped and rejected rows are attributable -- proposed == inserted + deduped + rejected", async () => {
  reset();
  const good = inventoryRow(1);
  // Preexisting shadow row for one of event 2's tokens -> ROWS_DEDUPED.
  const already = inventoryRow(2);
  const { entries } = buildEntries([good, already]);
  const existingEntry = entries.find((entry) => entry.conditionId === "cond-2" && entry.selectedTokenId === "tok-2-a")!;
  servingRows = [{
    condition_id: existingEntry.conditionId,
    selected_token_id: existingEntry.selectedTokenId,
    metric_formula_version: "shadow-strategic-sports-v1",
    projection_status: "ACTIVE",
    signal_result: null,
    expires_at: "2030-01-03T00:00:00.000Z",
    diagnostics: {
      providerSportCode: existingEntry.providerSportCode,
      providerSportFamily: existingEntry.providerSportFamily,
      providerEventId: existingEntry.providerEventId,
      providerMarketId: existingEntry.providerMarketId,
      providerEventContext: {
        eventId: existingEntry.providerEventId,
        providerMarketId: existingEntry.providerMarketId,
        sportFamily: existingEntry.providerSportFamily,
        league: existingEntry.providerSportCode,
      },
    },
  }];
  // Duplicate one entry verbatim -> intra-batch ROWS_DEDUPED.
  const withDupe = [...entries, entries[0]];

  const detail = await (await cache()).writeStrategicShadowPairs(withDupe, OBSERVED_AT, { detailed: true });
  const c = detail.conservation;

  assert.equal(c.rowsProposed, 5, "4 real + 1 exact duplicate");
  assert.equal(c.rowsDeduped, 2, "1 intra-batch duplicate + 1 preexisting row");
  assert.equal(c.rowsInserted, 3);
  assert.equal(c.rowsExplicitlyRejected, 0);
  assert.equal(
    c.rowsProposed,
    c.rowsInserted + c.rowsDeduped + c.rowsExplicitlyRejected,
    "no row may silently disappear",
  );
  assert.equal(c.conservationOk, true);

  // The preexisting row still gets an explicit terminal outcome.
  const preexistingRecords = detail.materializationRecords.filter(
    (r) => r.outcome === "PREEXISTING_DEDUP",
  );
  assert.equal(preexistingRecords.length, 1);
  assert.equal(preexistingRecords[0].providerEventId, "pm-event-2");
});

test("a malformed outcome tuple is an explicit named rejection, not a silent drop", async () => {
  reset();
  const { entries } = buildEntries([inventoryRow(1)]);
  // Force the writer's fail-closed branch: a broad row with no provider side.
  const malformed = { ...entries[0], conditionId: "cond-x", selectedOutcome: null };

  const detail = await (await cache()).writeStrategicShadowPairs([...entries, malformed], OBSERVED_AT, {
    detailed: true,
  });
  const c = detail.conservation;

  assert.equal(c.rowsProposed, 3);
  assert.equal(c.rowsInserted, 2);
  assert.equal(c.rowsExplicitlyRejected, 1);
  assert.equal(c.rejectionsByReason.MALFORMED_OUTCOME_TUPLE, 1);
  assert.equal(c.conservationOk, true, "the rejection keeps the ledger balanced");
});

test("every non-materialized event receives an explicit terminal outcome at the producer stage", () => {
  const materialized = inventoryRow(1);
  // No condition id -> identity incomplete.
  const noIdentity = inventoryRow(2, { conditionId: null });
  // Token/outcome/price arrays disagree -> index-unsafe, whole market skipped.
  const mismatched = inventoryRow(3, { outcomes: ["Only One"] });
  // Not a full-match market type and no usable tokens.
  const noTokens = inventoryRow(4, { clobTokenIds: [], sportsMarketType: "player_props" });

  const { diagnostics } = buildEntries([materialized, noIdentity, mismatched, noTokens]);
  const ledger = diagnostics.materialization;

  assert.equal(ledger.eventsConsidered, 4, "EVENTS_CONSIDERED");
  assert.equal(ledger.outcomes.MATERIALIZED, 1, "EVENTS_MATERIALIZED");
  assert.equal(
    ledger.outcomeTotal,
    ledger.eventsConsidered,
    "EVENTS_MATERIALIZED + EVENTS_EXPLICITLY_SKIPPED == EVENTS_CONSIDERED",
  );
  assert.equal(ledger.conservationOk, true);

  // Each skipped event names its own reason -- none is unaccounted for.
  const byEvent = new Map(
    diagnostics.materializationRecords.map((r) => [r.providerEventId, r.outcome]),
  );
  assert.equal(byEvent.get("pm-event-1"), "MATERIALIZED");
  assert.equal(byEvent.get("pm-event-2"), "EXACT_IDENTITY_INCOMPLETE");
  assert.equal(byEvent.get("pm-event-3"), "EXACT_IDENTITY_INCOMPLETE");
  assert.equal(byEvent.get("pm-event-4"), "EXACT_IDENTITY_INCOMPLETE");
  assert.equal(byEvent.size, 4, "every considered event has exactly one terminal record");
});

test("a write failure is recorded as WRITE_FAILED rather than losing the remaining rows", async () => {
  reset();
  insertShouldFail = true;
  const { entries } = buildEntries([inventoryRow(1)]);

  await assert.rejects(
    async () => (await cache()).writeStrategicShadowPairs(entries, OBSERVED_AT, { detailed: true }),
    /Failed to write shadow pairs/,
  );
  assert.equal(insertedRows.length, 0, "nothing may be reported as inserted on failure");
});
