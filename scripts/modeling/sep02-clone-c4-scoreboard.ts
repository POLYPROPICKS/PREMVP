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

/**
 * Population lineage mapping — corrected to the exact generated_signal_pairs
 * .formula_version values actually observed on the real 2026-09-02 clone
 * rows (probed directly, not assumed): "shadow-strategic-sports-v1",
 * "trusted-initial-formula-v1.1" (the scored non-shadow / "rich" lineage
 * actually in use — NOT "v2-lite-growth-safe", which does not appear in
 * this window), and "shadow-firemodel1_1_research_v0" (a distinct research
 * shadow lineage, kept separate from both). Any other/null value is
 * genuinely UNCLASSIFIED — on the probed window this was empty.
 */
type PopulationId =
  | "SEP_SHADOW_STRATEGIC_V1"
  | "SEP_PUBLIC_RICH_V1"
  | "SEP_FIREMODEL1_1_RESEARCH_V0"
  | "UNCLASSIFIED";
const SHADOW_STRATEGIC_FORMULA_VERSION = "shadow-strategic-sports-v1";
const PUBLIC_RICH_FORMULA_VERSION = "trusted-initial-formula-v1.1";
const FIREMODEL1_1_RESEARCH_FORMULA_VERSION = "shadow-firemodel1_1_research_v0";

function classifyPopulation(formulaVersion: string | null): PopulationId {
  if (formulaVersion === SHADOW_STRATEGIC_FORMULA_VERSION) return "SEP_SHADOW_STRATEGIC_V1";
  if (formulaVersion === PUBLIC_RICH_FORMULA_VERSION) return "SEP_PUBLIC_RICH_V1";
  if (formulaVersion === FIREMODEL1_1_RESEARCH_FORMULA_VERSION) return "SEP_FIREMODEL1_1_RESEARCH_V0";
  return "UNCLASSIFIED";
}

/**
 * The physical-event identity used by C4/research-engine's one-bet-per-event
 * semantics (research-engine/types.ts ResearchEngineInputEvent.physicalEventKey).
 * Uses the real provider event id when present; falls back to the
 * condition+token market/side identity only when it is absent, and the
 * fallback is tagged so it is never confused with a real provider event id.
 */
function physicalEventKeyOf(r: { providerEventId: string | null; conditionId: string; selectedTokenId: string }): string {
  return r.providerEventId ?? `NO_PROVIDER_EVENT_ID::${r.conditionId}::${r.selectedTokenId}`;
}

/** Chronological-first collapse to one row per physical event — identical rule to research-engine/engine.ts runModel's claimedKeys collapse, applied here so both the eligibility count and the settled bet count share one identity. */
function collapseToPhysicalEvents<T extends { decisionAt: string; providerEventId: string | null; conditionId: string; selectedTokenId: string }>(
  rows: T[],
): T[] {
  const sorted = [...rows].sort((a, b) => (a.decisionAt < b.decisionAt ? -1 : a.decisionAt > b.decisionAt ? 1 : 0));
  const claimed = new Set<string>();
  const out: T[] = [];
  for (const r of sorted) {
    const key = physicalEventKeyOf(r);
    if (claimed.has(key)) continue;
    claimed.add(key);
    out.push(r);
  }
  return out;
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

type EventStartSourceClass =
  | "GSP_DIAGNOSTICS"
  | "GSRS_EXACT_IDENTITY_MATCH"
  | "GSRS_CONDITION_ID_MATCH"
  | "NONE_AVAILABLE";

/**
 * Recovers eventStartIso using ONLY exact-identity clone data, in the
 * mission's stated precedence:
 *   1. direct GSP field (diagnostics.gameStartIso) — pair.eventStartIso as fetched;
 *   2. exact identity match (condition_id + selected_token_id) against
 *      generated_signal_research_snapshots.game_start_iso, PIT-filtered
 *      (snapshot_at <= decision_at) — this is what the unchanged materializer
 *      already does internally when eventStartIso is null;
 *   3. condition_id-only match against the same table/column, still PIT-filtered.
 *      Game start time is a property of the physical market, not the selected
 *      side, so a snapshot recorded against the OPPOSING token of the same
 *      condition_id is still an exact-identity source, never a slug/text guess.
 * Step 3 is computed here (not inside the unchanged materializer) precisely so
 * it only fires when steps 1 and 2 both fail — never overriding the
 * materializer's own exact-token match.
 */
function resolveEventStart(
  pair: { conditionId: string; selectedTokenId: string; decisionAt: string; eventStartIso: string | null },
  observationsByConditionId: Map<string, ForwardRichSnapshotObservation[]>,
): { eventStartIso: string | null; sourceClass: EventStartSourceClass } {
  if (pair.eventStartIso != null) {
    return { eventStartIso: pair.eventStartIso, sourceClass: "GSP_DIAGNOSTICS" };
  }
  const sameCondition = (observationsByConditionId.get(pair.conditionId) ?? [])
    .filter((o) => o.snapshotAt <= pair.decisionAt)
    .sort((a, b) => (a.snapshotAt < b.snapshotAt ? -1 : a.snapshotAt > b.snapshotAt ? 1 : 0));

  const exactTokenHit = sameCondition.find((o) => o.selectedTokenId === pair.selectedTokenId && o.gameStartIso != null);
  if (exactTokenHit) {
    return { eventStartIso: exactTokenHit.gameStartIso, sourceClass: "GSRS_EXACT_IDENTITY_MATCH" };
  }
  const conditionOnlyHit = sameCondition.find((o) => o.gameStartIso != null);
  if (conditionOnlyHit) {
    return { eventStartIso: conditionOnlyHit.gameStartIso, sourceClass: "GSRS_CONDITION_ID_MATCH" };
  }
  return { eventStartIso: null, sourceClass: "NONE_AVAILABLE" };
}

interface CoverageBeforeAfter {
  beforePct: number;
  afterPct: number;
  sourceClassCounts: Record<EventStartSourceClass, number>;
}

/** Enriches eventStartIso in place (returns new pair objects) and reports before/after coverage. */
function enrichEventStart(
  pairs: ForwardRichSignalPair[],
  observations: ForwardRichSnapshotObservation[],
): { enriched: ForwardRichSignalPair[]; coverage: CoverageBeforeAfter } {
  const observationsByConditionId = new Map<string, ForwardRichSnapshotObservation[]>();
  for (const o of observations) {
    const bucket = observationsByConditionId.get(o.conditionId);
    if (bucket) bucket.push(o);
    else observationsByConditionId.set(o.conditionId, [o]);
  }

  const sourceClassCounts: Record<EventStartSourceClass, number> = {
    GSP_DIAGNOSTICS: 0,
    GSRS_EXACT_IDENTITY_MATCH: 0,
    GSRS_CONDITION_ID_MATCH: 0,
    NONE_AVAILABLE: 0,
  };
  const enriched: ForwardRichSignalPair[] = [];
  for (const pair of pairs) {
    const { eventStartIso, sourceClass } = resolveEventStart(pair, observationsByConditionId);
    sourceClassCounts[sourceClass] += 1;
    enriched.push({ ...pair, eventStartIso });
  }

  const n = pairs.length || 1;
  const beforeResolved = sourceClassCounts.GSP_DIAGNOSTICS + sourceClassCounts.GSRS_EXACT_IDENTITY_MATCH;
  const afterResolved = beforeResolved + sourceClassCounts.GSRS_CONDITION_ID_MATCH;

  return {
    enriched,
    coverage: {
      beforePct: Math.round((beforeResolved / n) * 10000) / 100,
      afterPct: Math.round((afterResolved / n) * 10000) / 100,
      sourceClassCounts,
    },
  };
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
  rawRows: number;
  compactRows: number;
  uniquePhysicalEventsInCompact: number;
  c4EligiblePhysicalEvents: number;
  bets: number;
  settledN: number;
  win: number;
  loss: number;
  void_: number;
  open: number;
  noMatch: number;
  ambiguous: number;
  pnlUnits: number | null;
  roiPct: number | null;
  maxDrawdownUnits: number | null;
  winRatePct: number | null;
  pnlPer100Bets: number | null;
  coverage: {
    entryPricePct: number;
    sportPct: number;
    leadTimeHoursPct: number;
    sportLeadTimePct: number;
    scorePct: number;
    volumePct: number;
    providerEventIdPct: number;
  };
  eventStartEnrichment: CoverageBeforeAfter;
}

async function runForPopulation(
  population: PopulationId,
  rawRowCount: number,
  compactRows: ForwardRichResearchRow[],
  eventStartEnrichment: CoverageBeforeAfter,
): Promise<PopulationReport> {
  const c4 = FROZEN_MODELS.C4;
  const eligibleByRow = compactRows.filter((r) => {
    if (r.entryPrice == null || r.leadTimeHours == null) return false;
    const sportFamily = (r.providerSportFamily ?? r.providerSportCode ?? "").toLowerCase();
    return c4.predicate({
      entryPrice: r.entryPrice,
      sportFamily,
      leadTimeHours: r.leadTimeHours,
    } as any);
  });
  // UNIQUE_PHYSICAL_EVENTS: collapse to one row per physical event using the
  // exact chronological-first rule research-engine/engine.ts runModel applies
  // internally, so "C4 eligible physical events" and "Bets" share one identity.
  const eligiblePhysicalEvents = collapseToPhysicalEvents(eligibleByRow);

  const settlementCounts: Record<SettlementCategory, number> = {
    WIN: 0,
    LOSS: 0,
    VOID: 0,
    OPEN: 0,
    NO_MATCH: 0,
    AMBIGUOUS: 0,
  };
  const winLossInput: ResearchEngineInputEvent[] = [];

  for (const row of eligiblePhysicalEvents) {
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
        physicalEventKey: physicalEventKeyOf(row),
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
  const bets = eligiblePhysicalEvents.length; // one bet per physical event, by construction
  const pnlPer100 = bets === 0 ? 0 : Math.round((modelResult.PNL_U / bets) * 100 * 100) / 100;
  const winRatePct = settledN === 0 ? null : Math.round((modelResult.WINS / settledN) * 10000) / 100;

  const withEntryPrice = compactRows.filter((r) => r.entryPrice != null).length;
  const withSport = compactRows.filter((r) => (r.providerSportFamily ?? r.providerSportCode ?? null) != null).length;
  const withLeadTime = compactRows.filter((r) => r.leadTimeHours != null).length;
  const withSportLeadTime = compactRows.filter(
    (r) => (r.providerSportFamily ?? r.providerSportCode ?? null) != null && r.leadTimeHours != null,
  ).length;
  const withScore = compactRows.filter((r) => r.score.observationCount > 0).length;
  const withVolume = compactRows.filter((r) => r.volumeUsd != null).length;
  const withProviderEventId = compactRows.filter((r) => r.providerEventId != null).length;
  const pct = (n: number) => (compactRows.length === 0 ? 0 : Math.round((n / compactRows.length) * 10000) / 100);

  return {
    population,
    period: "2026-09-02 (Europe/Minsk, single day)",
    rawRows: rawRowCount,
    compactRows: compactRows.length,
    uniquePhysicalEventsInCompact: collapseToPhysicalEvents(compactRows).length,
    c4EligiblePhysicalEvents: eligiblePhysicalEvents.length,
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
    winRatePct,
    pnlPer100Bets: pnlPer100,
    coverage: {
      entryPricePct: pct(withEntryPrice),
      sportPct: pct(withSport),
      leadTimeHoursPct: pct(withLeadTime),
      sportLeadTimePct: pct(withSportLeadTime),
      scorePct: pct(withScore),
      volumePct: pct(withVolume),
      providerEventIdPct: pct(withProviderEventId),
    },
    eventStartEnrichment,
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
  // Explicit, separately-named source-stage units — never conflated.
  const distinctProviderEventId = new Set(rawGsp.map((r) => r.providerEventId).filter((v): v is string => v != null)).size;
  const distinctPhysicalEventKey = new Set(rawGsp.map((r) => physicalEventKeyOf(r))).size;
  const distinctConditionId = new Set(rawGsp.map((r) => r.conditionId)).size;
  const rawProviderEventIdCoveragePct =
    rawGspRows === 0 ? 0 : Math.round((rawGsp.filter((r) => r.providerEventId != null).length / rawGspRows) * 10000) / 100;

  const byPopulation = new Map<PopulationId, RawGsp[]>();
  for (const row of rawGsp) {
    const pop = classifyPopulation(row.formulaVersion);
    const bucket = byPopulation.get(pop) ?? [];
    bucket.push(row);
    byPopulation.set(pop, bucket);
  }

  // Invariant: raw population row counts must reconcile to the raw denominator.
  const populationRowSum = [...byPopulation.values()].reduce((sum, rows) => sum + rows.length, 0);
  const invariantFailures: string[] = [];
  if (populationRowSum !== rawGspRows) {
    invariantFailures.push(
      `POPULATION_ROW_SUM_MISMATCH: sum(population raw rows)=${populationRowSum} !== rawGspRows=${rawGspRows}`,
    );
  }

  const materializedAt = new Date().toISOString();
  const funnel: Record<string, unknown> = {};
  const reports: PopulationReport[] = [];
  let allCompactRows: ForwardRichResearchRow[] = [];

  for (const [population, rows] of byPopulation) {
    const compactPairs = compactSignalPairs(rows);
    // Fills eventStartIso gaps from exact-identity clone data only (see
    // resolveEventStart doc) before the unchanged materializer runs, so its
    // own PIT rule and exact-token fallback still apply to whatever remains.
    const { enriched: enrichedPairs, coverage: eventStartEnrichment } = enrichEventStart(compactPairs, observations);
    const compactRows = materializeForwardRichResearch({
      signalPairs: enrichedPairs,
      observations,
      sinceCutoff: SINCE_CUTOFF,
      materializedAt,
    });
    allCompactRows = allCompactRows.concat(compactRows);

    const uniquePhysicalEvents = collapseToPhysicalEvents(compactRows).length;
    // Invariant: per-population UNIQUE_PHYSICAL_EVENTS <= that population's compact rows.
    if (uniquePhysicalEvents > compactRows.length) {
      invariantFailures.push(
        `${population}: UNIQUE_PHYSICAL_EVENTS(${uniquePhysicalEvents}) > compactRows(${compactRows.length})`,
      );
    }

    funnel[population] = {
      rawRows: rows.length,
      compactRows: compactRows.length,
      compressionRatio: compactRows.length === 0 ? null : Math.round((rows.length / compactRows.length) * 100) / 100,
      DISTINCT_PROVIDER_EVENT_ID: new Set(compactRows.map((r) => r.providerEventId).filter((v): v is string => v != null)).size,
      DISTINCT_CONDITION_ID: new Set(compactRows.map((r) => r.conditionId)).size,
      UNIQUE_PHYSICAL_EVENTS: uniquePhysicalEvents,
    };

    reports.push(await runForPopulation(population, rows.length, compactRows, eventStartEnrichment));
  }

  // Invariant: no per-population UNIQUE_PHYSICAL_EVENTS may exceed the global
  // count measured with the exact same physical-event key.
  const globalUniquePhysicalEvents = collapseToPhysicalEvents(allCompactRows).length;
  for (const [population, entry] of Object.entries(funnel)) {
    const upe = (entry as { UNIQUE_PHYSICAL_EVENTS: number }).UNIQUE_PHYSICAL_EVENTS;
    if (upe > globalUniquePhysicalEvents) {
      invariantFailures.push(`${population}: UNIQUE_PHYSICAL_EVENTS(${upe}) > global(${globalUniquePhysicalEvents})`);
    }
  }
  // Invariant: Bets <= C4 eligible physical events (equality by construction here).
  for (const r of reports) {
    if (r.bets > r.c4EligiblePhysicalEvents) {
      invariantFailures.push(`${r.population}: bets(${r.bets}) > c4EligiblePhysicalEvents(${r.c4EligiblePhysicalEvents})`);
    }
  }

  const correctionRequired = invariantFailures.length > 0;
  const publishedReports = correctionRequired
    ? reports.map((r) => ({ ...r, pnlUnits: null, roiPct: null, maxDrawdownUnits: null, winRatePct: null, pnlPer100Bets: null }))
    : reports;

  console.log(
    JSON.stringify(
      {
        command: "REAL_C4_SCOREBOARD_SEMANTICALLY_ACCEPTED",
        status: correctionRequired ? "CORRECTION_REQUIRED" : "OK",
        invariantFailures,
        provenance: {
          sourceProjectRef: EXPECTED_CLONE_REF,
          window: { minskDate: "2026-09-02", utcStart: WINDOW_START, utcEnd: WINDOW_END },
        },
        sourceStage: {
          rawGspRows,
          DISTINCT_PROVIDER_EVENT_ID: distinctProviderEventId,
          DISTINCT_PHYSICAL_EVENT_KEY: distinctPhysicalEventKey,
          DISTINCT_CONDITION_ID: distinctConditionId,
          providerEventIdCoveragePct: rawProviderEventIdCoveragePct,
          note:
            rawProviderEventIdCoveragePct < 100
              ? `provider_event_id absent on ${Math.round((100 - rawProviderEventIdCoveragePct) * 100) / 100}% of raw rows; DISTINCT_PHYSICAL_EVENT_KEY falls back to condition_id::selected_token_id for those rows (tagged NO_PROVIDER_EVENT_ID::...)`
              : "provider_event_id present on all raw rows",
        },
        populationRawRowReconciliation: { populationRowSum, rawGspRows, matches: populationRowSum === rawGspRows },
        compressionByPopulation: funnel,
        globalUniquePhysicalEvents,
        weeklyStability: "NOT_YET_MEASURABLE (single-day slice)",
        c4PredicateUnchanged: FROZEN_MODELS.C4.predicateDescription,
        scoreboard: publishedReports,
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
