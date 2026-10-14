// Research-only runner for FORWARD_MODEL_DECISIONS_T90_V1. Builds the frozen T-90 cohort with the existing builder, runs the
// EXISTING frozen model selectors over their own causal source universe, joins them to the cohort by exact token, measures each
// model-owned BET token's own book, and reports DB first-persistence readiness. It contains NO database write: persistence is a
// fail-closed gate. Reads: Research DBClone (GET, explicit projections), Polymarket Gamma/CLOB (public). Writes ONE local receipt.
//   npm run research-clone:forward-model-decisions-t90 -- --out <dir>
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { buildExecutableLiquidityCohort, COHORT_HORIZON_HOURS, T90_MINUTES, t90CutoffMs } from "../lib/research/executableLiquidityCohortT90";
import {
  assessExecution, decideCohortModels, PERSISTENCE_EDGES, FORWARD_DECISIONS_VERSION, modelKey, parseCandidateIdentity, persistenceReadiness, summarizeDecisions, tokenKey,
  type ModelBet, type ModelEvaluation, type ModelRef, type PersistenceEnvironment,
} from "../lib/research/forwardModelDecisionsT90";
import { fetchOrderBooksConcurrent, fetchTokenFeeSchedule } from "../lib/liquidity/polymarketClient";
import { ALPHA_PROGRAMS, CONTROL_STRATEGIES } from "../lib/research/inplayPaperDecisions";
import { MODEL_IDS, selectedByModel, type V4EvidenceRow } from "./modeling/prospective-selection-shadow";
import { ACTIVE_D1_FOOTBALL_STRATEGIES } from "./modeling/active-d1-football-strategies";
import { cloneTarget, readSource } from "./research-t90-liquidity-cohort";

/** The SAFE owner module registers model ids only; no semantic version exists there and none is invented here. */
export const SAFE_OWNER_VERSION = "OWNER_UNVERSIONED";
const SAFE_SCOPE: Record<string, ModelRef["sportScope"]> = { TENNIS_P50_52_SAFE: "tennis" };
export const MODELS: ModelRef[] = [
  ...MODEL_IDS.map((id) => ({ modelId: id, modelVersion: SAFE_OWNER_VERSION, family: "SAFE_PREMATCH" as const, sportScope: SAFE_SCOPE[id] ?? "ALL" })),
  ...ACTIVE_D1_FOOTBALL_STRATEGIES.map((s) => ({ modelId: s.strategy_id, modelVersion: s.strategy_version, family: "FOOTBALL_D1" as const, sportScope: "soccer" as const })),
];

/** The football D-1 selectors consume a RunContext built from research_model_ready_rows by model_date (nightly D-1
 *  materialization carrying settlement_label) with no per-row DB ingest time; pre-T-90 availability cannot be proven. */
export const FOOTBALL_D1_BLOCK: ModelEvaluation = {
  status: "BLOCKED", reason: "FOOTBALL_D1_SOURCE_PATH_NOT_PROSPECTIVE",
  evidence: "RunContext <- classifyOneDay <- research_model_ready_rows(model_date) incl. settlement_label; no per-row ingested_at <= T-90 proof",
};

/** Exactly what the environment can prove today. Every false/null is a reported edge, never a default. */
export const PERSISTENCE_ENV: PersistenceEnvironment = {
  cloneWriteCapability: false, // no registered application writer for this producer; live-shadow-cycle is the SAFE daily-batch writer
  deployedContractVerified: false, // trigger/function bodies are not readable through PostgREST; no read-only catalog capability
  ledgerEncodesModelVersion: false, // prospective_selection_shadow_runtime has model_id only (repo schema) and no version column
  authoritativeStartSource: null, // cohort start = scored source game_start_iso confirmed against provider schedule (scheduled-only)
};

const V4_COLUMNS = "observation_id,observed_at,ingested_at,item_observation_id,condition_id,selected_token_id,entry_price_num,pre_event_score_num,provider_event_id,provider_sport_family,market_type,event_title,market_question,game_start_iso,data_coverage";
const PAGE = 1000;
const LOOKBACK_HOURS = 72;

type V4Row = V4EvidenceRow & { ingested_at: string };

const minskDate = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);

/** Same universe bounds as the cohort source read, plus the SAFE owner's projection. Pinned to the cohort's DB watermark. */
async function readSafeUniverse(watermarkMs: number, referenceMs: number): Promise<V4Row[]> {
  const { base, key } = cloneTarget();
  const db = createClient(base, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const from = new Date(referenceMs - LOOKBACK_HOURS * 3_600_000).toISOString();
  const startMin = new Date(referenceMs + T90_MINUTES * 60_000).toISOString();
  const startMax = new Date(referenceMs + COHORT_HORIZON_HOURS * 3_600_000 + 3_600_000).toISOString();
  const rows: V4Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db.from("research_evidence_page_rows").select(V4_COLUMNS)
      .gte("observed_at", from).lte("ingested_at", new Date(watermarkMs).toISOString())
      .gt("game_start_iso", startMin).lte("game_start_iso", startMax)
      .order("observed_at", { ascending: true }).order("observation_id", { ascending: true }).order("item_observation_id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`SAFE_UNIVERSE_READ:${error.code ?? "FAILED"}`);
    rows.push(...(data ?? []) as unknown as V4Row[]);
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

/** Runs the frozen SAFE selectors per Minsk decision date over rows the DB possessed no later than their event's T-90. */
export function evaluateSafeModels(rows: readonly V4Row[]): Map<string, ModelEvaluation> {
  const causal = rows.filter((r) => r.game_start_iso && Date.parse(r.ingested_at) <= t90CutoffMs(r.game_start_iso));
  const byDate = new Map<string, V4Row[]>();
  for (const r of causal) byDate.set(minskDate(r.observed_at), [...(byDate.get(minskDate(r.observed_at)) ?? []), r]);
  const bets = new Map<string, ModelBet[]>(MODEL_IDS.map((id) => [id, []]));
  const ingestedAt = new Map(causal.map((r) => [`${r.condition_id}::${r.selected_token_id}::${r.observed_at}`, r.ingested_at]));
  // Every SAFE model receives the SAME decision-candidate universe (owner: selectedByModel builds `metadata` from all
  // settlement-free decision candidates before any model predicate), so one evaluated-candidate set is exact for all five.
  const evaluated = new Set<string>();
  for (const [date, dayRows] of [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const { capped, metadata } = selectedByModel(dayRows, date);
    for (const identity of metadata.keys()) { const p = parseCandidateIdentity(identity); if (p) evaluated.add(tokenKey(p.conditionId, p.tokenId)); }
    for (const id of MODEL_IDS) for (const c of capped.get(id) ?? []) {
      const p = parseCandidateIdentity(c.candidateIdentity);
      if (!p) throw new Error(`SAFE_CANDIDATE_IDENTITY_UNPARSEABLE:${id}`);
      bets.get(id)!.push({ candidateIdentity: c.candidateIdentity, conditionId: p.conditionId, tokenId: p.tokenId, decisionTimestamp: c.decisionTimestamp, eventStart: c.eventStart, entryPrice: c.entryPrice, modelPhysicalEventKey: c.physicalEventKey, sourceIngestedAt: ingestedAt.get(c.candidateIdentity) ?? null });
    }
  }
  return new Map(MODEL_IDS.map((id) => [modelKey({ modelId: id, modelVersion: SAFE_OWNER_VERSION }), {
    status: "EVALUATED", bets: bets.get(id)!, evaluatedTokenKeys: evaluated, sourceAvailability: "DB_INGESTED_AT_BEFORE_T90",
  } as ModelEvaluation]));
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  if (!outDir) throw new Error("--out <dir> is required (receipt contains live prospective identities; never commit it)");
  mkdirSync(outDir, { recursive: true });
  const write = (receipt: Record<string, unknown>) => {
    const file = join(outDir, `forward-model-decisions-t90-${new Date().toISOString().replace(/[:.]/g, "")}.json`);
    writeFileSync(file, JSON.stringify(receipt, null, 2));
    return file;
  };
  const excluded = {
    control_in_play_not_prematch: CONTROL_STRATEGIES.map((s) => `${s.id}@${s.version}`),
    alpha_v0_facts_only_cannot_bet: ALPHA_PROGRAMS.map((s) => `${s.id}@${s.version}`),
  };
  try { cloneTarget(); } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const file = write({ version: FORWARD_DECISIONS_VERSION, business_pass: false, first_broken_edge: `RESEARCH_DBCLONE_READ_CAPABILITY:${reason}`, models: MODELS, excluded });
    console.log(JSON.stringify({ file, business_pass: false, first_broken_edge: `RESEARCH_DBCLONE_READ_CAPABILITY:${reason}`, models_registered: MODELS.length }, null, 2));
    process.exit(2);
  }

  const run = await buildExecutableLiquidityCohort({ readSource });
  const safeRows = await readSafeUniverse(run.timing.dbIngestWatermarkMs, run.timing.referenceMs);
  const evaluations = evaluateSafeModels(safeRows);
  for (const s of ACTIVE_D1_FOOTBALL_STRATEGIES) evaluations.set(modelKey({ modelId: s.strategy_id, modelVersion: s.strategy_version }), FOOTBALL_D1_BLOCK);
  const result = decideCohortModels(run.cohort, MODELS, evaluations);

  const bets = result.decisions.filter((d) => d.outcome === "BET");
  const books = await fetchOrderBooksConcurrent(bets.map((d) => d.bet!.tokenId), 6);
  const fees = await Promise.all(bets.map((d) => fetchTokenFeeSchedule(d.bet!.tokenId, { timeoutMs: 5000 })));
  const nowMs = Date.now();
  const assessed = bets.map((d, i) => {
    const execution = assessExecution(d, books[i], fees[i], run.timing.snapshotReadCompletedLocalMs);
    return { decision: d, execution, persistence: persistenceReadiness(d, execution, PERSISTENCE_ENV, nowMs) };
  });
  const firstEdges: Record<string, number> = {};
  for (const a of assessed) firstEdges[a.persistence.firstFailedEdge ?? "READY"] = (firstEdges[a.persistence.firstFailedEdge ?? "READY"] ?? 0) + 1;
  const summary = summarizeDecisions(result.decisions);
  const cohortStable = result.digestBefore === result.digestAfter;
  const firstBroken = !cohortStable ? "COHORT_DIGEST_CHANGED"
    : bets.length === 0 ? "NO_MODEL_ELIGIBLE_BET_IN_COHORT"
    : assessed.every((a) => !a.persistence.ready) ? `PERSISTENCE:${PERSISTENCE_EDGES.find((e) => firstEdges[e]) ?? "UNKNOWN"}` : null;
  const receipt = {
    version: FORWARD_DECISIONS_VERSION, research_only: true, db_writes: 0, business_pass: false,
    cohort: { version: run.cohort.version, digest_before: result.digestBefore, digest_after: result.digestAfter, stable: cohortStable, funnel: run.funnel },
    models: MODELS, excluded, persistence_environment: PERSISTENCE_ENV,
    summary, out_of_cohort_bets: result.outOfCohortBets, uniqueness_violations: result.uniquenessViolations,
    persistence_first_failed_edges: firstEdges, first_broken_edge: firstBroken,
    decisions: result.decisions, bets: assessed,
  };
  const file = write(receipt);
  // Terminal: aggregates only.
  console.log(JSON.stringify({ file, cohort: receipt.cohort, summary, persistence_first_failed_edges: firstEdges, first_broken_edge: firstBroken }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
