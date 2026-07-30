import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSportsEventMarketInventoryRows,
  writeSportsEventMarketInventory,
  SPORTS_INVENTORY_CONFLICT_TARGET,
  type SportsInventoryRawEvent,
} from "../../lib/feed/cacheSportsEventMarketInventory";

const OBSERVED_AT = "2026-07-30T12:00:00.000Z";
const SNAPSHOT_RUN_ID = "11111111-1111-1111-1111-111111111111";

function opts() {
  return { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID };
}

// ── Production-provider-shaped fixtures (real Gamma /events/keyset shape) ──

function sixMarketEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-mlb-0001",
    slug: "mlb-nyy-bos-2026-08-01",
    title: "Yankees vs Red Sox",
    startTime: "2026-08-01T23:05:00.000Z",
    tags: [{ id: "100381", label: "MLB", slug: "mlb" }],
    markets: [
      { id: "mkt-moneyline", slug: "mlb-nyy-bos-moneyline", question: "Yankees vs Red Sox: Moneyline", conditionId: "cond-1", clobTokenIds: ["tok-1a", "tok-1b"], outcomes: ["Yankees", "Red Sox"], outcomePrices: ["0.55", "0.45"], category: "MLB", sportsMarketType: "moneyline", volume: 120000, volume24hr: 30000, endDate: "2026-08-02T04:00:00.000Z" },
      { id: "mkt-spread", slug: "mlb-nyy-bos-spread", question: "Yankees vs Red Sox: Run Line", conditionId: "cond-2", clobTokenIds: ["tok-2a", "tok-2b"], outcomes: ["Yankees -1.5", "Red Sox +1.5"], outcomePrices: ["0.48", "0.52"], category: "MLB", sportsMarketType: "spread", volume: 40000, volume24hr: 8000, endDate: "2026-08-02T04:00:00.000Z" },
      { id: "mkt-total", slug: "mlb-nyy-bos-total", question: "Yankees vs Red Sox: Total Runs", conditionId: "cond-3", clobTokenIds: ["tok-3a", "tok-3b"], outcomes: ["Over 8.5", "Under 8.5"], outcomePrices: ["0.51", "0.49"], category: "MLB", sportsMarketType: "total", volume: 15000, volume24hr: 3000, endDate: "2026-08-02T04:00:00.000Z" },
      { id: "mkt-btts", slug: "mlb-nyy-bos-btts", question: "Both teams to score 3+", conditionId: "cond-4", clobTokenIds: ["tok-4a", "tok-4b"], outcomes: ["Yes", "No"], outcomePrices: ["0.6", "0.4"], category: "MLB", sportsMarketType: "prop", volume: 2000, volume24hr: 500, endDate: "2026-08-02T04:00:00.000Z" },
      { id: "mkt-prop-hr", slug: "mlb-nyy-bos-aaron-judge-hr", question: "Aaron Judge to hit a home run", conditionId: "cond-5", clobTokenIds: ["tok-5a", "tok-5b"], outcomes: ["Yes", "No"], outcomePrices: ["0.3", "0.7"], category: "MLB", sportsMarketType: "player_prop", volume: 900, volume24hr: 200, endDate: "2026-08-02T04:00:00.000Z" },
      { id: "mkt-1st5", slug: "mlb-nyy-bos-first-5-innings", question: "Yankees vs Red Sox: First 5 Innings Winner", conditionId: "cond-6", clobTokenIds: ["tok-6a", "tok-6b"], outcomes: ["Yankees", "Red Sox"], outcomePrices: ["0.53", "0.47"], category: "MLB", sportsMarketType: "moneyline", volume: 5000, volume24hr: 1000, endDate: "2026-08-02T04:00:00.000Z" },
    ],
  };
}

function wnbaEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-wnba-0001",
    slug: "wnba-lv-ny-2026-08-01",
    title: "Aces vs Liberty",
    startTime: "2026-08-01T20:00:00.000Z",
    tags: [{ id: "100400", label: "WNBA", slug: "wnba" }],
    markets: [
      { id: "mkt-wnba-ml", slug: "wnba-lv-ny-moneyline", question: "Aces vs Liberty: Moneyline", conditionId: "cond-wnba-1", clobTokenIds: ["tok-w1a", "tok-w1b"], outcomes: ["Aces", "Liberty"], outcomePrices: ["0.4", "0.6"], category: "WNBA" },
    ],
  };
}

function threeWaySoccerEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-epl-0001",
    slug: "epl-ars-che-2026-08-02",
    title: "Arsenal vs Chelsea",
    startTime: "2026-08-02T14:00:00.000Z",
    tags: [{ id: "100200", label: "Premier League", slug: "epl" }],
    markets: [
      { id: "mkt-1x2", slug: "epl-ars-che-1x2", question: "Arsenal vs Chelsea: Match Result", conditionId: "cond-1x2", clobTokenIds: ["tok-a", "tok-b", "tok-c"], outcomes: ["Arsenal", "Draw", "Chelsea"], outcomePrices: ["0.45", "0.28", "0.27"], category: "Soccer" },
    ],
  };
}

function tennisEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-atp-0001",
    slug: "atp-alcaraz-sinner-2026-08-03",
    title: "Alcaraz vs Sinner",
    startTime: "2026-08-03T15:00:00.000Z",
    tags: [{ id: "100500", label: "Tennis", slug: "atp" }],
    markets: [
      { id: "mkt-tennis-ml", slug: "atp-alcaraz-sinner-moneyline", question: "Alcaraz vs Sinner: Winner", conditionId: "cond-tennis-1", clobTokenIds: ["tok-t1a", "tok-t1b"], outcomes: ["Alcaraz", "Sinner"], outcomePrices: ["0.6", "0.4"], category: "Tennis" },
    ],
  };
}

function nhlEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-nhl-0001",
    slug: "nhl-tor-bos-2026-08-04",
    title: "Maple Leafs vs Bruins",
    startTime: "2026-08-04T23:00:00.000Z",
    tags: [{ id: "100600", label: "NHL", slug: "nhl" }],
    markets: [
      { id: "mkt-nhl-ml", slug: "nhl-tor-bos-moneyline", question: "Maple Leafs vs Bruins: Moneyline", conditionId: "cond-nhl-1", clobTokenIds: ["tok-n1a", "tok-n1b"], outcomes: ["Maple Leafs", "Bruins"], outcomePrices: ["0.5", "0.5"], category: "NHL" },
    ],
  };
}

function ufcEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-ufc-0001",
    slug: "ufc-fighter-a-fighter-b-2026-08-05",
    title: "Fighter A vs Fighter B",
    startTime: "2026-08-05T02:00:00.000Z",
    tags: [{ id: "100700", label: "UFC", slug: "ufc" }],
    markets: [
      { id: "mkt-ufc-ml", slug: "ufc-a-b-moneyline", question: "Fighter A vs Fighter B: Winner", conditionId: "cond-ufc-1", clobTokenIds: ["tok-u1a", "tok-u1b"], outcomes: ["Fighter A", "Fighter B"], outcomePrices: ["0.65", "0.35"], category: "MMA" },
    ],
  };
}

function cflEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-cfl-0001",
    slug: "cfl-tor-mtl-2026-08-06",
    title: "Argonauts vs Alouettes",
    startTime: "2026-08-06T23:00:00.000Z",
    tags: [{ id: "100800", label: "CFL", slug: "cfl" }],
    markets: [
      { id: "mkt-cfl-ml", slug: "cfl-tor-mtl-moneyline", question: "Argonauts vs Alouettes: Moneyline", conditionId: "cond-cfl-1", clobTokenIds: ["tok-c1a", "tok-c1b"], outcomes: ["Argonauts", "Alouettes"], outcomePrices: ["0.5", "0.5"], category: "CFL" },
    ],
  };
}

function pickleballEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-pball-0001",
    slug: "pickleball-player-x-player-y-2026-08-07",
    title: "Player X vs Player Y",
    startTime: "2026-08-07T18:00:00.000Z",
    tags: [{ id: "100900", label: "Pickleball", slug: "pickleball" }],
    markets: [
      { id: "mkt-pball-ml", slug: "pickleball-x-y-moneyline", question: "Player X vs Player Y: Winner", conditionId: "cond-pball-1", clobTokenIds: ["tok-p1a", "tok-p1b"], outcomes: ["Player X", "Player Y"], outcomePrices: ["0.5", "0.5"], category: "Pickleball" },
    ],
  };
}

function cricketEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-cricket-0001",
    slug: "cricket-ind-aus-2026-08-08",
    title: "India vs Australia",
    startTime: "2026-08-08T09:00:00.000Z",
    tags: [{ id: "101000", label: "Cricket", slug: "cricket" }],
    markets: [
      { id: "mkt-cricket-ml", slug: "cricket-ind-aus-moneyline", question: "India vs Australia: Match Winner", conditionId: "cond-cricket-1", clobTokenIds: ["tok-cr1a", "tok-cr1b"], outcomes: ["India", "Australia"], outcomePrices: ["0.55", "0.45"], category: "Cricket" },
    ],
  };
}

function esportsEvent(): SportsInventoryRawEvent {
  return {
    id: "evt-cs2-0001",
    slug: "cs2-teamx-teamy-2026-08-09",
    title: "Team X vs Team Y",
    startTime: "2026-08-09T18:00:00.000Z",
    tags: [{ id: "101100", label: "Esports", slug: "cs2" }],
    markets: [
      { id: "mkt-cs2-match", slug: "cs2-x-y-match-winner", question: "Team X vs Team Y: Match Winner", conditionId: "cond-cs2-1", clobTokenIds: ["tok-e1a", "tok-e1b"], outcomes: ["Team X", "Team Y"], outcomePrices: ["0.5", "0.5"], category: "Esports" },
      { id: "mkt-cs2-map1", slug: "cs2-x-y-map-1-winner", question: "Team X vs Team Y: Map 1 Winner", conditionId: "cond-cs2-2", clobTokenIds: ["tok-e2a", "tok-e2b"], outcomes: ["Team X", "Team Y"], outcomePrices: ["0.5", "0.5"], category: "Esports", sportsMarketType: "map_handicap" },
    ],
  };
}

function eventInside24to48h(): SportsInventoryRawEvent {
  return {
    id: "evt-nba-0002",
    slug: "nba-lal-bos-2026-08-01",
    title: "Lakers vs Celtics",
    startTime: new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString(),
    tags: [{ id: "100300", label: "NBA", slug: "nba" }],
    markets: [
      { id: "mkt-nba-ml", slug: "nba-lal-bos-moneyline", question: "Lakers vs Celtics: Moneyline", conditionId: "cond-nba-1", clobTokenIds: ["tok-nba1a", "tok-nba1b"], outcomes: ["Lakers", "Celtics"], outcomePrices: ["0.5", "0.5"], category: "NBA" },
    ],
  };
}

// ── RED-state / core contract test ──────────────────────────────────────

test("one provider event with six nested markets maps to six inventory rows sharing one provider_event_id", () => {
  const { rows, diagnostics } = buildSportsEventMarketInventoryRows([sixMarketEvent()], opts());

  assert.equal(rows.length, 6);
  assert.equal(diagnostics.rowsBuilt, 6);
  assert.equal(diagnostics.eventsSeen, 1);
  assert.equal(diagnostics.marketsSeen, 6);
  assert.equal(diagnostics.maxSiblingMarketCount, 6);

  const eventIds = new Set(rows.map((r) => r.providerEventId));
  assert.equal(eventIds.size, 1);
  assert.equal([...eventIds][0], "evt-mlb-0001");

  const marketIds = new Set(rows.map((r) => r.providerMarketId));
  assert.equal(marketIds.size, 6);
  assert.deepEqual(
    [...marketIds].sort(),
    ["mkt-1st5", "mkt-btts", "mkt-moneyline", "mkt-prop-hr", "mkt-spread", "mkt-total"].sort(),
  );

  for (const r of rows) {
    assert.equal(r.siblingMarketCount, 6);
  }
});

test("provider_event_id and provider_market_id remain byte-identical", () => {
  const { rows } = buildSportsEventMarketInventoryRows([wnbaEvent()], opts());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].providerEventId, "evt-wnba-0001");
  assert.equal(rows[0].providerMarketId, "mkt-wnba-ml");
});

test("event_start_iso is exact and parseable", () => {
  const { rows } = buildSportsEventMarketInventoryRows([tennisEvent()], opts());
  assert.equal(rows[0].eventStartIso, "2026-08-03T15:00:00.000Z");
  assert.equal(Number.isNaN(Date.parse(rows[0].eventStartIso)), false);
});

test("provider_tags are preserved verbatim", () => {
  const { rows } = buildSportsEventMarketInventoryRows([nhlEvent()], opts());
  assert.deepEqual(rows[0].providerTags, [{ id: "100600", label: "NHL", slug: "nhl" }]);
});

test("parent/sibling relationship is exact through shared provider_event_id", () => {
  const { rows } = buildSportsEventMarketInventoryRows([esportsEvent()], opts());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].providerEventId, rows[1].providerEventId);
  assert.equal(rows[0].siblingMarketCount, 2);
  assert.equal(rows[1].siblingMarketCount, 2);
});

test("three-way soccer market is captured", () => {
  const { rows } = buildSportsEventMarketInventoryRows([threeWaySoccerEvent()], opts());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].outcomes, ["Arsenal", "Draw", "Chelsea"]);
});

test("player prop market is captured", () => {
  const { rows } = buildSportsEventMarketInventoryRows([sixMarketEvent()], opts());
  const prop = rows.find((r) => r.providerMarketId === "mkt-prop-hr");
  assert.ok(prop);
  assert.equal(prop?.sportsMarketType, "player_prop");
});

test("esports map/round market is captured", () => {
  const { rows } = buildSportsEventMarketInventoryRows([esportsEvent()], opts());
  const map1 = rows.find((r) => r.providerMarketId === "mkt-cs2-map1");
  assert.ok(map1);
  assert.equal(map1?.sportsMarketType, "map_handicap");
});

test("no market is rejected because of odds, volume, market class, or outcome count", () => {
  const events = [
    sixMarketEvent(),
    wnbaEvent(),
    threeWaySoccerEvent(),
    tennisEvent(),
    nhlEvent(),
    ufcEvent(),
    cflEvent(),
    pickleballEvent(),
    cricketEvent(),
    esportsEvent(),
  ];
  const totalMarkets = events.reduce((sum, e) => sum + (e.markets?.length ?? 0), 0);
  const { rows, diagnostics } = buildSportsEventMarketInventoryRows(events, opts());
  assert.equal(rows.length, totalMarkets);
  assert.equal(diagnostics.rowsSkippedMissingEventId, 0);
  assert.equal(diagnostics.rowsSkippedMissingMarketId, 0);
  assert.equal(diagnostics.rowsSkippedInvalidStart, 0);
});

test("an event inside the 24-48h band is captured", () => {
  const { rows } = buildSportsEventMarketInventoryRows([eventInside24to48h()], opts());
  assert.equal(rows.length, 1);
});

test("two same-title occurrences with different provider IDs and start times remain separate", () => {
  const occurrenceA: SportsInventoryRawEvent = {
    id: "evt-rematch-a",
    slug: "rematch-a",
    title: "Team A vs Team B",
    startTime: "2026-08-10T18:00:00.000Z",
    tags: [{ id: "100300", label: "NBA", slug: "nba" }],
    markets: [{ id: "mkt-rematch-a-ml", slug: "rematch-a-ml", question: "Team A vs Team B: Moneyline", conditionId: "cond-ra", clobTokenIds: ["ra1", "ra2"], outcomes: ["A", "B"], outcomePrices: ["0.5", "0.5"] }],
  };
  const occurrenceB: SportsInventoryRawEvent = {
    id: "evt-rematch-b",
    slug: "rematch-b",
    title: "Team A vs Team B",
    startTime: "2026-08-17T18:00:00.000Z",
    tags: [{ id: "100300", label: "NBA", slug: "nba" }],
    markets: [{ id: "mkt-rematch-b-ml", slug: "rematch-b-ml", question: "Team A vs Team B: Moneyline", conditionId: "cond-rb", clobTokenIds: ["rb1", "rb2"], outcomes: ["A", "B"], outcomePrices: ["0.5", "0.5"] }],
  };
  const { rows } = buildSportsEventMarketInventoryRows([occurrenceA, occurrenceB], opts());
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].providerEventId, rows[1].providerEventId);
  assert.notEqual(rows[0].eventStartIso, rows[1].eventStartIso);
});

test("repeated input maps deterministically", () => {
  const events = [sixMarketEvent(), wnbaEvent()];
  const first = buildSportsEventMarketInventoryRows(events, opts());
  const second = buildSportsEventMarketInventoryRows(events, opts());
  assert.deepEqual(first.rows, second.rows);
  assert.deepEqual(first.diagnostics, second.diagnostics);
});

test("missing provider event ID is skipped with an explicit count", () => {
  const bad: SportsInventoryRawEvent = { ...sixMarketEvent(), id: "" };
  const { rows, diagnostics } = buildSportsEventMarketInventoryRows([bad], opts());
  assert.equal(rows.length, 0);
  assert.equal(diagnostics.rowsSkippedMissingEventId, 6);
});

test("missing provider market ID is skipped with an explicit count", () => {
  const base = sixMarketEvent();
  base.markets![0] = { ...base.markets![0], id: "" };
  const { rows, diagnostics } = buildSportsEventMarketInventoryRows([base], opts());
  assert.equal(rows.length, 5);
  assert.equal(diagnostics.rowsSkippedMissingMarketId, 1);
  assert.equal(diagnostics.rowsBuilt, 5);
});

test("missing or invalid event start is skipped with an explicit count", () => {
  const missingStart: SportsInventoryRawEvent = { ...sixMarketEvent(), startTime: undefined };
  const invalidStart: SportsInventoryRawEvent = { ...wnbaEvent(), id: "evt-bad-start", startTime: "not-a-date" };
  const { rows, diagnostics } = buildSportsEventMarketInventoryRows([missingStart, invalidStart], opts());
  assert.equal(rows.length, 0);
  assert.equal(diagnostics.rowsSkippedInvalidStart, 7); // 6 + 1
});

// ── Writer: bounded batching + conflict target ──────────────────────────

test("writer uses bounded batches of at most 500 rows", async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    provider: "polymarket" as const,
    providerEventId: `evt-${i}`,
    providerEventSlug: null,
    providerMarketId: `mkt-${i}`,
    providerMarketSlug: null,
    eventTitle: null,
    marketQuestion: null,
    eventStartIso: OBSERVED_AT,
    marketEndIso: null,
    conditionId: null,
    clobTokenIds: [],
    outcomes: [],
    outcomePrices: [],
    providerTags: [],
    rawCategory: null,
    leagueHint: null,
    sportsMarketType: null,
    volumeUsd: null,
    volume24hrUsd: null,
    siblingMarketCount: 1,
    snapshotRunId: SNAPSHOT_RUN_ID,
    observedAt: OBSERVED_AT,
    expiresAt: OBSERVED_AT,
  }));

  const batchSizes: number[] = [];
  const fakeRepoPort = {
    async upsertBatch(batch: Record<string, unknown>[]) {
      batchSizes.push(batch.length);
      return { error: null, count: batch.length };
    },
  };

  const result = await writeSportsEventMarketInventory(rows, { repoPort: fakeRepoPort });

  assert.deepEqual(batchSizes, [500, 500, 200]);
  assert.equal(result.batches, 3);
  assert.equal(result.inserted, 1200);
  assert.equal(result.failed, false);
});

test("upsert conflict target matches the occurrence-safe unique constraint", () => {
  assert.equal(
    SPORTS_INVENTORY_CONFLICT_TARGET,
    "provider,provider_event_id,provider_market_id,event_start_iso",
  );
});

test("writer surfaces batch failure without throwing (fail-open contract)", async () => {
  const rows = [
    {
      provider: "polymarket" as const,
      providerEventId: "evt-x",
      providerEventSlug: null,
      providerMarketId: "mkt-x",
      providerMarketSlug: null,
      eventTitle: null,
      marketQuestion: null,
      eventStartIso: OBSERVED_AT,
      marketEndIso: null,
      conditionId: null,
      clobTokenIds: [],
      outcomes: [],
      outcomePrices: [],
      providerTags: [],
      rawCategory: null,
      leagueHint: null,
      sportsMarketType: null,
      volumeUsd: null,
      volume24hrUsd: null,
      siblingMarketCount: 1,
      snapshotRunId: SNAPSHOT_RUN_ID,
      observedAt: OBSERVED_AT,
      expiresAt: OBSERVED_AT,
    },
  ];
  const fakeRepoPort = {
    async upsertBatch() {
      return { error: { message: "connection refused", code: "08006" }, count: null };
    },
  };

  const result = await writeSportsEventMarketInventory(rows, { repoPort: fakeRepoPort });
  assert.equal(result.failed, true);
  assert.equal(result.errorCode, "SPORTS_INVENTORY_BATCH_FAILED");
  assert.ok(result.errorMessage?.includes("connection refused"));
});
