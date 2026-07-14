// Canonical forward evaluation dataset (Phase 3E.8E.2C-B).
//
// Composes the 3E.8E.2A/2B boundary into a dataset layer carrying every field
// PRIMARY/ALT2/ALT1 and the ROI/event-group contracts actually read: cutoff
// filter -> canonical historical strict-dedup projection
// (strict_latest_created_before_resolved, reused verbatim from
// generatedSignalPairsDedupPolicy -- physical generated-signal rows are NOT
// automatically independent resolved observations; the live table stores many
// physical rows per resolved market) -> full evaluation projection ->
// exact-duplicate collapse (throwing on any same-key divergence that survives
// strict dedup, e.g. case-divergent condition ids) -> deterministic
// sort + SHA-256 content hash -> a lossless adapter back to the exact row
// shape the frozen evaluators expect. Does NOT run model evaluation, compute
// forward metrics, or select a model. Pure: no fs/network/env/Supabase,
// current time, or randomness. Never stores a raw row.
//
// Adapter-parity design decisions (both forced to Option A -- no existing
// evaluator input accepts a pre-derived value):
//   - Timing: the frozen evaluator's getHoursUntilStartValue always
//     recomputes hours-until-start from diagnostics.gameStartIso and
//     created_at itself; there is no supported "pass in the derived hours"
//     field. So the projection stores createdAt + gameStartIso (not just the
//     derived hoursUntilStart) and the conflict comparison covers both.
//   - Event grouping: evaluateHistoricalFunnelVariant's GROUP/KEEP steps call
//     groupRowsByEventGroup on the row objects directly -- there is no
//     supported "pass in a precomputed eventGroupKey" input. So the
//     projection stores the minimal original event-identity source fields
//     (matchFamilyKey, canonicalEventKey, parentEventKey, eventSlug,
//     eventTitle, marketSlug) needed to reproduce buildEventGroupKey exactly,
//     in addition to the computed eventGroupKey used for fast conflict
//     comparison.

import { createHash } from "node:crypto";
import type { ExportRow } from "./generatedSignalPairsExportContract";
import {
  POST_CUTOFF_RESOLVED_AT_EXCLUSIVE,
  filterPostCutoffResolvedRows,
  buildObservationKey,
  parseObservationTimestamp,
  getUtcWeekBucket,
} from "./postCutoffObservation";
import { buildEventGroupKey } from "./eventGroupSelection";
import {
  projectGeneratedSignalPairsStrictDedup,
  STRICT_DEDUP_POLICY_NAME,
} from "./generatedSignalPairsDedupPolicy";

export interface ForwardEventIdentity {
  matchFamilyKey: string | null;
  canonicalEventKey: string | null;
  parentEventKey: string | null;
  eventSlug: string | null;
  eventTitle: string | null;
  marketSlug: string | null;
}

export interface ForwardEvaluationObservation {
  observationKey: string;
  conditionId: string;
  tokenId: string;
  resolvedAt: string;
  weekBucket: string;

  score: number | null;
  coverage: number | null;
  entryPriceNum: number | null;
  smartMoneyScoreNum: number | null;
  hoursUntilStart: number | null;
  createdAt: string | null;
  gameStartIso: string | null;
  metricFormulaVersion: string | null;
  leagueSportText: string;
  signalResultLabel: string | null;
  realizedReturnPct: number | null;
  eventGroupKey: string | null;
  eventIdentity: ForwardEventIdentity;
  sourceId: string | null;
}

export interface PostCutoffEvaluationDataset {
  schemaVersion: 1;
  cutoffResolvedAtExclusive: string;
  inputRowCount: number;
  /** Post-cutoff rows before strict dedup (raw physical rows in the window). */
  postCutoffRowCount: number;
  /** The canonical historical dedup policy applied before projection. */
  strictDedupPolicy: typeof STRICT_DEDUP_POLICY_NAME;
  /** Physical rows dropped by the strict-dedup projection (not observations). */
  strictDedupDroppedRowCount: number;
  eligibleRowCount: number;
  uniqueObservationCount: number;
  exactDuplicateCount: number;
  observations: ForwardEvaluationObservation[];
  datasetHash: string;
}

/** Thrown when two rows share an observation key but diverge in a projected evaluation field. */
export class EvaluationConflictError extends Error {
  readonly observationKey: string;
  readonly conflictingFields: string[];
  constructor(observationKey: string, conflictingFields: string[]) {
    const sorted = [...conflictingFields].sort();
    super(
      `post-cutoff evaluation dataset: conflicting observations for key "${observationKey}" differ in field(s): ${sorted.join(", ")}`,
    );
    this.name = "EvaluationConflictError";
    this.observationKey = observationKey;
    this.conflictingFields = sorted;
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimmedStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function diagnosticsOf(row: ExportRow): Record<string, unknown> | null {
  const diagnostics = row["diagnostics"];
  return diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
    ? (diagnostics as Record<string, unknown>)
    : null;
}

/**
 * Score, exact frozen-evaluator priority: signal_confidence_num -> score ->
 * signal_score -> pre_event_score_num. First finite value wins; non-finite
 * values (including numeric strings) are skipped, never coerced.
 */
function getScoreValue(row: ExportRow): number | null {
  return (
    finiteNumber(row["signal_confidence_num"]) ??
    finiteNumber(row["score"]) ??
    finiteNumber(row["signal_score"]) ??
    finiteNumber(row["pre_event_score_num"])
  );
}

/** Coverage: diagnostics.dataCoverage only, finite or null. No range validation here. */
function getCoverageValue(row: ExportRow): number | null {
  const diagnostics = diagnosticsOf(row);
  return diagnostics ? finiteNumber(diagnostics["dataCoverage"]) : null;
}

/** Result label alias priority: signal_result -> result -> outcome_status, trimmed lowercase. */
function getResultLabel(row: ExportRow): string | null {
  for (const key of ["signal_result", "result", "outcome_status"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  }
  return null;
}

/** League/sport evidence text: exact frozen-evaluator source (market_slug + event_slug), lowercased. */
function getLeagueSportText(row: ExportRow): string {
  const marketSlug = typeof row["market_slug"] === "string" ? (row["market_slug"] as string) : "";
  const eventSlug = typeof row["event_slug"] === "string" ? (row["event_slug"] as string) : "";
  return `${marketSlug} ${eventSlug}`.toLowerCase();
}

/** Hours-until-start, derived exactly as the frozen evaluator does: (gameStartIso - created_at) / 3_600_000. */
function getHoursUntilStart(row: ExportRow, createdAt: string | null, gameStartIso: string | null): number | null {
  if (createdAt === null || gameStartIso === null) return null;
  const startMs = Date.parse(gameStartIso);
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(startMs) || Number.isNaN(createdMs)) return null;
  return (startMs - createdMs) / 3_600_000;
}

function getEventIdentity(row: ExportRow): ForwardEventIdentity {
  return {
    matchFamilyKey: trimmedStringOrNull(row["match_family_key"]),
    canonicalEventKey: trimmedStringOrNull(row["canonical_event_key"]),
    parentEventKey: trimmedStringOrNull(row["parent_event_key"]),
    eventSlug: trimmedStringOrNull(row["event_slug"]),
    eventTitle: trimmedStringOrNull(row["event_title"]),
    marketSlug: trimmedStringOrNull(row["market_slug"]),
  };
}

/**
 * Projects a single row into the canonical forward evaluation observation, or
 * null when it lacks a valid observation identity (missing/malformed
 * condition_id, token_id, or resolved_at). Never mutates `row`, never stores
 * the raw row or full diagnostics -- only the individually extracted fields
 * the frozen evaluators/ROI/event-group contracts actually read.
 */
export function projectForwardEvaluationObservation(row: ExportRow): ForwardEvaluationObservation | null {
  const observationKey = buildObservationKey(row);
  if (observationKey === null) return null;

  const conditionRaw = readIdentity(row, CONDITION_ID_FIELDS);
  const tokenId = readIdentity(row, TOKEN_ID_FIELDS);
  const resolved = parseObservationTimestamp(row["resolved_at"]);
  const weekBucket = getUtcWeekBucket(row["resolved_at"]);
  if (conditionRaw === null || tokenId === null || resolved === null || weekBucket === null) return null;

  const diagnostics = diagnosticsOf(row);
  const createdAt = trimmedStringOrNull(row["created_at"]);
  const gameStartIso = diagnostics ? trimmedStringOrNull(diagnostics["gameStartIso"]) : null;

  return {
    observationKey,
    conditionId: conditionRaw.toLowerCase(),
    tokenId,
    resolvedAt: resolved.toISOString(),
    weekBucket,
    score: getScoreValue(row),
    coverage: getCoverageValue(row),
    entryPriceNum: finiteNumber(row["entry_price_num"]),
    smartMoneyScoreNum: finiteNumber(row["smart_money_score_num"]),
    hoursUntilStart: getHoursUntilStart(row, createdAt, gameStartIso),
    createdAt,
    gameStartIso,
    metricFormulaVersion: trimmedStringOrNull(row["metric_formula_version"]),
    leagueSportText: getLeagueSportText(row),
    signalResultLabel: getResultLabel(row),
    realizedReturnPct: finiteNumber(row["realized_return_pct"]),
    eventGroupKey: buildEventGroupKey(row).key || null,
    eventIdentity: getEventIdentity(row),
    sourceId: trimmedStringOrNull(row["id"]),
  };
}

const CONFLICT_FIELDS: Array<keyof ForwardEvaluationObservation> = [
  "score",
  "coverage",
  "entryPriceNum",
  "smartMoneyScoreNum",
  "hoursUntilStart",
  "createdAt",
  "gameStartIso",
  "metricFormulaVersion",
  "leagueSportText",
  "signalResultLabel",
  "realizedReturnPct",
  "eventGroupKey",
  "sourceId",
];

function eventIdentityEqual(a: ForwardEventIdentity, b: ForwardEventIdentity): boolean {
  return (
    a.matchFamilyKey === b.matchFamilyKey &&
    a.canonicalEventKey === b.canonicalEventKey &&
    a.parentEventKey === b.parentEventKey &&
    a.eventSlug === b.eventSlug &&
    a.eventTitle === b.eventTitle &&
    a.marketSlug === b.marketSlug
  );
}

/**
 * Returns the names of fields that differ between two same-key observations
 * (sorted). Empty array means an exact duplicate, safe to collapse.
 */
function detectEvaluationConflictFields(a: ForwardEvaluationObservation, b: ForwardEvaluationObservation): string[] {
  const differing = CONFLICT_FIELDS.filter((f) => a[f] !== b[f]).map(String);
  if (!eventIdentityEqual(a.eventIdentity, b.eventIdentity)) differing.push("eventIdentity");
  return differing.sort();
}

function canonicalObservationPayload(o: ForwardEvaluationObservation) {
  return {
    observationKey: o.observationKey,
    conditionId: o.conditionId,
    tokenId: o.tokenId,
    resolvedAt: o.resolvedAt,
    weekBucket: o.weekBucket,
    score: o.score,
    coverage: o.coverage,
    entryPriceNum: o.entryPriceNum,
    smartMoneyScoreNum: o.smartMoneyScoreNum,
    hoursUntilStart: o.hoursUntilStart,
    createdAt: o.createdAt,
    gameStartIso: o.gameStartIso,
    metricFormulaVersion: o.metricFormulaVersion,
    leagueSportText: o.leagueSportText,
    signalResultLabel: o.signalResultLabel,
    realizedReturnPct: o.realizedReturnPct,
    eventGroupKey: o.eventGroupKey,
    eventIdentity: {
      matchFamilyKey: o.eventIdentity.matchFamilyKey,
      canonicalEventKey: o.eventIdentity.canonicalEventKey,
      parentEventKey: o.eventIdentity.parentEventKey,
      eventSlug: o.eventIdentity.eventSlug,
      eventTitle: o.eventIdentity.eventTitle,
      marketSlug: o.eventIdentity.marketSlug,
    },
    sourceId: o.sourceId,
  };
}

function canonicalPayload(dataset: Omit<PostCutoffEvaluationDataset, "datasetHash">): string {
  return JSON.stringify({
    schemaVersion: dataset.schemaVersion,
    cutoffResolvedAtExclusive: dataset.cutoffResolvedAtExclusive,
    inputRowCount: dataset.inputRowCount,
    postCutoffRowCount: dataset.postCutoffRowCount,
    strictDedupPolicy: dataset.strictDedupPolicy,
    strictDedupDroppedRowCount: dataset.strictDedupDroppedRowCount,
    eligibleRowCount: dataset.eligibleRowCount,
    uniqueObservationCount: dataset.uniqueObservationCount,
    exactDuplicateCount: dataset.exactDuplicateCount,
    observations: dataset.observations.map(canonicalObservationPayload),
  });
}

/**
 * Builds the deterministic post-cutoff evaluation dataset from candidate
 * export rows. Filters by the exclusive cutoff, applies the canonical
 * historical strict-dedup projection (one row per condition_id + token_id,
 * preferring the latest created_at <= resolved_at -- physical
 * generated-signal rows are not automatically independent resolved
 * observations), projects each surviving row, collapses exact duplicates
 * (throwing EvaluationConflictError on any same-key divergence that remains
 * after strict dedup), sorts deterministically, and emits a content-hashed
 * dataset. Input rows are never mutated; a malformed cutoff throws.
 */
export function buildPostCutoffEvaluationDataset(
  rows: readonly ExportRow[],
  cutoff: string = POST_CUTOFF_RESOLVED_AT_EXCLUSIVE,
): PostCutoffEvaluationDataset {
  const inputRowCount = rows.length;
  const postCutoffRows = filterPostCutoffResolvedRows(rows, cutoff);
  const strictDedup = projectGeneratedSignalPairsStrictDedup(postCutoffRows);

  const byKey = new Map<string, ForwardEvaluationObservation>();
  let eligibleRowCount = 0;
  let exactDuplicateCount = 0;

  for (const row of strictDedup.dedupedRows) {
    const observation = projectForwardEvaluationObservation(row);
    if (observation === null) continue;
    eligibleRowCount += 1;
    const existing = byKey.get(observation.observationKey);
    if (existing === undefined) {
      byKey.set(observation.observationKey, observation);
      continue;
    }
    const conflicts = detectEvaluationConflictFields(existing, observation);
    if (conflicts.length > 0) {
      throw new EvaluationConflictError(observation.observationKey, conflicts);
    }
    exactDuplicateCount += 1;
  }

  const observations = [...byKey.values()].sort((a, b) =>
    a.resolvedAt < b.resolvedAt ? -1 : a.resolvedAt > b.resolvedAt ? 1 : a.observationKey < b.observationKey ? -1 : a.observationKey > b.observationKey ? 1 : 0,
  );

  const withoutHash: Omit<PostCutoffEvaluationDataset, "datasetHash"> = {
    schemaVersion: 1,
    cutoffResolvedAtExclusive: cutoff,
    inputRowCount,
    postCutoffRowCount: strictDedup.rawRows,
    strictDedupPolicy: STRICT_DEDUP_POLICY_NAME,
    strictDedupDroppedRowCount: strictDedup.droppedDuplicateRows,
    eligibleRowCount,
    uniqueObservationCount: byKey.size,
    exactDuplicateCount,
    observations,
  };

  const datasetHash = createHash("sha256").update(canonicalPayload(withoutHash)).digest("hex");
  return { ...withoutHash, datasetHash };
}

/**
 * Reshapes a canonical projection back into the exact original field names
 * the frozen evaluators (PRIMARY/ALT2/ALT1), roiPnlContract, and
 * eventGroupSelection already read -- a lossless adapter, not a
 * reimplementation. Never modifies any evaluator; this is the only function
 * that re-expands the flat projection into a Row-shaped object.
 */
export function toFrozenEvaluatorRow(observation: ForwardEvaluationObservation): ExportRow {
  const row: Record<string, unknown> = {
    id: observation.sourceId ?? undefined,
    condition_id: observation.conditionId,
    token_id: observation.tokenId,
    resolved_at: observation.resolvedAt,
    created_at: observation.createdAt ?? undefined,
    signal_confidence_num: observation.score ?? undefined,
    entry_price_num: observation.entryPriceNum ?? undefined,
    smart_money_score_num: observation.smartMoneyScoreNum ?? undefined,
    metric_formula_version: observation.metricFormulaVersion ?? undefined,
    signal_result: observation.signalResultLabel ?? undefined,
    realized_return_pct: observation.realizedReturnPct ?? undefined,
    market_slug: observation.eventIdentity.marketSlug ?? undefined,
    event_slug: observation.eventIdentity.eventSlug ?? undefined,
    event_title: observation.eventIdentity.eventTitle ?? undefined,
    match_family_key: observation.eventIdentity.matchFamilyKey ?? undefined,
    canonical_event_key: observation.eventIdentity.canonicalEventKey ?? undefined,
    parent_event_key: observation.eventIdentity.parentEventKey ?? undefined,
    diagnostics: {
      dataCoverage: observation.coverage ?? undefined,
      gameStartIso: observation.gameStartIso ?? undefined,
    },
  };
  for (const key of Object.keys(row)) {
    if (row[key] === undefined) delete row[key];
  }
  return row;
}
