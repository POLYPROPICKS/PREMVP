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
  obj,
  buildProviderCodeSportMap,
  explicitSportFamily,
  buildOverlayRecord,
  buildMarketTypeResolverIndex,
  resolveMarketType,
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

export const SOURCE_ROW_SELECT = [
  "model_date", "population_id", "condition_id", "selected_token_id", "decision_at",
  "provider_event_id", "sport_family", "settlement_label", "entry_price_num",
  "canonical_sport_family:canonical_row->sportFamily",
  "canonical_provider_sport_family:canonical_row->providerSportFamily",
  "canonical_provider_sport_code:canonical_row->providerSportCode",
  "canonical_market_type_raw:canonical_row->marketTypeRaw",
  "canonical_lead_time_hours:canonical_row->leadTimeHours",
  "canonical_score_level:canonical_row->scoreLevel",
  "canonical_data_coverage:canonical_row->dataCoverage",
  "canonical_volume_usd:canonical_row->volumeUsd",
  "canonical_event_start:canonical_row->eventStart",
].join(",");

export function reconstructSourceRow(row: Record<string, unknown>): SourceRow {
  return {
    model_date: String(row.model_date),
    population_id: String(row.population_id),
    condition_id: String(row.condition_id),
    selected_token_id: String(row.selected_token_id),
    decision_at: String(row.decision_at),
    provider_event_id: row.provider_event_id as string | null,
    sport_family: row.sport_family as string | null,
    settlement_label: row.settlement_label as string | null,
    entry_price_num: row.entry_price_num as number | null,
    canonical_row: {
      sportFamily: row.canonical_sport_family,
      providerSportFamily: row.canonical_provider_sport_family,
      providerSportCode: row.canonical_provider_sport_code,
      marketTypeRaw: row.canonical_market_type_raw,
      leadTimeHours: row.canonical_lead_time_hours,
      scoreLevel: row.canonical_score_level,
      dataCoverage: row.canonical_data_coverage,
      volumeUsd: row.canonical_volume_usd,
      eventStart: row.canonical_event_start,
    },
  };
}

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

type CanonicalSourceIdentity = Pick<SourceRow,
  "model_date" | "population_id" | "condition_id" | "selected_token_id" | "decision_at">;

const HEX = "0123456789abcdef";

function compareSourceIdentity(a: CanonicalSourceIdentity, b: CanonicalSourceIdentity): number {
  for (const key of ["population_id", "condition_id", "selected_token_id", "decision_at"] as const) {
    const compared = a[key].localeCompare(b[key]);
    if (compared !== 0) return compared;
  }
  return 0;
}

/** Read condition-id hex-prefix buckets, splitting saturated first-level buckets once. */
export async function readPartitionedSourceDate<T extends CanonicalSourceIdentity>(
  date: string,
  fetchBucket: (prefix: string) => Promise<T[]>,
  pageSize = PAGE,
): Promise<T[]> {
  const rows: T[] = [];
  for (const first of HEX) {
    const prefix = `0x${first}`;
    const bucket = await fetchBucket(prefix);
    if (bucket.length < pageSize) {
      rows.push(...bucket);
      continue;
    }
    for (const second of HEX) {
      const childPrefix = `${prefix}${second}`;
      const child = await fetchBucket(childPrefix);
      if (child.length >= pageSize) {
        throw new Error(`RECON_SOURCE_PARTITION_TOO_LARGE:${date}:${childPrefix}`);
      }
      rows.push(...child);
    }
  }

  rows.sort(compareSourceIdentity);
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = [row.model_date, row.population_id, row.condition_id, row.selected_token_id, row.decision_at].join("::");
    if (seen.has(identity)) throw new Error(`RECON_SOURCE_DUPLICATE_IDENTITY:${date}:${identity}`);
    seen.add(identity);
  }
  return rows;
}

export async function readPartitionedSourceDateFromDb(db: any, date: string): Promise<SourceRow[]> {
  return readPartitionedSourceDate(date, async (prefix) => {
    const { data, error } = await db
      .from("research_model_ready_rows")
      .select(SOURCE_ROW_SELECT)
      .eq("model_date", date)
      .like("condition_id", `${prefix}%`)
      .order("population_id")
      .order("condition_id")
      .order("selected_token_id")
      .order("decision_at")
      .limit(PAGE);
    if (error) throw new Error(`RECON_SOURCE_READ:${date}:${error.code ?? error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map(reconstructSourceRow);
  });
}

/** Per-day bounded prefix reads avoid offset pagination over the date range. */
export async function readAllSourceRows(db: any, rangeEnd: string = RANGE_END): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for (const d of eachDate(RANGE_START, rangeEnd)) {
    rows.push(...await readPartitionedSourceDateFromDb(db, d));
    console.error(JSON.stringify({ STAGE: "SOURCE_READ", MODEL_DATE: d, ROWS_SO_FAR: rows.length }));
  }
  return rows;
}

type GspExactPair = Pick<GspMarketTypeEntry, "condition_id" | "selected_token_id">;

/** Default THROW (canonical fail-closed). SKIP = oversize pair yields no GSP entries (stays unresolved -> excluded from ordinary HOLD), recorded in `skipped`. */
export const GSP_OVERSIZE_POLICY: { mode: "THROW" | "SKIP"; skipped: string[] } = { mode: "THROW", skipped: [] };

export async function readExactGspMarketTypeEntries(
  pairs: GspExactPair[],
  fetchChunk: (chunk: GspExactPair[]) => Promise<GspMarketTypeEntry[]>,
  pageSize = PAGE,
  chunkSize = 50,
  onChunkComplete?: (lastPair: GspExactPair, entries: GspMarketTypeEntry[]) => void,
): Promise<GspMarketTypeEntry[]> {
  const orderedPairs = pairs.map((pair) => {
    if (!/^[A-Za-z0-9_-]+$/.test(pair.condition_id) || !/^[A-Za-z0-9_-]+$/.test(pair.selected_token_id)) {
      throw new Error("RECON_GSP_READ_INVALID_EXACT_ID");
    }
    return pair;
  }).sort((a, b) => a.condition_id.localeCompare(b.condition_id)
    || a.selected_token_id.localeCompare(b.selected_token_id));
  const readChunk = async (chunk: GspExactPair[]): Promise<GspMarketTypeEntry[]> => {
    const exactPairs = new Set(chunk.map((pair) => `${pair.condition_id}::${pair.selected_token_id}`));
    const data = await fetchChunk(chunk);
    if (data.length >= pageSize) {
      if (chunk.length === 1 && GSP_OVERSIZE_POLICY.mode === "SKIP") {
        GSP_OVERSIZE_POLICY.skipped.push(`${chunk[0].condition_id}::${chunk[0].selected_token_id}`);
        return [];
      }
      if (chunk.length === 1) {
        throw new Error(`RECON_GSP_EXACT_PAIR_TOO_LARGE:${chunk[0].condition_id}:${chunk[0].selected_token_id}`);
      }
      const middle = Math.floor(chunk.length / 2);
      return [
        ...await readChunk(chunk.slice(0, middle)),
        ...await readChunk(chunk.slice(middle)),
      ];
    }
    const entries: GspMarketTypeEntry[] = [];
    for (const entry of data) {
      if (!exactPairs.has(`${entry.condition_id}::${entry.selected_token_id}`)) continue;
      if (typeof entry.market_type !== "string") continue;
      entries.push(entry);
    }
    return entries;
  };

  const entries: GspMarketTypeEntry[] = [];
  for (let i = 0; i < orderedPairs.length; i += chunkSize) {
    const chunk = orderedPairs.slice(i, i + chunkSize);
    const chunkEntries = await readChunk(chunk);
    entries.push(...chunkEntries);
    onChunkComplete?.(chunk[chunk.length - 1], chunkEntries);
  }
  return entries.sort((a, b) => a.condition_id.localeCompare(b.condition_id)
    || a.selected_token_id.localeCompare(b.selected_token_id)
    || a.created_at.localeCompare(b.created_at)
    || a.id.localeCompare(b.id));
}

export async function readGspMarketTypeIndex(db: any, keys: Set<string>): Promise<Map<string, GspMarketTypeEntry[]>> {
  const pairs = [...keys].sort().map((key) => {
    const separator = key.indexOf("::");
    const condition_id = key.slice(0, separator);
    const selected_token_id = key.slice(separator + 2);
    if (separator <= 0) throw new Error("RECON_GSP_READ_INVALID_EXACT_ID");
    return { condition_id, selected_token_id };
  });
  console.error(JSON.stringify({ STAGE: "GSP_READ_START", CANDIDATE_IDENTITIES: pairs.length }));
  const progressKeys = new Set<string>();
  const entries = await readExactGspMarketTypeEntries(pairs, async (chunk) => {
    const exactPairFilter = chunk
      .map(({ condition_id, selected_token_id }) => `and(condition_id.eq.${condition_id},selected_token_id.eq.${selected_token_id})`)
      .join(",");
    const { data, error } = await db
      .from("generated_signal_pairs")
      .select("id,condition_id,selected_token_id,created_at,market_type:diagnostics->marketType")
      .or(exactPairFilter)
      .limit(PAGE);
    if (error) throw new Error(`RECON_GSP_READ:${error.code ?? error.message}`);
    return (data ?? []).map((raw: unknown) => {
      const r = obj(raw);
      return {
        id: String(r.id ?? ""),
        condition_id: String(r.condition_id ?? ""),
        selected_token_id: String(r.selected_token_id ?? ""),
        created_at: String(r.created_at ?? ""),
        market_type: typeof r.market_type === "string" ? r.market_type : null,
      } satisfies GspMarketTypeEntry;
    });
  }, PAGE, 50, (lastPair, chunkEntries) => {
    for (const entry of chunkEntries) progressKeys.add(`${entry.condition_id}::${entry.selected_token_id}`);
    console.error(JSON.stringify({ STAGE: "GSP_READ", EXACT_PAIR_CHUNK_END: `${lastPair.condition_id}::${lastPair.selected_token_id}`, KEYS_SO_FAR: progressKeys.size }));
  });
  const index = new Map<string, GspMarketTypeEntry[]>();
  for (const entry of entries) {
      const key = `${entry.condition_id}::${entry.selected_token_id}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push(entry);
  }
  console.error(JSON.stringify({ STAGE: "GSP_READ_COMPLETE", IDENTITIES: index.size }));
  return index;
}

export async function readSnapshotMarketTypes(db: any, keys: Set<string>): Promise<SnapshotMarketTypeEntry[]> {
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
    console.error(JSON.stringify({ STAGE: "SNAPSHOT_READ", CONDITION_CHUNK_END: chunk.at(-1), OBSERVATIONS_SO_FAR: entries.length }));
  }
  return entries;
}

export async function readEvidencePageMarketTypes(db: any, keys: Set<string>): Promise<EvidenceMarketTypeEntry[]> {
  const tokensByCondition = new Map<string, Set<string>>();
  for (const key of keys) {
    const separator = key.indexOf("::");
    const conditionId = key.slice(0, separator);
    const selectedTokenId = key.slice(separator + 2);
    if (!/^[A-Za-z0-9_-]+$/.test(conditionId) || !/^[A-Za-z0-9_-]+$/.test(selectedTokenId)) {
      throw new Error("RECON_EVIDENCE_READ_INVALID_EXACT_ID");
    }
    if (!tokensByCondition.has(conditionId)) tokensByCondition.set(conditionId, new Set());
    tokensByCondition.get(conditionId)!.add(selectedTokenId);
  }
  const conditionEntries = [...tokensByCondition.entries()].sort(([a], [b]) => a.localeCompare(b));
  const entries: EvidenceMarketTypeEntry[] = [];
  const conditionPageSize = 50;
  for (let i = 0; i < conditionEntries.length; i += conditionPageSize) {
    const chunk = conditionEntries.slice(i, i + conditionPageSize);
    const exactPairFilter = chunk
      .map(([conditionId, selectedTokens]) => `and(condition_id.eq.${conditionId},selected_token_id.in.(${[...selectedTokens].sort().join(",")}))`)
      .join(",");
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("research_evidence_page_rows")
        .select("observation_id,condition_id,selected_token_id,observed_at,market_type")
        .or(exactPairFilter)
        .not("market_type", "is", null)
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
    console.error(JSON.stringify({ STAGE: "EVIDENCE_PAGE_READ", CONDITION_CHUNK_END: chunk.at(-1)?.[0], OBSERVATIONS_SO_FAR: entries.length }));
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

export function marketTypeLineageBreakdown(rows: OverlayRecord[]): MarketTypeLineageBreakdown {
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
      if (selectedSource !== "MARKET_TYPE_CONFLICT" && selectedSource !== "MARKET_TYPE_UNRESOLVED") {
        result.RESOLVED_N++;
      }
      if (group.some((r) => r.reconciled_market_type === "soccer_exact_score")) result.EXACT_SCORE_N++;
      if (group.some((r) => r.reconciled_market_type !== null && r.reconciled_market_type !== "soccer_exact_score")) result.PROVEN_ORDINARY_N++;
    }
    const attributed = Object.values(LINEAGE_REPORT_NAMES).reduce((sum, name) => sum + result[name], 0);
    if (result.RESOLVED_N + result.UNRESOLVED_N + result.CONFLICT_N !== result.CANONICAL_SOCCER_N
      || attributed !== result.CANONICAL_SOCCER_N) {
      throw new Error("RECON_MARKET_TYPE_LINEAGE_SUMMARY_INVARIANT");
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

export async function runReconciliationV2(db: any, rangeEnd: string = RANGE_END): Promise<{
  overlay: OverlayRecord[];
  sourceRows: SourceRow[];
  periods: { AUG: PeriodBreakdown; SEP_1_12: PeriodBreakdown; SEP_13_24: PeriodBreakdown; COMBINED: PeriodBreakdown };
  duplicateIdentitiesTotal: number;
}> {
  console.error(JSON.stringify({ STAGE: "START", SOURCE_RANGE: `${RANGE_START}..${RANGE_END}` }));
  const sourceRows = await readAllSourceRows(db, rangeEnd);
  console.error(JSON.stringify({ STAGE: "SOURCE_READ_COMPLETE", ROWS: sourceRows.length }));

  const marketTypeRows = sourceRows.filter((row) => {
    const sport = explicitSportFamily(row);
    return sport.conflict || sport.value === null || sport.value === "soccer";
  });
  const identityKeys = new Set(marketTypeRows.map((r) => `${r.condition_id}::${r.selected_token_id}`));
  console.error(JSON.stringify({ STAGE: "LINEAGE_SCOPE", SOURCE_ROWS: sourceRows.length, CANDIDATE_ROWS: marketTypeRows.length, IDENTITIES: identityKeys.size }));
  const snapshotTypes = await readSnapshotMarketTypes(db, identityKeys);
  console.error(JSON.stringify({ STAGE: "SNAPSHOT_READ_COMPLETE", OBSERVATIONS: snapshotTypes.length }));
  const emptyGspIndex = new Map<string, GspMarketTypeEntry[]>();
  const snapshotResolver = buildMarketTypeResolverIndex(sourceRows, snapshotTypes, [], emptyGspIndex);
  const gspCandidateKeys = new Set<string>();
  for (const row of marketTypeRows) {
    if (resolveMarketType(row, emptyGspIndex, snapshotResolver).basis === "MARKET_TYPE_UNRESOLVED") {
      gspCandidateKeys.add(`${row.condition_id}::${row.selected_token_id}`);
    }
  }
  console.error(JSON.stringify({ STAGE: "GSP_READ_START", CANDIDATE_IDENTITIES: gspCandidateKeys.size }));
  const gspIndex = await readGspMarketTypeIndex(db, gspCandidateKeys);
  console.error(JSON.stringify({ STAGE: "GSP_READ_COMPLETE", IDENTITIES: gspIndex.size }));
  const gspResolver = buildMarketTypeResolverIndex(sourceRows, snapshotTypes, [], gspIndex);
  const evidenceCandidateKeys = new Set<string>();
  for (const row of marketTypeRows) {
    if (resolveMarketType(row, gspIndex, gspResolver).basis === "MARKET_TYPE_UNRESOLVED") {
      evidenceCandidateKeys.add(`${row.condition_id}::${row.selected_token_id}`);
    }
  }
  console.error(JSON.stringify({ STAGE: "EVIDENCE_PAGE_READ_START", CANDIDATE_IDENTITIES: evidenceCandidateKeys.size }));
  const evidenceTypes = await readEvidencePageMarketTypes(db, evidenceCandidateKeys);
  console.error(JSON.stringify({ STAGE: "EVIDENCE_PAGE_READ_COMPLETE", OBSERVATIONS: evidenceTypes.length }));
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
