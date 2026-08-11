import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Real production-shaped entrypoint test (correction commit) ─────────────
// Exercises the actual discoverSportsMarkets({ persistInventory: true }) path
// -- the same call scripts/generate-signals.ts makes in production -- with
// only the network (polymarketClient) and Supabase-writing boundaries
// (cacheSportsEventMarketInventory's writer, cacheGeneratedSignals's writer)
// replaced by in-memory fakes via node:test's mock.module. Everything between
// those boundaries (tag classification, inventory row building, the broad
// adapter) runs as real production code, unmocked.
//
// Single test, single mock setup, single dynamic import: node's ESM module
// cache binds discoverSportsMarkets.ts's static imports of polymarketClient /
// cacheSportsEventMarketInventory / cacheGeneratedSignals at first load and
// does not rebind them for a later mock.module() call in the same process,
// so every scenario below is exercised through one shared mocked fixture set
// rather than split across multiple tests/imports.
//
// Run with: node --experimental-test-module-mocks --import tsx --test \
//   tests/feed/broadSignalPairRealEntrypoint.test.ts

function keysetEvent(opts: {
  id: string;
  slug: string;
  title: string;
  startTime: string;
  tagIds: string[];
  tagSlugs?: Record<string, string>;
  markets: Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    id: opts.id,
    slug: opts.slug,
    title: opts.title,
    startTime: opts.startTime,
    active: true,
    closed: false,
    tags: opts.tagIds.map((id) => ({ id, label: id, ...(opts.tagSlugs?.[id] ? { slug: opts.tagSlugs[id] } : {}) })),
    markets: opts.markets,
  };
}

function twoOutcomeMarket(id: string, conditionId: string): Record<string, unknown> {
  return {
    id,
    slug: `${id}-slug`,
    question: "Market",
    conditionId,
    clobTokenIds: [`${id}-tok-a`, `${id}-tok-b`],
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.6", "0.4"],
    category: "Sports",
    sportsMarketType: "moneyline",
    volume: 10000,
    volume24hr: 2000,
    endDate: "2026-08-02T00:00:00.000Z",
  };
}

test("RED: the real persistInventory:true entrypoint activates the broad adapter, captures both outcomes of a market, keeps a future provider sport, and excludes non-sports", async () => {
  const basketballEvent = keysetEvent({
    id: "evt-basketball-1",
    slug: "basketball-1",
    title: "Basketball Game",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["301"],
    markets: [twoOutcomeMarket("mkt-basketball-1", "cond-basketball-1")],
  });
  const soccerEvent = keysetEvent({
    id: "evt-soccer-rus-1",
    slug: "soccer-rus-1",
    title: "Soccer Game",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    tagSlugs: { "303": "soccer" },
    markets: [twoOutcomeMarket("mkt-soccer-rus-1", "cond-soccer-rus-1")],
  });
  // rugby-sevens is never hardcoded anywhere in the codebase's business
  // logic -- it reaches the writer purely because /sports metadata
  // structurally declares tag 309 for it below.
  const rugbyEvent = keysetEvent({
    id: "evt-rugby-1",
    slug: "rugby-1",
    title: "Rugby Sevens Match",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["309"],
    markets: [twoOutcomeMarket("mkt-rugby-1", "cond-rugby-1")],
  });
  const nonSportsEvent = keysetEvent({
    id: "evt-election-1",
    slug: "election-1",
    title: "Election Outcome",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["999"],
    markets: [twoOutcomeMarket("mkt-election-1", "cond-election-1")],
  });

  mock.module("../../lib/feed/polymarketClient", {
    namedExports: {
      fetchSportsMetadata: async () => ({
        sports: [
          { sport: "baseball", tags: "300,1" },
          { sport: "basketball", tags: "301,1" },
          { sport: "rus", tags: "303,1" },
          { sport: "rugby-sevens", tags: "309,1" },
        ],
        tagIds: ["300", "301", "303", "309", "1"],
        success: true,
      }),
      fetchTeams: async () => ({ teams: [], count: 0 }),
      fetchActiveEventsByStartWindowKeysetSafe: async () => ({
        events: [basketballEvent, soccerEvent, rugbyEvent, nonSportsEvent],
        pagesFetched: 1,
        truncated: false,
        errorState: null,
      }),
      fetchMarketsBySportsTag: async () => [],
      fetchEventsByTagSlugSafe: async () => [],
      fetchEventsBySeriesSafe: async () => [],
      fetchPolymarketEventsByTagSafe: async () => [],
      fetchTagIdBySlugSafe: async () => null,
    },
  });

  let writeInventoryCalls = 0;
  mock.module("../../lib/feed/cacheSportsEventMarketInventory", {
    namedExports: {
      classifySportsConfirmation: (
        event: Record<string, unknown>,
        ctx: { specificSportsTagIds: Set<string> },
      ) => {
        const tags = Array.isArray(event.tags) ? (event.tags as Array<{ id: string }>) : [];
        const isConfirmedSports = tags.some((t) => ctx.specificSportsTagIds.has(String(t.id)));
        return { isConfirmedSports, source: isConfirmedSports ? "structured_sports_tag" : "no_sports_tag_match" };
      },
      buildSportsEventMarketInventoryRows: (
        events: Array<Record<string, unknown>>,
        opts: { observedAt: string; snapshotRunId: string },
      ) => {
        const rows: Record<string, unknown>[] = [];
        for (const ev of events) {
          const markets = Array.isArray(ev.markets) ? (ev.markets as Array<Record<string, unknown>>) : [];
          for (const mkt of markets) {
            rows.push({
              provider: "polymarket",
              providerEventId: String(ev.id),
              providerEventSlug: String(ev.slug ?? ""),
              providerMarketId: String(mkt.id),
              providerMarketSlug: String(mkt.slug ?? ""),
              eventTitle: String(ev.title ?? ""),
              marketQuestion: String(mkt.question ?? ""),
              eventStartIso: String(ev.startTime),
              marketEndIso: String(mkt.endDate ?? ""),
              conditionId: String(mkt.conditionId ?? ""),
              clobTokenIds: mkt.clobTokenIds,
              outcomes: mkt.outcomes,
              outcomePrices: mkt.outcomePrices,
              providerTags: ev.tags,
              rawCategory: String(mkt.category ?? ""),
              leagueHint: null,
              sportsMarketType: String(mkt.sportsMarketType ?? ""),
              volumeUsd: typeof mkt.volume === "number" ? mkt.volume : null,
              volume24hrUsd: typeof mkt.volume24hr === "number" ? mkt.volume24hr : null,
              isConfirmedSports: (ev as { isConfirmedSports?: boolean }).isConfirmedSports ?? false,
              sportsConfirmationSource: (ev as { sportsConfirmationSource?: string }).sportsConfirmationSource,
              siblingMarketCount: markets.length,
              snapshotRunId: opts.snapshotRunId,
              observedAt: opts.observedAt,
              expiresAt: opts.observedAt,
            });
          }
        }
        return {
          rows,
          diagnostics: {
            eventsSeen: events.length,
            marketsSeen: rows.length,
            rowsBuilt: rows.length,
            rowsSkippedMissingEventId: 0,
            rowsSkippedMissingMarketId: 0,
            rowsSkippedInvalidStart: 0,
            maxSiblingMarketCount: 1,
          },
        };
      },
      writeSportsEventMarketInventory: async (rows: unknown[]) => {
        writeInventoryCalls += 1;
        return { attempted: rows.length, inserted: rows.length, batches: 1, failed: false, errorCode: null, errorMessage: null };
      },
    },
  });

  let writtenBroadRows: unknown[] | null = null;
  mock.module("../../lib/feed/cacheGeneratedSignals", {
    namedExports: {
      writeStrategicShadowPairs: async (candidates: unknown[]) => {
        writtenBroadRows = candidates;
        return { inserted: candidates.length, materializationRecords: [] };
      },
    },
  });

  const { discoverSportsMarkets } = await import("../../lib/feed/discoverSportsMarkets");

  // persistInventory unset (default false): the broad adapter must not run at all.
  const readOnlyResult = await discoverSportsMarkets();
  assert.equal(writeInventoryCalls, 0, "persistInventory unset must never invoke the inventory writer");
  assert.equal(writtenBroadRows, null, "persistInventory unset must never invoke the broad Signal Pair writer");
  assert.equal(readOnlyResult.counts.broadSportsRowsProposed, undefined);

  // persistInventory:true -- the exact production entrypoint call shape
  // (scripts/generate-signals.ts:404 -- discoverSportsMarkets({ persistInventory: true })).
  const result = await discoverSportsMarkets({ persistInventory: true });
  assert.equal(writeInventoryCalls, 1, "persistInventory:true must invoke the inventory writer exactly once");
  assert.ok(writtenBroadRows, "persistInventory:true must invoke the broad Signal Pair writer");
  const rows = writtenBroadRows as Array<{
    providerEventId: string;
    selectedOutcome: string | null;
    selectedTokenId: string;
    providerSportCode: string | null;
    providerSportFamily: string | null;
  }>;

  // 4 events reach the keyset, but only 3 are structurally confirmed sports
  // (basketball, soccer, rugby) -- election is not.
  assert.equal(result.counts.confirmedSportsEvents48h, 3);

  // Three 2-outcome confirmed-sports markets -> six writer rows total.
  assert.equal(rows.length, 6, "all confirmed-sports markets' full outcome sets must reach the writer");
  const byEvent = (id: string) => rows.filter((r) => r.providerEventId === id);

  const basketballRows = byEvent("evt-basketball-1");
  assert.equal(basketballRows.length, 2, "one two-outcome market must produce two writer rows");
  assert.deepEqual(new Set(basketballRows.map((r) => r.selectedTokenId)), new Set(["mkt-basketball-1-tok-a", "mkt-basketball-1-tok-b"]));
  assert.deepEqual(new Set(basketballRows.map((r) => r.selectedOutcome)), new Set(["Yes", "No"]));
  assert.equal(basketballRows[0].providerSportCode, "basketball");

  const soccerRows = byEvent("evt-soccer-rus-1");
  assert.equal(soccerRows.length, 2);
  assert.equal(soccerRows[0].providerSportCode, "rus", "raw league/provider code remains unchanged");
  assert.equal(soccerRows[0].providerSportFamily, "soccer", "canonical family survives the real discovery entrypoint");

  const rugbyRows = byEvent("evt-rugby-1");
  assert.equal(rugbyRows.length, 2, "a future/unsupported provider sport tag must still reach the writer with both outcomes");
  assert.equal(rugbyRows[0].providerSportCode, "rugby-sevens");

  assert.equal(byEvent("evt-election-1").length, 0, "a structurally non-sports event must never reach the broad writer");

  assert.equal(result.counts.broadSportsRowsProposed, 6);
  assert.equal(result.counts.broadSportsWriteInserted, 6);
});
