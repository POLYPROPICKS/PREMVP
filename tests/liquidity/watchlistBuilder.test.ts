import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWatchlistCandidate,
  dedupeWatchlistCandidates,
  deriveLiquidityFamily,
  extractGameStart,
  extractMarketType,
  extractMarketVolumeUsd,
  extractSelectedTokenId,
  mapResearchSnapshotToLiquiditySource,
  toWatchlistRow,
} from "../../lib/liquidity/watchlistBuilder";

// A row matching the REAL public.generated_signal_research_snapshots shape.
function realEsportsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-real-1",
    condition_id: "cond-esports-1",
    selected_token_id:
      "15485078502615086758578180527211401921155810690828721480862485245242047583850",
    opposing_token_id:
      "66373083191163923723822375287519931205628881820976049927659768071645900057264",
    league: "Esports",
    market_family: "Esports",
    event_slug: "cs2-pcy-bsta-2026-06-27",
    selected_outcome: "Under",
    selected_price_num: 0.5,
    game_start_iso: "2026-06-27T22:00:00+00:00",
    hours_until_start_num: 16.45,
    diagnostics: {
      researchContext: {
        marketType: "round_over_under_game_2",
        marketSubtype: "round_over_under_game_2",
        signalPhaseAtSnapshot: "prematch",
      },
      fireModel: {
        rawFeatureHints: {
          marketType: "round_over_under_game_2",
          marketSubtype: "round_over_under_game_2",
        },
      },
    },
    ...overrides,
  };
}

test("extractMarketType prefers nested researchContext.marketType", () => {
  const r = extractMarketType(realEsportsRow());
  assert.equal(r.marketType, "round_over_under_game_2");
  assert.equal(r.source, "researchContext.marketType");
});

test("extractMarketType falls back through fireModel hints and subtypes", () => {
  const onlyHint = extractMarketType({
    diagnostics: { fireModel: { rawFeatureHints: { marketType: "moneyline" } } },
  });
  assert.equal(onlyHint.marketType, "moneyline");
  assert.equal(onlyHint.source, "fireModel.rawFeatureHints.marketType");

  const onlySubtype = extractMarketType({
    diagnostics: { researchContext: { marketSubtype: "total_game_1" } },
  });
  assert.equal(onlySubtype.marketType, "total_game_1");
  assert.equal(onlySubtype.source, "researchContext.marketSubtype");
});

test("extractMarketType returns null when no nested type/subtype exists", () => {
  // The broad market_family column must NOT count as a market type.
  const r = extractMarketType({ market_family: "Esports", diagnostics: {} });
  assert.equal(r.marketType, null);
  assert.equal(r.source, null);
});

test("deriveLiquidityFamily maps round_over_under_game_2 to total (SUPPORTED)", () => {
  const r = deriveLiquidityFamily("round_over_under_game_2");
  assert.equal(r.family, "total");
  assert.equal(r.status, "SUPPORTED");
  assert.equal(r.reason, null);
});

test("deriveLiquidityFamily rejects missing market type with missing_market_type", () => {
  const r = deriveLiquidityFamily(null);
  assert.equal(r.family, "UNKNOWN");
  assert.equal(r.status, "EXCLUDED_MISSING_MARKET_TYPE");
  assert.equal(r.reason, "missing_market_type");
});

test("extractSelectedTokenId / extractGameStart read real columns", () => {
  const row = realEsportsRow();
  assert.equal(extractSelectedTokenId(row), row.selected_token_id);
  assert.equal(extractGameStart(row), "2026-06-27T22:00:00+00:00");
});

test("mapResearchSnapshotToLiquiditySource aligns to the real schema", () => {
  const src = mapResearchSnapshotToLiquiditySource(realEsportsRow());
  assert.equal(src.conditionId, "cond-esports-1");
  assert.equal(src.selectedTokenId, realEsportsRow().selected_token_id);
  assert.equal(src.opposingTokenId, realEsportsRow().opposing_token_id);
  assert.equal(src.normalizedSport, "esports"); // derived from league
  assert.equal(src.rawSourceCategory, "Esports"); // market_family kept as category
  assert.equal(src.marketType, "round_over_under_game_2");
  assert.equal(src.gameStartIso, "2026-06-27T22:00:00+00:00");
  assert.equal(src.selectedPrice, 0.5);
});

// THE regression: previously this real row mapped to UNKNOWN (family_pass=0).
test("REGRESSION: real esports row is family-SUPPORTED, not UNKNOWN", () => {
  const c = buildWatchlistCandidate(realEsportsRow());
  assert.ok(c);
  assert.equal(c!.normalizedSport, "esports");
  assert.equal(c!.marketType, "round_over_under_game_2");
  assert.equal(c!.normalizedMarketFamily, "total");
  assert.equal(c!.marketFamilyGate, "SUPPORTED");
  assert.equal(c!.rawSourceCategory, "Esports");
});

// THE other regression: no nested market type => explicit missing_market_type,
// never a silent UNKNOWN family.
test("REGRESSION: row without nested market type => missing_market_type", () => {
  const c = buildWatchlistCandidate(
    realEsportsRow({ diagnostics: { researchContext: { signalPhaseAtSnapshot: "prematch" } } }),
  );
  assert.ok(c);
  assert.equal(c!.marketFamilyGate, "EXCLUDED_MISSING_MARKET_TYPE");
  assert.equal(c!.marketFamilyGateReason, "missing_market_type");
});

// Source has no volume column: do NOT hard-reject before capture — defer it.
test("missing source volume defers the volume gate (not rejected)", () => {
  const c = buildWatchlistCandidate(realEsportsRow());
  assert.ok(c);
  assert.equal(c!.volumeUsd, null);
  assert.equal(c!.volumeGate, "FAIL_MISSING_VOLUME"); // truthful about source
  assert.equal(c!.volumeGateDb, "deferred"); // DB disposition = deferred to capture
});

// Volume present but below threshold is still a hard reject (not deferred).
test("below-threshold source volume is rejected, not deferred", () => {
  const c = buildWatchlistCandidate(realEsportsRow({ diagnostics: {
    researchContext: { marketType: "round_over_under_game_2" },
    market_volume_usd: 500,
  } }));
  assert.ok(c);
  assert.equal(c!.volumeUsd, 500);
  assert.equal(c!.volumeGateDb, "rejected");
});

test("buildWatchlistCandidate returns null without token id or condition id", () => {
  assert.equal(buildWatchlistCandidate({ league: "NBA" }), null);
  assert.equal(buildWatchlistCandidate({ selected_token_id: "t" }), null); // no condition
  assert.equal(buildWatchlistCandidate({ condition_id: "c" }), null); // no token
});

test("extractMarketVolumeUsd prefers market-level then event-level", () => {
  assert.deepEqual(extractMarketVolumeUsd({ market_volume_usd: 12345 }), {
    volumeUsd: 12345,
    source: "source_column",
    scope: "market_level",
  });
  assert.deepEqual(extractMarketVolumeUsd({ diagnostics: { event_volume_usd: 80000 } }), {
    volumeUsd: 80000,
    source: "diagnostics_event_level",
    scope: "event_level_not_market_level",
  });
  // diagnostics as a JSON string is parsed safely.
  assert.equal(
    extractMarketVolumeUsd({ diagnostics: '{"market_volume_usd": 50000}' }).volumeUsd,
    50000,
  );
  assert.equal(extractMarketVolumeUsd({ diagnostics: "not-json" }).volumeUsd, null);
});

test("excluded prop detection via nested market type", () => {
  const prop = buildWatchlistCandidate({
    condition_id: "c",
    selected_token_id: "p",
    diagnostics: {
      researchContext: { marketType: "player_prop" },
      market_volume_usd: 99999,
    },
  });
  assert.equal(prop!.marketFamilyGate, "EXCLUDED_PROP");
  assert.equal(prop!.isProp, true);
});

test("dedupeWatchlistCandidates keeps highest priority per condition+token", () => {
  const low = buildWatchlistCandidate({
    condition_id: "c",
    selected_token_id: "dup",
    diagnostics: { researchContext: { marketType: "moneyline" }, market_volume_usd: 11000 },
  })!;
  const high = buildWatchlistCandidate({
    condition_id: "c",
    selected_token_id: "dup",
    diagnostics: { researchContext: { marketType: "moneyline" }, market_volume_usd: 900000 },
  })!;
  const deduped = dedupeWatchlistCandidates([low, high]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].volumeUsd, 900000);
});

test("toWatchlistRow maps to snake_case payload with gate strings", () => {
  const c = buildWatchlistCandidate({
    condition_id: "c",
    selected_token_id: "tok",
    league: "EPL",
    diagnostics: { researchContext: { marketType: "total" }, market_volume_usd: 50000 },
  })!;
  const row = toWatchlistRow(c, 120, 10000);
  assert.equal(row.token_id, "tok");
  assert.equal(row.condition_id, "c");
  assert.equal(row.normalized_sport, "soccer");
  assert.equal(row.normalized_market_family, "total");
  assert.equal(row.market_family_gate_status, "passed");
  assert.equal(row.volume_gate_status, "passed");
  assert.equal(row.is_supported_p0_market_family, true);
  assert.equal(row.minutes_to_start_at_insert, 120);
  assert.equal(row.volume_gate_threshold_usd, 10000);
});

test("toWatchlistRow carries deferred volume disposition", () => {
  const c = buildWatchlistCandidate(realEsportsRow())!;
  const row = toWatchlistRow(c, null, 10000);
  assert.equal(row.market_family_gate_status, "passed");
  assert.equal(row.volume_gate_status, "deferred");
});
