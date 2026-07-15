import { createHash } from "node:crypto";
import type { ExportRow } from "./generatedSignalPairsExportContract";
import {
  buildHistoricalSportingMatchIdentityIndex,
  type HistoricalMatchIdentityEvidence,
  type HistoricalSportingMatchIdentityIndex,
} from "./historicalSportingMatchIdentity";

export const HISTORICAL_MATCH_IDENTITY_RECOVERY_VERSION = "HISTORICAL_DERIVED_MATCH_KEY_V2_EXACT_RESCUE" as const;

export interface HistoricalIdentityRecoveryAudit {
  version: typeof HISTORICAL_MATCH_IDENTITY_RECOVERY_VERSION;
  originalRejectedRows: number;
  safelyRecoveredRows: number;
  remainingAmbiguousRows: number;
  newDerivedMatchGroups: number;
  collisionCount: number;
  representativeRecoveredExamples: Array<{ observationId: string; sourceField: "event_slug"; matchKey: string }>;
  representativeRemainingAmbiguousExamples: Array<{ observationId: string; reason: "NO_UNIQUE_EXACT_SLUG_START_LINK" }>;
  contentHash: string;
}

function id(row: ExportRow): string { return typeof row.id === "string" ? row.id : String(row.id ?? ""); }
function start(row: ExportRow): string | null {
  const d = row.diagnostics && typeof row.diagnostics === "object" && !Array.isArray(row.diagnostics) ? row.diagnostics as Record<string, unknown> : {};
  if (typeof d.gameStartIso !== "string") return null;
  const ms = Date.parse(d.gameStartIso); return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function slug(row: ExportRow): string | null {
  return typeof row.event_slug === "string" && row.event_slug.trim() ? row.event_slug.normalize("NFKC").trim().toLowerCase() : null;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function buildHistoricalMatchIdentityRecovery(rows: readonly ExportRow[], auditScopeRows: readonly ExportRow[] = rows): { index: HistoricalSportingMatchIdentityIndex; audit: HistoricalIdentityRecoveryAudit } {
  const ordered = [...rows].sort((a, b) => id(a).localeCompare(id(b)));
  const v1 = buildHistoricalSportingMatchIdentityIndex(ordered);
  const byObservationId = new Map(v1.byObservationId);
  const exactAnchors = new Map<string, Map<string, HistoricalMatchIdentityEvidence>>();
  for (const row of ordered) {
    const evidence = byObservationId.get(id(row)), s = start(row), eventSlug = slug(row);
    if (!evidence?.key || evidence.confidence !== "HIGH_PAIR_START" || !s || !eventSlug) continue;
    const bucketKey = `${s}|${eventSlug}`, bucket = exactAnchors.get(bucketKey) ?? new Map<string, HistoricalMatchIdentityEvidence>();
    bucket.set(evidence.key, evidence); exactAnchors.set(bucketKey, bucket);
  }
  const scopeIds = new Set(auditScopeRows.map(id));
  const originalRejectedRows = [...byObservationId.values()].filter((x) => scopeIds.has(x.observationId) && !x.key).length;
  const recovered: Array<{ observationId: string; sourceField: "event_slug"; matchKey: string }> = [];
  for (const row of ordered) {
    const observationId = id(row); if (byObservationId.get(observationId)?.key) continue;
    const s = start(row), eventSlug = slug(row); if (!s || !eventSlug) continue;
    const anchors = exactAnchors.get(`${s}|${eventSlug}`); if (!anchors || anchors.size !== 1) continue;
    const anchor = [...anchors.values()][0];
    byObservationId.set(observationId, { ...anchor, observationId, confidence: "UNIQUE_SAME_START_LINK", sourceField: "event_slug" });
    recovered.push({ observationId, sourceField: "event_slug", matchKey: anchor.key! });
  }
  const signatures = new Map<string, Set<string>>();
  for (const evidence of byObservationId.values()) if (evidence.key && evidence.canonicalStartIso && evidence.participants) {
    const set = signatures.get(evidence.key) ?? new Set<string>(); set.add(`${evidence.canonicalStartIso}|${evidence.participants.join("|")}`); signatures.set(evidence.key, set);
  }
  const scopedRecovered = recovered.filter((x) => scopeIds.has(x.observationId));
  const remaining = [...byObservationId.values()].filter((x) => scopeIds.has(x.observationId) && !x.key).sort((a,b)=>a.observationId.localeCompare(b.observationId));
  const collisionCount = [...signatures.values()].filter((x) => x.size !== 1).length;
  const assignments = [...byObservationId.values()].sort((a,b)=>a.observationId.localeCompare(b.observationId)).map(x=>[x.observationId,x.key,x.sourceField]);
  return {
    index: { byObservationId, derivedMatchGroups: signatures.size, derivedMatchCollisionCount: collisionCount },
    audit: {
      version: HISTORICAL_MATCH_IDENTITY_RECOVERY_VERSION, originalRejectedRows, safelyRecoveredRows: scopedRecovered.length,
      remainingAmbiguousRows: remaining.length, newDerivedMatchGroups: signatures.size - v1.derivedMatchGroups, collisionCount,
      representativeRecoveredExamples: scopedRecovered.slice(0, 10),
      representativeRemainingAmbiguousExamples: remaining.slice(0, 10).map(x=>({observationId:x.observationId,reason:"NO_UNIQUE_EXACT_SLUG_START_LINK"})),
      contentHash: digest(assignments),
    },
  };
}
