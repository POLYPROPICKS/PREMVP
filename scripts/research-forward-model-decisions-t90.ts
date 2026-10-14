// Research-only runner for FORWARD_MODEL_DECISIONS_T90_V2. Builds the frozen T-90 cohort with the existing builder, replays
// the EXISTING frozen SAFE selectors chronologically over their own causal source universe, joins them to the cohort by
// exact token, measures each model-owned BET under that model's own economics authority, and reports DB first-persistence
// readiness against the deployed FORWARD_BET_V1 contract. It contains NO database write: no approved application-owned
// FORWARD_BET_V1 writer exists on this repository boundary. Reads: Research DBClone (GET, explicit projections),
// Polymarket Gamma/CLOB (public). Writes ONE local receipt.
//   npm run research-clone:forward-model-decisions-t90 -- --out <dir>
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { buildExecutableLiquidityCohort } from "../lib/research/executableLiquidityCohortT90";
import {
  assessExecution, chronologicalClaims, decideCohortModels, FORWARD_CONTRACT, FORWARD_DECISIONS_VERSION, modelKey, parseCandidateIdentity,
  PERSISTENCE_EDGES, persistenceReadiness, summarizeDecisions, tokenKey, VERSION_ABSENT,
  type ModelBet, type ModelEvaluation, type ModelRef, type PersistenceEnvironment, type PrefixSelection,
} from "../lib/research/forwardModelDecisionsT90";
import { fetchOrderBooksConcurrent, fetchTokenFeeSchedule } from "../lib/liquidity/polymarketClient";
import { resolveSportFamily } from "../lib/research-clone/modelReady";
import { ALPHA_PROGRAMS, CONTROL_STRATEGIES } from "../lib/research/inplayPaperDecisions";
import { CAP, MODEL_IDS, numberOrNull, selectedByModel, type V4EvidenceRow } from "./modeling/prospective-selection-shadow";
import { toSettlementFreeDecisionTimeCandidates } from "./modeling/factor-atlas";
import { buildSafeUniverse, type IdentityCandidate } from "./modeling/tennis-safe-comparable-leaderboard";
import { ACTIVE_D1_FOOTBALL_STRATEGIES } from "./modeling/active-d1-football-strategies";
import { cloneTarget, readSource } from "./research-t90-liquidity-cohort";

// ── model identity authority ─────────────────────────────────────────────────────────────────────────────────────

const SAFE_OWNER = "scripts/modeling/prospective-selection-shadow.ts";
const FOOTBALL_OWNERS = ["scripts/modeling/active-d1-football-strategies.ts", "scripts/modeling/football-strategy-registry.ts", "scripts/modeling/football-live-safe-rebaseline.ts"];

/** Git blob SHA-1 of a working-tree file (the exact source definition evaluated), plus HEAD when git is available. */
export function gitBlobSha(content: Buffer): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest("hex");
}
function sourceIdentity(paths: readonly string[]): string | null {
  try {
    let head = "NO_GIT";
    try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* no git */ }
    return `${head}:${paths.map((p) => `${p}@${gitBlobSha(readFileSync(p))}`).join(",")}`;
  } catch { return null; }
}

const SAFE_SCOPE: Record<string, ModelRef["sportScope"]> = { TENNIS_P50_52_SAFE: "tennis" };
/** The SAFE owner registers model ids only: no semantic version or definition registry exists, and none is invented. */
export function buildModels(): ModelRef[] {
  const safeSha = sourceIdentity([SAFE_OWNER]);
  const footballSha = sourceIdentity(FOOTBALL_OWNERS);
  return [
    ...MODEL_IDS.map((id): ModelRef => ({
      modelId: id, modelVersion: VERSION_ABSENT, sourceSha: safeSha, family: "SAFE_PREMATCH", sportScope: SAFE_SCOPE[id] ?? "ALL",
      versionAuthority: { state: "ABSENT", reason: `${SAFE_OWNER} exports MODEL_IDS only; no semantic_version/definition registry for SAFE models` },
    })),
    ...ACTIVE_D1_FOOTBALL_STRATEGIES.map((s): ModelRef => ({
      modelId: s.strategy_id, modelVersion: s.strategy_version, sourceSha: footballSha, family: "FOOTBALL_D1", sportScope: "soccer",
      versionAuthority: { state: "SEMANTIC_VERSION", source: "ACTIVE_D1_FOOTBALL_STRATEGIES.strategy_version (football-strategy-registry semantic_version / LIVE_B / D1_CAUSAL_V1)" },
    })),
  ];
}

// ── persistence environment (what this boundary can prove; every false/null is a reported edge) ──────────────────

export const APPROVED_PERSISTENCE_ROUTE: string | null = null;
export const PERSISTENCE_ROUTE_EVIDENCE =
  "FORWARD_BET_V1 writer exists only in protected Draft PR #526 (scripts/modeling/live-shadow-cycle.ts + lib/modeling/forwardBetContract.ts on claude/stoic-pasteur-c0r36x); main/this boundary has the legacy SAFE writer only (no contract_version). No manual SQL route is allowed.";
const FORWARD_COLUMNS = "row_key,row_kind,model_id,model_version,decision_kind,contract_version,physical_event_key,canonical_game_key,economic_unit_key,observed_at,decision_generated_at,scheduled_start_at,authoritative_start_at,authoritative_start_source,first_persisted_at,timing_class,timing_detail,contract_status,verification_status,observation_lag_seconds,lead_time_scheduled_seconds,lead_time_authoritative_seconds,executable_buy_price,executable_price_authority,executable_quote_at";

type Db = ReturnType<typeof createClient>;
const db = (): Db => { const { base, key } = cloneTarget(); return createClient(base, key, { auth: { persistSession: false, autoRefreshToken: false } }); };

/** Read-only: the deployed table exposes every FORWARD_BET_V1 column; count existing contract and legacy LEDGER rows. */
async function probeDeployedContract(client: Db) {
  const cols = await client.from(FORWARD_CONTRACT.table).select(FORWARD_COLUMNS).eq("contract_version", FORWARD_CONTRACT.version).limit(1);
  const contract = await client.from(FORWARD_CONTRACT.table).select("row_key", { count: "exact", head: true }).eq("contract_version", FORWARD_CONTRACT.version);
  const versioned = await client.from(FORWARD_CONTRACT.table).select("row_key", { count: "exact", head: true }).not("model_version", "is", null);
  const legacy = await client.from(FORWARD_CONTRACT.table).select("row_key", { count: "exact", head: true }).eq("row_kind", "LEDGER").is("contract_version", null);
  const firstPersisted = await client.from(FORWARD_CONTRACT.table).select("row_key", { count: "exact", head: true }).eq("row_kind", "LEDGER").not("first_persisted_at", "is", null);
  return {
    columns_verified: !cols.error, columns_error: cols.error?.code ?? null,
    contract_rows_n: contract.count ?? null, model_version_nonnull_rows_n: versioned.count ?? null,
    legacy_ledger_rows_n: legacy.count ?? null, ledger_rows_with_first_persisted_at_n: firstPersisted.count ?? null,
    trigger_body: "NOT_READABLE_FROM_THIS_SURFACE (PostgREST exposes no catalog; Supabase MCP execute_sql denied). Semantics from migration 20261012180000_virtual_bet_forward_contract_v1 (PR #526) + mission attestation.",
  };
}

/** Physical event keys already holding a LEDGER row for each model_id (legacy or contract): the trigger rejects re-claims.
 *  Exact while no FORWARD_BET_V1 row exists (probe contract_rows_n); contract rows can also claim via canonical_game_key /
 *  economic_unit_key, whose derivation lives only in protected PR #526, so with contract rows this is a lower bound. */
async function readExistingEconomicUnits(client: Db, keysByModel: Map<string, Set<string>>) {
  const out = new Map<string, Set<string>>();
  for (const [modelId, keys] of keysByModel) {
    const set = new Set<string>();
    const list = [...keys];
    for (let i = 0; i < list.length; i += 50) {
      const { data, error } = await client.from(FORWARD_CONTRACT.table).select("physical_event_key").eq("row_kind", "LEDGER").eq("model_id", modelId).in("physical_event_key", list.slice(i, i + 50));
      if (error) throw new Error(`EXISTING_UNITS_READ:${error.code ?? "FAILED"}`);
      for (const r of (data ?? []) as Array<{ physical_event_key: string }>) set.add(r.physical_event_key);
    }
    out.set(modelId, set);
  }
  return out;
}

/** Server-bounded clock: the decision is generated no earlier than the later of the local clock and the gateway Date. */
async function serverBoundedNow(): Promise<{ generatedMs: number; localMs: number; serverDateMs: number | null }> {
  const { base, key } = cloneTarget();
  const res = await fetch(`${base}/rest/v1/${FORWARD_CONTRACT.table}?select=row_key&limit=0`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const localMs = Date.now();
  const header = res.headers.get("date");
  const serverDateMs = header ? Date.parse(header) : null;
  return { generatedMs: Math.max(localMs, serverDateMs !== null && Number.isFinite(serverDateMs) ? serverDateMs + 999 : localMs), localMs, serverDateMs };
}

// ── football D-1: prove the absence of a prospective, settlement-free input path ─────────────────────────────────

async function probeFootballInputPath(client: Db, referenceMs: number) {
  const todayMinsk = new Date(referenceMs + 3 * 3_600_000).toISOString().slice(0, 10);
  const days = await client.from("research_model_ready_days").select("model_date,status").order("model_date", { ascending: false }).limit(1);
  const upcoming = await client.from("research_model_ready_rows").select("model_date", { count: "exact", head: true }).gte("model_date", todayMinsk);
  return { today_minsk: todayMinsk, latest_model_ready_day: (days.data?.[0] as { model_date?: string } | undefined)?.model_date ?? null, model_ready_rows_for_today_or_later_n: upcoming.count ?? null };
}

function footballBlock(probe: Awaited<ReturnType<typeof probeFootballInputPath>>): ModelEvaluation {
  return {
    status: "BLOCKED", reason: "FOOTBALL_D1_NO_PROSPECTIVE_SETTLEMENT_FREE_INPUT",
    evidence: `RunContext is built only by classifyOneDay <- research_model_ready_rows(model_date): a nightly D-1 materialization whose rows carry settlement_label and have no ingested_at column; latest MODEL_READY day=${probe.latest_model_ready_day}; rows for model_date>=${probe.today_minsk}: ${probe.model_ready_rows_for_today_or_later_n}. No other RunContext builder exists; replaying settlement-bearing rows as prospective is forbidden.`,
  };
}

// ── SAFE: chronological prefix replay over the SAFE owner's own projection ────────────────────────────────────────

const V4_COLUMNS = "observation_id,observed_at,ingested_at,item_observation_id,condition_id,selected_token_id,entry_price_num,pre_event_score_num,provider_event_id,provider_sport_family,market_type,event_title,market_question,game_start_iso,data_coverage";
const PAGE = 1000;
const LOOKBACK_HOURS = 72;
type V4Row = V4EvidenceRow & { ingested_at: string };
const minskDate = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);

/**
 * COMPLETE Minsk decision days (the owner reads whole dates) with NO event-start filter: events that already started or
 * start beyond the cohort horizon still competed for each day's cap and rank, so dropping them would let the replay
 * claim picks a real day would have cap-exhausted. Only the cohort join restricts to upcoming events.
 */
async function readSafeUniverse(client: Db, watermarkMs: number, referenceMs: number): Promise<V4Row[]> {
  const firstDay = minskDate(new Date(referenceMs - LOOKBACK_HOURS * 3_600_000).toISOString());
  const from = new Date(Date.parse(`${firstDay}T00:00:00.000Z`) - 3 * 3_600_000).toISOString();
  const rows: V4Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client.from("research_evidence_page_rows").select(V4_COLUMNS)
      .gte("observed_at", from).lte("ingested_at", new Date(watermarkMs).toISOString())
      .order("observed_at", { ascending: true }).order("observation_id", { ascending: true }).order("item_observation_id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`SAFE_UNIVERSE_READ:${error.code ?? "FAILED"}`);
    rows.push(...(data ?? []) as unknown as V4Row[]);
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

/** The SAFE owner's universe stage, reproduced from its own exported building blocks to expose per-model evaluation sets. */
function safeUniverseStage(rows: readonly V4Row[]) {
  const scorecard = rows.map((row) => ({
    populationId: "RESEARCH_EVIDENCE_V4", conditionId: row.condition_id, selectedTokenId: row.selected_token_id, providerEventId: row.provider_event_id,
    decisionAt: row.observed_at, entryPrice: numberOrNull(row.entry_price_num), eventStart: row.game_start_iso,
    sportFamily: resolveSportFamily({ providerSportFamily: row.provider_sport_family }), providerSportFamily: row.provider_sport_family,
    scoreLevel: numberOrNull(row.pre_event_score_num), score: EMPTY, selectedPrice: EMPTY, volumeUsd: null, leadTimeHours: null,
    marketTypeRaw: row.market_type, eventTitle: row.event_title, marketQuestion: row.market_question, dataCoverage: numberOrNull(row.data_coverage) ?? 0,
  }));
  const decisionCandidates = toSettlementFreeDecisionTimeCandidates(scorecard as never);
  const byIdentity = new Map<string, IdentityCandidate>(rows.map((r) => [`${r.condition_id}::${r.selected_token_id}::${r.observed_at}`, { createdAt: r.observed_at, structuredMarketType: r.market_type, marketText: r.market_question, eventIdentityText: r.event_title }]));
  const { safeUniverse } = buildSafeUniverse(decisionCandidates, (c, t, d) => byIdentity.get(`${c}::${t}::${d}`) ?? null);
  return { decisionCandidates, safeUniverse };
}
const EMPTY = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };

type SafePick = { candidateIdentity: string; physicalEventKey: string; decisionTimestamp: string; eventStart: string; entryPrice: number };

export function safePrefixSelector(date: string, models: readonly ModelRef[]) {
  return (prefix: readonly V4Row[]): PrefixSelection<SafePick> => {
    const { capped } = selectedByModel(prefix, date);
    const { decisionCandidates, safeUniverse } = safeUniverseStage(prefix);
    const universeIds = new Set(safeUniverse.map((c) => c.candidateIdentity));
    const predicateEvaluated = new Map<string, Set<string>>();
    const gateRejected = new Map<string, Set<string>>();
    const picks = new Map<string, SafePick[]>();
    for (const m of models) {
      const scoped = (sport: string) => m.sportScope === "ALL" || m.sportScope === sport;
      predicateEvaluated.set(m.modelId, new Set(safeUniverse.filter((c) => scoped(c.sportFamily)).map((c) => tokenKey(c.ref!, c.candidateRef!))));
      gateRejected.set(m.modelId, new Set(decisionCandidates.filter((c) => scoped(c.sportFamily) && !universeIds.has(c.candidateIdentity)).map((c) => tokenKey(c.ref!, c.candidateRef!))));
      const chosen = capped.get(m.modelId as (typeof MODEL_IDS)[number]) ?? [];
      for (const c of chosen) if (!universeIds.has(c.candidateIdentity)) throw new Error(`SAFE_UNIVERSE_PARITY_FAILED:${m.modelId}`);
      picks.set(m.modelId, chosen.map((c) => ({ candidateIdentity: c.candidateIdentity, physicalEventKey: c.physicalEventKey, decisionTimestamp: c.decisionTimestamp, eventStart: c.eventStart, entryPrice: c.entryPrice })));
    }
    return { picks, predicateEvaluated, gateRejected };
  };
}

/** Per Minsk decision date, replay every causal prefix (ingested_at order); claims are first-in-time and never revised. */
export function evaluateSafeModels(rows: readonly V4Row[], models: readonly ModelRef[]) {
  const safe = models.filter((m) => m.family === "SAFE_PREMATCH");
  const byDate = new Map<string, V4Row[]>();
  for (const r of rows) {
    if (!r.game_start_iso) continue;
    const d = minskDate(r.observed_at);
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(r);
  }
  // Duplicate identities (same condition::token::observed_at, different observation rows) take the LATEST ingest: a pick
  // is never treated as available before every row that could have produced it existed in the DB.
  const ingestedAt = new Map<string, string>();
  for (const r of rows) {
    const k = `${r.condition_id}::${r.selected_token_id}::${r.observed_at}`;
    const prev = ingestedAt.get(k);
    if (prev === undefined || Date.parse(r.ingested_at) > Date.parse(prev)) ingestedAt.set(k, r.ingested_at);
  }
  const bets = new Map<string, ModelBet[]>(safe.map((m) => [m.modelId, []]));
  const predicate = new Map(safe.map((m) => [m.modelId, new Set<string>()]));
  const gate = new Map(safe.map((m) => [m.modelId, new Set<string>()]));
  const replay = { dates: 0, instants: 0, inconsistent_availability_n: 0, cap_exhausted_n: 0 };
  for (const [date, dayRows] of [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const r = chronologicalClaims(dayRows, safe.map((m) => m.modelId), CAP, safePrefixSelector(date, safe));
    replay.dates++; replay.instants += r.instants; replay.inconsistent_availability_n += r.inconsistentAvailabilityN; replay.cap_exhausted_n += r.capExhaustedN;
    for (const m of safe) {
      for (const k of r.predicateEvaluated.get(m.modelId) ?? []) predicate.get(m.modelId)!.add(k);
      for (const k of r.gateRejected.get(m.modelId) ?? []) gate.get(m.modelId)!.add(k);
      for (const c of r.claims.get(m.modelId) ?? []) {
        const p = parseCandidateIdentity(c.candidateIdentity);
        if (!p) throw new Error(`SAFE_CANDIDATE_IDENTITY_UNPARSEABLE:${m.modelId}`);
        bets.get(m.modelId)!.push({
          candidateIdentity: c.candidateIdentity, conditionId: p.conditionId, tokenId: p.tokenId, observedAt: c.decisionTimestamp, eventStart: c.eventStart,
          entryPrice: c.entryPrice, modelPhysicalEventKey: c.physicalEventKey, sourceIngestedAt: ingestedAt.get(c.candidateIdentity) ?? null, claimInstant: c.claimInstant,
        });
      }
    }
  }
  const evaluations = new Map<string, ModelEvaluation>(safe.map((m) => [modelKey(m), {
    status: "EVALUATED", bets: bets.get(m.modelId)!, predicateEvaluatedTokenKeys: predicate.get(m.modelId)!, gateRejectedTokenKeys: gate.get(m.modelId)!,
  }]));
  return { evaluations, replay };
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
  const models = buildModels();
  const excluded = {
    control_in_play_not_prematch: CONTROL_STRATEGIES.map((s) => `${s.id}@${s.version}`),
    alpha_v0_facts_only_cannot_bet: ALPHA_PROGRAMS.map((s) => `${s.id}@${s.version}`),
  };
  try { cloneTarget(); } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const file = write({ version: FORWARD_DECISIONS_VERSION, business_pass: false, db_writes: 0, first_broken_edge: `RESEARCH_DBCLONE_READ_CAPABILITY:${reason}`, models, excluded });
    console.log(JSON.stringify({ file, business_pass: false, first_broken_edge: `RESEARCH_DBCLONE_READ_CAPABILITY:${reason}`, models_registered: models.length }, null, 2));
    process.exit(2);
  }
  const client = db();
  const t0 = Date.now();
  const run = await buildExecutableLiquidityCohort({ readSource });
  const safeRows = await readSafeUniverse(client, run.timing.dbIngestWatermarkMs, run.timing.referenceMs);
  const { evaluations, replay } = evaluateSafeModels(safeRows, models);
  const footballProbe = await probeFootballInputPath(client, run.timing.referenceMs);
  for (const m of models) if (m.family === "FOOTBALL_D1") evaluations.set(modelKey(m), footballBlock(footballProbe));
  const clock = await serverBoundedNow();
  const result = decideCohortModels(run.cohort, models, evaluations, clock.generatedMs);

  const bets = result.decisions.filter((d) => d.outcome === "BET");
  const books = await fetchOrderBooksConcurrent(bets.map((d) => d.bet!.tokenId), 6);
  const fees = await Promise.all(bets.map((d) => fetchTokenFeeSchedule(d.bet!.tokenId, { timeoutMs: 5000 })));
  const keysByModel = new Map<string, Set<string>>();
  for (const d of bets) (keysByModel.get(d.modelId) ?? keysByModel.set(d.modelId, new Set()).get(d.modelId)!).add(d.bet!.modelPhysicalEventKey);
  const contractProbe = await probeDeployedContract(client);
  const env: PersistenceEnvironment = {
    deployedContractColumnsVerified: contractProbe.columns_verified,
    existingEconomicUnitsByModelId: await readExistingEconomicUnits(client, keysByModel),
    approvedPersistenceRoute: APPROVED_PERSISTENCE_ROUTE,
    authoritativeStartSource: null, // cohort start = scored source game_start_iso confirmed against provider schedule (scheduled-only)
  };
  const nowMs = Date.now();
  const assessed = bets.map((d, i) => {
    const execution = assessExecution(d, books[i], fees[i], run.timing.snapshotReadCompletedLocalMs);
    return { decision: d, execution, persistence: persistenceReadiness(d, execution, env, nowMs) };
  });
  const count = (xs: readonly string[]) => xs.reduce<Record<string, number>>((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {});
  const firstEdges = count(assessed.map((a) => a.persistence.firstFailedEdge ?? "READY"));
  const allEdges = count(assessed.flatMap((a) => a.persistence.failedEdges));
  const executionBlocked = count(assessed.map((a) => a.execution.blockedAt?.reason ?? "NONE"));
  const summary = summarizeDecisions(result.decisions);
  const digests = new Set([result.digestBefore, result.digestAfter, ...Object.values(result.digestByModel)]);
  const cohortStable = digests.size === 1;
  const firstBroken = !cohortStable ? "COHORT_DIGEST_CHANGED"
    : bets.length === 0 ? "NO_MODEL_ELIGIBLE_BET_IN_COHORT"
    : assessed.every((a) => !a.persistence.ready) ? `PERSISTENCE:${PERSISTENCE_EDGES.find((e) => firstEdges[e]) ?? "UNKNOWN"}` : null;
  const receipt = {
    version: FORWARD_DECISIONS_VERSION, research_only: true, db_writes: 0, business_pass: false,
    clock: { decision_generated_at: new Date(clock.generatedMs).toISOString(), local_at: new Date(clock.localMs).toISOString(), server_date_header_at: clock.serverDateMs ? new Date(clock.serverDateMs).toISOString() : null, run_seconds: Math.round((nowMs - t0) / 1000) },
    cohort: { version: run.cohort.version, digest_before: result.digestBefore, digest_after: result.digestAfter, digest_by_model: result.digestByModel, stable: cohortStable, funnel: run.funnel },
    safe_replay: { rows: safeRows.length, ...replay },
    football_input_probe: footballProbe,
    deployed_contract: { ...FORWARD_CONTRACT, probe: contractProbe, approved_persistence_route: APPROVED_PERSISTENCE_ROUTE, route_evidence: PERSISTENCE_ROUTE_EVIDENCE },
    models, excluded, summary, out_of_cohort_bets: result.outOfCohortBets, uniqueness_violations: result.uniquenessViolations,
    execution_blocked_reasons: executionBlocked, persistence_first_failed_edges: firstEdges, persistence_all_failed_edges: allEdges, first_broken_edge: firstBroken,
    decisions: result.decisions, bets: assessed,
  };
  const file = write(receipt);
  // Terminal: aggregates only.
  console.log(JSON.stringify({ file, clock: receipt.clock, cohort: { ...receipt.cohort, funnel: undefined }, safe_replay: receipt.safe_replay, football_input_probe: footballProbe, deployed_contract_probe: contractProbe, summary, execution_blocked_reasons: executionBlocked, persistence_first_failed_edges: firstEdges, persistence_all_failed_edges: allEdges, first_broken_edge: firstBroken }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
