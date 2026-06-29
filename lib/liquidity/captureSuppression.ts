// LIQUIDITY_MODEL — pure repeated-http_404 capture suppression logic.
//
// Production CLOB capture wastes ~95% of attempts on tokens whose orderbook
// endpoint returns a persistent HTTP 404 (delisted/never-listed/wrong token).
// This module decides, from a token's recent snapshot history (already in
// market_price_liquidity_snapshots), whether to SKIP fetching its book this
// run. It never fabricates data and never suppresses a token that has recovered.
//
// Rule (defaults): suppress a token when it has >= 3 http_404 failures inside
// the last 24h AND no ok/partial snapshot captured after its first in-window
// 404. One-off 404s, stale 404s outside the window, non-404 failures (timeout/
// network), and recovered tokens are never suppressed by this rule.
//
// No I/O. The capture script supplies recent rows; this returns a decision.

import { bucketFailureReason } from "./failureBuckets";
import type { SnapshotStatus } from "./types";

/** Minimal recent-snapshot shape needed to decide suppression. */
export interface RecentSnapshotLike {
  token_id: string;
  captured_at: string;
  snapshot_status: SnapshotStatus;
  failure_reason: string | null;
}

export interface SuppressionOptions {
  /** Min in-window http_404 failures to suppress. Default 3. */
  thresholdCount?: number;
  /** Lookback window in ms. Default 24h. */
  windowMs?: number;
  /** Reference "now" (ms epoch or ISO). Default Date.now(). */
  now?: number | string;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;

function toMs(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : fallback;
}

function isSuccess(status: SnapshotStatus): boolean {
  return status === "ok" || status === "partial";
}

/**
 * Decide whether to skip CLOB capture for a single token based on its recent
 * snapshot history. Pure; order-independent (rows are sorted internally).
 */
export function shouldSuppressLiquidityCaptureForToken(
  recentSnapshots: RecentSnapshotLike[],
  options: SuppressionOptions = {},
): boolean {
  const threshold = options.thresholdCount ?? DEFAULT_THRESHOLD;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = toMs(options.now, Date.now());
  const windowStart = now - windowMs;

  // Keep only in-window rows with a parseable timestamp, oldest -> newest.
  const inWindow = recentSnapshots
    .map((r) => ({ row: r, t: Date.parse(r.captured_at) }))
    .filter((x) => Number.isFinite(x.t) && x.t >= windowStart && x.t <= now)
    .sort((a, b) => a.t - b.t);

  let http404Count = 0;
  let firstHttp404At: number | null = null;
  let successAfterFirst404 = false;

  for (const { row, t } of inWindow) {
    const is404 =
      row.snapshot_status === "failed" && bucketFailureReason(row.failure_reason) === "http_404";
    if (is404) {
      http404Count += 1;
      if (firstHttp404At === null) firstHttp404At = t;
    } else if (isSuccess(row.snapshot_status) && firstHttp404At !== null && t > firstHttp404At) {
      successAfterFirst404 = true;
    }
  }

  return http404Count >= threshold && !successAfterFirst404;
}

export interface CaptureSuppressionPlan {
  /** Tokens to skip fetching this run. */
  suppressedTokens: Set<string>;
  /** Tokens to keep fetching, preserving input order. */
  keptTokens: string[];
  /** Count of tokens suppressed due to the repeated-http_404 rule. */
  repeatedHttp404: number;
  /** Total tokens skipped (== repeatedHttp404 today; kept distinct for clarity). */
  tokensSkipped: number;
}

/**
 * Build a suppression plan for a batch of candidate tokens given their recent
 * snapshot history (keyed by token_id). Tokens with no history are kept.
 */
export function planCaptureSuppression(
  tokenIds: string[],
  recentByToken: Map<string, RecentSnapshotLike[]>,
  options: SuppressionOptions = {},
): CaptureSuppressionPlan {
  const suppressedTokens = new Set<string>();
  const keptTokens: string[] = [];
  for (const tokenId of tokenIds) {
    const history = recentByToken.get(tokenId) ?? [];
    if (history.length > 0 && shouldSuppressLiquidityCaptureForToken(history, options)) {
      suppressedTokens.add(tokenId);
    } else {
      keptTokens.push(tokenId);
    }
  }
  return {
    suppressedTokens,
    keptTokens,
    repeatedHttp404: suppressedTokens.size,
    tokensSkipped: suppressedTokens.size,
  };
}

/** Render the canonical parseable capture-skip summary line. */
export function renderCaptureSkipSummaryLine(plan: CaptureSuppressionPlan): string {
  return `LIQUIDITY_SNAPSHOT_CAPTURE_SKIP_SUMMARY repeated_http_404=${plan.repeatedHttp404} tokens_skipped=${plan.tokensSkipped}`;
}
