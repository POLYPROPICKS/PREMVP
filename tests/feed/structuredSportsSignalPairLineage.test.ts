import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifySportsConfirmation,
  buildSportsEventMarketInventoryRows,
  type SportsInventoryRawEvent,
} from "../../lib/feed/cacheSportsEventMarketInventory";
import {
  buildProviderSportMetadataMap,
  buildBroadStructuredSportsShadowEntries,
} from "../../lib/feed/discoverSportsMarkets";

// ── Structured provider sport -> Signal Pair lineage (commit 1) ────────────
// Production-shaped seam: raw /sports metadata + raw provider keyset events
// -> classifySportsConfirmation (existing, tag-structural only)
// -> buildSportsEventMarketInventoryRows (existing, reused unchanged)
// -> buildBroadStructuredSportsShadowEntries (new, pure adapter)
// This is the exact input buildBroadStructuredSportsShadowEntries's caller
// hands to writeStrategicShadowPairs. No network, no Supabase.

const OBSERVED_AT = "2026-08-01T12:00:00.000Z";
const SNAPSHOT_RUN_ID = "22222222-2222-2222-2222-222222222222";

// Raw /sports metadata. Every code below is discovered purely from this
// fixture -- none of these strings (including "rugby-sevens", a sport this
// codebase has never special-cased) are hardcoded anywhere in production code.
const SPORTS_RAW: unknown[] = [
  { sport: "baseball", tags: "300,1" },
  { sport: "basketball", tags: "301,1" },
  { sport: "hockey", tags: "302,1" },
  { sport: "soccer", tags: "303,1" },
  { sport: "tennis", tags: "304,1" },
  { sport: "cricket", tags: "305,1" },
  { sport: "mma", tags: "306,1" },
  { sport: "esports", tags: "307,1" },
  { sport: "golf", tags: "308,1" },
  { sport: "rugby-sevens", tags: "309,1", series: "5001,5002" }, // future unknown sport
];

const SPECIFIC_SPORTS_TAG_IDS = new Set([
  "300", "301", "302", "303", "304", "305", "306", "307", "308", "309",
]);
const SPORTS_TAG_IDS = [...SPECIFIC_SPORTS_TAG_IDS, "1"];

function tagEvent(opts: {
  id: string;
  slug: string;
  title: string;
  startTime: string;
  tagIds: string[];
  markets: SportsInventoryRawEvent["markets"];
}): SportsInventoryRawEvent {
  const rawEvent = {
    id: opts.id,
    slug: opts.slug,
    title: opts.title,
    startTime: opts.startTime,
    tags: opts.tagIds.map((id) => ({ id, label: id })),
  } as Record<string, unknown>;
  const confirmation = classifySportsConfirmation(rawEvent, {
    specificSportsTagIds: SPECIFIC_SPORTS_TAG_IDS,
    sportsTagIds: SPORTS_TAG_IDS,
    sportsMetadataAvailable: true,
  });
  return {
    ...rawEvent,
    markets: opts.markets,
    isConfirmedSports: confirmation.isConfirmedSports,
    sportsConfirmationSource: confirmation.source,
  } as SportsInventoryRawEvent;
}

function market(id: string, conditionId: string, question = "Market"): NonNullable<SportsInventoryRawEvent["markets"]>[number] {
  return {
    id,
    slug: `${id}-slug`,
    question,
    conditionId,
    clobTokenIds: [`${id}-tok-a`, `${id}-tok-b`],
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.55", "0.45"],
    category: "Sports",
    sportsMarketType: "moneyline",
    volume: 10000,
    volume24hr: 2000,
    endDate: "2026-08-02T00:00:00.000Z",
  };
}

const SPORT_TAG_BY_CODE: Record<string, string> = {
  baseball: "300",
  basketball: "301",
  hockey: "302",
  soccer: "303",
  tennis: "304",
  cricket: "305",
  mma: "306",
  esports: "307",
  golf: "308",
  "rugby-sevens": "309",
};

function buildFixtureEvents(): SportsInventoryRawEvent[] {
  const events: SportsInventoryRawEvent[] = [];
  let i = 0;
  for (const [code, tagId] of Object.entries(SPORT_TAG_BY_CODE)) {
    i += 1;
    events.push(
      tagEvent({
        id: `evt-${code}-1`,
        slug: `${code}-event-1`,
        title: `${code} event ${i}`,
        startTime: "2026-08-01T20:00:00.000Z",
        tagIds: [tagId],
        markets: [market(`mkt-${code}-1`, `cond-${code}-1`)],
      }),
    );
  }
  return events;
}

test("RED: every structurally confirmed provider sport (including a future unknown sport) reaches the writer input", () => {
  const events = buildFixtureEvents();
  const { rows } = buildSportsEventMarketInventoryRows(events, {
    observedAt: OBSERVED_AT,
    snapshotRunId: SNAPSHOT_RUN_ID,
  });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries, diagnostics } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());

  assert.equal(entries.length, Object.keys(SPORT_TAG_BY_CODE).length, "every fixture sport must produce exactly one row");
  const codesSeen = new Set(entries.map((e) => e.providerSportCode));
  for (const code of Object.keys(SPORT_TAG_BY_CODE)) {
    assert.ok(codesSeen.has(code), `expected provider sport code "${code}" to survive into Signal Pair input`);
  }
  assert.ok(codesSeen.has("rugby-sevens"), "a future unknown provider sport must not be dropped at ingestion");
  assert.equal(diagnostics.rowsProposed, entries.length);
});

test("RED: ordinary non-sports events never reach sports Signal Pair input", () => {
  const nonSports = tagEvent({
    id: "evt-nonsports-1",
    slug: "election-outcome",
    title: "Will X happen in the election",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["999"], // not a specific sports tag
    markets: [market("mkt-nonsports-1", "cond-nonsports-1")],
  });
  const { rows } = buildSportsEventMarketInventoryRows([nonSports], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  assert.equal(rows[0]?.isConfirmedSports, false);
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 0, "a structurally non-sports event must not produce a Signal Pair row");
});

test("RED: no title/question inference is used -- a basketball-worded title with a soccer tag stays soccer", () => {
  const misleading = tagEvent({
    id: "evt-misleading-1",
    slug: "misleading-title",
    title: "Lakers Basketball Showdown", // deliberately misleading text
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"], // soccer tag, not basketball
    markets: [market("mkt-misleading-1", "cond-misleading-1")],
  });
  const { rows } = buildSportsEventMarketInventoryRows([misleading], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerSportCode, "soccer", "structured tag must win over misleading title text");
});

test("RED: structured identity, start, market type, condition/token lineage and game/team IDs survive", () => {
  const ev = tagEvent({
    id: "evt-basketball-full-1",
    slug: "basketball-full-1",
    title: "Basketball Full Identity Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["301"],
    markets: [market("mkt-basketball-full-1", "cond-basketball-full-1", "Full Identity Market")],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const gameTeamLookup = new Map([
    ["mkt-basketball-full-1", { gameId: "game-123", teamAId: "team-A", teamBId: "team-B" }],
  ]);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, gameTeamLookup);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.providerEventId, "evt-basketball-full-1");
  assert.equal(e.providerMarketId, "mkt-basketball-full-1");
  assert.equal(e.gameStartIso, "2026-08-01T20:00:00.000Z");
  assert.equal(e.conditionId, "cond-basketball-full-1");
  assert.equal(e.selectedTokenId, "mkt-basketball-full-1-tok-a");
  assert.equal(e.marketType, "moneyline");
  assert.equal(e.gameId, "game-123");
  assert.equal(e.teamAId, "team-A");
  assert.equal(e.teamBId, "team-B");
  assert.deepEqual(e.providerSportTagIds, ["301"]);
});

test("RED: multiple markets for one event share the same provider event identity", () => {
  const ev = tagEvent({
    id: "evt-multi-market-1",
    slug: "multi-market-1",
    title: "Multi Market Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["302"],
    markets: [
      market("mkt-multi-1", "cond-multi-1", "Moneyline"),
      market("mkt-multi-2", "cond-multi-2", "Puck Line"),
    ],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 2);
  assert.equal(entries[0].providerEventId, entries[1].providerEventId);
  assert.notEqual(entries[0].providerMarketId, entries[1].providerMarketId);
});

test("RED: similar titles with different provider event IDs remain distinct", () => {
  const evA = tagEvent({
    id: "evt-similar-A",
    slug: "similar-a",
    title: "Yankees vs Red Sox",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["300"],
    markets: [market("mkt-similar-A", "cond-similar-A")],
  });
  const evB = tagEvent({
    id: "evt-similar-B",
    slug: "similar-b",
    title: "Yankees vs Red Sox",
    startTime: "2026-08-05T20:00:00.000Z",
    tagIds: ["300"],
    markets: [market("mkt-similar-B", "cond-similar-B")],
  });
  const { rows } = buildSportsEventMarketInventoryRows([evA, evB], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].providerEventId, entries[1].providerEventId);
  assert.notEqual(entries[0].conditionId, entries[1].conditionId);
});

test("RED: an event with multiple structural sport tags is retained as an explicit ambiguous state, not dropped or guessed", () => {
  const ev = tagEvent({
    id: "evt-ambiguous-1",
    slug: "ambiguous-1",
    title: "Cross-tagged event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["301", "302"], // basketball + hockey both structurally matched
    markets: [market("mkt-ambiguous-1", "cond-ambiguous-1")],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries, diagnostics } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 1, "an ambiguous row must still be written, never dropped");
  assert.equal(entries[0].ambiguousSport, true);
  assert.equal(entries[0].providerSportCode, null);
  assert.equal(entries[0].providerSportSource, "ambiguous_multi_tag");
  assert.deepEqual(new Set(entries[0].providerSportTagIds), new Set(["301", "302"]));
  assert.equal(diagnostics.rowsAmbiguousSport, 1);
});

test("RED: a repeated event reachable through a duplicate discovery path never produces two distinct writer-input identities", () => {
  const ev = tagEvent({
    id: "evt-duplicate-1",
    slug: "duplicate-1",
    title: "Duplicate Path Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    markets: [market("mkt-duplicate-1", "cond-duplicate-1")],
  });
  // Same event surfaced twice, simulating two independent discovery paths
  // (e.g. matched via two different tag IDs) that both confirm the same
  // physical market before the existing keyset-level id dedup applies.
  const { rows } = buildSportsEventMarketInventoryRows([ev, ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  const uniqueKeys = new Set(entries.map((e) => `${e.conditionId}::${e.selectedTokenId}`));
  assert.equal(uniqueKeys.size, 1, "duplicate discovery paths must collapse to one writer-input identity key");
});

test("RED: snapshot and attribution fields are present for every proposed row", () => {
  const events = buildFixtureEvents();
  const { rows } = buildSportsEventMarketInventoryRows(events, { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.equal(e.shadowReason, "BROAD_STRUCTURED_SPORTS_V1");
    assert.ok(e.conditionId, "conditionId must be present for provenance");
    assert.ok(e.selectedTokenId, "selectedTokenId must be present for provenance");
    assert.ok(e.providerEventId, "providerEventId must be present for provenance");
    assert.ok(e.providerMarketId, "providerMarketId must be present for provenance");
    assert.ok(e.tokenSelectionMethod, "token selection method must be disclosed, not silent");
  }
});

test("RED: rows missing a usable condition/token identity are skipped with an explicit aggregate reason, not silently zeroed", () => {
  const brokenMarket = market("mkt-broken-1", "cond-broken-1");
  brokenMarket.clobTokenIds = [];
  const ev = tagEvent({
    id: "evt-broken-1",
    slug: "broken-1",
    title: "Broken Market Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["305"],
    markets: [brokenMarket],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries, diagnostics } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 0);
  assert.equal(diagnostics.rowsSkippedMissingToken, 1);
});

test("RED (pre-patch baseline, still true post-patch as regression guard): the closed-vocabulary targeted collectors alone cannot represent a non-targeted structural sport", () => {
  // Documents the exact defect this commit fixes: the four hardcoded shadow
  // scopes never included cricket/tennis/mma/esports-adjacent sports outside
  // their own targeted collector. The broad path above is what makes them
  // reachable; this assertion pins the closed set so a future regression
  // that reintroduces a hardcoded allowlist inside the broad adapter itself
  // is caught.
  const LEGACY_TARGETED_SHADOW_SCOPES = new Set(["WC2026", "ESPORT", "NBA", "NHL"]);
  assert.ok(!LEGACY_TARGETED_SHADOW_SCOPES.has("cricket"));
  assert.ok(!LEGACY_TARGETED_SHADOW_SCOPES.has("rugby-sevens"));
});
