/**
 * QUALITY_FILL_PORTFOLIO_TEST_V1 — extends DAILY_CAP_PNL_OPTIMIZATION_V1 (this
 * same PR) by testing a SMALL FIXED SET of evidence-backed daily portfolio
 * fill strategies against the existing P50_52/PORTFOLIO_BROAD baselines.
 *
 * Business question: can a simple evidence-backed quality ordering beat
 * P50_52 @ cap50 while preserving/improving 30-50/day supply?
 * This is a fixed-candidate allocation test, not a threshold/score sweep.
 *
 * ENGINE_REUSE: runStandalone/runPortfolio/computeDailyResults/computeCapacity/
 * applyDailyCap imported verbatim from scripts/modeling/daily-portfolio-frontier.ts —
 * one capacity-selection authority for both baseline and candidate cap50 selections.
 * The only new code is the FIXED tier predicates for the QUALITY_FILL A/B/C/D
 * candidates (ordinary price/sport-family boolean composition of the same
 * fields the frozen engine already exposes) and the reporting/aggregation
 * around them. No new score threshold. No new capacity engine.
 *
 * SELECTION_BEFORE_SETTLEMENT_V1: P50_52, PORTFOLIO_BROAD, QUALITY_FILL_A and
 * QUALITY_FILL_D (this mission's four required models) are wired to the
 * decision-time-only selection path (toDecisionTimeSelectionInput /
 * runStandaloneStrict / runPortfolioStrict / computePartialCapacity /
 * partialDailyResults / partialMetricsFor / settledBetsOnly — all imported
 * verbatim). Their tables report SELECTED_N/SETTLED_N/OPEN_N/
 * OTHER_NONTERMINAL_N/SETTLED_PNL_U_PARTIAL/SETTLEMENT_COVERAGE_PCT instead
 * of a complete headline P&L. QUALITY_FILL_B/QUALITY_FILL_C are out of this
 * mission's scope and remain on the legacy toAtlasInput()-filtered path.
 *
 *   npx tsx scripts/modeling/quality-fill-portfolio-test.ts \
 *     --start=2026-08-04 --end=2026-09-20
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import "dotenv/config";

import { enumerateMinskDates, type CorpusLabel, type ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { SOCCER_FAMILY } from "@/lib/modeling/research-engine/models";
import { toAtlasInput, toDecisionTimeSelectionInput, type AtlasInputEvent } from "./factor-atlas";
import {
  runPortfolio,
  runStandaloneStrict,
  runPortfolioStrict,
  computeDailyResults,
  computeCapacity,
  computePartialCapacity,
  partialDailyResults,
  partialMetricsFor,
  settledBetsOnly,
  applyDailyCap,
  metricsFor,
  type TieredBet,
  type SelectedCandidate,
  type CapacityResult,
  type PartialCapacityResult,
} from "./daily-portfolio-frontier";

/** This mission's four required models — the ones wired to the selection-before-settlement path in this script. */
const FIXED_PATH_MODELS = new Set(["P50_52", "PORTFOLIO_BROAD", "QUALITY_FILL_A", "QUALITY_FILL_D"]);

const DEFAULT_START = "2026-08-04";
const DEFAULT_END = "2026-09-20";
const PAGE = 1000;
const CAPS = [20, 30, 40, 50] as const;
const DISPLAY_CAPS = [30, 40, 50] as const;
const AUG_END = "2026-08-31";
const SEP_START = "2026-09-01";
const EVIDENCE_OUT_DIR = "modeling/evidence/daily-cap-pnl-optimization-v1";
const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";

const ESPORTS_FAMILY = "esports";

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((v) => v.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const START = arg("start", DEFAULT_START);
const END = arg("end", DEFAULT_END);

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function projectRefOf(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

/** Fail-closed: only ever runs against the bound research-clone project — never production. */
async function resolveDb() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = projectRefOf(url);
  if (ref !== EXPECTED_CLONE_PROJECT_REF) {
    throw new Error(`REFUSING_NON_CLONE_TARGET: expected research-clone project ${EXPECTED_CLONE_PROJECT_REF}, got ${ref}`);
  }
  return createClient(url, key);
}

async function fetchRows(): Promise<ScorecardReadyRow[]> {
  const db = await resolveDb();
  const rows: ScorecardReadyRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("research_model_ready_rows")
      .select("canonical_row")
      .gte("model_date", START)
      .lte("model_date", END)
      .order("model_date")
      .order("population_id")
      .order("condition_id")
      .order("selected_token_id")
      .order("decision_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`FETCH_ROWS:${error.code ?? error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ canonical_row: ScorecardReadyRow }>) rows.push(r.canonical_row);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// ── FIXED tier predicates (evidence-backed sleeves already proven in this PR) ──
type Ev = { entryPrice: number; sportFamily: string };
const inP5052 = (e: Ev) => e.entryPrice >= 0.5 && e.entryPrice < 0.52;
const inP5254 = (e: Ev) => e.entryPrice >= 0.52 && e.entryPrice < 0.54;
const inP5460 = (e: Ev) => e.entryPrice >= 0.54 && e.entryPrice < 0.6;

const TIER_TENNIS_P5052 = (e: Ev) => inP5052(e) && e.sportFamily === "tennis";
const TIER_SOCCER_P5054 = (e: Ev) => (inP5052(e) || inP5254(e)) && e.sportFamily === SOCCER_FAMILY;
const TIER_REMAINING_P5052 = (e: Ev) => inP5052(e);
const TIER_NON_ESPORTS_REMAINING_P5052 = (e: Ev) => inP5052(e) && e.sportFamily !== ESPORTS_FAMILY;
const TIER_ESPORTS_P5052 = (e: Ev) => inP5052(e) && e.sportFamily === ESPORTS_FAMILY;
const TIER_SOCCER_P5460 = (e: Ev) => inP5460(e) && e.sportFamily === SOCCER_FAMILY;

/** Exported so scripts/modeling/refresh-modeling-dashboard.ts can reuse the exact frozen QUALITY_FILL_A/D tier definitions without redefining them. */
export const QUALITY_PORTFOLIOS: Record<string, Array<(e: Ev) => boolean>> = {
  QUALITY_FILL_A: [TIER_TENNIS_P5052, TIER_SOCCER_P5054, TIER_REMAINING_P5052],
  QUALITY_FILL_B: [TIER_TENNIS_P5052, TIER_SOCCER_P5054, TIER_NON_ESPORTS_REMAINING_P5052, TIER_ESPORTS_P5052],
  QUALITY_FILL_C: [
    TIER_TENNIS_P5052,
    TIER_SOCCER_P5054,
    TIER_NON_ESPORTS_REMAINING_P5052,
    TIER_ESPORTS_P5052,
    TIER_SOCCER_P5460,
  ],
  // QUALITY_FILL_A + Soccer 0.54-0.60 as a LAST fallback tier (fixed before running; unchanged after seeing results).
  QUALITY_FILL_D: [TIER_TENNIS_P5052, TIER_SOCCER_P5054, TIER_REMAINING_P5052, TIER_SOCCER_P5460],
};

const REQUIRED_MODELS = [
  "P50_52",
  "PORTFOLIO_BROAD",
  "QUALITY_FILL_A",
  "QUALITY_FILL_B",
  "QUALITY_FILL_C",
  "QUALITY_FILL_D",
] as const;

// P50_52 / PORTFOLIO_BROAD tier definitions reused verbatim (same predicates as daily-portfolio-frontier.ts).
const TIER_PREFERRED = (e: Ev & { scoreLevel?: number | null }) =>
  (inP5052(e) && e.sportFamily === "tennis") ||
  (inP5052(e) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65);
const TIER_P50_52 = (e: Ev) => inP5052(e);
const TIER_P52_54 = (e: Ev) => inP5254(e);

interface CapEconRow extends CapacityResult {
  MODEL: string;
  SEGMENT: "OVERALL" | "AUGUST" | "SEPTEMBER";
  CALENDAR_DAYS: number;
  PNL_PER_CALENDAR_DAY: number;
  PROJECTION_30D_PNL_U_FLAT_1U: number;
}

function capEconomics(model: string, segment: CapEconRow["SEGMENT"], bets: TieredBet[], cap: number, dates: string[]): CapEconRow {
  const c = computeCapacity(bets, cap, dates);
  const calendarDays = dates.length;
  const pnlPerCalendarDay = calendarDays ? round(c.total_pnl_u / calendarDays, 4) : 0;
  return {
    MODEL: model,
    SEGMENT: segment,
    ...c,
    CALENDAR_DAYS: calendarDays,
    PNL_PER_CALENDAR_DAY: pnlPerCalendarDay,
    PROJECTION_30D_PNL_U_FLAT_1U: round(pnlPerCalendarDay * 30, 2),
  };
}

function fillRates(bets: TieredBet[], dates: string[]) {
  const daily = computeDailyResults(bets, dates);
  const n = dates.length;
  return {
    FILL_RATE_30: n ? round(daily.filter((d) => d.event_n >= 30).length / n, 4) : 0,
    FILL_RATE_40: n ? round(daily.filter((d) => d.event_n >= 40).length / n, 4) : 0,
    FILL_RATE_50: n ? round(daily.filter((d) => d.event_n >= 50).length / n, 4) : 0,
  };
}

interface MarginalLayerRow {
  MODEL: string;
  LAYER: string;
  INCREMENTAL_EVENT_N: number;
  INCREMENTAL_PNL_U: number;
  INCREMENTAL_ROI_PCT: number;
  INCREMENTAL_PNL_PER_CALENDAR_DAY: number;
}
const MARGINAL_LAYERS: Array<[number, number, string]> = [
  [20, 30, "21_TO_30"],
  [30, 40, "31_TO_40"],
  [40, 50, "41_TO_50"],
];
function marginalLayers(model: string, capMap: Map<number, CapEconRow>, calendarDays: number): MarginalLayerRow[] {
  return MARGINAL_LAYERS.map(([lo, hi, label]) => {
    const a = capMap.get(lo)!;
    const b = capMap.get(hi)!;
    const incN = b.selected_event_n - a.selected_event_n;
    const incPnl = round(b.total_pnl_u - a.total_pnl_u, 2);
    const incRoi = incN > 0 ? round((incPnl / incN) * 100, 4) : 0;
    return {
      MODEL: model,
      LAYER: label,
      INCREMENTAL_EVENT_N: incN,
      INCREMENTAL_PNL_U: incPnl,
      INCREMENTAL_ROI_PCT: incRoi,
      INCREMENTAL_PNL_PER_CALENDAR_DAY: calendarDays ? round(incPnl / calendarDays, 4) : 0,
    };
  });
}

/**
 * CAP_ENGINE_AUTHORITY: baseline and candidate cap50 selections both go through the
 * canonical `applyDailyCap()` (scripts/modeling/daily-portfolio-frontier.ts) — no
 * second capacity-selection implementation here.
 */
function pairedComparisonAtCap50(baselineBets: TieredBet[], candidateBets: TieredBet[], baselineDates: string[]) {
  const cap = 50;
  const baseCappedBets = applyDailyCap(baselineBets, cap);
  const candCappedBets = applyDailyCap(candidateBets, cap);
  const baseCapped = new Set(baseCappedBets.map((b) => b.physicalEventKey));
  const candKeys = new Set(candCappedBets.map((b) => b.physicalEventKey));
  const shared = [...candKeys].filter((k) => baseCapped.has(k));
  const added = candCappedBets.filter((b) => !baseCapped.has(b.physicalEventKey));
  const removed = [...baseCapped].filter((k) => !candKeys.has(k));
  const baseMetrics = metricsFor(baseCappedBets);
  const candMetrics = metricsFor(candCappedBets);
  const baseFill = fillRates(baselineBets, baselineDates);
  const candFill = fillRates(candidateBets, baselineDates);
  return {
    SHARED_EVENT_N: shared.length,
    ADDED_EVENT_N: added.length,
    REMOVED_EVENT_N: removed.length,
    BASELINE_CAP50_N: baseCapped.size,
    CANDIDATE_CAP50_N: candCappedBets.length,
    BASELINE_CAP50_PNL_U: baseMetrics.pnl_u,
    CANDIDATE_CAP50_PNL_U: candMetrics.pnl_u,
    PNL_DELTA_U: round(candMetrics.pnl_u - baseMetrics.pnl_u, 2),
    FILL_RATE_50_DELTA: round(candFill.FILL_RATE_50 - baseFill.FILL_RATE_50, 4),
    BASELINE_FILL_RATE_50: baseFill.FILL_RATE_50,
    CANDIDATE_FILL_RATE_50: candFill.FILL_RATE_50,
    BASELINE_FILL_RATE_30: baseFill.FILL_RATE_30,
    CANDIDATE_FILL_RATE_30: candFill.FILL_RATE_30,
    BASELINE_FILL_RATE_40: baseFill.FILL_RATE_40,
    CANDIDATE_FILL_RATE_40: candFill.FILL_RATE_40,
  };
}

// ── FIXED_PATH_MODELS-only counterparts: same shapes as above, but the
// underlying selection is decision-time-only and settlement is joined post-
// selection/post-cap via computePartialCapacity()/partialDailyResults()/
// partialMetricsFor() (all imported verbatim). ──────────────────────────────

interface PartialCapEconRow extends PartialCapacityResult {
  MODEL: string;
  SEGMENT: "OVERALL" | "AUGUST" | "SEPTEMBER";
  CALENDAR_DAYS: number;
  SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: number;
  PROJECTION_30D_SETTLED_PNL_U_PARTIAL: number;
}

function partialCapEconomics(
  model: string,
  segment: PartialCapEconRow["SEGMENT"],
  candidates: SelectedCandidate[],
  settlementByCandidateIdentity: Map<string, CorpusLabel>,
  cap: number,
  dates: string[],
): PartialCapEconRow {
  const c = computePartialCapacity(candidates, settlementByCandidateIdentity, cap);
  const calendarDays = dates.length;
  const pnlPerCalendarDay = calendarDays ? round(c.settled_pnl_u_partial / calendarDays, 4) : 0;
  return {
    MODEL: model,
    SEGMENT: segment,
    ...c,
    CALENDAR_DAYS: calendarDays,
    SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: pnlPerCalendarDay,
    PROJECTION_30D_SETTLED_PNL_U_PARTIAL: round(pnlPerCalendarDay * 30, 2),
  };
}

function partialFillRates(candidates: SelectedCandidate[], settlementByCandidateIdentity: Map<string, CorpusLabel>, dates: string[]) {
  const daily = partialDailyResults(candidates, settlementByCandidateIdentity, dates);
  const n = dates.length;
  return {
    FILL_RATE_30: n ? round(daily.filter((d) => d.event_n >= 30).length / n, 4) : 0,
    FILL_RATE_40: n ? round(daily.filter((d) => d.event_n >= 40).length / n, 4) : 0,
    FILL_RATE_50: n ? round(daily.filter((d) => d.event_n >= 50).length / n, 4) : 0,
  };
}

interface PartialMarginalLayerRow {
  MODEL: string;
  LAYER: string;
  INCREMENTAL_SELECTED_N: number;
  INCREMENTAL_SETTLED_PNL_U_PARTIAL: number;
  INCREMENTAL_SETTLED_ROI_PCT_PARTIAL: number;
  INCREMENTAL_SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: number;
}

function partialMarginalLayers(model: string, capMap: Map<number, PartialCapEconRow>, calendarDays: number): PartialMarginalLayerRow[] {
  return MARGINAL_LAYERS.map(([lo, hi, label]) => {
    const a = capMap.get(lo)!;
    const b = capMap.get(hi)!;
    const incN = b.selected_n - a.selected_n;
    const incPnl = round(b.settled_pnl_u_partial - a.settled_pnl_u_partial, 2);
    const incRoi = incN > 0 ? round((incPnl / incN) * 100, 4) : 0;
    return {
      MODEL: model,
      LAYER: label,
      INCREMENTAL_SELECTED_N: incN,
      INCREMENTAL_SETTLED_PNL_U_PARTIAL: incPnl,
      INCREMENTAL_SETTLED_ROI_PCT_PARTIAL: incRoi,
      INCREMENTAL_SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: calendarDays ? round(incPnl / calendarDays, 4) : 0,
    };
  });
}

/**
 * FIXED_PATH_MODELS-only counterpart of pairedComparisonAtCap50(). Never
 * reports a single complete PNL_DELTA_U — only settled-only deltas alongside
 * explicit coverage, since OPEN_N > 0 on the live corpus for every model
 * wired to this path.
 */
function partialPairedComparisonAtCap50(
  baselineCandidates: SelectedCandidate[],
  candidateCandidates: SelectedCandidate[],
  settlementByCandidateIdentity: Map<string, CorpusLabel>,
  baselineDates: string[],
) {
  const cap = 50;
  const baseCapped = applyDailyCap(baselineCandidates, cap);
  const candCapped = applyDailyCap(candidateCandidates, cap);
  const baseKeys = new Set(baseCapped.map((b) => b.physicalEventKey));
  const candKeys = new Set(candCapped.map((c) => c.physicalEventKey));
  const shared = [...candKeys].filter((k) => baseKeys.has(k));
  const added = candCapped.filter((c) => !baseKeys.has(c.physicalEventKey));
  const removed = [...baseKeys].filter((k) => !candKeys.has(k));
  const baseMetrics = partialMetricsFor(baseCapped, settlementByCandidateIdentity);
  const candMetrics = partialMetricsFor(candCapped, settlementByCandidateIdentity);
  const baseFill = partialFillRates(baselineCandidates, settlementByCandidateIdentity, baselineDates);
  const candFill = partialFillRates(candidateCandidates, settlementByCandidateIdentity, baselineDates);
  return {
    SHARED_EVENT_N: shared.length,
    ADDED_EVENT_N: added.length,
    REMOVED_EVENT_N: removed.length,
    BASELINE_CAP50_SELECTED_N: baseCapped.length,
    CANDIDATE_CAP50_SELECTED_N: candCapped.length,
    BASELINE_CAP50_SETTLED_N: baseMetrics.SETTLED_N,
    CANDIDATE_CAP50_SETTLED_N: candMetrics.SETTLED_N,
    BASELINE_CAP50_OPEN_N: baseMetrics.OPEN_N,
    CANDIDATE_CAP50_OPEN_N: candMetrics.OPEN_N,
    BASELINE_CAP50_SETTLED_PNL_U_PARTIAL: baseMetrics.SETTLED_PNL_U_PARTIAL,
    CANDIDATE_CAP50_SETTLED_PNL_U_PARTIAL: candMetrics.SETTLED_PNL_U_PARTIAL,
    SETTLED_PNL_U_PARTIAL_DELTA: round(candMetrics.SETTLED_PNL_U_PARTIAL - baseMetrics.SETTLED_PNL_U_PARTIAL, 2),
    BASELINE_SETTLEMENT_COVERAGE_PCT: baseMetrics.SETTLEMENT_COVERAGE_PCT,
    CANDIDATE_SETTLEMENT_COVERAGE_PCT: candMetrics.SETTLEMENT_COVERAGE_PCT,
    FILL_RATE_50_DELTA: round(candFill.FILL_RATE_50 - baseFill.FILL_RATE_50, 4),
    BASELINE_FILL_RATE_50: baseFill.FILL_RATE_50,
    CANDIDATE_FILL_RATE_50: candFill.FILL_RATE_50,
    BASELINE_FILL_RATE_30: baseFill.FILL_RATE_30,
    CANDIDATE_FILL_RATE_30: candFill.FILL_RATE_30,
    BASELINE_FILL_RATE_40: baseFill.FILL_RATE_40,
    CANDIDATE_FILL_RATE_40: candFill.FILL_RATE_40,
  };
}

async function main() {
  const rawRows = await fetchRows();
  const input: AtlasInputEvent[] = toAtlasInput(rawRows);

  const dates = enumerateMinskDates(START, END);
  const augDates = dates.filter((d) => d <= AUG_END);
  const sepDates = dates.filter((d) => d >= SEP_START);

  // ── SELECTION_BEFORE_SETTLEMENT_V1: P50_52/PORTFOLIO_BROAD/QUALITY_FILL_A/QUALITY_FILL_D ──
  const { candidates: decisionTimeCandidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rawRows);
  const fixedCandidatesByModel = new Map<string, SelectedCandidate[]>();
  fixedCandidatesByModel.set("P50_52", runStandaloneStrict(decisionTimeCandidates, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52));
  fixedCandidatesByModel.set("PORTFOLIO_BROAD", runPortfolioStrict(decisionTimeCandidates, [TIER_PREFERRED, TIER_P50_52, TIER_P52_54] as Parameters<typeof runPortfolioStrict>[1]));
  fixedCandidatesByModel.set("QUALITY_FILL_A", runPortfolioStrict(decisionTimeCandidates, QUALITY_PORTFOLIOS.QUALITY_FILL_A as Parameters<typeof runPortfolioStrict>[1]));
  fixedCandidatesByModel.set("QUALITY_FILL_D", runPortfolioStrict(decisionTimeCandidates, QUALITY_PORTFOLIOS.QUALITY_FILL_D as Parameters<typeof runPortfolioStrict>[1]));

  // Legacy (out-of-scope) models only: QUALITY_FILL_B, QUALITY_FILL_C.
  const betsByModel = new Map<string, TieredBet[]>();
  for (const [id, tiers] of Object.entries(QUALITY_PORTFOLIOS)) {
    if (FIXED_PATH_MODELS.has(id)) continue;
    betsByModel.set(id, runPortfolio(input, tiers));
  }
  // Settled-only subset of P50_52's fixed-path selection — used ONLY so
  // TABLE 4's baseline stays apples-to-apples against QUALITY_FILL_B/C
  // (legacy, fully-settled, out of scope). settledBetsOnly() imported
  // verbatim — no duplicated settlement math.
  const p50_52Settled = settledBetsOnly(fixedCandidatesByModel.get("P50_52")!, settlementByCandidateIdentity).settledBets;

  // TABLE 1 — MODEL x CAP economics (overall + Aug + Sep-through-Sep20), cap 30/40/50; fill rates once per model
  interface Table1Row {
    CAP: number;
    OVERALL: CapEconRow;
    AUGUST: CapEconRow;
    SEPTEMBER: CapEconRow;
  }
  interface Table1Block {
    ROWS: Table1Row[];
    FILL_RATE_30: number;
    FILL_RATE_40: number;
    FILL_RATE_50: number;
  }
  interface PartialTable1Row {
    CAP: number;
    OVERALL: PartialCapEconRow;
    AUGUST: PartialCapEconRow;
    SEPTEMBER: PartialCapEconRow;
  }
  interface PartialTable1Block {
    ROWS: PartialTable1Row[];
    FILL_RATE_30: number;
    FILL_RATE_40: number;
    FILL_RATE_50: number;
  }
  const table1: Record<string, Table1Block | PartialTable1Block> = {};
  const capMapOverallByModel = new Map<string, Map<number, CapEconRow>>();
  const partialCapMapOverallByModel = new Map<string, Map<number, PartialCapEconRow>>();
  for (const modelId of REQUIRED_MODELS) {
    if (FIXED_PATH_MODELS.has(modelId)) {
      const candidates = fixedCandidatesByModel.get(modelId)!;
      const overallCapMap = new Map<number, PartialCapEconRow>();
      for (const cap of CAPS) overallCapMap.set(cap, partialCapEconomics(modelId, "OVERALL", candidates, settlementByCandidateIdentity, cap, dates));
      partialCapMapOverallByModel.set(modelId, overallCapMap);

      const augCandidates = candidates.filter((c) => c.day <= AUG_END);
      const sepCandidates = candidates.filter((c) => c.day >= SEP_START);
      const rows = DISPLAY_CAPS.map((cap) => ({
        CAP: cap,
        OVERALL: overallCapMap.get(cap)!,
        AUGUST: partialCapEconomics(modelId, "AUGUST", augCandidates, settlementByCandidateIdentity, cap, augDates),
        SEPTEMBER: partialCapEconomics(modelId, "SEPTEMBER", sepCandidates, settlementByCandidateIdentity, cap, sepDates),
      }));
      table1[modelId] = { ROWS: rows, ...partialFillRates(candidates, settlementByCandidateIdentity, dates) };
      continue;
    }
    const bets = betsByModel.get(modelId)!;
    const overallCapMap = new Map<number, CapEconRow>();
    for (const cap of CAPS) overallCapMap.set(cap, capEconomics(modelId, "OVERALL", bets, cap, dates));
    capMapOverallByModel.set(modelId, overallCapMap);

    // computeCapacity aggregates over whatever bet set it is given (its `allDates` arg only
    // shapes the daily/active-day breakdown, not the totals) — so Aug/Sep segments must be
    // pre-filtered to their own bets, not just given a narrower `dates` array over full-range bets.
    const augBets = bets.filter((b) => b.day <= AUG_END);
    const sepBets = bets.filter((b) => b.day >= SEP_START);
    const rows = DISPLAY_CAPS.map((cap) => ({
      CAP: cap,
      OVERALL: overallCapMap.get(cap)!,
      AUGUST: capEconomics(modelId, "AUGUST", augBets, cap, augDates),
      SEPTEMBER: capEconomics(modelId, "SEPTEMBER", sepBets, cap, sepDates),
    }));
    table1[modelId] = { ROWS: rows, ...fillRates(bets, dates) };
  }

  // TABLE 2 — marginal 21-30 / 31-40 / 41-50
  const table2: Record<string, MarginalLayerRow[] | PartialMarginalLayerRow[]> = {};
  for (const modelId of REQUIRED_MODELS) {
    table2[modelId] = FIXED_PATH_MODELS.has(modelId)
      ? partialMarginalLayers(modelId, partialCapMapOverallByModel.get(modelId)!, dates.length)
      : marginalLayers(modelId, capMapOverallByModel.get(modelId)!, dates.length);
  }

  // TABLE 3 — fill rate 30/40/50 (already embedded in table1[modelId] top-level fields, re-surfaced standalone)
  const table3: Record<string, { FILL_RATE_30: number; FILL_RATE_40: number; FILL_RATE_50: number }> = {};
  for (const modelId of REQUIRED_MODELS) {
    table3[modelId] = FIXED_PATH_MODELS.has(modelId)
      ? partialFillRates(fixedCandidatesByModel.get(modelId)!, settlementByCandidateIdentity, dates)
      : fillRates(betsByModel.get(modelId)!, dates);
  }

  // TABLE 4 — cap50 paired comparison vs P50_52
  const fixedBaseline = fixedCandidatesByModel.get("P50_52")!;
  const table4: Record<string, ReturnType<typeof pairedComparisonAtCap50> | ReturnType<typeof partialPairedComparisonAtCap50>> = {};
  for (const modelId of REQUIRED_MODELS) {
    if (modelId === "P50_52") continue;
    table4[modelId] = FIXED_PATH_MODELS.has(modelId)
      ? partialPairedComparisonAtCap50(fixedBaseline, fixedCandidatesByModel.get(modelId)!, settlementByCandidateIdentity, dates)
      : pairedComparisonAtCap50(p50_52Settled, betsByModel.get(modelId)!, dates);
  }

  // TABLE 5 — cap50 paired comparison QUALITY_FILL_D vs QUALITY_FILL_A (canonical applyDailyCap() output; both FIXED_PATH_MODELS)
  const table5DvsA = partialPairedComparisonAtCap50(fixedCandidatesByModel.get("QUALITY_FILL_A")!, fixedCandidatesByModel.get("QUALITY_FILL_D")!, settlementByCandidateIdentity, dates);
  const aCap50Settled = partialCapMapOverallByModel.get("QUALITY_FILL_A")!.get(50)!.settled_pnl_u_partial;
  const dCap50Settled = partialCapMapOverallByModel.get("QUALITY_FILL_D")!.get(50)!.settled_pnl_u_partial;
  const reconciledSettledDelta = round(dCap50Settled - aCap50Settled, 2);

  const artifact = {
    MISSION: "QUALITY_FILL_PORTFOLIO_TEST_V1",
    PARENT_MISSION: "DAILY_CAP_PNL_OPTIMIZATION_V1",
    NOTE: "P50_52/PORTFOLIO_BROAD/QUALITY_FILL_A/QUALITY_FILL_D (FIXED_PATH_MODELS) report SELECTED_N/SETTLED_N/OPEN_N/OTHER_NONTERMINAL_N/SETTLED_PNL_U_PARTIAL/SETTLEMENT_COVERAGE_PCT — never a complete headline P&L while OPEN_N > 0. TABLE_4's baseline for legacy QUALITY_FILL_B/C uses the settled-only subset of P50_52's fixed-path selection so both operands stay apples-to-apples.",
    FIXED_PATH_MODELS: [...FIXED_PATH_MODELS],
    ENGINE_REUSE:
      "runStandalone/runPortfolio/computeDailyResults/computeCapacity/applyDailyCap imported verbatim from scripts/modeling/daily-portfolio-frontier.ts (one capacity-selection authority for baseline and candidate cap50 selections alike). FIXED_PATH_MODELS additionally use toDecisionTimeSelectionInput/runStandaloneStrict/runPortfolioStrict/computePartialCapacity/partialDailyResults/partialMetricsFor/settledBetsOnly — same tier predicates, same comparator, same applyDailyCap() ordering. Only new code: FIXED tier predicates for QUALITY_FILL_A/B/C/D (ordinary price+sport-family composition), no new score threshold, no new capacity engine.",
    DATASET_RANGE: { start: START, end: END },
    CALENDAR_DAYS: dates.length,
    SOURCE_ROW_N: rawRows.length,
    TABLE_1_MODEL_X_CAP_ECONOMICS: table1,
    TABLE_2_MARGINAL_LAYERS: table2,
    TABLE_3_FILL_RATES: table3,
    TABLE_4_CAP50_PAIRED_VS_P50_52: table4,
    TABLE_5_CAP50_PAIRED_D_VS_A: {
      ...table5DvsA,
      QUALITY_FILL_A_CAP50_SETTLED_PNL_U_PARTIAL: aCap50Settled,
      QUALITY_FILL_D_CAP50_SETTLED_PNL_U_PARTIAL: dCap50Settled,
      RECONCILED_SETTLED_PNL_U_PARTIAL_DELTA: reconciledSettledDelta,
      RECONCILES: reconciledSettledDelta === table5DvsA.SETTLED_PNL_U_PARTIAL_DELTA,
    },
  };

  console.log(JSON.stringify(artifact, null, 2));

  mkdirSync(EVIDENCE_OUT_DIR, { recursive: true });
  const outPath = `${EVIDENCE_OUT_DIR}/QUALITY_FILL_PORTFOLIO_TEST_${START}_${END}.json`;
  writeFileSync(outPath, JSON.stringify({ GENERATED_AT: new Date().toISOString(), ...artifact }, null, 2));
  console.error(`Wrote aggregate evidence artifact: ${outPath}`);
}

/**
 * Guarded entrypoint (same pattern as scripts/modeling/daily-portfolio-frontier.ts):
 * `main()` only auto-runs when this file is the invoked script, so
 * scripts/modeling/refresh-modeling-dashboard.ts can import `QUALITY_PORTFOLIOS`
 * (the accepted QUALITY_FILL_A/D tier definitions) without triggering this
 * file's own DB-fetching main() as a side effect of the import.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
