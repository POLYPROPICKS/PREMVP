// Historical Model Run Visual Scorecard (Phase 3E.6).
//
// A deterministic, founder-facing scorecard built entirely from the ALREADY-
// COMPUTED canonical historical comparison artifact (and, optionally, the
// reproducible run manifest and the sport/market performance slice). This
// module renders what the canonical historical engines produced -- it never
// fetches data, never reads env/network/Supabase, never re-derives ROI/PnL or
// strict dedup, never uses forward/post-cutoff rows, and never selects a
// Champion. It fails closed (ScorecardValidationError) on any cross-artifact
// inconsistency rather than silently repairing it.
//
// Output is a pure JSON model (buildHistoricalModelScorecard), a self-
// contained HTML page with inline CSS + inline deterministic SVG and no
// JavaScript/CDN/remote fonts (renderHistoricalModelScorecardHtml), and a
// provenance manifest tying both to the source corpus/classifier hashes.

import { createHash } from "node:crypto";
import {
  LOCKED_EXECUTION_SET,
  BASELINE_VARIANT_ID,
  type VariantExecution,
  type VariantMetrics,
} from "./historicalFunnelComparison";
import type { ComparisonWithHash } from "./historicalFunnelScorecard";
import type { EvaluationRunManifest } from "./evaluationRunManifest";
import type {
  SportMarketPerformanceSlice,
  SegmentBucket,
  ModelSlice,
} from "./sportMarketPerformanceSlice";

export const SCORECARD_GENERATOR_VERSION = "3E.6-model-scorecard-v1" as const;

// Phase 4B: the first bounded historical hypothesis batch. LOCKED_EXECUTION_SET
// itself (the original 9, defined in historicalFunnelComparison.ts) is never
// modified -- these three are requested and rendered alongside it. Each is
// exactly one bounded change from base comparator ALT2_TS_SCORE_GE_65.
export const HYPOTHESIS_BATCH_1_IDS = [
  "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS",
  "ALT5_TS_SCORE_GE_65_TENNIS_ONLY",
  "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING",
] as const;

/** The full model order the scorecard requires and renders: locked 9 + batch 1 (3) = 12. */
export const SCORECARD_MODEL_ORDER: readonly string[] = [...LOCKED_EXECUTION_SET, ...HYPOTHESIS_BATCH_1_IDS];

// Fixed, prominent frozen comparators. Order is locked and never sorted.
export const FROZEN_COMPARATOR_IDS = [
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT2_TS_SCORE_GE_65",
  "ALT1_CANONICAL_EVENT_GROUPING",
] as const;

export class ScorecardValidationError extends Error {
  constructor(message: string) {
    super(`historical model scorecard: ${message}`);
    this.name = "ScorecardValidationError";
  }
}

// ---- JSON model ----

export interface ScorecardExecutive {
  headline: "CANONICAL HISTORICAL MODEL COMPARISON";
  championPolicy: "NO AUTOMATIC CHAMPION";
  promotionPolicy: "NO LIVE PROMOTION";
  rawRowCount: number | null;
  strictDedupRowCount: number;
  corpusFirstResolvedAt: string | null;
  corpusLastResolvedAt: string | null;
  corpusHash: string;
  classifierHash: string;
  comparisonEngineVersion: string;
  executedModelCount: number;
  blockedOrSkippedModelCount: number;
}

export interface FrozenComparatorCard {
  variantId: string;
  selectedN: number;
  eventGroups: number;
  totalPnlUnits: number | null;
  roiPct: number | null;
  wins: number;
  losses: number;
  invalid: number;
  maxDrawdownUnits: number;
  maxSignalsPerEvent: number;
}

export interface ScorecardModelRow {
  variantId: string;
  status: string;
  executed: boolean;
  isFrozenComparator: boolean;
  isBaseline: boolean;
  selectedSignals: number | null;
  uniqueEventGroups: number | null;
  pnlUnits: number | null;
  roiPct: number | null;
  currentDrawdownUnits: number | null;
  maxDrawdownUnits: number | null;
  wins: number | null;
  losses: number | null;
  invalid: number | null;
  maxSignalsPerEvent: number | null;
  deltaVsBaseline: {
    outputRows: number;
    pnlUnits: number | null;
    roiPercentagePoints: number | null;
  } | null;
  blocker: string | null;
}

export interface ChartPoint {
  label: string;
  value: number;
}

export interface BarChartSeries {
  title: string;
  unit: string;
  points: ChartPoint[];
}

export interface ScatterPoint {
  label: string;
  x: number;
  y: number;
}

export interface ScatterSeries {
  title: string;
  xLabel: string;
  yLabel: string;
  points: ScatterPoint[];
}

export interface EnvelopeSeries {
  title: string;
  yLabel: string;
  lines: Array<{ label: string; points: number[] }>;
}

export interface ScorecardCharts {
  volumeRoiFrontier: ScatterSeries;
  volumePnlFrontier: ScatterSeries;
  pnlBars: BarChartSeries;
  roiBars: BarChartSeries;
  volumeBars: BarChartSeries;
  maxDrawdownBars: BarChartSeries;
  cumulativePnlEnvelopes: EnvelopeSeries;
  drawdownEnvelopes: EnvelopeSeries;
  eventConcentration: BarChartSeries;
  signalsPerEvent: BarChartSeries | null;
}

export interface DecompositionSegment {
  dimension: string;
  modelId: string;
  label: string;
  confidence: string;
  n: number;
  pnlUnits: number | null;
  roiPct: number | null;
  sampleStatus: string;
  lowSampleWarning: boolean;
}

export interface ScorecardDecomposition {
  corpusRowCount: number;
  segments: DecompositionSegment[];
  classificationCoverage: {
    sport: Record<string, number>;
    marketType: Record<string, number>;
  };
  unknownCoveragePct: { sport: number; marketType: number };
}

export interface ScorecardInterpretation {
  primary: string;
  alt2: string;
  alt1: string;
  champion: "none";
  promotion: "no";
  additionalCandidates: string[];
}

export interface HypothesisSegmentRef {
  dimension: string;
  modelId: string;
  label: string;
  n: number;
  roiPct: number | null;
  pnlUnits: number | null;
}

export interface HypothesisReadiness {
  strongestPositiveSegments: HypothesisSegmentRef[];
  strongestNegativeSegments: HypothesisSegmentRef[];
  concentrationRisks: Array<{ modelId: string; maxSignalsPerEvent: number; workingEventGroups: number }>;
  lowSampleSegments: HypothesisSegmentRef[];
  candidateModelsForNextBatch: string[];
  blockedDimensions: string[];
}

export interface HistoricalModelScorecard {
  schemaVersion: 1;
  generatorVersion: typeof SCORECARD_GENERATOR_VERSION;
  executive: ScorecardExecutive;
  frozenComparators: FrozenComparatorCard[];
  models: ScorecardModelRow[];
  charts: ScorecardCharts;
  decomposition: ScorecardDecomposition | null;
  interpretation: ScorecardInterpretation;
  hypothesisReadiness: HypothesisReadiness;
  contentHash: string;
}

export interface ScorecardInputs {
  comparison: ComparisonWithHash;
  manifest?: EvaluationRunManifest;
  performanceSlice?: SportMarketPerformanceSlice;
}

// ---- numeric guards ----

function assertFinite(value: number | null | undefined, field: string, variantId: string): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScorecardValidationError(`non-finite ${field} for ${variantId}`);
  }
}

function invalidCount(m: VariantMetrics): number {
  return m.voidOrExcludedResultRows;
}

// ---- validation ----

interface ValidatedComparison {
  byId: Map<string, VariantExecution>;
  requiredOrder: readonly string[];
}

function validateAndIndex(comparison: ComparisonWithHash): ValidatedComparison {
  if (!comparison || !Array.isArray(comparison.executions)) {
    throw new ScorecardValidationError("comparison has no executions array");
  }
  if (typeof comparison.inputSha256 !== "string" || comparison.inputSha256.length === 0) {
    throw new ScorecardValidationError("comparison is missing inputSha256 (corpus hash)");
  }
  if (typeof comparison.classifierSha256 !== "string" || comparison.classifierSha256.length === 0) {
    throw new ScorecardValidationError("comparison is missing classifierSha256");
  }

  const byId = new Map<string, VariantExecution>();
  for (const exec of comparison.executions) {
    if (byId.has(exec.variantId)) {
      throw new ScorecardValidationError(`duplicate model id ${exec.variantId}`);
    }
    byId.set(exec.variantId, exec);
  }

  // Backward-compatible required order: a comparison artifact predating
  // Phase 4B carries only the original locked 9 and must keep validating
  // exactly as before. Once ANY batch-1 hypothesis is present, all 12 become
  // required (a partial batch is a fail-closed inconsistency, not silently
  // accepted).
  const hasAnyBatch1Id = HYPOTHESIS_BATCH_1_IDS.some((id) => byId.has(id));
  const requiredOrder = hasAnyBatch1Id ? SCORECARD_MODEL_ORDER : LOCKED_EXECUTION_SET;

  // Every model in the required order must remain present (blocked/skipped
  // included) -- no candidate may silently disappear.
  for (const id of requiredOrder) {
    if (!byId.has(id)) {
      throw new ScorecardValidationError(`locked model ${id} is missing from the comparison`);
    }
  }

  // Executed required models must appear in the exact required order.
  const executedLockedOrder = comparison.executions
    .filter((e) => e.evaluationStatus === "EXECUTED" && requiredOrder.includes(e.variantId))
    .map((e) => e.variantId);
  const expectedOrder = requiredOrder.filter((id) => byId.get(id)?.evaluationStatus === "EXECUTED");
  if (executedLockedOrder.join("|") !== expectedOrder.join("|")) {
    throw new ScorecardValidationError("executed model order diverges from the required scorecard model order");
  }

  // Frozen comparators must be present AND executed with metrics.
  for (const id of FROZEN_COMPARATOR_IDS) {
    const exec = byId.get(id);
    if (!exec || exec.evaluationStatus !== "EXECUTED" || !exec.metrics) {
      throw new ScorecardValidationError(`frozen comparator ${id} is missing or not executed`);
    }
  }

  // Per-metric sanity for every executed model.
  for (const exec of comparison.executions) {
    if (exec.evaluationStatus !== "EXECUTED" || !exec.metrics) continue;
    const m = exec.metrics;
    if (m.outputRows < 0) {
      throw new ScorecardValidationError(`negative selected count for ${exec.variantId}`);
    }
    assertFinite(m.flatUnitPnl, "flatUnitPnl", exec.variantId);
    assertFinite(m.flatUnitRoi, "flatUnitRoi", exec.variantId);
    assertFinite(m.equity.maximumDrawdownUnits, "maximumDrawdownUnits", exec.variantId);
    assertFinite(m.equity.endingPnl, "endingPnl", exec.variantId);
    assertFinite(m.equity.peakPnl, "peakPnl", exec.variantId);
    // PnL / ROI reconciliation (flat 1-unit stake): roi = pnl/outputRows*100.
    if (m.outputRows > 0 && m.flatUnitPnl !== null && m.flatUnitRoi !== null) {
      const expectedRoi = (m.flatUnitPnl / m.outputRows) * 100;
      if (Math.abs(expectedRoi - m.flatUnitRoi) > 1e-6) {
        throw new ScorecardValidationError(`PnL/ROI reconciliation failed for ${exec.variantId}`);
      }
    }
  }

  return { byId, requiredOrder };
}

function validateManifest(comparison: ComparisonWithHash, manifest: EvaluationRunManifest): void {
  if (manifest.inputSha256 !== comparison.inputSha256) {
    throw new ScorecardValidationError("comparison/manifest corpus hash mismatch");
  }
  if (manifest.classifierSha256 !== comparison.classifierSha256) {
    throw new ScorecardValidationError("comparison/manifest classifier hash mismatch");
  }
}

function validatePerformanceSlice(byId: Map<string, VariantExecution>, slice: SportMarketPerformanceSlice): void {
  for (const model of slice.models) {
    const exec = byId.get(model.variantId);
    if (exec?.evaluationStatus === "EXECUTED" && exec.metrics) {
      if (model.outputRows !== exec.metrics.outputRows) {
        throw new ScorecardValidationError(
          `performance slice does not reconcile with model totals for ${model.variantId} (${model.outputRows} vs ${exec.metrics.outputRows})`,
        );
      }
    }
  }
}

// ---- builders ----

function frozenCard(exec: VariantExecution): FrozenComparatorCard {
  const m = exec.metrics!;
  return {
    variantId: exec.variantId,
    selectedN: m.outputRows,
    eventGroups: m.workingEventGroups,
    totalPnlUnits: m.flatUnitPnl,
    roiPct: m.flatUnitRoi,
    wins: m.wins,
    losses: m.losses,
    invalid: invalidCount(m),
    maxDrawdownUnits: m.equity.maximumDrawdownUnits,
    maxSignalsPerEvent: m.maximumSignalsPerWorkingEvent,
  };
}

function modelRow(exec: VariantExecution): ScorecardModelRow {
  const m = exec.metrics;
  const executed = exec.evaluationStatus === "EXECUTED" && !!m;
  const currentDrawdown = executed ? m!.equity.peakPnl - m!.equity.endingPnl : null;
  const delta = exec.baselineDelta;
  return {
    variantId: exec.variantId,
    status: exec.evaluationStatus,
    executed,
    isFrozenComparator: (FROZEN_COMPARATOR_IDS as readonly string[]).includes(exec.variantId),
    isBaseline: exec.variantId === BASELINE_VARIANT_ID,
    selectedSignals: executed ? m!.outputRows : null,
    uniqueEventGroups: executed ? m!.workingEventGroups : null,
    pnlUnits: executed ? m!.flatUnitPnl : null,
    roiPct: executed ? m!.flatUnitRoi : null,
    currentDrawdownUnits: currentDrawdown,
    maxDrawdownUnits: executed ? m!.equity.maximumDrawdownUnits : null,
    wins: executed ? m!.wins : null,
    losses: executed ? m!.losses : null,
    invalid: executed ? invalidCount(m!) : null,
    maxSignalsPerEvent: executed ? m!.maximumSignalsPerWorkingEvent : null,
    deltaVsBaseline: delta
      ? {
          outputRows: delta.outputRowsDeltaVsBaseline,
          pnlUnits: delta.pnlDeltaVsBaseline,
          roiPercentagePoints: delta.roiPercentagePointDeltaVsBaseline,
        }
      : null,
    blocker: exec.blocker ?? (exec.limitationFlags.length > 0 ? exec.limitationFlags.join("; ") : null),
  };
}

function buildCharts(executedRows: ScorecardModelRow[]): ScorecardCharts {
  const barPoints = (fn: (r: ScorecardModelRow) => number): ChartPoint[] =>
    executedRows.map((r) => ({ label: r.variantId, value: fn(r) }));

  return {
    volumeRoiFrontier: {
      title: "Volume vs ROI (each executed model)",
      xLabel: "Selected signals",
      yLabel: "ROI %",
      points: executedRows.map((r) => ({ label: r.variantId, x: r.selectedSignals ?? 0, y: r.roiPct ?? 0 })),
    },
    volumePnlFrontier: {
      title: "Volume vs PnL (each executed model)",
      xLabel: "Selected signals",
      yLabel: "PnL units",
      points: executedRows.map((r) => ({ label: r.variantId, x: r.selectedSignals ?? 0, y: r.pnlUnits ?? 0 })),
    },
    pnlBars: { title: "Total PnL (units)", unit: "units", points: barPoints((r) => r.pnlUnits ?? 0) },
    roiBars: { title: "ROI (%)", unit: "%", points: barPoints((r) => r.roiPct ?? 0) },
    volumeBars: { title: "Selected volume (signals)", unit: "signals", points: barPoints((r) => r.selectedSignals ?? 0) },
    maxDrawdownBars: { title: "Maximum drawdown (units)", unit: "units", points: barPoints((r) => r.maxDrawdownUnits ?? 0) },
    // Equity ENVELOPE (not a per-bet walk): derived only from the aggregate
    // equity metrics the comparison exposes -- start at 0, rise to peak, end
    // at ending PnL. Never implies statistical significance or per-row data.
    cumulativePnlEnvelopes: {
      title: "PnL equity envelope (aggregate: 0 → peak → ending)",
      yLabel: "PnL units",
      lines: executedRows.map((r) => ({
        label: r.variantId,
        points: [0, r.pnlUnits !== null ? (r.pnlUnits ?? 0) + (r.currentDrawdownUnits ?? 0) : 0, r.pnlUnits ?? 0],
      })),
    },
    drawdownEnvelopes: {
      title: "Drawdown envelope (aggregate: 0 → -max drawdown)",
      yLabel: "Drawdown units",
      lines: executedRows.map((r) => ({ label: r.variantId, points: [0, -(r.maxDrawdownUnits ?? 0)] })),
    },
    eventConcentration: {
      title: "Max signals per working event",
      unit: "signals/event",
      points: barPoints((r) => r.maxSignalsPerEvent ?? 0),
    },
    signalsPerEvent: null,
  };
}

function segmentsFromSlice(slice: SportMarketPerformanceSlice): DecompositionSegment[] {
  const out: DecompositionSegment[] = [];
  const push = (dimension: string, model: ModelSlice, buckets: SegmentBucket[]): void => {
    for (const b of buckets) {
      out.push({
        dimension,
        modelId: model.variantId,
        label: b.label,
        confidence: b.classificationConfidence,
        n: b.metrics.signals,
        pnlUnits: b.metrics.pnlUnits,
        roiPct: b.metrics.roiPct,
        sampleStatus: b.sampleStatus,
        lowSampleWarning: b.sampleStatus === "LOW_SAMPLE",
      });
    }
  };
  for (const model of slice.models) {
    push("sport", model, model.sportBreakdown);
    push("marketType", model, model.marketTypeBreakdown);
  }
  return out;
}

function buildDecomposition(slice: SportMarketPerformanceSlice | undefined): ScorecardDecomposition | null {
  if (!slice) return null;
  const cov = slice.classificationCoverage;
  return {
    corpusRowCount: slice.corpusRowCount,
    segments: segmentsFromSlice(slice),
    classificationCoverage: {
      sport: { ...cov.sport },
      marketType: { ...cov.marketType },
    },
    unknownCoveragePct: { sport: cov.sport.UNKNOWN, marketType: cov.marketType.UNKNOWN },
  };
}

function buildHypothesisReadiness(
  models: ScorecardModelRow[],
  decomposition: ScorecardDecomposition | null,
): HypothesisReadiness {
  const executed = models.filter((m) => m.executed);
  const blockedDimensions: string[] = [];
  if (!decomposition) blockedDimensions.push("decomposition");

  const segRefs: HypothesisSegmentRef[] = decomposition
    ? decomposition.segments.map((s) => ({
        dimension: s.dimension,
        modelId: s.modelId,
        label: s.label,
        n: s.n,
        roiPct: s.roiPct,
        pnlUnits: s.pnlUnits,
      }))
    : [];

  const robust = segRefs.filter((s) => s.n >= 30 && s.roiPct !== null);
  const positives = [...robust].sort((a, b) => (b.roiPct ?? 0) - (a.roiPct ?? 0)).slice(0, 5);
  const negatives = [...robust].sort((a, b) => (a.roiPct ?? 0) - (b.roiPct ?? 0)).slice(0, 5);
  const lowSample = segRefs.filter((s) => s.n > 0 && s.n < 30).slice(0, 10);

  const concentrationRisks = executed
    .filter((m) => (m.maxSignalsPerEvent ?? 0) > 1)
    .map((m) => ({
      modelId: m.variantId,
      maxSignalsPerEvent: m.maxSignalsPerEvent ?? 0,
      workingEventGroups: m.uniqueEventGroups ?? 0,
    }));

  return {
    strongestPositiveSegments: positives,
    strongestNegativeSegments: negatives,
    concentrationRisks,
    lowSampleSegments: lowSample,
    candidateModelsForNextBatch: executed.map((m) => m.variantId),
    blockedDimensions,
  };
}

/**
 * Builds the deterministic historical model scorecard from the canonical
 * historical comparison artifact (and optional manifest/performance slice).
 * Fails closed on any cross-artifact inconsistency. Pure: no fs/env/network.
 */
export function buildHistoricalModelScorecard(inputs: ScorecardInputs): HistoricalModelScorecard {
  const { comparison, manifest, performanceSlice } = inputs;
  const { byId, requiredOrder } = validateAndIndex(comparison);
  if (manifest) validateManifest(comparison, manifest);
  if (performanceSlice) validatePerformanceSlice(byId, performanceSlice);

  const orderedExecutions = requiredOrder.map((id) => byId.get(id)!);
  const models = orderedExecutions.map(modelRow);
  const executedRows = models.filter((m) => m.executed);

  const executedCount = executedRows.length;
  const blockedOrSkippedCount = requiredOrder.length - executedCount;

  const executive: ScorecardExecutive = {
    headline: "CANONICAL HISTORICAL MODEL COMPARISON",
    championPolicy: "NO AUTOMATIC CHAMPION",
    promotionPolicy: "NO LIVE PROMOTION",
    rawRowCount: manifest ? manifest.rawInputRowCount : null,
    strictDedupRowCount: comparison.corpus.inputRows,
    corpusFirstResolvedAt: comparison.corpus.firstResolvedAt,
    corpusLastResolvedAt: comparison.corpus.lastResolvedAt,
    corpusHash: comparison.inputSha256,
    classifierHash: comparison.classifierSha256,
    comparisonEngineVersion: comparison.comparisonEngineVersion,
    executedModelCount: executedCount,
    blockedOrSkippedModelCount: blockedOrSkippedCount,
  };

  const frozenComparators = FROZEN_COMPARATOR_IDS.map((id) => frozenCard(byId.get(id)!));
  const charts = buildCharts(executedRows);
  const decomposition = buildDecomposition(performanceSlice);
  const hypothesisReadiness = buildHypothesisReadiness(models, decomposition);

  const additionalCandidates = executedRows
    .filter((m) => !m.isFrozenComparator && !m.isBaseline)
    .map((m) => m.variantId);

  const interpretation: ScorecardInterpretation = {
    primary: "PRIMARY = historical quality candidate",
    alt2: "ALT2 = broad / high-volume comparator",
    alt1: "ALT1 = concentration-control comparator",
    champion: "none",
    promotion: "no",
    additionalCandidates,
  };

  const withoutHash: Omit<HistoricalModelScorecard, "contentHash"> = {
    schemaVersion: 1,
    generatorVersion: SCORECARD_GENERATOR_VERSION,
    executive,
    frozenComparators,
    models,
    charts,
    decomposition,
    interpretation,
    hypothesisReadiness,
  };

  const contentHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  return { ...withoutHash, contentHash };
}

/** Deterministic pretty JSON with exactly one trailing newline. */
export function serializeScorecardJson(scorecard: HistoricalModelScorecard): string {
  return `${JSON.stringify(scorecard, null, 2)}\n`;
}

// ---- HTML rendering (inline CSS + inline SVG, no JS/CDN/fonts/network) ----

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

const SVG_W = 640;
const SVG_H = 240;
const PAD_L = 48;
const PAD_B = 64;
const PAD_T = 24;
const PAD_R = 16;

function shortLabel(variantId: string): string {
  return variantId.replace(/_/g, " ").slice(0, 14);
}

function barChartSvg(chartId: string, series: BarChartSeries): string {
  const points = series.points;
  const values = points.map((p) => p.value);
  const maxV = Math.max(0, ...values);
  const minV = Math.min(0, ...values);
  const span = maxV - minV || 1;
  const plotW = SVG_W - PAD_L - PAD_R;
  const plotH = SVG_H - PAD_T - PAD_B;
  const bw = points.length > 0 ? plotW / points.length : plotW;
  const yOfZero = PAD_T + plotH - ((0 - minV) / span) * plotH;

  const bars = points
    .map((p, i) => {
      const h = (Math.abs(p.value) / span) * plotH;
      const x = PAD_L + i * bw + bw * 0.15;
      const w = bw * 0.7;
      const y = p.value >= 0 ? yOfZero - h : yOfZero;
      const fill = p.value >= 0 ? "#2f7d5b" : "#a3423a";
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"><title>${escapeHtml(p.label)}: ${fmt(p.value)}</title></rect>` +
        `<text x="${(x + w / 2).toFixed(1)}" y="${(p.value >= 0 ? y - 3 : y + h + 11).toFixed(1)}" font-size="9" text-anchor="middle" fill="#222">${escapeHtml(fmt(p.value, 1))}</text>` +
        `<text x="${(x + w / 2).toFixed(1)}" y="${(SVG_H - PAD_B + 14).toFixed(1)}" font-size="8" text-anchor="end" fill="#444" transform="rotate(-40 ${(x + w / 2).toFixed(1)} ${(SVG_H - PAD_B + 14).toFixed(1)})">${escapeHtml(shortLabel(p.label))}</text>`
      );
    })
    .join("");

  return (
    `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="${escapeHtml(series.title)}" class="chart" id="chart-${escapeHtml(chartId)}">` +
    `<title>${escapeHtml(series.title)}</title>` +
    `<line x1="${PAD_L}" y1="${yOfZero.toFixed(1)}" x2="${SVG_W - PAD_R}" y2="${yOfZero.toFixed(1)}" stroke="#999" stroke-width="1"/>` +
    `<text x="4" y="${PAD_T + 4}" font-size="9" fill="#444">${escapeHtml(series.unit)}</text>` +
    bars +
    `</svg>`
  );
}

function scatterSvg(chartId: string, series: ScatterSeries): string {
  const xs = series.points.map((p) => p.x);
  const ys = series.points.map((p) => p.y);
  const maxX = Math.max(1, ...xs);
  const minX = Math.min(0, ...xs);
  const maxY = Math.max(0, ...ys);
  const minY = Math.min(0, ...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const plotW = SVG_W - PAD_L - PAD_R;
  const plotH = SVG_H - PAD_T - PAD_B;

  const dots = series.points
    .map((p) => {
      const cx = PAD_L + ((p.x - minX) / spanX) * plotW;
      const cy = PAD_T + plotH - ((p.y - minY) / spanY) * plotH;
      return (
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="#33608f"><title>${escapeHtml(p.label)}: (${fmt(p.x, 0)}, ${fmt(p.y)})</title></circle>` +
        `<text x="${(cx + 6).toFixed(1)}" y="${(cy - 4).toFixed(1)}" font-size="8" fill="#333">${escapeHtml(shortLabel(p.label))}</text>`
      );
    })
    .join("");

  return (
    `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="${escapeHtml(series.title)}" class="chart" id="chart-${escapeHtml(chartId)}">` +
    `<title>${escapeHtml(series.title)}</title>` +
    `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${(PAD_T + plotH).toFixed(1)}" stroke="#999"/>` +
    `<line x1="${PAD_L}" y1="${(PAD_T + plotH).toFixed(1)}" x2="${SVG_W - PAD_R}" y2="${(PAD_T + plotH).toFixed(1)}" stroke="#999"/>` +
    `<text x="${PAD_L}" y="${SVG_H - 4}" font-size="9" fill="#444">${escapeHtml(series.xLabel)}</text>` +
    `<text x="4" y="${PAD_T + 4}" font-size="9" fill="#444">${escapeHtml(series.yLabel)}</text>` +
    dots +
    `</svg>`
  );
}

function envelopeSvg(chartId: string, series: EnvelopeSeries): string {
  const allY = series.lines.flatMap((l) => l.points);
  const maxY = Math.max(0, ...allY);
  const minY = Math.min(0, ...allY);
  const spanY = maxY - minY || 1;
  const plotW = SVG_W - PAD_L - PAD_R;
  const plotH = SVG_H - PAD_T - PAD_B;
  const palette = ["#33608f", "#2f7d5b", "#a3423a", "#7a5c9e", "#b7791f", "#4c8c8c", "#8c5a4c", "#556b2f", "#993d6b"];

  const yOfZero = PAD_T + plotH - ((0 - minY) / spanY) * plotH;
  const lines = series.lines
    .map((line, li) => {
      const n = line.points.length;
      const path = line.points
        .map((y, i) => {
          const x = PAD_L + (n > 1 ? (i / (n - 1)) * plotW : 0);
          const py = PAD_T + plotH - ((y - minY) / spanY) * plotH;
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${py.toFixed(1)}`;
        })
        .join(" ");
      const color = palette[li % palette.length];
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.85"><title>${escapeHtml(line.label)}</title></path>`;
    })
    .join("");

  return (
    `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="${escapeHtml(series.title)}" class="chart" id="chart-${escapeHtml(chartId)}">` +
    `<title>${escapeHtml(series.title)}</title>` +
    `<line x1="${PAD_L}" y1="${yOfZero.toFixed(1)}" x2="${SVG_W - PAD_R}" y2="${yOfZero.toFixed(1)}" stroke="#ccc"/>` +
    `<text x="4" y="${PAD_T + 4}" font-size="9" fill="#444">${escapeHtml(series.yLabel)}</text>` +
    lines +
    `</svg>`
  );
}

function frozenCardHtml(card: FrozenComparatorCard): string {
  return (
    `<div class="frozen-card">` +
    `<h3>${escapeHtml(card.variantId)}</h3>` +
    `<dl>` +
    `<dt>Selected N</dt><dd>${fmtInt(card.selectedN)}</dd>` +
    `<dt>Event groups</dt><dd>${fmtInt(card.eventGroups)}</dd>` +
    `<dt>Total PnL</dt><dd>${fmt(card.totalPnlUnits)} u</dd>` +
    `<dt>ROI</dt><dd>${fmt(card.roiPct)} %</dd>` +
    `<dt>Wins / Losses / Invalid</dt><dd>${fmtInt(card.wins)} / ${fmtInt(card.losses)} / ${fmtInt(card.invalid)}</dd>` +
    `<dt>Max drawdown</dt><dd>${fmt(card.maxDrawdownUnits)} u</dd>` +
    `<dt>Max signals / event</dt><dd>${fmtInt(card.maxSignalsPerEvent)}</dd>` +
    `</dl></div>`
  );
}

function modelTableRow(m: ScorecardModelRow): string {
  const delta = m.deltaVsBaseline;
  return (
    `<tr class="${m.executed ? "executed" : "not-executed"}">` +
    `<td>${escapeHtml(m.variantId)}</td>` +
    `<td>${escapeHtml(m.status)}</td>` +
    `<td>${fmtInt(m.selectedSignals)}</td>` +
    `<td>${fmtInt(m.uniqueEventGroups)}</td>` +
    `<td>${fmt(m.pnlUnits)}</td>` +
    `<td>${fmt(m.roiPct)}</td>` +
    `<td>${fmt(m.currentDrawdownUnits)}</td>` +
    `<td>${fmt(m.maxDrawdownUnits)}</td>` +
    `<td>${fmtInt(m.wins)}/${fmtInt(m.losses)}/${fmtInt(m.invalid)}</td>` +
    `<td>${delta ? fmt(delta.pnlUnits) : "—"}</td>` +
    `<td>${escapeHtml(m.blocker ?? "")}</td>` +
    `</tr>`
  );
}

function decompositionHtml(d: ScorecardDecomposition | null): string {
  if (!d) {
    return `<section><h2>5. Automated decomposition</h2><p class="muted">No performance-slice artifact supplied; sport / market-type / confidence decomposition is unavailable in this run.</p></section>`;
  }
  const rows = d.segments
    .map(
      (s) =>
        `<tr class="${s.lowSampleWarning ? "low-sample" : ""}"><td>${escapeHtml(s.dimension)}</td><td>${escapeHtml(s.modelId)}</td><td>${escapeHtml(s.label)}</td><td>${escapeHtml(s.confidence)}</td><td>${fmtInt(s.n)}</td><td>${fmt(s.pnlUnits)}</td><td>${fmt(s.roiPct)}</td><td>${escapeHtml(s.sampleStatus)}${s.lowSampleWarning ? " ⚠" : ""}</td></tr>`,
    )
    .join("");
  return (
    `<section><h2>5. Automated decomposition</h2>` +
    `<p>Sport UNKNOWN coverage: ${fmt(d.unknownCoveragePct.sport)}% · Market-type UNKNOWN coverage: ${fmt(d.unknownCoveragePct.marketType)}%</p>` +
    `<table><thead><tr><th>Dimension</th><th>Model</th><th>Segment</th><th>Confidence</th><th>N</th><th>PnL</th><th>ROI %</th><th>Sample</th></tr></thead><tbody>${rows}</tbody></table></section>`
  );
}

/**
 * Renders the scorecard as a single self-contained HTML page: inline CSS,
 * inline deterministic SVG charts, no JavaScript, no external URL, no remote
 * font, no network. Never embeds raw corpus rows. Deterministic for identical
 * input.
 */
export function renderHistoricalModelScorecardHtml(s: HistoricalModelScorecard): string {
  const e = s.executive;
  const css =
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;color:#1a1a1a;background:#fafafa;max-width:1000px}" +
    "h1{font-size:20px}h2{font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px}h3{font-size:13px;margin:0 0 6px}" +
    ".banner{background:#1f2d3d;color:#fff;padding:12px;border-radius:6px}" +
    ".policy{display:inline-block;background:#b7791f;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:6px}" +
    ".frozen-grid{display:flex;flex-wrap:wrap;gap:12px}.frozen-card{border:1px solid #ccc;border-radius:6px;padding:10px;flex:1 1 220px;background:#fff}" +
    ".frozen-card dl{display:grid;grid-template-columns:1fr auto;gap:2px 8px;margin:0;font-size:12px}.frozen-card dt{color:#555}.frozen-card dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}" +
    "table{border-collapse:collapse;width:100%;font-size:11px;margin-top:8px}th,td{border:1px solid #ddd;padding:3px 6px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}" +
    "tr.not-executed{background:#f3f0e8;color:#666}tr.low-sample{background:#fff4f0}" +
    ".chart{width:100%;height:auto;background:#fff;border:1px solid #eee;border-radius:6px;margin:8px 0}" +
    ".muted{color:#666}.chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}" +
    "@media print{body{background:#fff}.chart{break-inside:avoid}}";

  const charts = s.charts;
  const chartBlocks = [
    scatterSvg("volume-roi", charts.volumeRoiFrontier),
    scatterSvg("volume-pnl", charts.volumePnlFrontier),
    barChartSvg("pnl", charts.pnlBars),
    barChartSvg("roi", charts.roiBars),
    barChartSvg("volume", charts.volumeBars),
    barChartSvg("maxdd", charts.maxDrawdownBars),
    envelopeSvg("cum-pnl", charts.cumulativePnlEnvelopes),
    envelopeSvg("drawdown", charts.drawdownEnvelopes),
    barChartSvg("event-conc", charts.eventConcentration),
  ]
    .map((svg) => `<div>${svg}</div>`)
    .join("");

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Historical Model Run Scorecard</title><style>${css}</style></head><body>` +
    `<h1>Historical Model Run Visual Scorecard</h1>` +
    `<div class="banner"><strong>${escapeHtml(e.headline)}</strong><br>` +
    `<span class="policy">${escapeHtml(e.championPolicy)}</span><span class="policy">${escapeHtml(e.promotionPolicy)}</span></div>` +
    // 1. Executive summary
    `<section><h2>1. Executive summary</h2><table><tbody>` +
    `<tr><th>Raw corpus rows</th><td>${e.rawRowCount === null ? "— (manifest not supplied)" : fmtInt(e.rawRowCount)}</td></tr>` +
    `<tr><th>Strict-dedup observations</th><td>${fmtInt(e.strictDedupRowCount)}</td></tr>` +
    `<tr><th>Corpus date range</th><td>${escapeHtml(e.corpusFirstResolvedAt ?? "—")} → ${escapeHtml(e.corpusLastResolvedAt ?? "—")}</td></tr>` +
    `<tr><th>Corpus hash</th><td>${escapeHtml(e.corpusHash)}</td></tr>` +
    `<tr><th>Classifier hash</th><td>${escapeHtml(e.classifierHash)}</td></tr>` +
    `<tr><th>Executed models</th><td>${fmtInt(e.executedModelCount)}</td></tr>` +
    `<tr><th>Blocked / skipped candidates</th><td>${fmtInt(e.blockedOrSkippedModelCount)}</td></tr>` +
    `</tbody></table></section>` +
    // 2. Frozen comparators
    `<section><h2>2. Frozen comparator summary</h2><div class="frozen-grid">${s.frozenComparators.map(frozenCardHtml).join("")}</div></section>` +
    // 3. All-model comparison
    `<section><h2>3. All-model comparison (locked execution set)</h2><table><thead><tr>` +
    `<th>Model</th><th>Status</th><th>N</th><th>Events</th><th>PnL</th><th>ROI %</th><th>Cur DD</th><th>Max DD</th><th>W/L/Inv</th><th>ΔPnL vs base</th><th>Blocker</th>` +
    `</tr></thead><tbody>${s.models.map(modelTableRow).join("")}</tbody></table></section>` +
    // 4. Charts
    `<section><h2>4. Comparative charts</h2><div class="chart-grid">${chartBlocks}</div></section>` +
    // 5. Decomposition
    decompositionHtml(s.decomposition) +
    // 6. Interpretation
    `<section><h2>6. Interpretation</h2><ul>` +
    `<li>${escapeHtml(s.interpretation.primary)}</li>` +
    `<li>${escapeHtml(s.interpretation.alt2)}</li>` +
    `<li>${escapeHtml(s.interpretation.alt1)}</li>` +
    `<li><strong>Champion: ${escapeHtml(s.interpretation.champion)} · Promotion: ${escapeHtml(s.interpretation.promotion)}</strong></li>` +
    `</ul><p>Additional executed candidates: ${s.interpretation.additionalCandidates.map((c) => escapeHtml(c)).join(", ") || "—"}</p></section>` +
    // 7. Hypothesis readiness
    `<section><h2>7. Hypothesis-readiness (input for Phase 4B)</h2>` +
    `<p>Candidate models for next batch: ${s.hypothesisReadiness.candidateModelsForNextBatch.map((c) => escapeHtml(c)).join(", ") || "—"}</p>` +
    `<p>Blocked dimensions: ${s.hypothesisReadiness.blockedDimensions.map((c) => escapeHtml(c)).join(", ") || "none"}</p></section>` +
    `<footer class="muted"><small>Generator ${escapeHtml(s.generatorVersion)} · content ${escapeHtml(s.contentHash)}</small></footer>` +
    `</body></html>\n`;

  return html;
}

// ---- manifest + artifact bundle ----

export interface ScorecardManifest {
  schemaVersion: 1;
  generatorVersion: typeof SCORECARD_GENERATOR_VERSION;
  scorecardContentHash: string;
  scorecardJsonSha256: string;
  scorecardHtmlSha256: string;
  comparisonInputSha256: string;
  classifierSha256: string;
  comparisonEngineVersion: string;
  championPolicy: "NO AUTOMATIC CHAMPION";
  promotionPolicy: "NO LIVE PROMOTION";
  executedModelCount: number;
  blockedOrSkippedModelCount: number;
  sourceRunId: string | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildScorecardManifest(
  scorecard: HistoricalModelScorecard,
  htmlString: string,
  sourceRunId: string | null = null,
): ScorecardManifest {
  return {
    schemaVersion: 1,
    generatorVersion: SCORECARD_GENERATOR_VERSION,
    scorecardContentHash: scorecard.contentHash,
    scorecardJsonSha256: sha256(serializeScorecardJson(scorecard)),
    scorecardHtmlSha256: sha256(htmlString),
    comparisonInputSha256: scorecard.executive.corpusHash,
    classifierSha256: scorecard.executive.classifierHash,
    comparisonEngineVersion: scorecard.executive.comparisonEngineVersion,
    championPolicy: "NO AUTOMATIC CHAMPION",
    promotionPolicy: "NO LIVE PROMOTION",
    executedModelCount: scorecard.executive.executedModelCount,
    blockedOrSkippedModelCount: scorecard.executive.blockedOrSkippedModelCount,
    sourceRunId,
  };
}

export interface ScorecardArtifactBundle {
  scorecard: HistoricalModelScorecard;
  manifest: ScorecardManifest;
  jsonString: string;
  htmlString: string;
  manifestString: string;
}

export function buildHistoricalModelScorecardArtifacts(inputs: ScorecardInputs): ScorecardArtifactBundle {
  const scorecard = buildHistoricalModelScorecard(inputs);
  const jsonString = serializeScorecardJson(scorecard);
  const htmlString = renderHistoricalModelScorecardHtml(scorecard);
  const manifest = buildScorecardManifest(scorecard, htmlString, inputs.manifest?.runId ?? null);
  const manifestString = `${JSON.stringify(manifest, null, 2)}\n`;
  return { scorecard, manifest, jsonString, htmlString, manifestString };
}
