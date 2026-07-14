// Deterministic post-cutoff observation ledger (Phase 3E.8E.2B).
//
// Composes the 3E.8E.2A boundary into a stable, hashable ledger: exclusive
// cutoff filter -> canonical observation key -> exact-duplicate collapse
// (throwing on same-key content divergence) -> UTC Monday-week cohorts ->
// deterministically sorted output + SHA-256 content hash. Pure: no model
// membership, ROI/PnL/drawdown, fs, network, env, Supabase, current time, or
// randomness. Never stores raw rows.

import { createHash } from "node:crypto";
import type { ExportRow } from "./generatedSignalPairsExportContract";
import {
  POST_CUTOFF_RESOLVED_AT_EXCLUSIVE,
  filterPostCutoffResolvedRows,
  buildObservationKey,
  parseObservationTimestamp,
  getUtcWeekBucket,
} from "./postCutoffObservation";

export interface PostCutoffLedgerObservation {
  observationKey: string;
  conditionId: string;
  tokenId: string;
  resolvedAt: string;
  weekBucket: string;
}

export interface PostCutoffLedgerWeek {
  weekBucket: string;
  observationCount: number;
  observationKeys: string[];
}

export interface PostCutoffObservationLedger {
  schemaVersion: 1;
  cutoffResolvedAtExclusive: string;
  inputRowCount: number;
  eligibleRowCount: number;
  uniqueObservationCount: number;
  exactDuplicateCount: number;
  weeks: PostCutoffLedgerWeek[];
  observations: PostCutoffLedgerObservation[];
  ledgerHash: string;
}

/** Thrown when two rows share an observation key but differ in canonical content. */
export class ObservationConflictError extends Error {
  readonly observationKey: string;
  readonly conflictingFields: string[];
  constructor(observationKey: string, conflictingFields: string[]) {
    super(
      `post-cutoff observation ledger: conflicting observations for key "${observationKey}" differ in field(s): ${conflictingFields.join(", ")}`,
    );
    this.name = "ObservationConflictError";
    this.observationKey = observationKey;
    this.conflictingFields = conflictingFields;
  }
}

const CONDITION_ID_FIELDS = ["condition_id", "conditionId"] as const;
const TOKEN_ID_FIELDS = ["token_id", "tokenId"] as const;

function readIdentity(row: ExportRow, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const trimmed = String(value).trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

const CANONICAL_FIELDS: Array<keyof PostCutoffLedgerObservation> = [
  "observationKey",
  "conditionId",
  "tokenId",
  "resolvedAt",
  "weekBucket",
];

/**
 * Returns the names of canonical fields that differ between two observations.
 * The public seam used by the ledger's duplicate merge: identical content ->
 * `[]` (an exact duplicate, safe to collapse); any divergence -> the differing
 * field names. With `throwOnConflict`, a non-empty divergence raises an
 * ObservationConflictError carrying only the key and field names -- never a
 * raw row. Note: with the current buildObservationKey normalization the key
 * fully determines every canonical field, so this guard is not reachable via
 * row inputs alone; it exists as a defensive invariant and is exercised here
 * directly.
 */
export function detectObservationConflictFields(
  a: PostCutoffLedgerObservation,
  b: PostCutoffLedgerObservation,
  options: { throwOnConflict?: boolean } = {},
): string[] {
  const differing = CANONICAL_FIELDS.filter((f) => a[f] !== b[f]).map((f) => String(f));
  if (differing.length > 0 && options.throwOnConflict) {
    throw new ObservationConflictError(a.observationKey, differing);
  }
  return differing;
}

function toObservation(row: ExportRow): PostCutoffLedgerObservation | null {
  const observationKey = buildObservationKey(row);
  if (observationKey === null) return null;
  const conditionRaw = readIdentity(row, CONDITION_ID_FIELDS);
  const tokenId = readIdentity(row, TOKEN_ID_FIELDS);
  const resolved = parseObservationTimestamp(row["resolved_at"]);
  const weekBucket = getUtcWeekBucket(row["resolved_at"]);
  if (conditionRaw === null || tokenId === null || resolved === null || weekBucket === null) return null;
  return {
    observationKey,
    conditionId: conditionRaw.toLowerCase(),
    tokenId,
    resolvedAt: resolved.toISOString(),
    weekBucket,
  };
}

function canonicalPayload(ledger: Omit<PostCutoffObservationLedger, "ledgerHash">): string {
  // Explicit, fixed key order so the serialized payload is deterministic and
  // independent of input ordering. Excludes ledgerHash and any runtime value.
  return JSON.stringify({
    schemaVersion: ledger.schemaVersion,
    cutoffResolvedAtExclusive: ledger.cutoffResolvedAtExclusive,
    inputRowCount: ledger.inputRowCount,
    eligibleRowCount: ledger.eligibleRowCount,
    uniqueObservationCount: ledger.uniqueObservationCount,
    exactDuplicateCount: ledger.exactDuplicateCount,
    weeks: ledger.weeks.map((w) => ({
      weekBucket: w.weekBucket,
      observationCount: w.observationCount,
      observationKeys: w.observationKeys,
    })),
    observations: ledger.observations.map((o) => ({
      observationKey: o.observationKey,
      conditionId: o.conditionId,
      tokenId: o.tokenId,
      resolvedAt: o.resolvedAt,
      weekBucket: o.weekBucket,
    })),
  });
}

/**
 * Builds a deterministic post-cutoff observation ledger from candidate export
 * rows. Filters by the exclusive cutoff, canonicalizes each eligible row into
 * an observation, collapses exact duplicates (throwing ObservationConflictError
 * on any same-key content divergence), groups by UTC Monday week, and emits a
 * stably sorted, content-hashed ledger. Input rows are never mutated; a
 * malformed cutoff throws.
 */
export function buildPostCutoffObservationLedger(
  rows: readonly ExportRow[],
  cutoff: string = POST_CUTOFF_RESOLVED_AT_EXCLUSIVE,
): PostCutoffObservationLedger {
  const inputRowCount = rows.length;
  // filterPostCutoffResolvedRows validates the cutoff (throws if invalid) and
  // never mutates its input.
  const postCutoffRows = filterPostCutoffResolvedRows(rows, cutoff);

  const byKey = new Map<string, PostCutoffLedgerObservation>();
  let eligibleRowCount = 0;
  let exactDuplicateCount = 0;

  for (const row of postCutoffRows) {
    const observation = toObservation(row);
    if (observation === null) continue; // post-cutoff but no canonical identity -> not observable
    eligibleRowCount += 1;
    const existing = byKey.get(observation.observationKey);
    if (existing === undefined) {
      byKey.set(observation.observationKey, observation);
      continue;
    }
    // Same key: exact duplicate (collapse) or a canonical conflict (throw).
    detectObservationConflictFields(existing, observation, { throwOnConflict: true });
    exactDuplicateCount += 1;
  }

  const observations = [...byKey.values()].sort(
    (a, b) => (a.resolvedAt < b.resolvedAt ? -1 : a.resolvedAt > b.resolvedAt ? 1 : a.observationKey < b.observationKey ? -1 : a.observationKey > b.observationKey ? 1 : 0),
  );

  const weekMap = new Map<string, string[]>();
  for (const o of observations) {
    const bucket = weekMap.get(o.weekBucket) ?? [];
    bucket.push(o.observationKey);
    weekMap.set(o.weekBucket, bucket);
  }
  const weeks: PostCutoffLedgerWeek[] = [...weekMap.entries()]
    .map(([weekBucket, keys]) => ({
      weekBucket,
      observationCount: keys.length,
      observationKeys: [...keys].sort(),
    }))
    .sort((a, b) => (a.weekBucket < b.weekBucket ? -1 : a.weekBucket > b.weekBucket ? 1 : 0));

  const withoutHash: Omit<PostCutoffObservationLedger, "ledgerHash"> = {
    schemaVersion: 1,
    cutoffResolvedAtExclusive: cutoff,
    inputRowCount,
    eligibleRowCount,
    uniqueObservationCount: byKey.size,
    exactDuplicateCount,
    weeks,
    observations,
  };

  const ledgerHash = createHash("sha256").update(canonicalPayload(withoutHash)).digest("hex");
  return { ...withoutHash, ledgerHash };
}
