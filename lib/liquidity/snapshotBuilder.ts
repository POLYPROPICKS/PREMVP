// LIQUIDITY_MODEL — pure snapshot payload construction + failure classification.
// No I/O. The capture script supplies fetch results; this turns them into
// SnapshotRow payloads with computed microstructure metrics.

import {
  computeDepthWithinPct,
  computeMidPrice,
  computeSpread,
  computeSpreadBps,
  getBestBidAsk,
} from "./orderbookMath";
import { classifyPhaseBucket, computeMinutesToStart } from "./timeBuckets";
import type {
  FetchOrderBookResult,
  SnapshotRow,
  SnapshotStatus,
  WatchlistRow,
} from "./types";

/**
 * Classify a fetch result into a SnapshotStatus + stable failure code.
 * OK = both sides present. PARTIAL = exactly one side present.
 * EMPTY_BOOK = fetch ok but no levels at all.
 */
export function classifySnapshotFailure(result: FetchOrderBookResult): {
  status: SnapshotStatus;
  failureCode: string | null;
} {
  if (!result.ok) {
    if (result.errorCode === "TIMEOUT") return { status: "TIMEOUT", failureCode: "timeout" };
    if (result.errorCode === "PARSE_FAILED") {
      return { status: "PARSE_FAILED", failureCode: "parse_failed" };
    }
    if (typeof result.httpStatus === "number" && result.httpStatus >= 400) {
      return { status: "HTTP_ERROR", failureCode: `http_${result.httpStatus}` };
    }
    return { status: "FETCH_FAILED", failureCode: result.errorCode ?? "fetch_failed" };
  }
  const book = result.book;
  if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
    return { status: "EMPTY_BOOK", failureCode: "empty_book" };
  }
  if (book.bids.length === 0 || book.asks.length === 0) {
    return { status: "PARTIAL", failureCode: "one_sided_book" };
  }
  return { status: "OK", failureCode: null };
}

export interface SnapshotBuildContext {
  capturedAt: string;
}

/**
 * Build a SnapshotRow from a watchlist row + fetch result. Always returns a row
 * (failure rows are recorded with status/failure_code and null metrics) so the
 * funnel report can account for every fetch attempt.
 */
export function buildSnapshotInsertPayload(
  watchlistRow: WatchlistRow,
  result: FetchOrderBookResult,
  ctx: SnapshotBuildContext,
): SnapshotRow {
  const { status, failureCode } = classifySnapshotFailure(result);
  const book = result.book ?? null;

  const minutesToStart = computeMinutesToStart(ctx.capturedAt, watchlistRow.game_start_iso);
  const phaseBucket = classifyPhaseBucket(minutesToStart);

  const { bestBid, bestAsk } = getBestBidAsk(book);
  const depth1 = computeDepthWithinPct(book, 0.01);
  const depth2 = computeDepthWithinPct(book, 0.02);
  const depth5 = computeDepthWithinPct(book, 0.05);

  return {
    token_id: watchlistRow.token_id,
    market_id: watchlistRow.market_id,
    normalized_sport: watchlistRow.normalized_sport,
    normalized_market_family: watchlistRow.normalized_market_family,
    captured_at: ctx.capturedAt,
    game_start_iso: watchlistRow.game_start_iso,
    minutes_to_start: minutesToStart,
    phase_bucket: phaseBucket,
    status,
    failure_code: failureCode,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid_price: computeMidPrice(book),
    spread: computeSpread(book),
    spread_bps: computeSpreadBps(book),
    bid_depth_1pct_usd: depth1.bidDepthUsd,
    ask_depth_1pct_usd: depth1.askDepthUsd,
    bid_depth_2pct_usd: depth2.bidDepthUsd,
    ask_depth_2pct_usd: depth2.askDepthUsd,
    bid_depth_5pct_usd: depth5.bidDepthUsd,
    ask_depth_5pct_usd: depth5.askDepthUsd,
    latency_ms: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
    bids: book?.bids ?? [],
    asks: book?.asks ?? [],
  };
}
