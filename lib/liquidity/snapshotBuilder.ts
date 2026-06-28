// LIQUIDITY_MODEL — pure snapshot payload construction + failure classification.
// No I/O. The capture script supplies fetch results; this turns them into
// SnapshotRow payloads (matching market_price_liquidity_snapshots) with computed
// microstructure metrics. Failure rows are recorded with status='failed'.

import {
  computeBuyableUsdAtSlippage,
  computeDepthWithinPct,
  computeMidPrice,
  computeSellableUsdAtSlippage,
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
 * Classify a fetch result into a DB SnapshotStatus + stable failure code.
 * ok = both sides present. partial = exactly one side (or empty) but fetched.
 * failed = transport/HTTP/parse/timeout failure.
 */
export function classifySnapshotFailure(result: FetchOrderBookResult): {
  status: SnapshotStatus;
  failureReason: string | null;
} {
  if (!result.ok) {
    if (result.errorCode === "TIMEOUT") return { status: "failed", failureReason: "timeout" };
    if (result.errorCode === "PARSE_FAILED") {
      return { status: "failed", failureReason: "parse_failed" };
    }
    if (typeof result.httpStatus === "number" && result.httpStatus >= 400) {
      return { status: "failed", failureReason: `http_${result.httpStatus}` };
    }
    return { status: "failed", failureReason: result.errorCode ?? "fetch_failed" };
  }
  const book = result.book;
  if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
    return { status: "partial", failureReason: "empty_book" };
  }
  if (book.bids.length === 0 || book.asks.length === 0) {
    return { status: "partial", failureReason: "one_sided_book" };
  }
  return { status: "ok", failureReason: null };
}

function impliedDecimalOdds(price: number | null): number | null {
  if (price === null || !(price > 0)) return null;
  return 1 / price;
}

export interface SnapshotBuildContext {
  capturedAt: string;
  snapshotReason?: string;
}

/**
 * Build a SnapshotRow from a watchlist row + fetch result. Always returns a row
 * (failed rows carry status='failed' + failure_reason and null metrics) so the
 * funnel report can account for every fetch attempt.
 */
export function buildSnapshotInsertPayload(
  watchlistRow: WatchlistRow,
  result: FetchOrderBookResult,
  ctx: SnapshotBuildContext,
): SnapshotRow {
  const { status, failureReason } = classifySnapshotFailure(result);
  const book = result.book ?? null;

  const minutesToStart = computeMinutesToStart(ctx.capturedAt, watchlistRow.game_start_iso);
  const phaseBucket = classifyPhaseBucket(minutesToStart);

  const { bestBid, bestAsk } = getBestBidAsk(book);
  const mid = computeMidPrice(book);
  const depth1 = computeDepthWithinPct(book, 0.01);
  const depth2 = computeDepthWithinPct(book, 0.02);
  const depth5 = computeDepthWithinPct(book, 0.05);

  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const bidDepthTotal = bids.reduce((sum, l) => sum + l.price * l.size, 0);
  const askDepthTotal = asks.reduce((sum, l) => sum + l.price * l.size, 0);

  return {
    captured_at: ctx.capturedAt,
    source: "polymarket",
    snapshot_reason: ctx.snapshotReason ?? "scheduled",
    snapshot_status: status,
    condition_id: watchlistRow.condition_id,
    token_id: watchlistRow.token_id,
    opposing_token_id: watchlistRow.opposing_token_id,
    event_slug: watchlistRow.event_slug,
    market_slug: watchlistRow.market_slug,
    selected_outcome: watchlistRow.selected_outcome,
    normalized_sport: watchlistRow.normalized_sport,
    league: watchlistRow.league,
    normalized_market_family: watchlistRow.normalized_market_family,
    match_family_key: watchlistRow.match_family_key,
    game_start_iso: watchlistRow.game_start_iso,
    minutes_to_start: minutesToStart,
    phase_bucket: phaseBucket,
    market_volume_usd: watchlistRow.market_volume_usd,
    volume_gate_status: watchlistRow.volume_gate_status,
    volume_gate_threshold_usd: watchlistRow.volume_gate_threshold_usd,
    market_family_gate_status: watchlistRow.market_family_gate_status,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid_price: mid,
    implied_decimal_odds_mid: impliedDecimalOdds(mid),
    implied_decimal_odds_bid: impliedDecimalOdds(bestBid),
    implied_decimal_odds_ask: impliedDecimalOdds(bestAsk),
    spread_abs: computeSpread(book),
    spread_bps: computeSpreadBps(book),
    bid_depth_total: status === "failed" ? null : bidDepthTotal,
    ask_depth_total: status === "failed" ? null : askDepthTotal,
    bid_depth_1pct: depth1.bidDepthUsd,
    bid_depth_2pct: depth2.bidDepthUsd,
    bid_depth_5pct: depth5.bidDepthUsd,
    ask_depth_1pct: depth1.askDepthUsd,
    ask_depth_2pct: depth2.askDepthUsd,
    ask_depth_5pct: depth5.askDepthUsd,
    exit_sellable_usd_1pct: computeSellableUsdAtSlippage(bids, 0.01),
    exit_sellable_usd_2pct: computeSellableUsdAtSlippage(bids, 0.02),
    exit_sellable_usd_5pct: computeSellableUsdAtSlippage(bids, 0.05),
    entry_buyable_usd_1pct: computeBuyableUsdAtSlippage(asks, 0.01),
    entry_buyable_usd_2pct: computeBuyableUsdAtSlippage(asks, 0.02),
    entry_buyable_usd_5pct: computeBuyableUsdAtSlippage(asks, 0.05),
    book_levels_json: { bids, asks },
    api_latency_ms: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
    failure_reason: failureReason,
    diagnostics: {
      http_status: result.httpStatus ?? null,
      error_code: result.errorCode ?? null,
    },
  };
}
