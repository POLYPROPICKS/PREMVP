// LIQUIDITY_MODEL — pure orderbook microstructure math.
//
// Convention for a YES long position on a Polymarket binary market:
//   - asks are ENTRY liquidity (you BUY YES at the best ask, walking up).
//   - bids are EXIT liquidity (you SELL YES, walking the bid book downward
//     from the highest bid).
//   - Executable return uses real fills, never the midpoint ("no midpoint
//     fantasy"). The midpoint is reported for reference only.
//   - Unknown values return null, never fake zeros.

import type { OrderBookLevel, ParsedOrderBook } from "./types";

/**
 * Normalize a token id to a trimmed string. Token ids are large decimal
 * strings; we do not lowercase them. Returns null for empty/invalid input.
 */
export function normalizeTokenId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return String(raw);
  }
  const s = String(raw).trim();
  if (!s) return null;
  // Strip surrounding quotes if a caller passed a JSON-encoded string.
  const unquoted = s.replace(/^"+|"+$/g, "").trim();
  return unquoted || null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function coerceLevels(raw: unknown): OrderBookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: OrderBookLevel[] = [];
  for (const entry of raw) {
    let price: number | null = null;
    let size: number | null = null;
    if (Array.isArray(entry)) {
      // [price, size] tuple form.
      price = toFiniteNumber(entry[0]);
      size = toFiniteNumber(entry[1]);
    } else if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      price = toFiniteNumber(obj.price ?? obj.p);
      size = toFiniteNumber(obj.size ?? obj.s ?? obj.quantity);
    }
    if (price === null || size === null) continue;
    if (price <= 0 || size <= 0) continue;
    out.push({ price, size });
  }
  return out;
}

/**
 * Parse a raw orderbook payload (Polymarket CLOB shape or generic) into a
 * normalized ParsedOrderBook. Handles string or numeric prices/sizes and
 * either {price,size} objects or [price,size] tuples.
 * Returns null only when no token id can be derived.
 */
export function parseOrderBook(
  raw: unknown,
  tokenIdHint?: string | null,
): ParsedOrderBook | null {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tokenId =
    normalizeTokenId(tokenIdHint) ??
    normalizeTokenId(obj.asset_id) ??
    normalizeTokenId(obj.token_id) ??
    normalizeTokenId(obj.tokenId) ??
    normalizeTokenId(obj.market);
  if (!tokenId) return null;

  const bids = coerceLevels(obj.bids ?? obj.buys);
  const asks = coerceLevels(obj.asks ?? obj.sells);

  // bids: highest price first; asks: lowest price first.
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  return { tokenId, bids, asks, raw };
}

/** Best (highest) bid and best (lowest) ask, or null when a side is empty. */
export function getBestBidAsk(book: ParsedOrderBook | null | undefined): {
  bestBid: number | null;
  bestAsk: number | null;
} {
  if (!book) return { bestBid: null, bestAsk: null };
  const bestBid = book.bids.length ? book.bids[0].price : null;
  const bestAsk = book.asks.length ? book.asks[0].price : null;
  return { bestBid, bestAsk };
}

/** Midpoint = (bestBid + bestAsk) / 2. Reference only — not executable. */
export function computeMidPrice(book: ParsedOrderBook | null | undefined): number | null {
  const { bestBid, bestAsk } = getBestBidAsk(book);
  if (bestBid === null || bestAsk === null) return null;
  return (bestBid + bestAsk) / 2;
}

/** Absolute spread = bestAsk - bestBid. */
export function computeSpread(book: ParsedOrderBook | null | undefined): number | null {
  const { bestBid, bestAsk } = getBestBidAsk(book);
  if (bestBid === null || bestAsk === null) return null;
  return bestAsk - bestBid;
}

/** Spread in basis points relative to the midpoint. */
export function computeSpreadBps(book: ParsedOrderBook | null | undefined): number | null {
  const spread = computeSpread(book);
  const mid = computeMidPrice(book);
  if (spread === null || mid === null || mid <= 0) return null;
  return (spread / mid) * 10000;
}

/**
 * USD notional resting within `pct` (fractional, e.g. 0.01 = 1%) of the
 * midpoint on each side. Bids count down to mid*(1-pct); asks up to
 * mid*(1+pct). Notional per level = price * size.
 * Returns nulls when there is no midpoint reference.
 */
export function computeDepthWithinPct(
  book: ParsedOrderBook | null | undefined,
  pct: number,
): { bidDepthUsd: number | null; askDepthUsd: number | null } {
  const mid = computeMidPrice(book);
  if (!book || mid === null || !(pct > 0)) {
    return { bidDepthUsd: null, askDepthUsd: null };
  }
  const bidFloor = mid * (1 - pct);
  const askCeil = mid * (1 + pct);
  let bidDepthUsd = 0;
  for (const lvl of book.bids) {
    if (lvl.price < bidFloor) break;
    bidDepthUsd += lvl.price * lvl.size;
  }
  let askDepthUsd = 0;
  for (const lvl of book.asks) {
    if (lvl.price > askCeil) break;
    askDepthUsd += lvl.price * lvl.size;
  }
  return { bidDepthUsd, askDepthUsd };
}

/**
 * USD proceeds obtainable by SELLING into the bid book while staying within
 * `slippagePct` (fractional) below the reference price (best bid by default).
 * Walks bids highest-first. Returns null when there is no bid liquidity.
 */
export function computeSellableUsdAtSlippage(
  bids: OrderBookLevel[] | null | undefined,
  slippagePct: number,
  referencePrice?: number | null,
): number | null {
  if (!bids || bids.length === 0 || !(slippagePct >= 0)) return null;
  const sorted = [...bids].sort((a, b) => b.price - a.price);
  const ref = referencePrice ?? sorted[0].price;
  if (!(ref > 0)) return null;
  const floor = ref * (1 - slippagePct);
  let usd = 0;
  for (const lvl of sorted) {
    if (lvl.price < floor) break;
    usd += lvl.price * lvl.size;
  }
  return usd;
}

/**
 * USD cost to BUY from the ask book while staying within `slippagePct`
 * (fractional) above the reference price (best ask by default).
 * Walks asks lowest-first. Returns null when there is no ask liquidity.
 */
export function computeBuyableUsdAtSlippage(
  asks: OrderBookLevel[] | null | undefined,
  slippagePct: number,
  referencePrice?: number | null,
): number | null {
  if (!asks || asks.length === 0 || !(slippagePct >= 0)) return null;
  const sorted = [...asks].sort((a, b) => a.price - b.price);
  const ref = referencePrice ?? sorted[0].price;
  if (!(ref > 0)) return null;
  const ceil = ref * (1 + slippagePct);
  let usd = 0;
  for (const lvl of sorted) {
    if (lvl.price > ceil) break;
    usd += lvl.price * lvl.size;
  }
  return usd;
}

export interface ExecutableExit {
  /** Shares actually fillable from available bids (capped by slippage band). */
  filledShares: number;
  /** USD proceeds for the filled shares. */
  proceedsUsd: number;
  /** Volume-weighted average exit price for the filled shares, or null. */
  avgPrice: number | null;
  /** True when the full requested share quantity was filled. */
  fullyFilled: boolean;
  /** Requested shares minus filled shares. */
  remainingShares: number;
}

/**
 * Walk the bid book (highest first) to exit `sharesToSell` shares.
 * When `slippagePct` is provided, levels below bestBid*(1-slippagePct) are
 * not used (insufficient-depth case). Partial fills are reported honestly.
 */
export function computeExecutableExit(
  bids: OrderBookLevel[] | null | undefined,
  sharesToSell: number,
  slippagePct?: number | null,
): ExecutableExit {
  const empty: ExecutableExit = {
    filledShares: 0,
    proceedsUsd: 0,
    avgPrice: null,
    fullyFilled: false,
    remainingShares: Number.isFinite(sharesToSell) && sharesToSell > 0 ? sharesToSell : 0,
  };
  if (!bids || bids.length === 0 || !(sharesToSell > 0)) return empty;

  const sorted = [...bids].sort((a, b) => b.price - a.price);
  const floor =
    slippagePct !== null && slippagePct !== undefined && slippagePct >= 0
      ? sorted[0].price * (1 - slippagePct)
      : 0;

  let remaining = sharesToSell;
  let proceeds = 0;
  let filled = 0;
  for (const lvl of sorted) {
    if (lvl.price < floor) break;
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.size);
    proceeds += take * lvl.price;
    filled += take;
    remaining -= take;
  }

  return {
    filledShares: filled,
    proceedsUsd: proceeds,
    avgPrice: filled > 0 ? proceeds / filled : null,
    fullyFilled: remaining <= 1e-9,
    remainingShares: Math.max(0, remaining),
  };
}

export interface EntryExitReturn {
  entryPrice: number | null;
  shares: number | null;
  stakeUsd: number;
  exitProceedsUsd: number | null;
  fullyFilled: boolean;
  netReturnPct: number | null;
}

/**
 * Simulate buying `stakeUsd` of YES at the best ask, then immediately exiting
 * into the bid book within `slippagePct`. Pure round-trip executable return.
 */
export function computeEntryExitReturn(
  book: ParsedOrderBook | null | undefined,
  stakeUsd: number,
  slippagePct?: number | null,
  feePct = 0,
): EntryExitReturn {
  const base: EntryExitReturn = {
    entryPrice: null,
    shares: null,
    stakeUsd,
    exitProceedsUsd: null,
    fullyFilled: false,
    netReturnPct: null,
  };
  const { bestAsk } = getBestBidAsk(book);
  if (!book || bestAsk === null || !(stakeUsd > 0) || !(bestAsk > 0)) return base;

  const shares = stakeUsd / bestAsk;
  const exit = computeExecutableExit(book.bids, shares, slippagePct);
  // Honest proceeds: partial fills report only what actually fills.
  const netReturnPct = computeNetReturnPct(stakeUsd, exit.proceedsUsd, feePct);
  return {
    entryPrice: bestAsk,
    shares,
    stakeUsd,
    exitProceedsUsd: exit.proceedsUsd,
    fullyFilled: exit.fullyFilled,
    netReturnPct,
  };
}

/**
 * Net return percent of a round-trip. fee is fractional (0.01 = 1%) applied to
 * exit proceeds. Returns null for non-positive stake.
 */
export function computeNetReturnPct(
  stakeUsd: number,
  exitProceedsUsd: number | null,
  feePct = 0,
): number | null {
  if (!(stakeUsd > 0) || exitProceedsUsd === null) return null;
  const net = exitProceedsUsd * (1 - feePct) - stakeUsd;
  return (net / stakeUsd) * 100;
}
