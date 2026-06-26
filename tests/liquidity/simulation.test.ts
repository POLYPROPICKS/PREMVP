import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEntryExitSimulation,
  selectEntryExitPairs,
  summarizeSimulationFlags,
} from "../../lib/liquidity/simulation";
import type { ParsedOrderBook, SnapshotRow } from "../../lib/liquidity/types";

const deepBook: ParsedOrderBook = {
  tokenId: "t",
  bids: [
    { price: 0.5, size: 10000 },
    { price: 0.49, size: 10000 },
  ],
  asks: [{ price: 0.51, size: 10000 }],
};

test("buildEntryExitSimulation marks executable when depth is ample", () => {
  const sim = buildEntryExitSimulation(
    {
      tokenId: "t",
      marketId: null,
      normalizedSport: "soccer",
      normalizedMarketFamily: "moneyline",
      phaseBucket: "T_1H",
      book: deepBook,
    },
    10,
    "2026-06-26T00:00:00.000Z",
  );
  assert.equal(sim.entry_price, 0.51);
  assert.equal(sim.executable_5pct, true);
  assert.equal(sim.executable_15pct, true);
  assert.ok(sim.shares! > 0);
});

test("buildEntryExitSimulation reports not-executable on thin book", () => {
  const thin: ParsedOrderBook = {
    tokenId: "t",
    bids: [{ price: 0.5, size: 1 }],
    asks: [{ price: 0.51, size: 100000 }],
  };
  const sim = buildEntryExitSimulation(
    {
      tokenId: "t",
      marketId: null,
      normalizedSport: "soccer",
      normalizedMarketFamily: "moneyline",
      phaseBucket: "T_1H",
      book: thin,
    },
    100,
  );
  assert.equal(sim.executable_5pct, false);
});

function snap(overrides: Partial<SnapshotRow>): SnapshotRow {
  return {
    token_id: "t",
    market_id: null,
    normalized_sport: "soccer",
    normalized_market_family: "moneyline",
    captured_at: "2026-06-26T00:00:00.000Z",
    game_start_iso: null,
    minutes_to_start: null,
    phase_bucket: "T_1H",
    status: "OK",
    failure_code: null,
    best_bid: 0.5,
    best_ask: 0.51,
    mid_price: 0.505,
    spread: 0.01,
    spread_bps: 198,
    bid_depth_1pct_usd: null,
    ask_depth_1pct_usd: null,
    bid_depth_2pct_usd: null,
    ask_depth_2pct_usd: null,
    bid_depth_5pct_usd: null,
    ask_depth_5pct_usd: null,
    latency_ms: 12,
    bids: [{ price: 0.5, size: 10000 }],
    asks: [{ price: 0.51, size: 10000 }],
    ...overrides,
  };
}

test("selectEntryExitPairs keeps latest usable snapshot per token and caps", () => {
  const inputs = selectEntryExitPairs(
    [
      snap({ token_id: "a", captured_at: "2026-06-26T00:00:00.000Z" }),
      snap({ token_id: "a", captured_at: "2026-06-26T01:00:00.000Z", best_bid: 0.6 }),
      snap({ token_id: "b" }),
      snap({ token_id: "c", status: "FETCH_FAILED", bids: [], asks: [] }),
    ],
    10,
  );
  const tokens = inputs.map((i) => i.tokenId).sort();
  assert.deepEqual(tokens, ["a", "b"]);
  const cap1 = selectEntryExitPairs([snap({ token_id: "a" }), snap({ token_id: "b" })], 1);
  assert.equal(cap1.length, 1);
});

test("summarizeSimulationFlags aggregates executable counts", () => {
  const rows = [
    buildEntryExitSimulation({ tokenId: "a", marketId: null, normalizedSport: "soccer", normalizedMarketFamily: "moneyline", phaseBucket: "T_1H", book: deepBook }, 10),
    buildEntryExitSimulation({ tokenId: "b", marketId: null, normalizedSport: "soccer", normalizedMarketFamily: "moneyline", phaseBucket: "T_1H", book: deepBook }, 10),
  ];
  const flags = summarizeSimulationFlags(rows);
  assert.equal(flags.simulations, 2);
  assert.equal(flags.tokens, 2);
  assert.equal(flags.executable5pct, 2);
});
