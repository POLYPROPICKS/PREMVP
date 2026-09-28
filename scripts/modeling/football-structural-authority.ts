/**
 * FOOTBALL_STRUCTURAL_AUTHORITY_V1 — deterministic founder-facing football
 * structural authority for 2026-08-04..2026-09-24 (AUG / SEP_1_12 /
 * SEP_13_24 / COMBINED).
 *
 * Reuses, verbatim, without reimplementing any economics/settlement rule:
 *   - Denominator + fail-closed sport/market reconciliation:
 *     build-football-denominator-reconciliation.ts /
 *     build-football-denominator-reconciliation-v2.ts (this run's v2
 *     extension through 2026-09-24).
 *   - SELECTION_BEFORE_SETTLEMENT_V1 decision-time-only selection, one
 *     physicalEventKey -> maximum one selected bet per tested cell, and the
 *     OPEN/settled split: runStandaloneStrict / classifySettlement /
 *     settledBetsOnly / metricsFor (scripts/modeling/daily-portfolio-frontier.ts).
 *   - evaluateEvent / sortChronologically / settleBetU / aggregateMetrics
 *     (lib/modeling/research-engine) — flat 1u stake, chronological MaxDD.
 *   - DecisionTimeCandidate shape (scripts/modeling/factor-atlas.ts).
 *
 * This file adds ONLY: odds-bucket / timing-bucket / market-structure-bucket
 * / daily-supply reporting predicates and aggregation over those reused
 * primitives. No new settlement math, no new selection rule.
 *
 * DISPLAY_ODDS = 1 / entry_price (BETTING_ECONOMICS_CONTRACT_V2.md §1). All
 * PnL reported here is REFERENCE_PNL / NOT_EXECUTION_AUTHORITY. Exact Score
 * (`soccer_exact_score`) is kept OUTSIDE ordinary HOLD (odds/timing grids)
 * and reported only as its own diagnostic bucket in the market-structure grid.
 *
 * Read-only against the research clone. Writes only under
 * modeling/evidence/football-structural-authority-v2/.
 *
 *   npx tsx scripts/modeling/football-structural-authority.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  runReconciliationV2,
  AUG_END,
  SEP_1_12_END,
  SEP_13_24_START,
  RANGE_START,
  RANGE_END,
  SEP_START,
} from "./build-football-denominator-reconciliation-v2";
import { obj, EXPECTED_CLONE_REF, type SourceRow, type OverlayRecord } from "./build-football-denominator-reconciliation";
import {
  runStandaloneStrict,
  classifySettlement,
  settledBetsOnly,
  metricsFor,
  type SelectedCandidate,
} from "./daily-portfolio-frontier";
import type { DecisionTimeCandidate } from "./factor-atlas";
import { evaluateEvent, type EvaluatedEvent } from "@/lib/modeling/research-engine";
import type { CorpusLabel, DerivedSeries } from "@/lib/modeling/research-corpus/rollingCorpus";

export const OUT_DIR = "modeling/evidence/football-structural-authority-v2";
export const ARTIFACT_BASENAME = `FOOTBALL_STRUCTURAL_AUTHORITY_${RANGE_START}_${RANGE_END}`;

const EMPTY_SERIES: DerivedSeries = {
  observationCount: 0,
  firstEligibleValue: null,
  firstEligibleObservedAt: null,
  lastEligibleValue: null,
  lastEligibleObservedAt: null,
  delta: null,
};

export type PeriodId = "AUG" | "SEP_1_12" | "SEP_13_24" | "COMBINED";
export const PERIOD_IDS: PeriodId[] = ["AUG", "SEP_1_12", "SEP_13_24", "COMBINED"];

export function periodOfModelDate(modelDate: string): "AUG" | "SEP_1_12" | "SEP_13_24" {
  if (modelDate <= AUG_END) return "AUG";
  if (modelDate <= SEP_1_12_END) return "SEP_1_12";
  return "SEP_13_24";
}

// ── Candidate construction: canonical soccer physical events only, per the
// v2 denominator's fail-closed sport reconciliation. ──────────────────────

export interface StructuralCandidate extends DecisionTimeCandidate {
  period: "AUG" | "SEP_1_12" | "SEP_13_24";
  modelDate: string;
}

function overlayIdentityKey(o: { model_date: string; population_id: string; condition_id: string; selected_token_id: string; decision_at: string }): string {
  return `${o.model_date}::${o.population_id}::${o.condition_id}::${o.selected_token_id}::${o.decision_at}`;
}
function sourceIdentityKey(r: SourceRow): string {
  return `${r.model_date}::${r.population_id}::${r.condition_id}::${r.selected_token_id}::${r.decision_at}`;
}

export function buildStructuralCandidates(
  sourceRows: SourceRow[],
  overlay: OverlayRecord[],
): { candidates: StructuralCandidate[]; settlementByCandidateIdentity: Map<string, CorpusLabel> } {
  const overlayByIdentity = new Map<string, OverlayRecord>();
  for (const o of overlay) overlayByIdentity.set(overlayIdentityKey(o), o);

  const candidates: StructuralCandidate[] = [];
  const settlementByCandidateIdentity = new Map<string, CorpusLabel>();

  for (const row of sourceRows) {
    const ov = overlayByIdentity.get(sourceIdentityKey(row));
    if (!ov || ov.reconciled_sport_family !== "soccer") continue;
    if (!row.provider_event_id) continue;
    const cr = obj(row.canonical_row);
    const eventStart = typeof cr.eventStart === "string" ? cr.eventStart : null;
    const entryPrice = row.entry_price_num;
    if (!eventStart) continue;
    if (entryPrice === null || !(entryPrice > 0 && entryPrice < 1)) continue;
    const label = row.settlement_label;
    if (label !== "WIN" && label !== "LOSS" && label !== "OPEN" && label !== "VOID" && label !== "NO_MATCH" && label !== "AMBIGUOUS") continue;

    const candidateIdentity = `${row.condition_id}::${row.selected_token_id}::${row.decision_at}`;
    candidates.push({
      physicalEventKey: row.provider_event_id,
      decisionTimestamp: row.decision_at,
      eventStart,
      entryPrice,
      sportFamily: "soccer",
      ref: row.condition_id,
      candidateRef: row.selected_token_id,
      scoreLevel: typeof cr.scoreLevel === "number" ? cr.scoreLevel : null,
      score: EMPTY_SERIES,
      selectedPrice: EMPTY_SERIES,
      volumeUsd: typeof cr.volumeUsd === "number" ? cr.volumeUsd : null,
      rowLeadTimeHours: typeof cr.leadTimeHours === "number" ? cr.leadTimeHours : null,
      marketTypeRaw: ov.reconciled_market_type,
      candidateIdentity,
      period: periodOfModelDate(row.model_date),
      modelDate: row.model_date,
    });
    settlementByCandidateIdentity.set(candidateIdentity, label as CorpusLabel);
  }
  return { candidates, settlementByCandidateIdentity };
}

// ── Bucket definitions (fixed order = deterministic report order) ─────────

export interface Bucket {
  id: string;
  label: string;
  min: number;
  max: number; // exclusive, except the last bucket in a family (>= min)
}

export const ODDS_BUCKETS: Bucket[] = [
  { id: "LT_1_35", label: "<1.35", min: 0, max: 1.35 },
  { id: "1_35_1_50", label: "1.35-1.50", min: 1.35, max: 1.5 },
  { id: "1_50_1_75", label: "1.50-1.75", min: 1.5, max: 1.75 },
  { id: "1_75_2_00", label: "1.75-2.00", min: 1.75, max: 2.0 },
  { id: "2_00_2_25", label: "2.00-2.25", min: 2.0, max: 2.25 },
  { id: "2_25_2_50", label: "2.25-2.50", min: 2.25, max: 2.5 },
  { id: "2_50_3_00", label: "2.50-3.00", min: 2.5, max: 3.0 },
  { id: "3_00_4_00", label: "3.00-4.00", min: 3.0, max: 4.0 },
  { id: "4_00_5_00", label: "4.00-5.00", min: 4.0, max: 5.0 },
  { id: "GE_5_00", label: "5.00+", min: 5.0, max: Infinity },
];

export const TIMING_BUCKETS: Bucket[] = [
  { id: "LT_1H", label: "<1h", min: -Infinity, max: 1 },
  { id: "1_3H", label: "1-3h", min: 1, max: 3 },
  { id: "3_6H", label: "3-6h", min: 3, max: 6 },
  { id: "6_12H", label: "6-12h", min: 6, max: 12 },
  { id: "12_24H", label: "12-24h", min: 12, max: 24 },
  { id: "GE_24H", label: ">=24h", min: 24, max: Infinity },
];

export function inBucket(value: number, b: Bucket): boolean {
  if (b.max === Infinity) return value >= b.min;
  return value >= b.min && value < b.max;
}

export function displayOdds(entryPrice: number): number {
  return 1 / entryPrice;
}

export type MarketBucketId = "moneyline" | "totals" | "spreads" | "total_corners" | "other_structured" | "soccer_exact_score" | "UNRESOLVED";
export const MARKET_BUCKET_IDS: Exclude<MarketBucketId, "UNRESOLVED">[] = [
  "moneyline",
  "totals",
  "spreads",
  "total_corners",
  "other_structured",
  "soccer_exact_score",
];

export function marketBucketOf(marketTypeRaw: string | null): MarketBucketId {
  if (marketTypeRaw === null) return "UNRESOLVED";
  if (marketTypeRaw === "moneyline") return "moneyline";
  if (marketTypeRaw === "totals") return "totals";
  if (marketTypeRaw === "spreads") return "spreads";
  if (marketTypeRaw === "total_corners") return "total_corners";
  if (marketTypeRaw === "soccer_exact_score") return "soccer_exact_score";
  return "other_structured";
}

/** Exact Score is kept outside ordinary HOLD (odds/timing grids, daily supply). */
export function isOrdinaryHold(marketTypeRaw: string | null): boolean {
  return marketBucketOf(marketTypeRaw) !== "soccer_exact_score";
}

// ── Stats helpers (not economics — plain descriptive statistics) ──────────

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length, 6);
}

/** Linear-interpolation-free "nearest-rank" percentile over a deterministically pre-sorted array. */
export function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return round(sortedValues[idx], 6);
}

export function median(sortedValues: number[]): number | null {
  return percentile(sortedValues, 50);
}

// ── Cell metrics: reuses runStandaloneStrict / settledBetsOnly / metricsFor
// verbatim. This function adds ONLY bucket-membership predicates + the
// display-odds mean/median descriptive stats on top. ──────────────────────

export interface CellMetrics {
  N_SELECTED: number;
  N_SETTLED: number;
  N_OPEN: number;
  N_OTHER_NONTERMINAL: number;
  WINS: number;
  LOSSES: number;
  REFERENCE_PNL_U: number;
  REFERENCE_ROI_SETTLED_PCT: number;
  MAX_DD_U: number;
  MEAN_DISPLAY_ODDS: number | null;
  MEDIAN_DISPLAY_ODDS: number | null;
}

export function computeCell(
  candidates: StructuralCandidate[],
  settlementByCandidateIdentity: Map<string, CorpusLabel>,
  predicate: (e: EvaluatedEvent & DecisionTimeCandidate) => boolean,
): CellMetrics {
  const selected: SelectedCandidate[] = runStandaloneStrict(candidates, predicate as any);
  const { settledBets, openN, otherNonterminalN } = settledBetsOnly(selected, settlementByCandidateIdentity);
  const m = metricsFor(settledBets);
  const odds = selected.map((c) => displayOdds(c.entryPrice)).sort((a, b) => a - b);
  return {
    N_SELECTED: selected.length,
    N_SETTLED: settledBets.length,
    N_OPEN: openN,
    N_OTHER_NONTERMINAL: otherNonterminalN,
    WINS: m.wins,
    LOSSES: m.losses,
    REFERENCE_PNL_U: m.pnl_u,
    REFERENCE_ROI_SETTLED_PCT: m.roi_pct,
    MAX_DD_U: m.max_drawdown_u,
    MEAN_DISPLAY_ODDS: mean(odds),
    MEDIAN_DISPLAY_ODDS: median(odds),
  };
}

function candidatesForPeriod(all: StructuralCandidate[], period: PeriodId): StructuralCandidate[] {
  return period === "COMBINED" ? all : all.filter((c) => c.period === period);
}

// ── B: odds x period grid ──────────────────────────────────────────────────
export function buildOddsGrid(all: StructuralCandidate[], settlement: Map<string, CorpusLabel>) {
  const out: Record<PeriodId, Record<string, CellMetrics>> = { AUG: {}, SEP_1_12: {}, SEP_13_24: {}, COMBINED: {} };
  for (const period of PERIOD_IDS) {
    const periodCandidates = candidatesForPeriod(all, period);
    for (const bucket of ODDS_BUCKETS) {
      out[period][bucket.id] = computeCell(periodCandidates, settlement, (e) => isOrdinaryHold(e.marketTypeRaw) && inBucket(displayOdds(e.entryPrice), bucket));
    }
  }
  return out;
}

// ── C: odds x timing x period grid ─────────────────────────────────────────
export function buildOddsTimingGrid(all: StructuralCandidate[], settlement: Map<string, CorpusLabel>) {
  const out: Record<PeriodId, Record<string, Record<string, CellMetrics>>> = { AUG: {}, SEP_1_12: {}, SEP_13_24: {}, COMBINED: {} };
  for (const period of PERIOD_IDS) {
    const periodCandidates = candidatesForPeriod(all, period);
    out[period] = {};
    for (const oddsBucket of ODDS_BUCKETS) {
      out[period][oddsBucket.id] = {};
      for (const timingBucket of TIMING_BUCKETS) {
        out[period][oddsBucket.id][timingBucket.id] = computeCell(
          periodCandidates,
          settlement,
          (e) => isOrdinaryHold(e.marketTypeRaw) && inBucket(displayOdds(e.entryPrice), oddsBucket) && inBucket(e.leadTimeHours, timingBucket),
        );
      }
    }
  }
  return out;
}

// ── D: market structure x period grid ──────────────────────────────────────
export function buildMarketStructureGrid(all: StructuralCandidate[], settlement: Map<string, CorpusLabel>) {
  const out: Record<PeriodId, Record<string, CellMetrics>> = { AUG: {}, SEP_1_12: {}, SEP_13_24: {}, COMBINED: {} };
  for (const period of PERIOD_IDS) {
    const periodCandidates = candidatesForPeriod(all, period);
    for (const bucketId of MARKET_BUCKET_IDS) {
      out[period][bucketId] = computeCell(periodCandidates, settlement, (e) => marketBucketOf(e.marketTypeRaw) === bucketId);
    }
    // Diagnostic only — never one of the 6 requested buckets, but reported so the
    // grid is honest about rows whose market type could not be resolved at all.
    out[period]["UNRESOLVED_MARKET_TYPE"] = computeCell(periodCandidates, settlement, (e) => marketBucketOf(e.marketTypeRaw) === "UNRESOLVED");
  }
  return out;
}

// ── E: daily supply ─────────────────────────────────────────────────────────
export interface DailySupply {
  CALENDAR_DAY_N: number;
  ACTIVE_DAY_N: number;
  SELECTED_N: number;
  SETTLED_N: number;
  MEAN_SELECTED_PER_DAY: number | null;
  MEDIAN_SELECTED_PER_DAY: number | null;
  P25_SELECTED_PER_DAY: number | null;
  P75_SELECTED_PER_DAY: number | null;
  MAX_SELECTED_PER_DAY: number | null;
}

const CALENDAR_DAY_N: Record<PeriodId, number> = {
  AUG: 28, // 2026-08-04..2026-08-31
  SEP_1_12: 12, // 2026-09-01..2026-09-12
  SEP_13_24: 12, // 2026-09-13..2026-09-24
  COMBINED: 52, // 2026-08-04..2026-09-24
};

function dailySupplyFor(periodCandidates: StructuralCandidate[], settlement: Map<string, CorpusLabel>, predicate: (e: EvaluatedEvent & DecisionTimeCandidate) => boolean, calendarDayN: number): DailySupply {
  const selected = runStandaloneStrict(periodCandidates, predicate as any);
  const settled = settledBetsOnly(selected, settlement);
  const byDay = new Map<string, number>();
  for (const c of selected) byDay.set(c.day, (byDay.get(c.day) ?? 0) + 1);
  const counts = [...byDay.keys()].sort().map((d) => byDay.get(d)!);
  return {
    CALENDAR_DAY_N: calendarDayN,
    ACTIVE_DAY_N: byDay.size,
    SELECTED_N: selected.length,
    SETTLED_N: settled.settledBets.length,
    MEAN_SELECTED_PER_DAY: mean(counts),
    MEDIAN_SELECTED_PER_DAY: median([...counts].sort((a, b) => a - b)),
    P25_SELECTED_PER_DAY: percentile([...counts].sort((a, b) => a - b), 25),
    P75_SELECTED_PER_DAY: percentile([...counts].sort((a, b) => a - b), 75),
    MAX_SELECTED_PER_DAY: counts.length ? Math.max(...counts) : null,
  };
}

export function buildDailySupply(all: StructuralCandidate[], settlement: Map<string, CorpusLabel>) {
  const out: Record<PeriodId, { ORDINARY_HOLD: DailySupply; EXACT_SCORE: DailySupply }> = {} as any;
  for (const period of PERIOD_IDS) {
    const periodCandidates = candidatesForPeriod(all, period);
    out[period] = {
      ORDINARY_HOLD: dailySupplyFor(periodCandidates, settlement, (e) => isOrdinaryHold(e.marketTypeRaw), CALENDAR_DAY_N[period]),
      EXACT_SCORE: dailySupplyFor(periodCandidates, settlement, (e) => marketBucketOf(e.marketTypeRaw) === "soccer_exact_score", CALENDAR_DAY_N[period]),
    };
  }
  return out;
}

// ── F: structural interaction cells needed for the reference reconciliation ─
export function buildStructuralInteractionCells(all: StructuralCandidate[], settlement: Map<string, CorpusLabel>) {
  const cell = (period: PeriodId, oddsId: string, extra: (e: EvaluatedEvent & DecisionTimeCandidate) => boolean) => {
    const oddsBucket = ODDS_BUCKETS.find((b) => b.id === oddsId)!;
    const periodCandidates = candidatesForPeriod(all, period);
    return computeCell(periodCandidates, settlement, (e) => isOrdinaryHold(e.marketTypeRaw) && inBucket(displayOdds(e.entryPrice), oddsBucket) && extra(e));
  };
  const timing = (id: string) => TIMING_BUCKETS.find((b) => b.id === id)!;
  return {
    "1_75_2_00__12_24H": cell("COMBINED", "1_75_2_00", (e) => inBucket(e.leadTimeHours, timing("12_24H"))),
    "1_75_2_00__3_6H": cell("COMBINED", "1_75_2_00", (e) => inBucket(e.leadTimeHours, timing("3_6H"))),
    "2_25_2_50__OTHER_STRUCTURED": cell("COMBINED", "2_25_2_50", (e) => marketBucketOf(e.marketTypeRaw) === "other_structured"),
    "2_25_2_50__TOTAL_CORNERS": cell("COMBINED", "2_25_2_50", (e) => marketBucketOf(e.marketTypeRaw) === "total_corners"),
  };
}

// ── DB bootstrap ─────────────────────────────────────────────────────────
function projectRef(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

export async function connectClone() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("REQUIRED_CLONE_READ_AUTHORIZATION_UNAVAILABLE");
  if (projectRef(url) !== EXPECTED_CLONE_REF || (process.env.SUPABASE_URL && projectRef(process.env.SUPABASE_URL) === projectRef(url))) {
    throw new Error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH");
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export interface StructuralAuthorityArtifact {
  MISSION: string;
  RANGE: string;
  PERIODS: Record<PeriodId, string>;
  SEMANTICS: Record<string, string>;
  DENOMINATOR: unknown;
  ODDS_GRID: unknown;
  ODDS_TIMING_GRID: unknown;
  MARKET_STRUCTURE_GRID: unknown;
  DAILY_SUPPLY: unknown;
  STRUCTURAL_INTERACTION_CELLS: unknown;
  NOT_EXECUTION_AUTHORITY: true;
  REFERENCE_PNL_LABEL: "REFERENCE_PNL / NOT_EXECUTION_AUTHORITY";
}

export async function buildArtifact(db: any): Promise<StructuralAuthorityArtifact> {
  const recon = await runReconciliationV2(db);
  const { candidates, settlementByCandidateIdentity } = buildStructuralCandidates(recon.sourceRows, recon.overlay);

  const oddsGrid = buildOddsGrid(candidates, settlementByCandidateIdentity);
  const oddsTimingGrid = buildOddsTimingGrid(candidates, settlementByCandidateIdentity);
  const marketGrid = buildMarketStructureGrid(candidates, settlementByCandidateIdentity);
  const dailySupply = buildDailySupply(candidates, settlementByCandidateIdentity);
  const interactionCells = buildStructuralInteractionCells(candidates, settlementByCandidateIdentity);

  return {
    MISSION: "FOOTBALL_STRUCTURAL_AUTHORITY_V1",
    RANGE: `${RANGE_START}..${RANGE_END}`,
    PERIODS: {
      AUG: `${RANGE_START}..${AUG_END}`,
      SEP_1_12: `${SEP_START}..${SEP_1_12_END}`,
      SEP_13_24: `${SEP_13_24_START}..${RANGE_END}`,
      COMBINED: `${RANGE_START}..${RANGE_END}`,
    },
    SEMANTICS: {
      SELECTION: "SELECTION_BEFORE_SETTLEMENT_V1 (scripts/modeling/daily-portfolio-frontier.ts runStandaloneStrict)",
      MAX_BETS_PER_EVENT_PER_CELL: "1 (physicalEventKey-scoped, chronological-first qualifying row wins)",
      OPEN_HANDLING: "OPEN keeps the selected slot; excluded from settled PnL/ROI, counted in N_OPEN",
      STAKE: "flat 1u (lib/modeling/research-engine/settlement.ts settleBetU)",
      ODDS: "DISPLAY_ODDS = 1 / entry_price (BETTING_ECONOMICS_CONTRACT_V2.md #DISPLAY_ODDS)",
      EXACT_SCORE: "soccer_exact_score kept OUTSIDE ordinary HOLD (odds/timing grids, daily supply); reported only as its own market-structure/daily-supply diagnostic bucket",
      PNL_LABEL: "REFERENCE_PNL / NOT_EXECUTION_AUTHORITY (BETTING_ECONOMICS_CONTRACT_V2.md #2)",
    },
    DENOMINATOR: {
      AUG: recon.periods.AUG,
      SEP_1_12: recon.periods.SEP_1_12,
      SEP_13_24: recon.periods.SEP_13_24,
      COMBINED: recon.periods.COMBINED,
    },
    ODDS_GRID: oddsGrid,
    ODDS_TIMING_GRID: oddsTimingGrid,
    MARKET_STRUCTURE_GRID: marketGrid,
    DAILY_SUPPLY: dailySupply,
    STRUCTURAL_INTERACTION_CELLS: interactionCells,
    NOT_EXECUTION_AUTHORITY: true,
    REFERENCE_PNL_LABEL: "REFERENCE_PNL / NOT_EXECUTION_AUTHORITY",
  };
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function mdTable(rows: Array<[string, CellMetrics]>): string {
  const header = "| Bucket | N_SELECTED | N_SETTLED | N_OPEN | WINS | LOSSES | REFERENCE_PNL_U | ROI_SETTLED_% | MAX_DD_U | MEAN_ODDS | MEDIAN_ODDS |\n|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map(
    ([label, m]) =>
      `| ${label} | ${m.N_SELECTED} | ${m.N_SETTLED} | ${m.N_OPEN} | ${m.WINS} | ${m.LOSSES} | ${m.REFERENCE_PNL_U} | ${m.REFERENCE_ROI_SETTLED_PCT} | ${m.MAX_DD_U} | ${m.MEAN_DISPLAY_ODDS ?? "-"} | ${m.MEDIAN_DISPLAY_ODDS ?? "-"} |`,
  );
  return [header, ...lines].join("\n");
}

function buildMarkdown(a: StructuralAuthorityArtifact): string {
  const sections: string[] = [];
  sections.push(`# Football Structural Authority — ${a.RANGE}\n\nStatus: **STRUCTURAL / ECONOMICS DIAGNOSTIC AUTHORITY — ${a.REFERENCE_PNL_LABEL}**\n`);
  sections.push(`## Denominator (from football-denominator-reconciliation-v2)\n`);
  for (const p of PERIOD_IDS) {
    const d = (a.DENOMINATOR as any)[p];
    sections.push(`- **${p}** (${d.RANGE}): SOURCE_ROW_N=${d.SOURCE_ROW_N}, UNIQUE_PHYSICAL_EVENT_N=${d.UNIQUE_PHYSICAL_EVENT_N}, CANONICAL_SOCCER_PHYSICAL_EVENT_N=${d.stats.canonical_soccer_physical_event_n}, SPORT_UNRESOLVED_N=${d.SPORT_UNRESOLVED_N}`);
  }
  for (const p of PERIOD_IDS) {
    sections.push(`\n## Odds grid — ${p}\n`);
    const rows: Array<[string, CellMetrics]> = ODDS_BUCKETS.map((b) => [b.label, (a.ODDS_GRID as any)[p][b.id]]);
    sections.push(mdTable(rows));
  }
  for (const p of PERIOD_IDS) {
    sections.push(`\n## Market structure grid — ${p}\n`);
    const rows: Array<[string, CellMetrics]> = [...MARKET_BUCKET_IDS, "UNRESOLVED_MARKET_TYPE"].map((id) => [id, (a.MARKET_STRUCTURE_GRID as any)[p][id]]);
    sections.push(mdTable(rows));
  }
  sections.push(`\n## Daily supply\n`);
  const supplyHeader = "| Period | Bucket | CALENDAR_DAY_N | ACTIVE_DAY_N | SELECTED_N | SETTLED_N | MEAN/DAY | MEDIAN/DAY | P25/DAY | P75/DAY | MAX/DAY |\n|---|---|---|---|---|---|---|---|---|---|---|";
  const supplyRows: string[] = [];
  for (const p of PERIOD_IDS) {
    for (const bucket of ["ORDINARY_HOLD", "EXACT_SCORE"] as const) {
      const s = (a.DAILY_SUPPLY as any)[p][bucket] as DailySupply;
      supplyRows.push(`| ${p} | ${bucket} | ${s.CALENDAR_DAY_N} | ${s.ACTIVE_DAY_N} | ${s.SELECTED_N} | ${s.SETTLED_N} | ${s.MEAN_SELECTED_PER_DAY ?? "-"} | ${s.MEDIAN_SELECTED_PER_DAY ?? "-"} | ${s.P25_SELECTED_PER_DAY ?? "-"} | ${s.P75_SELECTED_PER_DAY ?? "-"} | ${s.MAX_SELECTED_PER_DAY ?? "-"} |`);
    }
  }
  sections.push([supplyHeader, ...supplyRows].join("\n"));
  sections.push(`\n## Structural interaction cells (reference reconciliation targets)\n`);
  const icHeader = "| Cell | N_SELECTED | N_SETTLED | REFERENCE_PNL_U | ROI_SETTLED_% |\n|---|---|---|---|---|";
  const icRows = Object.entries(a.STRUCTURAL_INTERACTION_CELLS as Record<string, CellMetrics>).map(
    ([k, m]) => `| ${k} | ${m.N_SELECTED} | ${m.N_SETTLED} | ${m.REFERENCE_PNL_U} | ${m.REFERENCE_ROI_SETTLED_PCT} |`,
  );
  sections.push([icHeader, ...icRows].join("\n"));
  sections.push(`\n## Scope and non-claims\n\n- \`${a.REFERENCE_PNL_LABEL}\`\n- All odds are \`DISPLAY_ODDS\` (BETTING_ECONOMICS_CONTRACT_V2.md), never AVAILABLE/FILL/NET odds.\n- \`soccer_exact_score\` is excluded from every odds/timing grid cell and from ORDINARY_HOLD daily supply.\n- No production write, no model ranking/promotion performed here.\n`);
  return sections.join("\n");
}

async function main() {
  const db = await connectClone();
  const artifact = await buildArtifact(db);

  mkdirSync(OUT_DIR, { recursive: true });
  const json = canonicalStringify(artifact);
  writeFileSync(join(OUT_DIR, `${ARTIFACT_BASENAME}.json`), json);
  const md = buildMarkdown(artifact);
  writeFileSync(join(OUT_DIR, `${ARTIFACT_BASENAME}.md`), md);

  const jsonSha256 = createHash("sha256").update(json, "utf8").digest("hex");
  const mdSha256 = createHash("sha256").update(md, "utf8").digest("hex");
  const shaLines = [`${jsonSha256}  ${ARTIFACT_BASENAME}.json`, `${mdSha256}  ${ARTIFACT_BASENAME}.md`];
  writeFileSync(join(OUT_DIR, "SHA256SUMS.txt"), shaLines.join("\n") + "\n");

  console.log(JSON.stringify({ STATUS: "SUCCESS", ARTIFACT_JSON_SHA256: jsonSha256, PRODUCTION_WRITES: 0, CLONE_DB_WRITES: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
