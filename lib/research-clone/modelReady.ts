import { createHash } from "node:crypto";
import type { ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { runResearchEngine, FROZEN_MODEL_IDS, type FrozenModelId } from "@/lib/modeling/research-engine";

export const DEGRADED_MODEL_DATES = new Set(["2026-09-05"]);
export const MODEL_READY_VERSION = "clone-model-ready-v1";

export type StoredModelRow = {
  model_date: string; population_id: string; condition_id: string; selected_token_id: string;
  decision_at: string; provider_event_id: string | null; entry_price_num: number | null;
  event_start: string | null; sport_family: string | null; settlement_label: string;
  source_kind: "RESEARCH_CLONE"; materializer_version: string;
  canonical_row: ScorecardReadyRow; canonical_row_sha256: string;
};

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const r = v as Record<string, unknown>;
  return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${stable(r[k])}`).join(",")}}`;
}
export function toStoredModelRow(modelDate: string, row: ScorecardReadyRow): StoredModelRow {
  const canonical = stable(row);
  return {
    model_date: modelDate, population_id: row.populationId, condition_id: row.conditionId,
    selected_token_id: row.selectedTokenId, decision_at: row.decisionAt,
    provider_event_id: row.providerEventId, entry_price_num: row.entryPrice,
    event_start: row.eventStart, sport_family: row.sportFamily,
    settlement_label: row.labelAsOf, source_kind: "RESEARCH_CLONE",
    materializer_version: MODEL_READY_VERSION, canonical_row: row,
    canonical_row_sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

/**
 * Resolves the frozen-evaluator sport-family carrier from a persisted
 * canonical row, old and new alike. Rows materialized after the carrier fix
 * already carry a normalized `sportFamily`. Rows accepted before that fix
 * carry the real source authority only under `providerSportFamily` (still
 * present verbatim on the immutable persisted `canonical_row` JSON, never
 * rewritten); this falls back to it with the exact same trim/lowercase
 * semantics used at the write boundary
 * (scripts/modeling/clone-model-ready-pipeline.ts:normalizeMaterializedSportFamily).
 * Missing source authority — on either shape — stays explicit `null`, never
 * fabricated.
 */
export function resolveSportFamily(row: { sportFamily?: string | null; providerSportFamily?: unknown }): string | null {
  if (typeof row.sportFamily === "string") {
    const normalized = row.sportFamily.trim().toLowerCase();
    if (normalized.length > 0) return normalized;
  }
  const fallback = typeof row.providerSportFamily === "string" ? row.providerSportFamily.trim().toLowerCase() : "";
  return fallback.length > 0 ? fallback : null;
}

export function evaluateRows(rows: ScorecardReadyRow[]) {
  const input = rows
    .filter((r) => (r.labelAsOf === "WIN" || r.labelAsOf === "LOSS") && r.providerEventId && r.eventStart && r.entryPrice !== null && r.entryPrice > 0 && r.entryPrice < 1)
    .sort((a, b) => a.decisionAt.localeCompare(b.decisionAt) || a.conditionId.localeCompare(b.conditionId))
    .map((r) => ({ physicalEventKey: r.providerEventId!, decisionTimestamp: r.decisionAt, eventStart: r.eventStart!, entryPrice: r.entryPrice!, sportFamily: resolveSportFamily(r) ?? "", outcome: r.labelAsOf as "WIN" | "LOSS", ref: r.conditionId }));
  const result = runResearchEngine(input, "all");
  return Object.fromEntries(FROZEN_MODEL_IDS.map((id: FrozenModelId) => [id, result.models[id]]));
}
