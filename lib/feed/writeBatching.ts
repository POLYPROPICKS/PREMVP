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
 * generated_signal_pairs has no index on condition_id, so every dedup query is
 * a sequential scan costing ~6s regardless of how many IDs it carries — a full
 * broad batch needs ~90 of them, which runs for ~11 minutes and still hits
 * statement timeouts partway through. Rather than let a 30-minute cron overrun
 * itself and write a half-deduplicated batch, the writer refuses the batch and
 * says why. Lifting this cap needs an index on
 * (metric_formula_version, condition_id, selected_token_id), which is a schema
 * migration and therefore a separate, explicitly authorized change.
 */
export const SHADOW_DEDUP_MAX_QUERIES = 12;

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
