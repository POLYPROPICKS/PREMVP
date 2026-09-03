/**
 * SCORE_LEVEL_DIRECTIONAL_EVIDENCE_V1 — bounded read-only runner.
 *
 * Score-band hypothesis study on generated_signal_pairs.pre_event_score_num,
 * for the two fully closed Sep-01 / Sep-02 Europe/Minsk days, restricted to
 * the two Score-populated rich producer populations. Not C4-gated — this is
 * a standalone Score-level study, independent of the C4 price/sport/lead-time
 * predicate. SEP_SHADOW_STRATEGIC_V1 is excluded (Score structurally absent).
 *
 * Reuses UNCHANGED:
 *   - lib/modeling/research-engine/settlement.ts (settleBetU, flat 1u stake)
 *   - lib/modeling/research-engine/metrics.ts (maxDrawdownU, round)
 *   - lib/feed/resolveSignalOutcome.ts (Gamma terminal-state settlement authority)
 *
 * Reuses the PROVEN PATTERNS from scripts/modeling/sep02-clone-c4-scoreboard.ts:
 *   - project-ref + credential-class clone resolution (SUPABASE_URL must
 *     resolve to nppznoujvnyjargjkmnv; privileged sb_secret_-class key found
 *     by value, not env-var name)
 *   - keyset pagination (not OFFSET/range)
 *   - physical-event identity + chronological-first collapse (one bet per
 *     physical event)
 *
 * No writes. No schema changes. No C4 predicate involved. No threshold search
 * beyond the four predeclared bands.
 *
 *   npx tsx scripts/modeling/sep0102-score-level-study.ts
 */
import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { settleBetU } from "../../lib/modeling/research-engine/settlement";
import { round, maxDrawdownU } from "../../lib/modeling/research-engine/metrics";
import type { Outcome, SelectedBet } from "../../lib/modeling/research-engine/types";
import { fetchGammaMarketByConditionId, resolveSignalOutcome } from "../../lib/feed/resolveSignalOutcome";

const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
const EXPECTED_PRODUCTION_REF = "nbnldzfsxffztsfrrxqy";

// Sep-01 00:00 Minsk (inclusive) -> Sep-03 00:00 Minsk (exclusive)
const SEP01_START = "2026-08-31T21:00:00.000Z";
const SEP01_END = "2026-09-01T21:00:00.000Z"; // == SEP02_START
const SEP02_END = "2026-09-02T21:00:00.000Z";

type PopulationId = "SEP_PUBLIC_RICH_V1" | "SEP_FIREMODEL1_1_RESEARCH_V0";
const POPULATION_FORMULA_VERSION: Record<PopulationId, string> = {
  SEP_PUBLIC_RICH_V1: "trusted-initial-formula-v1.1",
  SEP_FIREMODEL1_1_RESEARCH_V0: "shadow-firemodel1_1_research_v0",
};

type ScoreBand = "50-59" | "60-69" | "70-79" | "80+";
const BANDS: ScoreBand[] = ["50-59", "60-69", "70-79", "80+"];
function bandOf(score: number): ScoreBand | null {
  if (score >= 50 && score < 60) return "50-59";
  if (score >= 60 && score < 70) return "60-69";
  if (score >= 70 && score < 80) return "70-79";
  if (score >= 80) return "80+";
  return null; // below 50 — out of the predeclared bands, not silently pooled
}

function credentialClass(key: string): "sb_secret" | "sb_publishable" | "jwt" | "unknown" {
  if (key.startsWith("sb_secret_")) return "sb_secret";
  if (key.startsWith("sb_publishable_")) return "sb_publishable";
  if (key.split(".").length === 3) return "jwt";
  return "unknown";
}

function resolveCloneClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("BLOCKED_NO_SUPABASE_URL_CONFIGURED");
  const ref = new URL(url).hostname.split(".")[0];
  if (ref === EXPECTED_PRODUCTION_REF) throw new Error("BLOCKED_PRODUCTION_REF_REJECTED");
  if (ref !== EXPECTED_CLONE_REF) throw new Error(`BLOCKED_NO_BINDING_MATCHES_CLONE_REF: ${ref}`);

  let privilegedKeyVar: string | null = null;
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && credentialClass(v) === "sb_secret") {
      privilegedKeyVar = k;
      break;
    }
  }
  const key = privilegedKeyVar ? (process.env[privilegedKeyVar] as string) : process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("BLOCKED_NO_SUPABASE_CREDENTIAL_CONFIGURED");
  console.log(
    JSON.stringify({
      resolvedBindingProjectRef: ref,
      matchesExpectedCloneRef: true,
      credentialEnvVarUsed: privilegedKeyVar ?? "SUPABASE_SERVICE_ROLE_KEY",
      credentialClass: privilegedKeyVar ? "sb_secret" : credentialClass(key),
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
  preEventScoreNum: number | null;
  providerEventId: string | null;
  formulaVersion: string | null;
}

async function fetchGspWindow(client: SupabaseClient): Promise<RawGsp[]> {
  const pageSize = 1000;
  const out: RawGsp[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorConditionId: string | null = null;
  const formulaVersions = new Set(Object.values(POPULATION_FORMULA_VERSION));
  while (true) {
    // Filtering by formula_version in the query (even via .in()) changed the
    // query plan enough to time out against the ~2.86M-row table; the
    // date-range + keyset shape already proven in sep02-clone-c4-scoreboard.ts
    // fetches everything in range and filters formula_version client-side instead.
    let query = client
      .from("generated_signal_pairs")
      .select("condition_id, selected_token_id, created_at, entry_price_num, pre_event_score_num, diagnostics, formula_version")
      .not("condition_id", "is", null)
      .not("selected_token_id", "is", null)
      .gte("created_at", SEP01_START)
      .lt("created_at", SEP02_END)
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
      const fv = str(r.formula_version);
      if (fv === null || !formulaVersions.has(fv)) continue;
      const d = obj(r.diagnostics);
      out.push({
        conditionId: String(r.condition_id),
        selectedTokenId: String(r.selected_token_id),
        createdAt: String(r.created_at),
        entryPriceNum: num(r.entry_price_num),
        preEventScoreNum: num(r.pre_event_score_num),
        providerEventId: str(d.providerEventId),
        formulaVersion: fv,
      });
    }
    if (chunk.length < pageSize) break;
    const last = chunk[chunk.length - 1];
    cursorCreatedAt = String(last.created_at);
    cursorConditionId = String(last.condition_id);
  }
  return out;
}

function physicalEventKeyOf(r: { providerEventId: string | null; conditionId: string; selectedTokenId: string }): string {
  return r.providerEventId ?? `NO_PROVIDER_EVENT_ID::${r.conditionId}::${r.selectedTokenId}`;
}

/** One bet per physical event: chronological-first row wins — identical rule to research-engine/engine.ts runModel. */
function collapseToPhysicalEvents(rows: RawGsp[]): RawGsp[] {
  const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const claimed = new Set<string>();
  const out: RawGsp[] = [];
  for (const r of sorted) {
    const key = physicalEventKeyOf(r);
    if (claimed.has(key)) continue;
    claimed.add(key);
    out.push(r);
  }
  return out;
}

type SettlementCategory = "WIN" | "LOSS" | "VOID" | "OPEN" | "NO_MATCH" | "AMBIGUOUS";
function classifySettlement(resolverState: string, signalResult: "won" | "lost" | null): SettlementCategory {
  if (resolverState === "resolved_candidate") return signalResult === "won" ? "WIN" : "LOSS";
  if (resolverState === "active_unresolved") return "OPEN";
  if (resolverState === "lookup_failed") return "NO_MATCH";
  return "AMBIGUOUS";
}

interface SettledBetRecord {
  decisionAt: string; // == createdAt
  category: SettlementCategory;
  pnlU: number | null; // WIN/LOSS only
  score: number | null;
}

/** Bounded concurrency pool — avoids thousands of sequential Gamma HTTP round-trips. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function settleBets(events: RawGsp[]): Promise<SettledBetRecord[]> {
  const gammaCache = new Map<string, Awaited<ReturnType<typeof fetchGammaMarketByConditionId>>>();
  return mapWithConcurrency(events, 20, async (row) => {
    let market = gammaCache.get(row.conditionId);
    if (market === undefined) {
      market = await fetchGammaMarketByConditionId(row.conditionId);
      gammaCache.set(row.conditionId, market);
    }
    const resolved = resolveSignalOutcome({
      conditionId: row.conditionId,
      selectedTokenId: row.selectedTokenId,
      entryPriceNum: row.entryPriceNum,
      market,
    });
    const category = classifySettlement(resolved.resolverState, resolved.signalResult);
    const pnlU =
      (category === "WIN" || category === "LOSS") && row.entryPriceNum != null
        ? settleBetU(category as Outcome, row.entryPriceNum)
        : null;
    return { decisionAt: row.createdAt, category, pnlU, score: row.preEventScoreNum };
  });
}

interface BandReport {
  band: string;
  uniquePhysicalEvents: number;
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
  winRatePct: number | null;
  pnlPer100Bets: number;
}

function reportFor(label: string, records: SettledBetRecord[]): BandReport {
  const counts: Record<SettlementCategory, number> = { WIN: 0, LOSS: 0, VOID: 0, OPEN: 0, NO_MATCH: 0, AMBIGUOUS: 0 };
  for (const r of records) counts[r.category] += 1;

  const winLoss = records
    .filter((r) => r.category === "WIN" || r.category === "LOSS")
    .sort((a, b) => (a.decisionAt < b.decisionAt ? -1 : a.decisionAt > b.decisionAt ? 1 : 0));
  const selectedBets: SelectedBet[] = winLoss.map((r) => ({
    physicalEventKey: "",
    decisionTimestamp: r.decisionAt,
    eventStart: r.decisionAt,
    leadTimeHours: 0,
    entryPrice: 0,
    sportFamily: "",
    outcome: r.category as Outcome,
    pnlU: r.pnlU as number,
  }));
  const pnlU = selectedBets.reduce((s, b) => s + b.pnlU, 0);
  const settledN = counts.WIN + counts.LOSS;
  const bets = records.length;
  const roiPct = bets === 0 ? 0 : (pnlU / bets) * 100;
  const maxDd = maxDrawdownU(selectedBets);
  const winRatePct = settledN === 0 ? null : round((counts.WIN / settledN) * 100, 2);

  return {
    band: label,
    uniquePhysicalEvents: bets,
    bets,
    settledN,
    win: counts.WIN,
    loss: counts.LOSS,
    void_: counts.VOID,
    open: counts.OPEN,
    noMatch: counts.NO_MATCH,
    ambiguous: counts.AMBIGUOUS,
    pnlUnits: round(pnlU, 2),
    roiPct: round(roiPct, 4),
    maxDrawdownUnits: round(maxDd, 2),
    winRatePct,
    pnlPer100Bets: bets === 0 ? 0 : round((pnlU / bets) * 100, 2),
  };
}

async function main() {
  loadEnvConfig(process.cwd());
  const client = resolveCloneClient();

  const rawGsp = await fetchGspWindow(client);

  const byPopulation = new Map<PopulationId, RawGsp[]>();
  for (const [pop, fv] of Object.entries(POPULATION_FORMULA_VERSION) as [PopulationId, string][]) {
    byPopulation.set(pop, rawGsp.filter((r) => r.formulaVersion === fv));
  }

  const output: Record<string, unknown> = {};

  for (const [population, rows] of byPopulation) {
    const rawRows = rows.length;
    const withScore = rows.filter((r) => r.preEventScoreNum != null);
    const scoreCoveragePct = rawRows === 0 ? 0 : round((withScore.length / rawRows) * 100, 2);
    const scoreValues = withScore.map((r) => r.preEventScoreNum as number);
    const scoreMin = scoreValues.length ? Math.min(...scoreValues) : null;
    const scoreMax = scoreValues.length ? Math.max(...scoreValues) : null;

    // Sep-01 / Sep-02 raw split, then collapse to one bet per physical event
    // WITHIN each day (a physical event decided on one day is one bet that day;
    // the two days do not share physical-event identity claims).
    const sep01Raw = rows.filter((r) => r.createdAt < SEP01_END);
    const sep02Raw = rows.filter((r) => r.createdAt >= SEP01_END);
    const sep01Selected = collapseToPhysicalEvents(sep01Raw);
    const sep02Selected = collapseToPhysicalEvents(sep02Raw);
    const combinedSelected = [...sep01Selected, ...sep02Selected];

    const [sep01Settled, sep02Settled] = await Promise.all([settleBets(sep01Selected), settleBets(sep02Selected)]);
    const combinedSettled = [...sep01Settled, ...sep02Settled];

    const baseline = {
      combined: reportFor("BASELINE_NO_SCORE_RESTRICTION", combinedSettled),
      sep01: reportFor("BASELINE_NO_SCORE_RESTRICTION", sep01Settled),
      sep02: reportFor("BASELINE_NO_SCORE_RESTRICTION", sep02Settled),
    };

    const bandReports: Record<string, unknown> = {};
    for (const band of BANDS) {
      const sep01Band = sep01Settled.filter((r) => r.score != null && bandOf(r.score) === band);
      const sep02Band = sep02Settled.filter((r) => r.score != null && bandOf(r.score) === band);
      const combinedBand = [...sep01Band, ...sep02Band];
      bandReports[band] = {
        combined: reportFor(band, combinedBand),
        sep01: sep01Band.length > 0 ? reportFor(band, sep01Band) : { band, note: "N=0 on Sep-01" },
        sep02: sep02Band.length > 0 ? reportFor(band, sep02Band) : { band, note: "N=0 on Sep-02" },
      };
    }

    output[population] = {
      rawRows,
      scoreCoveragePct,
      scoreMin,
      scoreMax,
      uniquePhysicalEventsCombined: combinedSelected.length,
      uniquePhysicalEventsSep01: sep01Selected.length,
      uniquePhysicalEventsSep02: sep02Selected.length,
      baseline,
      scoreBands: bandReports,
    };
  }

  console.log(
    JSON.stringify(
      {
        command: "SCORE_LEVEL_DIRECTIONAL_EVIDENCE_V1",
        label: "TWO_DAY_DIRECTIONAL_EVIDENCE",
        note: "Hypothesis evidence only, not accepted alpha or a production policy change. No promotion decision may be based on one strong day alone.",
        provenance: {
          sourceProjectRef: EXPECTED_CLONE_REF,
          window: { sep01: [SEP01_START, SEP01_END], sep02: [SEP01_END, SEP02_END] },
          scoreField: "generated_signal_pairs.pre_event_score_num",
        },
        excluded: { SEP_SHADOW_STRATEGIC_V1: "Score structurally absent — not included in this study" },
        bands: BANDS,
        populations: output,
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
