// Read-only sporting-match identity diagnostics.
//
// This deliberately reports observable candidate relationships only. It does
// not create an execution grouping, normalize slugs, or invoke replay/model
// selection logic.

import type { ExportRow } from "./generatedSignalPairsExportContract";

export interface FieldCoverage {
  field: string;
  populatedRows: number;
  coveragePct: number;
}

export interface IdentityCluster {
  field: string;
  value: string;
  rowCount: number;
  distinctConditionIds: number;
  distinctMarketSlugs: number;
  collisionRisk: "NONE" | "MULTI_MARKET" | "AMBIGUOUS";
}

export interface SportingMatchIdentityDiagnostic {
  totalRows: number;
  fieldCoverage: FieldCoverage[];
  likelyMultiMarketClusters: IdentityCluster[];
  collisionRisks: IdentityCluster[];
  notes: string[];
}

const CANDIDATE_FIELDS = ["match_family_key", "canonical_event_key", "parent_event_key", "event_slug"] as const;
const CONDITION_FIELD = "condition_id";
const MARKET_FIELD = "market_slug";

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result === "" ? null : result;
}

function toPercent(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 10_000) / 100;
}

/**
 * Inspects only top-level fields that occur in the supplied rows. Candidate
 * values are used verbatim; repeated values are diagnostic evidence, not a
 * proposed execution key.
 */
export function inspectSportingMatchIdentity(rows: readonly ExportRow[]): SportingMatchIdentityDiagnostic {
  const presentFields = new Set<string>();
  for (const row of rows) for (const field of Object.keys(row)) presentFields.add(field);

  const fields = CANDIDATE_FIELDS.filter((field) => presentFields.has(field));
  const fieldCoverage = fields.map((field) => {
    const populatedRows = rows.reduce((count, row) => count + (nonBlank(row[field]) === null ? 0 : 1), 0);
    return { field, populatedRows, coveragePct: toPercent(populatedRows, rows.length) };
  });

  const clusters: IdentityCluster[] = [];
  for (const field of fields) {
    const grouped = new Map<string, { conditions: Set<string>; markets: Set<string>; rows: number }>();
    for (const row of rows) {
      const value = nonBlank(row[field]);
      if (value === null) continue;
      const group = grouped.get(value) ?? { conditions: new Set<string>(), markets: new Set<string>(), rows: 0 };
      group.rows += 1;
      const condition = nonBlank(row[CONDITION_FIELD]);
      const market = nonBlank(row[MARKET_FIELD]);
      if (condition !== null) group.conditions.add(condition);
      if (market !== null) group.markets.add(market);
      grouped.set(value, group);
    }
    for (const [value, group] of grouped) {
      if (group.rows < 2) continue;
      const multiMarket = group.markets.size > 1 || group.conditions.size > 1;
      clusters.push({
        field,
        value,
        rowCount: group.rows,
        distinctConditionIds: group.conditions.size,
        distinctMarketSlugs: group.markets.size,
        collisionRisk: !multiMarket ? "NONE" : group.markets.size > 1 && group.conditions.size > 1 ? "MULTI_MARKET" : "AMBIGUOUS",
      });
    }
  }

  const ordered = clusters.sort((a, b) => a.field.localeCompare(b.field) || a.value.localeCompare(b.value));
  return {
    totalRows: rows.length,
    fieldCoverage,
    likelyMultiMarketClusters: ordered.filter((cluster) => cluster.collisionRisk === "MULTI_MARKET"),
    collisionRisks: ordered.filter((cluster) => cluster.collisionRisk !== "NONE"),
    notes: [
      "Candidate values are reported verbatim and are not normalized.",
      "This diagnostic does not create execution groups or change replay/model behavior.",
      "A collision risk means repeated candidate value spans multiple observed market or condition identities; it is not proof of one real-world match.",
    ],
  };
}
