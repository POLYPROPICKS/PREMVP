// Extended Historical Decomposition Engine (Phase 4A.2 / A1).
//
// One deterministic, reusable decomposition of the canonical historical
// corpus across the analytical dimensions the current scorecard does not yet
// cover: score/price/implied-odds/coverage/timing/formula-version bands,
// event concentration, keep-all vs canonical one-per-event comparison, and
// maximum-drawdown / longest-losing-streak attribution.
//
// Reuse only -- no new math: strict dedup
// (generatedSignalPairsDedupPolicy), variant selection
// (evaluateHistoricalFunnelVariant), ROI/PnL (roiPnlContract), equity/
// drawdown/streak (computeFlatUnitEquityMetrics + the same canonical
// chronological order and computeRowReturnPct per-row returns), event
// identity (eventGroupSelection), sport/market classifiers
// (sportMarketPerformanceSlice). Pure: no fs/env/network/Supabase, no
// forward rows, no mutation of input. HISTORICAL RESEARCH ONLY -- no model
// promotion, no Champion.

import { createHash } from "node:crypto";
import {
  projectGeneratedSignalPairsStrictDedup,
  STRICT_DEDUP_POLICY_NAME,
} from "./generatedSignalPairsDedupPolicy";
import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";
import {
  evaluateHistoricalFunnelVariant,
  getScoreValue,
  getCoverageValue,
  getHoursUntilStartValue,
} from "./historicalFunnelVariants";
import { computeFlatUnitEquityMetrics } from "./historicalFunnelComparison";
import { computeFlatStakeRoiSummary, computeRowReturnPct } from "./roiPnlContract";
import { buildEventGroupKey, groupRowsByEventGroup } from "./eventGroupSelection";
import { classifySport, classifyMarketType } from "./sportMarketPerformanceSlice";
import { getBundle, type ExecutableFunnelClassifier } from "./executableFunnelClassifier";

type Row = ExportRow;

export const DECOMPOSITION_ENGINE_VERSION = "4A.2-extended-decomposition-v1" as const;

/**
 * Decomposition dimensions excluded from global cross-model/evidence
 * ranking pools because they are a deterministic mirror of another
 * dimension already counted there. impliedOddsBands is a 1:1 function of
 * priceBands (see impliedOddsBandOf) -- counting both as independent
 * findings would double-count the same rows. Price is the canonical
 * dimension; implied odds remains a derived secondary label in detail
 * tables only.
 */
export const EVIDENCE_MIRROR_DIMENSIONS = ["impliedOddsBands"] as const;

// ---- immutable bucket contracts ----

export const SCORE_BANDS = [
  "BELOW_65",
  "SCORE_65_TO_71_99",
  "SCORE_72_TO_79_99",
  "SCORE_80_PLUS",
  "MISSING_OR_INVALID",
] as const;

export const PRICE_BANDS = [
  "PRICE_BELOW_0_30",
  "PRICE_0_30_TO_0_43",
  "PRICE_0_44_TO_0_58",
  "PRICE_0_59_TO_0_74",
  "PRICE_0_75_PLUS",
  "MISSING_OR_INVALID",
] as const;

export const IMPLIED_ODDS_BANDS = [
  "ODDS_ABOVE_3_33",
  "ODDS_2_28_TO_3_33",
  "ODDS_1_70_TO_2_27",
  "ODDS_1_34_TO_1_69",
  "ODDS_1_33_OR_LESS",
  "MISSING_OR_INVALID",
] as const;

export const COVERAGE_BANDS = [
  "COVERAGE_BELOW_25",
  "COVERAGE_25_TO_49",
  "COVERAGE_50_TO_74",
  "COVERAGE_75_TO_89",
  "COVERAGE_90_TO_100",
  "MISSING_OR_INVALID",
] as const;

export const TIMING_BUCKETS = [
  "ALREADY_STARTED_OR_INVALID",
  "T_0_TO_3H",
  "T_3_TO_6H",
  "T_6_TO_12H",
  "T_12_TO_24H",
  "T_24_TO_48H",
  "T_48H_PLUS",
  "UNKNOWN_START_TIME",
] as const;

export type ScoreBand = (typeof SCORE_BANDS)[number];
export type PriceBand = (typeof PRICE_BANDS)[number];
export type ImpliedOddsBand = (typeof IMPLIED_ODDS_BANDS)[number];
export type CoverageBand = (typeof COVERAGE_BANDS)[number];
export type TimingBucket = (typeof TIMING_BUCKETS)[number];

// ---- bucket classifiers (reusing canonical field adapters, never new field semantics) ----

/** Score band from the canonical getScoreValue adapter. */
export function scoreBandOf(row: Row): ScoreBand {
  const s = getScoreValue(row);
  if (s === null) return "MISSING_OR_INVALID";
  if (s < 65) return "BELOW_65";
  if (s < 72) return "SCORE_65_TO_71_99";
  if (s < 80) return "SCORE_72_TO_79_99";
  return "SCORE_80_PLUS";
}

function entryPrice(row: Row): number | null {
  const v = row.entry_price_num;
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1 ? v : null;
}

/** Entry-price band; the 0.44-0.58 band is a locked historical quality segment and stays explicit. */
export function priceBandOf(row: Row): PriceBand {
  const p = entryPrice(row);
  if (p === null) return "MISSING_OR_INVALID";
  if (p < 0.3) return "PRICE_BELOW_0_30";
  if (p < 0.44) return "PRICE_0_30_TO_0_43";
  if (p < 0.59) return "PRICE_0_44_TO_0_58";
  if (p < 0.75) return "PRICE_0_59_TO_0_74";
  return "PRICE_0_75_PLUS";
}

/**
 * Implied decimal-odds band. Derived ONLY when 0 < entry_price_num <= 1
 * (decimalOdds = 1/price); the bands correspond one-to-one to the price
 * bands, so band membership can never disagree between the two dimensions.
 * These are calculated implied odds, NOT executed sportsbook odds.
 */
export function impliedOddsBandOf(row: Row): ImpliedOddsBand {
  const band = priceBandOf(row);
  switch (band) {
    case "PRICE_BELOW_0_30":
      return "ODDS_ABOVE_3_33";
    case "PRICE_0_30_TO_0_43":
      return "ODDS_2_28_TO_3_33";
    case "PRICE_0_44_TO_0_58":
      return "ODDS_1_70_TO_2_27";
    case "PRICE_0_59_TO_0_74":
      return "ODDS_1_34_TO_1_69";
    case "PRICE_0_75_PLUS":
      return "ODDS_1_33_OR_LESS";
    default:
      return "MISSING_OR_INVALID";
  }
}

/** Coverage band from the canonical diagnostics.dataCoverage path (getCoverageValue). */
export function coverageBandOf(row: Row): CoverageBand {
  const c = getCoverageValue(row);
  if (c === null || c < 0 || c > 100) return "MISSING_OR_INVALID";
  if (c < 25) return "COVERAGE_BELOW_25";
  if (c < 50) return "COVERAGE_25_TO_49";
  if (c < 75) return "COVERAGE_50_TO_74";
  if (c < 90) return "COVERAGE_75_TO_89";
  return "COVERAGE_90_TO_100";
}

/** Timing bucket from the canonical gameStartIso - created_at adapter; never substitutes resolved_at. */
export function timingBucketOf(row: Row): TimingBucket {
  const h = getHoursUntilStartValue(row);
  if (h === null) return "UNKNOWN_START_TIME";
  if (h <= 0) return "ALREADY_STARTED_OR_INVALID";
  if (h < 3) return "T_0_TO_3H";
  if (h < 6) return "T_3_TO_6H";
  if (h < 12) return "T_6_TO_12H";
  if (h < 24) return "T_12_TO_24H";
  if (h < 48) return "T_24_TO_48H";
  return "T_48H_PLUS";
}

const MISSING_VERSION_BUCKET = "MISSING_OR_INVALID";

function versionBucketOf(row: Row, field: "formula_version" | "metric_formula_version"): string {
  const v = row[field];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : MISSING_VERSION_BUCKET;
}

// ---- sample classes ----

export type DecompositionSampleClass = "ROBUST" | "MODERATE" | "LOW" | "INSUFFICIENT";

/** ROBUST >= 100, MODERATE 30..99, LOW 10..29, INSUFFICIENT < 10. */
export function sampleClassOf(n: number): DecompositionSampleClass {
  if (n >= 100) return "ROBUST";
  if (n >= 30) return "MODERATE";
  if (n >= 10) return "LOW";
  return "INSUFFICIENT";
}

// ---- segment metrics (canonical engines only) ----

export interface DecompositionSegmentMetrics {
  observations: number;
  wins: number;
  losses: number;
  voidOrInvalid: number;
  winRate: number | null;
  flatUnitPnl: number | null;
  flatUnitRoi: number | null;
  uniqueMarkets: number;
  workingEventGroups: number;
  maximumSignalsPerWorkingEvent: number;
  maximumDrawdownUnits: number;
  longestLosingStreak: number;
  sampleClass: DecompositionSampleClass;
}

function strOf(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Segment metrics: ROI/PnL via computeFlatStakeRoiSummary, equity via computeFlatUnitEquityMetrics -- never re-derived. */
export function computeSegmentMetrics(rows: readonly Row[]): DecompositionSegmentMetrics {
  const roi = computeFlatStakeRoiSummary([...rows], { strict: false, stakeUnits: 1 });
  const equity = computeFlatUnitEquityMetrics(rows);
  const markets = new Set<string>();
  const eventCounts = new Map<string, number>();
  for (const row of rows) {
    const cond = strOf(row, "condition_id");
    if (cond !== null) markets.add(cond);
    const key = buildEventGroupKey(row).key;
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }
  const counts = [...eventCounts.values()];
  return {
    observations: rows.length,
    wins: roi.winCount,
    losses: roi.lossCount,
    voidOrInvalid: rows.length - roi.winCount - roi.lossCount,
    winRate: roi.winRatePct,
    flatUnitPnl: roi.totalPnlUnits,
    flatUnitRoi: roi.roiPct,
    uniqueMarkets: markets.size,
    workingEventGroups: eventCounts.size,
    maximumSignalsPerWorkingEvent: counts.length > 0 ? Math.max(...counts) : 0,
    maximumDrawdownUnits: equity.maximumDrawdownUnits,
    longestLosingStreak: equity.longestLosingStreak,
    sampleClass: sampleClassOf(rows.length),
  };
}

export interface DecompositionBucket {
  bucket: string;
  metrics: DecompositionSegmentMetrics;
}

function decomposeBy(rows: readonly Row[], order: readonly string[], bucketOf: (row: Row) => string): DecompositionBucket[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const bucket = bucketOf(row);
    const list = groups.get(bucket) ?? [];
    list.push(row);
    groups.set(bucket, list);
  }
  const known = order.map((bucket) => ({ bucket, metrics: computeSegmentMetrics(groups.get(bucket) ?? []) }));
  // Buckets outside the fixed contract (formula versions) are appended in
  // deterministic lexicographic order.
  const extras = [...groups.keys()]
    .filter((k) => !order.includes(k))
    .sort()
    .map((bucket) => ({ bucket, metrics: computeSegmentMetrics(groups.get(bucket)!) }));
  return [...known, ...extras];
}

function decomposeByVersions(rows: readonly Row[], field: "formula_version" | "metric_formula_version"): DecompositionBucket[] {
  return decomposeBy(rows, [], (r) => versionBucketOf(r, field)).sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}

// ---- event concentration ----

export interface EventConcentrationDetail {
  selectedObservations: number;
  workingEventGroups: number;
  maximumSignalsPerWorkingEvent: number;
  eventsWith1Signal: number;
  eventsWith2Signals: number;
  eventsWith3Signals: number;
  eventsWith4Signals: number;
  eventsWith5PlusSignals: number;
  signalsFromMultiSignalEvents: number;
  pnlFromSingleSignalEvents: number | null;
  pnlFromMultiSignalEvents: number | null;
}

export function computeEventConcentrationDetail(rows: readonly Row[]): EventConcentrationDetail {
  const groups = groupRowsByEventGroup(rows);
  const counts = [...groups.values()].map((g) => g.length);
  const singleRows: Row[] = [];
  const multiRows: Row[] = [];
  for (const group of groups.values()) {
    (group.length === 1 ? singleRows : multiRows).push(...group);
  }
  const singleRoi = computeFlatStakeRoiSummary(singleRows, { strict: false, stakeUnits: 1 });
  const multiRoi = computeFlatStakeRoiSummary(multiRows, { strict: false, stakeUnits: 1 });
  const countOf = (n: number) => counts.filter((c) => c === n).length;
  return {
    selectedObservations: rows.length,
    workingEventGroups: groups.size,
    maximumSignalsPerWorkingEvent: counts.length > 0 ? Math.max(...counts) : 0,
    eventsWith1Signal: countOf(1),
    eventsWith2Signals: countOf(2),
    eventsWith3Signals: countOf(3),
    eventsWith4Signals: countOf(4),
    eventsWith5PlusSignals: counts.filter((c) => c >= 5).length,
    signalsFromMultiSignalEvents: multiRows.length,
    pnlFromSingleSignalEvents: singleRoi.totalPnlUnits,
    pnlFromMultiSignalEvents: multiRoi.totalPnlUnits,
  };
}

// ---- keep-all vs canonical one-per-event ----

function scoreOrZero(row: Row): number {
  return getScoreValue(row) ?? 0;
}
function coverageOrZero(row: Row): number {
  return getCoverageValue(row) ?? 0;
}

/**
 * The exact canonical one-per-event selection ALT1 executes: stable sort by
 * score desc, then stable sort by coverage desc (coverage becomes the
 * primary key -- identical to the evaluator's buffered ORDER flush), then
 * keep the first row of each canonical event group. No new key, no new
 * tie-break.
 */
function canonicalOnePerEvent(rows: readonly Row[]): Row[] {
  let ordered = [...rows].sort((a, b) => scoreOrZero(b) - scoreOrZero(a));
  ordered = [...ordered].sort((a, b) => coverageOrZero(b) - coverageOrZero(a));
  const groups = groupRowsByEventGroup(ordered);
  return [...groups.values()].map((group) => group[0]);
}

export interface OnePerEventComparison {
  keepAll: DecompositionSegmentMetrics;
  onePerEvent: DecompositionSegmentMetrics;
  onePerEventSelectedSourceIds: string[];
  deltas: {
    observations: number;
    workingEventGroups: number;
    flatUnitPnl: number | null;
    flatUnitRoi: number | null;
    maximumDrawdownUnits: number;
    longestLosingStreak: number;
    maximumSignalsPerWorkingEvent: number;
  };
}

/** Analysis only -- never a new model ID. */
export function compareKeepAllVsOnePerEvent(rows: readonly Row[]): OnePerEventComparison {
  const keepAll = computeSegmentMetrics(rows);
  const selected = canonicalOnePerEvent(rows);
  const onePerEvent = computeSegmentMetrics(selected);
  const ids = selected
    .map((r) => strOf(r, "id") ?? "")
    .filter((v) => v !== "")
    .sort();
  return {
    keepAll,
    onePerEvent,
    onePerEventSelectedSourceIds: ids,
    deltas: {
      observations: onePerEvent.observations - keepAll.observations,
      workingEventGroups: onePerEvent.workingEventGroups - keepAll.workingEventGroups,
      flatUnitPnl:
        onePerEvent.flatUnitPnl !== null && keepAll.flatUnitPnl !== null ? onePerEvent.flatUnitPnl - keepAll.flatUnitPnl : null,
      flatUnitRoi:
        onePerEvent.flatUnitRoi !== null && keepAll.flatUnitRoi !== null ? onePerEvent.flatUnitRoi - keepAll.flatUnitRoi : null,
      maximumDrawdownUnits: onePerEvent.maximumDrawdownUnits - keepAll.maximumDrawdownUnits,
      longestLosingStreak: onePerEvent.longestLosingStreak - keepAll.longestLosingStreak,
      maximumSignalsPerWorkingEvent: onePerEvent.maximumSignalsPerWorkingEvent - keepAll.maximumSignalsPerWorkingEvent,
    },
  };
}

// ---- chronological walk shared by drawdown/streak location ----

interface BetStep {
  row: Row;
  returnUnits: number;
  isWin: boolean;
  isLoss: boolean;
}

function validMs(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * The exact canonical chronological bet walk computeFlatUnitEquityMetrics
 * performs: resolved_at ASC then id ASC, per-row return via
 * computeRowReturnPct (unresolved/invalid rows place no bet). This function
 * only LOCATES intervals -- every aggregate figure it reports is reconciled
 * against computeFlatUnitEquityMetrics in tests.
 */
function chronologicalBets(rows: readonly Row[]): BetStep[] {
  const ordered = [...rows].sort((a, b) => {
    const am = validMs(a.resolved_at);
    const bm = validMs(b.resolved_at);
    if (am !== bm) return am - bm;
    const ai = strOf(a, "id") ?? "";
    const bi = strOf(b, "id") ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  const bets: BetStep[] = [];
  for (const row of ordered) {
    const computed = computeRowReturnPct(row);
    if (computed.returnPct === null) continue;
    bets.push({ row, returnUnits: computed.returnPct / 100, isWin: computed.label === "win", isLoss: computed.label === "loss" });
  }
  return bets;
}

// ---- attribution over a row subset ----

export interface AttributionBucket {
  bucket: string;
  rowCount: number;
  pnlUnits: number | null;
}

export interface IntervalAttribution {
  sport: AttributionBucket[];
  marketFamily: AttributionBucket[];
  scoreBand: AttributionBucket[];
  priceBand: AttributionBucket[];
  coverageBand: AttributionBucket[];
  timingBucket: AttributionBucket[];
  formulaVersion: AttributionBucket[];
  eventSignalMultiplicity: AttributionBucket[];
}

function attributeSubset(subset: readonly BetStep[], fullRows: readonly Row[]): IntervalAttribution {
  const eventCounts = new Map<string, number>();
  for (const row of fullRows) {
    const key = buildEventGroupKey(row).key;
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }
  const attributeBy = (labelOf: (row: Row) => string): AttributionBucket[] => {
    const groups = new Map<string, { rowCount: number; pnl: number }>();
    for (const step of subset) {
      const label = labelOf(step.row);
      const g = groups.get(label) ?? { rowCount: 0, pnl: 0 };
      g.rowCount += 1;
      g.pnl += step.returnUnits;
      groups.set(label, g);
    }
    return [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([bucket, g]) => ({ bucket, rowCount: g.rowCount, pnlUnits: g.pnl }));
  };
  return {
    sport: attributeBy((r) => classifySport(r).sportKey),
    marketFamily: attributeBy((r) => classifyMarketType(r).marketKey),
    scoreBand: attributeBy(scoreBandOf),
    priceBand: attributeBy(priceBandOf),
    coverageBand: attributeBy(coverageBandOf),
    timingBucket: attributeBy(timingBucketOf),
    formulaVersion: attributeBy((r) => versionBucketOf(r, "metric_formula_version")),
    eventSignalMultiplicity: attributeBy((r) =>
      (eventCounts.get(buildEventGroupKey(r).key) ?? 1) > 1 ? "MULTI_SIGNAL_EVENT" : "SINGLE_SIGNAL_EVENT",
    ),
  };
}

function topNegative(attribution: IntervalAttribution, limit = 10): Array<{ dimension: string; bucket: string; rowCount: number; pnlUnits: number | null }> {
  const all: Array<{ dimension: string; bucket: string; rowCount: number; pnlUnits: number | null }> = [];
  for (const [dimension, buckets] of Object.entries(attribution)) {
    for (const b of buckets as AttributionBucket[]) {
      if ((b.pnlUnits ?? 0) < 0) all.push({ dimension, bucket: b.bucket, rowCount: b.rowCount, pnlUnits: b.pnlUnits });
    }
  }
  return all
    .sort((a, b) => (a.pnlUnits ?? 0) - (b.pnlUnits ?? 0) || (a.dimension < b.dimension ? -1 : 1))
    .slice(0, limit);
}

// ---- drawdown interval ----

export interface MaxDrawdownInterval {
  drawdownUnits: number;
  startSourceId: string | null;
  endSourceId: string | null;
  startResolvedAt: string | null;
  endResolvedAt: string | null;
  intervalRowCount: number;
  intervalPnlUnits: number;
  attribution: IntervalAttribution;
  topNegativeContributors: Array<{ dimension: string; bucket: string; rowCount: number; pnlUnits: number | null }>;
}

/**
 * Locates the exact maximum-drawdown interval on the canonical equity walk.
 * Reports observation IDENTITY only (id + resolved_at), never raw payloads.
 * Descriptive attribution -- no causal claim.
 */
export function locateMaxDrawdownInterval(rows: readonly Row[]): MaxDrawdownInterval | null {
  const bets = chronologicalBets(rows);
  if (bets.length === 0) return null;

  let cumulative = 0;
  let peak = 0;
  let peakIndex = -1; // bet index that established the current peak; -1 = start
  let maxDrawdown = 0;
  let bestStart = -1;
  let bestEnd = -1;

  bets.forEach((bet, i) => {
    cumulative += bet.returnUnits;
    if (cumulative > peak) {
      peak = cumulative;
      peakIndex = i;
    }
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      bestStart = peakIndex + 1;
      bestEnd = i;
    }
  });

  if (maxDrawdown <= 0 || bestStart < 0) {
    return {
      drawdownUnits: 0,
      startSourceId: null,
      endSourceId: null,
      startResolvedAt: null,
      endResolvedAt: null,
      intervalRowCount: 0,
      intervalPnlUnits: 0,
      attribution: attributeSubset([], rows),
      topNegativeContributors: [],
    };
  }

  const interval = bets.slice(bestStart, bestEnd + 1);
  const attribution = attributeSubset(interval, rows);
  return {
    drawdownUnits: maxDrawdown,
    startSourceId: strOf(interval[0].row, "id"),
    endSourceId: strOf(interval[interval.length - 1].row, "id"),
    startResolvedAt: strOf(interval[0].row, "resolved_at"),
    endResolvedAt: strOf(interval[interval.length - 1].row, "resolved_at"),
    intervalRowCount: interval.length,
    intervalPnlUnits: interval.reduce((s, b) => s + b.returnUnits, 0),
    attribution,
    topNegativeContributors: topNegative(attribution),
  };
}

// ---- longest losing streak ----

export interface LongestLosingStreak {
  length: number;
  startSourceId: string | null;
  endSourceId: string | null;
  startResolvedAt: string | null;
  endResolvedAt: string | null;
  cumulativePnlUnits: number;
  attribution: IntervalAttribution;
}

/** Locates the exact canonical longest losing streak (same walk as the equity engine). */
export function locateLongestLosingStreak(rows: readonly Row[]): LongestLosingStreak | null {
  const bets = chronologicalBets(rows);
  if (bets.length === 0) return null;

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  bets.forEach((bet, i) => {
    if (bet.isLoss) {
      if (curLen === 0) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else if (bet.isWin) {
      curLen = 0;
    }
    // non-win/non-loss valid returns neither extend nor break streaks -- the
    // canonical engine resets only on win and extends only on loss.
  });

  if (bestLen === 0) {
    return {
      length: 0,
      startSourceId: null,
      endSourceId: null,
      startResolvedAt: null,
      endResolvedAt: null,
      cumulativePnlUnits: 0,
      attribution: attributeSubset([], rows),
    };
  }

  const streak = bets.slice(bestStart, bestStart + bestLen);
  return {
    length: bestLen,
    startSourceId: strOf(streak[0].row, "id"),
    endSourceId: strOf(streak[streak.length - 1].row, "id"),
    startResolvedAt: strOf(streak[0].row, "resolved_at"),
    endResolvedAt: strOf(streak[streak.length - 1].row, "resolved_at"),
    cumulativePnlUnits: streak.reduce((s, b) => s + b.returnUnits, 0),
    attribution: attributeSubset(streak, rows),
  };
}

// ---- dimension availability matrix ----

export type DimensionStatus = "AVAILABLE" | "PARTIAL" | "MISSING_SOURCE_FIELD" | "UNTRUSTED_SEMANTICS";

export interface DimensionAvailability {
  dimension: string;
  status: DimensionStatus;
  coveredRows: number;
  missingRows: number;
  coveragePct: number;
  sourcePath: string;
  confidence: string;
  notes: string;
}

/**
 * Honest per-dimension availability. league/tournament/tier/liquidity/
 * volume/spread/open_interest have no structured physical source and no
 * existing canonical classifier -- they are reported MISSING_SOURCE_FIELD
 * with zero coverage, never guessed from slug text.
 */
export function buildDimensionAvailability(rows: readonly Row[]): DimensionAvailability[] {
  const total = rows.length;
  const covered = (predicate: (row: Row) => boolean): number => rows.filter(predicate).length;
  const entry = (
    dimension: string,
    coveredRows: number,
    sourcePath: string,
    confidence: string,
    notes: string,
    forcedStatus?: DimensionStatus,
  ): DimensionAvailability => {
    const status: DimensionStatus =
      forcedStatus ?? (total > 0 && coveredRows === total ? "AVAILABLE" : coveredRows > 0 ? "PARTIAL" : "MISSING_SOURCE_FIELD");
    return {
      dimension,
      status,
      coveredRows,
      missingRows: total - coveredRows,
      coveragePct: total > 0 ? (coveredRows / total) * 100 : 0,
      sourcePath,
      confidence,
      notes,
    };
  };

  const missing = (dimension: string, notes: string): DimensionAvailability =>
    entry(dimension, 0, "none", "NONE", notes, "MISSING_SOURCE_FIELD");

  return [
    entry("score", covered((r) => getScoreValue(r) !== null), "signal_confidence_num (canonical getScoreValue alias chain)", "HIGH", "physical column"),
    entry("entry_price", covered((r) => entryPrice(r) !== null), "entry_price_num", "HIGH", "physical column; only 0<p<=1 counts as valid"),
    entry("implied_odds", covered((r) => entryPrice(r) !== null), "derived 1/entry_price_num", "HIGH", "calculated implied odds, not executed sportsbook odds"),
    entry("coverage", covered((r) => coverageBandOf(r) !== "MISSING_OR_INVALID"), "diagnostics.dataCoverage (canonical getCoverageValue)", "HIGH", "nested structured field"),
    entry("timing", covered((r) => getHoursUntilStartValue(r) !== null), "diagnostics.gameStartIso - created_at (canonical adapter)", "MEDIUM", "gameStartIso presence varies by row"),
    entry("formula_version", covered((r) => versionBucketOf(r, "formula_version") !== MISSING_VERSION_BUCKET), "formula_version", "HIGH", "physical column"),
    entry(
      "metric_formula_version",
      covered((r) => versionBucketOf(r, "metric_formula_version") !== MISSING_VERSION_BUCKET),
      "metric_formula_version",
      "HIGH",
      "physical column",
    ),
    entry(
      "sport",
      covered((r) => classifySport(r).classificationConfidence !== "UNKNOWN"),
      "lib/modeling/sportMarketPerformanceSlice.ts classifySport",
      "MEDIUM",
      "existing canonical slug-based classifier; MEDIUM confidence, not official metadata",
    ),
    entry(
      "market_family",
      covered((r) => classifyMarketType(r).classificationConfidence !== "UNKNOWN"),
      "lib/modeling/sportMarketPerformanceSlice.ts classifyMarketType",
      "MEDIUM",
      "existing canonical slug-based classifier; MEDIUM confidence",
    ),
    missing("league", "no structured league column and no existing canonical league classifier; not guessed from slug text"),
    missing("tournament", "no structured tournament column and no existing canonical classifier; not guessed"),
    missing("tier", "no physical source field; not derivable from unrelated fields"),
    missing("liquidity", "raw liquidity is a formula-internal value never persisted to the historical export"),
    missing("volume", "no physical source field in the 27-column canonical export"),
    missing("spread", "no physical source field"),
    missing("open_interest", "no physical source field"),
    entry(
      "event_identity",
      covered((r) => buildEventGroupKey(r).key !== ""),
      "lib/modeling/eventGroupSelection.ts buildEventGroupKey",
      "MEDIUM",
      "canonical priority-chain event key; MEDIUM identity confidence (exploratory grouping limitation)",
    ),
  ];
}

// ---- full builder ----

export interface ModelDecomposition {
  variantId: string;
  selectedObservations: number;
  decompositions: {
    scoreBands: DecompositionBucket[];
    priceBands: DecompositionBucket[];
    impliedOddsBands: DecompositionBucket[];
    coverageBands: DecompositionBucket[];
    timingBuckets: DecompositionBucket[];
    formulaVersions: DecompositionBucket[];
    metricFormulaVersions: DecompositionBucket[];
  };
  eventConcentration: EventConcentrationDetail;
  onePerEventComparison: OnePerEventComparison;
  maxDrawdownInterval: MaxDrawdownInterval | null;
  longestLosingStreak: LongestLosingStreak | null;
  dimensionAvailability: DimensionAvailability[];
  timingFieldCoveragePct: number;
}

export interface ExtendedHistoricalDecomposition {
  schemaVersion: 1;
  engineVersion: typeof DECOMPOSITION_ENGINE_VERSION;
  inputSha256: string;
  classifierSha256: string;
  strictDedupPolicy: typeof STRICT_DEDUP_POLICY_NAME;
  rawRowCount: number;
  strictDedupRowCount: number;
  requestedVariantIds: string[];
  corpusDimensionAvailability: DimensionAvailability[];
  models: ModelDecomposition[];
  contentHash: string;
}

export interface ExtendedDecompositionOptions {
  rawRows: readonly ExportRow[];
  classifier: ExecutableFunnelClassifier;
  requestedVariantIds: readonly string[];
}

function dedupCorpusHash(rows: readonly ExportRow[]): string {
  const ordered = [...rows].sort((a, b) => {
    const ak = getStrictDedupKeyForExportRow(a) ?? "";
    const bk = getStrictDedupKeyForExportRow(b) ?? "";
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/**
 * Builds the full extended decomposition: strict-dedups rawRows (canonical
 * policy), evaluates each requested variant through the existing evaluator,
 * and decomposes each model's selected rows across every dimension. Fails
 * closed on an unknown variant. Pure; input rows are never mutated.
 */
export function buildExtendedHistoricalDecomposition(options: ExtendedDecompositionOptions): ExtendedHistoricalDecomposition {
  const { rawRows, classifier, requestedVariantIds } = options;

  const seen = new Set<string>();
  for (const id of requestedVariantIds) {
    if (seen.has(id)) throw new Error(`extended decomposition: duplicate variant id ${id}`);
    seen.add(id);
    if (!getBundle(classifier, id)) throw new Error(`extended decomposition: unknown variant id ${id}`);
  }

  const projection = projectGeneratedSignalPairsStrictDedup(rawRows);
  const dedupRows = projection.dedupedRows;

  const models: ModelDecomposition[] = requestedVariantIds.map((variantId) => {
    const evaluated = evaluateHistoricalFunnelVariant(dedupRows, classifier, variantId);
    const rows = evaluated.selectedRows as Row[];
    const timedRows = rows.filter((r) => getHoursUntilStartValue(r) !== null).length;
    return {
      variantId,
      selectedObservations: rows.length,
      decompositions: {
        scoreBands: decomposeBy(rows, SCORE_BANDS, scoreBandOf),
        priceBands: decomposeBy(rows, PRICE_BANDS, priceBandOf),
        impliedOddsBands: decomposeBy(rows, IMPLIED_ODDS_BANDS, impliedOddsBandOf),
        coverageBands: decomposeBy(rows, COVERAGE_BANDS, coverageBandOf),
        timingBuckets: decomposeBy(rows, TIMING_BUCKETS, timingBucketOf),
        formulaVersions: decomposeByVersions(rows, "formula_version"),
        metricFormulaVersions: decomposeByVersions(rows, "metric_formula_version"),
      },
      eventConcentration: computeEventConcentrationDetail(rows),
      onePerEventComparison: compareKeepAllVsOnePerEvent(rows),
      maxDrawdownInterval: locateMaxDrawdownInterval(rows),
      longestLosingStreak: locateLongestLosingStreak(rows),
      dimensionAvailability: buildDimensionAvailability(rows),
      timingFieldCoveragePct: rows.length > 0 ? (timedRows / rows.length) * 100 : 0,
    };
  });

  const withoutHash: Omit<ExtendedHistoricalDecomposition, "contentHash"> = {
    schemaVersion: 1,
    engineVersion: DECOMPOSITION_ENGINE_VERSION,
    inputSha256: dedupCorpusHash(dedupRows),
    classifierSha256: createHash("sha256").update(JSON.stringify(classifier)).digest("hex"),
    strictDedupPolicy: STRICT_DEDUP_POLICY_NAME,
    rawRowCount: rawRows.length,
    strictDedupRowCount: dedupRows.length,
    requestedVariantIds: [...requestedVariantIds],
    corpusDimensionAvailability: buildDimensionAvailability(dedupRows),
    models,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  return { ...withoutHash, contentHash };
}

/** Deterministic pretty JSON with exactly one trailing newline. */
export function serializeExtendedDecompositionJson(result: ExtendedHistoricalDecomposition): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

// ---- compact HTML evidence summary (A1 only, not the A2 dashboard) ----

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}
function fmtInt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

const CSS =
  "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;color:#1a1a1a;background:#fafafa;max-width:1050px}" +
  "h1{font-size:20px}h2{font-size:15px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:22px}h3{font-size:13px;margin:12px 0 4px}" +
  ".banner{background:#1f2d3d;color:#fff;padding:10px 14px;border-radius:6px;font-weight:600}" +
  "table{border-collapse:collapse;width:100%;font-size:11px;margin-top:6px}th,td{border:1px solid #ddd;padding:2px 5px;text-align:right}" +
  "th:first-child,td:first-child{text-align:left}" +
  "tr.warn-sample{background:#fff4f0}.warn-tag{color:#a3423a;font-weight:600}" +
  ".muted{color:#666}@media print{body{background:#fff}}";

function bucketTable(title: string, buckets: DecompositionBucket[]): string {
  const rows = buckets
    .filter((b) => b.metrics.observations > 0)
    .map((b) => {
      const warn = b.metrics.sampleClass === "LOW" || b.metrics.sampleClass === "INSUFFICIENT";
      return (
        `<tr class="${warn ? "warn-sample" : ""}"><td>${escapeHtml(b.bucket)}</td>` +
        `<td>${fmtInt(b.metrics.observations)}</td><td>${fmt(b.metrics.flatUnitPnl)}</td><td>${fmt(b.metrics.flatUnitRoi)}</td>` +
        `<td>${fmt(b.metrics.maximumDrawdownUnits)}</td><td>${fmtInt(b.metrics.longestLosingStreak)}</td>` +
        `<td>${escapeHtml(b.metrics.sampleClass)}${warn ? ' <span class="warn-tag">⚠</span>' : ""}</td></tr>`
      );
    })
    .join("");
  return `<h3>${escapeHtml(title)}</h3><table><thead><tr><th>Bucket</th><th>N</th><th>PnL</th><th>ROI%</th><th>MaxDD</th><th>Streak</th><th>Sample</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function availabilityTable(matrix: DimensionAvailability[]): string {
  const rows = matrix
    .map(
      (d) =>
        `<tr><td>${escapeHtml(d.dimension)}</td><td>${escapeHtml(d.status)}</td><td>${fmtInt(d.coveredRows)}</td><td>${fmt(d.coveragePct, 1)}</td><td>${escapeHtml(d.confidence)}</td><td class="muted">${escapeHtml(d.notes)}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Dimension</th><th>Status</th><th>Covered</th><th>%</th><th>Confidence</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Global evidence pool for one model's strongest-segment lists. Excludes
 * impliedOddsBands entirely -- it is a deterministic 1:1 mirror of
 * priceBands (see impliedOddsBandOf), so counting both would double-count
 * the same underlying rows as two independent findings. Price remains the
 * canonical dimension here; the full implied-odds detail table is rendered
 * separately (bucketTable), just excluded from this ranking pool.
 */
function evidencePool(model: ModelDecomposition): Array<{ dim: string; bucket: string; m: DecompositionSegmentMetrics }> {
  return extractEvidencePool(model);
}

/** Exported so the dashboard layer reuses the exact same mirror-exclusion rule instead of reimplementing it. */
export function extractEvidencePool(model: ModelDecomposition): Array<{ dim: string; bucket: string; m: DecompositionSegmentMetrics }> {
  const all: Array<{ dim: string; bucket: string; m: DecompositionSegmentMetrics }> = [];
  for (const [dim, buckets] of Object.entries(model.decompositions)) {
    if ((EVIDENCE_MIRROR_DIMENSIONS as readonly string[]).includes(dim)) continue;
    for (const b of buckets) if (b.metrics.observations > 0) all.push({ dim, bucket: b.bucket, m: b.metrics });
  }
  return all;
}

function strongestSegments(model: ModelDecomposition): string {
  const all = evidencePool(model);
  // Positive segments: flatUnitPnl > 0 only. Negative segments: flatUnitPnl
  // < 0 only. Zero-PnL segments are excluded from both -- a positive (even
  // barely positive) segment must never appear in the negative list.
  const positive = all.filter((e) => (e.m.flatUnitPnl ?? 0) > 0).sort((a, b) => (b.m.flatUnitPnl ?? 0) - (a.m.flatUnitPnl ?? 0));
  const negative = all.filter((e) => (e.m.flatUnitPnl ?? 0) < 0).sort((a, b) => (a.m.flatUnitPnl ?? 0) - (b.m.flatUnitPnl ?? 0));
  const row = (e: { dim: string; bucket: string; m: DecompositionSegmentMetrics }) => {
    const warn = e.m.sampleClass === "LOW" || e.m.sampleClass === "INSUFFICIENT";
    return `<tr class="${warn ? "warn-sample" : ""}"><td>${escapeHtml(e.dim)} / ${escapeHtml(e.bucket)}</td><td>${fmtInt(e.m.observations)}</td><td>${fmt(e.m.flatUnitPnl)}</td><td>${fmt(e.m.flatUnitRoi)}</td><td>${escapeHtml(e.m.sampleClass)}${warn ? ' <span class="warn-tag">⚠ small sample</span>' : ""}</td></tr>`;
  };
  const top = positive.slice(0, 5).map(row).join("");
  const bottom = negative.slice(0, 5).map(row).join("");
  return (
    `<h3>Strongest positive segments (by PnL)</h3><table><thead><tr><th>Segment</th><th>N</th><th>PnL</th><th>ROI%</th><th>Sample</th></tr></thead><tbody>${top || '<tr><td colspan="5" class="muted">none</td></tr>'}</tbody></table>` +
    `<h3>Strongest negative segments (by PnL)</h3><table><thead><tr><th>Segment</th><th>N</th><th>PnL</th><th>ROI%</th><th>Sample</th></tr></thead><tbody>${bottom || '<tr><td colspan="5" class="muted">none</td></tr>'}</tbody></table>`
  );
}

function ddSection(model: ModelDecomposition): string {
  const dd = model.maxDrawdownInterval;
  if (!dd || dd.intervalRowCount === 0) return `<p class="muted">No drawdown interval (no losing sequence located).</p>`;
  const contributors = dd.topNegativeContributors
    .map((c) => `<tr><td>${escapeHtml(c.dimension)} / ${escapeHtml(c.bucket)}</td><td>${fmtInt(c.rowCount)}</td><td>${fmt(c.pnlUnits)}</td></tr>`)
    .join("");
  return (
    `<p>Max drawdown ${fmt(dd.drawdownUnits)}u over ${fmtInt(dd.intervalRowCount)} bets ` +
    `(${escapeHtml(dd.startResolvedAt ?? "—")} → ${escapeHtml(dd.endResolvedAt ?? "—")}). Descriptive attribution only — no causal claim.</p>` +
    `<table><thead><tr><th>Negative contributor</th><th>Rows</th><th>PnL</th></tr></thead><tbody>${contributors}</tbody></table>`
  );
}

function streakSection(model: ModelDecomposition): string {
  const s = model.longestLosingStreak;
  if (!s || s.length === 0) return `<p class="muted">No losing streak located.</p>`;
  return `<p>Longest losing streak: ${fmtInt(s.length)} bets, cumulative ${fmt(s.cumulativePnlUnits)}u (${escapeHtml(s.startResolvedAt ?? "—")} → ${escapeHtml(s.endResolvedAt ?? "—")}).</p>`;
}

/**
 * Compact deterministic evidence summary (A1). Inline CSS, plain tables, no
 * JavaScript/CDN/remote fonts/network, no raw corpus rows.
 */
export function renderExtendedDecompositionSummaryHtml(result: ExtendedHistoricalDecomposition): string {
  const modelSections = result.models
    .map((m) => {
      const ope = m.onePerEventComparison;
      const ec = m.eventConcentration;
      return (
        `<section><h2>Model: ${escapeHtml(m.variantId)} (N=${fmtInt(m.selectedObservations)})</h2>` +
        bucketTable("Score bands", m.decompositions.scoreBands) +
        bucketTable("Entry-price bands", m.decompositions.priceBands) +
        bucketTable("Implied decimal-odds bands (calculated, not executed odds)", m.decompositions.impliedOddsBands) +
        bucketTable("Coverage bands", m.decompositions.coverageBands) +
        bucketTable(`Timing buckets (field coverage ${fmt(m.timingFieldCoveragePct, 1)}%)`, m.decompositions.timingBuckets) +
        bucketTable("metric_formula_version", m.decompositions.metricFormulaVersions) +
        strongestSegments(m) +
        `<h3>Event concentration</h3><table><tbody>` +
        `<tr><th>Working event groups</th><td>${fmtInt(ec.workingEventGroups)}</td></tr>` +
        `<tr><th>Max signals/event</th><td>${fmtInt(ec.maximumSignalsPerWorkingEvent)}</td></tr>` +
        `<tr><th>Events with 1/2/3/4/5+ signals</th><td>${fmtInt(ec.eventsWith1Signal)} / ${fmtInt(ec.eventsWith2Signals)} / ${fmtInt(ec.eventsWith3Signals)} / ${fmtInt(ec.eventsWith4Signals)} / ${fmtInt(ec.eventsWith5PlusSignals)}</td></tr>` +
        `<tr><th>PnL single-signal vs multi-signal events</th><td>${fmt(ec.pnlFromSingleSignalEvents)} / ${fmt(ec.pnlFromMultiSignalEvents)}</td></tr>` +
        `</tbody></table>` +
        `<h3>Keep-all vs canonical one-per-event (analysis only)</h3><table><thead><tr><th></th><th>N</th><th>Events</th><th>PnL</th><th>ROI%</th><th>MaxDD</th><th>Streak</th><th>MaxSig/Ev</th></tr></thead><tbody>` +
        `<tr><td>KEEP_ALL_SELECTED_ROWS</td><td>${fmtInt(ope.keepAll.observations)}</td><td>${fmtInt(ope.keepAll.workingEventGroups)}</td><td>${fmt(ope.keepAll.flatUnitPnl)}</td><td>${fmt(ope.keepAll.flatUnitRoi)}</td><td>${fmt(ope.keepAll.maximumDrawdownUnits)}</td><td>${fmtInt(ope.keepAll.longestLosingStreak)}</td><td>${fmtInt(ope.keepAll.maximumSignalsPerWorkingEvent)}</td></tr>` +
        `<tr><td>CANONICAL_ONE_PER_EVENT</td><td>${fmtInt(ope.onePerEvent.observations)}</td><td>${fmtInt(ope.onePerEvent.workingEventGroups)}</td><td>${fmt(ope.onePerEvent.flatUnitPnl)}</td><td>${fmt(ope.onePerEvent.flatUnitRoi)}</td><td>${fmt(ope.onePerEvent.maximumDrawdownUnits)}</td><td>${fmtInt(ope.onePerEvent.longestLosingStreak)}</td><td>${fmtInt(ope.onePerEvent.maximumSignalsPerWorkingEvent)}</td></tr>` +
        `<tr><td>Δ (one-per-event − keep-all)</td><td>${fmtInt(ope.deltas.observations)}</td><td>${fmtInt(ope.deltas.workingEventGroups)}</td><td>${fmt(ope.deltas.flatUnitPnl)}</td><td>${fmt(ope.deltas.flatUnitRoi)}</td><td>${fmt(ope.deltas.maximumDrawdownUnits)}</td><td>${fmtInt(ope.deltas.longestLosingStreak)}</td><td>${fmtInt(ope.deltas.maximumSignalsPerWorkingEvent)}</td></tr>` +
        `</tbody></table>` +
        `<h3>Maximum drawdown attribution</h3>${ddSection(m)}` +
        `<h3>Longest losing streak</h3>${streakSection(m)}` +
        `</section>`
      );
    })
    .join("");

  const blockedDims = result.corpusDimensionAvailability.filter((d) => d.status === "MISSING_SOURCE_FIELD").map((d) => d.dimension);

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Extended Historical Decomposition</title><style>${CSS}</style></head><body>` +
    `<h1>Extended Historical Decomposition — Evidence Summary</h1>` +
    `<div class="banner">HISTORICAL RESEARCH ONLY &middot; NO AUTOMATIC MODEL PROMOTION</div>` +
    `<section><h2>Corpus provenance</h2><table><tbody>` +
    `<tr><th>Raw rows</th><td>${fmtInt(result.rawRowCount)}</td></tr>` +
    `<tr><th>Strict-dedup rows</th><td>${fmtInt(result.strictDedupRowCount)}</td></tr>` +
    `<tr><th>Dedup policy</th><td>${escapeHtml(result.strictDedupPolicy)}</td></tr>` +
    `<tr><th>Corpus hash</th><td>${escapeHtml(result.inputSha256)}</td></tr>` +
    `<tr><th>Classifier hash</th><td>${escapeHtml(result.classifierSha256)}</td></tr>` +
    `<tr><th>Models analyzed</th><td>${escapeHtml(result.requestedVariantIds.join(", "))}</td></tr>` +
    `</tbody></table></section>` +
    `<section><h2>Dimension availability (strict-dedup corpus)</h2>${availabilityTable(result.corpusDimensionAvailability)}` +
    `<p>Blocked / missing dimensions: ${escapeHtml(blockedDims.join(", ") || "none")}</p></section>` +
    modelSections +
    `<footer class="muted"><small>engine ${escapeHtml(result.engineVersion)} · content ${escapeHtml(result.contentHash)}</small></footer>` +
    `</body></html>\n`
  );
}

// ---- manifest ----

export interface ExtendedDecompositionManifest {
  schemaVersion: 1;
  inputSha256: string;
  classifierSha256: string;
  strictDedupPolicy: typeof STRICT_DEDUP_POLICY_NAME;
  rawRowCount: number;
  strictDedupRowCount: number;
  requestedVariantIds: string[];
  decompositionHash: string;
  htmlSha256: string;
  artifactSha256s: Record<string, string>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Provenance manifest: hashes only -- no timestamp, absolute path, env value, duration, or git identity. */
export function buildExtendedDecompositionManifest(
  result: ExtendedHistoricalDecomposition,
  jsonString: string,
  htmlString: string,
): ExtendedDecompositionManifest {
  return {
    schemaVersion: 1,
    inputSha256: result.inputSha256,
    classifierSha256: result.classifierSha256,
    strictDedupPolicy: result.strictDedupPolicy,
    rawRowCount: result.rawRowCount,
    strictDedupRowCount: result.strictDedupRowCount,
    requestedVariantIds: [...result.requestedVariantIds],
    decompositionHash: result.contentHash,
    htmlSha256: sha256(htmlString),
    artifactSha256s: {
      "extended_historical_decomposition.json": sha256(jsonString),
      "extended_historical_decomposition_summary.html": sha256(htmlString),
    },
  };
}
