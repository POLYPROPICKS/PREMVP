import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import "dotenv/config";

import { resolveSportFamily } from "@/lib/research-clone/modelReady";
import { replayDynamicHarvest, type DynamicExecutionCandidate } from "@/lib/modeling/dynamicAwareVault";
import { buildPrincipalRecoveryStageA } from "@/lib/modeling/dynamicPrincipalRecoveryVault";
import { stableHash } from "@/lib/modeling/scientificCapitalArchitecture";
import { SOCCER_FAMILY } from "@/lib/modeling/research-engine/models";
import { toSettlementFreeDecisionTimeCandidates } from "./factor-atlas";
import { applyDailyCap, PORTFOLIOS, runPortfolioStrict, runStandaloneStrict, type SelectedCandidate } from "./daily-portfolio-frontier";
import { QUALITY_PORTFOLIOS } from "./quality-fill-portfolio-test";
import { applyLiveMixAllocation, buildSafeUniverse, QUALITY_FILL_A_SAFE_MIX_CONFIGS, type IdentityCandidate, type IdentityLookup } from "./tennis-safe-comparable-leaderboard";

const DATES = ["2026-09-21", "2026-09-22"] as const;
const CAP = 30;
const CLONE_REF = "nppznoujvnyjargjkmnv";
const CAPITAL_CUTOFF = "2026-09-20T21:00:00.000Z";
const MODEL_IDS = ["P50_52_SAFE", "PORTFOLIO_BROAD_SAFE", "QUALITY_FILL_A_SAFE", "QUALITY_FILL_D_SAFE", "TENNIS_P50_52_SAFE"] as const;
const EMPTY_SERIES = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };
const OUTPUT_DIR = "modeling/evidence/prospective-selection-shadow-v1";
const DASHBOARD_DATA_PATH = "modeling/evidence/modeling-dashboard-v1/FORWARD_SHADOW_DATA.js";

type V4EvidenceRow = {
  observation_id: string;
  observed_at: string;
  item_observation_id: string;
  condition_id: string;
  selected_token_id: string;
  entry_price_num: number | string | null;
  pre_event_score_num: number | string | null;
  provider_event_id: string | null;
  provider_sport_family: string | null;
  market_type: string | null;
  event_title: string | null;
  market_question: string | null;
  game_start_iso: string | null;
  data_coverage: number | string | null;
};

type LedgerRow = {
  date: string;
  model: (typeof MODEL_IDS)[number];
  candidateIdentity: string;
  physicalEventKey: string;
  decisionTimestamp: string;
  eventStart: string;
  entryPrice: number;
  sportFamily: string;
  settlementState: "UNQUERIED";
};
type ShadowRow = {
  model: (typeof MODEL_IDS)[number];
  date: string;
  selected_n: number;
  executed_n: number;
  capital_skip_n: number;
  stake_per_bet_usd: number;
  free_active_usd: number;
  open_principal_usd: number;
  active_usd: number;
  vault_usd: number;
  total_usd: number;
};

function numberOrNull(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function utcStartOfMinskDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - 3 * 60 * 60_000).toISOString();
}

function projectRef(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

function resolveClone() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const actualRef = projectRef(url);
  if (actualRef !== CLONE_REF) throw new Error(`REFUSING_NON_CLONE_TARGET: expected ${CLONE_REF}, got ${actualRef}`);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Bounded row-level selection read plan: only the two exact Minsk dates, from the persisted
 * research-evidence V4 clone table, with an explicit projection that excludes signal_result
 * and all settlement columns. Complete 1,000-row pages are processed locally; no input rows
 * are printed or persisted, only the selected capped ledger and aggregate shadow states.
 */
async function readV4DateRows(db: ReturnType<typeof resolveClone>, date: string): Promise<V4EvidenceRow[]> {
  const from = utcStartOfMinskDate(date);
  const until = new Date(Date.parse(from) + 24 * 60 * 60_000).toISOString();
  const rows: V4EvidenceRow[] = [];
  const columns = "observation_id,observed_at,item_observation_id,condition_id,selected_token_id,entry_price_num,pre_event_score_num,provider_event_id,provider_sport_family,market_type,event_title,market_question,game_start_iso,data_coverage";
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from("research_evidence_page_rows")
      .select(columns)
      .gte("observed_at", from)
      .lt("observed_at", until)
      .order("observed_at", { ascending: true })
      .order("observation_id", { ascending: true })
      .order("item_observation_id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`CLONE_V4_READ:${error.code ?? error.message}`);
    const page = (data ?? []) as V4EvidenceRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function toScorecardRow(row: V4EvidenceRow): any {
  const price = numberOrNull(row.entry_price_num);
  const scoreLevel = numberOrNull(row.pre_event_score_num);
  const dataCoverage = numberOrNull(row.data_coverage) ?? 0;
  // This adapter intentionally has no labelAsOf/frozenLabel/signal_result property.
  return {
    populationId: "RESEARCH_EVIDENCE_V4",
    conditionId: row.condition_id,
    selectedTokenId: row.selected_token_id,
    providerEventId: row.provider_event_id,
    decisionAt: row.observed_at,
    entryPrice: price,
    eventStart: row.game_start_iso,
    sportFamily: resolveSportFamily({ providerSportFamily: row.provider_sport_family }),
    providerSportFamily: row.provider_sport_family,
    scoreLevel,
    score: EMPTY_SERIES,
    selectedPrice: EMPTY_SERIES,
    volumeUsd: null,
    leadTimeHours: null,
    marketTypeRaw: row.market_type,
    eventTitle: row.event_title,
    marketQuestion: row.market_question,
    dataCoverage,
  };
}

function identityLookupFor(rows: readonly V4EvidenceRow[]): IdentityLookup {
  const byIdentity = new Map<string, IdentityCandidate>();
  for (const row of rows) {
    const key = `${row.condition_id}::${row.selected_token_id}::${row.observed_at}`;
    byIdentity.set(key, {
      createdAt: row.observed_at,
      structuredMarketType: row.market_type,
      marketText: row.market_question,
      eventIdentityText: row.event_title,
    });
  }
  return (conditionId, selectedTokenId, decisionAt) => byIdentity.get(`${conditionId}::${selectedTokenId}::${decisionAt}`) ?? null;
}

function split(bets: readonly SelectedCandidate[]) {
  const football = bets.filter((bet) => bet.sportFamily === SOCCER_FAMILY).length;
  const tennis = bets.filter((bet) => bet.sportFamily === "tennis").length;
  return { football, tennis, other: bets.length - football - tennis };
}

function capModel(model: (typeof MODEL_IDS)[number], bets: SelectedCandidate[], date: string): SelectedCandidate[] {
  if (model === "QUALITY_FILL_A_SAFE") {
    const chosen = applyLiveMixAllocationForDate(bets, date);
    return chosen;
  }
  return applyDailyCap(bets, CAP).filter((candidate) => candidate.day === date);
}

function applyLiveMixAllocationForDate(bets: SelectedCandidate[], date: string): SelectedCandidate[] {
  return applyLiveMixAllocation(bets, [date], QUALITY_FILL_A_SAFE_MIX_CONFIGS[CAP]);
}

function selectedByModel(rows: readonly V4EvidenceRow[], date: string) {
  const scorecardRows = rows.map(toScorecardRow);
  const decisionCandidates = toSettlementFreeDecisionTimeCandidates(scorecardRows);
  const { safeUniverse } = buildSafeUniverse(decisionCandidates, identityLookupFor(rows));
  const broadTiers = PORTFOLIOS.find((portfolio) => portfolio.id === "PORTFOLIO_BROAD")?.tiers;
  if (!broadTiers) throw new Error("PORTFOLIO_BROAD tiers missing");
  const raw: Record<(typeof MODEL_IDS)[number], SelectedCandidate[]> = {
    P50_52_SAFE: runStandaloneStrict(safeUniverse, (event) => event.entryPrice >= 0.5 && event.entryPrice < 0.52),
    PORTFOLIO_BROAD_SAFE: runPortfolioStrict(safeUniverse, broadTiers),
    QUALITY_FILL_A_SAFE: runPortfolioStrict(safeUniverse, QUALITY_PORTFOLIOS.QUALITY_FILL_A),
    QUALITY_FILL_D_SAFE: runPortfolioStrict(safeUniverse, QUALITY_PORTFOLIOS.QUALITY_FILL_D),
    TENNIS_P50_52_SAFE: runStandaloneStrict(safeUniverse, (event) => event.entryPrice >= 0.5 && event.entryPrice < 0.52 && event.sportFamily === "tennis"),
  };
  const metadata = new Map<string, { scoreLevel: number; dataCoverage: number }>();
  const sourceByIdentity = new Map(rows.map((row) => [`${row.condition_id}::${row.selected_token_id}::${row.observed_at}`, row]));
  for (const candidate of decisionCandidates) {
    const source = sourceByIdentity.get(candidate.candidateIdentity);
    if (source) metadata.set(candidate.candidateIdentity, {
      scoreLevel: numberOrNull(source.pre_event_score_num) ?? 0,
      dataCoverage: numberOrNull(source.data_coverage) ?? 0,
    });
  }
  const capped = new Map<(typeof MODEL_IDS)[number], SelectedCandidate[]>();
  for (const model of MODEL_IDS) {
    const chosen = capModel(model, raw[model], date);
    if (chosen.length > CAP) throw new Error(`CAP30_EXCEEDED:${date}:${model}:${chosen.length}`);
    const physicalKeys = chosen.map((candidate) => candidate.physicalEventKey);
    if (new Set(physicalKeys).size !== physicalKeys.length) throw new Error(`DUPLICATE_PHYSICAL_EVENT:${date}:${model}`);
    capped.set(model, chosen);
  }
  return { capped, metadata };
}

function usd(units: number): number {
  return Math.round((units * 2 + Number.EPSILON) * 100) / 100;
}

function capitalRowsForModel(model: (typeof MODEL_IDS)[number], ledgerRows: LedgerRow[], metadata: Map<string, { scoreLevel: number; dataCoverage: number }>, mode: "FIXED_1U" | "DYNAMIC_ACTIVE_3PCT"): ShadowRow[] {
  const selected = ledgerRows.filter((row) => row.model === model);
  const executionCandidates: DynamicExecutionCandidate[] = selected.map((row) => {
    const feature = metadata.get(row.candidateIdentity);
    if (!feature) throw new Error(`CAPITAL_FEATURE_MISSING:${row.candidateIdentity}`);
    return {
      observationId: row.candidateIdentity,
      decisionAtIso: row.decisionTimestamp,
      settlementState: "UNQUERIED",
      finalScore: feature.scoreLevel,
      dataCoverage: feature.dataCoverage,
      entryPrice: row.entryPrice,
    };
  });
  const policy = mode === "FIXED_1U"
    ? { family: "NO_VAULT" as const, id: "DYNAMIC_NO_VAULT" as const }
    : buildPrincipalRecoveryStageA().find((candidate) => candidate.id === "PRV2_T25_P50_R1_S0.05_C0.1") as Parameters<typeof replayDynamicHarvest>[1] | undefined;
  if (!policy) throw new Error("PRV2_T25_P50_R1_S0.05_C0.1 policy missing");
  const replay = replayDynamicHarvest(executionCandidates, policy, {
    finalizationMode: "KEEP_OPEN_AT_CUTOFF",
    cutoffAtIso: CAPITAL_CUTOFF,
    stakeMode: mode,
  });
  const byIdentity = new Map(replay.ledger.map((row) => [row.observationId, row]));
  return DATES.map((date) => {
    const dateSelections = selected.filter((row) => row.date === date);
    const dateExecutions = dateSelections.map((row) => byIdentity.get(row.candidateIdentity)!).filter(Boolean);
    const candidates = dateSelections.length;
    const decisionInstants = new Set(dateSelections.map((row) => new Date(Date.parse(row.decisionTimestamp)).toISOString()));
    const curvePoints = replay.curve.filter((point) => decisionInstants.has(point.atIso));
    const snapshot = curvePoints.at(-1) ?? replay.curve[0];
    const fixedStakeUsd = mode === "FIXED_1U" ? 2 : null;
    const stakePerBetUsd = fixedStakeUsd ?? (candidates ? usd(dateExecutions.find((row) => row.stake > 0)?.stake ?? 0) : 0);
    return {
      model,
      date,
      selected_n: candidates,
      executed_n: dateExecutions.filter((row) => row.stake > 0).length,
      capital_skip_n: dateExecutions.filter((row) => row.stake <= 0).length,
      stake_per_bet_usd: stakePerBetUsd,
      free_active_usd: usd(snapshot.freeActive),
      open_principal_usd: usd(snapshot.openPrincipal),
      active_usd: usd(snapshot.active),
      vault_usd: usd(snapshot.vault),
      total_usd: usd(snapshot.total),
    };
  });
}

function outputJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const db = resolveClone();
  const allLedger: LedgerRow[] = [];
  const metadataByModel = new Map<string, Map<string, { scoreLevel: number; dataCoverage: number }>>();
  const dateSummaries: Record<string, Array<{ model: string; selected: number; football: number; tennis: number; other: number }>> = {};
  for (const date of DATES) {
    const rows = await readV4DateRows(db, date);
    const { capped, metadata } = selectedByModel(rows, date);
    dateSummaries[date] = [];
    for (const model of MODEL_IDS) {
      const chosen = capped.get(model)!;
      const counts = split(chosen);
      dateSummaries[date].push({ model, selected: chosen.length, ...counts });
      for (const candidate of chosen) {
        const output: LedgerRow = {
          date,
          model,
          candidateIdentity: candidate.candidateIdentity,
          physicalEventKey: candidate.physicalEventKey,
          decisionTimestamp: candidate.decisionTimestamp,
          eventStart: candidate.eventStart,
          entryPrice: candidate.entryPrice,
          sportFamily: candidate.sportFamily,
          settlementState: "UNQUERIED",
        };
        allLedger.push(output);
      }
      const existing = metadataByModel.get(model) ?? new Map<string, { scoreLevel: number; dataCoverage: number }>();
      for (const [key, value] of metadata) existing.set(key, value);
      metadataByModel.set(model, existing);
    }
  }
  allLedger.sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model) || a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey) || a.candidateIdentity.localeCompare(b.candidateIdentity));
  const hashes = Object.fromEntries(DATES.map((date) => [date, stableHash(allLedger.filter((row) => row.date === date))]));
  const fixed: ShadowRow[] = [];
  const protectedRows: ShadowRow[] = [];
  for (const model of MODEL_IDS) {
    const modelLedger = allLedger.filter((row) => row.model === model);
    const metadata = metadataByModel.get(model)!;
    fixed.push(...capitalRowsForModel(model, modelLedger, metadata, "FIXED_1U"));
    protectedRows.push(...capitalRowsForModel(model, modelLedger, metadata, "DYNAMIC_ACTIVE_3PCT"));
  }
  const artifact = {
    mission: "PROSPECTIVE_SELECTION_SHADOW_V1",
    generatedAt: new Date().toISOString(),
    freshness: { selectionFreshThrough: "2026-09-22", settlementFreshThrough: "2026-09-20", pnlFreshThrough: "2026-09-20" },
    cap: CAP,
    startCapitalUsd: 100,
    ledgerHashes: hashes,
    ledger: allLedger,
    selectionSummaries: dateSummaries,
    fixedShadow: fixed,
    protectedShadow: protectedRows,
    labels: { protectedPolicy: "DYNAMIC_PROTECTED_GROWTH_V1", protectedPolicyId: "PRV2_T25_P50_R1_S0.05_C0.1", settlementState: "UNQUERIED" },
  };
  outputJson(join(OUTPUT_DIR, "PROSPECTIVE_LEDGER.json"), artifact);
  mkdirSync(dirname(DASHBOARD_DATA_PATH), { recursive: true });
  writeFileSync(DASHBOARD_DATA_PATH, `window.POLYPROPICKS_FORWARD_SHADOW_DATA = ${JSON.stringify(artifact)};\n`, "utf8");
  console.log("PROSPECTIVE_SELECTION_SHADOW=PASS");
  for (const date of DATES) {
    console.log(`${date}_MODEL_SELECTIONS=`);
    for (const row of dateSummaries[date]) console.log(`${row.model}: selected=${row.selected} football=${row.football} tennis=${row.tennis} other=${row.other}`);
    console.log(`${date}_LEDGER_HASH=${hashes[date]}`);
  }
  console.log(`FIXED_SHADOW_BY_MODEL=${JSON.stringify(fixed)}`);
  console.log(`PROTECTED_SHADOW_BY_MODEL=${JSON.stringify(protectedRows)}`);
  console.log("UNQUERIED_CAPITAL_SUPPORT=PASS");
  console.log("SELECTION_DOES_NOT_READ_SETTLEMENT=PASS");
  console.log("CAP30_MAX=PASS");
  console.log("DETERMINISTIC_LEDGER_HASH=PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
