import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWatchlistCandidate,
  dedupeWatchlistCandidates,
  toWatchlistRow,
} from "../../lib/liquidity/watchlistBuilder";

test("buildWatchlistCandidate normalizes sport/family and runs gates", () => {
  const c = buildWatchlistCandidate({
    token_id: "tok123",
    market_id: "mkt1",
    sport: "NBA",
    market_family: "moneyline",
    volume_usd: 25000,
    question: "Who wins?",
  });
  assert.ok(c);
  assert.equal(c!.tokenId, "tok123");
  assert.equal(c!.normalizedSport, "basketball");
  assert.equal(c!.normalizedMarketFamily, "moneyline");
  assert.equal(c!.marketFamilyGate, "SUPPORTED");
  assert.equal(c!.volumeGate, "PASS");
});

test("buildWatchlistCandidate returns null without token id", () => {
  assert.equal(buildWatchlistCandidate({ sport: "NBA" }), null);
});

test("buildWatchlistCandidate marks excluded families and failing volume", () => {
  const prop = buildWatchlistCandidate({ token_id: "p", market_family: "player_prop", volume_usd: 99999 });
  assert.equal(prop!.marketFamilyGate, "EXCLUDED_PROP");
  const lowVol = buildWatchlistCandidate({ token_id: "l", market_family: "moneyline", volume_usd: 100 });
  assert.equal(lowVol!.volumeGate, "FAIL_BELOW_THRESHOLD");
});

test("dedupeWatchlistCandidates keeps highest priority per token", () => {
  const low = buildWatchlistCandidate({ token_id: "dup", market_family: "moneyline", volume_usd: 11000 })!;
  const high = buildWatchlistCandidate({ token_id: "dup", market_family: "moneyline", volume_usd: 900000 })!;
  const deduped = dedupeWatchlistCandidates([low, high]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].volumeUsd, 900000);
});

test("toWatchlistRow maps to snake_case payload", () => {
  const c = buildWatchlistCandidate({ token_id: "tok", sport: "EPL", market_family: "total", volume_usd: 50000 })!;
  const row = toWatchlistRow(c);
  assert.equal(row.token_id, "tok");
  assert.equal(row.normalized_sport, "soccer");
  assert.equal(row.normalized_market_family, "total");
  assert.equal(row.volume_gate, "PASS");
});
