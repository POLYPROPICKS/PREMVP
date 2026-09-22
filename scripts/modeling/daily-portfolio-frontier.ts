/**
 * DAILY_PORTFOLIO_FRONTIER_V1 — deterministic daily PnL x ROI x capacity
 * portfolio frontier over the already-immutable Aug04-Aug31 research corpus.
 *
 * Converts the fixed factor-atlas strategy set into DAILY portfolio
 * economics: a strategy's month-total selected bets (one physicalEventKey
 * -> maximum one selected bet, chronological-first qualifying row wins,
 * exactly as the frozen engine) are grouped by their own Minsk calendar day
 * to answer "how many events/day can this strategy actually supply, and at
 * what PnL/ROI, under a capped daily desk of 15/20/30/40/50 events".
 *
 * Local disk only: reads CORPUS/MANIFEST via the existing loadPartition()
 * (fail-closed hash verification) and reuses the existing frozen-range
 * explicit view + frozen-engine primitives verbatim, via factor-atlas.ts's
 * own reusable normalizer/runner. SCREENING ONLY -- never promotes a model,
 * never selects a production winner, never modifies frozen C0/C1/C4/C5.
 *
 *   npx tsx scripts/modeling/daily-portfolio-frontier.ts \
 *     --start=2026-08-04 --end=2026-08-31 --pretty
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildExplicitDateRangeRowView,
  enumerateMinskDates,
  type LoadedPartition,
  type ScorecardReadyRow,
} from "@/lib/modeling/research-corpus/rollingCorpus";
import { evaluateRows } from "@/lib/research-clone/modelReady";
import { evaluateEvent, sortChronologically, aggregateMetrics, settleBetU, type SelectedBet } from "@/lib/modeling/research-engine";
import { toAtlasInput, canonicalJson, sha256, type AtlasInputEvent } from "./factor-atlas";
import { loadPartition } from "./rolling-research-corpus";

export const FRONTIER_OUT_DIR = "modeling/evidence/daily-portfolio-frontier-v1";

const MINSK_OFFSET_MS = 3 * 3600_000;
const CAPS = [15, 20, 30, 40, 50] as const;
const LAYERS: Array<[number, number]> = [
  [15, 20],
  [20, 30],
  [30, 40],
  [40, 50],
];

function minskDate(iso: string): string {
  return new Date(Date.parse(iso) + MINSK_OFFSET_MS).toISOString().slice(0, 10);
}

type AtlasEvaluatedEvent = ReturnType<typeof evaluateEvent> & AtlasInputEvent;

function inC0(entryPrice: number): boolean {
  return entryPrice >= 0.5 && entryPrice < 0.6;
}

// ── Fixed strategy set (standalone) ─────────────────────────────────────────

interface Strategy {
  id: string;
  predicate: (e: AtlasEvaluatedEvent) => boolean;
}

const C0: Strategy = { id: "C0", predicate: (e) => inC0(e.entryPrice) };
const P50_52: Strategy = { id: "P50_52", predicate: (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52 };
const P50_54: Strategy = { id: "P50_54", predicate: (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54 };
const SCORE63_64: Strategy = {
  id: "SCORE63_64",
  predicate: (e) => inC0(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65,
};
const SCORE63_64_P50_52: Strategy = {
  id: "SCORE63_64_P50_52",
  predicate: (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52 && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65,
};
const TENNIS: Strategy = { id: "TENNIS", predicate: (e) => inC0(e.entryPrice) && e.sportFamily === "tennis" };
const TENNIS_P50_52: Strategy = { id: "TENNIS_P50_52", predicate: (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52 && e.sportFamily === "tennis" };
const LEAD12_18: Strategy = { id: "LEAD12_18", predicate: (e) => inC0(e.entryPrice) && e.leadTimeHours >= 12 && e.leadTimeHours < 18 };
const TENNIS_LEAD12_18: Strategy = {
  id: "TENNIS_LEAD12_18",
  predicate: (e) => inC0(e.entryPrice) && e.sportFamily === "tennis" && e.leadTimeHours >= 12 && e.leadTimeHours < 18,
};
const TENNIS_LEAD18_24: Strategy = {
  id: "TENNIS_LEAD18_24",
  predicate: (e) => inC0(e.entryPrice) && e.sportFamily === "tennis" && e.leadTimeHours >= 18 && e.leadTimeHours < 24,
};

export const STANDALONE_STRATEGIES: Strategy[] = [
  C0,
  P50_52,
  P50_54,
  SCORE63_64,
  SCORE63_64_P50_52,
  TENNIS,
  TENNIS_P50_52,
  LEAD12_18,
  TENNIS_LEAD12_18,
  TENNIS_LEAD18_24,
];

// ── Composite portfolios: ordered tiers, highest priority first ────────────

interface Portfolio {
  id: string;
  tiers: Array<(e: AtlasEvaluatedEvent) => boolean>;
}

const TIER_PREFERRED = (e: AtlasEvaluatedEvent) => TENNIS_P50_52.predicate(e) || SCORE63_64_P50_52.predicate(e);
const TIER_P50_52 = (e: AtlasEvaluatedEvent) => P50_52.predicate(e);
const TIER_P52_54 = (e: AtlasEvaluatedEvent) => e.entryPrice >= 0.52 && e.entryPrice < 0.54;
const TIER_REMAINING_C0 = (e: AtlasEvaluatedEvent) => inC0(e.entryPrice);

export const PORTFOLIOS: Portfolio[] = [
  { id: "PORTFOLIO_DUAL", tiers: [TIER_PREFERRED, TIER_P50_52] },
  { id: "PORTFOLIO_BROAD", tiers: [TIER_PREFERRED, TIER_P50_52, TIER_P52_54] },
  { id: "PORTFOLIO_C0_FILL", tiers: [TIER_PREFERRED, TIER_P50_52, TIER_P52_54, TIER_REMAINING_C0] },
];

export interface TieredBet extends SelectedBet {
  tier: number;
  day: string;
}

function toSelectedBet(event: AtlasEvaluatedEvent): SelectedBet {
  return {
    physicalEventKey: event.physicalEventKey,
    decisionTimestamp: event.decisionTimestamp,
    eventStart: event.eventStart,
    leadTimeHours: event.leadTimeHours,
    entryPrice: event.entryPrice,
    sportFamily: event.sportFamily,
    outcome: event.outcome,
    pnlU: settleBetU(event.outcome, event.entryPrice),
    ...(event.ref === undefined ? {} : { ref: event.ref }),
    ...(event.candidateRef === undefined ? {} : { candidateRef: event.candidateRef }),
  };
}

/**
 * ONE standalone strategy: qualification predicate applied BEFORE
 * chronological physical-event selection -- never a post-selection
 * partition. One physicalEventKey -> maximum one selected bet for the whole
 * range (not reset per day); the resulting bets are grouped by their own
 * day afterward for daily/capacity reporting. portfolio_tier is always 1.
 */
export function runStandalone(input: AtlasInputEvent[], predicate: (e: AtlasEvaluatedEvent) => boolean): TieredBet[] {
  const ordered = sortChronologically(input.map((e) => evaluateEvent(e) as AtlasEvaluatedEvent)) as AtlasEvaluatedEvent[];
  const claimed = new Set<string>();
  const bets: TieredBet[] = [];
  for (const event of ordered) {
    if (claimed.has(event.physicalEventKey)) continue;
    if (!predicate(event)) continue;
    claimed.add(event.physicalEventKey);
    bets.push({ ...toSelectedBet(event), tier: 1, day: minskDate(event.decisionTimestamp) });
  }
  return bets;
}

/**
 * ONE composite portfolio: for every physical event, the HIGHEST-priority
 * tier for which ANY of its candidate rows qualifies is resolved first; the
 * event is then assigned to that tier only, and the chronological-first row
 * that satisfies THAT tier's own predicate is selected. An event never
 * appears in two tiers, and an event matching no tier is excluded entirely.
 */
export function runPortfolio(input: AtlasInputEvent[], tiers: Array<(e: AtlasEvaluatedEvent) => boolean>): TieredBet[] {
  const evaluated = input.map((e) => evaluateEvent(e) as AtlasEvaluatedEvent);
  const grouped = new Map<string, AtlasEvaluatedEvent[]>();
  for (const event of evaluated) {
    const list = grouped.get(event.physicalEventKey);
    if (list) list.push(event);
    else grouped.set(event.physicalEventKey, [event]);
  }
  const bets: TieredBet[] = [];
  for (const group of grouped.values()) {
    const sorted = sortChronologically(group) as AtlasEvaluatedEvent[];
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
      const tierPredicate = tiers[tierIndex];
      const winner = sorted.find(tierPredicate);
      if (winner) {
        bets.push({ ...toSelectedBet(winner), tier: tierIndex + 1, day: minskDate(winner.decisionTimestamp) });
        break;
      }
    }
  }
  return bets;
}

// ── Aggregation helpers ──────────────────────────────────────────────────────

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

export function metricsFor(bets: SelectedBet[]): { events: number; wins: number; losses: number; pnl_u: number; roi_pct: number; max_drawdown_u: number } {
  const chrono = [...bets].sort((a, b) => a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey));
  const m = aggregateMetrics(chrono);
  return { events: m.SELECTED_PHYSICAL_EVENT_N, wins: m.WINS, losses: m.LOSSES, pnl_u: m.PNL_U, roi_pct: m.ROI_PCT, max_drawdown_u: m.MAX_DRAWDOWN_U };
}

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

export interface DailyResultRow {
  date: string;
  event_n: number;
  pnl_u: number;
}

export interface UncappedResult {
  events: number;
  wins: number;
  losses: number;
  pnl_u: number;
  roi_pct: number;
  max_drawdown_u: number;
  active_day_n: number;
  mean_events_per_active_day: number;
  median_events_per_active_day: number;
  p25_events_per_active_day: number;
  p75_events_per_active_day: number;
  mean_daily_pnl_u: number;
  median_daily_pnl_u: number;
  pnl_per_active_day: number;
  positive_pnl_day_n: number;
  negative_pnl_day_n: number;
  zero_pnl_day_n: number;
  best_day_pnl_u: number;
  worst_day_pnl_u: number;
  p25_daily_pnl_u: number;
  p75_daily_pnl_u: number;
  days_supply_ge_15: number;
  days_supply_ge_20: number;
  days_supply_ge_30: number;
  days_supply_ge_40: number;
  days_supply_ge_50: number;
}

export interface CapacityResult {
  cap: number;
  selected_event_n: number;
  active_day_n: number;
  total_pnl_u: number;
  roi_pct: number;
  pnl_per_active_day: number;
  mean_selected_events_per_active_day: number;
  median_selected_events_per_active_day: number;
  max_drawdown_u: number;
}

export interface MarginalLayer {
  layer: string;
  incremental_event_n: number;
  incremental_pnl_u: number;
  incremental_roi_pct: number;
  incremental_pnl_per_day: number;
}

/** Every day in the requested range, whether or not the strategy fired. */
export function computeDailyResults(bets: TieredBet[], allDates: string[]): DailyResultRow[] {
  const byDay = new Map<string, TieredBet[]>();
  for (const bet of bets) {
    const list = byDay.get(bet.day);
    if (list) list.push(bet);
    else byDay.set(bet.day, [bet]);
  }
  return allDates.map((date) => {
    const dayBets = byDay.get(date) ?? [];
    return { date, event_n: dayBets.length, pnl_u: round(dayBets.reduce((s, b) => s + b.pnlU, 0), 2) };
  });
}

export function computeUncapped(bets: TieredBet[], allDates: string[]): UncappedResult {
  const base = metricsFor(bets);
  const daily = computeDailyResults(bets, allDates);
  const activeDays = daily.filter((d) => d.event_n > 0);
  const activeEventCounts = activeDays.map((d) => d.event_n).sort((a, b) => a - b);
  const allPnl = daily.map((d) => d.pnl_u).sort((a, b) => a - b);
  const activeDayN = activeDays.length;
  const positive = daily.filter((d) => d.pnl_u > 0).length;
  const negative = daily.filter((d) => d.pnl_u < 0).length;
  const zero = daily.filter((d) => d.pnl_u === 0).length;
  return {
    ...base,
    active_day_n: activeDayN,
    mean_events_per_active_day: activeDayN ? round(activeEventCounts.reduce((s, n) => s + n, 0) / activeDayN, 4) : 0,
    median_events_per_active_day: activeDayN ? median(activeEventCounts) : 0,
    p25_events_per_active_day: activeDayN ? round(percentile(activeEventCounts, 0.25), 4) : 0,
    p75_events_per_active_day: activeDayN ? round(percentile(activeEventCounts, 0.75), 4) : 0,
    mean_daily_pnl_u: round(allPnl.reduce((s, n) => s + n, 0) / allPnl.length, 4),
    median_daily_pnl_u: round(median(allPnl), 4),
    pnl_per_active_day: activeDayN ? round(base.pnl_u / activeDayN, 4) : 0,
    positive_pnl_day_n: positive,
    negative_pnl_day_n: negative,
    zero_pnl_day_n: zero,
    best_day_pnl_u: allPnl.length ? allPnl[allPnl.length - 1] : 0,
    worst_day_pnl_u: allPnl.length ? allPnl[0] : 0,
    p25_daily_pnl_u: round(percentile(allPnl, 0.25), 4),
    p75_daily_pnl_u: round(percentile(allPnl, 0.75), 4),
    days_supply_ge_15: daily.filter((d) => d.event_n >= 15).length,
    days_supply_ge_20: daily.filter((d) => d.event_n >= 20).length,
    days_supply_ge_30: daily.filter((d) => d.event_n >= 30).length,
    days_supply_ge_40: daily.filter((d) => d.event_n >= 40).length,
    days_supply_ge_50: daily.filter((d) => d.event_n >= 50).length,
  };
}

/** Deterministic, feature-neutral capacity ordering: tier ASC, decisionAt ASC, providerEventId ASC. Never uses outcome/pnl. */
function compareCapacityOrder(a: TieredBet, b: TieredBet): number {
  return a.tier - b.tier || a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey);
}

export function applyDailyCap(bets: TieredBet[], cap: number): TieredBet[] {
  const byDay = new Map<string, TieredBet[]>();
  for (const bet of bets) {
    const list = byDay.get(bet.day);
    if (list) list.push(bet);
    else byDay.set(bet.day, [bet]);
  }
  const kept: TieredBet[] = [];
  for (const dayBets of byDay.values()) {
    const ordered = [...dayBets].sort(compareCapacityOrder);
    kept.push(...ordered.slice(0, cap));
  }
  return kept;
}

export function computeCapacity(bets: TieredBet[], cap: number, allDates: string[]): CapacityResult {
  const capped = applyDailyCap(bets, cap);
  const base = metricsFor(capped);
  const daily = computeDailyResults(capped, allDates);
  const activeDays = daily.filter((d) => d.event_n > 0);
  const activeEventCounts = activeDays.map((d) => d.event_n).sort((a, b) => a - b);
  const activeDayN = activeDays.length;
  return {
    cap,
    selected_event_n: base.events,
    active_day_n: activeDayN,
    total_pnl_u: base.pnl_u,
    roi_pct: base.roi_pct,
    pnl_per_active_day: activeDayN ? round(base.pnl_u / activeDayN, 4) : 0,
    mean_selected_events_per_active_day: activeDayN ? round(activeEventCounts.reduce((s, n) => s + n, 0) / activeDayN, 4) : 0,
    median_selected_events_per_active_day: activeDayN ? median(activeEventCounts) : 0,
    max_drawdown_u: base.max_drawdown_u,
  };
}

export function computeMarginal(capacityByCap: Map<number, CapacityResult>): MarginalLayer[] {
  return LAYERS.map(([lo, hi]) => {
    const a = capacityByCap.get(lo)!;
    const b = capacityByCap.get(hi)!;
    const incrementalEventN = b.selected_event_n - a.selected_event_n;
    const incrementalPnl = round(b.total_pnl_u - a.total_pnl_u, 2);
    const incrementalRoi = incrementalEventN > 0 ? round((incrementalPnl / incrementalEventN) * 100, 4) : 0;
    const activeDayN = b.active_day_n || a.active_day_n;
    return {
      layer: `${lo}_TO_${hi}`,
      incremental_event_n: incrementalEventN,
      incremental_pnl_u: incrementalPnl,
      incremental_roi_pct: incrementalRoi,
      incremental_pnl_per_day: activeDayN ? round(incrementalPnl / activeDayN, 4) : 0,
    };
  });
}

function flowClass(meanEventsPerActiveDay: number): "LOW_FLOW" | "MEDIUM_FLOW" | "HIGH_FLOW" {
  if (meanEventsPerActiveDay < 10) return "LOW_FLOW";
  if (meanEventsPerActiveDay < 30) return "MEDIUM_FLOW";
  return "HIGH_FLOW";
}
function roiClass(roiPct: number): "NEGATIVE" | "0_TO_10" | "10_TO_20" | "20_TO_30" | "GE_30" {
  if (roiPct < 0) return "NEGATIVE";
  if (roiPct < 10) return "0_TO_10";
  if (roiPct < 20) return "10_TO_20";
  if (roiPct < 30) return "20_TO_30";
  return "GE_30";
}
function pnlClass(pnlU: number): "NEGATIVE" | "0_TO_25" | "25_TO_75" | "GE_75" {
  if (pnlU < 0) return "NEGATIVE";
  if (pnlU < 25) return "0_TO_25";
  if (pnlU < 75) return "25_TO_75";
  return "GE_75";
}

export interface FrontierRow {
  strategy_id: string;
  uncapped_events: number;
  active_days: number;
  mean_events_per_active_day: number;
  total_pnl_u: number;
  pnl_per_active_day: number;
  roi_pct: number;
  max_drawdown_u: number;
  FLOW_CLASS: string;
  ROI_CLASS: string;
  PNL_CLASS: string;
}

interface FrozenReferenceModel {
  events: number;
  wins: number;
  losses: number;
  pnl_u: number;
  roi_pct: number;
  max_drawdown_u: number;
}
const EXPECTED_C0: Record<string, FrozenReferenceModel> = {
  SEP_PUBLIC_RICH_V1: { events: 239, wins: 159, losses: 80, pnl_u: 74.56, roi_pct: 31.1952, max_drawdown_u: -20.33 },
  SEP_SHADOW_STRATEGIC_V1: { events: 624, wins: 313, losses: 311, pnl_u: -12.46, roi_pct: -1.9964, max_drawdown_u: -42.62 },
};

export interface FrontierBusinessResult {
  RANGE: { START: string; END: string };
  PARTITION_HASHES: Record<string, string>;
  PIT_FUTURE_LEAK_N: number;
  C0_PARITY: Record<string, { PASS: boolean; expected: FrozenReferenceModel; actual: FrozenReferenceModel }>;
  STRATEGY_DEFINITIONS: { STANDALONE: string[]; PORTFOLIOS: Record<string, number> };
  UNCAPPED_RESULTS: Record<string, UncappedResult>;
  DAILY_RESULTS: Record<string, DailyResultRow[]>;
  CAPACITY_RESULTS: Record<string, CapacityResult[]>;
  MARGINAL_CAPACITY_RESULTS: Record<string, MarginalLayer[]>;
  PNL_ROI_FRONTIER: Record<string, FrontierRow[]>;
  CORE_CANDIDATES: Record<string, FrontierRow[]>;
  SATELLITE_CANDIDATES: Record<string, FrontierRow[]>;
}

export function buildFrontierResult(start: string, end: string, partitions: LoadedPartition[]): FrontierBusinessResult {
  const view = buildExplicitDateRangeRowView({ rangeStart: start, rangeEnd: end, partitions });
  if (view.PIT_FUTURE_LEAK_N !== 0) throw new Error(`FRONTIER_PIT_FUTURE_LEAK_NONZERO: ${view.PIT_FUTURE_LEAK_N}`);
  const allDates = enumerateMinskDates(start, end);
  const populationIds = Object.keys(view.POPULATION_ROW_N).sort();

  const C0_PARITY: FrontierBusinessResult["C0_PARITY"] = {};
  const UNCAPPED_RESULTS: FrontierBusinessResult["UNCAPPED_RESULTS"] = {};
  const DAILY_RESULTS: FrontierBusinessResult["DAILY_RESULTS"] = {};
  const CAPACITY_RESULTS: FrontierBusinessResult["CAPACITY_RESULTS"] = {};
  const MARGINAL_CAPACITY_RESULTS: FrontierBusinessResult["MARGINAL_CAPACITY_RESULTS"] = {};
  const PNL_ROI_FRONTIER: FrontierBusinessResult["PNL_ROI_FRONTIER"] = {};
  const CORE_CANDIDATES: FrontierBusinessResult["CORE_CANDIDATES"] = {};
  const SATELLITE_CANDIDATES: FrontierBusinessResult["SATELLITE_CANDIDATES"] = {};

  for (const pop of populationIds) {
    const popRows = view.rows.filter((r: ScorecardReadyRow) => r.populationId === pop);
    const input = toAtlasInput(popRows);

    // --- C0 parity (exact existing engine, against the accepted August authority) ---
    const evaluated = evaluateRows(popRows) as Record<string, any>;
    const actualC0: FrozenReferenceModel = {
      events: evaluated.C0.SELECTED_PHYSICAL_EVENT_N,
      wins: evaluated.C0.WINS,
      losses: evaluated.C0.LOSSES,
      pnl_u: evaluated.C0.PNL_U,
      roi_pct: evaluated.C0.ROI_PCT,
      max_drawdown_u: evaluated.C0.MAX_DRAWDOWN_U,
    };
    const expectedC0 = EXPECTED_C0[pop];
    if (!expectedC0) throw new Error(`C0_PARITY_AUTHORITY_MISSING: ${pop}`);
    const pass = canonicalJson(actualC0) === canonicalJson(expectedC0);
    if (!pass) throw new Error(`C0_PARITY_FAIL: ${pop} expected=${canonicalJson(expectedC0)} actual=${canonicalJson(actualC0)}`);
    C0_PARITY[pop] = { PASS: pass, expected: expectedC0, actual: actualC0 };

    const rows: FrontierRow[] = [];
    const runOne = (strategyId: string, bets: TieredBet[]) => {
      const key = `${pop}::${strategyId}`;
      const uncapped = computeUncapped(bets, allDates);
      UNCAPPED_RESULTS[key] = uncapped;
      DAILY_RESULTS[key] = computeDailyResults(bets, allDates);
      const capacityByCap = new Map<number, CapacityResult>();
      const capacityList: CapacityResult[] = [];
      for (const cap of CAPS) {
        const c = computeCapacity(bets, cap, allDates);
        capacityByCap.set(cap, c);
        capacityList.push(c);
      }
      CAPACITY_RESULTS[key] = capacityList;
      MARGINAL_CAPACITY_RESULTS[key] = computeMarginal(capacityByCap);
      rows.push({
        strategy_id: strategyId,
        uncapped_events: uncapped.events,
        active_days: uncapped.active_day_n,
        mean_events_per_active_day: uncapped.mean_events_per_active_day,
        total_pnl_u: uncapped.pnl_u,
        pnl_per_active_day: uncapped.pnl_per_active_day,
        roi_pct: uncapped.roi_pct,
        max_drawdown_u: uncapped.max_drawdown_u,
        FLOW_CLASS: flowClass(uncapped.mean_events_per_active_day),
        ROI_CLASS: roiClass(uncapped.roi_pct),
        PNL_CLASS: pnlClass(uncapped.pnl_u),
      });
    };

    for (const strategy of STANDALONE_STRATEGIES) {
      runOne(strategy.id, runStandalone(input, strategy.predicate));
    }
    for (const portfolio of PORTFOLIOS) {
      runOne(portfolio.id, runPortfolio(input, portfolio.tiers));
    }

    rows.sort((a, b) => b.total_pnl_u - a.total_pnl_u || b.roi_pct - a.roi_pct || b.mean_events_per_active_day - a.mean_events_per_active_day);
    PNL_ROI_FRONTIER[pop] = rows;
    CORE_CANDIDATES[pop] = rows.filter((r) => r.FLOW_CLASS !== "LOW_FLOW" && r.roi_pct > 0 && r.total_pnl_u > 0);
    SATELLITE_CANDIDATES[pop] = rows.filter((r) => r.FLOW_CLASS === "LOW_FLOW" && r.roi_pct >= 20 && r.total_pnl_u > 0);
  }

  return {
    RANGE: { START: start, END: end },
    PARTITION_HASHES: view.PARTITION_HASHES,
    PIT_FUTURE_LEAK_N: view.PIT_FUTURE_LEAK_N,
    C0_PARITY,
    STRATEGY_DEFINITIONS: {
      STANDALONE: STANDALONE_STRATEGIES.map((s) => s.id),
      PORTFOLIOS: Object.fromEntries(PORTFOLIOS.map((p) => [p.id, p.tiers.length])),
    },
    UNCAPPED_RESULTS,
    DAILY_RESULTS,
    CAPACITY_RESULTS,
    MARGINAL_CAPACITY_RESULTS,
    PNL_ROI_FRONTIER,
    CORE_CANDIDATES,
    SATELLITE_CANDIDATES,
  };
}

export function buildFrontierWithDeterminismProof(
  start: string,
  end: string,
  partitions: LoadedPartition[],
): { result: FrontierBusinessResult; canonicalSha256: string } {
  const result = buildFrontierResult(start, end, partitions);
  const reversed = buildFrontierResult(start, end, [...partitions].reverse());
  const a = sha256(canonicalJson(result));
  const b = sha256(canonicalJson(reversed));
  if (a !== b) throw new Error(`FRONTIER_NONDETERMINISTIC_UNDER_PARTITION_ORDER: ${a} != ${b}`);
  return { result, canonicalSha256: a };
}

function arg(name: string): string | undefined {
  const eq = process.argv.find((v) => v.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function main(): Promise<void> {
  const start = arg("--start");
  const end = arg("--end");
  if (!start || !end) throw new Error("FRONTIER_ARGS_REQUIRED: --start=YYYY-MM-DD --end=YYYY-MM-DD");
  const pretty = process.argv.includes("--pretty");

  const dates = enumerateMinskDates(start, end);
  if (dates.length !== 28) throw new Error(`FRONTIER_RANGE_NOT_28_DAYS: ${dates.length}`);
  const partitions = dates.map((d) => loadPartition(d));
  const { result, canonicalSha256 } = buildFrontierWithDeterminismProof(start, end, partitions);

  const artifact = {
    ARTIFACT: "DAILY_PORTFOLIO_FRONTIER_V1",
    ...result,
    DETERMINISM_REVERSED_PARTITIONS: "PASS",
    CANONICAL_RESULT_SHA256: canonicalSha256,
  };
  const json = JSON.stringify(artifact, null, 2) + "\n";
  mkdirSync(FRONTIER_OUT_DIR, { recursive: true });
  const base = `FRONTIER_${start}_${end}`;
  const jsonPath = join(FRONTIER_OUT_DIR, `${base}.json`);
  writeFileSync(jsonPath, json, "utf8");
  const fileSha = sha256(json);
  writeFileSync(join(FRONTIER_OUT_DIR, `${base}.SHA256SUMS.txt`), `${fileSha}  ${base}.json\n`, "utf8");

  const summary = {
    ARTIFACT: jsonPath.replace(/\\/g, "/"),
    ARTIFACT_SHA256: fileSha,
    CANONICAL_RESULT_SHA256: canonicalSha256,
    AVAILABLE_PARTITION_N: dates.length,
    MISSING_PARTITION_N: 0,
    PIT_FUTURE_LEAK_N: result.PIT_FUTURE_LEAK_N,
    C0_PARITY: result.C0_PARITY,
    PNL_ROI_FRONTIER: result.PNL_ROI_FRONTIER,
    CORE_CANDIDATES: result.CORE_CANDIDATES,
    SATELLITE_CANDIDATES: result.SATELLITE_CANDIDATES,
  };
  console.log(pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
