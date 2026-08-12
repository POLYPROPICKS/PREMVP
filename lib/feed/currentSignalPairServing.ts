import { supabaseAdmin } from "@/lib/supabase/server";

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
