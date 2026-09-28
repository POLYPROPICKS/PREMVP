/**
 * FOOTBALL_DENOMINATOR_RECONCILIATION_V2
 *
 * Extends FOOTBALL_DENOMINATOR_RECONCILIATION_V1
 * (build-football-denominator-reconciliation.ts) through 2026-09-24 without
 * overwriting the v1 artifact. Every classification rule (fail-closed sport
 * reconciliation, structured soccer market-type recovery, exact identity
 * joins) is imported verbatim from the v1 module — this file only extends
 * the date range/period split and re-runs the same read + classify + write
 * pipeline over 2026-08-04..2026-09-24, split into AUG / SEP_1_12 / SEP_13_24
 * / COMBINED.
 *
 * Read-only against the research clone. Never rewrites the source corpus or
 * any DB row.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  norm,
  obj,
  buildProviderCodeSportMap,
  buildOverlayRecord,
  buildMarketTypeResolverIndex,
  sortOverlay,
  countDuplicateIdentities,
  buildPeriodStats,
  crossPeriodPhysicalEventCount,
  EXPECTED_CLONE_REF,
  type SourceRow,
  type OverlayRecord,
  type GspMarketTypeEntry,
  type SnapshotMarketTypeEntry,
  type EvidenceMarketTypeEntry,
  type MarketTypeResolverIndex,
  type MarketTypeSource,
  type PeriodStats,
} from "./build-football-denominator-reconciliation";

export const OUT_DIR = "modeling/evidence/football-denominator-reconciliation-v2";
export const RANGE_START = "2026-08-04";
export const AUG_END = "2026-08-31";
export const SEP_START = "2026-09-01";
export const SEP_1_12_END = "2026-09-12";
export const SEP_13_24_START = "2026-09-13";
export const RANGE_END = "2026-09-24";
const PAGE = 1000;
const GSP_PAGE = 200;

function projectRef(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

function eachDate(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let d = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  while (d <= end) {
    out.push(new Date(d).toISOString().slice(0, 10));
    d += 86_400_000;
  }
  return out;
}

/** Same per-day paginated read strategy as v1 (avoids a global ORDER BY timeout), extended through RANGE_END. */
async function readAllSourceRows(db: any): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for (const d of eachDate(RANGE_START, RANGE_END)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("research_model_ready_rows")
        .select("model_date,population_id,condition_id,selected_token_id,decision_at,provider_event_id,sport_family,settlement_label,entry_price_num,canonical_row")
        .eq("model_date", d)
        .order("population_id")
        .order("condition_id")
        .order("selected_token_id")
        .order("decision_at")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`RECON_SOURCE_READ:${d}:${error.code ?? error.message}`);
      rows.push(...((data ?? []) as SourceRow[]));
      if ((data?.length ?? 0) < PAGE) break;
    }
  }
  return rows;
}

async function readGspMarketTypeIndex(db: any, keys: Set<string>): Promise<Map<string, GspMarketTypeEntry[]>> {
  const index = new Map<string, GspMarketTypeEntry[]>();
  if (keys.size === 0) return index;
  const conditionIds = [...new Set([...keys].map((k) => k.split("::")[0]))].sort();
  for (let i = 0; i < conditionIds.length; i += GSP_PAGE) {
    const chunk = conditionIds.slice(i, i + GSP_PAGE);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("generated_signal_pairs")
        .select("id,condition_id,selected_token_id,created_at,diagnostics")
        .in("condition_id", chunk)
        .order("condition_id")
        .order("selected_token_id")
        .order("created_at")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`RECON_GSP_READ:${error.code ?? error.message}`);
      for (const raw of data ?? []) {
        const r = obj(raw);
        const conditionId = String(r.condition_id ?? "");
        const selectedTokenId = String(r.selected_token_id ?? "");
        const key = `${conditionId}::${selectedTokenId}`;
        const d2 = obj(r.diagnostics);
        const entry: GspMarketTypeEntry = {
          id: String(r.id ?? ""),
          condition_id: conditionId,
          selected_token_id: selectedTokenId,
          created_at: String(r.created_at ?? ""),
          market_type: typeof d2.marketType === "string" ? d2.marketType : null,
        };
        if (!index.has(key)) index.set(key, []);
        index.get(key)!.push(entry);
      }
      if ((data?.length ?? 0) < PAGE) break;
    }
  }
  return index;
}

async function readSnapshotMarketTypes(db: any, keys: Set<string>): Promise<SnapshotMarketTypeEntry[]> {
  const conditionIds = [...new Set([...keys].map((k) => k.split("::")[0]))].sort();
  const entries: SnapshotMarketTypeEntry[] = [];
  for (let i = 0; i < conditionIds.length; i += GSP_PAGE) {
    const chunk = conditionIds.slice(i, i + GSP_PAGE);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("generated_signal_research_snapshots")
        .select("condition_id,selected_token_id,diagnostics")
        .in("condition_id", chunk)
        .order("condition_id")
        .order("selected_token_id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`RECON_SNAPSHOT_READ:${error.code ?? error.message}`);
      for (const raw of data ?? []) {
        const r = obj(raw);
        const diagnostics = obj(r.diagnostics);
        const researchContext = obj(diagnostics.researchContext);
        const fireModel = obj(diagnostics.fireModel);
        const rawHints = obj(fireModel.rawFeatureHints);
        const contextType = typeof researchContext.marketType === "string" ? researchContext.marketType : null;
        const hintType = typeof rawHints.marketType === "string" ? rawHints.marketType : null;
        if (contextType === null && hintType === null) continue;
        entries.push({
          condition_id: String(r.condition_id ?? ""),
          selected_token_id: String(r.selected_token_id ?? ""),
          research_context_market_type: contextType,
          firemodel_hint_market_type: hintType,
        });
      }
      if ((data?.length ?? 0) < PAGE) break;
    }
  }
  return entries;
}

async function readEvidencePageMarketTypes(db: any, keys: Set<string>): Promise<EvidenceMarketTypeEntry[]> {
  const conditionIds = [...new Set([...keys].map((k) => k.split("::")[0]))].sort();
  const entries: EvidenceMarketTypeEntry[] = [];
  for (let i = 0; i < conditionIds.length; i += GSP_PAGE) {
    const chunk = conditionIds.slice(i, i + GSP_PAGE);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("research_evidence_page_rows")
        .select("observation_id,condition_id,selected_token_id,observed_at,market_type")
        .in("condition_id", chunk)
        .order("observed_at")
        .order("observation_id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`RECON_EVIDENCE_READ:${error.code ?? error.message}`);
      for (const raw of data ?? []) {
        const r = obj(raw);
        const conditionId = String(r.condition_id ?? "");
        const selectedTokenId = String(r.selected_token_id ?? "");
        if (!keys.has(`${conditionId}::${selectedTokenId}`)) continue;
        entries.push({
          id: String(r.observation_id ?? ""),
          condition_id: conditionId,
          selected_token_id: selectedTokenId,
          created_at: String(r.observed_at ?? ""),
          market_type: typeof r.market_type === "string" ? r.market_type : null,
        });
      }
      if ((data?.length ?? 0) < PAGE) break;
    }
  }
  return entries;
}

function canonicalJsonLine(r: OverlayRecord): string {
  const keys: (keyof OverlayRecord)[] = [
    "model_date", "population_id", "provider_event_id", "condition_id", "selected_token_id", "decision_at",
    "source_sport_family", "reconciled_sport_family", "sport_reconciliation_basis",
    "provider_sport_code",
    "source_market_type", "reconciled_market_type", "market_type_source",
    "display_odds_available", "settlement_available", "lead_time_available", "score_level_available", "data_coverage_available", "volume_available",
  ];
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = r[k];
  return JSON.stringify(ordered);
}

export function buildOverlay(
  sourceRows: SourceRow[],
  gspIndex: Map<string, GspMarketTypeEntry[]>,
  resolverIndex?: MarketTypeResolverIndex,
): OverlayRecord[] {
  const codeMap = buildProviderCodeSportMap(sourceRows);
  return sortOverlay(sourceRows.map((row) => buildOverlayRecord(row, codeMap, gspIndex, resolverIndex)));
}

export interface PeriodBreakdown {
  RANGE: string;
  SOURCE_ROW_N: number;
  UNIQUE_SELECTION_N: number;
  UNIQUE_PHYSICAL_EVENT_N: number;
  SPORT_UNRESOLVED_N: number;
  SPORT_CONFLICT_N: number;
  DUPLICATE_OVERLAY_IDENTITY_N: number;
  marketTypeLineage: MarketTypeLineageBreakdown;
  stats: PeriodStats;
}

export interface MarketTypeLineageBreakdown {
  IDENTITY: Record<string, number>;
  PHYSICAL_EVENT: Record<string, number>;
}

const LINEAGE_SOURCES: MarketTypeSource[] = [
  "MARKET_TYPE_CANONICAL",
  "MARKET_TYPE_RESEARCH_CONTEXT_EXACT",
  "MARKET_TYPE_FIREMODEL_HINT_EXACT",
  "MARKET_TYPE_CONDITION_STATIC",
  "MARKET_TYPE_EVIDENCE_PAGE_EXACT",
  "MARKET_TYPE_GSP_DIAGNOSTICS",
  "MARKET_TYPE_CONFLICT",
  "MARKET_TYPE_UNRESOLVED",
];
const LINEAGE_REPORT_NAMES: Record<MarketTypeSource, string> = {
  MARKET_TYPE_CANONICAL: "FROM_CANONICAL_ROW_N",
  MARKET_TYPE_RESEARCH_CONTEXT_EXACT: "FROM_RESEARCH_CONTEXT_EXACT_N",
  MARKET_TYPE_FIREMODEL_HINT_EXACT: "FROM_FIREMODEL_HINT_EXACT_N",
  MARKET_TYPE_CONDITION_STATIC: "FROM_CONDITION_STATIC_RECOVERY_N",
  MARKET_TYPE_EVIDENCE_PAGE_EXACT: "FROM_EVIDENCE_PAGE_N",
  MARKET_TYPE_GSP_DIAGNOSTICS: "FROM_GSP_N",
  MARKET_TYPE_CONFLICT: "CONFLICT_N",
  MARKET_TYPE_UNRESOLVED: "UNRESOLVED_N",
};

function marketTypeLineageBreakdown(rows: OverlayRecord[]): MarketTypeLineageBreakdown {
  const rank = new Map(LINEAGE_SOURCES.map((source, i) => [source, i]));
  const summarize = (groups: Map<string, OverlayRecord[]>): Record<string, number> => {
    const result: Record<string, number> = Object.fromEntries(Object.values(LINEAGE_REPORT_NAMES).map((name) => [name, 0]));
    result.CANONICAL_SOCCER_N = groups.size;
    result.RESOLVED_N = 0;
    result.EXACT_SCORE_N = 0;
    result.PROVEN_ORDINARY_N = 0;
    for (const group of groups.values()) {
      const selectedSource = group.map((r) => r.market_type_source).sort((a, b) => rank.get(a)! - rank.get(b)!)[0];
      result[LINEAGE_REPORT_NAMES[selectedSource]]++;
      if (selectedSource === "MARKET_TYPE_CONFLICT") result.CONFLICT_N++;
      else if (selectedSource === "MARKET_TYPE_UNRESOLVED") result.UNRESOLVED_N++;
      else result.RESOLVED_N++;
      if (group.some((r) => r.reconciled_market_type === "soccer_exact_score")) result.EXACT_SCORE_N++;
      if (group.some((r) => r.reconciled_market_type !== null && r.reconciled_market_type !== "soccer_exact_score")) result.PROVEN_ORDINARY_N++;
    }
    return result;
  };
  const identities = new Map<string, OverlayRecord[]>();
  const events = new Map<string, OverlayRecord[]>();
  for (const row of rows) {
    if (row.reconciled_sport_family !== "soccer") continue;
    const identityKey = `${row.condition_id}::${row.selected_token_id}`;
    if (!identities.has(identityKey)) identities.set(identityKey, []);
    identities.get(identityKey)!.push(row);
    if (row.provider_event_id) {
      if (!events.has(row.provider_event_id)) events.set(row.provider_event_id, []);
      events.get(row.provider_event_id)!.push(row);
    }
  }
  return { IDENTITY: summarize(identities), PHYSICAL_EVENT: summarize(events) };
}

function periodBreakdown(range: string, rows: OverlayRecord[]): PeriodBreakdown {
  const stats = buildPeriodStats(rows);
  return {
    RANGE: range,
    SOURCE_ROW_N: stats.source_row_n,
    UNIQUE_SELECTION_N: stats.unique_selection_n,
    UNIQUE_PHYSICAL_EVENT_N: stats.unique_physical_event_n,
    SPORT_UNRESOLVED_N: stats.sport_unresolved_physical_event_n,
    SPORT_CONFLICT_N: stats.sport_conflict_physical_event_n,
    DUPLICATE_OVERLAY_IDENTITY_N: countDuplicateIdentities(rows),
    marketTypeLineage: marketTypeLineageBreakdown(rows),
    stats,
  };
}

export async function runReconciliationV2(db: any): Promise<{
  overlay: OverlayRecord[];
  sourceRows: SourceRow[];
  periods: { AUG: PeriodBreakdown; SEP_1_12: PeriodBreakdown; SEP_13_24: PeriodBreakdown; COMBINED: PeriodBreakdown };
  duplicateIdentitiesTotal: number;
}> {
  const sourceRows = await readAllSourceRows(db);

  const identityKeys = new Set(sourceRows.map((r) => `${r.condition_id}::${r.selected_token_id}`));
  const gspIndex = await readGspMarketTypeIndex(db, identityKeys);
  const snapshotTypes = await readSnapshotMarketTypes(db, identityKeys);
  const evidenceTypes = await readEvidencePageMarketTypes(db, identityKeys);
  const resolverIndex = buildMarketTypeResolverIndex(sourceRows, snapshotTypes, evidenceTypes, gspIndex);
  const overlay = buildOverlay(sourceRows, gspIndex, resolverIndex);
  const duplicateIdentitiesTotal = countDuplicateIdentities(overlay);

  const augRows = overlay.filter((r) => r.model_date >= RANGE_START && r.model_date <= AUG_END);
  const sep1Rows = overlay.filter((r) => r.model_date >= SEP_START && r.model_date <= SEP_1_12_END);
  const sep2Rows = overlay.filter((r) => r.model_date >= SEP_13_24_START && r.model_date <= RANGE_END);

  return {
    overlay,
    sourceRows,
    periods: {
      AUG: periodBreakdown(`${RANGE_START}..${AUG_END}`, augRows),
      SEP_1_12: periodBreakdown(`${SEP_START}..${SEP_1_12_END}`, sep1Rows),
      SEP_13_24: periodBreakdown(`${SEP_13_24_START}..${RANGE_END}`, sep2Rows),
      COMBINED: periodBreakdown(`${RANGE_START}..${RANGE_END}`, overlay),
    },
    duplicateIdentitiesTotal,
  };
}

async function main() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("REQUIRED_CLONE_READ_AUTHORIZATION_UNAVAILABLE");
  if (projectRef(url) !== EXPECTED_CLONE_REF || (process.env.SUPABASE_URL && projectRef(process.env.SUPABASE_URL) === projectRef(url))) {
    throw new Error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH");
  }
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { overlay, periods, duplicateIdentitiesTotal } = await runReconciliationV2(db);
  const crossAugSep1 = crossPeriodPhysicalEventCount(
    overlay.filter((r) => r.model_date >= RANGE_START && r.model_date <= AUG_END),
    overlay.filter((r) => r.model_date >= SEP_START && r.model_date <= SEP_1_12_END),
  );
  const crossSep1Sep2 = crossPeriodPhysicalEventCount(
    overlay.filter((r) => r.model_date >= SEP_START && r.model_date <= SEP_1_12_END),
    overlay.filter((r) => r.model_date >= SEP_13_24_START && r.model_date <= RANGE_END),
  );

  mkdirSync(OUT_DIR, { recursive: true });

  const jsonl = overlay.map(canonicalJsonLine).join("\n") + (overlay.length ? "\n" : "");
  const gz = gzipSync(Buffer.from(jsonl, "utf8"), { level: 9 });
  const overlayFile = `FOOTBALL_DENOMINATOR_OVERLAY_${RANGE_START}_${RANGE_END}.jsonl.gz`;
  writeFileSync(join(OUT_DIR, overlayFile), gz);
  const overlayContentSha256 = createHash("sha256").update(jsonl, "utf8").digest("hex");

  const manifest = {
    MISSION: "FOOTBALL_DENOMINATOR_RECONCILIATION_V2",
    EXTENDS: "FOOTBALL_DENOMINATOR_RECONCILIATION_V1 (2026-08-04..2026-09-20) -- v1 artifact unchanged",
    SOURCE_RANGE: `${RANGE_START}..${RANGE_END}`,
    SOURCE_TABLE: "research_model_ready_rows",
    SECONDARY_SOURCE_TABLE: "generated_signal_pairs",
    CLONE_PROJECT_REF: EXPECTED_CLONE_REF,
    OVERLAY_ROW_N: overlay.length,
    OVERLAY_CONTENT_SHA256: overlayContentSha256,
    DUPLICATE_OVERLAY_IDENTITY_N: duplicateIdentitiesTotal,
    CROSS_PERIOD_PHYSICAL_EVENT_N_AUG_SEP1_12: crossAugSep1,
    CROSS_PERIOD_PHYSICAL_EVENT_N_SEP1_12_SEP13_24: crossSep1Sep2,
    AUG: periods.AUG,
    SEP_1_12: periods.SEP_1_12,
    SEP_13_24: periods.SEP_13_24,
    COMBINED: periods.COMBINED,
    IMMUTABLE_SOURCE_CORPUS_UNCHANGED: true,
    PRODUCTION_WRITES: 0,
    CLONE_DB_WRITES: 0,
    NO_MODEL_RANKING_PERFORMED: true,
    NO_EXECUTION_ECONOMICS_CLAIM: true,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(OUT_DIR, `MANIFEST_${RANGE_START}_${RANGE_END}.json`), manifestJson);

  const findings = `# Football Denominator Reconciliation V2 — ${RANGE_START} .. ${RANGE_END}

Status: **DENOMINATOR / CLASSIFICATION AUTHORITY ONLY**

Extends \`football-denominator-reconciliation-v1\` (2026-08-04..2026-09-20) through 2026-09-24.
The v1 artifact under \`modeling/evidence/football-denominator-reconciliation-v1/\` is unchanged.
Every classification rule below is imported verbatim from \`build-football-denominator-reconciliation.ts\` (v1) — this run only extends the read range and adds the SEP_1_12 / SEP_13_24 period split.

## Source range

Read-only overlay over \`research_model_ready_rows\` (research clone \`${EXPECTED_CLONE_REF}\`) for \`${RANGE_START}\` through \`${RANGE_END}\`, split into AUG (\`${periods.AUG.RANGE}\`), SEP_1_12 (\`${periods.SEP_1_12.RANGE}\`) and SEP_13_24 (\`${periods.SEP_13_24.RANGE}\`).

## Per-period summary

| Period | SOURCE_ROW_N | UNIQUE_SELECTION_N | UNIQUE_PHYSICAL_EVENT_N | CANONICAL_SOCCER_PHYSICAL_EVENT_N | SPORT_UNRESOLVED_N | SPORT_CONFLICT_N | DUPLICATE_OVERLAY_IDENTITY_N |
|---|---|---|---|---|---|---|---|
| AUG | ${periods.AUG.SOURCE_ROW_N} | ${periods.AUG.UNIQUE_SELECTION_N} | ${periods.AUG.UNIQUE_PHYSICAL_EVENT_N} | ${periods.AUG.stats.canonical_soccer_physical_event_n} | ${periods.AUG.SPORT_UNRESOLVED_N} | ${periods.AUG.SPORT_CONFLICT_N} | ${periods.AUG.DUPLICATE_OVERLAY_IDENTITY_N} |
| SEP_1_12 | ${periods.SEP_1_12.SOURCE_ROW_N} | ${periods.SEP_1_12.UNIQUE_SELECTION_N} | ${periods.SEP_1_12.UNIQUE_PHYSICAL_EVENT_N} | ${periods.SEP_1_12.stats.canonical_soccer_physical_event_n} | ${periods.SEP_1_12.SPORT_UNRESOLVED_N} | ${periods.SEP_1_12.SPORT_CONFLICT_N} | ${periods.SEP_1_12.DUPLICATE_OVERLAY_IDENTITY_N} |
| SEP_13_24 | ${periods.SEP_13_24.SOURCE_ROW_N} | ${periods.SEP_13_24.UNIQUE_SELECTION_N} | ${periods.SEP_13_24.UNIQUE_PHYSICAL_EVENT_N} | ${periods.SEP_13_24.stats.canonical_soccer_physical_event_n} | ${periods.SEP_13_24.SPORT_UNRESOLVED_N} | ${periods.SEP_13_24.SPORT_CONFLICT_N} | ${periods.SEP_13_24.DUPLICATE_OVERLAY_IDENTITY_N} |
| COMBINED | ${periods.COMBINED.SOURCE_ROW_N} | ${periods.COMBINED.UNIQUE_SELECTION_N} | ${periods.COMBINED.UNIQUE_PHYSICAL_EVENT_N} | ${periods.COMBINED.stats.canonical_soccer_physical_event_n} | ${periods.COMBINED.SPORT_UNRESOLVED_N} | ${periods.COMBINED.SPORT_CONFLICT_N} | ${periods.COMBINED.DUPLICATE_OVERLAY_IDENTITY_N} |

(COMBINED is deduplicated over the whole ${RANGE_START}..${RANGE_END} range, not a sum of the three periods; a physical event present in more than one period is counted once in COMBINED. Physical events present in both AUG and SEP_1_12: ${crossAugSep1}. Physical events present in both SEP_1_12 and SEP_13_24: ${crossSep1Sep2}.)

## Canonical market-type lineage

Counts are shown first by unique \`condition_id + selected_token_id\` identity, then by unique \`provider_event_id\` physical event, for canonical soccer only. A condition with conflicting normalized structured observations fails closed.

\`MARKET_TYPE_LINEAGE_BY_PERIOD\`:
\`\`\`json
${JSON.stringify(Object.fromEntries(Object.entries(periods).map(([period, breakdown]) => [period, breakdown.marketTypeLineage])), null, 2)}
\`\`\`

## Scope and non-claims

This artifact defines **denominator and sport/market classification authority only**.

- \`NO_MODEL_RANKING_PERFORMED\`
- \`NO_EXECUTION_ECONOMICS_CLAIM\`
- \`IMMUTABLE_SOURCE_CORPUS_UNCHANGED\`

No hypothesis was tested, no ROI or leaderboard was computed here, and \`research_model_ready_rows\`/\`research_model_ready_days\` were not modified — this is a read-only sidecar overlay.
`;
  writeFileSync(join(OUT_DIR, "FINDINGS.md"), findings);

  const overlayGzSha256 = createHash("sha256").update(gz).digest("hex");
  const manifestSha256 = createHash("sha256").update(manifestJson, "utf8").digest("hex");
  const findingsSha256 = createHash("sha256").update(findings, "utf8").digest("hex");
  const shaLines = [
    `${overlayGzSha256}  ${overlayFile}`,
    `${manifestSha256}  MANIFEST_${RANGE_START}_${RANGE_END}.json`,
    `${findingsSha256}  FINDINGS.md`,
  ];
  writeFileSync(join(OUT_DIR, "SHA256SUMS.txt"), shaLines.join("\n") + "\n");

  console.log(JSON.stringify({
    STATUS: "SUCCESS",
    SOURCE_RANGE: `${RANGE_START}..${RANGE_END}`,
    OVERLAY_ROW_N: overlay.length,
    DUPLICATE_OVERLAY_IDENTITY_N: duplicateIdentitiesTotal,
    AUG: periods.AUG,
    SEP_1_12: periods.SEP_1_12,
    SEP_13_24: periods.SEP_13_24,
    COMBINED: periods.COMBINED,
    PRODUCTION_WRITES: 0,
    CLONE_DB_WRITES: 0,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
