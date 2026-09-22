/**
 * DAILY_CAP_PNL_OPTIMIZATION_V1 — answers ONE business question: what daily
 * cap maximizes absolute P&L while moving toward 30-50 physical bets/day,
 * over the current common research-clone model-ready period.
 *
 * ENGINE_REUSE: never reimplements capacity/settlement. Imports the exact
 * capacity primitives verbatim from scripts/modeling/daily-portfolio-frontier.ts
 * (runStandalone, runPortfolio, computeDailyResults, computeUncapped,
 * computeCapacity, computeMarginal, applyDailyCap, STANDALONE_STRATEGIES,
 * PORTFOLIOS) and the frozen C5 predicate verbatim from
 * lib/modeling/research-engine/models.ts. Row fetch + normalizer are the
 * exact pattern used by scripts/modeling/unified-core-scoreboard.ts
 * (research_model_ready_rows, fail-closed clone-project guard, toAtlasInput).
 *
 * SELECTION_BEFORE_SETTLEMENT_V1: P50_52 and PORTFOLIO_BROAD are wired to the
 * decision-time-only selection path (toDecisionTimeSelectionInput /
 * runStandaloneStrict / runPortfolioStrict / applyDailyCap /
 * computePartialCapacity — all imported verbatim from
 * scripts/modeling/daily-portfolio-frontier.ts and scripts/modeling/factor-atlas.ts;
 * same predicates/tiers as every other model here). Their tables report
 * SELECTED_N / SETTLED_N / OPEN_N / OTHER_NONTERMINAL_N /
 * SETTLED_PNL_U_PARTIAL / SETTLEMENT_COVERAGE_PCT instead of a complete
 * headline P&L — settlement coverage is well under 100% on the live corpus,
 * so a full ROI figure for these two models would misrepresent open bets as
 * losses (the pre-fix bug) or silently drop them. The other models here
 * (P50_54, C0, C5, TENNIS_P50_52, PORTFOLIO_C0_FILL) are out of this
 * mission's scope and remain on the legacy toAtlasInput()-filtered path
 * unchanged.
 *
 * No new score threshold, no new capacity engine, no production writes.
 *
 *   npx tsx scripts/modeling/daily-cap-pnl-optimization.ts \
 *     --start=2026-08-04 --end=2026-09-20
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import "dotenv/config";

import { enumerateMinskDates, type CorpusLabel, type ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { ENTRY_PRICE_BAND, TABLE_TENNIS_FAMILY } from "@/lib/modeling/research-engine";
import { toAtlasInput, toDecisionTimeSelectionInput, type AtlasInputEvent } from "./factor-atlas";
import {
  runStandalone,
  runPortfolio,
  runStandaloneStrict,
  runPortfolioStrict,
  computeDailyResults,
  computeUncapped,
  computeCapacity,
  computePartialCapacity,
  partialDailyResults,
  partialMetricsFor,
  settledBetsOnly,
  applyDailyCap,
  STANDALONE_STRATEGIES,
  PORTFOLIOS,
  metricsFor,
  type TieredBet,
  type SelectedCandidate,
  type CapacityResult,
  type PartialCapacityResult,
} from "./daily-portfolio-frontier";

/** The four models this mission requires on the selection-before-settlement path. Only two of them (P50_52, PORTFOLIO_BROAD) appear in this script's REQUIRED_MODELS. */
const FIXED_PATH_MODELS = new Set(["P50_52", "PORTFOLIO_BROAD"]);

const DEFAULT_START = "2026-08-04";
const DEFAULT_END = "2026-09-20";
const PAGE = 1000;
const CAPS = [15, 20, 30, 40, 50] as const;
const AUG_END = "2026-08-31";
const SEP_START = "2026-09-01";
const EVIDENCE_OUT_DIR = "modeling/evidence/daily-cap-pnl-optimization-v1";
const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";

const REQUIRED_MODELS = ["P50_54", "PORTFOLIO_BROAD", "P50_52", "C0", "C5", "TENNIS_P50_52", "PORTFOLIO_C0_FILL"] as const;

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
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function median(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

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

function inC0(entryPrice: number): boolean {
  return entryPrice >= ENTRY_PRICE_BAND.minInclusive && entryPrice < ENTRY_PRICE_BAND.maxExclusive;
}

interface DailySupplyStats {
  MODEL: string;
  TOTAL_N: number;
  /** WIN/LOSS-settled of TOTAL_N. Legacy (out-of-scope) models are fully settled by construction: SETTLED_N == TOTAL_N. */
  SETTLED_N: number;
  OPEN_N: number;
  OTHER_NONTERMINAL_N: number;
  SETTLEMENT_COVERAGE_PCT: number;
  CALENDAR_DAYS: number;
  ACTIVE_DAYS: number;
  MEAN_PER_CALENDAR_DAY: number;
  MEDIAN_PER_CALENDAR_DAY: number;
  P25_PER_CALENDAR_DAY: number;
  P75_PER_CALENDAR_DAY: number;
  MAX_PER_DAY: number;
  DAYS_GE_15: number;
  DAYS_GE_20: number;
  DAYS_GE_30: number;
  DAYS_GE_40: number;
  DAYS_GE_50: number;
  FILL_RATE_30: number;
  FILL_RATE_50: number;
}

/** Legacy (out-of-scope models only): fully WIN/LOSS-settled by construction — toAtlasInput() already filtered labelAsOf before this point. */
function supplyStats(model: string, bets: TieredBet[], dates: string[]): DailySupplyStats {
  const daily = computeDailyResults(bets, dates);
  const counts = daily.map((d) => d.event_n).sort((a, b) => a - b);
  const active = counts.filter((n) => n > 0);
  const calendarDays = dates.length;
  return {
    MODEL: model,
    TOTAL_N: bets.length,
    SETTLED_N: bets.length,
    OPEN_N: 0,
    OTHER_NONTERMINAL_N: 0,
    SETTLEMENT_COVERAGE_PCT: 100,
    CALENDAR_DAYS: calendarDays,
    ACTIVE_DAYS: active.length,
    MEAN_PER_CALENDAR_DAY: calendarDays ? round(counts.reduce((s, n) => s + n, 0) / calendarDays, 4) : 0,
    MEDIAN_PER_CALENDAR_DAY: calendarDays ? median(counts) : 0,
    P25_PER_CALENDAR_DAY: calendarDays ? round(percentile(counts, 0.25), 4) : 0,
    P75_PER_CALENDAR_DAY: calendarDays ? round(percentile(counts, 0.75), 4) : 0,
    MAX_PER_DAY: counts.length ? counts[counts.length - 1] : 0,
    DAYS_GE_15: daily.filter((d) => d.event_n >= 15).length,
    DAYS_GE_20: daily.filter((d) => d.event_n >= 20).length,
    DAYS_GE_30: daily.filter((d) => d.event_n >= 30).length,
    DAYS_GE_40: daily.filter((d) => d.event_n >= 40).length,
    DAYS_GE_50: daily.filter((d) => d.event_n >= 50).length,
    FILL_RATE_30: calendarDays ? round(daily.filter((d) => d.event_n >= 30).length / calendarDays, 4) : 0,
    FILL_RATE_50: calendarDays ? round(daily.filter((d) => d.event_n >= 50).length / calendarDays, 4) : 0,
  };
}

/** FIXED_PATH_MODELS only: selection-before-settlement candidates, settlement joined post-selection via partialDailyResults()/partialMetricsFor() (imported verbatim). */
function partialSupplyStats(model: string, candidates: SelectedCandidate[], settlementByCandidateIdentity: Map<string, CorpusLabel>, dates: string[]): DailySupplyStats {
  const daily = partialDailyResults(candidates, settlementByCandidateIdentity, dates);
  const counts = daily.map((d) => d.event_n).sort((a, b) => a - b);
  const active = counts.filter((n) => n > 0);
  const calendarDays = dates.length;
  const m = partialMetricsFor(candidates, settlementByCandidateIdentity);
  return {
    MODEL: model,
    TOTAL_N: candidates.length,
    SETTLED_N: m.SETTLED_N,
    OPEN_N: m.OPEN_N,
    OTHER_NONTERMINAL_N: m.OTHER_NONTERMINAL_N,
    SETTLEMENT_COVERAGE_PCT: m.SETTLEMENT_COVERAGE_PCT,
    CALENDAR_DAYS: calendarDays,
    ACTIVE_DAYS: active.length,
    MEAN_PER_CALENDAR_DAY: calendarDays ? round(counts.reduce((s, n) => s + n, 0) / calendarDays, 4) : 0,
    MEDIAN_PER_CALENDAR_DAY: calendarDays ? median(counts) : 0,
    P25_PER_CALENDAR_DAY: calendarDays ? round(percentile(counts, 0.25), 4) : 0,
    P75_PER_CALENDAR_DAY: calendarDays ? round(percentile(counts, 0.75), 4) : 0,
    MAX_PER_DAY: counts.length ? counts[counts.length - 1] : 0,
    DAYS_GE_15: daily.filter((d) => d.event_n >= 15).length,
    DAYS_GE_20: daily.filter((d) => d.event_n >= 20).length,
    DAYS_GE_30: daily.filter((d) => d.event_n >= 30).length,
    DAYS_GE_40: daily.filter((d) => d.event_n >= 40).length,
    DAYS_GE_50: daily.filter((d) => d.event_n >= 50).length,
    FILL_RATE_30: calendarDays ? round(daily.filter((d) => d.event_n >= 30).length / calendarDays, 4) : 0,
    FILL_RATE_50: calendarDays ? round(daily.filter((d) => d.event_n >= 50).length / calendarDays, 4) : 0,
  };
}

interface CapEconRow extends CapacityResult {
  MODEL: string;
  CALENDAR_DAYS: number;
  PNL_PER_CALENDAR_DAY: number;
  PROJECTION_30D_PNL_U_FLAT_1U: number;
}

/** Legacy (out-of-scope models only). */
function capEconomics(model: string, bets: TieredBet[], cap: number, dates: string[]): CapEconRow {
  const c = computeCapacity(bets, cap, dates);
  const calendarDays = dates.length;
  const pnlPerCalendarDay = calendarDays ? round(c.total_pnl_u / calendarDays, 4) : 0;
  return {
    MODEL: model,
    ...c,
    CALENDAR_DAYS: calendarDays,
    PNL_PER_CALENDAR_DAY: pnlPerCalendarDay,
    PROJECTION_30D_PNL_U_FLAT_1U: round(pnlPerCalendarDay * 30, 2),
  };
}

interface PartialCapEconRow extends PartialCapacityResult {
  MODEL: string;
  CALENDAR_DAYS: number;
  SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: number;
  PROJECTION_30D_SETTLED_PNL_U_PARTIAL: number;
}

/** FIXED_PATH_MODELS only: cap ordering via computePartialCapacity() (applyDailyCap() imported verbatim inside it) — settled-only PnL, explicitly partial while OPEN_N > 0. */
function partialCapEconomics(model: string, candidates: SelectedCandidate[], settlementByCandidateIdentity: Map<string, CorpusLabel>, cap: number, dates: string[]): PartialCapEconRow {
  const c = computePartialCapacity(candidates, settlementByCandidateIdentity, cap);
  const calendarDays = dates.length;
  const pnlPerCalendarDay = calendarDays ? round(c.settled_pnl_u_partial / calendarDays, 4) : 0;
  return {
    MODEL: model,
    ...c,
    CALENDAR_DAYS: calendarDays,
    SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: pnlPerCalendarDay,
    PROJECTION_30D_SETTLED_PNL_U_PARTIAL: round(pnlPerCalendarDay * 30, 2),
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

interface PartialMarginalLayerRow {
  MODEL: string;
  LAYER: string;
  INCREMENTAL_SELECTED_N: number;
  INCREMENTAL_SETTLED_PNL_U_PARTIAL: number;
  INCREMENTAL_SETTLED_ROI_PCT_PARTIAL: number;
  INCREMENTAL_SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: number;
}

/** LAYERS start at 1 (uncapped-cap-15 IS the 1-15 layer; there is no cap-0 baseline). */
const FULL_LAYERS: Array<[number, number]> = [
  [0, 15],
  [15, 20],
  [20, 30],
  [30, 40],
  [40, 50],
];

/** Legacy (out-of-scope models only). */
function marginalLayers(model: string, capacityByCap: Map<number, CapEconRow>, calendarDays: number): MarginalLayerRow[] {
  return FULL_LAYERS.map(([lo, hi]) => {
    const b = capacityByCap.get(hi)!;
    const a = lo === 0 ? { selected_event_n: 0, total_pnl_u: 0 } : capacityByCap.get(lo)!;
    const incrementalEventN = b.selected_event_n - a.selected_event_n;
    const incrementalPnl = round(b.total_pnl_u - a.total_pnl_u, 2);
    const incrementalRoi = incrementalEventN > 0 ? round((incrementalPnl / incrementalEventN) * 100, 4) : 0;
    return {
      MODEL: model,
      LAYER: lo === 0 ? "1_TO_15" : `${lo}_TO_${hi}`,
      INCREMENTAL_EVENT_N: incrementalEventN,
      INCREMENTAL_PNL_U: incrementalPnl,
      INCREMENTAL_ROI_PCT: incrementalRoi,
      INCREMENTAL_PNL_PER_CALENDAR_DAY: calendarDays ? round(incrementalPnl / calendarDays, 4) : 0,
    };
  });
}

/** FIXED_PATH_MODELS only. */
function partialMarginalLayers(model: string, capacityByCap: Map<number, PartialCapEconRow>, calendarDays: number): PartialMarginalLayerRow[] {
  return FULL_LAYERS.map(([lo, hi]) => {
    const b = capacityByCap.get(hi)!;
    const a = lo === 0 ? { selected_n: 0, settled_pnl_u_partial: 0 } : capacityByCap.get(lo)!;
    const incrementalN = b.selected_n - a.selected_n;
    const incrementalPnl = round(b.settled_pnl_u_partial - a.settled_pnl_u_partial, 2);
    const incrementalRoi = incrementalN > 0 ? round((incrementalPnl / incrementalN) * 100, 4) : 0;
    return {
      MODEL: model,
      LAYER: lo === 0 ? "1_TO_15" : `${lo}_TO_${hi}`,
      INCREMENTAL_SELECTED_N: incrementalN,
      INCREMENTAL_SETTLED_PNL_U_PARTIAL: incrementalPnl,
      INCREMENTAL_SETTLED_ROI_PCT_PARTIAL: incrementalRoi,
      INCREMENTAL_SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: calendarDays ? round(incrementalPnl / calendarDays, 4) : 0,
    };
  });
}

async function main() {
  const rawRows = await fetchRows();
  const input: AtlasInputEvent[] = toAtlasInput(rawRows);
  const processedN = new Set(input.map((e) => e.physicalEventKey)).size;

  const dates = enumerateMinskDates(START, END);
  const augDates = dates.filter((d) => d <= AUG_END);
  const sepDates = dates.filter((d) => d >= SEP_START);

  const standaloneById = new Map(STANDALONE_STRATEGIES.map((s) => [s.id, s]));
  const portfolioById = new Map(PORTFOLIOS.map((p) => [p.id, p]));

  // ── SELECTION_BEFORE_SETTLEMENT_V1: P50_52 + PORTFOLIO_BROAD only ──
  const { candidates: decisionTimeCandidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rawRows);
  const fixedCandidatesByModel = new Map<string, SelectedCandidate[]>();
  fixedCandidatesByModel.set("P50_52", runStandaloneStrict(decisionTimeCandidates, standaloneById.get("P50_52")!.predicate as Parameters<typeof runStandaloneStrict>[1]));
  fixedCandidatesByModel.set("PORTFOLIO_BROAD", runPortfolioStrict(decisionTimeCandidates, portfolioById.get("PORTFOLIO_BROAD")!.tiers as Parameters<typeof runPortfolioStrict>[1]));

  const betsByModel = new Map<string, TieredBet[]>();
  for (const modelId of REQUIRED_MODELS) {
    if (FIXED_PATH_MODELS.has(modelId)) continue; // reported from fixedCandidatesByModel instead — see TABLE_1/2/3/4 below
    if (modelId === "C5") {
      betsByModel.set(
        modelId,
        runStandalone(input, (e) => inC0(e.entryPrice) && e.sportFamily !== TABLE_TENNIS_FAMILY),
      );
      continue;
    }
    const standalone = standaloneById.get(modelId);
    if (standalone) {
      betsByModel.set(modelId, runStandalone(input, standalone.predicate));
      continue;
    }
    const portfolio = portfolioById.get(modelId);
    if (portfolio) {
      betsByModel.set(modelId, runPortfolio(input, portfolio.tiers));
      continue;
    }
    throw new Error(`MODEL_NOT_FOUND_IN_REUSED_ENGINE: ${modelId}`);
  }
  // Settled-only subset of P50_52's fixed-path selection, reused ONLY by
  // TABLE 5's widening comparison below so it stays apples-to-apples with
  // the legacy (out-of-scope, fully-settled) P50_54/C5/C0 universes.
  // settledBetsOnly() imported verbatim — no duplicated settlement math.
  betsByModel.set("P50_52", settledBetsOnly(fixedCandidatesByModel.get("P50_52")!, settlementByCandidateIdentity).settledBets);

  // TABLE 1 — daily supply, overall + Aug/Sep split
  const table1: Record<string, { OVERALL: DailySupplyStats; AUGUST: DailySupplyStats; SEPTEMBER: DailySupplyStats }> = {};
  for (const modelId of REQUIRED_MODELS) {
    if (FIXED_PATH_MODELS.has(modelId)) {
      const candidates = fixedCandidatesByModel.get(modelId)!;
      table1[modelId] = {
        OVERALL: partialSupplyStats(modelId, candidates, settlementByCandidateIdentity, dates),
        AUGUST: partialSupplyStats(modelId, candidates, settlementByCandidateIdentity, augDates),
        SEPTEMBER: partialSupplyStats(modelId, candidates, settlementByCandidateIdentity, sepDates),
      };
      continue;
    }
    const bets = betsByModel.get(modelId)!;
    table1[modelId] = {
      OVERALL: supplyStats(modelId, bets, dates),
      AUGUST: supplyStats(modelId, bets, augDates),
      SEPTEMBER: supplyStats(modelId, bets, sepDates),
    };
  }

  // TABLE 2 — cap economics 15/20/30/40/50
  const table2: Record<string, CapEconRow[] | PartialCapEconRow[]> = {};
  const capMapByModel = new Map<string, Map<number, CapEconRow>>();
  const partialCapMapByModel = new Map<string, Map<number, PartialCapEconRow>>();
  for (const modelId of REQUIRED_MODELS) {
    if (FIXED_PATH_MODELS.has(modelId)) {
      const candidates = fixedCandidatesByModel.get(modelId)!;
      const rows: PartialCapEconRow[] = [];
      const capMap = new Map<number, PartialCapEconRow>();
      for (const cap of CAPS) {
        const row = partialCapEconomics(modelId, candidates, settlementByCandidateIdentity, cap, dates);
        rows.push(row);
        capMap.set(cap, row);
      }
      table2[modelId] = rows;
      partialCapMapByModel.set(modelId, capMap);
      continue;
    }
    const bets = betsByModel.get(modelId)!;
    const rows: CapEconRow[] = [];
    const capMap = new Map<number, CapEconRow>();
    for (const cap of CAPS) {
      const row = capEconomics(modelId, bets, cap, dates);
      rows.push(row);
      capMap.set(cap, row);
    }
    table2[modelId] = rows;
    capMapByModel.set(modelId, capMap);
  }

  // TABLE 3 — marginal layers 1-15/16-20/21-30/31-40/41-50
  const table3: Record<string, MarginalLayerRow[] | PartialMarginalLayerRow[]> = {};
  for (const modelId of REQUIRED_MODELS) {
    table3[modelId] = FIXED_PATH_MODELS.has(modelId)
      ? partialMarginalLayers(modelId, partialCapMapByModel.get(modelId)!, dates.length)
      : marginalLayers(modelId, capMapByModel.get(modelId)!, dates.length);
  }

  // TABLE 4 — 30-day P&L projection per cap (already embedded in table2 rows)
  const table4: Record<
    string,
    Array<{ CAP: number; PNL_PER_CALENDAR_DAY: number; PROJECTION_30D_PNL_U_FLAT_1U: number } | { CAP: number; SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: number; PROJECTION_30D_SETTLED_PNL_U_PARTIAL: number }>
  > = {};
  for (const modelId of REQUIRED_MODELS) {
    if (FIXED_PATH_MODELS.has(modelId)) {
      table4[modelId] = (table2[modelId] as PartialCapEconRow[]).map((r) => ({
        CAP: r.cap,
        SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL: r.SETTLED_PNL_U_PER_CALENDAR_DAY_PARTIAL,
        PROJECTION_30D_SETTLED_PNL_U_PARTIAL: r.PROJECTION_30D_SETTLED_PNL_U_PARTIAL,
      }));
      continue;
    }
    table4[modelId] = (table2[modelId] as CapEconRow[]).map((r) => ({
      CAP: r.cap,
      PNL_PER_CALENDAR_DAY: r.PNL_PER_CALENDAR_DAY,
      PROJECTION_30D_PNL_U_FLAT_1U: r.PROJECTION_30D_PNL_U_FLAT_1U,
    }));
  }

  // TABLE 5 — P50_52 -> P50_54 -> C5/C0 widening economics (paired by physicalEventKey).
  // NARROW="P50_52" uses ONLY its settled-only subset (see betsByModel.set("P50_52", ...)
  // above) so this stays apples-to-apples against the legacy (fully-settled) P50_54/C5/C0
  // universes — P50_54/C5/C0 are out of this mission's scope and remain unchanged.
  function pairedWidening(narrowId: string, wideId: string) {
    const narrow = betsByModel.get(narrowId)!;
    const wide = betsByModel.get(wideId)!;
    const narrowKeys = new Set(narrow.map((b) => b.physicalEventKey));
    const addedBets = wide.filter((b) => !narrowKeys.has(b.physicalEventKey));
    const narrowM = metricsFor(narrow);
    const wideM = metricsFor(wide);
    const addedM = metricsFor(addedBets);
    const narrowDaily = supplyStats(narrowId, narrow, dates);
    const wideDaily = supplyStats(wideId, wide, dates);
    return {
      NARROW: narrowId,
      WIDE: wideId,
      NARROW_N: narrowM.events,
      WIDE_N: wideM.events,
      ADDED_EVENT_N: addedBets.length,
      NARROW_PNL_U: narrowM.pnl_u,
      WIDE_PNL_U: wideM.pnl_u,
      ADDED_LAYER_PNL_U: addedM.pnl_u,
      ADDED_LAYER_ROI_PCT: addedM.roi_pct,
      TOTAL_PNL_DELTA_U: round(wideM.pnl_u - narrowM.pnl_u, 4),
      NARROW_MEAN_PER_CALENDAR_DAY: narrowDaily.MEAN_PER_CALENDAR_DAY,
      WIDE_MEAN_PER_CALENDAR_DAY: wideDaily.MEAN_PER_CALENDAR_DAY,
      ADDED_MEAN_PER_CALENDAR_DAY: round(wideDaily.MEAN_PER_CALENDAR_DAY - narrowDaily.MEAN_PER_CALENDAR_DAY, 4),
    };
  }
  const table5 = {
    NOTE: "P50_52_TO_P50_54's NARROW side (P50_52) is the settled-only subset of the selection-before-settlement selection — see TABLE_1.P50_52 for full SELECTED_N/OPEN_N/SETTLEMENT_COVERAGE_PCT.",
    P50_52_TO_P50_54: pairedWidening("P50_52", "P50_54"),
    P50_54_TO_C5: pairedWidening("P50_54", "C5"),
    P50_54_TO_C0: pairedWidening("P50_54", "C0"),
    TENNIS_P50_52_STANDALONE: (() => {
      const bets = betsByModel.get("TENNIS_P50_52")!;
      const m = metricsFor(bets);
      const daily = supplyStats("TENNIS_P50_52", bets, dates);
      return { N: m.events, PNL_U: m.pnl_u, ROI_PCT: m.roi_pct, MEAN_PER_CALENDAR_DAY: daily.MEAN_PER_CALENDAR_DAY, DAYS_ACTIVE: daily.ACTIVE_DAYS };
    })(),
  };

  const artifact = {
    MISSION: "DAILY_CAP_PNL_OPTIMIZATION_V1",
    ENGINE_REUSE:
      "runStandalone/runPortfolio/computeDailyResults/computeUncapped/computeCapacity imported verbatim from scripts/modeling/daily-portfolio-frontier.ts; C5 predicate verbatim from lib/modeling/research-engine/models.ts. P50_52/PORTFOLIO_BROAD (FIXED_PATH_MODELS) use toDecisionTimeSelectionInput/runStandaloneStrict/runPortfolioStrict/computePartialCapacity/partialDailyResults/partialMetricsFor/settledBetsOnly — same predicates/tiers/comparator/applyDailyCap ordering, settlement joined only after selection+cap. Other models here are out of this mission's scope and remain on the legacy toAtlasInput()-filtered path unchanged.",
    FIXED_PATH_MODELS: [...FIXED_PATH_MODELS],
    DATASET_RANGE: { start: START, end: END },
    CALENDAR_DAYS: dates.length,
    SOURCE_ROW_N: rawRows.length,
    PROCESSED_PHYSICAL_EVENT_N: processedN,
    TABLE_1_DAILY_SUPPLY: table1,
    TABLE_2_CAP_ECONOMICS: table2,
    TABLE_3_MARGINAL_LAYERS: table3,
    TABLE_4_30_DAY_PNL_PROJECTION_FLAT_1U_RESEARCH_ONLY: table4,
    TABLE_5_WIDENING_ECONOMICS: table5,
  };

  console.log(JSON.stringify(artifact, null, 2));

  mkdirSync(EVIDENCE_OUT_DIR, { recursive: true });
  const outPath = `${EVIDENCE_OUT_DIR}/DAILY_CAP_PNL_${START}_${END}.json`;
  writeFileSync(outPath, JSON.stringify({ GENERATED_AT: new Date().toISOString(), ...artifact }, null, 2));
  console.error(`Wrote aggregate evidence artifact: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
