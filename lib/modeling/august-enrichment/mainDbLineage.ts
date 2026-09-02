/**
 * AUGUST_MAIN_DB_ENRICHMENT_V1 — pure point-in-time lineage helpers.
 *
 * Shared by scripts/modeling/build-august-enriched-main.ts. No IO, no DB, no LLM.
 * Encodes the leakage gate and the per-feature lineage envelope so they can be
 * unit-tested independently of the live production read.
 */

export type MainFeatureStatus =
  | "RECOVERED"
  | "ENRICHMENT_UNRESOLVED"
  | "NEVER_PERSISTED_FOR_POPULATION";

export interface MainFeature {
  value: string | number | null;
  source_table: string | null;
  source_field: string | null;
  semantic: string;
  observed_at: string | null;
  join_key: string | null;
  source_row_id: string | null;
  status: MainFeatureStatus;
  note?: string;
}

/** A feature value is eligible only if it was observable at or before decision time. */
export function pointInTimeSafe(observedAtIso: string | null, decisionIso: string): boolean {
  if (observedAtIso === null) return true; // value lives on the decision row itself
  const o = Date.parse(observedAtIso);
  const d = Date.parse(decisionIso);
  return Number.isFinite(o) && Number.isFinite(d) && o <= d;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Build a lineage-carrying feature. Missing value => ENRICHMENT_UNRESOLVED.
 * Value present but observed after the decision => ENRICHMENT_UNRESOLVED with a
 * leakage note (never RECOVERED). Nothing is imputed.
 */
export function buildFeature(args: {
  value: string | number | null;
  table: string;
  field: string;
  semantic: string;
  observedAt: string | null;
  joinKey: string | null;
  sourceRowId: string | null;
  decisionIso: string;
}): MainFeature {
  const { value, table, field, semantic, observedAt, joinKey, sourceRowId, decisionIso } = args;
  if (value === null || value === "") {
    return {
      value: null, source_table: table, source_field: field, semantic,
      observed_at: null, join_key: joinKey, source_row_id: sourceRowId,
      status: "ENRICHMENT_UNRESOLVED",
    };
  }
  if (!pointInTimeSafe(observedAt, decisionIso)) {
    return {
      value: null, source_table: table, source_field: field, semantic,
      observed_at: observedAt, join_key: joinKey, source_row_id: sourceRowId,
      status: "ENRICHMENT_UNRESOLVED",
      note: "value failed point-in-time gate (observed_at > decision_timestamp)",
    };
  }
  return {
    value, source_table: table, source_field: field, semantic,
    observed_at: observedAt, join_key: joinKey, source_row_id: sourceRowId,
    status: "RECOVERED",
  };
}

/**
 * Score slots for the shadow-strategic-sports-v1 population. The production
 * writer (lib/feed/cacheGeneratedSignals.ts writeStrategicShadowPairs) inserts a
 * literal NULL for every score column on this population, so a genuine value is
 * only possible if some other persisted surface carried it point-in-time.
 */
export function buildScoreFeature(args: {
  value: number | null;
  table: string;
  field: string;
  semantic: string;
  observedAt: string | null;
  id: string;
  decisionIso: string;
  gspRowPresent: boolean;
}): MainFeature {
  const { value, table, field, semantic, observedAt, id, decisionIso, gspRowPresent } = args;
  if (value !== null && pointInTimeSafe(observedAt, decisionIso)) {
    return {
      value, source_table: table, source_field: field, semantic,
      observed_at: observedAt, join_key: `id=${id}`, source_row_id: id, status: "RECOVERED",
    };
  }
  return {
    value: null, source_table: table, source_field: field, semantic,
    observed_at: null, join_key: `id=${id}`, source_row_id: gspRowPresent ? id : null,
    status: "NEVER_PERSISTED_FOR_POPULATION",
    note: "writeStrategicShadowPairs inserts literal NULL for this column on the shadow-strategic-sports-v1 population (cacheGeneratedSignals.ts:545-554)",
  };
}
