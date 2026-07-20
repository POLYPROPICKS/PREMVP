// Frozen Model Producer V2 Shadow (Integration Milestone 2A, Part B).
//
// Pure, read-only, side-effect-free evaluator for the FROZEN
// B2_PRICE_FLOOR_030_TIMING_WITHIN_120M threshold contract. This module does
// NOT touch execution/order/reservation/queue/Ireland/CLOB systems -- it only
// classifies already-generated signal candidates (generated_signal_pairs
// export rows) into ACCEPTED decisions or REJECTED-with-reason, evaluated at
// an explicit --as-of boundary. The contract itself (thresholds, timing
// window, tie-break order) is frozen and must never be tuned here.
//
// Identity + score adapters are re-used verbatim from the existing modeling
// library (getStrictDedupKeyForExportRow, getScoreValue, isEsports) so this
// module never re-implements field-reading heuristics that already exist.
// Deterministic hashing re-uses stable()/sha() from canonicalModelHandoff.ts.

import type { ExportRow } from "./generatedSignalPairsExportContract";
import { getStrictDedupKeyForExportRow } from "./generatedSignalPairsExportContract";
import { getScoreValue, isEsports } from "./historicalFunnelVariants";
import { stable, sha } from "./canonicalModelHandoff";

export const FROZEN_MODEL_V2_VERSION = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M" as const;
export const FROZEN_MODEL_V2_SCHEMA_VERSION = "FROZEN_MODEL_V2_SHADOW_DECISION_V1" as const;

// ---- Frozen thresholds. DO NOT TUNE. ----
const SCORE_THRESHOLD = 65;
const PRICE_FLOOR = 0.3;
const TIMING_WINDOW_MINUTES = 120;

// Boundary choice (spec is ambiguous only at the exact edge): score == 65 and
// price == 0.30 are explicitly ACCEPTED per the brief ("exactly is
// ACCEPTED"). For timing, the spec says "within 120 minutes" -- we treat
// exactly 120 minutes as still WITHIN the window (inclusive upper boundary),
// symmetric with the score/price inclusive-at-threshold rule. Anything
// beyond 120 minutes (120.000001+) is OUTSIDE_120M.

const CONDITION_ID_FIELDS = ["condition_id", "conditionId"] as const;
const TOKEN_ID_FIELDS = ["token_id", "tokenId"] as const;
const SELECTED_OUTCOME_FIELDS = ["selected_outcome", "selectedOutcome"] as const;
const ENTRY_PRICE_FIELDS = ["entry_price_num", "entryPrice", "entry_price"] as const;
const EVENT_KEY_FIELDS = [
  "match_family_key",
  "matchFamilyKey",
  "canonical_event_key",
  "canonicalEventKey",
  "parent_event_key",
  "parentEventKey",
  "event_slug",
  "eventSlug",
  "event_title",
  "eventTitle",
] as const;
// Leakage fields: never read for scoring/selection. Only checked to prove
// they cannot influence the decision (tests flip these and assert no diff).
const LEAKAGE_FIELDS = ["winning_outcome", "winningOutcome", "real_pnl_usd", "realPnlUsd"] as const;
// Market families this frozen contract supports. A row that declares an
// explicit market_type/marketType outside this allow-list fails closed as
// UNSUPPORTED_MARKET. A row with no market_type field at all is treated as
// the default supported binary market (most export rows do not carry this
// field), so absence is not itself a rejection reason.
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

function getStringField(row: ExportRow, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function getEntryPrice(row: ExportRow): number | null {
  for (const key of ENTRY_PRICE_FIELDS) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function getEventKey(row: ExportRow): string | null {
  return getStringField(row, EVENT_KEY_FIELDS);
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
  // Event key: prefer explicit event-level fields; fall back to condition_id
  // (a market/condition maps to exactly one event in the absence of a more
  // specific event grouping field).
  const eventKey = getEventKey(row) ?? conditionId;
  return { identity: { conditionId, tokenId, selectedOutcome, observationId, eventKey } };
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

function evaluateRow(
  row: ExportRow,
  index: number,
  asOfMs: number,
): { accepted: EvaluatedRow } | { reason: FrozenModelV2RejectionReason; eventKey: string | null; observationId: string | null } {
  const identityResult = resolveIdentity(row);
  if ("reason" in identityResult) {
    return { reason: identityResult.reason, eventKey: null, observationId: null };
  }
  const { identity } = identityResult;

  const marketType = row.market_type ?? row.marketType;
  if (typeof marketType === "string" && marketType.trim() !== "" && !SUPPORTED_MARKET_TYPES.has(marketType.trim())) {
    return { reason: "UNSUPPORTED_MARKET", eventKey: identity.eventKey, observationId: identity.observationId };
  }

  const createdAtRaw = row.created_at;
  const createdAtIso = typeof createdAtRaw === "string" ? createdAtRaw : null;
  const createdAtMs = createdAtIso !== null ? Date.parse(createdAtIso) : NaN;
  if (createdAtIso === null || !Number.isFinite(createdAtMs)) {
    return { reason: "SNAPSHOT_NOT_T90_COMPATIBLE", eventKey: identity.eventKey, observationId: identity.observationId };
  }
  if (createdAtMs > asOfMs) {
    return { reason: "FUTURE_DATA_REJECTED", eventKey: identity.eventKey, observationId: identity.observationId };
  }

  if (isEsports(row)) {
    return { reason: "ESPORTS_EXCLUDED", eventKey: identity.eventKey, observationId: identity.observationId };
  }

  const score = getScoreValue(row);
  if (score === null || score < SCORE_THRESHOLD) {
    return { reason: "SCORE_BELOW_65", eventKey: identity.eventKey, observationId: identity.observationId };
  }

  const entryPrice = getEntryPrice(row);
  if (entryPrice === null || entryPrice < PRICE_FLOOR) {
    return { reason: "PRICE_BELOW_030", eventKey: identity.eventKey, observationId: identity.observationId };
  }

  const gameStartIso = getGameStartIso(row);
  const gameStartMs = gameStartIso !== null ? Date.parse(gameStartIso) : NaN;
  if (gameStartIso === null || !Number.isFinite(gameStartMs)) {
    return { reason: "SNAPSHOT_NOT_T90_COMPATIBLE", eventKey: identity.eventKey, observationId: identity.observationId };
  }
  const minutesUntilStart = (gameStartMs - asOfMs) / 60_000;
  if (minutesUntilStart > TIMING_WINDOW_MINUTES) {
    return { reason: "OUTSIDE_120M", eventKey: identity.eventKey, observationId: identity.observationId };
  }

  return {
    accepted: {
      index,
      row,
      identity,
      score,
      entryPrice,
      minutesUntilStart,
      createdAtIso: new Date(createdAtMs).toISOString(),
    },
  };
}

/**
 * Deterministic one-per-event tie-break: highest score wins; ties broken by
 * earliest created_at (decision time); remaining ties broken by
 * lexicographically smallest observationId (strict dedup key). This order is
 * chosen so the winner is reproducible independent of input row order.
 */
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

/**
 * Top-level pure entry point. Never reads winning_outcome/real_pnl_usd (the
 * LEAKAGE_FIELDS constant exists only so a test module can assert those keys
 * are absent from any code path that reads scoring inputs; this function
 * itself never accesses row[leakageField]).
 */
export function produceFrozenModelV2ShadowDecisions(
  rows: readonly ExportRow[],
  asOfIsoInput: string,
): FrozenModelV2ShadowResult {
  const asOfIso = normalizeAsOfIso(asOfIsoInput);
  const asOfMs = Date.parse(asOfIso);

  const rejections: FrozenModelV2Rejection[] = [];
  const eligible: EvaluatedRow[] = [];

  rows.forEach((row, index) => {
    const result = evaluateRow(row, index, asOfMs);
    if ("accepted" in result) {
      eligible.push(result.accepted);
    } else {
      rejections.push({ index, observationId: result.observationId, eventKey: result.eventKey, reason: result.reason });
    }
  });

  // One-per-event dedup: group eligible rows by eventKey, deterministically
  // pick a single winner per group, reject the rest as
  // DUPLICATE_EVENT_LOWER_RANK. Grouping + sort are order-independent so the
  // outcome does not depend on input row order.
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
