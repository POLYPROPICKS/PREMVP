import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";
import { pathToFileURL } from "node:url";

import { replayDynamicHarvest, type DynamicExecutionCandidate } from "@/lib/modeling/dynamicAwareVault";
import { buildPrincipalRecoveryStageA } from "@/lib/modeling/dynamicPrincipalRecoveryVault";
import { stableHash } from "@/lib/modeling/scientificCapitalArchitecture";
import { resolveSignalOutcome, type GammaMarket } from "@/lib/feed/resolveSignalOutcome";
import { syncResearchEvidencePage } from "../research-clone-daily-sync";
import {
  CAP,
  MODEL_IDS,
  readV4DateRows,
  selectedByModel,
  type LedgerRow,
  type V4EvidenceRow,
} from "./prospective-selection-shadow";

const PRODUCTION_REF = "nbnldzfsxffztsfrrxqy";
const CLONE_REF = "nppznoujvnyjargjkmnv";
const RUNTIME_TABLE = "prospective_selection_shadow_runtime";
const MAX_SETTLEMENT_CONDITIONS_PER_CYCLE = 200;
const GAMMA_BATCH_N = 40;
const MODEL_SET = new Set<string>(MODEL_IDS);

type RuntimeLedgerRow = LedgerRow & {
  row_key: string;
  row_kind: "LEDGER";
  model_id: (typeof MODEL_IDS)[number];
  decision_date: string;
  condition_id: string | null;
  selected_token_id: string | null;
  pre_event_score: number;
  data_coverage: number;
  settlement_checked_at: string | null;
};

type GammaBatchResult = {
  markets: Map<string, GammaMarket>;
  respondedConditionIds: Set<string>;
  complete: boolean;
};

export function deriveRequiredSelectionDates(today: string, lastProcessedDate: string | null): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("INVALID_MINSK_DATE");
  if (lastProcessedDate && lastProcessedDate > today) throw new Error("MINSK_DATE_REGRESSION");
  const start = lastProcessedDate ? (lastProcessedDate === today ? today : addDays(lastProcessedDate, 1)) : addDays(today, -1);
  const dates: string[] = [];
  for (let day = start; day <= today; day = addDays(day, 1)) dates.push(day);
  return dates;
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function minskDateNow(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function projectRef(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

function resolveClients() {
  const sourceUrl = process.env.SUPABASE_URL;
  const sourceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cloneUrl = process.env.SUPABASE_CLONE_URL;
  const cloneKey = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!sourceUrl || !sourceKey || !cloneUrl || !cloneKey) throw new Error("MISSING_RESEARCH_SHADOW_CREDENTIALS");
  if (projectRef(sourceUrl) !== PRODUCTION_REF || projectRef(cloneUrl) !== CLONE_REF || sourceUrl === cloneUrl) {
    throw new Error("REFUSING_NON_PRODUCTION_OR_NON_CLONE_TARGET");
  }
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  return {
    source: createClient(sourceUrl, sourceKey, options),
    clone: createClient(cloneUrl, cloneKey, options),
  };
}

const LEDGER_PROJECTION = "row_key,row_kind,model_id,decision_date,candidate_identity,physical_event_key,decision_timestamp,event_start,entry_price,sport_family,condition_id,selected_token_id,pre_event_score,data_coverage,settlement_state,settlement_checked_at,settled_at,result";

async function readRuntimeSnapshot(db: SupabaseClient): Promise<Record<string, any> | null> {
  const { data, error } = await db.from(RUNTIME_TABLE)
    .select("snapshot_payload")
    .eq("row_key", "CURRENT")
    .eq("row_kind", "SNAPSHOT")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`SHADOW_SNAPSHOT_READ:${error.code ?? "FAILED"}`);
  return data?.snapshot_payload && typeof data.snapshot_payload === "object" ? data.snapshot_payload as Record<string, any> : null;
}

async function readAllLedger(db: SupabaseClient): Promise<RuntimeLedgerRow[]> {
  const all: RuntimeLedgerRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(RUNTIME_TABLE)
      .select(LEDGER_PROJECTION)
      .eq("row_kind", "LEDGER")
      .order("decision_timestamp", { ascending: true })
      .order("row_key", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`SHADOW_LEDGER_READ:${error.code ?? "FAILED"}`);
    const page = (data ?? []) as any[];
    all.push(...page.map(fromDatabaseLedger));
    if (page.length < 1000) break;
  }
  return all;
}

function identityFor(row: V4EvidenceRow): string {
  return `${row.condition_id}::${row.selected_token_id}::${row.observed_at}`;
}

function runtimeRow(model: (typeof MODEL_IDS)[number], date: string, candidate: any, source: V4EvidenceRow, metadata: { scoreLevel: number; dataCoverage: number }): RuntimeLedgerRow {
  return {
    row_key: `LEDGER:${model}:${candidate.candidateIdentity}`,
    row_kind: "LEDGER",
    model,
    model_id: model,
    date,
    candidateIdentity: candidate.candidateIdentity,
    physicalEventKey: candidate.physicalEventKey,
    decisionTimestamp: candidate.decisionTimestamp,
    eventStart: candidate.eventStart,
    entryPrice: candidate.entryPrice,
    sportFamily: candidate.sportFamily,
    condition_id: source.condition_id,
    selected_token_id: source.selected_token_id,
    pre_event_score: metadata.scoreLevel,
    data_coverage: metadata.dataCoverage,
    settlementState: "UNQUERIED",
    settlement_checked_at: null,
    decision_date: date,
    settledAt: null,
    result: null,
  };
}

function fromDatabaseLedger(row: any): RuntimeLedgerRow {
  return {
    ...row,
    model: row.model_id,
    date: String(row.decision_date),
    candidateIdentity: String(row.candidate_identity),
    physicalEventKey: String(row.physical_event_key),
    decisionTimestamp: String(row.decision_timestamp),
    eventStart: String(row.event_start),
    entryPrice: Number(row.entry_price),
    sportFamily: String(row.sport_family ?? "other"),
    condition_id: row.condition_id ?? null,
    selected_token_id: row.selected_token_id ?? null,
    pre_event_score: Number(row.pre_event_score ?? 0),
    data_coverage: Number(row.data_coverage ?? 0),
    settlementState: row.settlement_state,
    settlement_checked_at: row.settlement_checked_at ?? null,
    settledAt: row.settled_at ?? null,
    result: row.result ?? null,
  };
}

function toDatabaseLedger(row: RuntimeLedgerRow): Record<string, unknown> {
  return {
    row_key: row.row_key,
    row_kind: "LEDGER",
    model_id: row.model_id,
    decision_date: row.decision_date,
    candidate_identity: row.candidateIdentity,
    physical_event_key: row.physicalEventKey,
    decision_timestamp: row.decisionTimestamp,
    event_start: row.eventStart,
    entry_price: row.entryPrice,
    sport_family: row.sportFamily,
    condition_id: row.condition_id,
    selected_token_id: row.selected_token_id,
    pre_event_score: row.pre_event_score,
    data_coverage: row.data_coverage,
    settlement_state: row.settlementState,
    settlement_checked_at: row.settlement_checked_at,
    settled_at: row.settledAt,
    result: row.result,
    updated_at: new Date().toISOString(),
  };
}

export async function persistRuntimeSnapshot(db: SupabaseClient, snapshot: Record<string, unknown>, now: string): Promise<void> {
  const { error } = await db.from(RUNTIME_TABLE).upsert({
    row_key: "CURRENT",
    row_kind: "SNAPSHOT",
    snapshot_payload: snapshot,
    updated_at: now,
  }, { onConflict: "row_key" });
  if (error) throw new Error(`SHADOW_SNAPSHOT_WRITE:${error.code ?? "FAILED"}`);
}

function upsertRows(db: SupabaseClient, rows: readonly Record<string, unknown>[]): Promise<void> {
  return (async () => {
    for (let from = 0; from < rows.length; from += 500) {
      const { error } = await db.from(RUNTIME_TABLE).upsert(rows.slice(from, from + 500), { onConflict: "row_key" });
      if (error) throw new Error(`SHADOW_LEDGER_WRITE:${error.code ?? "FAILED"}`);
    }
  })();
}

async function fetchGammaBatch(conditionIds: readonly string[]): Promise<GammaBatchResult> {
  const markets = new Map<string, GammaMarket>();
  const respondedConditionIds = new Set<string>();
  let complete = true;
  for (let from = 0; from < conditionIds.length; from += GAMMA_BATCH_N) {
    const batch = conditionIds.slice(from, from + GAMMA_BATCH_N);
    const params = new URLSearchParams();
    for (const conditionId of batch) params.append("condition_ids", conditionId);
    params.set("closed", "true");
    params.set("limit", String(batch.length));
    try {
      const response = await fetch(`https://gamma-api.polymarket.com/markets?${params.toString()}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) { complete = false; continue; }
      const body = await response.json() as unknown;
      const rows = Array.isArray(body) ? body : [];
      for (const conditionId of batch) respondedConditionIds.add(conditionId);
      for (const item of rows) {
        const market = item as GammaMarket;
        if (typeof market.conditionId === "string") markets.set(market.conditionId.toLowerCase(), market);
      }
    } catch {
      complete = false;
    }
  }
  return { markets, respondedConditionIds, complete };
}

export async function resolveSelectedUnresolved(
  ledger: readonly RuntimeLedgerRow[],
  fetchMarkets: (conditionIds: readonly string[]) => Promise<GammaBatchResult> = fetchGammaBatch,
  now = new Date().toISOString(),
): Promise<{ updatedRows: RuntimeLedgerRow[]; complete: boolean; queriedConditionN: number }> {
  const open = ledger.filter((row) => row.row_kind === "LEDGER" && row.settlementState === "UNQUERIED" && typeof row.condition_id === "string" && row.condition_id.length > 0);
  const byCondition = new Map<string, RuntimeLedgerRow[]>();
  for (const row of open) {
    const key = row.condition_id!.toLowerCase();
    const rows = byCondition.get(key) ?? [];
    rows.push(row);
    byCondition.set(key, rows);
  }
  const orderedConditions = [...byCondition.keys()].sort((a, b) => {
    const aChecked = Math.min(...byCondition.get(a)!.map((row) => row.settlement_checked_at ? Date.parse(row.settlement_checked_at) : 0));
    const bChecked = Math.min(...byCondition.get(b)!.map((row) => row.settlement_checked_at ? Date.parse(row.settlement_checked_at) : 0));
    return aChecked - bChecked || a.localeCompare(b);
  }).slice(0, MAX_SETTLEMENT_CONDITIONS_PER_CYCLE);
  if (orderedConditions.length === 0) return { updatedRows: [], complete: true, queriedConditionN: 0 };
  const batch = await fetchMarkets(orderedConditions);
  const updatedRows: RuntimeLedgerRow[] = [];
  for (const conditionId of orderedConditions) {
    if (!batch.respondedConditionIds.has(conditionId)) continue;
    const market = batch.markets.get(conditionId) ?? null;
    for (const row of byCondition.get(conditionId)!) {
      const outcome = resolveSignalOutcome({
        conditionId: row.condition_id!,
        selectedTokenId: row.selected_token_id,
        entryPriceNum: row.entryPrice,
        market,
      });
      const result = outcome.resolverState === "resolved_candidate" ? outcome.signalResult : null;
      updatedRows.push({
        ...row,
        settlement_checked_at: now,
        settlementState: result === "won" ? "WIN" : result === "lost" ? "LOSS" : "UNQUERIED",
        result: result === "won" ? "WIN" : result === "lost" ? "LOSS" : null,
        settledAt: result ? now : null,
      });
    }
  }
  return {
    updatedRows,
    complete: batch.complete && orderedConditions.length === byCondition.size && updatedRows.length > 0,
    queriedConditionN: batch.respondedConditionIds.size,
  };
}

function capitalCandidate(row: RuntimeLedgerRow): DynamicExecutionCandidate {
  const base = {
    observationId: row.candidateIdentity,
    decisionAtIso: row.decisionTimestamp,
    finalScore: row.pre_event_score,
    dataCoverage: row.data_coverage,
    entryPrice: row.entryPrice,
  };
  if (row.settlementState === "UNQUERIED") return { ...base, settlementState: "UNQUERIED" };
  if (!row.settledAt || !row.result) throw new Error("TERMINAL_SETTLEMENT_MISSING_FIELDS");
  return {
    ...base,
    resolvedAtIso: row.settledAt,
    row: { signal_result: row.result === "WIN" ? "won" : "lost" },
  };
}

function usd(units: number): number {
  return Math.round((units * 2 + Number.EPSILON) * 100) / 100;
}

function replayCapital(rows: readonly RuntimeLedgerRow[], now: string) {
  const protectedPolicy = buildPrincipalRecoveryStageA().find((policy) => policy.id === "PRV2_T25_P50_R1_S0.05_C0.1");
  if (!protectedPolicy) throw new Error("PRV2_POLICY_MISSING");
  const fixedPolicy = { family: "NO_VAULT" as const, id: "DYNAMIC_NO_VAULT" as const };
  return new Map(MODEL_IDS.map((model) => {
    const candidates = rows.filter((row) => row.model_id === model).map(capitalCandidate);
    const fixed = replayDynamicHarvest(candidates, fixedPolicy, {
      finalizationMode: "KEEP_OPEN_AT_CUTOFF", cutoffAtIso: now, stakeMode: "FIXED_1U",
    });
    const protectedReplay = replayDynamicHarvest(candidates, protectedPolicy, {
      finalizationMode: "KEEP_OPEN_AT_CUTOFF", cutoffAtIso: now, stakeMode: "DYNAMIC_ACTIVE_3PCT",
    });
    return [model, { fixed, protected: protectedReplay }];
  }));
}

function selectionMetrics(rows: readonly RuntimeLedgerRow[], date: string, model: (typeof MODEL_IDS)[number], replays: ReturnType<typeof replayCapital> extends Map<any, infer V> ? V : never) {
  const current = rows.filter((row) => row.model_id === model && row.decision_date === date);
  const fixedLedger = replays.fixed.ledger;
  const protectedLedger = replays.protected.ledger;
  const rowByIdentity = (ledger: typeof fixedLedger) => new Map(ledger.map((entry) => [entry.observationId, entry]));
  const fixedById = rowByIdentity(fixedLedger);
  const protectedById = rowByIdentity(protectedLedger);
  const n = (sport: string) => current.filter((row) => row.sportFamily.toLowerCase() === sport).length;
  const fixedSkips = current.filter((row) => (fixedById.get(row.candidateIdentity)?.stake ?? 0) <= 0).length;
  const protectedSkips = current.filter((row) => (protectedById.get(row.candidateIdentity)?.stake ?? 0) <= 0).length;
  return {
    model,
    date,
    selectedToday: current.length,
    football: current.filter((row) => ["soccer", "football"].includes(row.sportFamily.toLowerCase())).length,
    tennis: n("tennis"),
    other: current.length - current.filter((row) => ["soccer", "football", "tennis"].includes(row.sportFamily.toLowerCase())).length,
    settled: current.filter((row) => row.settlementState === "WIN" || row.settlementState === "LOSS").length,
    unqueried: current.filter((row) => row.settlementState === "UNQUERIED").length,
    wins: current.filter((row) => row.settlementState === "WIN").length,
    losses: current.filter((row) => row.settlementState === "LOSS").length,
    fixed: {
      freeUsd: usd(replays.fixed.endingFreeActive),
      lockedUsd: usd(replays.fixed.endingOpenPrincipal),
      realizedPnlUsd: usd(replays.fixed.pnl),
      totalUsd: usd(replays.fixed.endingTotal),
      capitalSkips: fixedSkips,
    },
    protected: {
      freeUsd: usd(replays.protected.endingFreeActive),
      lockedUsd: usd(replays.protected.endingOpenPrincipal),
      vaultUsd: usd(replays.protected.endingVault),
      realizedPnlUsd: usd(replays.protected.pnl),
      totalUsd: usd(replays.protected.endingTotal),
      capitalSkips: protectedSkips,
    },
  };
}

async function main(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const today = minskDateNow(now);
  const { source, clone } = resolveClients();
  const priorSnapshot = await readRuntimeSnapshot(clone);
  const dates = deriveRequiredSelectionDates(today, typeof priorSnapshot?.processedThroughDate === "string" ? priorSnapshot.processedThroughDate : null);
  const bootstrapDate = dates[0] ?? today;
  const bootstrapSince = new Date(Date.parse(`${bootstrapDate}T00:00:00.000Z`) - 3 * 60 * 60_000).toISOString();

  // The exact V4-only transport reuses the durable research cursor and never runs the broad daily sync.
  const sync = await syncResearchEvidencePage(clone, source, bootstrapSince);
  if (sync.APPEND_PENDING) throw new Error("V4_EVIDENCE_SYNC_PENDING");

  let ledger = await readAllLedger(clone);
  const existing = new Set(ledger.map((row) => row.row_key));
  const additions: RuntimeLedgerRow[] = [];
  const selectionSummaries: Record<string, Array<{ model: string; selected: number; football: number; tennis: number; other: number }>> = {};
  for (const date of dates) {
    const evidenceRows = await readV4DateRows(clone, date);
    const { capped, metadata } = selectedByModel(evidenceRows, date);
    const byIdentity = new Map(evidenceRows.map((row) => [identityFor(row), row]));
    selectionSummaries[date] = [];
    for (const model of MODEL_IDS) {
      const priorCount = ledger.filter((row) => row.model_id === model && row.decision_date === date).length;
      if (priorCount > CAP) throw new Error(`PERSISTED_CAP_EXCEEDED:${date}:${model}`);
      const chosen = capped.get(model) ?? [];
      const newCandidates = chosen.filter((candidate) => !existing.has(`LEDGER:${model}:${candidate.candidateIdentity}`)).slice(0, CAP - priorCount);
      for (const candidate of newCandidates) {
        const sourceRow = byIdentity.get(candidate.candidateIdentity);
        const feature = metadata.get(candidate.candidateIdentity);
        if (!sourceRow || !feature) throw new Error("SELECTED_SOURCE_IDENTITY_MISSING");
        const row = runtimeRow(model, date, candidate, sourceRow, feature);
        additions.push(row);
        existing.add(row.row_key);
      }
      const currentRows = [...ledger, ...additions].filter((row) => row.model_id === model && row.decision_date === date);
      if (currentRows.length > CAP) throw new Error(`CAP30_EXCEEDED:${date}:${model}`);
      const football = currentRows.filter((row) => ["football", "soccer"].includes(row.sportFamily.toLowerCase())).length;
      const tennis = currentRows.filter((row) => row.sportFamily.toLowerCase() === "tennis").length;
      selectionSummaries[date].push({ model, selected: currentRows.length, football, tennis, other: currentRows.length - football - tennis });
    }
  }
  await upsertRows(clone, additions.map(toDatabaseLedger));
  ledger = [...ledger, ...additions];

  const settlement = await resolveSelectedUnresolved(ledger);
  await upsertRows(clone, settlement.updatedRows.map(toDatabaseLedger));
  if (settlement.updatedRows.length) {
    const updates = new Map(settlement.updatedRows.map((row) => [row.row_key, row]));
    ledger = ledger.map((row) => updates.get(row.row_key) ?? row);
  }

  const replays = replayCapital(ledger, nowIso);
  const todaySelection = MODEL_IDS.map((model) => selectionMetrics(ledger, today, model, replays.get(model)!));
  const byDate = Object.fromEntries([...new Set(ledger.map((row) => row.decision_date))].sort().map((date) => [date, stableHash(
    ledger.filter((row) => row.decision_date === date).map((row) => ({
      row_key: row.row_key,
      model: row.model_id,
      candidateIdentity: row.candidateIdentity,
      physicalEventKey: row.physicalEventKey,
      decisionTimestamp: row.decisionTimestamp,
      eventStart: row.eventStart,
      entryPrice: row.entryPrice,
      sportFamily: row.sportFamily,
    })).sort((a, b) => a.model.localeCompare(b.model) || a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey) || a.candidateIdentity.localeCompare(b.candidateIdentity)),
  )]));
  const settlementFreshThrough = settlement.complete ? nowIso : (priorSnapshot?.freshness?.settlementFreshThrough ?? null);
  const snapshot = {
    status: "OK",
    mission: "LIVE_MODELING_DASHBOARD_PRODUCTION_V1",
    lastSuccessfulRefresh: nowIso,
    generatedAt: nowIso,
    freshness: {
      selectionFreshThrough: today,
      settlementFreshThrough,
      pnlFreshThrough: settlementFreshThrough,
    },
    processedThroughDate: today,
    selectionHashes: byDate,
    selectionSummaries,
    settlement: {
      queriedConditionN: settlement.queriedConditionN,
      providerBatchComplete: settlement.complete,
      stateCounts: {
        unqueried: ledger.filter((row) => row.settlementState === "UNQUERIED").length,
        wins: ledger.filter((row) => row.settlementState === "WIN").length,
        losses: ledger.filter((row) => row.settlementState === "LOSS").length,
      },
    },
    models: todaySelection,
  };
  await persistRuntimeSnapshot(clone, snapshot, nowIso);

  console.log(JSON.stringify({
    LIVE_SHADOW_CYCLE: "SUCCESS",
    currentMinskDate: today,
    selectionFreshThrough: snapshot.freshness.selectionFreshThrough,
    settlementFreshThrough: snapshot.freshness.settlementFreshThrough,
    pnlFreshThrough: snapshot.freshness.pnlFreshThrough,
    selectedToday: todaySelection.map(({ model, selectedToday, settled, unqueried, wins, losses }) => ({ model, selectedToday, settled, unqueried, wins, losses })),
    selectedLedgerRowN: ledger.length,
    settlementConditionsQueried: settlement.queriedConditionN,
    gammaCallsWereSelectedOnly: true,
    productionMoneyWrites: 0,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ LIVE_SHADOW_CYCLE: "FAILED", reason: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}
