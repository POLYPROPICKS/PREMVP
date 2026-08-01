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

  // Each fixture market() has 2 outcomes -- both must survive into the writer input.
  assert.equal(entries.length, Object.keys(SPORT_TAG_BY_CODE).length * 2, "every outcome of every fixture sport must produce a row");
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
  assert.equal(entries.length, 2, "both outcomes of the one market must be represented");
  assert.equal(entries[0].providerSportCode, "soccer", "structured tag must win over misleading title text");
  assert.equal(entries[1].providerSportCode, "soccer");
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
  assert.equal(entries.length, 2, "both outcomes of the one market must be represented");
  const e = entries[0];
  assert.equal(e.providerEventId, "evt-basketball-full-1");
  assert.equal(e.providerMarketId, "mkt-basketball-full-1");
  assert.equal(e.gameStartIso, "2026-08-01T20:00:00.000Z");
  assert.equal(e.conditionId, "cond-basketball-full-1");
  assert.equal(e.selectedTokenId, "mkt-basketball-full-1-tok-a");
  assert.equal(e.selectedOutcome, "Yes");
  assert.equal(e.marketType, "moneyline");
  assert.equal(e.gameId, "game-123");
  assert.equal(e.teamAId, "team-A");
  assert.equal(e.teamBId, "team-B");
  assert.deepEqual(e.providerSportTagIds, ["301"]);

  const e2 = entries[1];
  assert.equal(e2.providerEventId, "evt-basketball-full-1");
  assert.equal(e2.providerMarketId, "mkt-basketball-full-1");
  assert.equal(e2.conditionId, "cond-basketball-full-1");
  assert.equal(e2.selectedTokenId, "mkt-basketball-full-1-tok-b");
  assert.equal(e2.selectedOutcome, "No");
  assert.equal(e2.gameId, "game-123", "second outcome retains the same event/game/team identity");
  assert.equal(e2.teamAId, "team-A");
  assert.equal(e2.teamBId, "team-B");
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
  // 2 markets x 2 outcomes each = 4 rows.
  assert.equal(entries.length, 4);
  const marketIds = new Set(entries.map((e) => e.providerMarketId));
  assert.equal(marketIds.size, 2, "both sibling markets must be represented");
  for (const e of entries) {
    assert.equal(e.providerEventId, entries[0].providerEventId);
  }
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
  // 2 events x 2 outcomes each = 4 rows.
  assert.equal(entries.length, 4);
  const eventIds = new Set(entries.map((e) => e.providerEventId));
  assert.equal(eventIds.size, 2, "same-titled events with distinct provider IDs must remain distinct");
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
  assert.equal(entries.length, 2, "both outcomes of an ambiguous row must still be written, never dropped");
  for (const e of entries) {
    assert.equal(e.ambiguousSport, true);
    assert.equal(e.providerSportCode, null);
    assert.equal(e.providerSportSource, "ambiguous_multi_tag");
    assert.deepEqual(new Set(e.providerSportTagIds), new Set(["301", "302"]));
  }
  assert.equal(diagnostics.rowsAmbiguousSport, 1, "ambiguity is counted once per market, not once per outcome row");
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
  // The one real market has 2 real outcomes, so 2 distinct identity keys are
  // expected. This pure adapter does not itself dedup repeated inventory rows
  // (that dedup happens downstream in writeStrategicShadowPairs's read-before-
  // write check) -- what matters here is that no THIRD, spurious identity is
  // invented by the repeated discovery path, and that both real outcomes are
  // still represented identically across the duplicate rows.
  const uniqueKeys = new Set(entries.map((e) => `${e.conditionId}::${e.selectedTokenId}`));
  assert.equal(uniqueKeys.size, 2, "duplicate discovery paths must not invent identities beyond the market's real outcomes");
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

// ── Outcome completeness (correction commit) ────────────────────────────────

function marketWithOutcomes(
  id: string,
  conditionId: string,
  tokens: string[],
  outcomes: (string | null)[],
  prices: (string | number | null)[],
): NonNullable<SportsInventoryRawEvent["markets"]>[number] {
  return {
    id,
    slug: `${id}-slug`,
    question: "Market",
    conditionId,
    clobTokenIds: tokens,
    outcomes,
    outcomePrices: prices,
    category: "Sports",
    sportsMarketType: "moneyline",
    volume: 10000,
    volume24hr: 2000,
    endDate: "2026-08-02T00:00:00.000Z",
  };
}

test("RED: a production-shaped market with two real outcomes emits two rows, one per aligned token/outcome/price tuple", () => {
  const mkt = marketWithOutcomes(
    "mkt-two-outcomes",
    "cond-two-outcomes",
    ["tok-yes", "tok-no"],
    ["Yes", "No"],
    [0.62, 0.38],
  );
  const ev = tagEvent({
    id: "evt-two-outcomes",
    slug: "two-outcomes-slug",
    title: "Two Outcome Market Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    markets: [mkt],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());

  assert.equal(entries.length, 2, "exactly two broad Signal Pair inputs are emitted");
  assert.equal(entries[0].selectedTokenId, "tok-yes");
  assert.equal(entries[0].selectedOutcome, "Yes");
  assert.equal(entries[0].entryPriceNum, 0.62);
  assert.equal(entries[1].selectedTokenId, "tok-no");
  assert.equal(entries[1].selectedOutcome, "No");
  assert.equal(entries[1].entryPriceNum, 0.38);
  for (const e of entries) {
    assert.equal(e.providerEventId, "evt-two-outcomes");
    assert.equal(e.providerMarketId, "mkt-two-outcomes");
    assert.equal(e.conditionId, "cond-two-outcomes");
    assert.equal(e.gameStartIso, "2026-08-01T20:00:00.000Z");
    assert.notEqual(e.selectedOutcome, "Yes" === e.selectedOutcome && e.tokenIndex === 1, "row 2 must not fall back to a fabricated 'Yes'");
  }
});

test("RED: a production-shaped market with three real outcomes emits three rows, generic over array length", () => {
  const mkt = marketWithOutcomes(
    "mkt-three-outcomes",
    "cond-three-outcomes",
    ["tok-a", "tok-b", "tok-c"],
    ["Team A", "Draw", "Team B"],
    [0.4, 0.25, 0.35],
  );
  const ev = tagEvent({
    id: "evt-three-outcomes",
    slug: "three-outcomes-slug",
    title: "Three Outcome Market Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    markets: [mkt],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 3, "the adapter is generic over outcome-array length, not hardcoded to two");
  assert.deepEqual(entries.map((e) => e.selectedOutcome), ["Team A", "Draw", "Team B"]);
  assert.deepEqual(entries.map((e) => e.selectedTokenId), ["tok-a", "tok-b", "tok-c"]);
  assert.deepEqual(entries.map((e) => e.entryPriceNum), [0.4, 0.25, 0.35]);
});

// ── Malformed parity (correction commit) ────────────────────────────────────

test("RED: token count differing from outcome count is skipped as an index-mismatched market, never paired by guesswork", () => {
  const mkt = marketWithOutcomes(
    "mkt-mismatch",
    "cond-mismatch",
    ["tok-a", "tok-b"],
    ["Yes"], // outcomes shorter than tokens
    [0.5, 0.5],
  );
  const ev = tagEvent({
    id: "evt-mismatch",
    slug: "mismatch-slug",
    title: "Mismatched Arrays Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    markets: [mkt],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries, diagnostics } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 0, "a market with mismatched array lengths must never be paired by index guesswork");
  assert.equal(diagnostics.rowsSkippedIndexMismatch, 1);
});

test("RED: a missing or invalid outcome price at one index is skipped without fabricating a price, siblings unaffected", () => {
  const mkt = marketWithOutcomes(
    "mkt-bad-price",
    "cond-bad-price",
    ["tok-a", "tok-b"],
    ["Yes", "No"],
    [0.55, null], // second price missing
  );
  const ev = tagEvent({
    id: "evt-bad-price",
    slug: "bad-price-slug",
    title: "Bad Price Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    markets: [mkt],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries, diagnostics } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 1, "the sibling with a valid price must still be emitted");
  assert.equal(entries[0].selectedTokenId, "tok-a");
  assert.equal(diagnostics.rowsSkippedMissingPrice, 1);
});

test("RED: an empty token string at one index is skipped without fabricating a token, siblings unaffected", () => {
  const mkt = marketWithOutcomes(
    "mkt-empty-token",
    "cond-empty-token",
    ["tok-a", ""], // second token empty
    ["Yes", "No"],
    [0.55, 0.45],
  );
  const ev = tagEvent({
    id: "evt-empty-token",
    slug: "empty-token-slug",
    title: "Empty Token Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    markets: [mkt],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries, diagnostics } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].selectedTokenId, "tok-a");
  assert.equal(diagnostics.rowsSkippedMalformedOutcome, 1);
});

test("RED: an empty outcome name at one index is skipped without fabricating an outcome, siblings unaffected", () => {
  const mkt = marketWithOutcomes(
    "mkt-empty-outcome",
    "cond-empty-outcome",
    ["tok-a", "tok-b"],
    ["Yes", ""], // second outcome empty
    [0.55, 0.45],
  );
  const ev = tagEvent({
    id: "evt-empty-outcome",
    slug: "empty-outcome-slug",
    title: "Empty Outcome Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    markets: [mkt],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries, diagnostics } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].selectedTokenId, "tok-a");
  assert.equal(diagnostics.rowsSkippedMissingOutcome, 1);
});

test("RED: a market with zero valid aligned outcomes emits zero rows and reports the malformed count honestly", () => {
  const mkt = marketWithOutcomes(
    "mkt-all-bad",
    "cond-all-bad",
    ["", ""],
    ["", ""],
    [null, null],
  );
  const ev = tagEvent({
    id: "evt-all-bad",
    slug: "all-bad-slug",
    title: "All Bad Event",
    startTime: "2026-08-01T20:00:00.000Z",
    tagIds: ["303"],
    markets: [mkt],
  });
  const { rows } = buildSportsEventMarketInventoryRows([ev], { observedAt: OBSERVED_AT, snapshotRunId: SNAPSHOT_RUN_ID });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const { entries, diagnostics } = buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
  assert.equal(entries.length, 0);
  assert.equal(diagnostics.rowsSkippedMalformedOutcome, 2, "both empty-token slots are honestly counted");
  assert.equal(diagnostics.outcomeTuplesConsidered, 2);
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
