// LIQUIDITY_MODEL — pure failure-reason bucketing for CLOB snapshot capture.
//
// Snapshot rows store a free-text `failure_reason` (e.g. "http_404", "timeout").
// For actionable diagnostics we collapse the long tail of raw reasons into a
// small, stable set of canonical buckets so logs/reports can answer "why are
// captures failing?" at a glance. No I/O; safe to import anywhere.

/** Canonical, stable failure buckets surfaced in logs/reports. */
export type FailureBucket =
  | "http_404"
  | "http_429"
  | "timeout"
  | "network_error"
  | "empty_book"
  | "unknown";

/** Fixed bucket order — drives zero-filling and the rendered summary line. */
export const FAILURE_BUCKET_KEYS: FailureBucket[] = [
  "http_404",
  "http_429",
  "timeout",
  "network_error",
  "empty_book",
  "unknown",
];

export type FailureBucketCounts = Record<FailureBucket, number>;

/** Reasons that represent a transport/connectivity failure (no HTTP status). */
const NETWORK_REASONS = new Set(["network_error", "fetch_failed", "no_fetch", "invalid_token_id"]);

/**
 * Map a single raw `failure_reason` to its canonical bucket. Tolerant of
 * null/empty/casing/whitespace. Unmapped reasons (parse_failed, one_sided_book,
 * other HTTP codes, etc.) fall to `unknown` so nothing is silently dropped.
 */
export function bucketFailureReason(reason: string | null | undefined): FailureBucket {
  const r = (reason ?? "").trim().toLowerCase();
  if (!r) return "unknown";
  if (r === "http_404") return "http_404";
  if (r === "http_429") return "http_429";
  if (r === "timeout") return "timeout";
  if (r === "empty_book") return "empty_book";
  if (NETWORK_REASONS.has(r)) return "network_error";
  return "unknown";
}

function zeroCounts(): FailureBucketCounts {
  return { http_404: 0, http_429: 0, timeout: 0, network_error: 0, empty_book: 0, unknown: 0 };
}

/** Tally a list of raw failure reasons into the six canonical buckets. */
export function tallyFailureBuckets(reasons: Array<string | null | undefined>): FailureBucketCounts {
  const counts = zeroCounts();
  for (const reason of reasons) {
    counts[bucketFailureReason(reason)] += 1;
  }
  return counts;
}

export interface FailureBucketSummary {
  totalFailures: number;
  /** Dominant bucket (FAILURE_BUCKET_KEYS order breaks ties); "none" when empty. */
  topReason: FailureBucket | "none";
  counts: FailureBucketCounts;
}

/** Summarize raw failure reasons: total, top bucket, and per-bucket counts. */
export function summarizeFailureBuckets(
  reasons: Array<string | null | undefined>,
): FailureBucketSummary {
  const counts = tallyFailureBuckets(reasons);
  let totalFailures = 0;
  let topReason: FailureBucket | "none" = "none";
  let topCount = 0;
  for (const key of FAILURE_BUCKET_KEYS) {
    const n = counts[key];
    totalFailures += n;
    if (n > topCount) {
      topCount = n;
      topReason = key;
    }
  }
  return { totalFailures, topReason, counts };
}

/** Render the canonical parseable failure-bucket log line. */
export function renderFailureBucketsLine(counts: FailureBucketCounts): string {
  const parts = FAILURE_BUCKET_KEYS.map((key) => `${key}=${counts[key]}`);
  return `LIQUIDITY_SNAPSHOT_FAILURE_BUCKETS ${parts.join(" ")}`;
}
