// Frozen Model Producer V2 Shadow (Integration Milestone 2A, Part B; parity
// repair v2). Pure, read-only, side-effect-free evaluator for the FROZEN
// B2_PRICE_FLOOR_030_TIMING_WITHIN_120M threshold contract. This module does
// NOT touch execution/order/reservation/queue/Ireland/CLOB systems -- it only
// classifies already-generated signal candidates (generated_signal_pairs
// export rows) into ACCEPTED decisions or REJECTED-with-reason.
//
// PARITY NOTE: the price-floor and timing predicates below are copied
// verbatim (same constants, same comparison operators) from the accepted
// canonical B2 implementation in lib/modeling/boundedRoutingExperiments.ts
// (commit ce122b0 "Modeling: add post-June canonical walkthrough" / 65256a8
// "Modeling: add canonical model handoff package" -- a divergent history
// line never merged into this branch's ancestry, so the file cannot be
// imported without dragging in its full PnL/bankroll/vault-replay dependency
// graph, which is inappropriate for a leakage-free forward shadow producer
// and would blow the approved file budget). The two functions are:
//
//   export const PRICE_FLOOR = 0.3 as const;
//   export const TIMING_UPPER_HOURS = 2 as const;
//   function passesPriceFloor(row): getEntryPriceValue(row) !== null && p >= PRICE_FLOOR
//   function passesTimingWithin120m(row): h !== null && h >= 0 && h < TIMING_UPPER_HOURS
//   function getEntryPriceValue(row): finiteNumber(row.entry_price_num); 0 < v <= 1 ? v : null
//   function getHoursUntilStartValue(row): (startMs(diagnostics.gameStartIso) - createdMs(row.created_at)) / 3_600_000
//
// Score (>=65) and eSports exclusion adapters (getScoreValue, isEsports) are
// imported verbatim from historicalFunnelVariants.ts -- reused directly, not
// re-implemented, since that module IS import-safe (no PnL/bankroll deps).
// Physical-event grouping reuses buildEventGroupKey from eventGroupSelection.ts
// (the same canonical grouping helper used elsewhere in the modeling stack)
// instead of a locally invented event-key heuristic.
//
// T-90 SNAPSHOT RESOLUTION (per strict observation identity): among all rows
// sharing an identity, the eligible set is those with
// created_at <= game_start - 90 minutes (an accepted-source rule -- see
// executionWaterfall.ts's t90 resolution: `createdMs(r) <= startMs(r) - 90*60_000`).
// The winner is the eligible row with the LATEST created_at (closest to the
// T-90 boundary from before it), tie-broken by observationId ascending. A
// snapshot created even 1ms after the T-90 boundary is excluded from
// eligibility entirely (it cannot displace an earlier valid snapshot, since
// it is never part of the eligible set to begin with).

import type { ExportRow } from "./generatedSignalPairsExportContract";
import { getStrictDedupKeyForExportRow } from "./generatedSignalPairsExportContract";
import { getScoreValue, isEsports } from "./historicalFunnelVariants";
import { buildEventGroupKey } from "./eventGroupSelection";
import { createHash } from "node:crypto";

export const FROZEN_MODEL_V2_VERSION = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M" as const;
export const FROZEN_MODEL_V2_SCHEMA_VERSION = "FROZEN_MODEL_V2_SHADOW_DECISION_V1" as const;

// ---- Frozen thresholds. DO NOT TUNE. Verbatim from accepted source. ----
const SCORE_THRESHOLD = 65;
const PRICE_FLOOR = 0.3;
const TIMING_UPPER_HOURS = 2; // 120 minutes
const T90_OFFSET_MS = 90 * 60_000;

const CONDITION_ID_FIELDS = ["condition_id", "conditionId"] as const;
const TOKEN_ID_FIELDS = ["token_id", "tokenId"] as const;
const SELECTED_OUTCOME_FIELDS = ["selected_outcome", "selectedOutcome"] as const;
// Leakage fields: never read for scoring/selection. Only referenced in the
// type below to document the check; the code never accesses row[leakageField].
const SUPPORTED_MARKET_TYPES = new Set(["BINARY", "binary"]);

export type FrozenModelV2RejectionReason =
  | "MISSING_EVENT_IDENTITY"
  | "MISSING_TOKEN_ID"
  | "MISSING_SELECTED_OUTCOME"
  | "UNSUPPORTED_MARKET"
  | "SNAPSHOT_NOT_T90_COMPATIBLE"
  | "FUTURE_DATA_REJECTED"
  | "SCORE_BELOW_65"
  | "PRICE_BELOW_030"
  | "OUTSIDE_120M"
  | "ESPORTS_EXCLUDED"
  | "DUPLICATE_EVENT_LOWER_RANK";

export interface FrozenModelV2Rejection {
  index: number;
  observationId: string | null;
  eventKey: string | null;
  reason: FrozenModelV2RejectionReason;
}

export interface FrozenModelV2Decision {
  decisionId: string;
  observationId: string;
  eventKey: string;
  asOfIso: string;
  modelVersion: string;
  score: number;
  entryPrice: number;
  minutesUntilStart: number;
  selectedOutcome: string;
  createdAtIso: string;
}

export interface FrozenModelV2ShadowResult {
  asOfIso: string;
  modelVersion: string;
  inputCount: number;
  eligibleCount: number;
  acceptedDecisions: FrozenModelV2Decision[];
  rejections: FrozenModelV2Rejection[];
}

export function normalizeAsOfIso(asOf: string): string {
  const ms = typeof asOf === "string" ? Date.parse(asOf) : NaN;
  if (typeof asOf !== "string" || asOf.trim() === "" || !Number.isFinite(ms)) {
    throw new Error("FROZEN_MODEL_V2_INVALID_AS_OF");
  }
  return new Date(ms).toISOString();
}

// ---- deterministic hashing (local, no import of canonicalModelHandoff.ts) ----
export function stable(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input !== null && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = sortKeys(record[key]);
          return acc;
        }, {});
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}

export function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function getStringField(row: ExportRow, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

// Verbatim port of scoreComponentAnalysis.ts's getEntryPriceValue.
function getEntryPriceValue(row: ExportRow): number | null {
  const raw = row.entry_price_num;
  const v = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  return v !== null && v > 0 && v <= 1 ? v : null;
}

// Verbatim port of boundedRoutingExperiments.ts's passesPriceFloor.
function passesPriceFloor(row: ExportRow): boolean {
  const p = getEntryPriceValue(row);
  return p !== null && p >= PRICE_FLOOR;
}

// Verbatim port of historicalFunnelVariants.ts's getHoursUntilStartValue,
// computed relative to the row's OWN created_at (the snapshot's own capture
// time), not an external as-of wall clock -- matching the accepted source.
function getHoursUntilStartValue(row: ExportRow): number | null {
  const gameStartIso = getGameStartIso(row);
  const createdAt = typeof row.created_at === "string" ? row.created_at : null;
  if (gameStartIso === null || createdAt === null) return null;
  const startMs = Date.parse(gameStartIso);
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(startMs) || Number.isNaN(createdMs)) return null;
  return (startMs - createdMs) / 3_600_000;
}

// Verbatim port of boundedRoutingExperiments.ts's passesTimingWithin120m:
// 0 <= hoursUntilStart < 2. Already-started (negative) and >=120min both fail
// closed.
function passesTimingWithin120m(row: ExportRow): boolean {
  const h = getHoursUntilStartValue(row);
  return h !== null && h >= 0 && h < TIMING_UPPER_HOURS;
}

function getGameStartIso(row: ExportRow): string | null {
  const diagnostics = row.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    const value = (diagnostics as Record<string, unknown>).gameStartIso;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

interface RowIdentity {
  conditionId: string;
  tokenId: string;
  selectedOutcome: string;
  observationId: string;
  eventKey: string;
}

function resolveIdentity(row: ExportRow): { identity: RowIdentity } | { reason: FrozenModelV2RejectionReason } {
  const conditionId = getStringField(row, CONDITION_ID_FIELDS);
  if (conditionId === null) return { reason: "MISSING_EVENT_IDENTITY" };
  const tokenId = getStringField(row, TOKEN_ID_FIELDS);
  if (tokenId === null) return { reason: "MISSING_TOKEN_ID" };
  const selectedOutcome = getStringField(row, SELECTED_OUTCOME_FIELDS);
  if (selectedOutcome === null) return { reason: "MISSING_SELECTED_OUTCOME" };
  const observationId = getStrictDedupKeyForExportRow(row);
  if (observationId === null) return { reason: "MISSING_EVENT_IDENTITY" };
  // Canonical physical-event grouping key (reused from eventGroupSelection.ts,
  // not a locally invented heuristic).
  const eventKey = buildEventGroupKey(row as Record<string, unknown>).key || conditionId;
  return { identity: { conditionId, tokenId, selectedOutcome, observationId, eventKey } };
}

function createdMs(row: ExportRow): number | null {
  const ms = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Per-identity canonical T-90 snapshot resolution: among rows sharing a
 * strict observation identity, the eligible set is created_at <=
 * game_start - 90min; the winner is the eligible row with the latest
 * created_at, tie-broken by observationId ascending. Rows created even 1ms
 * after the T-90 boundary are excluded from the eligible set (they cannot
 * displace an earlier valid snapshot).
 */
function resolveT90Snapshot(rows: readonly ExportRow[]): ExportRow | null {
  const withStart = rows
    .map((row) => ({ row, start: (() => { const iso = getGameStartIso(row); return iso !== null ? Date.parse(iso) : NaN; })(), created: createdMs(row) }))
    .filter((r): r is { row: ExportRow; start: number; created: number } => Number.isFinite(r.start) && r.created !== null);
  if (withStart.length === 0) return null;
  const eligible = withStart.filter((r) => r.created <= r.start - T90_OFFSET_MS);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    if (a.created !== b.created) return b.created - a.created;
    const aId = getStrictDedupKeyForExportRow(a.row) ?? "";
    const bId = getStrictDedupKeyForExportRow(b.row) ?? "";
    return aId.localeCompare(bId);
  });
  return eligible[0].row;
}

interface EvaluatedRow {
  index: number;
  row: ExportRow;
  identity: RowIdentity;
  score: number;
  entryPrice: number;
  minutesUntilStart: number;
  createdAtIso: string;
}

/**
 * Top-level pure entry point. Groups input rows by strict observation
 * identity, resolves the canonical T-90 snapshot per identity, then applies
 * the frozen threshold gates to that single resolved snapshot per identity,
 * then applies one-per-event dedup across identities sharing an event.
 *
 * Never reads winning_outcome/real_pnl_usd anywhere in this function.
 */
export function produceFrozenModelV2ShadowDecisions(
  rows: readonly ExportRow[],
  asOfIsoInput: string,
): FrozenModelV2ShadowResult {
  const asOfIso = normalizeAsOfIso(asOfIsoInput);
  const asOfMs = Date.parse(asOfIso);

  const rejections: FrozenModelV2Rejection[] = [];

  // Visible universe: rows must exist at or before the as-of replay boundary.
  const visible: Array<{ row: ExportRow; index: number }> = [];
  rows.forEach((row, index) => {
    const c = createdMs(row);
    if (c === null) {
      rejections.push({ index, observationId: null, eventKey: null, reason: "SNAPSHOT_NOT_T90_COMPATIBLE" });
      return;
    }
    if (c > asOfMs) {
      rejections.push({ index, observationId: null, eventKey: null, reason: "FUTURE_DATA_REJECTED" });
      return;
    }
    visible.push({ row, index });
  });

  // Group visible rows by strict observation identity.
  const byIdentity = new Map<string, Array<{ row: ExportRow; index: number }>>();
  const identityFailures = new Map<number, { reason: FrozenModelV2RejectionReason; eventKey: string | null; observationId: string | null }>();
  for (const entry of visible) {
    const identityResult = resolveIdentity(entry.row);
    if ("reason" in identityResult) {
      identityFailures.set(entry.index, { reason: identityResult.reason, eventKey: null, observationId: null });
      continue;
    }
    const key = identityResult.identity.observationId;
    const bucket = byIdentity.get(key);
    if (bucket) bucket.push(entry);
    else byIdentity.set(key, [entry]);
  }
  for (const [index, failure] of identityFailures) {
    rejections.push({ index, observationId: failure.observationId, eventKey: failure.eventKey, reason: failure.reason });
  }

  const eligible: EvaluatedRow[] = [];

  for (const bucket of byIdentity.values()) {
    const identityResult = resolveIdentity(bucket[0].row);
    if ("reason" in identityResult) continue; // already recorded above
    const { identity } = identityResult;

    const marketType = bucket[0].row.market_type ?? bucket[0].row.marketType;
    if (typeof marketType === "string" && marketType.trim() !== "" && !SUPPORTED_MARKET_TYPES.has(marketType.trim())) {
      rejections.push({ index: bucket[0].index, observationId: identity.observationId, eventKey: identity.eventKey, reason: "UNSUPPORTED_MARKET" });
      continue;
    }

    const t90Snapshot = resolveT90Snapshot(bucket.map((b) => b.row));
    if (t90Snapshot === null) {
      rejections.push({ index: bucket[0].index, observationId: identity.observationId, eventKey: identity.eventKey, reason: "SNAPSHOT_NOT_T90_COMPATIBLE" });
      continue;
    }

    if (isEsports(t90Snapshot)) {
      rejections.push({ index: bucket[0].index, observationId: identity.observationId, eventKey: identity.eventKey, reason: "ESPORTS_EXCLUDED" });
      continue;
    }

    const score = getScoreValue(t90Snapshot);
    if (score === null || score < SCORE_THRESHOLD) {
      rejections.push({ index: bucket[0].index, observationId: identity.observationId, eventKey: identity.eventKey, reason: "SCORE_BELOW_65" });
      continue;
    }

    if (!passesPriceFloor(t90Snapshot)) {
      rejections.push({ index: bucket[0].index, observationId: identity.observationId, eventKey: identity.eventKey, reason: "PRICE_BELOW_030" });
      continue;
    }

    if (!passesTimingWithin120m(t90Snapshot)) {
      rejections.push({ index: bucket[0].index, observationId: identity.observationId, eventKey: identity.eventKey, reason: "OUTSIDE_120M" });
      continue;
    }

    const entryPrice = getEntryPriceValue(t90Snapshot)!;
    const minutesUntilStart = getHoursUntilStartValue(t90Snapshot)! * 60;
    const createdAtIso = new Date(createdMs(t90Snapshot)!).toISOString();

    eligible.push({ index: bucket[0].index, row: t90Snapshot, identity, score, entryPrice, minutesUntilStart, createdAtIso });
  }

  // One-per-event dedup: group eligible identities by eventKey, deterministic
  // winner (highest score -> earliest created_at -> smallest observationId).
  const byEvent = new Map<string, EvaluatedRow[]>();
  for (const evaluated of eligible) {
    const key = evaluated.identity.eventKey;
    const group = byEvent.get(key);
    if (group) group.push(evaluated);
    else byEvent.set(key, [evaluated]);
  }

  const winners: EvaluatedRow[] = [];
  for (const group of byEvent.values()) {
    const sorted = [...group].sort(compareForTieBreak);
    const [winner, ...losers] = sorted;
    winners.push(winner);
    for (const loser of losers) {
      rejections.push({
        index: loser.index,
        observationId: loser.identity.observationId,
        eventKey: loser.identity.eventKey,
        reason: "DUPLICATE_EVENT_LOWER_RANK",
      });
    }
  }

  const acceptedDecisions = winners
    .map((evaluated) => buildDecision(evaluated, asOfIso))
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId));

  rejections.sort((a, b) => a.index - b.index);

  return {
    asOfIso,
    modelVersion: FROZEN_MODEL_V2_VERSION,
    inputCount: rows.length,
    eligibleCount: eligible.length,
    acceptedDecisions,
    rejections,
  };
}

function compareForTieBreak(a: EvaluatedRow, b: EvaluatedRow): number {
  if (a.score !== b.score) return b.score - a.score;
  const aCreatedMs = Date.parse(a.createdAtIso);
  const bCreatedMs = Date.parse(b.createdAtIso);
  if (aCreatedMs !== bCreatedMs) return aCreatedMs - bCreatedMs;
  return a.identity.observationId.localeCompare(b.identity.observationId);
}

function buildDecisionId(fields: {
  observationId: string;
  eventKey: string;
  asOfIso: string;
  modelVersion: string;
  score: number;
  entryPrice: number;
  minutesUntilStart: number;
  selectedOutcome: string;
}): string {
  return sha(stable(fields));
}

function buildDecision(evaluated: EvaluatedRow, asOfIso: string): FrozenModelV2Decision {
  const { identity } = evaluated;
  const decisionId = buildDecisionId({
    observationId: identity.observationId,
    eventKey: identity.eventKey,
    asOfIso,
    modelVersion: FROZEN_MODEL_V2_VERSION,
    score: evaluated.score,
    entryPrice: evaluated.entryPrice,
    minutesUntilStart: evaluated.minutesUntilStart,
    selectedOutcome: identity.selectedOutcome,
  });
  return {
    decisionId,
    observationId: identity.observationId,
    eventKey: identity.eventKey,
    asOfIso,
    modelVersion: FROZEN_MODEL_V2_VERSION,
    score: evaluated.score,
    entryPrice: evaluated.entryPrice,
    minutesUntilStart: evaluated.minutesUntilStart,
    selectedOutcome: identity.selectedOutcome,
    createdAtIso: evaluated.createdAtIso,
  };
}
