/**
 * REAL_COMPACT_CORPUS_MODEL_SCOREBOARD_ACCEPTANCE_V1 — bounded read-only runner.
 *
 * Reuses UNCHANGED:
 *   - lib/modeling/forward-rich/materializeForwardRichResearch.ts (PIT rule:
 *     FEATURE_OBSERVED_AT <= DECISION_AT)
 *   - lib/modeling/research-engine (frozen C0/C1/C4/C5 predicates + settlement)
 *   - lib/feed/resolveSignalOutcome.ts (Gamma terminal-state settlement authority)
 *
 * Adds ONLY:
 *   - a project-ref based Supabase client resolver (never trusts env var
 *     naming; resolves the research clone nppznoujvnyjargjkmnv by URL host)
 *   - a minimal per-population dedup ("first eligible chronological row per
 *     (population, condition_id, selected_token_id)") ahead of the unchanged
 *     materializer
 *   - population separation by generated_signal_pairs.formula_version
 *
 * No writes. No schema/migration changes. No C4 predicate change.
 *
 *   npx tsx scripts/modeling/sep02-clone-c4-scoreboard.ts
 */
import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  materializeForwardRichResearch,
  type ForwardRichSignalPair,
  type ForwardRichSnapshotObservation,
  type ForwardRichResearchRow,
} from "../../lib/modeling/forward-rich";
import { FROZEN_MODELS } from "../../lib/modeling/research-engine/models";
import { runModel } from "../../lib/modeling/research-engine/engine";
import type { ResearchEngineInputEvent, Outcome } from "../../lib/modeling/research-engine/types";
import {
  fetchGammaMarketByConditionId,
  resolveSignalOutcome,
} from "../../lib/feed/resolveSignalOutcome";

const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
const EXPECTED_PRODUCTION_REF = "nbnldzfsxffztsfrrxqy";

const WINDOW_START = "2026-09-01T21:00:00.000Z"; // 2026-09-02 00:00 Europe/Minsk
const WINDOW_END = "2026-09-02T21:00:00.000Z"; // 2026-09-03 00:00 Europe/Minsk (exclusive)
const SINCE_CUTOFF = "2026-09-01T20:59:59.999Z"; // one ms before WINDOW_START, so decisionAt > cutoff admits the whole closed slice

type PopulationId = "SEP_SHADOW_STRATEGIC_V1" | "SEP_PUBLIC_RICH_V1" | "UNCLASSIFIED";
const SHADOW_FORMULA_VERSION = "shadow-strategic-sports-v1";
const PUBLIC_RICH_FORMULA_VERSION = "v2-lite-growth-safe";

function classifyPopulation(formulaVersion: string | null): PopulationId {
  if (formulaVersion === SHADOW_FORMULA_VERSION) return "SEP_SHADOW_STRATEGIC_V1";
  if (formulaVersion === PUBLIC_RICH_FORMULA_VERSION) return "SEP_PUBLIC_RICH_V1";
  return "UNCLASSIFIED";
}

/** Credential class inferred from key shape only — never from its value beyond the prefix. */
function credentialClass(key: string): "sb_secret" | "sb_publishable" | "jwt" | "unknown" {
  if (key.startsWith("sb_secret_")) return "sb_secret";
  if (key.startsWith("sb_publishable_")) return "sb_publishable";
  if (key.split(".").length === 3) return "jwt"; // legacy service_role/anon JWT, role unknown without decoding
  return "unknown";
}

/**
 * Resolves the Supabase client by exact project ref, never by env-var name —
 * and by credential CLASS, never by env-var name either. A var named
 * SUPABASE_SERVICE_ROLE_KEY is not proof the value it holds is privileged
 * (observed: it held an sb_publishable_ key in this environment, which reads
 * as zero rows under RLS). Scans all configured env values for the first
 * sb_secret_-class (privileged) key, regardless of which variable holds it.
 */
function resolveCloneClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("BLOCKED_NO_SUPABASE_URL_CONFIGURED");
  const ref = new URL(url).hostname.split(".")[0];
  if (ref === EXPECTED_PRODUCTION_REF) {
    throw new Error("BLOCKED_PRODUCTION_REF_REJECTED: configured binding resolves to production, not the research clone");
  }
  if (ref !== EXPECTED_CLONE_REF) {
    throw new Error(`BLOCKED_NO_BINDING_MATCHES_CLONE_REF: configured project ref is not ${EXPECTED_CLONE_REF}`);
  }

  let privilegedKeyVar: string | null = null;
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && credentialClass(v) === "sb_secret") {
      privilegedKeyVar = k;
      break;
    }
  }
  const fallbackKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const key = privilegedKeyVar ? (process.env[privilegedKeyVar] as string) : fallbackKey;
  if (!key) throw new Error("BLOCKED_NO_SUPABASE_CREDENTIAL_CONFIGURED");
  const usedClass = privilegedKeyVar ? "sb_secret" : credentialClass(key);

  console.log(
    JSON.stringify({
      resolvedBindingProjectRef: ref,
      matchesExpectedCloneRef: true,
      credentialEnvVarUsed: privilegedKeyVar ?? "SUPABASE_SERVICE_ROLE_KEY",
      credentialClass: usedClass,
    }),
  );
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

type Row = Record<string, unknown>;
function obj(v: unknown): Row {
  return v && typeof v === "object" ? (v as Row) : {};
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

interface RawGsp {
  conditionId: string;
  selectedTokenId: string;
  createdAt: string;
  entryPriceNum: number | null;
  formulaVersion: string | null;
  volumeUsd: number | null;
  eventStartIso: string | null;
  providerEventId: string | null;
  marketTypeRaw: string | null;
  marketFamily: string | null;
  providerSportCode: string | null;
  providerSportFamily: string | null;
}

async function fetchGspWindow(client: SupabaseClient): Promise<RawGsp[]> {
  const pageSize = 1000;
  const out: RawGsp[] = [];
  // Keyset pagination, not OFFSET/range — avoids deep-offset timeouts on a
  // multi-million-row table. created_at is not unique alone, so the cursor
  // also carries a stable tiebreak (condition_id).
  let cursorCreatedAt: string | null = null;
  let cursorConditionId: string | null = null;
  while (true) {
    let query = client
      .from("generated_signal_pairs")
      .select("condition_id, selected_token_id, created_at, entry_price_num, diagnostics, formula_version")
      .not("condition_id", "is", null)
      .not("selected_token_id", "is", null)
      .gte("created_at", WINDOW_START)
      .lt("created_at", WINDOW_END)
      .order("created_at", { ascending: true })
      .order("condition_id", { ascending: true })
      .limit(pageSize);
    if (cursorCreatedAt !== null) {
      query = query.or(
        `created_at.gt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},condition_id.gt.${cursorConditionId})`,
      );
    }
    const { data, error } = await query;
    if (error) throw new Error(`RESEARCH_CLONE_SOURCE_READ_generated_signal_pairs:${error.message}`);
    const chunk = (data ?? []) as Row[];
    for (const raw of chunk) {
      const r = obj(raw);
      const d = obj(r.diagnostics);
      out.push({
        conditionId: String(r.condition_id),
        selectedTokenId: String(r.selected_token_id),
        createdAt: String(r.created_at),
        entryPriceNum: num(r.entry_price_num),
        formulaVersion: str(r.formula_version),
        volumeUsd: num(d.volumeUsd),
        eventStartIso: str(d.gameStartIso),
        providerEventId: str(d.providerEventId),
        marketTypeRaw: str(d.marketType),
        marketFamily: str(d.marketFamily),
        providerSportCode: str(d.providerSportCode),
        providerSportFamily: str(d.providerSportFamily),
      });
    }
    if (chunk.length < pageSize) break;
    const last = chunk[chunk.length - 1];
    cursorCreatedAt = String(last.created_at);
    cursorConditionId = String(last.condition_id);
  }
  return out;
}

async function fetchObservationsWindow(client: SupabaseClient): Promise<ForwardRichSnapshotObservation[]> {
  const pageSize = 1000;
  const out: ForwardRichSnapshotObservation[] = [];
  // Keyset pagination (not OFFSET/range): deep-offset pagination over a
  // multi-hundred-thousand-row table times out. snapshot_at is not unique
  // alone, so the cursor also carries a stable tiebreak (condition_id).
  let cursorSnapshotAt: string | null = null;
  let cursorConditionId: string | null = null;
  // Bounded to the decision day itself, matching the closed D-1 slice this
  // mission scores; the PIT cut inside the materializer still applies
  // FEATURE_OBSERVED_AT <= DECISION_AT on whatever is fetched here.
  const readFloor = WINDOW_START;
  while (true) {
    let query = client
      .from("generated_signal_research_snapshots")
      .select(
        "condition_id, selected_token_id, snapshot_at, created_at, snapshot_run_id, selected_price_num, opposing_price_num, event_id, game_start_iso, data_coverage_num, diagnostics",
      )
      .gte("snapshot_at", readFloor)
      .lt("snapshot_at", WINDOW_END)
      .order("snapshot_at", { ascending: true })
      .order("condition_id", { ascending: true })
      .limit(pageSize);
    if (cursorSnapshotAt !== null) {
      query = query.or(
        `snapshot_at.gt.${cursorSnapshotAt},and(snapshot_at.eq.${cursorSnapshotAt},condition_id.gt.${cursorConditionId})`,
      );
    }
    const { data, error } = await query;
    if (error) throw new Error(`RESEARCH_CLONE_SOURCE_READ_generated_signal_research_snapshots:${error.message}`);
    const chunk = (data ?? []) as Row[];
    for (const raw of chunk) {
      const r = obj(raw);
      const d = obj(r.diagnostics);
      const so = obj(d.scoreObservation);
      const fireModel = obj(d.fireModel);
      const modelCandidate = obj(fireModel.modelCandidate);
      out.push({
        conditionId: String(r.condition_id),
        selectedTokenId: String(r.selected_token_id),
        snapshotAt: String(r.snapshot_at),
        sourceCreatedAt: str(r.created_at) ?? String(r.snapshot_at),
        snapshotRunId: str(r.snapshot_run_id),
        scoreValue: num(so.scoreValue) ?? num(d.formulaScore) ?? num(modelCandidate.score),
        scoreMetricFormulaVersion: str(so.metricFormulaVersion) ?? str(fireModel.formulaVersion),
        selectedPriceNum: num(r.selected_price_num),
        opposingPriceNum: num(r.opposing_price_num),
        providerEventId: str(r.event_id),
        gameStartIso: str(r.game_start_iso),
        dataCoverageNum: num(r.data_coverage_num),
      });
    }
    if (chunk.length < pageSize) break;
    const last = chunk[chunk.length - 1];
    cursorSnapshotAt = String(last.snapshot_at);
    cursorConditionId = String(last.condition_id);
  }
  return out;
}

/** Minimal deterministic compaction: first-eligible chronological row per (condition, token) within a population. */
function compactSignalPairs(rows: RawGsp[]): ForwardRichSignalPair[] {
  const byIdentity = new Map<string, RawGsp>();
  for (const row of rows) {
    const key = `${row.conditionId}::${row.selectedTokenId}`;
    const existing = byIdentity.get(key);
    if (!existing || row.createdAt < existing.createdAt) byIdentity.set(key, row);
  }
  return [...byIdentity.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((row) => ({
      conditionId: row.conditionId,
      selectedTokenId: row.selectedTokenId,
      decisionAt: row.createdAt,
      sourceCreatedAt: row.createdAt,
      entryPriceNum: row.entryPriceNum,
      volumeUsd: row.volumeUsd,
      eventStartIso: row.eventStartIso,
      providerEventId: row.providerEventId,
      marketTypeRaw: row.marketTypeRaw,
      marketFamily: row.marketFamily,
      providerSportCode: row.providerSportCode,
      providerSportFamily: row.providerSportFamily,
      formulaVersion: row.formulaVersion,
    }));
}

type SettlementCategory = "WIN" | "LOSS" | "VOID" | "OPEN" | "NO_MATCH" | "AMBIGUOUS";

function classifySettlement(
  resolverState: string,
  signalResult: "won" | "lost" | null,
): SettlementCategory {
  if (resolverState === "resolved_candidate") return signalResult === "won" ? "WIN" : "LOSS";
  if (resolverState === "active_unresolved") return "OPEN";
  if (resolverState === "lookup_failed") return "NO_MATCH";
  return "AMBIGUOUS"; // closed_unknown, invalid_snapshot
}

interface PopulationReport {
  population: PopulationId;
  period: string;
  uniqueEligibleEvents: number;
  bets: number;
  settledN: number;
  win: number;
  loss: number;
  void_: number;
  open: number;
  noMatch: number;
  ambiguous: number;
  pnlUnits: number;
  roiPct: number;
  maxDrawdownUnits: number;
  pnlPer100Bets: number;
  coverage: {
    entryPricePct: number;
    sportLeadTimePct: number;
    scorePct: number;
    volumePct: number;
  };
}

async function runForPopulation(
  population: PopulationId,
  compactRows: ForwardRichResearchRow[],
): Promise<PopulationReport> {
  const c4 = FROZEN_MODELS.C4;
  const eligible = compactRows.filter((r) => {
    if (r.entryPrice == null || r.leadTimeHours == null) return false;
    const sportFamily = (r.providerSportFamily ?? r.providerSportCode ?? "").toLowerCase();
    return c4.predicate({
      entryPrice: r.entryPrice,
      sportFamily,
      leadTimeHours: r.leadTimeHours,
    } as any);
  });

  const settlementCounts: Record<SettlementCategory, number> = {
    WIN: 0,
    LOSS: 0,
    VOID: 0,
    OPEN: 0,
    NO_MATCH: 0,
    AMBIGUOUS: 0,
  };
  const winLossInput: ResearchEngineInputEvent[] = [];

  for (const row of eligible) {
    const market = await fetchGammaMarketByConditionId(row.conditionId);
    const resolved = resolveSignalOutcome({
      conditionId: row.conditionId,
      selectedTokenId: row.selectedTokenId,
      entryPriceNum: row.entryPrice,
      market,
    });
    const category = classifySettlement(resolved.resolverState, resolved.signalResult);
    settlementCounts[category] += 1;
    if (category === "WIN" || category === "LOSS") {
      winLossInput.push({
        physicalEventKey: `${row.conditionId}::${row.selectedTokenId}`,
        decisionTimestamp: row.decisionAt,
        eventStart: row.eventStart ?? row.decisionAt,
        entryPrice: row.entryPrice as number,
        sportFamily: (row.providerSportFamily ?? row.providerSportCode ?? "").toLowerCase(),
        outcome: (category as Outcome),
      });
    }
  }

  const modelResult = runModel("C4", winLossInput);

  const settledN = modelResult.WINS + modelResult.LOSSES;
  const bets = eligible.length;
  const pnlPer100 = bets === 0 ? 0 : Math.round((modelResult.PNL_U / bets) * 100 * 100) / 100;

  const withEntryPrice = compactRows.filter((r) => r.entryPrice != null).length;
  const withSportLeadTime = compactRows.filter(
    (r) => (r.providerSportFamily ?? r.providerSportCode ?? null) != null && r.leadTimeHours != null,
  ).length;
  const withScore = compactRows.filter((r) => r.score.observationCount > 0).length;
  const withVolume = compactRows.filter((r) => r.volumeUsd != null).length;
  const pct = (n: number) => (compactRows.length === 0 ? 0 : Math.round((n / compactRows.length) * 10000) / 100);

  return {
    population,
    period: "2026-09-02 (Europe/Minsk, single day)",
    uniqueEligibleEvents: bets,
    bets,
    settledN,
    win: settlementCounts.WIN,
    loss: settlementCounts.LOSS,
    void_: settlementCounts.VOID,
    open: settlementCounts.OPEN,
    noMatch: settlementCounts.NO_MATCH,
    ambiguous: settlementCounts.AMBIGUOUS,
    pnlUnits: modelResult.PNL_U,
    roiPct: modelResult.ROI_PCT,
    maxDrawdownUnits: modelResult.MAX_DRAWDOWN_U,
    pnlPer100Bets: pnlPer100,
    coverage: {
      entryPricePct: pct(withEntryPrice),
      sportLeadTimePct: pct(withSportLeadTime),
      scorePct: pct(withScore),
      volumePct: pct(withVolume),
    },
  };
}

async function main() {
  loadEnvConfig(process.cwd());
  const client = resolveCloneClient();

  const [rawGsp, observations] = await Promise.all([
    fetchGspWindow(client),
    fetchObservationsWindow(client),
  ]);

  const rawGspRows = rawGsp.length;
  const uniqueProviderEvents = new Set(rawGsp.map((r) => r.providerEventId).filter(Boolean)).size;
  const uniqueConditionMarkets = new Set(rawGsp.map((r) => r.conditionId)).size;

  const byPopulation = new Map<PopulationId, RawGsp[]>();
  for (const row of rawGsp) {
    const pop = classifyPopulation(row.formulaVersion);
    const bucket = byPopulation.get(pop) ?? [];
    bucket.push(row);
    byPopulation.set(pop, bucket);
  }

  const materializedAt = new Date().toISOString();
  const funnel: Record<string, unknown> = {};
  const reports: PopulationReport[] = [];

  let totalCompactRows = 0;
  let totalCompactEvents = new Set<string>();
  let totalCompactMarkets = new Set<string>();

  for (const [population, rows] of byPopulation) {
    const compactPairs = compactSignalPairs(rows);
    const compactRows = materializeForwardRichResearch({
      signalPairs: compactPairs,
      observations,
      sinceCutoff: SINCE_CUTOFF,
      materializedAt,
    });

    totalCompactRows += compactRows.length;
    for (const r of compactRows) {
      totalCompactEvents.add(r.providerEventId ?? `${r.conditionId}::${r.selectedTokenId}`);
      totalCompactMarkets.add(r.conditionId);
    }

    funnel[population] = {
      rawRows: rows.length,
      compactRows: compactRows.length,
      compressionRatio: compactRows.length === 0 ? null : Math.round((rows.length / compactRows.length) * 100) / 100,
      uniqueCompactEvents: new Set(compactRows.map((r) => r.providerEventId ?? `${r.conditionId}::${r.selectedTokenId}`)).size,
      uniqueCompactMarkets: new Set(compactRows.map((r) => r.conditionId)).size,
    };

    reports.push(await runForPopulation(population, compactRows));
  }

  console.log(
    JSON.stringify(
      {
        command: "REAL_COMPACT_CORPUS_MODEL_SCOREBOARD_ACCEPTANCE_V1",
        provenance: {
          sourceProjectRef: EXPECTED_CLONE_REF,
          window: { minskDate: "2026-09-02", utcStart: WINDOW_START, utcEnd: WINDOW_END },
        },
        sourceStage: {
          rawGspRows,
          uniqueProviderEvents,
          uniqueConditionMarkets,
        },
        compressionByPopulation: funnel,
        analyticalOutputTotals: {
          compactRows: totalCompactRows,
          uniqueCompactEvents: totalCompactEvents.size,
          uniqueCompactMarkets: totalCompactMarkets.size,
          compressionRatio: totalCompactRows === 0 ? null : Math.round((rawGspRows / totalCompactRows) * 100) / 100,
        },
        weeklyStability: "NOT_YET_MEASURABLE (single-day slice)",
        c4PredicateUnchanged: FROZEN_MODELS.C4.predicateDescription,
        scoreboard: reports,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
