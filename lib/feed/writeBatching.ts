// Bounded request batching for the generated-signal writers.
//
// The broad structured-sports collector proposes tens of thousands of rows per
// run. Issuing that as one dedup query plus one insert produced a multi-megabyte
// query string and a ~40 MB insert body, both of which the PostgREST endpoint
// rejects — so the entire broad write failed and nothing was ever persisted.
// Splitting into bounded requests keeps each call well inside transport limits
// without changing any selection or dedup semantics.

/** Condition IDs per read-before-write dedup query. */
export const SHADOW_DEDUP_QUERY_CHUNK = 200;

/** Rows per insert request. */
export const SHADOW_INSERT_CHUNK = 500;

/**
 * Maximum dedup queries a single run may issue.
 *
 * The production index on
 * (condition_id, selected_token_id, metric_formula_version) makes these
 * bounded lookups cheap enough for the full observed broad batch. The
 * 2026-08-07 production run proposed 86,948 outcome rows, or at most 43,474
 * distinct binary-market condition IDs (218 chunks). 250 leaves measured
 * headroom while retaining a fail-closed guard if the producer grows beyond
 * the cron's safe budget.
 */
export const SHADOW_DEDUP_MAX_QUERIES = 250;

/** Marker for the explicit fail-closed path above. */
export const SHADOW_DEDUP_BUDGET_EXCEEDED = "SHADOW_DEDUP_BUDGET_EXCEEDED";

/**
 * Split `items` into consecutive chunks of at most `size`, preserving order and
 * losing nothing. A non-positive or non-finite size yields a single chunk so a
 * misconfiguration can never silently drop rows.
 */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  if (!Number.isFinite(size) || size <= 0) return [[...items]];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
