import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWatchlistCandidate,
  dedupeWatchlistCandidates,
  extractMarketVolumeUsd,
  toWatchlistRow,
} from "../../lib/liquidity/watchlistBuilder";

test("buildWatchlistCandidate maps real research-snapshot columns", () => {
  const c = buildWatchlistCandidate({
    id: "row-1",
    condition_id: "cond-1",
    selected_token_id: "tok123",
    opposing_token_id: "tok456",
    league: "NBA",
    market_family: "moneyline",
    game_start_iso: "2026-06-26T20:00:00.000Z",
    selected_outcome: "Lakers",
    diagnostics: { market_volume_usd: 25000 },
  });
  assert.ok(c);
  assert.equal(c!.conditionId, "cond-1");
  assert.equal(c!.tokenId, "tok123");
  assert.equal(c!.normalizedSport, "basketball"); // derived from league
  assert.equal(c!.sportSource, "league_derived");
  assert.equal(c!.normalizedMarketFamily, "moneyline");
  assert.equal(c!.marketFamilyGate, "SUPPORTED");
  assert.equal(c!.volumeUsd, 25000);
  assert.equal(c!.volumeSource, "diagnostics");
  assert.equal(c!.volumeGate, "PASS");
});

test("buildWatchlistCandidate returns null without token id or condition id", () => {
  assert.equal(buildWatchlistCandidate({ league: "NBA" }), null);
  assert.equal(buildWatchlistCandidate({ selected_token_id: "t" }), null); // no condition
  assert.equal(buildWatchlistCandidate({ condition_id: "c" }), null); // no token
});

test("missing volume fails the gate (hard)", () => {
  const c = buildWatchlistCandidate({
    condition_id: "c",
    selected_token_id: "t",
    league: "EPL",
    market_family: "moneyline",
  });
  assert.equal(c!.volumeUsd, null);
  assert.equal(c!.volumeGate, "FAIL_MISSING_VOLUME");
  assert.equal(c!.volumeSource, null);
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

test("excluded family and prop detection", () => {
  const prop = buildWatchlistCandidate({
    condition_id: "c",
    selected_token_id: "p",
    market_family: "player_prop",
    diagnostics: { market_volume_usd: 99999 },
  });
  assert.equal(prop!.marketFamilyGate, "EXCLUDED_PROP");
  assert.equal(prop!.isProp, true);
});

test("dedupeWatchlistCandidates keeps highest priority per condition+token", () => {
  const low = buildWatchlistCandidate({
    condition_id: "c",
    selected_token_id: "dup",
    market_family: "moneyline",
    diagnostics: { market_volume_usd: 11000 },
  })!;
  const high = buildWatchlistCandidate({
    condition_id: "c",
    selected_token_id: "dup",
    market_family: "moneyline",
    diagnostics: { market_volume_usd: 900000 },
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
    market_family: "total",
    diagnostics: { market_volume_usd: 50000 },
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
