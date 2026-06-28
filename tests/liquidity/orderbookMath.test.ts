import test from "node:test";
import assert from "node:assert/strict";
import {
  computeBuyableUsdAtSlippage,
  computeDepthWithinPct,
  computeEntryExitReturn,
  computeExecutableExit,
  computeMidPrice,
  computeNetReturnPct,
  computeSellableUsdAtSlippage,
  computeSpread,
  computeSpreadBps,
  getBestBidAsk,
  normalizeTokenId,
  parseOrderBook,
} from "../../lib/liquidity/orderbookMath";

test("normalizeTokenId trims, unquotes, rejects empty", () => {
  assert.equal(normalizeTokenId("  123456  "), "123456");
  assert.equal(normalizeTokenId('"789"'), "789");
  assert.equal(normalizeTokenId(42), "42");
  assert.equal(normalizeTokenId(""), null);
  assert.equal(normalizeTokenId(null), null);
  assert.equal(normalizeTokenId(undefined), null);
});

test("parseOrderBook handles string and number prices and tuple form", () => {
  const book = parseOrderBook({
    asset_id: "tok1",
    bids: [
      { price: "0.40", size: "100" },
      { price: 0.45, size: 50 },
    ],
    asks: [
      [0.55, 20],
      ["0.50", "30"],
    ],
  });
  assert.ok(book);
  assert.equal(book!.tokenId, "tok1");
  // bids descending, asks ascending
  assert.deepEqual(
    book!.bids.map((b) => b.price),
    [0.45, 0.4],
  );
  assert.deepEqual(
    book!.asks.map((a) => a.price),
    [0.5, 0.55],
  );
});

test("parseOrderBook drops invalid levels and returns null without token id", () => {
  const book = parseOrderBook({ asset_id: "t", bids: [{ price: -1, size: 5 }, { price: 0.3, size: 0 }], asks: [] });
  assert.equal(book!.bids.length, 0);
  assert.equal(parseOrderBook({ bids: [], asks: [] }), null);
});

const sampleBook = parseOrderBook({
  token_id: "t",
  bids: [
    { price: 0.5, size: 100 },
    { price: 0.49, size: 200 },
    { price: 0.45, size: 1000 },
  ],
  asks: [
    { price: 0.52, size: 100 },
    { price: 0.55, size: 500 },
  ],
})!;

test("getBestBidAsk / mid / spread / spreadBps", () => {
  assert.deepEqual(getBestBidAsk(sampleBook), { bestBid: 0.5, bestAsk: 0.52 });
  assert.equal(computeMidPrice(sampleBook), 0.51);
  assert.ok(Math.abs(computeSpread(sampleBook)! - 0.02) < 1e-9);
  assert.ok(Math.abs(computeSpreadBps(sampleBook)! - (0.02 / 0.51) * 10000) < 1e-6);
});

test("getBestBidAsk returns nulls for empty sides", () => {
  const oneSided = parseOrderBook({ token_id: "t", bids: [{ price: 0.4, size: 10 }], asks: [] })!;
  assert.deepEqual(getBestBidAsk(oneSided), { bestBid: 0.4, bestAsk: null });
  assert.equal(computeMidPrice(oneSided), null);
  assert.equal(computeSpread(oneSided), null);
  assert.equal(computeSpreadBps(oneSided), null);
});

test("computeDepthWithinPct sums notional within bands of mid", () => {
  // mid = 0.51. 1% band: bids >= 0.5049 -> none (0.5 < 0.5049). asks <= 0.5151 -> none (0.52 > 0.5151).
  const d1 = computeDepthWithinPct(sampleBook, 0.01);
  assert.equal(d1.bidDepthUsd, 0);
  assert.equal(d1.askDepthUsd, 0);
  // 2% band: bids >= 0.4998 -> only 0.5 level. asks <= 0.5202 -> only 0.52 level.
  const d2 = computeDepthWithinPct(sampleBook, 0.02);
  assert.ok(Math.abs(d2.bidDepthUsd! - 0.5 * 100) < 1e-9);
  assert.ok(Math.abs(d2.askDepthUsd! - 0.52 * 100) < 1e-9);
  // 5% band: bids >= 0.4845 -> 0.5 and 0.49 levels. asks <= 0.5355 -> 0.52 only.
  const d5 = computeDepthWithinPct(sampleBook, 0.05);
  assert.ok(Math.abs(d5.bidDepthUsd! - (0.5 * 100 + 0.49 * 200)) < 1e-9);
  assert.ok(Math.abs(d5.askDepthUsd! - 0.52 * 100) < 1e-9);
});

test("sellable/buyable USD at slippage", () => {
  // sell into bids within 5% of best bid 0.5 -> floor 0.475 -> 0.5 and 0.49 levels.
  const sell = computeSellableUsdAtSlippage(sampleBook.bids, 0.05);
  assert.ok(Math.abs(sell! - (0.5 * 100 + 0.49 * 200)) < 1e-9);
  // buy from asks within 5% of best ask 0.52 -> ceil 0.546 -> only 0.52 level.
  const buy = computeBuyableUsdAtSlippage(sampleBook.asks, 0.05);
  assert.ok(Math.abs(buy! - 0.52 * 100) < 1e-9);
  assert.equal(computeSellableUsdAtSlippage([], 0.05), null);
});

test("computeExecutableExit fully fills within depth", () => {
  const exit = computeExecutableExit(sampleBook.bids, 250);
  assert.equal(exit.fullyFilled, true);
  assert.equal(exit.filledShares, 250);
  // 100@0.5 + 150@0.49 = 50 + 73.5 = 123.5
  assert.ok(Math.abs(exit.proceedsUsd - 123.5) < 1e-9);
  assert.ok(Math.abs(exit.avgPrice! - 123.5 / 250) < 1e-9);
  assert.equal(exit.remainingShares, 0);
});

test("computeExecutableExit reports insufficient depth within slippage band", () => {
  // within 1% of best bid 0.5 -> floor 0.495 -> only the 100@0.5 level usable.
  const exit = computeExecutableExit(sampleBook.bids, 250, 0.01);
  assert.equal(exit.fullyFilled, false);
  assert.equal(exit.filledShares, 100);
  assert.equal(exit.remainingShares, 150);
});

test("computeEntryExitReturn round trip and net return", () => {
  // stake 52 -> shares = 52/0.52 = 100. exit 100 shares: 100@0.5 = 50 proceeds.
  const r = computeEntryExitReturn(sampleBook, 52, 0.15);
  assert.equal(r.entryPrice, 0.52);
  assert.ok(Math.abs(r.shares! - 100) < 1e-9);
  assert.ok(Math.abs(r.exitProceedsUsd! - 50) < 1e-9);
  assert.ok(Math.abs(r.netReturnPct! - ((50 - 52) / 52) * 100) < 1e-6);
});

test("computeNetReturnPct honors fee and null inputs", () => {
  assert.equal(computeNetReturnPct(100, 110, 0), 10);
  assert.ok(Math.abs(computeNetReturnPct(100, 110, 0.01)! - (110 * 0.99 - 100)) < 1e-9);
  assert.equal(computeNetReturnPct(0, 110), null);
  assert.equal(computeNetReturnPct(100, null), null);
});
