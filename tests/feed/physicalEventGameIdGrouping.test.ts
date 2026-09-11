// PHYSICAL_EVENT_FRAGMENTATION_FIXED_V1 — focused regression test.
//
// Proves the exact acceptance criteria for propagating provider event.gameId
// onto flattened markets in discoverSportsMarkets.ts's keyset augmentation
// block, using a synthetic fixture shaped like the live Sevilla FC vs Valencia
// CF fragmentation (gameId 90117164 split across provider event ids 940179
// and 940411), with no network access (global.fetch is stubbed for the
// duration of this test only and restored in `finally`).
import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverSportsMarkets } from "../../lib/feed/discoverSportsMarkets";
import { sampleToCandidateMarkets } from "../../lib/feed/buildLandingCards";

const SEVILLA_VALENCIA_GAME_ID = "90117164";
const START_ISO = new Date(Date.now() + 2 * 3600 * 1000).toISOString();

function moneylineMarket(id: string, conditionId: string) {
  return {
    id,
    conditionId,
    question: `Will Sevilla FC win on 2026-09-11?`,
    slug: `lal-sev-val-${id}`,
    active: true,
    closed: false,
    sportsMarketType: "moneyline",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.495", "0.505"],
    clobTokenIds: ["token-ml-yes", "token-ml-no"],
    volumeNum: 200000,
  };
}

function totalsMarket(id: string, conditionId: string) {
  return {
    id,
    conditionId,
    question: `Sevilla FC vs. Valencia CF: O/U 2.5`,
    slug: `lal-sev-val-more-markets-${id}`,
    active: true,
    closed: false,
    sportsMarketType: "totals",
    outcomes: ["Over", "Under"],
    outcomePrices: ["0.405", "0.595"],
    clobTokenIds: ["token-tot-over", "token-tot-under"],
    volumeNum: 30000,
  };
}

function unrelatedMoneylineMarket() {
  return {
    id: "unrelated-market",
    conditionId: "0xUNRELATED",
    question: "Will Real Madrid win?",
    slug: "unrelated-match",
    active: true,
    closed: false,
    sportsMarketType: "moneyline",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.5", "0.5"],
    clobTokenIds: ["token-un-yes", "token-un-no"],
    volumeNum: 500000,
  };
}

function nullGameIdMarket() {
  return {
    id: "no-gameid-market",
    conditionId: "0xNOGAMEID",
    question: "Will Legacy FC win?",
    slug: "legacy-no-gameid-2026-09-11",
    active: true,
    closed: false,
    sportsMarketType: "moneyline",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.5", "0.5"],
    clobTokenIds: ["token-legacy-yes", "token-legacy-no"],
    volumeNum: 50000,
  };
}

const TAGS = [{ id: "780", slug: "la-liga" }];

// Event A: main moneyline event (mirrors provider event 940179).
const EVENT_A = {
  id: "940179",
  slug: "lal-sev-val-2026-09-11",
  title: "Sevilla FC vs. Valencia CF",
  active: true,
  closed: false,
  gameId: 90117164,
  startTime: START_ISO,
  tags: TAGS,
  markets: [moneylineMarket("4019510", "0xMONEYLINE")],
};

// Event B: "More Markets" event for the SAME physical match (mirrors 940411).
// No market-level gameId (matches live provider behavior) -- only the event
// carries gameId 90117164.
const EVENT_B = {
  id: "940411",
  slug: "lal-sev-val-2026-09-11-more-markets",
  title: "Sevilla FC vs. Valencia CF - More Markets",
  active: true,
  closed: false,
  gameId: 90117164,
  startTime: START_ISO,
  tags: TAGS,
  markets: [totalsMarket("4020969", "0xTOTALS")],
};

// Event C: a different physical match entirely -- must never merge with A/B.
const EVENT_C = {
  id: "950000",
  slug: "unrelated-match-2026-09-11",
  title: "Real Madrid vs. Barcelona",
  active: true,
  closed: false,
  gameId: 99999999,
  startTime: START_ISO,
  tags: TAGS,
  markets: [unrelatedMoneylineMarket()],
};

// Event D: no event-level gameId at all -- proves the prior fallback grouping
// (by nestedEventId) is preserved when neither market nor event expose one.
const EVENT_D = {
  id: "970000",
  slug: "legacy-no-gameid-2026-09-11",
  title: "Legacy FC vs. Historic FC",
  active: true,
  closed: false,
  startTime: START_ISO,
  tags: TAGS,
  markets: [nullGameIdMarket()],
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

async function withStubbedGammaApi<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/events/keyset")) {
      const params = new URL(url).searchParams;
      if (params.has("start_time_min")) {
        // Primary spine call (fetchActiveEventsByStartWindowKeysetSafe).
        return jsonResponse({
          events: [EVENT_A, EVENT_B, EVENT_C, EVENT_D],
          next_cursor: null,
        });
      }
      // Every other keyset-backed fetch (tag/series/tag-slug lookups used by
      // extended WC2026/esports/NBA/NHL candidate collection) gets an empty,
      // well-formed page -- out of scope for this fix.
      return jsonResponse({ events: [], next_cursor: null });
    }
    if (url.endsWith("/sports")) {
      return jsonResponse([{ tags: "780" }]);
    }
    if (url.endsWith("/teams")) {
      return jsonResponse([]);
    }
    // Every other Gamma endpoint (markets, tags, etc.) -- empty array is a
    // valid, safely-handled response shape for all of them.
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

test("physical-event fragments sharing provider event.gameId merge into one group before ranking", async () => {
  await withStubbedGammaApi(async () => {
    const result = await discoverSportsMarkets({
      windowHours: 24,
      fallbackWindowHours: 48,
      fetchVolumeMinUsd: 0,
      finalEventVolumeMinUsd: 1000,
      targetCards: 254,
    });

    const merged = result.finalCandidates.filter(
      (s) => s.gameId === SEVILLA_VALENCIA_GAME_ID,
    );

    // AFTER: exactly one physical-match group, not two provider-event groups.
    assert.equal(merged.length, 1, "expected exactly one merged physical-match sample");
    const sample = merged[0]!;

    // Aggregate event volume is computed across the merged physical match
    // (moneyline event volume 200000 + more-markets event volume 30000).
    assert.equal(sample.eventVolumeUsd, 230000);
    assert.equal(sample.marketCount, 2);

    // targetCards ranking operates on the merged group: with combined volume
    // 230000 it must out-rank the unrelated single-event match (500000) only
    // by volume ordering, but must still appear inside the ranked population
    // that targetCards bounds.
    const rank = result.finalCandidates.indexOf(sample);
    assert.ok(rank >= 0 && rank < 254, `merged sample must be inside targetCards=254, got rank ${rank}`);

    // marketsRaw preserves BOTH source markets (moneyline from event A,
    // totals from event B) as fan-out siblings for downstream scoring.
    const siblingTypes = new Set(
      (sample.marketsRaw ?? []).map((m) => String(m.sportsMarketType).toLowerCase()),
    );
    assert.ok(siblingTypes.has("moneyline"), "moneyline sibling from event A must survive the merge");
    assert.ok(siblingTypes.has("totals"), "totals sibling from event B must survive the merge");

    // Both-side scorer fan-out is unchanged: moneyline (Yes/No) + totals
    // (Over/Under) expand into 4 independent CandidateMarket identities.
    const candidates = sampleToCandidateMarkets(sample);
    assert.equal(candidates.length, 4, "expected 2 markets x 2 sides = 4 fan-out identities");
    const conditionIds = new Set(candidates.map((c) => c.market.conditionId));
    assert.deepEqual(conditionIds, new Set(["0xMONEYLINE", "0xTOTALS"]));

    // No unrelated event with a different gameId merges into this group.
    const unrelated = result.finalCandidates.find((s) => s.gameId === "99999999");
    assert.ok(unrelated, "unrelated different-gameId match must remain its own sample");
    assert.notEqual(unrelated!.eventVolumeUsd, sample.eventVolumeUsd + 500000);
    assert.equal(unrelated!.marketCount, 1);

    // A provider match with NO gameId anywhere (neither market nor event)
    // preserves the prior nestedEventId/slug fallback grouping -- it must
    // still surface as its own independent sample, not merge into the
    // Sevilla-Valencia group and not disappear.
    const legacy = result.finalCandidates.find(
      (s) => s.slug === "legacy-no-gameid-2026-09-11" || s.polymarketEventSlug === "legacy-no-gameid-2026-09-11",
    );
    assert.ok(legacy, "null-gameId event must still produce its own sample via fallback grouping");
    assert.notEqual(legacy!.gameId, SEVILLA_VALENCIA_GAME_ID);
  });
});
