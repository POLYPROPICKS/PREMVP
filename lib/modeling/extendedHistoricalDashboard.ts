// Extended Decomposition Charts and Historical Dashboard (Phase A2).
//
// Turns the already-computed A1 extended-decomposition JSON into one
// self-contained, readable historical research dashboard. Consumes A1
// output ONLY -- never recalculates model selection, ROI, dedup, equity, or
// event grouping from raw rows. Every number here is copied or purely
// aggregated (sums/medians/ratios) from A1's own segment metrics. Research
// evidence only: never selects a Champion, never promotes a model.

import { createHash } from "node:crypto";
import {
  extractEvidencePool,
  type ExtendedHistoricalDecomposition,
  type ModelDecomposition,
  type DecompositionSegmentMetrics,
  type DimensionAvailability,
} from "./extendedHistoricalDecomposition";

export const DASHBOARD_ENGINE_VERSION = "A2-extended-dashboard-v1" as const;

export class DashboardValidationError extends Error {
  constructor(message: string) {
    super(`extended historical dashboard: ${message}`);
    this.name = "DashboardValidationError";
  }
}

// ---- cross-model evidence thresholds (exact, immutable) ----

export const BROAD_MODEL_MIN_OBSERVATIONS = 200;
export const SEGMENT_ELIGIBLE_MIN_OBSERVATIONS = 30;
export const MIN_ELIGIBLE_BROAD_MODELS = 3;
const CONSISTENT_RATIO_THRESHOLD = 0.8;

// ---- JSON model ----

export interface ModelSummary {
  variantId: string;
  selectedObservations: number;
  flatUnitPnl: number | null;
  flatUnitRoi: number | null;
  maximumDrawdownUnits: number;
  longestLosingStreak: number;
  workingEventGroups: number;
  maximumSignalsPerWorkingEvent: number;
}

export interface FrontierPoint {
  variantId: string;
  x: number | null;
  y: number | null;
  size: number;
}

export interface FrontierData {
  roiPnl: FrontierPoint[];
  drawdownPnl: FrontierPoint[];
}

export interface HeatmapCell {
  variantId: string;
  bucket: string;
  observations: number;
  flatUnitPnl: number | null;
  flatUnitRoi: number | null;
}

export interface DimensionHeatmap {
  dimension: string;
  buckets: string[];
  cells: HeatmapCell[];
}

export interface EventConcentrationSummary {
  variantId: string;
  selectedObservations: number;
  workingEventGroups: number;
  maximumSignalsPerWorkingEvent: number;
  eventsWith1Signal: number;
  eventsWith2Signals: number;
  eventsWith3Signals: number;
  eventsWith4Signals: number;
  eventsWith5PlusSignals: number;
  pnlFromSingleSignalEvents: number | null;
  pnlFromMultiSignalEvents: number | null;
}

export interface OnePerEventTradeoff {
  variantId: string;
  deltaObservations: number;
  deltaPnl: number | null;
  deltaRoi: number | null;
  deltaMaxDrawdown: number;
  deltaLongestLosingStreak: number;
  deltaMaxSignalsPerEvent: number;
  riskImprovesDespiteLowerPnl: boolean;
}

export interface DrawdownComparisonEntry {
  variantId: string;
  drawdownUnits: number;
  intervalRowCount: number;
  topNegativeContributors: Array<{ dimension: string; bucket: string; rowCount: number; pnlUnits: number | null }>;
}

export interface LosingStreakComparisonEntry {
  variantId: string;
  length: number;
  cumulativePnlUnits: number;
  startResolvedAt: string | null;
  endResolvedAt: string | null;
  sampleWarning: boolean;
}

export type EvidenceClassification = "CONSISTENT_POSITIVE" | "CONSISTENT_NEGATIVE" | "MIXED";

export interface CrossModelEvidenceEntry {
  dimension: string;
  bucket: string;
  eligibleModelCount: number;
  positiveModelCount: number;
  negativeModelCount: number;
  totalPnl: number;
  medianRoi: number | null;
  minimumN: number;
  maximumN: number;
  supportRatio: number;
  classification: EvidenceClassification;
  eligibleModelIds: string[];
}

export const RESEARCH_DIRECTION_KINDS = [
  "TEST_EXCLUSION",
  "TEST_INCLUSION",
  "TEST_TIMING_GATE",
  "TEST_PRICE_GATE",
  "TEST_SCORE_INTERACTION",
  "REVIEW_CONCENTRATION_TRADEOFF",
] as const;
export type ResearchDirectionKind = (typeof RESEARCH_DIRECTION_KINDS)[number];

export interface ResearchDirection {
  kind: ResearchDirectionKind;
  dimension: string;
  bucket: string;
  supportingModels: string[];
  opposingModels: string[];
  sampleRange: { minimumN: number; maximumN: number };
  totalPnl: number;
  medianRoi: number | null;
  reason: string;
}

export interface ExtendedHistoricalDashboard {
  schemaVersion: 1;
  engineVersion: typeof DASHBOARD_ENGINE_VERSION;
  sourceDecompositionHash: string;
  corpusSummary: {
    rawRowCount: number;
    strictDedupRowCount: number;
    modelCount: number;
    inputSha256: string;
    classifierSha256: string;
  };
  modelSummaries: ModelSummary[];
  frontierData: FrontierData;
  dimensionHeatmaps: {
    score: DimensionHeatmap;
    price: DimensionHeatmap;
    coverage: DimensionHeatmap;
    timing: DimensionHeatmap;
  };
  eventConcentration: EventConcentrationSummary[];
  onePerEventTradeoffs: OnePerEventTradeoff[];
  drawdownComparison: DrawdownComparisonEntry[];
  losingStreakComparison: LosingStreakComparisonEntry[];
  crossModelEvidence: CrossModelEvidenceEntry[];
  nextResearchDirections: ResearchDirection[];
  dataAvailability: DimensionAvailability[];
  limitations: string[];
  contentHash: string;
}

export interface DashboardOptions {
  decomposition: ExtendedHistoricalDecomposition;
}

// ---- validation ----

function validate(decomposition: ExtendedHistoricalDecomposition): void {
  if (!decomposition || decomposition.schemaVersion !== 1) {
    throw new DashboardValidationError("source decomposition has an unexpected schemaVersion");
  }
  if (!Array.isArray(decomposition.models) || decomposition.models.length === 0) {
    throw new DashboardValidationError("source decomposition has no models");
  }
  if (typeof decomposition.contentHash !== "string" || decomposition.contentHash.length !== 64) {
    throw new DashboardValidationError("source decomposition is missing a valid contentHash");
  }
  const withoutHash: Record<string, unknown> = { ...(decomposition as unknown as Record<string, unknown>) };
  delete withoutHash.contentHash;
  const recomputed = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  if (recomputed !== decomposition.contentHash) {
    throw new DashboardValidationError("source decomposition contentHash does not verify (tampered or corrupted input)");
  }
}

// ---- model summaries / frontier ----

function summarize(model: ModelDecomposition): ModelSummary {
  const m = model.onePerEventComparison.keepAll;
  return {
    variantId: model.variantId,
    selectedObservations: model.selectedObservations,
    flatUnitPnl: m.flatUnitPnl,
    flatUnitRoi: m.flatUnitRoi,
    maximumDrawdownUnits: m.maximumDrawdownUnits,
    longestLosingStreak: m.longestLosingStreak,
    workingEventGroups: m.workingEventGroups,
    maximumSignalsPerWorkingEvent: m.maximumSignalsPerWorkingEvent,
  };
}

function buildFrontier(summaries: ModelSummary[]): FrontierData {
  return {
    roiPnl: summaries.map((s) => ({ variantId: s.variantId, x: s.flatUnitRoi, y: s.flatUnitPnl, size: s.selectedObservations })),
    drawdownPnl: summaries.map((s) => ({ variantId: s.variantId, x: s.maximumDrawdownUnits, y: s.flatUnitPnl, size: s.selectedObservations })),
  };
}

// ---- heatmaps ----

function buildHeatmap(models: readonly ModelDecomposition[], dimensionKey: keyof ModelDecomposition["decompositions"], dimensionLabel: string): DimensionHeatmap {
  const bucketOrder: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    for (const b of model.decompositions[dimensionKey]) {
      if (!seen.has(b.bucket)) {
        seen.add(b.bucket);
        bucketOrder.push(b.bucket);
      }
    }
  }
  const cells: HeatmapCell[] = [];
  for (const model of models) {
    for (const b of model.decompositions[dimensionKey]) {
      if (b.metrics.observations === 0) continue;
      cells.push({
        variantId: model.variantId,
        bucket: b.bucket,
        observations: b.metrics.observations,
        flatUnitPnl: b.metrics.flatUnitPnl,
        flatUnitRoi: b.metrics.flatUnitRoi,
      });
    }
  }
  return { dimension: dimensionLabel, buckets: bucketOrder, cells };
}

// ---- event concentration / one-per-event ----

function eventConcentrationSummary(model: ModelDecomposition): EventConcentrationSummary {
  const c = model.eventConcentration;
  return {
    variantId: model.variantId,
    selectedObservations: c.selectedObservations,
    workingEventGroups: c.workingEventGroups,
    maximumSignalsPerWorkingEvent: c.maximumSignalsPerWorkingEvent,
    eventsWith1Signal: c.eventsWith1Signal,
    eventsWith2Signals: c.eventsWith2Signals,
    eventsWith3Signals: c.eventsWith3Signals,
    eventsWith4Signals: c.eventsWith4Signals,
    eventsWith5PlusSignals: c.eventsWith5PlusSignals,
    pnlFromSingleSignalEvents: c.pnlFromSingleSignalEvents,
    pnlFromMultiSignalEvents: c.pnlFromMultiSignalEvents,
  };
}

function onePerEventTradeoff(model: ModelDecomposition): OnePerEventTradeoff {
  const d = model.onePerEventComparison.deltas;
  return {
    variantId: model.variantId,
    deltaObservations: d.observations,
    deltaPnl: d.flatUnitPnl,
    deltaRoi: d.flatUnitRoi,
    deltaMaxDrawdown: d.maximumDrawdownUnits,
    deltaLongestLosingStreak: d.longestLosingStreak,
    deltaMaxSignalsPerEvent: d.maximumSignalsPerWorkingEvent,
    // A lower total PnL after one-per-event is never an automatic rejection
    // when the risk profile (drawdown) improves -- this flag surfaces that
    // trade-off explicitly instead of collapsing it to a single verdict.
    riskImprovesDespiteLowerPnl: d.maximumDrawdownUnits < 0 && (d.flatUnitPnl ?? 0) < 0,
  };
}

function drawdownComparisonEntry(model: ModelDecomposition): DrawdownComparisonEntry {
  const dd = model.maxDrawdownInterval;
  return {
    variantId: model.variantId,
    drawdownUnits: dd?.drawdownUnits ?? 0,
    intervalRowCount: dd?.intervalRowCount ?? 0,
    topNegativeContributors: dd?.topNegativeContributors ?? [],
  };
}

function losingStreakComparisonEntry(model: ModelDecomposition): LosingStreakComparisonEntry {
  const s = model.longestLosingStreak;
  return {
    variantId: model.variantId,
    length: s?.length ?? 0,
    cumulativePnlUnits: s?.cumulativePnlUnits ?? 0,
    startResolvedAt: s?.startResolvedAt ?? null,
    endResolvedAt: s?.endResolvedAt ?? null,
    sampleWarning: (s?.length ?? 0) > 0 && (s?.length ?? 0) < 5,
  };
}

// ---- cross-model evidence ----

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Deterministic cross-model evidence. Only "broad" models
 * (selectedObservations >= BROAD_MODEL_MIN_OBSERVATIONS) contribute; within
 * each broad model, only buckets with observations >= SEGMENT_ELIGIBLE_MIN_
 * OBSERVATIONS are eligible. A dimension/bucket becomes an evidence entry
 * only when at least MIN_ELIGIBLE_BROAD_MODELS broad models have it
 * eligible. Reuses extractEvidencePool's exact mirror exclusion (implied
 * odds is never counted as independent evidence from price).
 */
export function computeCrossModelEvidence(models: readonly ModelDecomposition[]): CrossModelEvidenceEntry[] {
  const broadModels = models.filter((m) => m.selectedObservations >= BROAD_MODEL_MIN_OBSERVATIONS);

  const byKey = new Map<
    string,
    { dimension: string; bucket: string; entries: Array<{ variantId: string; m: DecompositionSegmentMetrics }> }
  >();

  for (const model of broadModels) {
    const pool = extractEvidencePool(model);
    for (const { dim, bucket, m } of pool) {
      if (m.observations < SEGMENT_ELIGIBLE_MIN_OBSERVATIONS) continue;
      const key = `${dim}::${bucket}`;
      const existing = byKey.get(key) ?? { dimension: dim, bucket, entries: [] };
      existing.entries.push({ variantId: model.variantId, m });
      byKey.set(key, existing);
    }
  }

  const results: CrossModelEvidenceEntry[] = [];
  for (const { dimension, bucket, entries } of byKey.values()) {
    if (entries.length < MIN_ELIGIBLE_BROAD_MODELS) continue;
    const eligibleModelCount = entries.length;
    const positiveModelCount = entries.filter((e) => (e.m.flatUnitPnl ?? 0) > 0).length;
    const negativeModelCount = entries.filter((e) => (e.m.flatUnitPnl ?? 0) < 0).length;
    const totalPnl = entries.reduce((s, e) => s + (e.m.flatUnitPnl ?? 0), 0);
    const medianRoi = median(entries.map((e) => e.m.flatUnitRoi).filter((v): v is number => v !== null));
    const ns = entries.map((e) => e.m.observations);
    const positiveRatio = positiveModelCount / eligibleModelCount;
    const negativeRatio = negativeModelCount / eligibleModelCount;

    let classification: EvidenceClassification = "MIXED";
    if (positiveRatio >= CONSISTENT_RATIO_THRESHOLD && totalPnl > 0) classification = "CONSISTENT_POSITIVE";
    else if (negativeRatio >= CONSISTENT_RATIO_THRESHOLD && totalPnl < 0) classification = "CONSISTENT_NEGATIVE";

    results.push({
      dimension,
      bucket,
      eligibleModelCount,
      positiveModelCount,
      negativeModelCount,
      totalPnl,
      medianRoi,
      minimumN: Math.min(...ns),
      maximumN: Math.max(...ns),
      supportRatio: classification === "CONSISTENT_NEGATIVE" ? negativeRatio : positiveRatio,
      classification,
      eligibleModelIds: entries.map((e) => e.variantId).sort(),
    });
  }

  return results.sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}

const DIRECTION_KIND_BY_DIMENSION: Record<string, { positive: ResearchDirectionKind; negative: ResearchDirectionKind }> = {
  priceBands: { positive: "TEST_INCLUSION", negative: "TEST_PRICE_GATE" },
  scoreBands: { positive: "TEST_SCORE_INTERACTION", negative: "TEST_SCORE_INTERACTION" },
  timingBuckets: { positive: "TEST_TIMING_GATE", negative: "TEST_TIMING_GATE" },
  coverageBands: { positive: "TEST_INCLUSION", negative: "TEST_EXCLUSION" },
  formulaVersions: { positive: "TEST_INCLUSION", negative: "TEST_EXCLUSION" },
  metricFormulaVersions: { positive: "TEST_INCLUSION", negative: "TEST_EXCLUSION" },
};

/**
 * Evidence statements only -- never a model/candidate definition. Derived
 * purely from computeCrossModelEvidence's CONSISTENT_POSITIVE/NEGATIVE
 * entries, plus a concentration-tradeoff review whenever one-per-event
 * improves risk (lower drawdown) even where total PnL is lower.
 */
function buildNextResearchDirections(evidence: readonly CrossModelEvidenceEntry[], tradeoffs: readonly OnePerEventTradeoff[]): ResearchDirection[] {
  const directions: ResearchDirection[] = [];
  for (const e of evidence) {
    if (e.classification === "MIXED") continue;
    const kinds = DIRECTION_KIND_BY_DIMENSION[e.dimension];
    if (!kinds) continue;
    const kind = e.classification === "CONSISTENT_POSITIVE" ? kinds.positive : kinds.negative;
    directions.push({
      kind,
      dimension: e.dimension,
      bucket: e.bucket,
      supportingModels: e.classification === "CONSISTENT_POSITIVE" ? e.eligibleModelIds.filter((id) => true) : [],
      opposingModels: [],
      sampleRange: { minimumN: e.minimumN, maximumN: e.maximumN },
      totalPnl: e.totalPnl,
      medianRoi: e.medianRoi,
      reason:
        e.classification === "CONSISTENT_POSITIVE"
          ? `${e.eligibleModelCount} broad models agree this segment is profitable (support ${(e.supportRatio * 100).toFixed(0)}%).`
          : `${e.eligibleModelCount} broad models agree this segment is unprofitable (support ${(e.supportRatio * 100).toFixed(0)}%).`,
    });
  }

  for (const t of tradeoffs) {
    if (t.riskImprovesDespiteLowerPnl) {
      directions.push({
        kind: "REVIEW_CONCENTRATION_TRADEOFF",
        dimension: "eventConcentration",
        bucket: t.variantId,
        supportingModels: [t.variantId],
        opposingModels: [],
        sampleRange: { minimumN: 0, maximumN: 0 },
        totalPnl: t.deltaPnl ?? 0,
        medianRoi: t.deltaRoi,
        reason:
          "One-per-event lowers total PnL but also lowers maximum drawdown for this model -- a risk/volume trade-off worth reviewing, not an automatic rejection.",
      });
    }
  }

  return directions.sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}

// ---- limitations ----

function buildLimitations(availability: readonly DimensionAvailability[]): string[] {
  return availability
    .filter((d) => d.status === "MISSING_SOURCE_FIELD" || d.status === "UNTRUSTED_SEMANTICS")
    .map((d) => `${d.dimension}: ${d.status} -- ${d.notes}`)
    .sort();
}

// ---- full builder ----

/**
 * Builds the dashboard entirely from the already-computed A1 decomposition.
 * Verifies the source contentHash before doing anything else (fails closed
 * on a tampered/corrupted input). Pure: no fs/env/network, no recomputation
 * of ROI/dedup/equity/grouping. Never mutates the source object.
 */
export function buildExtendedHistoricalDashboard(options: DashboardOptions): ExtendedHistoricalDashboard {
  const { decomposition } = options;
  validate(decomposition);

  const models = decomposition.models;
  const modelSummaries = models.map(summarize);
  const evidence = computeCrossModelEvidence(models);
  const tradeoffs = models.map(onePerEventTradeoff);
  const directions = buildNextResearchDirections(evidence, tradeoffs);

  const withoutHash: Omit<ExtendedHistoricalDashboard, "contentHash"> = {
    schemaVersion: 1,
    engineVersion: DASHBOARD_ENGINE_VERSION,
    sourceDecompositionHash: decomposition.contentHash,
    corpusSummary: {
      rawRowCount: decomposition.rawRowCount,
      strictDedupRowCount: decomposition.strictDedupRowCount,
      modelCount: models.length,
      inputSha256: decomposition.inputSha256,
      classifierSha256: decomposition.classifierSha256,
    },
    modelSummaries,
    frontierData: buildFrontier(modelSummaries),
    dimensionHeatmaps: {
      score: buildHeatmap(models, "scoreBands", "score"),
      price: buildHeatmap(models, "priceBands", "price"),
      coverage: buildHeatmap(models, "coverageBands", "coverage"),
      timing: buildHeatmap(models, "timingBuckets", "timing"),
    },
    eventConcentration: models.map(eventConcentrationSummary),
    onePerEventTradeoffs: tradeoffs,
    drawdownComparison: models.map(drawdownComparisonEntry),
    losingStreakComparison: models.map(losingStreakComparisonEntry),
    crossModelEvidence: evidence,
    nextResearchDirections: directions,
    dataAvailability: decomposition.corpusDimensionAvailability,
    limitations: buildLimitations(decomposition.corpusDimensionAvailability),
  };

  const contentHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  return { ...withoutHash, contentHash };
}

/** Deterministic pretty JSON with exactly one trailing newline. */
export function serializeExtendedDashboardJson(dashboard: ExtendedHistoricalDashboard): string {
  return `${JSON.stringify(dashboard, null, 2)}\n`;
}

// ---- HTML rendering ----

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
function shortLabel(id: string): string {
  return id.replace(/_/g, " ").slice(0, 16);
}

const SVG_W = 640;
const SVG_H = 260;
const PAD_L = 50;
const PAD_R = 20;
const PAD_T = 26;
const PAD_B = 60;

function scatterSvg(id: string, title: string, desc: string, xLabel: string, yLabel: string, points: FrontierPoint[]): string {
  const xs = points.map((p) => p.x ?? 0);
  const ys = points.map((p) => p.y ?? 0);
  const sizes = points.map((p) => p.size);
  const maxX = Math.max(0, ...xs);
  const minX = Math.min(0, ...xs);
  const maxY = Math.max(0, ...ys);
  const minY = Math.min(0, ...ys);
  const maxSize = Math.max(1, ...sizes);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const plotW = SVG_W - PAD_L - PAD_R;
  const plotH = SVG_H - PAD_T - PAD_B;
  const palette = ["#33608f", "#2f7d5b", "#a3423a", "#7a5c9e", "#b7791f", "#4c8c8c", "#8c5a4c", "#556b2f", "#993d6b", "#3f6f3f", "#6b4f8f", "#8f6b3f"];

  const legend = points
    .map(
      (p, i) =>
        `<div class="legend-item"><span class="dot" style="background:${palette[i % palette.length]}"></span>${i + 1}. ${escapeHtml(shortLabel(p.variantId))}</div>`,
    )
    .join("");

  const dots = points
    .map((p, i) => {
      const px = p.x ?? 0;
      const py = p.y ?? 0;
      const cx = PAD_L + ((px - minX) / spanX) * plotW;
      const cy = PAD_T + plotH - ((py - minY) / spanY) * plotH;
      const r = 4 + (p.size / maxSize) * 10;
      const color = palette[i % palette.length];
      return (
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.75" stroke="${color}"><title>${escapeHtml(p.variantId)}: x=${fmt(p.x)}, y=${fmt(p.y)}, N=${fmtInt(p.size)}</title></circle>` +
        `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="8" text-anchor="middle" dy="3" fill="#fff">${i + 1}</text>`
      );
    })
    .join("");

  return (
    `<figure><svg viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-labelledby="${id}-title ${id}-desc" class="chart" id="${id}">` +
    `<title id="${id}-title">${escapeHtml(title)}</title><desc id="${id}-desc">${escapeHtml(desc)}</desc>` +
    `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${(PAD_T + plotH).toFixed(1)}" stroke="#999"/>` +
    `<line x1="${PAD_L}" y1="${(PAD_T + plotH).toFixed(1)}" x2="${SVG_W - PAD_R}" y2="${(PAD_T + plotH).toFixed(1)}" stroke="#999"/>` +
    `<text x="${PAD_L}" y="${SVG_H - 6}" font-size="9" fill="#444">${escapeHtml(xLabel)}</text>` +
    `<text x="4" y="${PAD_T - 6}" font-size="9" fill="#444">${escapeHtml(yLabel)}</text>` +
    dots +
    `</svg><figcaption class="legend">${legend}</figcaption></figure>`
  );
}

function barsSvg(id: string, title: string, desc: string, entries: Array<{ label: string; value: number }>): string {
  const values = entries.map((e) => e.value);
  const maxV = Math.max(0, ...values, 0.001);
  const plotW = SVG_W - PAD_L - PAD_R;
  const rowH = Math.max(16, Math.floor((SVG_H - PAD_T - 10) / Math.max(1, entries.length)));
  const height = PAD_T + entries.length * rowH + 10;

  const bars = entries
    .map((e, i) => {
      const y = PAD_T + i * rowH;
      const w = (e.value / maxV) * plotW;
      return (
        `<rect x="${PAD_L}" y="${(y + 2).toFixed(1)}" width="${w.toFixed(1)}" height="${rowH - 4}" fill="#33608f"><title>${escapeHtml(e.label)}: ${fmt(e.value)}</title></rect>` +
        `<text x="4" y="${(y + rowH / 2 + 3).toFixed(1)}" font-size="9" fill="#333">${escapeHtml(shortLabel(e.label))}</text>` +
        `<text x="${(PAD_L + w + 4).toFixed(1)}" y="${(y + rowH / 2 + 3).toFixed(1)}" font-size="9" fill="#222">${fmt(e.value)}</text>`
      );
    })
    .join("");

  return (
    `<figure><svg viewBox="0 0 ${SVG_W} ${height}" role="img" aria-labelledby="${id}-title ${id}-desc" class="chart" id="${id}">` +
    `<title id="${id}-title">${escapeHtml(title)}</title><desc id="${id}-desc">${escapeHtml(desc)}</desc>${bars}</svg></figure>`
  );
}

function heatmapSvg(id: string, title: string, desc: string, heatmap: DimensionHeatmap, models: string[], metric: "flatUnitPnl" | "flatUnitRoi"): string {
  const cols = heatmap.buckets;
  const rows = models;
  const cellW = Math.min(70, (SVG_W - PAD_L - PAD_R) / Math.max(1, cols.length));
  const cellH = 20;
  const height = PAD_T + rows.length * cellH + 20;
  const values = heatmap.cells.map((c) => c[metric] ?? 0);
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));

  const cellFor = (variantId: string, bucket: string) => heatmap.cells.find((c) => c.variantId === variantId && c.bucket === bucket);

  const cells: string[] = [];
  rows.forEach((variantId, ri) => {
    cols.forEach((bucket, ci) => {
      const cell = cellFor(variantId, bucket);
      const x = PAD_L + ci * cellW;
      const y = PAD_T + ri * cellH;
      if (!cell) {
        cells.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW - 1}" height="${cellH - 1}" fill="#eee"/>`);
        return;
      }
      const v = cell[metric] ?? 0;
      const intensity = Math.min(1, Math.abs(v) / maxAbs);
      const color = v >= 0 ? `rgba(47,125,91,${0.15 + intensity * 0.7})` : `rgba(163,66,58,${0.15 + intensity * 0.7})`;
      cells.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW - 1}" height="${cellH - 1}" fill="${color}"><title>${escapeHtml(variantId)} / ${escapeHtml(bucket)}: ${fmt(v)} (N=${fmtInt(cell.observations)})</title></rect>`,
      );
    });
    cells.push(`<text x="4" y="${(PAD_T + ri * cellH + cellH / 2 + 3).toFixed(1)}" font-size="8" fill="#333">${escapeHtml(shortLabel(variantId))}</text>`);
  });
  const colLabels = cols
    .map((bucket, ci) => `<text x="${(PAD_L + ci * cellW + 2).toFixed(1)}" y="${(PAD_T - 4).toFixed(1)}" font-size="7" fill="#444">${escapeHtml(bucket.slice(0, 10))}</text>`)
    .join("");

  return (
    `<figure><svg viewBox="0 0 ${SVG_W} ${height}" role="img" aria-labelledby="${id}-title ${id}-desc" class="chart" id="${id}">` +
    `<title id="${id}-title">${escapeHtml(title)}</title><desc id="${id}-desc">${escapeHtml(desc)}</desc>${colLabels}${cells.join("")}</svg></figure>`
  );
}

function heatmapFallbackTable(heatmap: DimensionHeatmap): string {
  const rows = heatmap.cells
    .map((c) => `<tr><td>${escapeHtml(c.variantId)}</td><td>${escapeHtml(c.bucket)}</td><td>${fmtInt(c.observations)}</td><td>${fmt(c.flatUnitPnl)}</td><td>${fmt(c.flatUnitRoi)}</td></tr>`)
    .join("");
  return `<table class="chart-fallback"><thead><tr><th>Model</th><th>Bucket</th><th>N</th><th>PnL</th><th>ROI%</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:0 0 40px;color:#1a1a1a;background:#fafafa}
.wrap{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:12px 0}
h2{font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:26px}
h3{font-size:13px;margin:14px 0 4px}
.banner{background:#1f2d3d;color:#fff;padding:10px 14px;border-radius:6px;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:10px}
.card{background:#fff;border:1px solid #ddd;border-radius:6px;padding:8px 10px}
.card .value{font-size:18px;font-weight:700}
.card .label{font-size:11px;color:#666}
.toc{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:6px 10px;font-size:12px;z-index:5;overflow-x:auto;white-space:nowrap}
.toc a{margin-right:10px;color:#1f2d3d;text-decoration:none}
.chart{width:100%;height:auto;background:#fff;border:1px solid #eee;border-radius:6px}
figure{margin:8px 0}
.legend{display:flex;flex-wrap:wrap;gap:6px;font-size:10px;margin-top:4px}
.legend-item{display:flex;align-items:center;gap:3px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
table{border-collapse:collapse;width:100%;font-size:11px;margin-top:6px}
th,td{border:1px solid #ddd;padding:2px 5px;text-align:right}
th:first-child,td:first-child{text-align:left}
.chart-fallback{max-height:220px;overflow:auto;display:block}
.missing-tag{background:#a3423a;color:#fff;border-radius:3px;padding:1px 6px;font-size:11px;margin:2px}
.muted{color:#666}
.warn-tag{color:#a3423a;font-weight:600}
@media (max-width:480px){.wrap{padding:8px}.cards{grid-template-columns:repeat(2,1fr)}}
@media print{body{background:#fff}.toc{position:static}.chart{break-inside:avoid}}
`;

function corpusCards(d: ExtendedHistoricalDashboard): string {
  const cs = d.corpusSummary;
  const card = (label: string, value: string) => `<div class="card"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
  return (
    `<div class="cards">` +
    card("Raw rows", fmtInt(cs.rawRowCount)) +
    card("Strict-dedup rows", fmtInt(cs.strictDedupRowCount)) +
    card("Models analyzed", fmtInt(cs.modelCount)) +
    card("Corpus hash", `${cs.inputSha256.slice(0, 12)}…`) +
    `</div>`
  );
}

function findingsList(d: ExtendedHistoricalDashboard): string {
  const top = [...d.crossModelEvidence]
    .filter((e) => e.classification !== "MIXED")
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    .slice(0, 5);
  if (top.length === 0) return `<p class="muted">No cross-model evidence reached the minimum-3-broad-models threshold yet.</p>`;
  const items = top
    .map(
      (e) =>
        `<li><strong>${escapeHtml(e.classification)}</strong>: ${escapeHtml(e.dimension)} / ${escapeHtml(e.bucket)} — total PnL ${fmt(e.totalPnl)}u across ${fmtInt(e.eligibleModelCount)} broad models (support ${fmt(e.supportRatio * 100, 0)}%)</li>`,
    )
    .join("");
  return `<ol>${items}</ol>`;
}

function missingDimensionsBlock(d: ExtendedHistoricalDashboard): string {
  const missing = d.dataAvailability.filter((a) => a.status === "MISSING_SOURCE_FIELD");
  return missing.map((a) => `<span class="missing-tag">${escapeHtml(a.dimension)}</span>`).join(" ");
}

function modelDetailSection(d: ExtendedHistoricalDashboard): string {
  const rows = d.modelSummaries
    .map(
      (m) =>
        `<tr><td>${escapeHtml(m.variantId)}</td><td>${fmtInt(m.selectedObservations)}</td><td>${fmt(m.flatUnitPnl)}</td><td>${fmt(m.flatUnitRoi)}</td><td>${fmt(m.maximumDrawdownUnits)}</td><td>${fmtInt(m.longestLosingStreak)}</td></tr>`,
    )
    .join("");
  return `<section id="model-detail"><h2>3b. All-model summary table</h2><table><thead><tr><th>Model</th><th>N</th><th>PnL</th><th>ROI%</th><th>MaxDD</th><th>Streak</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function eventConcentrationSection(d: ExtendedHistoricalDashboard): string {
  const rows = d.eventConcentration
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.variantId)}</td><td>${fmtInt(c.selectedObservations)}</td><td>${fmtInt(c.workingEventGroups)}</td><td>${fmtInt(c.maximumSignalsPerWorkingEvent)}</td><td>${fmtInt(c.eventsWith1Signal)}/${fmtInt(c.eventsWith2Signals)}/${fmtInt(c.eventsWith3Signals)}/${fmtInt(c.eventsWith4Signals)}/${fmtInt(c.eventsWith5PlusSignals)}</td><td>${fmt(c.pnlFromSingleSignalEvents)} / ${fmt(c.pnlFromMultiSignalEvents)}</td></tr>`,
    )
    .join("");
  return (
    `<section id="concentration"><h2>8. Concentration dashboard</h2>` +
    barsSvg("chart-concentration", "Max signals per event by model", "Bar chart of maximum signals per working event group for each model.", d.modelSummaries.map((m) => ({ label: m.variantId, value: m.maximumSignalsPerWorkingEvent }))) +
    `<table class="chart-fallback"><thead><tr><th>Model</th><th>N</th><th>Events</th><th>Max/Ev</th><th>1/2/3/4/5+</th><th>PnL single/multi</th></tr></thead><tbody>${rows}</tbody></table></section>`
  );
}

function onePerEventSection(d: ExtendedHistoricalDashboard): string {
  const rows = d.onePerEventTradeoffs
    .map(
      (t) =>
        `<tr class="${t.riskImprovesDespiteLowerPnl ? "warn-sample" : ""}"><td>${escapeHtml(t.variantId)}</td><td>${fmtInt(t.deltaObservations)}</td><td>${fmt(t.deltaPnl)}</td><td>${fmt(t.deltaRoi)}</td><td>${fmt(t.deltaMaxDrawdown)}</td><td>${fmtInt(t.deltaLongestLosingStreak)}</td><td>${fmtInt(t.deltaMaxSignalsPerEvent)}</td>${t.riskImprovesDespiteLowerPnl ? '<td class="warn-tag">risk↓ despite PnL↓ — not an automatic rejection</td>' : "<td></td>"}</tr>`,
    )
    .join("");
  return `<section id="one-per-event"><h2>9. One-per-event trade-off (analysis only)</h2><table><thead><tr><th>Model</th><th>ΔN</th><th>ΔPnL</th><th>ΔROI</th><th>ΔMaxDD</th><th>ΔStreak</th><th>ΔMaxSig/Ev</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function drawdownSection(d: ExtendedHistoricalDashboard): string {
  const bars = barsSvg(
    "chart-drawdown",
    "Maximum drawdown by model",
    "Horizontal bar chart of maximum drawdown units for each model.",
    d.drawdownComparison.map((e) => ({ label: e.variantId, value: e.drawdownUnits })),
  );
  const rows = d.drawdownComparison
    .map((e) => {
      const contribs = e.topNegativeContributors.slice(0, 3).map((c) => `${escapeHtml(c.dimension)}/${escapeHtml(c.bucket)}(${fmt(c.pnlUnits)})`).join(", ");
      return `<tr><td>${escapeHtml(e.variantId)}</td><td>${fmt(e.drawdownUnits)}</td><td>${fmtInt(e.intervalRowCount)}</td><td class="muted">${contribs || "—"}</td></tr>`;
    })
    .join("");
  return (
    `<section id="drawdown"><h2>10. Drawdown comparison</h2>${bars}<p class="muted">Descriptive attribution only — no causal claim.</p>` +
    `<table class="chart-fallback"><thead><tr><th>Model</th><th>MaxDD</th><th>Interval N</th><th>Top negative contributors</th></tr></thead><tbody>${rows}</tbody></table></section>`
  );
}

function streakSection(d: ExtendedHistoricalDashboard): string {
  const rows = d.losingStreakComparison
    .map(
      (e) =>
        `<tr class="${e.sampleWarning ? "warn-sample" : ""}"><td>${escapeHtml(e.variantId)}</td><td>${fmtInt(e.length)}</td><td>${fmt(e.cumulativePnlUnits)}</td><td>${escapeHtml(e.startResolvedAt ?? "—")} → ${escapeHtml(e.endResolvedAt ?? "—")}</td></tr>`,
    )
    .join("");
  return `<section id="streak"><h2>11. Longest losing-streak comparison</h2><table><thead><tr><th>Model</th><th>Length</th><th>Cumulative PnL</th><th>Interval</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function availabilitySection(d: ExtendedHistoricalDashboard): string {
  const rows = d.dataAvailability
    .map((a) => `<tr class="${a.status === "MISSING_SOURCE_FIELD" ? "warn-sample" : ""}"><td>${escapeHtml(a.dimension)}</td><td>${escapeHtml(a.status)}</td><td>${fmt(a.coveragePct, 1)}%</td><td class="muted">${escapeHtml(a.notes)}</td></tr>`)
    .join("");
  return (
    `<section id="availability"><h2>12. Data availability</h2><p>${missingDimensionsBlock(d)}</p>` +
    `<table><thead><tr><th>Dimension</th><th>Status</th><th>Coverage</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></section>`
  );
}

function evidenceSection(d: ExtendedHistoricalDashboard): string {
  const rows = d.crossModelEvidence
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.dimension)}</td><td>${escapeHtml(e.bucket)}</td><td>${fmtInt(e.eligibleModelCount)}</td><td>${fmtInt(e.positiveModelCount)}/${fmtInt(e.negativeModelCount)}</td><td>${fmt(e.totalPnl)}</td><td>${fmt(e.medianRoi)}</td><td>${escapeHtml(e.classification)}</td></tr>`,
    )
    .join("");
  return `<section id="evidence"><h2>13. Cross-model evidence</h2><table><thead><tr><th>Dimension</th><th>Bucket</th><th>Eligible</th><th>+/-</th><th>Total PnL</th><th>Median ROI</th><th>Class</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">none reached the minimum-3-broad-models threshold</td></tr>'}</tbody></table></section>`;
}

function directionsSection(d: ExtendedHistoricalDashboard): string {
  const items = d.nextResearchDirections
    .map(
      (r) =>
        `<li><strong>${escapeHtml(r.kind)}</strong>: ${escapeHtml(r.dimension)} / ${escapeHtml(r.bucket)} — ${escapeHtml(r.reason)} (N ${fmtInt(r.sampleRange.minimumN)}–${fmtInt(r.sampleRange.maximumN)}, total PnL ${fmt(r.totalPnl)}u, median ROI ${fmt(r.medianRoi)}%)</li>`,
    )
    .join("");
  return `<section id="directions"><h2>14. Next research directions (evidence statements only, no candidate creation)</h2><ul>${items || '<li class="muted">none</li>'}</ul></section>`;
}

/**
 * Renders the full self-contained dashboard HTML: inline CSS, inline SVG
 * charts with title/desc, table fallback under every chart, responsive down
 * to 390px, print stylesheet, sticky compact TOC. Never embeds raw corpus
 * rows or absolute file paths.
 */
export function renderExtendedHistoricalDashboardHtml(d: ExtendedHistoricalDashboard): string {
  const modelIds = d.modelSummaries.map((m) => m.variantId);

  const frontierSection =
    `<section id="model-frontier"><h2>2. Model frontier (ROI vs PnL)</h2>` +
    scatterSvg("chart-frontier-roi", "ROI vs PnL frontier", "Scatter plot of flat-unit ROI against flat-unit PnL for all analyzed models; bubble size is selected observations.", "ROI %", "PnL units", d.frontierData.roiPnl) +
    `<table class="chart-fallback"><thead><tr><th>Model</th><th>ROI%</th><th>PnL</th><th>N</th></tr></thead><tbody>${d.frontierData.roiPnl.map((p) => `<tr><td>${escapeHtml(p.variantId)}</td><td>${fmt(p.x)}</td><td>${fmt(p.y)}</td><td>${fmtInt(p.size)}</td></tr>`).join("")}</tbody></table>` +
    `<h3>3. Return vs risk frontier (drawdown vs PnL)</h3>` +
    scatterSvg("chart-frontier-dd", "Drawdown vs PnL frontier", "Scatter plot of maximum drawdown units against flat-unit PnL; lower drawdown is to the left; bubble size is selected observations.", "Max drawdown units", "PnL units", d.frontierData.drawdownPnl) +
    `<table class="chart-fallback"><thead><tr><th>Model</th><th>MaxDD</th><th>PnL</th><th>N</th></tr></thead><tbody>${d.frontierData.drawdownPnl.map((p) => `<tr><td>${escapeHtml(p.variantId)}</td><td>${fmt(p.x)}</td><td>${fmt(p.y)}</td><td>${fmtInt(p.size)}</td></tr>`).join("")}</tbody></table>` +
    `</section>`;

  const heatmapSection = (title: string, id: string, hm: DimensionHeatmap, showN: boolean) =>
    `<section id="${id}"><h2>${escapeHtml(title)}</h2>` +
    `<h3>ROI</h3>${heatmapSvg(`${id}-roi`, `${title} ROI heatmap`, `Models by ${hm.dimension} bucket, cell color intensity is flat-unit ROI.`, hm, modelIds, "flatUnitRoi")}` +
    `<h3>PnL</h3>${heatmapSvg(`${id}-pnl`, `${title} PnL heatmap`, `Models by ${hm.dimension} bucket, cell color intensity is flat-unit PnL.`, hm, modelIds, "flatUnitPnl")}` +
    (showN ? `<p class="muted">Implied odds are shown here only as a derived label of the price bucket, never as an independent chart.</p>` : "") +
    heatmapFallbackTable(hm) +
    `</section>`;

  const findingsSection = `<section id="findings"><h2>4. Five most important cross-model findings</h2>${findingsList(d)}</section>`;
  const limitationsSection = `<section id="limitations-top"><h2>5. Data limitations</h2><p>${missingDimensionsBlock(d)}</p></section>`;

  const toc =
    `<nav class="toc">` +
    ["model-frontier", "score", "price", "coverage", "timing", "concentration", "one-per-event", "drawdown", "streak", "availability", "evidence", "directions", "model-detail"]
      .map((id) => `<a href="#${id}">${id}</a>`)
      .join("") +
    `</nav>`;

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Extended Historical Dashboard</title><style>${CSS}</style></head><body>` +
    toc +
    `<div class="wrap">` +
    `<h1>Extended Historical Decomposition Dashboard</h1>` +
    `<div class="banner">HISTORICAL RESEARCH ONLY &middot; NO AUTOMATIC CHAMPION &middot; NO MODEL PROMOTION</div>` +
    `<section id="corpus"><h2>1. Executive summary</h2>${corpusCards(d)}</section>` +
    frontierSection +
    findingsSection +
    limitationsSection +
    heatmapSection("5. Score-band heatmap", "score", d.dimensionHeatmaps.score, false) +
    heatmapSection("6. Entry-price heatmap", "price", d.dimensionHeatmaps.price, true) +
    heatmapSection("7. Coverage heatmap", "coverage", d.dimensionHeatmaps.coverage, false) +
    heatmapSection("7b. Timing heatmap", "timing", d.dimensionHeatmaps.timing, false) +
    eventConcentrationSection(d) +
    onePerEventSection(d) +
    drawdownSection(d) +
    streakSection(d) +
    availabilitySection(d) +
    evidenceSection(d) +
    directionsSection(d) +
    modelDetailSection(d) +
    `<footer class="muted"><small>engine ${escapeHtml(d.engineVersion)} · content ${escapeHtml(d.contentHash)}</small></footer>` +
    `</div></body></html>\n`
  );
}

// ---- manifest ----

export interface ExtendedDashboardManifest {
  schemaVersion: 1;
  sourceDecompositionSha256: string;
  sourceDecompositionContentHash: string;
  dashboardJsonSha256: string;
  dashboardHtmlSha256: string;
  artifactSha256s: Record<string, string>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Provenance manifest only -- no timestamp, absolute path, env value, duration, or git identity. */
export function buildExtendedDashboardManifest(
  dashboard: ExtendedHistoricalDashboard,
  sourceDecompositionJson: string,
  dashboardJson: string,
  dashboardHtml: string,
): ExtendedDashboardManifest {
  return {
    schemaVersion: 1,
    sourceDecompositionSha256: sha256(sourceDecompositionJson),
    sourceDecompositionContentHash: dashboard.sourceDecompositionHash,
    dashboardJsonSha256: sha256(dashboardJson),
    dashboardHtmlSha256: sha256(dashboardHtml),
    artifactSha256s: {
      "extended_historical_dashboard.json": sha256(dashboardJson),
      "extended_historical_dashboard.html": sha256(dashboardHtml),
    },
  };
}
