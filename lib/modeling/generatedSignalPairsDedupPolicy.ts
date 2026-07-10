// Pure, side-effect-free strict duplicate-projection policy for local
// generated_signal_pairs exports (Phase 3D.2N).
//
// This module does NOT deduplicate the caller's input array -- it produces
// a new, explicit projection (`dedupedRows`) selecting one row per strict
// dedup key, leaving the original `rows` array completely untouched. It is
// opt-in only: nothing in the CLI or the export contract calls this module
// automatically. It does NOT compute ROI/PnL, does not read the database,
// the filesystem, or process.env, and never logs a row payload.
//
// The strict dedup key (condition_id + token_id) is reused verbatim from
// lib/modeling/generatedSignalPairsExportContract.ts's
// getStrictDedupKeyForExportRow() -- this module does not reimplement key
// parsing.

import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";

export const STRICT_DEDUP_POLICY_NAME = "strict_latest_created_before_resolved" as const;

export interface GeneratedSignalPairsDedupProjection<T extends ExportRow = ExportRow> {
  policyName: typeof STRICT_DEDUP_POLICY_NAME;
  rawRows: number;
  dedupRows: number;
  uniqueStrictDedupKeys: number;
  droppedDuplicateRows: number;
  rowsMissingStrictDedupKey: number;
  keysWithDuplicates: number;
  rowsCreatedAfterResolved: number;
  keysWithNoCreatedAtBeforeResolved: number;
  hasDuplicateStrictKeyRisk: boolean;
  dedupedRows: T[];
}

function getValidTimeMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function getIdString(row: ExportRow): string | null {
  const value = row.id;
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

interface Candidate<T extends ExportRow> {
  row: T;
  originalIndex: number;
  createdMs: number | null;
  resolvedMs: number | null;
  id: string | null;
}

/**
 * Compares two candidates for the same strict key and returns true if `b`
 * should be preferred over `a` under the strict_latest_created_before_resolved
 * policy:
 *   1. a valid created_at <= resolved_at beats one that is missing or after
 *      resolved_at;
 *   2. among candidates in the same tier, later created_at wins;
 *   3. on an exact created_at tie, the lexicographically larger id wins;
 *   4. with no ids (or a further tie), the earliest original position wins
 *      (deterministic, stable).
 */
function isPreferred<T extends ExportRow>(a: Candidate<T>, b: Candidate<T>): boolean {
  const aBeforeResolved =
    a.createdMs !== null && a.resolvedMs !== null && a.createdMs <= a.resolvedMs;
  const bBeforeResolved =
    b.createdMs !== null && b.resolvedMs !== null && b.createdMs <= b.resolvedMs;

  if (aBeforeResolved !== bBeforeResolved) {
    return bBeforeResolved;
  }

  const aCreated = a.createdMs ?? -Infinity;
  const bCreated = b.createdMs ?? -Infinity;
  if (aCreated !== bCreated) {
    return bCreated > aCreated;
  }

  if (a.id !== null && b.id !== null && a.id !== b.id) {
    return b.id > a.id;
  }

  return false;
}

/**
 * Projects `rows` down to one row per strict dedup key
 * (condition_id + token_id), preferring the latest created_at that is
 * still <= resolved_at; falling back to the latest created_at overall when
 * no candidate for a key satisfies that; falling back to deterministic
 * original order when created_at/id cannot break a tie. Rows missing the
 * strict key are excluded from `dedupedRows` and counted separately. The
 * input array and its row objects are never mutated; selected rows in
 * `dedupedRows` are the original object references.
 */
export function projectGeneratedSignalPairsStrictDedup<T extends ExportRow>(
  rows: readonly T[],
): GeneratedSignalPairsDedupProjection<T> {
  const groups = new Map<string, Candidate<T>[]>();
  let rowsMissingStrictDedupKey = 0;
  let rowsCreatedAfterResolved = 0;

  rows.forEach((row, originalIndex) => {
    const key = getStrictDedupKeyForExportRow(row);
    if (key === null) {
      rowsMissingStrictDedupKey += 1;
      return;
    }

    const createdMs = getValidTimeMs(row.created_at);
    const resolvedMs = getValidTimeMs(row.resolved_at);
    const candidate: Candidate<T> = { row, originalIndex, createdMs, resolvedMs, id: getIdString(row) };

    if (resolvedMs !== null && createdMs !== null && createdMs > resolvedMs) {
      rowsCreatedAfterResolved += 1;
    }

    const existing = groups.get(key);
    if (existing) {
      existing.push(candidate);
    } else {
      groups.set(key, [candidate]);
    }
  });

  const dedupedRows: T[] = [];
  let droppedDuplicateRows = 0;
  let keysWithDuplicates = 0;
  let keysWithNoCreatedAtBeforeResolved = 0;

  for (const candidates of groups.values()) {
    if (candidates.length > 1) {
      keysWithDuplicates += 1;
      droppedDuplicateRows += candidates.length - 1;
    }

    let winner = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (isPreferred(winner, candidates[i])) winner = candidates[i];
    }

    const winnerBeforeResolved =
      winner.createdMs !== null && winner.resolvedMs !== null && winner.createdMs <= winner.resolvedMs;
    if (!winnerBeforeResolved) {
      keysWithNoCreatedAtBeforeResolved += 1;
    }

    dedupedRows.push(winner.row);
  }

  return {
    policyName: STRICT_DEDUP_POLICY_NAME,
    rawRows: rows.length,
    dedupRows: dedupedRows.length,
    uniqueStrictDedupKeys: groups.size,
    droppedDuplicateRows,
    rowsMissingStrictDedupKey,
    keysWithDuplicates,
    rowsCreatedAfterResolved,
    keysWithNoCreatedAtBeforeResolved,
    hasDuplicateStrictKeyRisk: droppedDuplicateRows > 0,
    dedupedRows,
  };
}
