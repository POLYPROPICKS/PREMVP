// Candidate robustness and rule-contribution audit engine (Phase 3E.7).
//
// Audits exactly two already-selected candidates -- PRIMARY_V1_AVOID_NBA_NHL_
// COV_CAP and ALT2_TS_SCORE_GE_65 -- on the same canonical dedup corpus, plus
// a BASELINE weekly-stability comparison. This is analysis only: it never
// changes formulas, thresholds, predicates, the classifier, the ROI contract,
// or the corpus. Every ROI/PnL/win-loss figure reuses roiPnlContract and
// computeFlatUnitEquityMetrics; every row selection reuses
// evaluateHistoricalFunnelVariant against the classifier's own declared
// funnel -- no business logic is re-derived. Pure: no fs/env/network/database
// access, never mutates its input.

import { createHash } from "node:crypto";
import {
  evaluateHistoricalFunnelVariant,
  getScoreValue,
  getCoverageValue,
  getSmartMoneyValue,
  getHoursUntilStartValue,
} from "./historicalFunnelVariants";
import { computeFlatUnitEquityMetrics } from "./historicalFunnelComparison";
import { computeFlatStakeRoiSummary, computeRowReturnPct } from "./roiPnlContract";
import { buildEventGroupKey } from "./eventGroupSelection";
import {
  getBundle,
  type ExecutableFunnelClassifier,
  type BundleRecord,
  type FunnelStep,
} from "./executableFunnelClassifier";

type Row = Record<string, unknown>;

export const AUDITED_CANDIDATE_IDS = [
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT2_TS_SCORE_GE_65",
] as const;
export const BASELINE_ID = "BASELINE_V1_CONTROL";

function getStr(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function validMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** ISO 8601 year-week label (UTC), e.g. "2026-W18". */
function isoWeekLabel(ms: number): string {
  const date = new Date(ms);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---- Weekly stability (Audit A) ----

export interface WeekMetrics {
  week: string;
  signals: number;
  wins: number;
  losses: number;
  pnl: number;
  roiPct: number | null;
  winRatePct: number | null;
  maxDrawdownUnits: number;
}

export interface WeeklyStability {
  weeks: WeekMetrics[];
  positiveWeekCount: number;
  negativeWeekCount: number;
  bestWeek: WeekMetrics | null;
  worstWeek: WeekMetrics | null;
  bestWeekShareOfPositivePnl: number | null;
  bestTwoWeeksShareOfPositivePnl: number | null;
  bestWeekConcentrationFlag: boolean;
  totalPnl: number;
}

function computeWeeklyStability(rows: readonly Row[]): WeeklyStability {
  const byWeek = new Map<string, Row[]>();
  for (const row of rows) {
    const ms = validMs(row.resolved_at);
    if (ms === null) continue;
    const label = isoWeekLabel(ms);
    const bucket = byWeek.get(label) ?? [];
    bucket.push(row);
    byWeek.set(label, bucket);
  }

  const weeks: WeekMetrics[] = Array.from(byWeek.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, weekRows]) => {
      const roi = computeFlatStakeRoiSummary(weekRows, { strict: false, stakeUnits: 1 });
      const equity = computeFlatUnitEquityMetrics(weekRows);
      return {
        week,
        signals: weekRows.length,
        wins: roi.winCount,
        losses: roi.lossCount,
        pnl: roi.totalPnlUnits ?? 0,
        roiPct: roi.roiPct,
        winRatePct: roi.winRatePct,
        maxDrawdownUnits: equity.maximumDrawdownUnits,
      };
    });

  const positiveWeekCount = weeks.filter((w) => w.pnl > 0).length;
  const negativeWeekCount = weeks.filter((w) => w.pnl < 0).length;
  const sortedByPnlDesc = [...weeks].sort((a, b) => b.pnl - a.pnl);
  const bestWeek = weeks.length > 0 ? sortedByPnlDesc[0] : null;
  const worstWeek = weeks.length > 0 ? sortedByPnlDesc[sortedByPnlDesc.length - 1] : null;
  const totalPositive = weeks.filter((w) => w.pnl > 0).reduce((s, w) => s + w.pnl, 0);
  const bestTwoSum = sortedByPnlDesc.slice(0, 2).filter((w) => w.pnl > 0).reduce((s, w) => s + w.pnl, 0);

  const bestWeekShare = totalPositive > 0 && bestWeek ? bestWeek.pnl / totalPositive : null;
  const bestTwoShare = totalPositive > 0 ? bestTwoSum / totalPositive : null;

  return {
    weeks,
    positiveWeekCount,
    negativeWeekCount,
    bestWeek,
    worstWeek,
    bestWeekShareOfPositivePnl: bestWeekShare,
    bestTwoWeeksShareOfPositivePnl: bestTwoShare,
    bestWeekConcentrationFlag: bestWeekShare !== null && bestWeekShare > 0.4,
    totalPnl: weeks.reduce((s, w) => s + w.pnl, 0),
  };
}

// ---- Rule contribution ablation (Audit B, PRIMARY only) ----

export interface RuleStage {
  stageIndex: number;
  ruleLabel: string;
  plainLanguage: string;
  inputRows: number;
  outputRows: number;
  removedRows: number;
  wins: number;
  losses: number;
  pnl: number | null;
  roiPct: number | null;
  winRatePct: number | null;
  maxDrawdownUnits: number;
  deltaPnlFromPrevious: number | null;
  deltaRoiFromPrevious: number | null;
}

export interface RuleContribution {
  stages: RuleStage[];
}

function metricsForRows(rows: readonly Row[]) {
  const roi = computeFlatStakeRoiSummary([...rows], { strict: false, stakeUnits: 1 });
  const equity = computeFlatUnitEquityMetrics(rows);
  return { roi, equity };
}

/**
 * Cumulative ablation: for each prefix length of the bundle's OWN declared
 * ordered funnel (exact historical order, never reordered), builds a
 * truncated in-memory classifier containing only that prefix and re-runs the
 * real evaluator -- so the historical rule logic and its order are reused
 * verbatim, never re-implemented.
 */
function computeRuleContribution(
  rows: readonly Row[],
  classifier: ExecutableFunnelClassifier,
  bundle: BundleRecord,
): RuleContribution {
  const stages: RuleStage[] = [];

  // Stage 0: BASELINE (no filtering at all).
  const baselineMetrics = metricsForRows(rows);
  stages.push({
    stageIndex: 0,
    ruleLabel: "BASELINE",
    plainLanguage: "Все строки канонического корпуса, без фильтров.",
    inputRows: rows.length,
    outputRows: rows.length,
    removedRows: 0,
    wins: baselineMetrics.roi.winCount,
    losses: baselineMetrics.roi.lossCount,
    pnl: baselineMetrics.roi.totalPnlUnits,
    roiPct: baselineMetrics.roi.roiPct,
    winRatePct: baselineMetrics.roi.winRatePct,
    maxDrawdownUnits: baselineMetrics.equity.maximumDrawdownUnits,
    deltaPnlFromPrevious: null,
    deltaRoiFromPrevious: null,
  });

  // Cumulative prefixes at every REQUIRE/EXCLUDE/GROUP+ORDER+KEEP step,
  // exactly in the bundle's declared order.
  const funnel = bundle.orderedFunnel;
  let cumulativeEnd = 0;
  let previousSelected: readonly Row[] = rows;

  const filterSteps = funnel.filter((s) => s.action === "REQUIRE" || s.action === "EXCLUDE");
  const tailSteps = funnel.filter((s) => s.action === "GROUP" || s.action === "ORDER" || s.action === "KEEP" || s.action === "STAKE" || s.action === "OUTPUT");

  for (const step of filterSteps) {
    cumulativeEnd = step.step;
    const prefix = funnel.filter((s) => s.step <= cumulativeEnd);
    const truncated: ExecutableFunnelClassifier = {
      ...classifier,
      bundles: classifier.bundles.map((b) =>
        b.bundleId === bundle.bundleId ? { ...b, orderedFunnel: renumber(prefix) } : b,
      ),
    };
    const evalResult = evaluateHistoricalFunnelVariant(rows, truncated, bundle.bundleId);
    const m = metricsForRows(evalResult.selectedRows);
    const prevStage = stages[stages.length - 1];
    stages.push({
      stageIndex: stages.length,
      ruleLabel: labelForStep(step),
      plainLanguage: step.plainLanguage,
      inputRows: previousSelected.length,
      outputRows: evalResult.selectedRows.length,
      removedRows: previousSelected.length - evalResult.selectedRows.length,
      wins: m.roi.winCount,
      losses: m.roi.lossCount,
      pnl: m.roi.totalPnlUnits,
      roiPct: m.roi.roiPct,
      winRatePct: m.roi.winRatePct,
      maxDrawdownUnits: m.equity.maximumDrawdownUnits,
      deltaPnlFromPrevious: (m.roi.totalPnlUnits ?? 0) - (prevStage.pnl ?? 0),
      deltaRoiFromPrevious: m.roi.roiPct !== null && prevStage.roiPct !== null ? m.roi.roiPct - prevStage.roiPct : null,
    });
    previousSelected = evalResult.selectedRows;
  }

  // Final stage: the full declared funnel (grouping/order/keep/stake/output).
  if (tailSteps.length > 0) {
    const evalResult = evaluateHistoricalFunnelVariant(rows, classifier, bundle.bundleId);
    const m = metricsForRows(evalResult.selectedRows);
    const prevStage = stages[stages.length - 1];
    stages.push({
      stageIndex: stages.length,
      ruleLabel: "FULL_FUNNEL",
      plainLanguage: "Финальная группировка/сортировка/keep-правило (один сигнал на рабочую группу событий).",
      inputRows: previousSelected.length,
      outputRows: evalResult.selectedRows.length,
      removedRows: previousSelected.length - evalResult.selectedRows.length,
      wins: m.roi.winCount,
      losses: m.roi.lossCount,
      pnl: m.roi.totalPnlUnits,
      roiPct: m.roi.roiPct,
      winRatePct: m.roi.winRatePct,
      maxDrawdownUnits: m.equity.maximumDrawdownUnits,
      deltaPnlFromPrevious: (m.roi.totalPnlUnits ?? 0) - (prevStage.pnl ?? 0),
      deltaRoiFromPrevious: m.roi.roiPct !== null && prevStage.roiPct !== null ? m.roi.roiPct - prevStage.roiPct : null,
    });
  }

  return { stages };
}

function renumber(steps: FunnelStep[]): FunnelStep[] {
  return steps.map((s, i) => ({ ...s, step: i + 1 }));
}

function labelForStep(step: FunnelStep): string {
  if (step.field === "signal_confidence_num") return "score_>=_threshold";
  if (step.field === "league") return "exclude_nba_nhl";
  if (step.field === "data_coverage_num+entry_price_num") return "exclude_bad_coverage_price_bucket";
  if (step.field === "hours_until_start_num") return "exclude_timing_6_24h";
  if (step.field === "data_coverage_num") return "coverage_>=_threshold";
  return `${step.action.toLowerCase()}_${step.field ?? "step"}`;
}

// ---- Segments (Audit C) ----

const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;

export interface SegmentBucket {
  label: string;
  signals: number;
  wins: number;
  losses: number;
  pnl: number | null;
  roiPct: number | null;
  winRatePct: number | null;
  sampleFlag: "OK" | "LOW_SAMPLE";
}

function bucketRows<K extends string>(
  rows: readonly Row[],
  bucketOf: (row: Row) => K,
  orderedLabels: readonly K[],
): SegmentBucket[] {
  const groups = new Map<K, Row[]>();
  for (const label of orderedLabels) groups.set(label, []);
  for (const row of rows) {
    const label = bucketOf(row);
    const bucket = groups.get(label) ?? [];
    bucket.push(row);
    groups.set(label, bucket);
  }
  return orderedLabels.map((label) => {
    const bucketRowsArr = groups.get(label) ?? [];
    const roi = computeFlatStakeRoiSummary(bucketRowsArr, { strict: false, stakeUnits: 1 });
    return {
      label,
      signals: bucketRowsArr.length,
      wins: roi.winCount,
      losses: roi.lossCount,
      pnl: bucketRowsArr.length >= 20 ? roi.totalPnlUnits : roi.totalPnlUnits,
      roiPct: roi.roiPct,
      winRatePct: roi.winRatePct,
      sampleFlag: bucketRowsArr.length >= 20 ? "OK" : "LOW_SAMPLE",
    };
  });
}

function leagueFamilyOf(row: Row): "NBA_NHL" | "OTHER" {
  const marketSlug = typeof row.market_slug === "string" ? row.market_slug : "";
  const eventSlug = typeof row.event_slug === "string" ? row.event_slug : "";
  return NBA_NHL_RE.test(`${marketSlug} ${eventSlug}`.toLowerCase()) ? "NBA_NHL" : "OTHER";
}

function scoreBandOf(row: Row): "65-71.999" | "72-79.999" | "80-89.999" | "90+" | "MISSING" {
  const s = getScoreValue(row);
  if (s === null) return "MISSING";
  if (s < 72) return "65-71.999";
  if (s < 80) return "72-79.999";
  if (s < 90) return "80-89.999";
  return "90+";
}

function priceBandOf(row: Row): "<0.30" | "0.30-0.4399" | "0.44-0.58" | "0.5801-0.75" | ">0.75" | "MISSING" {
  const p = typeof row.entry_price_num === "number" ? row.entry_price_num : null;
  if (p === null) return "MISSING";
  if (p < 0.3) return "<0.30";
  if (p < 0.44) return "0.30-0.4399";
  if (p <= 0.58) return "0.44-0.58";
  if (p < 0.75) return "0.5801-0.75";
  return ">0.75";
}

function coverageBandOf(row: Row): "<50" | "50-74" | "75-89" | "90+" | "MISSING" {
  const c = getCoverageValue(row);
  if (c === null) return "MISSING";
  if (c < 50) return "<50";
  if (c < 75) return "50-74";
  if (c < 90) return "75-89";
  return "90+";
}

function timingBandOf(row: Row): "<6h" | "6-24h" | "24-72h" | ">72h" | "missing" {
  const h = getHoursUntilStartValue(row);
  if (h === null) return "missing";
  if (h < 6) return "<6h";
  if (h < 24) return "6-24h";
  if (h < 72) return "24-72h";
  return ">72h";
}

export interface Segments {
  leagueFamily: SegmentBucket[];
  scoreBand: SegmentBucket[];
  priceBand: SegmentBucket[];
  coverageBand: SegmentBucket[];
  timingBand: SegmentBucket[];
}

function computeSegments(rows: readonly Row[]): Segments {
  return {
    leagueFamily: bucketRows(rows, leagueFamilyOf, ["NBA_NHL", "OTHER"] as const),
    scoreBand: bucketRows(rows, scoreBandOf, ["65-71.999", "72-79.999", "80-89.999", "90+", "MISSING"] as const),
    priceBand: bucketRows(rows, priceBandOf, ["<0.30", "0.30-0.4399", "0.44-0.58", "0.5801-0.75", ">0.75", "MISSING"] as const),
    coverageBand: bucketRows(rows, coverageBandOf, ["<50", "50-74", "75-89", "90+", "MISSING"] as const),
    timingBand: bucketRows(rows, timingBandOf, ["<6h", "6-24h", "24-72h", ">72h", "missing"] as const),
  };
}

// ---- Concentration (Audit D) ----

export interface Concentration {
  top1WinContribution: number;
  top5WinContribution: number;
  top10WinContribution: number;
  pnlAfterRemovingTop1: number;
  pnlAfterRemovingTop5: number;
  pnlAfterRemovingTop10: number;
  worst1Contribution: number;
  worst5Contribution: number;
  worst10Contribution: number;
}

function rowPnl(row: Row): number {
  const computed = computeRowReturnPct(row);
  return computed.returnPct === null ? 0 : computed.returnPct / 100;
}

function computeConcentration(rows: readonly Row[]): Concentration {
  const totalPnl = rows.reduce((s, r) => s + rowPnl(r), 0);
  const sortedDesc = [...rows].sort((a, b) => rowPnl(b) - rowPnl(a));
  const sortedAsc = [...rows].sort((a, b) => rowPnl(a) - rowPnl(b));

  const sumTopN = (n: number) => sortedDesc.slice(0, n).reduce((s, r) => s + rowPnl(r), 0);
  const sumWorstN = (n: number) => sortedAsc.slice(0, n).reduce((s, r) => s + rowPnl(r), 0);

  const top1 = sumTopN(1);
  const top5 = sumTopN(5);
  const top10 = sumTopN(10);

  return {
    top1WinContribution: top1,
    top5WinContribution: top5,
    top10WinContribution: top10,
    pnlAfterRemovingTop1: totalPnl - top1,
    pnlAfterRemovingTop5: totalPnl - top5,
    pnlAfterRemovingTop10: totalPnl - top10,
    worst1Contribution: sumWorstN(1),
    worst5Contribution: sumWorstN(5),
    worst10Contribution: sumWorstN(10),
  };
}

// ---- Identity/duplication (Audit E) ----

export interface IdentityMetrics {
  uniqueConditionTokenPairs: number;
  uniqueMarkets: number;
  workingEventGroups: number;
  maximumSignalsPerWorkingEvent: number;
  eventsWithMoreThanOneSignal: number;
}

function computeIdentity(rows: readonly Row[]): IdentityMetrics {
  const pairs = new Set<string>();
  const markets = new Set<string>();
  const eventCounts = new Map<string, number>();
  for (const row of rows) {
    const cond = getStr(row, "condition_id");
    const tok = getStr(row, "token_id") ?? getStr(row, "selected_token_id");
    if (cond !== null && tok !== null) pairs.add(`${cond}::${tok}`);
    if (cond !== null) markets.add(cond);
    const eventKey = buildEventGroupKey(row).key;
    eventCounts.set(eventKey, (eventCounts.get(eventKey) ?? 0) + 1);
  }
  const counts = Array.from(eventCounts.values());
  return {
    uniqueConditionTokenPairs: pairs.size,
    uniqueMarkets: markets.size,
    workingEventGroups: eventCounts.size,
    maximumSignalsPerWorkingEvent: counts.length > 0 ? Math.max(...counts) : 0,
    eventsWithMoreThanOneSignal: counts.filter((c) => c > 1).length,
  };
}

// ---- Field coverage (Audit F) ----

export interface FieldCoverage {
  score: number;
  coverage: number;
  timing: number;
  league: number;
  entryPrice: number;
  smartMoney: number;
  result: number;
  eventIdentity: number;
}

function pct(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

function computeFieldCoverage(rows: readonly Row[]): FieldCoverage {
  const total = rows.length;
  let score = 0, coverage = 0, timing = 0, league = 0, entryPrice = 0, smartMoney = 0, result = 0, eventIdentity = 0;
  for (const row of rows) {
    if (getScoreValue(row) !== null) score += 1;
    if (getCoverageValue(row) !== null) coverage += 1;
    if (getHoursUntilStartValue(row) !== null) timing += 1;
    if (getStr(row, "event_slug") !== null || getStr(row, "market_slug") !== null) league += 1;
    if (typeof row.entry_price_num === "number") entryPrice += 1;
    if (getSmartMoneyValue(row) !== null) smartMoney += 1;
    if (getStr(row, "signal_result") !== null) result += 1;
    if (buildEventGroupKey(row).key !== "condition:") eventIdentity += 1;
  }
  return {
    score: pct(score, total),
    coverage: pct(coverage, total),
    timing: pct(timing, total),
    league: pct(league, total),
    entryPrice: pct(entryPrice, total),
    smartMoney: pct(smartMoney, total),
    result: pct(result, total),
    eventIdentity: pct(eventIdentity, total),
  };
}

// ---- Top-level audit ----

export interface CandidateAudit {
  variantId: string;
  overallMetrics: {
    inputRows: number;
    outputRows: number;
    wins: number;
    losses: number;
    flatUnitPnl: number | null;
    flatUnitRoi: number | null;
    winRatePct: number | null;
  };
  weeklyStability: WeeklyStability;
  ruleContribution: RuleContribution | null;
  segments: Segments;
  concentration: Concentration;
  identity: IdentityMetrics;
  fieldCoverage: FieldCoverage;
}

export interface CandidateRobustnessAuditResult {
  corpusSha256: string;
  corpusRowCount: number;
  candidates: CandidateAudit[];
  baselineWeeklyStability: WeeklyStability;
  smartMoneyLimitationNote: string;
}

export interface AuditOptions {
  rows: readonly Row[];
  classifier: ExecutableFunnelClassifier;
  candidateVariantIds: readonly string[];
  expectedCorpusSha256?: string;
}

function computeCorpusHash(rows: readonly Row[]): string {
  const ordered = [...rows].sort((a, b) => {
    const ak = `${getStr(a, "condition_id") ?? ""}::${getStr(a, "token_id") ?? ""}`;
    const bk = `${getStr(b, "condition_id") ?? ""}::${getStr(b, "token_id") ?? ""}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/**
 * Audits the requested candidate bundles (row selection reuses the real
 * evaluator against the classifier's own declared funnel; every ROI/PnL/
 * equity figure reuses the canonical roiPnlContract). No fs/env/network
 * access. Never mutates `rows`. Throws if `expectedCorpusSha256` is supplied
 * and does not match the computed corpus hash.
 */
export function auditCandidateRobustness(options: AuditOptions): CandidateRobustnessAuditResult {
  const { rows, classifier, candidateVariantIds, expectedCorpusSha256 } = options;

  const corpusSha256 = computeCorpusHash(rows);
  if (expectedCorpusSha256 && corpusSha256 !== expectedCorpusSha256) {
    throw new Error(
      `candidate robustness audit: corpus hash mismatch (expected ${expectedCorpusSha256}, computed ${corpusSha256})`,
    );
  }

  const baselineEval = evaluateHistoricalFunnelVariant(rows, classifier, BASELINE_ID);
  const baselineWeeklyStability = computeWeeklyStability(baselineEval.selectedRows);

  const candidates: CandidateAudit[] = candidateVariantIds.map((variantId) => {
    const bundle = getBundle(classifier, variantId);
    if (!bundle) throw new Error(`candidate robustness audit: unknown bundle ${variantId}`);
    const evalResult = evaluateHistoricalFunnelVariant(rows, classifier, variantId);
    const selected = evalResult.selectedRows;
    const roi = computeFlatStakeRoiSummary(selected, { strict: false, stakeUnits: 1 });

    return {
      variantId,
      overallMetrics: {
        inputRows: evalResult.inputRows,
        outputRows: selected.length,
        wins: roi.winCount,
        losses: roi.lossCount,
        flatUnitPnl: roi.totalPnlUnits,
        flatUnitRoi: roi.roiPct,
        winRatePct: roi.winRatePct,
      },
      weeklyStability: computeWeeklyStability(selected),
      ruleContribution: variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP" ? computeRuleContribution(rows, classifier, bundle) : null,
      segments: computeSegments(selected),
      concentration: computeConcentration(selected),
      identity: computeIdentity(selected),
      fieldCoverage: computeFieldCoverage(selected),
    };
  });

  return {
    corpusSha256,
    corpusRowCount: rows.length,
    candidates,
    baselineWeeklyStability,
    smartMoneyLimitationNote:
      "smart_money_score_num is missing on the canonical export (dropped by the exporter normalizer) -> smart-money variants and stake guards remain unvalidated on this corpus.",
  };
}
