// Post-cutoff observation boundary (Phase 3E.8E.2A).
//
// A pure, deterministic module for the frozen post-cutoff observation window:
// exclusive eligibility by `resolved_at`, a stable idempotent observation
// identity, and UTC Monday-start weekly buckets. It does NOT decide model
// membership, ROI/PnL, drawdown, dedup, persistence, or graphs -- those belong
// to later orchestration boundaries. No fs, network, env, Supabase, locale
// date formatting, or module-level current-time calls.

import type { ExportRow } from "./generatedSignalPairsExportContract";

/**
 * Founder-locked exclusive cutoff. A row is eligible only when its
 * `resolved_at` is STRICTLY greater than this instant (equal or earlier is
 * excluded). UTC.
 */
export const POST_CUTOFF_RESOLVED_AT_EXCLUSIVE = "2026-07-13T06:04:05.701Z";

const CONDITION_ID_FIELDS = ["condition_id", "conditionId"] as const;
const TOKEN_ID_FIELDS = ["token_id", "tokenId"] as const;

/**
 * Parses a timestamp value into a Date, or null when it is not a non-empty
 * string that resolves to a finite instant. Only strings are accepted; numbers
 * and other types are rejected so eligibility can never hinge on an ambiguous
 * epoch guess. Timezone offsets are honored by Date parsing and thereby
 * normalized to a single UTC instant.
 */
export function parseObservationTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Resolves the configured cutoff into a Date, throwing a deterministic error
 * for an explicitly invalid cutoff (a configuration bug, never row data).
 */
function resolveCutoff(cutoff: string): Date {
  const parsed = parseObservationTimestamp(cutoff);
  if (parsed === null) {
    throw new Error(`post-cutoff observation: invalid cutoff timestamp (expected an ISO instant): ${cutoff}`);
  }
  return parsed;
}

function getTrimmedIdentity(row: ExportRow, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const trimmed = String(value).trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/**
 * True when `row.resolved_at` is a valid instant STRICTLY after `cutoff`.
 * Only `resolved_at` decides eligibility -- never created_at/expires_at/
 * updated_at. Missing or malformed `resolved_at` -> false. A malformed
 * `cutoff` throws.
 */
export function isPostCutoffResolvedRow(
  row: ExportRow,
  cutoff: string = POST_CUTOFF_RESOLVED_AT_EXCLUSIVE,
): boolean {
  const cutoffDate = resolveCutoff(cutoff);
  const resolved = parseObservationTimestamp(row["resolved_at"]);
  if (resolved === null) return false;
  return resolved.getTime() > cutoffDate.getTime();
}

/**
 * Returns the subset of `rows` whose `resolved_at` is strictly after `cutoff`,
 * preserving input order and never mutating the input array or its rows.
 * Duplicates are NOT removed here -- dedup belongs to a later boundary. A
 * malformed `cutoff` throws once, before any row is examined.
 */
export function filterPostCutoffResolvedRows(
  rows: readonly ExportRow[],
  cutoff: string = POST_CUTOFF_RESOLVED_AT_EXCLUSIVE,
): ExportRow[] {
  const cutoffDate = resolveCutoff(cutoff);
  const out: ExportRow[] = [];
  for (const row of rows) {
    const resolved = parseObservationTimestamp(row["resolved_at"]);
    if (resolved !== null && resolved.getTime() > cutoffDate.getTime()) out.push(row);
  }
  return out;
}

/**
 * Builds a stable, idempotent observation key from a row's canonical identity:
 * `<condition-id-lowercased>::<token-id-trimmed>::<resolved-at-iso-utc>`.
 * condition_id is lowercased (hex hashes are case-insensitive); token_id keeps
 * its trimmed string form; resolved_at is normalized to a canonical UTC ISO
 * string so offset-equivalent timestamps collapse to one key. Returns null if
 * any canonical component is missing or malformed. Never uses title, slug, or
 * created_at, and never hashes at this layer.
 */
export function buildObservationKey(row: ExportRow): string | null {
  const condition = getTrimmedIdentity(row, CONDITION_ID_FIELDS);
  if (condition === null) return null;
  const token = getTrimmedIdentity(row, TOKEN_ID_FIELDS);
  if (token === null) return null;
  const resolved = parseObservationTimestamp(row["resolved_at"]);
  if (resolved === null) return null;
  return `${condition.toLowerCase()}::${token}::${resolved.toISOString()}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Maps a timestamp to its ISO-style UTC week bucket: the UTC Monday date of
 * the week containing that instant, formatted `YYYY-MM-DD`. All math is in
 * UTC, so the result is independent of the machine's local timezone. Returns
 * null for a malformed timestamp.
 */
export function getUtcWeekBucket(resolvedAt: unknown): string | null {
  const parsed = parseObservationTimestamp(resolvedAt);
  if (parsed === null) return null;
  // getUTCDay(): 0=Sunday..6=Saturday. Days elapsed since the week's Monday is
  // (day + 6) % 7 (Mon->0, Tue->1, ... Sun->6). Subtract that in UTC epoch ms.
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  const monday = new Date(parsed.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}
