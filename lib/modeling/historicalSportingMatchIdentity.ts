// Frozen-corpus-only sporting-match identity derivation.
// Pure, deterministic, fail-closed; never used unless explicitly selected.

import { createHash } from "node:crypto";
import type { ExportRow } from "./generatedSignalPairsExportContract";

export const HISTORICAL_SPORTING_MATCH_IDENTITY_VERSION = "HISTORICAL_DERIVED_MATCH_KEY_V1" as const;

export type HistoricalMatchIdentityConfidence =
  | "HIGH_PAIR_START"
  | "UNIQUE_SAME_START_LINK"
  | "REJECTED_AMBIGUOUS";

export interface HistoricalMatchIdentityEvidence {
  observationId: string;
  key: string | null;
  confidence: HistoricalMatchIdentityConfidence;
  canonicalStartIso: string | null;
  participants: readonly [string, string] | null;
  sourceField: string | null;
}

export interface HistoricalSportingMatchIdentityIndex {
  byObservationId: Map<string, HistoricalMatchIdentityEvidence>;
  derivedMatchGroups: number;
  derivedMatchCollisionCount: number;
}

export interface HistoricalSportingMatchIdentityAudit {
  algorithmVersion: typeof HISTORICAL_SPORTING_MATCH_IDENTITY_VERSION;
  summary: {
    totalRows: number;
    highConfidenceRows: number;
    uniquelyLinkedRows: number;
    ambiguousRejectedRows: number;
    derivedMatchGroups: number;
    derivedMatchCollisionCount: number;
  };
  derivedMatchCollisionCount: number;
  largestGroups: Array<{ key: string; rows: number }>;
  representativeMultiMarketGroups: Array<{ key: string; observationIds: string[] }>;
  representativeRejectedAmbiguousRows: Array<{ observationId: string; sourceField: string | null }>;
  contentHash: string;
}

export function assertHistoricalSportingMatchIdentityAuditSafe(audit: HistoricalSportingMatchIdentityAudit): void {
  if (audit.derivedMatchCollisionCount !== 0) {
    throw new Error(`historical identity audit found ${audit.derivedMatchCollisionCount} collisions`);
  }
  if (audit.summary.derivedMatchGroups === 0) {
    throw new Error("historical identity audit found zero derived match groups");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function diagnosticsOf(row: ExportRow): Record<string, unknown> {
  return row.diagnostics && typeof row.diagnostics === "object" && !Array.isArray(row.diagnostics)
    ? row.diagnostics as Record<string, unknown>
    : {};
}

function observationIdOf(row: ExportRow): string {
  const id = text(row.id) ?? (typeof row.id === "number" ? String(row.id) : null);
  if (id) return id;
  return `anon:${hash(JSON.stringify(row))}`;
}

function canonicalStartOf(row: ExportRow): string | null {
  const raw = text(diagnosticsOf(row).gameStartIso);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeParticipant(value: string): string | null {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^(?:will\s+|spread:\s*)/i, "")
    .replace(/\s*\((?:bo\d+|[-+]?\d+(?:\.\d+)?)\)\s*$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized.length >= 2 ? normalized : null;
}

function cleanPairSide(value: string, side: "a" | "b"): string | null {
  let result = value.trim();
  if (side === "a") result = result.replace(/^(?:valorant|counter-strike|dota 2|lol):\s*/i, "");
  else result = result.split(/\s+-\s+|:\s+/)[0].replace(/\s*\((?:bo\d+)\).*$/i, "");
  return normalizeParticipant(result);
}

function candidateTexts(row: ExportRow): Array<{ field: string; value: string }> {
  const diagnostics = diagnosticsOf(row);
  const candidates: Array<[string, unknown]> = [
    ["event_slug", row.event_slug],
    ["event_title", row.event_title],
    ["diagnostics.marketTitle", diagnostics.marketTitle],
    ["market_slug", row.market_slug],
    ["diagnostics.marketSlug", diagnostics.marketSlug],
  ];
  return candidates.flatMap(([field, value]) => {
    const found = text(value);
    return found ? [{ field, value: found }] : [];
  });
}

function extractPair(row: ExportRow): { participants: [string, string]; sourceField: string } | null {
  for (const candidate of candidateTexts(row)) {
    if (/\.\.\.|…/.test(candidate.value)) continue;
    const beat = candidate.value.match(/^will\s+(.+?)\s+beat\s+(.+?)(?:\?|\s+-\s+|:\s+|$)/i);
    const versus = candidate.value.match(/(.+?)\s+(?:vs\.?|versus)\s+(.+)/i);
    const match = beat ?? versus;
    if (!match) continue;
    const a = cleanPairSide(match[1], "a");
    const b = cleanPairSide(match[2], "b");
    if (!a || !b || a === b) continue;
    return { participants: [a, b].sort((x, y) => x.localeCompare(y)) as [string, string], sourceField: candidate.field };
  }
  return null;
}

function extractSingleParticipant(row: ExportRow): { participant: string; sourceField: string } | null {
  for (const candidate of candidateTexts(row)) {
    if (/\.\.\.|…/.test(candidate.value)) continue;
    const patterns = [
      /^(.+?)\s+—\s+match winner$/i,
      /^(.+?)\s+leading at halftime\??$/i,
      /^will\s+(.+?)\s+win on\s+/i,
      /^spread:\s*(.+?)\s*\(/i,
      /^(.+?)\s+to score first\s+/i,
    ];
    for (const pattern of patterns) {
      const match = candidate.value.match(pattern);
      const participant = match ? normalizeParticipant(match[1]) : null;
      if (participant) return { participant, sourceField: candidate.field };
    }
  }
  return null;
}

function matchKey(start: string, participants: readonly [string, string]): string {
  return `historical:v1:${hash(`${start}|${participants[0]}|${participants[1]}`)}`;
}

export function deriveHistoricalSportingMatchKeyV1(row: ExportRow): HistoricalMatchIdentityEvidence {
  const observationId = observationIdOf(row);
  const canonicalStartIso = canonicalStartOf(row);
  const pair = extractPair(row);
  if (!canonicalStartIso || !pair) {
    return { observationId, key: null, confidence: "REJECTED_AMBIGUOUS", canonicalStartIso, participants: null, sourceField: null };
  }
  return {
    observationId,
    key: matchKey(canonicalStartIso, pair.participants),
    confidence: "HIGH_PAIR_START",
    canonicalStartIso,
    participants: pair.participants,
    sourceField: pair.sourceField,
  };
}

export function buildHistoricalSportingMatchIdentityIndex(rows: readonly ExportRow[]): HistoricalSportingMatchIdentityIndex {
  const ordered = [...rows].sort((a, b) => observationIdOf(a).localeCompare(observationIdOf(b)));
  const byObservationId = new Map<string, HistoricalMatchIdentityEvidence>();
  const highByStart = new Map<string, HistoricalMatchIdentityEvidence[]>();
  for (const row of ordered) {
    const evidence = deriveHistoricalSportingMatchKeyV1(row);
    byObservationId.set(evidence.observationId, evidence);
    if (evidence.confidence === "HIGH_PAIR_START" && evidence.canonicalStartIso) {
      const bucket = highByStart.get(evidence.canonicalStartIso) ?? [];
      bucket.push(evidence);
      highByStart.set(evidence.canonicalStartIso, bucket);
    }
  }

  for (const row of ordered) {
    const id = observationIdOf(row);
    if (byObservationId.get(id)?.confidence === "HIGH_PAIR_START") continue;
    const start = canonicalStartOf(row);
    const single = extractSingleParticipant(row);
    if (!start || !single) continue;
    const candidates = new Map<string, HistoricalMatchIdentityEvidence>();
    for (const high of highByStart.get(start) ?? []) {
      if (high.key && high.participants?.includes(single.participant)) candidates.set(high.key, high);
    }
    if (candidates.size === 1) {
      const linked = [...candidates.values()][0];
      byObservationId.set(id, { observationId: id, key: linked.key, confidence: "UNIQUE_SAME_START_LINK", canonicalStartIso: start, participants: linked.participants, sourceField: single.sourceField });
    }
  }

  const signatures = new Map<string, Set<string>>();
  for (const evidence of byObservationId.values()) {
    if (!evidence.key || !evidence.canonicalStartIso || !evidence.participants) continue;
    const set = signatures.get(evidence.key) ?? new Set<string>();
    set.add(`${evidence.canonicalStartIso}|${evidence.participants.join("|")}`);
    signatures.set(evidence.key, set);
  }
  return {
    byObservationId,
    derivedMatchGroups: signatures.size,
    derivedMatchCollisionCount: [...signatures.values()].filter((set) => set.size > 1).length,
  };
}

export function auditHistoricalSportingMatchIdentityV1(rows: readonly ExportRow[]): HistoricalSportingMatchIdentityAudit {
  const index = buildHistoricalSportingMatchIdentityIndex(rows);
  const assignments = [...index.byObservationId.values()].sort((a, b) => a.observationId.localeCompare(b.observationId));
  const groups = new Map<string, string[]>();
  for (const evidence of assignments) {
    if (!evidence.key) continue;
    const ids = groups.get(evidence.key) ?? [];
    ids.push(evidence.observationId);
    groups.set(evidence.key, ids);
  }
  const orderedGroups = [...groups].map(([key, ids]) => ({ key, observationIds: ids.sort(), rows: ids.length })).sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key));
  const summary = {
    totalRows: rows.length,
    highConfidenceRows: assignments.filter((x) => x.confidence === "HIGH_PAIR_START").length,
    uniquelyLinkedRows: assignments.filter((x) => x.confidence === "UNIQUE_SAME_START_LINK").length,
    ambiguousRejectedRows: assignments.filter((x) => x.confidence === "REJECTED_AMBIGUOUS").length,
    derivedMatchGroups: index.derivedMatchGroups,
    derivedMatchCollisionCount: index.derivedMatchCollisionCount,
  };
  const contentHash = hash(JSON.stringify(assignments.map((x) => [x.observationId, x.key, x.confidence])));
  return {
    algorithmVersion: HISTORICAL_SPORTING_MATCH_IDENTITY_VERSION,
    summary,
    derivedMatchCollisionCount: index.derivedMatchCollisionCount,
    largestGroups: orderedGroups.slice(0, 20).map(({ key, rows: count }) => ({ key, rows: count })),
    representativeMultiMarketGroups: orderedGroups.filter((g) => g.rows > 1).slice(0, 20).map(({ key, observationIds }) => ({ key, observationIds: observationIds.slice(0, 20) })),
    representativeRejectedAmbiguousRows: assignments.filter((x) => x.confidence === "REJECTED_AMBIGUOUS").slice(0, 20).map((x) => ({ observationId: x.observationId, sourceField: x.sourceField })),
    contentHash,
  };
}
