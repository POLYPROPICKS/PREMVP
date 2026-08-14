import { supabaseAdmin } from "@/lib/supabase/server";

export const CURRENT_SERVING_PRUNE_BATCH_SIZE = 25;

export class ServingProjectionPendingError extends Error {
  readonly sourceGeneratedSignalPairIds: readonly string[];

  constructor(sourceGeneratedSignalPairIds: readonly string[], cause: unknown) {
    super(`SERVING_PROJECTION_PENDING source_ids=${sourceGeneratedSignalPairIds.join(",")}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ServingProjectionPendingError";
    this.sourceGeneratedSignalPairIds = sourceGeneratedSignalPairIds;
  }
}

/**
 * Historical rows have already committed when this runs. A failure is explicit
 * and recoverable by rerunning the SQL-owned deterministic reconciler; it never
 * rolls back or mutates the historical corpus.
 */
export async function refreshCurrentSignalPairServing(sourceGeneratedSignalPairIds: readonly string[]): Promise<void> {
  const ids = [...new Set(sourceGeneratedSignalPairIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return;
  const { error } = await supabaseAdmin.rpc("refresh_current_signal_pair_serving", {
    p_source_generated_signal_pair_ids: ids,
  });
  if (error) throw new ServingProjectionPendingError(ids, error);
}

export function insertedSourceIds(data: unknown, expectedCount: number): string[] {
  const ids = Array.isArray(data)
    ? data.map((row) => row && typeof row === "object" ? (row as Record<string, unknown>).id : null)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length !== expectedCount) {
    throw new Error(`Historical insert did not return all source UUIDs: expected=${expectedCount} returned=${ids.length}`);
  }
  return ids;
}

/** Test doubles used by older producer tests do not emulate `.select()`. Real
 * Supabase writer calls always request IDs; production rejects a missing reply. */
export async function projectInsertedRows(data: unknown, expectedCount: number): Promise<void> {
  if (data === undefined) return;
  await refreshCurrentSignalPairServing(insertedSourceIds(data, expectedCount));
}

export type CurrentServingPruneResult = {
  attempted: boolean;
  deletedRows: number;
  batches: number;
  durationMs: number;
};

function uniqueSourceIds(sourceGeneratedSignalPairIds: readonly string[]): string[] {
  return [...new Set(sourceGeneratedSignalPairIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * Removes only physically stale serving rows. The normal producer path passes
 * no IDs and prunes one expiry-indexed batch. The resolver path passes only
 * source IDs it just changed to a terminal result, so the SQL function makes
 * exact primary-key checks and never reconstructs from historical GSP rows.
 */
export async function pruneCurrentSignalPairServing(
  resolvedSourceGeneratedSignalPairIds: readonly string[] = [],
): Promise<CurrentServingPruneResult> {
  const startedAt = Date.now();
  const sourceIds = uniqueSourceIds(resolvedSourceGeneratedSignalPairIds);
  const batches = sourceIds.length === 0
    ? [null]
    : Array.from({ length: Math.ceil(sourceIds.length / CURRENT_SERVING_PRUNE_BATCH_SIZE) }, (_, index) =>
      sourceIds.slice(index * CURRENT_SERVING_PRUNE_BATCH_SIZE, (index + 1) * CURRENT_SERVING_PRUNE_BATCH_SIZE),
    );
  let deletedRows = 0;

  for (const resolvedIds of batches) {
    const { data, error } = await supabaseAdmin.rpc("prune_current_signal_pair_serving", {
      p_batch_size: CURRENT_SERVING_PRUNE_BATCH_SIZE,
      p_resolved_source_generated_signal_pair_ids: resolvedIds,
    });
    if (error) throw new Error(`CURRENT_SERVING_PRUNE_FAILED: ${error.message}`);
    const deleted = Number(data ?? 0);
    if (!Number.isInteger(deleted) || deleted < 0 || deleted > CURRENT_SERVING_PRUNE_BATCH_SIZE) {
      throw new Error("CURRENT_SERVING_PRUNE_INVALID_RESULT");
    }
    deletedRows += deleted;
  }

  return {
    attempted: true,
    deletedRows,
    batches: batches.length,
    durationMs: Date.now() - startedAt,
  };
}
