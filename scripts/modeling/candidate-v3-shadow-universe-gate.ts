// Candidate V3 shadow UNIVERSE pre-gate (bounded repair v1). Pure, research-only.
//
// Closes the edge   source row -> Candidate V3 universe -> produceFrozenModelV2ShadowDecisions
// which the Final Independent Review found open:
//   1. soccer/football scope was not enforced before the producer;
//   2. a missing/nested market type bypassed the producer's top-level
//      market_type check.
//
// This module runs BEFORE the producer and never modifies it. It reuses, and does
// not copy, the two existing authorities:
//   - sport:   normalizeProviderSportFamily (lib/feed/sportScoreOwnership.ts)
//              applied to the structured diagnostics.providerSportFamily;
//   - market:  classifyMarketText / isAllowedFullMatchMarketClass
//              (lib/contur3/taxonomy.ts) applied to the structured market type.
//
// Structured surfaces only: no title/slug inference, no outcome fields
// (winning_outcome / real_pnl_usd are never read). No DB, no network, no env.

import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";
import { getStrictDedupKeyForExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";
import {
  produceFrozenModelV2ShadowDecisions,
  type FrozenModelV2Decision,
  type FrozenModelV2Rejection,
} from "../../lib/modeling/frozenModelProducerV2Shadow";
import { normalizeProviderSportFamily } from "../../lib/feed/sportScoreOwnership";
import {
  classifyMarketText,
  isAllowedFullMatchMarketClass,
  normalizeMarketText,
  type MarketClass,
} from "../../lib/contur3/taxonomy";

export const CANDIDATE_V3_UNIVERSE_GATE_VERSION = "CANDIDATE_V3_SHADOW_UNIVERSE_GATE_V1" as const;

export type UniverseGateReasonCode =
  | "ALLOWED"
  | "SPORT_FAMILY_MISSING"
  | "SPORT_FAMILY_NOT_SOCCER"
  | "MARKET_TYPE_UNRESOLVED"
  | "MARKET_TYPE_CONTRADICTION"
  | "MARKET_CLASS_NOT_ALLOWED";

export interface UniverseGateResult {
  allowed: boolean;
  reason_code: UniverseGateReasonCode;
  normalized_sport_family: string | null;
  raw_market_type: string | null;
  canonical_market_class: MarketClass | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Structured market type, strict precedence:
 *   1. diagnostics.researchContext.marketType
 *   2. diagnostics.marketType
 * Non-empty strings only. Two present surfaces whose canonical normalized text
 * differs are a contradiction (fail closed). Outcome fields are never read.
 */
function resolveStructuredMarketType(
  diagnostics: Record<string, unknown> | null,
): { marketType: string } | { reason: "MARKET_TYPE_UNRESOLVED" | "MARKET_TYPE_CONTRADICTION"; marketType: string | null } {
  const nested = nonEmptyString(asRecord(diagnostics?.researchContext)?.marketType);
  const flat = nonEmptyString(diagnostics?.marketType);
  if (nested === null && flat === null) return { reason: "MARKET_TYPE_UNRESOLVED", marketType: null };
  if (nested !== null && flat !== null && normalizeMarketText(nested) !== normalizeMarketText(flat)) {
    return { reason: "MARKET_TYPE_CONTRADICTION", marketType: nested };
  }
  return { marketType: (nested ?? flat) as string };
}

export function evaluateCandidateV3UniverseGate(row: ExportRow): UniverseGateResult {
  const diagnostics = asRecord(row.diagnostics);

  // ---- SPORT GATE ----
  const normalizedSport = normalizeProviderSportFamily(diagnostics?.providerSportFamily);
  if (normalizedSport === null) {
    return { allowed: false, reason_code: "SPORT_FAMILY_MISSING", normalized_sport_family: null, raw_market_type: null, canonical_market_class: null };
  }
  if (normalizedSport !== "soccer") {
    return { allowed: false, reason_code: "SPORT_FAMILY_NOT_SOCCER", normalized_sport_family: normalizedSport, raw_market_type: null, canonical_market_class: null };
  }

  // ---- MARKET TYPE RESOLUTION ----
  const resolved = resolveStructuredMarketType(diagnostics);
  if ("reason" in resolved) {
    return { allowed: false, reason_code: resolved.reason, normalized_sport_family: normalizedSport, raw_market_type: resolved.marketType, canonical_market_class: null };
  }

  // ---- CANONICAL MARKET CLASS ----
  const marketClass = classifyMarketText(resolved.marketType);
  if (!isAllowedFullMatchMarketClass(marketClass)) {
    return { allowed: false, reason_code: "MARKET_CLASS_NOT_ALLOWED", normalized_sport_family: normalizedSport, raw_market_type: resolved.marketType, canonical_market_class: marketClass };
  }
  return { allowed: true, reason_code: "ALLOWED", normalized_sport_family: normalizedSport, raw_market_type: resolved.marketType, canonical_market_class: marketClass };
}

export interface UniverseGateRejection {
  index: number;
  observationId: string | null;
  reason_code: Exclude<UniverseGateReasonCode, "ALLOWED">;
  normalized_sport_family: string | null;
  raw_market_type: string | null;
  canonical_market_class: MarketClass | null;
}

export interface ProducerRejectionAtSourceIndex extends FrozenModelV2Rejection {
  /** `index` above is remapped to the row's position in the ORIGINAL input. */
  producerInputIndex: number;
}

export interface CandidateV3SelectorResult {
  gateVersion: typeof CANDIDATE_V3_UNIVERSE_GATE_VERSION;
  asOfIso: string;
  inputCount: number;
  universeAllowedCount: number;
  universeRejectedCount: number;
  universeGateRejectionCounts: Record<string, number>;
  universeGateRejections: UniverseGateRejection[];
  acceptedDecisions: FrozenModelV2Decision[];
  producerRejections: ProducerRejectionAtSourceIndex[];
  acceptedMarketClassCounts: Record<string, number>;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function createdIso(row: ExportRow): string | null {
  const ms = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Composition: universe gate -> existing producer (unmodified) on ALLOWED rows only.
 * Producer rules are not reimplemented here.
 */
export function runCandidateV3Selector(
  rows: readonly ExportRow[],
  asOfIso: string,
): CandidateV3SelectorResult {
  const allowedRows: ExportRow[] = [];
  const allowedSourceIndex: number[] = [];
  const classByRow = new Map<ExportRow, MarketClass>();
  const gateRejections: UniverseGateRejection[] = [];
  const gateRejectionCounts: Record<string, number> = {};

  rows.forEach((row, index) => {
    const gate = evaluateCandidateV3UniverseGate(row);
    if (gate.allowed) {
      allowedRows.push(row);
      allowedSourceIndex.push(index);
      classByRow.set(row, gate.canonical_market_class as MarketClass);
      return;
    }
    increment(gateRejectionCounts, gate.reason_code);
    gateRejections.push({
      index,
      observationId: getStrictDedupKeyForExportRow(row),
      reason_code: gate.reason_code as UniverseGateRejection["reason_code"],
      normalized_sport_family: gate.normalized_sport_family,
      raw_market_type: gate.raw_market_type,
      canonical_market_class: gate.canonical_market_class,
    });
  });

  const produced = produceFrozenModelV2ShadowDecisions(allowedRows, asOfIso);

  // Map each accepted decision back to the canonical class of the exact source
  // snapshot the producer selected (observationId + T-90 snapshot created_at).
  const classBySnapshot = new Map<string, MarketClass>();
  for (const row of allowedRows) {
    const observationId = getStrictDedupKeyForExportRow(row);
    const created = createdIso(row);
    if (observationId !== null && created !== null) {
      classBySnapshot.set(`${observationId}|${created}`, classByRow.get(row) as MarketClass);
    }
  }
  const acceptedClassCounts: Record<string, number> = {};
  for (const decision of produced.acceptedDecisions) {
    const cls = classBySnapshot.get(`${decision.observationId}|${decision.createdAtIso}`);
    if (cls === undefined) throw new Error("CANDIDATE_V3_ACCEPTED_DECISION_SOURCE_CLASS_UNRESOLVED");
    increment(acceptedClassCounts, cls);
  }

  return {
    gateVersion: CANDIDATE_V3_UNIVERSE_GATE_VERSION,
    asOfIso: produced.asOfIso,
    inputCount: rows.length,
    universeAllowedCount: allowedRows.length,
    universeRejectedCount: gateRejections.length,
    universeGateRejectionCounts: sortedCounts(gateRejectionCounts),
    universeGateRejections: gateRejections,
    acceptedDecisions: produced.acceptedDecisions,
    producerRejections: produced.rejections.map((rejection) => ({
      ...rejection,
      index: allowedSourceIndex[rejection.index],
      producerInputIndex: rejection.index,
    })),
    acceptedMarketClassCounts: sortedCounts(acceptedClassCounts),
  };
}
