/**
 * FOOTBALL_DENOMINATOR_RECONCILIATION_V1
 *
 * Reads the immutable, already-accepted `research_model_ready_rows` (clone
 * only) for 2026-08-04..2026-09-20 and produces a deterministic SIDECAR
 * overlay classifying, per canonical model-ready identity
 * (model_date, population_id, condition_id, selected_token_id, decision_at),
 * what sport/market classification is known, safely recovered, or left
 * unresolved. It never rewrites the source corpus or any DB row: this is a
 * read-only evidence artifact (gzip JSONL + manifest + findings + checksums)
 * written under modeling/evidence/football-denominator-reconciliation-v1/.
 *
 * Fail-closed sport rules (see mission contract) — normalization is
 * trim+lowercase only, never fuzzy/title/slug-based inference.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const OUT_DIR = "modeling/evidence/football-denominator-reconciliation-v1";
export const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
export const RANGE_START = "2026-08-04";
export const AUG_END = "2026-08-31";
export const SEP_START = "2026-09-01";
export const RANGE_END = "2026-09-20";
const PAGE = 1000;
const GSP_PAGE = 200;

export function norm(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t.length > 0 ? t : null;
}
export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface SourceRow {
  model_date: string;
  population_id: string;
  condition_id: string;
  selected_token_id: string;
  decision_at: string;
  provider_event_id: string | null;
  sport_family: string | null;
  settlement_label: string | null;
  entry_price_num: number | null;
  canonical_row: Record<string, unknown>;
}

export type SportBasis =
  | "SPORT_EXPLICIT"
  | "SPORT_CONFLICT"
  | "SPORT_RECOVERED_PROVIDER_CODE"
  | "SPORT_RECOVERED_MARKET_TYPE"
  | "SPORT_RECOVERED_CODE_AND_MARKET"
  | "SPORT_UNRESOLVED";

export type MarketTypeSource =
  | "MARKET_TYPE_CANONICAL"
  | "MARKET_TYPE_GSP_DIAGNOSTICS"
  | "MARKET_TYPE_UNRESOLVED";

export interface OverlayRecord {
  model_date: string;
  population_id: string;
  provider_event_id: string | null;
  condition_id: string;
  selected_token_id: string;
  decision_at: string;

  source_sport_family: string | null;
  reconciled_sport_family: string | null;
  sport_reconciliation_basis: SportBasis;

  provider_sport_code: string | null;

  source_market_type: string | null;
  reconciled_market_type: string | null;
  market_type_source: MarketTypeSource;

  display_odds_available: boolean;
  settlement_available: boolean;
  lead_time_available: boolean;
  score_level_available: boolean;
  data_coverage_available: boolean;
  volume_available: boolean;
}

/** Rule 1: explicit sport from `sport_family` / `canonical_row.sportFamily` / `canonical_row.providerSportFamily`. */
export function explicitSportFamily(row: SourceRow): { value: string | null; conflict: boolean } {
  const carriers = [row.sport_family, obj(row.canonical_row).sportFamily, obj(row.canonical_row).providerSportFamily]
    .map(norm)
    .filter((v): v is string => v !== null);
  const distinct = [...new Set(carriers)];
  if (distinct.length === 0) return { value: null, conflict: false };
  if (distinct.length === 1) return { value: distinct[0], conflict: false };
  return { value: null, conflict: true };
}

/**
 * Rule 2 support: a provider code may recover sport only when it maps to
 * exactly one explicit (non-conflicting) sport family across the whole
 * Aug04-Sep20 corpus. No hard-coded league/code dictionary.
 */
export function buildProviderCodeSportMap(rows: SourceRow[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const { value, conflict } = explicitSportFamily(row);
    if (conflict || value === null) continue;
    const code = norm(obj(row.canonical_row).providerSportCode);
    if (!code) continue;
    if (!map.has(code)) map.set(code, new Set());
    map.get(code)!.add(value);
  }
  return map;
}

export function uniqueCodeSport(map: Map<string, Set<string>>, code: string | null): string | "AMBIGUOUS" | null {
  if (!code) return null;
  const set = map.get(code);
  if (!set || set.size === 0) return null;
  if (set.size > 1) return "AMBIGUOUS";
  return [...set][0];
}

/** Rules 1-4: fail-closed sport reconciliation for one row. */
export function reconcileSport(
  row: SourceRow,
  codeMap: Map<string, Set<string>>,
): { source: string | null; reconciled: string | null; basis: SportBasis; providerSportCode: string | null } {
  const providerSportCode = norm(obj(row.canonical_row).providerSportCode);
  const explicit = explicitSportFamily(row);
  if (explicit.conflict) {
    return { source: null, reconciled: null, basis: "SPORT_CONFLICT", providerSportCode };
  }
  if (explicit.value !== null) {
    return { source: explicit.value, reconciled: explicit.value, basis: "SPORT_EXPLICIT", providerSportCode };
  }

  const codeSport = uniqueCodeSport(codeMap, providerSportCode);
  const marketType = norm(obj(row.canonical_row).marketTypeRaw);
  const marketEvidence = marketType !== null && marketType.startsWith("soccer_");
  // A uniquely-mapped NON-soccer code is a conflicting classification against
  // soccer_* market evidence — it must block market-based recovery too.
  const codeConflicting = codeSport !== null && codeSport !== "AMBIGUOUS" && codeSport !== "soccer";

  if (codeSport === "soccer" && marketEvidence) {
    return { source: null, reconciled: "soccer", basis: "SPORT_RECOVERED_CODE_AND_MARKET", providerSportCode };
  }
  if (codeSport === "soccer") {
    return { source: null, reconciled: "soccer", basis: "SPORT_RECOVERED_PROVIDER_CODE", providerSportCode };
  }
  if (!codeConflicting && marketEvidence) {
    return { source: null, reconciled: "soccer", basis: "SPORT_RECOVERED_MARKET_TYPE", providerSportCode };
  }
  return { source: null, reconciled: null, basis: "SPORT_UNRESOLVED", providerSportCode };
}

export interface GspMarketTypeEntry {
  id: string;
  condition_id: string;
  selected_token_id: string;
  created_at: string;
  market_type: string | null;
}

/** Market-type reconciliation: canonical_row.marketTypeRaw first, exact GSP fallback second. */
export function resolveMarketType(
  row: SourceRow,
  gspIndex: Map<string, GspMarketTypeEntry[]>,
): { source: string | null; reconciled: string | null; basis: MarketTypeSource } {
  const canonical = norm(obj(row.canonical_row).marketTypeRaw);
  if (canonical !== null) {
    return { source: canonical, reconciled: canonical, basis: "MARKET_TYPE_CANONICAL" };
  }
  const key = `${row.condition_id}::${row.selected_token_id}`;
  const entries = gspIndex.get(key) ?? [];
  let best: GspMarketTypeEntry | null = null;
  for (const e of entries) {
    if (e.created_at > row.decision_at) continue;
    if (!best || e.created_at > best.created_at || (e.created_at === best.created_at && e.id > best.id)) best = e;
  }
  const mt = best ? norm(best.market_type) : null;
  if (mt !== null) {
    return { source: mt, reconciled: mt, basis: "MARKET_TYPE_GSP_DIAGNOSTICS" };
  }
  return { source: null, reconciled: null, basis: "MARKET_TYPE_UNRESOLVED" };
}

export function buildOverlayRecord(
  row: SourceRow,
  codeMap: Map<string, Set<string>>,
  gspIndex: Map<string, GspMarketTypeEntry[]>,
): OverlayRecord {
  const sport = reconcileSport(row, codeMap);
  const market = resolveMarketType(row, gspIndex);
  const canonicalRow = row.canonical_row;
  return {
    model_date: row.model_date,
    population_id: row.population_id,
    provider_event_id: row.provider_event_id,
    condition_id: row.condition_id,
    selected_token_id: row.selected_token_id,
    decision_at: row.decision_at,

    source_sport_family: sport.source,
    reconciled_sport_family: sport.reconciled,
    sport_reconciliation_basis: sport.basis,

    provider_sport_code: sport.providerSportCode,

    source_market_type: market.source,
    reconciled_market_type: market.reconciled,
    market_type_source: market.basis,

    display_odds_available: row.entry_price_num !== null,
    settlement_available: row.settlement_label === "WIN" || row.settlement_label === "LOSS" || row.settlement_label === "VOID",
    lead_time_available: isFiniteNum(canonicalRow.leadTimeHours),
    score_level_available: isFiniteNum(canonicalRow.scoreLevel),
    data_coverage_available: isFiniteNum(canonicalRow.dataCoverage),
    volume_available: isFiniteNum(canonicalRow.volumeUsd),
  };
}

export function sortKey(r: { model_date: string; population_id: string; condition_id: string; selected_token_id: string; decision_at: string }): string {
  return [r.model_date, r.population_id, r.condition_id, r.selected_token_id, r.decision_at].join("|");
}

export function sortOverlay(rows: OverlayRecord[]): OverlayRecord[] {
  return [...rows].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

export function countDuplicateIdentities(rows: OverlayRecord[]): number {
  const seen = new Set<string>();
  let dup = 0;
  for (const r of rows) {
    const k = sortKey(r);
    if (seen.has(k)) dup++;
    else seen.add(k);
  }
  return dup;
}

// ── physical-event-scoped precedence classification ─────────────────────────
const SPORT_BUCKET_PRECEDENCE: SportBasis[] = [
  "SPORT_EXPLICIT",
  "SPORT_RECOVERED_CODE_AND_MARKET",
  "SPORT_RECOVERED_PROVIDER_CODE",
  "SPORT_RECOVERED_MARKET_TYPE",
];

export interface PeriodStats {
  source_row_n: number;
  unique_selection_n: number;
  unique_physical_event_n: number;

  explicit_soccer_physical_event_n: number;
  recovered_soccer_by_code_n: number;
  recovered_soccer_by_market_n: number;
  recovered_soccer_by_code_and_market_n: number;
  canonical_soccer_physical_event_n: number;
  sport_unresolved_physical_event_n: number;
  sport_conflict_physical_event_n: number;

  canonical_soccer_with_market_type_n: number;
  canonical_soccer_market_type_unresolved_n: number;

  canonical_soccer_moneyline_n: number;
  canonical_soccer_totals_n: number;
  canonical_soccer_spreads_n: number;

  lead_time_available_n: number;
  score_level_available_n: number;
  data_coverage_available_n: number;
  volume_available_n: number;
}

/**
 * Per-physical-event classification within one scope (a period or the full
 * combined range): if ANY row for a `provider_event_id` reaches a soccer
 * classification via explicit or recovered evidence, the event is counted
 * there (explicit wins over recovered; code+market over code-only over
 * market-only); only when no row for the event reaches any classification
 * does it fall to conflict/unresolved. Rows with no `provider_event_id` are
 * excluded from physical-event counts (RESEARCH_CORPUS_CONTRACT.md §2 —
 * never folded in via a condition_id fallback).
 */
export function buildPeriodStats(rows: OverlayRecord[]): PeriodStats {
  const selectionSet = new Set<string>();
  const eventRows = new Map<string, OverlayRecord[]>();
  for (const r of rows) {
    selectionSet.add(`${r.condition_id}::${r.selected_token_id}`);
    if (!r.provider_event_id) continue;
    if (!eventRows.has(r.provider_event_id)) eventRows.set(r.provider_event_id, []);
    eventRows.get(r.provider_event_id)!.push(r);
  }

  let explicitSoccer = 0;
  let recoveredByCode = 0;
  let recoveredByMarket = 0;
  let recoveredByCodeAndMarket = 0;
  let unresolved = 0;
  let conflict = 0;
  const canonicalSoccerEvents = new Map<string, OverlayRecord[]>();

  for (const [eventId, evRows] of eventRows) {
    let winningBasis: SportBasis | null = null;
    for (const basis of SPORT_BUCKET_PRECEDENCE) {
      if (evRows.some((r) => r.sport_reconciliation_basis === basis && r.reconciled_sport_family === "soccer")) {
        winningBasis = basis;
        break;
      }
    }
    if (winningBasis) {
      canonicalSoccerEvents.set(eventId, evRows);
      if (winningBasis === "SPORT_EXPLICIT") explicitSoccer++;
      else if (winningBasis === "SPORT_RECOVERED_CODE_AND_MARKET") recoveredByCodeAndMarket++;
      else if (winningBasis === "SPORT_RECOVERED_PROVIDER_CODE") recoveredByCode++;
      else if (winningBasis === "SPORT_RECOVERED_MARKET_TYPE") recoveredByMarket++;
      continue;
    }
    // No row confirms soccer for this event.
    const hasExplicitOtherSport = evRows.some(
      (r) => r.sport_reconciliation_basis === "SPORT_EXPLICIT" && r.reconciled_sport_family !== null && r.reconciled_sport_family !== "soccer",
    );
    if (hasExplicitOtherSport) continue; // out of scope for football buckets, not unresolved/conflict
    const hasConflict = evRows.some((r) => r.sport_reconciliation_basis === "SPORT_CONFLICT");
    if (hasConflict) conflict++;
    else unresolved++;
  }

  let withMarketType = 0;
  let marketTypeUnresolved = 0;
  let moneyline = 0;
  let totals = 0;
  let spreads = 0;
  for (const evRows of canonicalSoccerEvents.values()) {
    const hasMarketType = evRows.some((r) => r.reconciled_market_type !== null);
    if (hasMarketType) withMarketType++;
    else marketTypeUnresolved++;
    if (evRows.some((r) => r.reconciled_market_type === "moneyline")) moneyline++;
    if (evRows.some((r) => r.reconciled_market_type === "totals")) totals++;
    if (evRows.some((r) => r.reconciled_market_type === "spreads")) spreads++;
  }

  const uniquePhysicalEvents = eventRows.size;

  return {
    source_row_n: rows.length,
    unique_selection_n: selectionSet.size,
    unique_physical_event_n: uniquePhysicalEvents,

    explicit_soccer_physical_event_n: explicitSoccer,
    recovered_soccer_by_code_n: recoveredByCode,
    recovered_soccer_by_market_n: recoveredByMarket,
    recovered_soccer_by_code_and_market_n: recoveredByCodeAndMarket,
    canonical_soccer_physical_event_n: canonicalSoccerEvents.size,
    sport_unresolved_physical_event_n: unresolved,
    sport_conflict_physical_event_n: conflict,

    canonical_soccer_with_market_type_n: withMarketType,
    canonical_soccer_market_type_unresolved_n: marketTypeUnresolved,

    canonical_soccer_moneyline_n: moneyline,
    canonical_soccer_totals_n: totals,
    canonical_soccer_spreads_n: spreads,

    lead_time_available_n: rows.filter((r) => r.lead_time_available).length,
    score_level_available_n: rows.filter((r) => r.score_level_available).length,
    data_coverage_available_n: rows.filter((r) => r.data_coverage_available).length,
    volume_available_n: rows.filter((r) => r.volume_available).length,
  };
}

export function crossPeriodPhysicalEventCount(augRows: OverlayRecord[], sepRows: OverlayRecord[]): number {
  const augEvents = new Set(augRows.map((r) => r.provider_event_id).filter((v): v is string => !!v));
  const sepEvents = new Set(sepRows.map((r) => r.provider_event_id).filter((v): v is string => !!v));
  let n = 0;
  for (const e of augEvents) if (sepEvents.has(e)) n++;
  return n;
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

/**
 * Per-day paginated read: a single global ORDER BY across the whole
 * Aug04-Sep20 range times out (57014) at this row volume without a matching
 * composite index. Each `model_date` is a small, bounded slice, so the same
 * (population_id, condition_id, selected_token_id, decision_at) ordering
 * stays cheap per page; final cross-day determinism is restored by sorting
 * the fully-assembled in-memory set before writing the overlay.
 */
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
    const { data, error } = await db
      .from("generated_signal_pairs")
      .select("id,condition_id,selected_token_id,created_at,diagnostics")
      .in("condition_id", chunk);
    if (error) throw new Error(`RECON_GSP_READ:${error.code ?? error.message}`);
    for (const raw of data ?? []) {
      const r = obj(raw);
      const conditionId = String(r.condition_id ?? "");
      const selectedTokenId = String(r.selected_token_id ?? "");
      const key = `${conditionId}::${selectedTokenId}`;
      if (!keys.has(key)) continue;
      const d = obj(r.diagnostics);
      const entry: GspMarketTypeEntry = {
        id: String(r.id ?? ""),
        condition_id: conditionId,
        selected_token_id: selectedTokenId,
        created_at: String(r.created_at ?? ""),
        market_type: typeof d.marketType === "string" ? d.marketType : null,
      };
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push(entry);
    }
  }
  return index;
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

async function main() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("REQUIRED_CLONE_READ_AUTHORIZATION_UNAVAILABLE");
  if (projectRef(url) !== EXPECTED_CLONE_REF || (process.env.SUPABASE_URL && projectRef(process.env.SUPABASE_URL) === projectRef(url))) {
    throw new Error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH");
  }
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const sourceRows = await readAllSourceRows(db);
  const codeMap = buildProviderCodeSportMap(sourceRows);

  const needsGspFallback = new Set<string>();
  for (const row of sourceRows) {
    if (norm(obj(row.canonical_row).marketTypeRaw) === null) {
      needsGspFallback.add(`${row.condition_id}::${row.selected_token_id}`);
    }
  }
  const gspIndex = await readGspMarketTypeIndex(db, needsGspFallback);

  const overlay = sortOverlay(sourceRows.map((row) => buildOverlayRecord(row, codeMap, gspIndex)));
  const duplicateIdentities = countDuplicateIdentities(overlay);

  const augRows = overlay.filter((r) => r.model_date >= RANGE_START && r.model_date <= AUG_END);
  const sepRows = overlay.filter((r) => r.model_date >= SEP_START && r.model_date <= RANGE_END);
  const augStats = buildPeriodStats(augRows);
  const sepStats = buildPeriodStats(sepRows);
  const combinedStats = buildPeriodStats(overlay);
  const crossPeriod = crossPeriodPhysicalEventCount(augRows, sepRows);

  mkdirSync(OUT_DIR, { recursive: true });

  const jsonl = overlay.map(canonicalJsonLine).join("\n") + (overlay.length ? "\n" : "");
  const gz = gzipSync(Buffer.from(jsonl, "utf8"), { level: 9 });
  const overlayFile = `FOOTBALL_DENOMINATOR_OVERLAY_${RANGE_START}_${RANGE_END}.jsonl.gz`;
  writeFileSync(join(OUT_DIR, overlayFile), gz);
  const overlayContentSha256 = createHash("sha256").update(jsonl, "utf8").digest("hex");

  const manifest = {
    MISSION: "FOOTBALL_DENOMINATOR_RECONCILIATION_V1",
    SOURCE_RANGE: `${RANGE_START}..${RANGE_END}`,
    SOURCE_TABLE: "research_model_ready_rows",
    SECONDARY_SOURCE_TABLE: "generated_signal_pairs",
    CLONE_PROJECT_REF: EXPECTED_CLONE_REF,
    OVERLAY_ROW_N: overlay.length,
    OVERLAY_CONTENT_SHA256: overlayContentSha256,
    DUPLICATE_OVERLAY_IDENTITY_N: duplicateIdentities,
    CROSS_PERIOD_PHYSICAL_EVENT_N: crossPeriod,
    AUG: { RANGE: `${RANGE_START}..${AUG_END}`, ...augStats },
    SEP: { RANGE: `${SEP_START}..${RANGE_END}`, ...sepStats },
    COMBINED: { RANGE: `${RANGE_START}..${RANGE_END}`, ...combinedStats },
    IMMUTABLE_SOURCE_CORPUS_UNCHANGED: true,
    PRODUCTION_WRITES: 0,
    CLONE_DB_WRITES: 0,
    NO_MODEL_RANKING_PERFORMED: true,
    NO_EXECUTION_ECONOMICS_CLAIM: true,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(OUT_DIR, `MANIFEST_${RANGE_START}_${RANGE_END}.json`), manifestJson);

  const findings = `# Football Denominator Reconciliation — ${RANGE_START} .. ${RANGE_END}

Status: **DENOMINATOR / CLASSIFICATION AUTHORITY ONLY**

## Source range

Read-only overlay over \`research_model_ready_rows\` (research clone \`${EXPECTED_CLONE_REF}\`) for \`${RANGE_START}\` through \`${RANGE_END}\`, split into August (\`${RANGE_START}..${AUG_END}\`) and September (\`${SEP_START}..${RANGE_END}\`).

## Physical events

- August unique physical events: **${augStats.unique_physical_event_n}**
- September unique physical events: **${sepStats.unique_physical_event_n}**
- Combined unique physical events (deduplicated, not summed): **${combinedStats.unique_physical_event_n}**
- Physical events present in both periods (not double-counted in COMBINED): **${crossPeriod}**

## Football (soccer) classification

- Explicit soccer (explicit carrier, unambiguous): August ${augStats.explicit_soccer_physical_event_n}, September ${sepStats.explicit_soccer_physical_event_n}, combined ${combinedStats.explicit_soccer_physical_event_n}
- Safely recovered soccer (unique provider code and/or \`soccer_*\` structured market type — never title/slug/odds/result inference): August ${augStats.recovered_soccer_by_code_n + augStats.recovered_soccer_by_market_n + augStats.recovered_soccer_by_code_and_market_n}, September ${sepStats.recovered_soccer_by_code_n + sepStats.recovered_soccer_by_market_n + sepStats.recovered_soccer_by_code_and_market_n}, combined ${combinedStats.recovered_soccer_by_code_n + combinedStats.recovered_soccer_by_market_n + combinedStats.recovered_soccer_by_code_and_market_n}
- Canonical soccer denominator (explicit + all recovered paths): August ${augStats.canonical_soccer_physical_event_n}, September ${sepStats.canonical_soccer_physical_event_n}, combined ${combinedStats.canonical_soccer_physical_event_n}
- Unresolved sport (no explicit or safe-recovery evidence): August ${augStats.sport_unresolved_physical_event_n}, September ${sepStats.sport_unresolved_physical_event_n}, combined ${combinedStats.sport_unresolved_physical_event_n}
- Explicit sport conflict (disagreeing explicit carriers, fails closed to unresolved): August ${augStats.sport_conflict_physical_event_n}, September ${sepStats.sport_conflict_physical_event_n}, combined ${combinedStats.sport_conflict_physical_event_n}

## Football market-type coverage

Within the canonical soccer denominator (combined scope):

- With a resolved market type: ${combinedStats.canonical_soccer_with_market_type_n}
- Market type unresolved: ${combinedStats.canonical_soccer_market_type_unresolved_n}
- Moneyline: ${combinedStats.canonical_soccer_moneyline_n}
- Totals: ${combinedStats.canonical_soccer_totals_n}
- Spreads: ${combinedStats.canonical_soccer_spreads_n}

(A single physical event may carry more than one structured market and therefore appear in more than one bucket above; each bucket is independently counted, never mutually exclusive.)

## Optional feature availability (never shrinks the football denominator)

Row-level counts across the combined range: lead time available ${combinedStats.lead_time_available_n}/${combinedStats.source_row_n}, score level available ${combinedStats.score_level_available_n}/${combinedStats.source_row_n}, data coverage available ${combinedStats.data_coverage_available_n}/${combinedStats.source_row_n}, volume available ${combinedStats.volume_available_n}/${combinedStats.source_row_n}.

A football signal with a known market and settlement/display-odds evidence remains in the denominator even when score level, volume, timing, or coverage are missing — these are descriptive-only flags, never exclusion criteria.

## Scope and non-claims

This artifact defines **denominator and sport/market classification authority only**, sourced from the immutable, already-accepted model-ready corpus plus an exact (never fuzzy) \`generated_signal_pairs\` market-type fallback.

- \`NO_MODEL_RANKING_PERFORMED\`
- \`NO_EXECUTION_ECONOMICS_CLAIM\`
- \`IMMUTABLE_SOURCE_CORPUS_UNCHANGED\`

No hypothesis was tested, no ROI or leaderboard was computed, and the immutable August/September corpus and \`research_model_ready_rows\`/\`research_model_ready_days\` tables were not modified — this is a read-only sidecar overlay.
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
    DUPLICATE_OVERLAY_IDENTITY_N: duplicateIdentities,
    AUG: augStats,
    SEP: sepStats,
    COMBINED: combinedStats,
    CROSS_PERIOD_PHYSICAL_EVENT_N: crossPeriod,
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
