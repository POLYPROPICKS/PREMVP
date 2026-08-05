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
  resolveOfficialSportCode,
  OFFICIAL_FULL_MATCH_MARKET_TYPES,
} from "../../lib/feed/discoverSportsMarkets";

// ── Official sports materialization ────────────────────────────────────────
// Production-shaped seam. Every real Polymarket sports event carries broad
// umbrella tags alongside its league tag; the fixtures below reproduce that
// shape, which the pre-existing lineage fixtures did not. Pure functions only:
// no network, no Supabase.

const OBSERVED_AT = "2026-08-05T08:00:00.000Z";
const SNAPSHOT_RUN_ID = "33333333-3333-3333-3333-333333333333";

// Umbrella tags: "1" (Sports) is on every entry, "100350" (Soccer) on every
// soccer league. League tags ("500" epl, "501" lal, "600" nba) are unique.
const SPORTS_RAW: unknown[] = [
  { sport: "epl", tags: "1,100350,500", series: "10188" },
  { sport: "lal", tags: "1,100350,501", series: "10193" },
  { sport: "seriea", tags: "1,100350,502" },
  { sport: "nba", tags: "1,600", series: "39" },
];

const SPECIFIC_SPORTS_TAG_IDS = new Set(["100350", "500", "501", "502", "600"]);
const SPORTS_TAG_IDS = [...SPECIFIC_SPORTS_TAG_IDS, "1"];

function market(opts: {
  id: string;
  conditionId: string;
  sportsMarketType?: string | null;
  gameStartTime?: string | null;
  clobTokenIds?: unknown[];
  outcomes?: unknown[];
  outcomePrices?: unknown[];
}) {
  return {
    id: opts.id,
    slug: `${opts.id}-slug`,
    question: "Market question",
    conditionId: opts.conditionId,
    clobTokenIds: opts.clobTokenIds ?? [`${opts.id}-tok-a`, `${opts.id}-tok-b`],
    outcomes: opts.outcomes ?? ["Home", "Away"],
    outcomePrices: opts.outcomePrices ?? ["0.55", "0.45"],
    sportsMarketType: opts.sportsMarketType ?? "moneyline",
    gameStartTime: opts.gameStartTime ?? "2026-08-05T20:00:00.000Z",
    gameId: `${opts.id}-game`,
    endDate: "2026-08-05T23:00:00.000Z",
  } as NonNullable<SportsInventoryRawEvent["markets"]>[number];
}

function event(opts: {
  id: string;
  tagIds: string[];
  startTime?: string | null;
  title?: string;
  markets: NonNullable<SportsInventoryRawEvent["markets"]>;
}): SportsInventoryRawEvent {
  const rawEvent = {
    id: opts.id,
    slug: `${opts.id}-slug`,
    title: opts.title ?? "Alpha vs Beta",
    startTime: opts.startTime === undefined ? "2026-08-05T20:00:00.000Z" : opts.startTime,
    startDate: "2025-01-01T00:00:00.000Z", // deliberately stale creation date
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

function build(events: SportsInventoryRawEvent[]) {
  const { rows } = buildSportsEventMarketInventoryRows(events, {
    observedAt: OBSERVED_AT,
    snapshotRunId: SNAPSHOT_RUN_ID,
  });
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  return buildBroadStructuredSportsShadowEntries(rows, sportMeta, new Map());
}

// ── official sport attribution ─────────────────────────────────────────────

test("an event carrying umbrella tags alongside its league tag still resolves to exactly one official sport", () => {
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  // This is the exact production shape that previously resolved as ambiguous:
  // tag "1" alone maps to all four sports, "100350" to all three soccer codes.
  const resolved = resolveOfficialSportCode(["1", "100350", "500"], sportMeta);
  assert.equal(resolved.providerSportCode, "epl");
  assert.equal(resolved.providerSportSource, "structured_sports_tag");
  assert.equal(resolved.ambiguousSport, false);
});

test("umbrella tags alone remain ambiguous and are never guessed", () => {
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const resolved = resolveOfficialSportCode(["1", "100350"], sportMeta);
  assert.equal(resolved.providerSportCode, null);
  assert.equal(resolved.providerSportSource, "ambiguous_multi_tag");
  assert.equal(resolved.ambiguousSport, true);
});

test("tags with no official sport mapping are unclassified, not ambiguous", () => {
  const sportMeta = buildProviderSportMetadataMap(SPORTS_RAW);
  const resolved = resolveOfficialSportCode(["999", "998"], sportMeta);
  assert.equal(resolved.providerSportCode, null);
  assert.equal(resolved.providerSportSource, "unclassified");
  assert.equal(resolved.ambiguousSport, false);
});

test("sport attribution comes from the official tag id, never from title text", () => {
  const misleading = event({
    id: "evt-text-trap",
    title: "Lakers NBA Basketball Showdown", // says basketball
    tagIds: ["1", "100350", "501"], // official tags say lal (soccer)
    markets: [market({ id: "m-text-trap", conditionId: "cond-text-trap" })],
  });
  const { entries } = build([misleading]);
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.equal(e.providerSportCode, "lal", "official tag must win over misleading title text");
  }
});

test("providerSportCode is persisted on every materialized entry", () => {
  const { entries } = build([
    event({ id: "evt-a", tagIds: ["1", "600"], markets: [market({ id: "m-a", conditionId: "cond-a" })] }),
  ]);
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.equal(e.providerSportCode, "nba");
    assert.equal(e.providerSportSource, "structured_sports_tag");
    assert.ok(e.providerSportTagIds?.includes("600"));
  }
});

// ── exact official lineage ─────────────────────────────────────────────────

test("official sportsMarketType, game start and exact id lineage survive to the writer input", () => {
  const { entries } = build([
    event({
      id: "evt-lineage",
      tagIds: ["1", "600"],
      startTime: "2026-08-05T20:00:00.000Z",
      markets: [market({ id: "m-lineage", conditionId: "cond-lineage" })],
    }),
  ]);
  const e = entries[0];
  assert.equal(e.providerEventId, "evt-lineage");
  assert.equal(e.providerMarketId, "m-lineage");
  assert.equal(e.conditionId, "cond-lineage");
  assert.equal(e.marketType, "moneyline");
  assert.equal(e.gameStartIso, "2026-08-05T20:00:00.000Z");
  assert.ok(e.selectedTokenId.startsWith("m-lineage-tok-"));
});

test("event.startTime is the kickoff, never the stale startDate", () => {
  const { entries } = build([
    event({
      id: "evt-start",
      tagIds: ["1", "600"],
      startTime: "2026-08-05T20:00:00.000Z",
      markets: [market({ id: "m-start", conditionId: "cond-start" })],
    }),
  ]);
  // startDate on the fixture is 2025-01-01 and must never surface as kickoff.
  assert.equal(entries[0].gameStartIso, "2026-08-05T20:00:00.000Z");
  assert.ok(!entries.some((e) => String(e.gameStartIso).startsWith("2025-01-01")));
});

test("no duplicate condition/token identity is emitted for one market", () => {
  const { entries } = build([
    event({ id: "evt-dup", tagIds: ["1", "600"], markets: [market({ id: "m-dup", conditionId: "cond-dup" })] }),
  ]);
  const keys = entries.map((e) => `${e.conditionId}::${e.selectedTokenId}`);
  assert.equal(new Set(keys).size, keys.length, "each condition/token pair must appear once");
});

// ── materialization outcome ledger ─────────────────────────────────────────

test("every considered official event receives exactly one terminal outcome", () => {
  const { diagnostics } = build([
    event({ id: "evt-ok", tagIds: ["1", "600"], markets: [market({ id: "m-ok", conditionId: "cond-ok" })] }),
    event({
      id: "evt-nofm",
      tagIds: ["1", "500"],
      markets: [market({ id: "m-nofm", conditionId: "cond-nofm", sportsMarketType: "totals" })],
    }),
    event({
      id: "evt-badidentity",
      tagIds: ["1", "501"],
      markets: [
        market({
          id: "m-badidentity",
          conditionId: "cond-badidentity",
          clobTokenIds: ["only-one-token"], // length mismatch vs 2 outcomes
        }),
      ],
    }),
  ]);
  const led = diagnostics.materialization;
  assert.equal(led.eventsConsidered, 3);
  assert.equal(led.outcomeTotal, 3);
  assert.equal(led.conservationOk, true, "materialized + skips must equal events considered");
  // The producer materializes every structured sports market, not only the
  // full-match line, so the totals-only event still materializes. Full-match
  // is the coverage denominator, not a materialization filter.
  assert.equal(led.outcomes.MATERIALIZED, 2);
  assert.equal(led.outcomes.EXACT_IDENTITY_INCOMPLETE, 1);
  assert.equal(led.fullMatchEventsConsidered, 2);
  assert.equal(led.fullMatchEventsMaterialized, 1);
});

test("an identity failure is never masked as a missing full-match market", () => {
  const { diagnostics } = build([
    event({
      id: "evt-bad-nonfm",
      tagIds: ["1", "600"],
      markets: [
        market({
          id: "m-bad-nonfm",
          conditionId: "cond-bad-nonfm",
          sportsMarketType: "totals",
          clobTokenIds: ["only-one-token"],
        }),
      ],
    }),
  ]);
  const led = diagnostics.materialization;
  assert.equal(led.outcomes.EXACT_IDENTITY_INCOMPLETE, 1);
  assert.equal(led.outcomes.NO_SUPPORTED_FULLMATCH_MARKET, 0);
});

test("outcome totals reconcile for a larger mixed inventory", () => {
  const events: SportsInventoryRawEvent[] = [];
  for (let i = 0; i < 25; i++) {
    events.push(
      event({
        id: `evt-bulk-${i}`,
        tagIds: ["1", i % 2 === 0 ? "600" : "500"],
        markets: [
          market({
            id: `m-bulk-${i}`,
            conditionId: `cond-bulk-${i}`,
            sportsMarketType: i % 5 === 0 ? "spreads" : "moneyline",
          }),
        ],
      }),
    );
  }
  const { diagnostics } = build(events);
  const led = diagnostics.materialization;
  assert.equal(led.eventsConsidered, 25);
  assert.equal(led.outcomeTotal, 25);
  assert.equal(led.conservationOk, true);
  const summed = Object.values(led.outcomes).reduce((a, b) => a + b, 0);
  assert.equal(summed, led.eventsConsidered);
});

test("full-match coverage is measured against official sportsMarketType only", () => {
  assert.ok(OFFICIAL_FULL_MATCH_MARKET_TYPES.has("moneyline"));
  const { diagnostics } = build([
    event({ id: "evt-fm", tagIds: ["1", "600"], markets: [market({ id: "m-fm", conditionId: "cond-fm" })] }),
    event({
      id: "evt-notfm",
      tagIds: ["1", "600"],
      markets: [market({ id: "m-notfm", conditionId: "cond-notfm", sportsMarketType: "totals" })],
    }),
  ]);
  const led = diagnostics.materialization;
  assert.equal(led.fullMatchEventsConsidered, 1);
  assert.equal(led.fullMatchEventsMaterialized, 1);
});

test("a structurally non-sports event never enters the ledger", () => {
  const { entries, diagnostics } = build([
    event({ id: "evt-politics", tagIds: ["999"], markets: [market({ id: "m-pol", conditionId: "cond-pol" })] }),
  ]);
  assert.equal(entries.length, 0);
  assert.equal(diagnostics.materialization.eventsConsidered, 0);
});
