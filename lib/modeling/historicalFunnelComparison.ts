// Deterministic comparison engine for the normalized historical funnel
// variants (Phase 3E.4).
//
// Runs the locked execution set against ONE canonical strict-dedup row array
// and reports per-variant metrics, baseline deltas, and step attrition. Every
// ROI/PnL figure comes from the canonical roiPnlContract (flat 1 unit); the
// per-row equity walk reuses the same computeRowReturnPct interpretation --
// no ROI/win/loss math is re-derived here. Pure: no fs/env/network/database
// access, never mutates the input rows.

import {
  computeFlatStakeRoiSummary,
  computeRowReturnPct,
} from "./roiPnlContract";
import {
  evaluateHistoricalFunnelVariant,
  type FunnelStepResult,
} from "./historicalFunnelVariants";
import {
  getBundle,
  resolveAlias,
  type ExecutableFunnelClassifier,
  type BundleRecord,
  type StakePolicy,
} from "./executableFunnelClassifier";
import { buildEventGroupKey } from "./eventGroupSelection";

export const COMPARISON_ENGINE_VERSION = "3E.4-comparison-v1";
export const BASELINE_VARIANT_ID = "BASELINE_V1_CONTROL";

// The locked execution set (Phase 3E.4). MODEL_A is intentionally absent --
// it is an alias of ALT_SM_GUARD_ON_PRIMARY and must never execute twice.
export const LOCKED_EXECUTION_SET: readonly string[] = [
  "BASELINE_V1_CONTROL",
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT1_CANONICAL_EVENT_GROUPING",
  "ALT2_TS_SCORE_GE_65",
  "ALT2_PY_SCORE_GE_65_SM_LT_85",
  "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL",
  "ALT3_PY_SCORE_GE_65",
  "ALT_SM_GUARD_ON_PRIMARY",
  "ALT_SM_GUARD_ON_PRIMARY_APPROX",
];

type Row = Record<string, unknown>;

export type EvaluationStatus =
  | "EXECUTED"
  | "SKIPPED_AMBIGUOUS_ALIAS"
  | "SKIPPED_CONTRACT_STUB"
  | "SKIPPED_LABEL_ONLY"
  | "SKIPPED_DUPLICATE_ALIAS"
  | "BLOCKED_MISSING_FIELD"
  | "BLOCKED_CLASSIFIER_STATUS"
  | "FAILED_VALIDATION";

export interface EquityMetrics {
  endingPnl: number;
  peakPnl: number;
  maximumDrawdownUnits: number;
  maximumDrawdownPctOfPeak: number | null;
  longestWinningStreak: number;
  longestLosingStreak: number;
}

export interface VariantMetrics {
  inputRows: number;
  outputRows: number;
  retentionRate: number;
  removedRows: number;
  wins: number;
  losses: number;
  voidOrExcludedResultRows: number;
  winRate: number | null;
  flatUnitPnl: number | null;
  flatUnitRoi: number | null;
  firstResolvedAt: string | null;
  lastResolvedAt: string | null;
  coveredCalendarDays: number;
  signalsPerCoveredDay: number | null;
  uniqueConditionTokenPairs: number;
  uniqueMarkets: number;
  workingEventGroups: number;
  maximumSignalsPerWorkingEvent: number;
  equity: EquityMetrics;
}

export interface BaselineDelta {
  outputRowsDeltaVsBaseline: number;
  pnlDeltaVsBaseline: number | null;
  roiPercentagePointDeltaVsBaseline: number | null;
  winRatePercentagePointDeltaVsBaseline: number | null;
  signalsPerDayDeltaVsBaseline: number | null;
}

export interface VariantExecution {
  variantId: string;
  requestedAs?: string;
  evaluationStatus: EvaluationStatus;
  classifierRunStatus: string;
  metrics?: VariantMetrics;
  baselineDelta?: BaselineDelta;
  stepResults?: FunnelStepResult[];
  limitationFlags: string[];
  historicalStakePolicy: StakePolicy | null;
  normalizedStakePolicy: StakePolicy | null;
  blocker?: string | null;
}

export interface ComparisonResult {
  corpus: {
    inputRows: number;
    firstResolvedAt: string | null;
    lastResolvedAt: string | null;
    coveredCalendarDays: number;
  };
  comparisonEngineVersion: string;
  baselineVariantId: string;
  executions: VariantExecution[];
}

function getStr(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function validMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function calendarDaysInclusive(minMs: number | null, maxMs: number | null): number {
  if (minMs === null || maxMs === null) return 0;
  const dayMs = 86400000;
  return Math.floor(maxMs / dayMs) - Math.floor(minMs / dayMs) + 1;
}

function dateRange(rows: readonly Row[]): { first: string | null; last: string | null; days: number } {
  let minMs: number | null = null;
  let maxMs: number | null = null;
  let first: string | null = null;
  let last: string | null = null;
  for (const row of rows) {
    const raw = typeof row.resolved_at === "string" ? row.resolved_at : "";
    const ms = validMs(raw);
    if (ms === null) continue;
    if (minMs === null || ms < minMs) { minMs = ms; first = raw; }
    if (maxMs === null || ms > maxMs) { maxMs = ms; last = raw; }
  }
  return { first, last, days: calendarDaysInclusive(minMs, maxMs) };
}

/**
 * Flat 1-unit equity walk over `rows`, ordered by resolved_at ASC then id
 * ASC. Uses the canonical computeRowReturnPct interpretation -- the same
 * win/loss/return math as roiPnlContract -- so equity never diverges from
 * the ROI summary. Per-row PnL in units = returnPct / 100 for each valid
 * resolved bet; unresolved/invalid rows are skipped (they place no bet).
 */
export function computeFlatUnitEquityMetrics(rows: readonly Row[]): EquityMetrics {
  const ordered = [...rows].sort((a, b) => {
    const am = validMs(a.resolved_at) ?? Number.POSITIVE_INFINITY;
    const bm = validMs(b.resolved_at) ?? Number.POSITIVE_INFINITY;
    if (am !== bm) return am - bm;
    const ai = getStr(a, "id") ?? "";
    const bi = getStr(b, "id") ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let peakAtMaxDrawdown = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let longestWin = 0;
  let longestLoss = 0;

  for (const row of ordered) {
    const computed = computeRowReturnPct(row);
    if (computed.returnPct === null) continue; // unresolved or invalid: no bet
    const pnlUnits = computed.returnPct / 100;
    cumulative += pnlUnits;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      peakAtMaxDrawdown = peak;
    }
    if (computed.label === "win") {
      winStreak += 1;
      lossStreak = 0;
      if (winStreak > longestWin) longestWin = winStreak;
    } else if (computed.label === "loss") {
      lossStreak += 1;
      winStreak = 0;
      if (lossStreak > longestLoss) longestLoss = lossStreak;
    }
  }

  return {
    endingPnl: cumulative,
    peakPnl: peak,
    maximumDrawdownUnits: maxDrawdown,
    maximumDrawdownPctOfPeak: peakAtMaxDrawdown > 0 ? (maxDrawdown / peakAtMaxDrawdown) * 100 : null,
    longestWinningStreak: longestWin,
    longestLosingStreak: longestLoss,
  };
}

function computeMetrics(inputRows: number, selectedRows: readonly Row[], stepResults: FunnelStepResult[]): VariantMetrics {
  const roi = computeFlatStakeRoiSummary(selectedRows as unknown[], { strict: false, stakeUnits: 1 });
  const range = dateRange(selectedRows);
  const wins = roi.winCount;
  const losses = roi.lossCount;
  const voidOrExcluded = selectedRows.length - wins - losses;

  const conditionTokenPairs = new Set<string>();
  const markets = new Set<string>();
  const eventCounts = new Map<string, number>();
  for (const row of selectedRows) {
    const cond = getStr(row, "condition_id");
    const tok = getStr(row, "token_id") ?? getStr(row, "selected_token_id");
    if (cond !== null && tok !== null) conditionTokenPairs.add(`${cond}::${tok}`);
    if (cond !== null) markets.add(cond);
    const eventKey = buildEventGroupKey(row).key;
    eventCounts.set(eventKey, (eventCounts.get(eventKey) ?? 0) + 1);
  }
  const maxPerEvent = eventCounts.size > 0 ? Math.max(...eventCounts.values()) : 0;

  return {
    inputRows,
    outputRows: selectedRows.length,
    retentionRate: inputRows > 0 ? selectedRows.length / inputRows : 0,
    removedRows: inputRows - selectedRows.length,
    wins,
    losses,
    voidOrExcludedResultRows: voidOrExcluded,
    winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
    flatUnitPnl: roi.totalPnlUnits,
    flatUnitRoi: roi.roiPct,
    firstResolvedAt: range.first,
    lastResolvedAt: range.last,
    coveredCalendarDays: range.days,
    signalsPerCoveredDay: range.days > 0 ? selectedRows.length / range.days : null,
    uniqueConditionTokenPairs: conditionTokenPairs.size,
    uniqueMarkets: markets.size,
    workingEventGroups: eventCounts.size,
    maximumSignalsPerWorkingEvent: maxPerEvent,
    equity: computeFlatUnitEquityMetrics(selectedRows),
  };
}

function statusForNonExecutable(bundle: BundleRecord): EvaluationStatus | null {
  switch (bundle.runStatus) {
    case "AMBIGUOUS_ALIAS_NOT_EXECUTABLE":
      return "SKIPPED_AMBIGUOUS_ALIAS";
    case "CONTRACT_STUB_ONLY":
      return "SKIPPED_CONTRACT_STUB";
    case "LABEL_ONLY":
      return "SKIPPED_LABEL_ONLY";
    case "BLOCKED_MISSING_FIELD":
      return "BLOCKED_MISSING_FIELD";
    default:
      return null;
  }
}

export interface CompareOptions {
  rows: readonly Row[];
  classifier: ExecutableFunnelClassifier;
  requestedVariantIds: readonly string[];
}

/**
 * Runs every requested variant against the same canonical row array. No
 * requested id silently disappears -- ambiguous aliases, stubs, label-only
 * records, blocked/duplicate variants each appear with an explicit status.
 * Deterministic: output order matches requested order.
 */
export function compareHistoricalFunnelVariants(options: CompareOptions): ComparisonResult {
  const { rows, classifier, requestedVariantIds } = options;
  const corpusRange = dateRange(rows);

  // First pass: execute BASELINE so deltas can reference it.
  const executedOnce = new Set<string>();
  const executions: VariantExecution[] = [];
  let baselineMetrics: VariantMetrics | null = null;

  for (const requestedId of requestedVariantIds) {
    const bundle = getBundle(classifier, requestedId);
    if (!bundle) {
      executions.push({
        variantId: requestedId,
        evaluationStatus: "FAILED_VALIDATION",
        classifierRunStatus: "UNKNOWN",
        limitationFlags: ["unknown_bundle_id"],
        historicalStakePolicy: null,
        normalizedStakePolicy: null,
        blocker: `Unknown bundle id ${requestedId}`,
      });
      continue;
    }

    const base: Omit<VariantExecution, "evaluationStatus"> = {
      variantId: requestedId,
      classifierRunStatus: bundle.runStatus,
      limitationFlags: [],
      historicalStakePolicy: bundle.historicalStakePolicy,
      normalizedStakePolicy: bundle.normalizedEvaluationStakePolicy,
    };

    // MODEL_A (verified alias of an already-included bundle) must not execute
    // a second time.
    if (bundle.runStatus === "VERIFIED_ALIAS") {
      const targets = resolveAlias(classifier, requestedId);
      executions.push({
        ...base,
        evaluationStatus: "SKIPPED_DUPLICATE_ALIAS",
        limitationFlags: [`alias_of:${targets.join(",")}`],
        blocker: `${requestedId} is a verified alias of ${targets.join(", ")}; not executed a second time.`,
      });
      continue;
    }

    const nonExec = statusForNonExecutable(bundle);
    if (nonExec) {
      executions.push({
        ...base,
        evaluationStatus: nonExec,
        limitationFlags: bundle.plainLanguageBlocker ? [bundle.plainLanguageBlocker] : [],
        blocker: bundle.plainLanguageBlocker,
      });
      continue;
    }

    // Execute the funnel via the pure evaluator (which itself reuses canonical
    // predicates). If the evaluator reports BLOCKED (e.g. a missing field), we
    // surface that rather than fabricating metrics.
    const evalResult = evaluateHistoricalFunnelVariant(rows, classifier, requestedId);
    if (evalResult.status === "BLOCKED") {
      executions.push({
        ...base,
        evaluationStatus: "BLOCKED_MISSING_FIELD",
        stepResults: evalResult.stepResults,
        limitationFlags: evalResult.limitationFlags,
        blocker: bundle.plainLanguageBlocker,
      });
      continue;
    }

    const metrics = computeMetrics(evalResult.inputRows, evalResult.selectedRows, evalResult.stepResults);
    if (requestedId === BASELINE_VARIANT_ID) baselineMetrics = metrics;
    executedOnce.add(requestedId);

    executions.push({
      ...base,
      evaluationStatus: "EXECUTED",
      metrics,
      stepResults: evalResult.stepResults,
      limitationFlags: evalResult.limitationFlags,
      blocker: bundle.plainLanguageBlocker,
    });
  }

  // Second pass: fill baseline deltas now that baseline metrics are known.
  if (baselineMetrics) {
    for (const exec of executions) {
      if (exec.evaluationStatus !== "EXECUTED" || !exec.metrics) continue;
      const m = exec.metrics;
      const b = baselineMetrics;
      exec.baselineDelta = {
        outputRowsDeltaVsBaseline: m.outputRows - b.outputRows,
        pnlDeltaVsBaseline: m.flatUnitPnl !== null && b.flatUnitPnl !== null ? m.flatUnitPnl - b.flatUnitPnl : null,
        roiPercentagePointDeltaVsBaseline: m.flatUnitRoi !== null && b.flatUnitRoi !== null ? m.flatUnitRoi - b.flatUnitRoi : null,
        winRatePercentagePointDeltaVsBaseline: m.winRate !== null && b.winRate !== null ? m.winRate - b.winRate : null,
        signalsPerDayDeltaVsBaseline: m.signalsPerCoveredDay !== null && b.signalsPerCoveredDay !== null ? m.signalsPerCoveredDay - b.signalsPerCoveredDay : null,
      };
    }
  }

  return {
    corpus: {
      inputRows: rows.length,
      firstResolvedAt: corpusRange.first,
      lastResolvedAt: corpusRange.last,
      coveredCalendarDays: corpusRange.days,
    },
    comparisonEngineVersion: COMPARISON_ENGINE_VERSION,
    baselineVariantId: BASELINE_VARIANT_ID,
    executions,
  };
}
