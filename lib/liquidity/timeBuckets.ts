// LIQUIDITY_MODEL — pure time-bucket math.
// No I/O. Returns null/UNKNOWN for unparseable inputs rather than fake zeros.

import type { PhaseBucket } from "./types";

/**
 * Minutes from capture time until game start.
 * Positive = pre-game (start is in the future), negative = live/post.
 * Returns null when either timestamp is missing or unparseable.
 */
export function computeMinutesToStart(
  capturedAt: string | Date | null | undefined,
  gameStartIso: string | Date | null | undefined,
): number | null {
  const captured = toEpochMs(capturedAt);
  const start = toEpochMs(gameStartIso);
  if (captured === null || start === null) return null;
  return (start - captured) / 60000;
}

/**
 * Classify minutes-to-start into a phase bucket.
 * null minutes => UNKNOWN_START.
 * Pre-game buckets are upper-bounded thresholds (e.g. T_30M = 15..30 min out).
 * Live buckets use elapsed minutes since start.
 */
export function classifyPhaseBucket(minutesToStart: number | null): PhaseBucket {
  if (minutesToStart === null || !Number.isFinite(minutesToStart)) {
    return "UNKNOWN_START";
  }

  // Pre-game: start is in the future (minutesToStart > 0).
  if (minutesToStart > 720) return "T_12H_PLUS";
  if (minutesToStart > 360) return "T_12H";
  if (minutesToStart > 180) return "T_6H";
  if (minutesToStart > 120) return "T_3H";
  if (minutesToStart > 60) return "T_2H";
  if (minutesToStart > 30) return "T_1H";
  if (minutesToStart > 15) return "T_30M";
  if (minutesToStart > 10) return "T_15M";
  if (minutesToStart > 5) return "T_10M";
  if (minutesToStart > 0) return "T_5M";

  // Live / post: minutesToStart <= 0, elapsed = -minutesToStart.
  const elapsed = -minutesToStart;
  if (elapsed <= 5) return "LIVE_0_5M";
  if (elapsed <= 15) return "LIVE_5_15M";
  if (elapsed <= 240) return "LIVE_15M_PLUS";
  // More than 4h after start: treat as post/stale.
  return "POST_OR_STALE";
}

function toEpochMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  const s = String(value).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
