// Persisted Score-Component, Fine-Timing and Interaction Analysis Engine
// (Phase 4B.1 / B1).
//
// One deterministic, reusable analysis of the canonical historical corpus
// that answers which persisted score components, price corridors, coverage
// levels and FINE timing sub-windows explain profitable and toxic historical
// segments. It splits the broad 0-3h decomposition bucket into actionable
// 0-30m / 30-60m / 1-2h / 2-3h sub-windows, adds cumulative 30m/1h/2h/3h
// entry gates, deduplicates identical selected-row cohorts so each votes
// once, and reconstructs the persisted portion of the executable score
// formula -- explicitly leaving the missing historical inputs (oddsFit,
// momentum, liquidity) as MISSING rather than fabricating them.
//
// Reuse only -- no new business math: strict dedup
// (generatedSignalPairsDedupPolicy), variant selection
// (evaluateHistoricalFunnelVariant), ROI/PnL + equity/drawdown/streak
// (computeSegmentMetrics -> roiPnlContract + computeFlatUnitEquityMetrics),
// timing/score/price/coverage band adapters (extendedHistoricalDecomposition
// + historicalFunnelVariants), formula weights (executable_funnel_classifier).
// Pure: no fs/env/network/Supabase, no forward/post-cutoff rows, no mutation
// of input. HISTORICAL RESEARCH ONLY -- never generates or promotes a model.

import { createHash } from "node:crypto";
import {
  projectGeneratedSignalPairsStrictDedup,
  STRICT_DEDUP_POLICY_NAME,
} from "./generatedSignalPairsDedupPolicy";
import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";
import { computeRowReturnPct } from "./roiPnlContract";
import {
  evaluateHistoricalFunnelVariant,
  getScoreValue,
  getCoverageValue,
  getSmartMoneyValue,
  getHoursUntilStartValue,
} from "./historicalFunnelVariants";
import {
  computeSegmentMetrics,
  sampleClassOf,
  scoreBandOf,
  priceBandOf,
  coverageBandOf,
  PRICE_BANDS,
  SCORE_BANDS,
  COVERAGE_BANDS,
  type DecompositionSegmentMetrics,
} from "./extendedHistoricalDecomposition";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";

type Row = ExportRow;

export const SCORE_COMPONENT_ANALYSIS_ENGINE_VERSION = "4B.1-score-component-analysis-v1" as const;
export const SCORE_COMPONENT_ANALYSIS_SCHEMA_VERSION = 1 as const;

// Minimum valid pairs for a correlation to be reported as anything other than
// INSUFFICIENT, and the minimum cell N for strong-evidence eligibility.
export const CORRELATION_MIN_PAIRS = 30 as const;
export const STRONG_EVIDENCE_MIN_N = 30 as const;

// The executable formula whose persisted portion is reconstructed here.
const TARGET_METRIC_FORMULA_VERSION = "v2-lite-growth-safe";

// ---------------------------------------------------------------- contracts

export const FINE_TIMING_BUCKETS = [
  "ALREADY_STARTED_OR_INVALID",
  "T_0_TO_30M",
  "T_30_TO_60M",
  "T_60_TO_120M",
  "T_120_TO_180M",
  "T_3_TO_6H",
  "T_6_TO_12H",
  "T_12_TO_24H",
  "T_24_TO_48H",
  "T_48H_PLUS",
  "UNKNOWN_START_TIME",
] as const;
export type FineTimingBucket = (typeof FINE_TIMING_BUCKETS)[number];

export const CUMULATIVE_TIMING_GATES = ["WITHIN_30M", "WITHIN_60M", "WITHIN_120M", "WITHIN_180M"] as const;
export type CumulativeTimingGate = (typeof CUMULATIVE_TIMING_GATES)[number];

export const COMPONENT_VALUE_BANDS = [
  "BELOW_25",
  "VALUE_25_TO_49_99",
  "VALUE_50_TO_64_99",
  "VALUE_65_TO_74_99",
  "VALUE_75_TO_84_99",
  "VALUE_85_TO_100",
  "MISSING_OR_INVALID",
] as const;
export type ComponentValueBand = (typeof COMPONENT_VALUE_BANDS)[number];

export const PERSISTED_COMPONENT_KEYS = [
  "finalScore",
  "smartMoney",
  "whalePublic",
  "preEvent",
  "coverage",
  "entryPrice",
] as const;
export type PersistedComponentKey = (typeof PERSISTED_COMPONENT_KEYS)[number];

/**
 * Human-readable interpretation of the three named historical price
 * corridors. These are CALCULATED market-price labels (implied probability /
 * derived decimal odds), never executed sportsbook odds.
 */
export const PRICE_CORRIDOR_LABELS: Readonly<Record<string, string>> = {
  PRICE_BELOW_0_30: "implied probability below 30% (calculated decimal odds above 3.33)",
  PRICE_0_30_TO_0_43: "implied probability 30-43% (calculated decimal odds approximately 3.33-2.33)",
  PRICE_0_44_TO_0_58: "implied probability 44-58% (calculated decimal odds approximately 2.27-1.72)",
  PRICE_0_59_TO_0_74: "implied probability 59-74% (calculated decimal odds approximately 1.69-1.35)",
  PRICE_0_75_PLUS: "implied probability 75%+ (calculated decimal odds 1.33 or less)",
};

// ------------------------------------------------------------ field adapters

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whale/public persisted component -- exact exported top-level field. */
export function getWhalePublicValue(row: Row): number | null {
  return finiteNumber(row.whale_public_score_num);
}

/** Pre-event persisted component -- exact exported top-level field. */
export function getPreEventValue(row: Row): number | null {
  return finiteNumber(row.pre_event_score_num);
}

/** Entry price component (0 < p <= 1); preserved raw for calculation. */
export function getEntryPriceValue(row: Row): number | null {
  const v = finiteNumber(row.entry_price_num);
  return v !== null && v > 0 && v <= 1 ? v : null;
}

interface PersistedComponentSpec {
  key: PersistedComponentKey;
  label: string;
  physicalSource: string;
  role: string;
  rangeContract: "ZERO_TO_100" | "ZERO_TO_ONE_PRICE";
  formulaWeight: number | null;
  get: (row: Row) => number | null;
}

const COMPONENT_SPECS: readonly PersistedComponentSpec[] = [
  {
    key: "finalScore",
    label: "final score / signal confidence",
    physicalSource: "signal_confidence_num -> score -> signal_score -> pre_event_score_num (canonical getScoreValue chain)",
    role: "FORMULA_OUTPUT",
    rangeContract: "ZERO_TO_100",
    formulaWeight: null,
    get: getScoreValue,
  },
  {
    key: "smartMoney",
    label: "smart money score",
    physicalSource: "smart_money_score_num (top-level)",
    role: "DIRECT_FORMULA_COMPONENT",
    rangeContract: "ZERO_TO_100",
    formulaWeight: 0.25,
    get: getSmartMoneyValue,
  },
  {
    key: "whalePublic",
    label: "whale/public score",
    physicalSource: "whale_public_score_num (top-level)",
    role: "DIRECT_FORMULA_COMPONENT",
    rangeContract: "ZERO_TO_100",
    formulaWeight: 0.15,
    get: getWhalePublicValue,
  },
  {
    key: "preEvent",
    label: "pre-event score",
    physicalSource: "pre_event_score_num (top-level)",
    role: "DIRECT_FORMULA_COMPONENT",
    rangeContract: "ZERO_TO_100",
    formulaWeight: 0.2,
    get: getPreEventValue,
  },
  {
    key: "coverage",
    label: "data coverage",
    physicalSource: "diagnostics.dataCoverage (canonical getCoverageValue)",
    role: "DIRECT_FORMULA_COMPONENT_PLUS_NESTED",
    rangeContract: "ZERO_TO_100",
    formulaWeight: 0.05,
    get: getCoverageValue,
  },
  {
    key: "entryPrice",
    label: "entry price (market-implied)",
    physicalSource: "entry_price_num (top-level)",
    role: "PRICE_INTERACTION_NOT_SCORE_COMPONENT",
    rangeContract: "ZERO_TO_ONE_PRICE",
    formulaWeight: null,
    get: getEntryPriceValue,
  },
];

// ------------------------------------------------------------- bucket funcs

/**
 * Fine timing sub-window from the canonical (gameStartIso - created_at)
 * adapter -- never substitutes resolved_at. Lower bounds are inclusive at 0
 * (matching the cumulative gates); strictly negative hours are already
 * started/invalid, an absent/unparseable start time is unknown.
 */
export function fineTimingBucketOf(row: Row): FineTimingBucket {
  const h = getHoursUntilStartValue(row);
  if (h === null) return "UNKNOWN_START_TIME";
  if (h < 0) return "ALREADY_STARTED_OR_INVALID";
  if (h < 0.5) return "T_0_TO_30M";
  if (h < 1) return "T_30_TO_60M";
  if (h < 2) return "T_60_TO_120M";
  if (h < 3) return "T_120_TO_180M";
  if (h < 6) return "T_3_TO_6H";
  if (h < 12) return "T_6_TO_12H";
  if (h < 24) return "T_12_TO_24H";
  if (h < 48) return "T_24_TO_48H";
  return "T_48H_PLUS";
}

const GATE_UPPER: Readonly<Record<CumulativeTimingGate, number>> = {
  WITHIN_30M: 0.5,
  WITHIN_60M: 1,
  WITHIN_120M: 2,
  WITHIN_180M: 3,
};

/** Cumulative entry gate membership: 0 <= hours < upper bound. */
export function isWithinCumulativeGate(hours: number | null, gate: CumulativeTimingGate): boolean {
  if (hours === null || hours < 0) return false;
  return hours < GATE_UPPER[gate];
}

/** 0-100 component value band; missing/out-of-range is MISSING_OR_INVALID. */
export function componentValueBandOf(value: number | null): ComponentValueBand {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) return "MISSING_OR_INVALID";
  if (value < 25) return "BELOW_25";
  if (value < 50) return "VALUE_25_TO_49_99";
  if (value < 65) return "VALUE_50_TO_64_99";
  if (value < 75) return "VALUE_65_TO_74_99";
  if (value < 85) return "VALUE_75_TO_84_99";
  return "VALUE_85_TO_100";
}

/** Strong-evidence eligibility gate: N >= 30. */
export function isStrongEvidence(n: number): boolean {
  return n >= STRONG_EVIDENCE_MIN_N;
}

export type CorrelationSampleClass = "SUFFICIENT" | "INSUFFICIENT";
export function classifyCorrelationSample(validPairs: number): CorrelationSampleClass {
  return validPairs >= CORRELATION_MIN_PAIRS ? "SUFFICIENT" : "INSUFFICIENT";
}

// ----------------------------------------------------------- statistics

/** Average-rank assignment for ties (stable, deterministic). */
export function rankAverageTies(values: readonly number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => (a.v === b.v ? a.i - b.i : a.v - b.v));
  const ranks = new Array<number>(values.length);
  let k = 0;
  while (k < indexed.length) {
    let j = k;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[k].v) j++;
    const avgRank = (k + j) / 2 + 1; // 1-based average rank
    for (let m = k; m <= j; m++) ranks[indexed[m].i] = avgRank;
    k = j + 1;
  }
  return ranks;
}

/** Pearson correlation; null for <2 pairs or zero variance in either axis. */
export function pearsonCorrelation(pairs: readonly [number, number][]): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx;
    const dy = y - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/** Spearman rank correlation (average ranks for ties). */
export function spearmanCorrelation(pairs: readonly [number, number][]): number | null {
  if (pairs.length < 2) return null;
  const rx = rankAverageTies(pairs.map((p) => p[0]));
  const ry = rankAverageTies(pairs.map((p) => p[1]));
  return pearsonCorrelation(rx.map((r, i) => [r, ry[i]] as [number, number]));
}

// --------------------------------------------------- selection-hash cohorts

/** Strict observation identity for a selected row (id, then dedup key). */
function observationIdOf(row: Row): string {
  const id = row.id;
  if (typeof id === "string" && id.trim() !== "") return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  const key = getStrictDedupKeyForExportRow(row);
  return key ?? `__anon__${JSON.stringify(row)}`;
}

/** Permutation-independent hash of an ordered selected-observation-id set. */
export function computeSelectionHash(observationIds: readonly string[]): string {
  const sorted = [...observationIds].sort();
  return createHash("sha256").update(sorted.join(" ")).digest("hex");
}

// ---------------------------------------------------------- number helpers

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function round6(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

// --------------------------------------------------------------- result types

export interface FormulaInputContract {
  field: string;
  weight: number | null;
  persisted: boolean;
}

export interface ScoreComponentFormulaContract {
  formulaModelId: string;
  metricFormulaVersion: string;
  rawExpression: string;
  persistedInputs: FormulaInputContract[];
  missingInputs: FormulaInputContract[];
}

export interface ComponentAvailability {
  key: PersistedComponentKey;
  label: string;
  physicalSource: string;
  role: string;
  rangeContract: string;
  formulaWeight: number | null;
  coverageRows: number;
  coverageRate: number | null;
  observedMin: number | null;
  observedMax: number | null;
  blocked: boolean;
}

export interface BucketMetricEntry<K extends string = string> {
  bucket: K;
  metrics: DecompositionSegmentMetrics;
}

export interface GateMetricEntry {
  gate: CumulativeTimingGate;
  metrics: DecompositionSegmentMetrics;
}

export interface UniqueCohort {
  cohortId: string;
  selectionHash: string;
  canonicalVariantId: string;
  aliasVariantIds: string[];
  selectedObservations: number;
}

export interface ComponentBandAnalysis {
  component: PersistedComponentKey;
  bands: Array<{ band: string; metrics: DecompositionSegmentMetrics }>;
}

export interface ComponentOutcomeCorrelation {
  component: PersistedComponentKey;
  pearsonReturn: number | null;
  spearmanReturn: number | null;
  pearsonWin: number | null;
  spearmanWin: number | null;
  validReturnPairs: number;
  validWinPairs: number;
  classification: CorrelationSampleClass;
}

export interface RedundancyCell {
  componentA: PersistedComponentKey;
  componentB: PersistedComponentKey;
  pearson: number | null;
  spearman: number | null;
  validPairCount: number;
  flag: "HIGH_REDUNDANCY" | "NONE";
}

export interface PersistedContributionAnalysis {
  coveredRows: number;
  medianPersistedContribution: number | null;
  medianObservedScore: number | null;
  medianRemainder: number | null;
  remainderP10: number | null;
  remainderP90: number | null;
  sourceProvableClampCapCount: number;
  verdict: "EXACT_HISTORICAL_RECOMPUTATION_READY" | "PARTIAL_RECONSTRUCTION_ONLY" | "BLOCKED_MISSING_HISTORICAL_COMPONENTS";
}

export interface InteractionGrid {
  id: string;
  rowDimension: string;
  colDimension: string;
  cells: Array<{
    row: string;
    col: string;
    metrics: { observations: number; flatUnitPnl: number | null; flatUnitRoi: number | null; maximumDrawdownUnits: number; sampleClass: string };
    strongEvidenceEligible: boolean;
  }>;
}

export type MonotonicityClass = "MONOTONIC_POSITIVE" | "MONOTONIC_NEGATIVE" | "NON_MONOTONIC" | "INSUFFICIENT";

export interface MonotonicityEntry {
  component: PersistedComponentKey;
  classification: MonotonicityClass;
  eligibleBands: number;
}

export interface B2EvidenceDirection {
  type:
    | "TEST_COMPONENT_REWEIGHT"
    | "TEST_COMPONENT_GUARD"
    | "TEST_COMPONENT_INTERACTION"
    | "TEST_PRICE_AWARE_SCORING"
    | "TEST_TIMING_AWARE_ROUTING"
    | "TEST_FINE_TIMING_GATE"
    | "TEST_SPORT_ROUTING"
    | "TEST_MARKET_FAMILY_ROUTING"
    | "CAPTURE_MISSING_COMPONENT";
  componentOrInteraction: string;
  uniqueSupportingCohorts: number;
  aliasModelsExcludedFromVote: string[];
  sampleRange: { minN: number; maxN: number };
  totalPnl: number | null;
  medianRoi: number | null;
  redundancyWarning: string | null;
  dataLimitation: string | null;
  reason: string;
}

export interface ScoreComponentAnalysisResult {
  schemaVersion: typeof SCORE_COMPONENT_ANALYSIS_SCHEMA_VERSION;
  engineVersion: typeof SCORE_COMPONENT_ANALYSIS_ENGINE_VERSION;
  corpusSummary: {
    rawRowCount: number;
    strictDedupRowCount: number;
    droppedDuplicateRows: number;
    strictDedupPolicy: string;
    requestedVariantIds: string[];
  };
  formulaContract: ScoreComponentFormulaContract;
  formulaFeasibility: PersistedContributionAnalysis["verdict"];
  componentAvailability: ComponentAvailability[];
  uniqueCohorts: UniqueCohort[];
  componentBandAnalysis: ComponentBandAnalysis[];
  fineTimingAnalysis: {
    fullCorpus: BucketMetricEntry<FineTimingBucket>[];
    cohorts: Array<{ cohortId: string; canonicalVariantId: string; buckets: BucketMetricEntry<FineTimingBucket>[] }>;
  };
  cumulativeTimingGateAnalysis: {
    fullCorpus: GateMetricEntry[];
    cohorts: Array<{ cohortId: string; canonicalVariantId: string; gates: GateMetricEntry[] }>;
  };
  componentOutcomeCorrelations: ComponentOutcomeCorrelation[];
  componentRedundancyMatrix: RedundancyCell[];
  persistedContributionAnalysis: PersistedContributionAnalysis;
  interactionAnalysis: InteractionGrid[];
  monotonicityAnalysis: MonotonicityEntry[];
  b2EvidenceDirections: B2EvidenceDirection[];
  limitations: string[];
  contentHash: string;
}

// ---------------------------------------------------------------- build

function buildFormulaContract(classifier: ExecutableFunnelClassifier): {
  contract: ScoreComponentFormulaContract;
  clampCapCount: number;
} {
  const model = classifier.formulaModels.find((m) => m.metricFormulaVersion === TARGET_METRIC_FORMULA_VERSION);
  if (!model) {
    throw new Error(`score component analysis: formula model for ${TARGET_METRIC_FORMULA_VERSION} not found in classifier`);
  }
  const PERSISTED_FORMULA_FIELDS = new Set([
    "smart_money_score_num",
    "whale_public_score_num",
    "pre_event_score_num",
    "dataCoverage",
  ]);

  // The final signal step (signalV2Raw) drives the persisted reconstruction;
  // its contributions are the direct component weights. Any contribution
  // whose input is not a persisted field -- plus any input feeding the
  // intermediate preEventVal step that is not persisted -- is a MISSING
  // historical input (never fabricated).
  const finalStep = model.calculationSteps.find((s) => s.output === "signalV2Raw");
  const rawExpression = finalStep?.expression ?? model.calculationSteps.map((s) => s.expression).join(" ; ");

  const persistedInputs: FormulaInputContract[] = [];
  const missingFields = new Map<string, number | null>();

  for (const step of model.calculationSteps) {
    for (const c of step.contributions) {
      if (PERSISTED_FORMULA_FIELDS.has(c.input)) {
        if (step.output === "signalV2Raw") {
          persistedInputs.push({ field: c.input, weight: c.weight, persisted: true });
        }
      } else if (c.input !== "signalV2Raw") {
        // record the first (largest-context) weight seen for a missing field
        if (!missingFields.has(c.input)) missingFields.set(c.input, c.weight);
      }
    }
  }

  const missingInputs: FormulaInputContract[] = [...missingFields.entries()]
    .map(([field, weight]) => ({ field, weight, persisted: false }))
    .sort((a, b) => a.field.localeCompare(b.field));

  return {
    contract: {
      formulaModelId: model.formulaModelId,
      metricFormulaVersion: model.metricFormulaVersion,
      rawExpression,
      persistedInputs,
      missingInputs,
    },
    clampCapCount: model.capsAndFloors.length,
  };
}

function groupMetrics<K extends string>(
  rows: readonly Row[],
  order: readonly K[],
  bucketOf: (row: Row) => K,
): BucketMetricEntry<K>[] {
  const groups = new Map<K, Row[]>();
  for (const row of rows) {
    const b = bucketOf(row);
    const arr = groups.get(b);
    if (arr) arr.push(row);
    else groups.set(b, [row]);
  }
  return order
    .filter((b) => groups.has(b))
    .map((b) => ({ bucket: b, metrics: computeSegmentMetrics(groups.get(b) ?? []) }));
}

function buildGateEntries(rows: readonly Row[]): GateMetricEntry[] {
  return CUMULATIVE_TIMING_GATES.map((gate) => {
    const inGate = rows.filter((r) => isWithinCumulativeGate(getHoursUntilStartValue(r), gate));
    return { gate, metrics: computeSegmentMetrics(inGate) };
  });
}

function bandOrderFor(component: PersistedComponentKey): readonly string[] {
  if (component === "entryPrice") return PRICE_BANDS;
  if (component === "finalScore") return [...COMPONENT_VALUE_BANDS];
  return [...COMPONENT_VALUE_BANDS];
}

function bandOfComponent(spec: PersistedComponentSpec, row: Row): string {
  if (spec.key === "entryPrice") return priceBandOf(row);
  return componentValueBandOf(spec.get(row));
}

function buildInteractionGrid(
  id: string,
  rowDimension: string,
  colDimension: string,
  rows: readonly Row[],
  rowOrder: readonly string[],
  colOrder: readonly string[],
  rowOf: (row: Row) => string,
  colOf: (row: Row) => string,
): InteractionGrid {
  const cellMap = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${rowOf(row)} ${colOf(row)}`;
    const arr = cellMap.get(key);
    if (arr) arr.push(row);
    else cellMap.set(key, [row]);
  }
  const cells: InteractionGrid["cells"] = [];
  for (const r of rowOrder) {
    for (const c of colOrder) {
      const key = `${r} ${c}`;
      const bucket = cellMap.get(key);
      if (!bucket || bucket.length === 0) continue;
      const m = computeSegmentMetrics(bucket);
      cells.push({
        row: r,
        col: c,
        metrics: {
          observations: m.observations,
          flatUnitPnl: round6(m.flatUnitPnl),
          flatUnitRoi: round6(m.flatUnitRoi),
          maximumDrawdownUnits: round6(m.maximumDrawdownUnits) ?? 0,
          sampleClass: m.sampleClass,
        },
        strongEvidenceEligible: isStrongEvidence(m.observations),
      });
    }
  }
  return { id, rowDimension, colDimension, cells };
}

function classifyMonotonicity(
  rows: readonly Row[],
  spec: PersistedComponentSpec,
): MonotonicityEntry {
  const order = bandOrderFor(spec.key).filter((b) => b !== "MISSING_OR_INVALID");
  const eligible: Array<{ roi: number; pnl: number }> = [];
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const b = bandOfComponent(spec, row);
    const arr = groups.get(b);
    if (arr) arr.push(row);
    else groups.set(b, [row]);
  }
  for (const band of order) {
    const bucket = groups.get(band);
    if (!bucket || bucket.length < STRONG_EVIDENCE_MIN_N) continue;
    const m = computeSegmentMetrics(bucket);
    if (m.flatUnitRoi === null || m.flatUnitPnl === null) continue;
    eligible.push({ roi: m.flatUnitRoi, pnl: m.flatUnitPnl });
  }
  if (eligible.length < 3) return { component: spec.key, classification: "INSUFFICIENT", eligibleBands: eligible.length };

  const roiDir = trendDirection(eligible.map((e) => e.roi));
  const pnlDir = trendDirection(eligible.map((e) => e.pnl));
  if (roiDir === 0 || pnlDir === 0 || roiDir !== pnlDir) {
    return { component: spec.key, classification: "NON_MONOTONIC", eligibleBands: eligible.length };
  }
  return {
    component: spec.key,
    classification: roiDir > 0 ? "MONOTONIC_POSITIVE" : "MONOTONIC_NEGATIVE",
    eligibleBands: eligible.length,
  };
}

/** +1 strictly increasing, -1 strictly decreasing, 0 otherwise. */
function trendDirection(values: readonly number[]): number {
  let inc = true;
  let dec = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) inc = false;
    if (values[i] >= values[i - 1]) dec = false;
  }
  return inc ? 1 : dec ? -1 : 0;
}

function collectPairs(
  rows: readonly Row[],
  xOf: (row: Row) => number | null,
  yOf: (row: Row) => number | null,
): [number, number][] {
  const pairs: [number, number][] = [];
  for (const row of rows) {
    const x = xOf(row);
    const y = yOf(row);
    if (x === null || y === null) continue;
    pairs.push([x, y]);
  }
  return pairs;
}

// Realized return / win indicator via the canonical row-return contract.
function realizedReturnOf(row: Row): number | null {
  return computeRowReturnPct(row).returnPct;
}
function winIndicatorOf(row: Row): number | null {
  const label = computeRowReturnPct(row).label;
  if (label === "win") return 1;
  if (label === "loss") return 0;
  return null;
}

export interface ScoreComponentAnalysisInput {
  rawRows: readonly Row[];
  classifier: ExecutableFunnelClassifier;
  requestedVariantIds: readonly string[];
}

export function buildScoreComponentAnalysis(input: ScoreComponentAnalysisInput): ScoreComponentAnalysisResult {
  const { rawRows, classifier, requestedVariantIds } = input;
  const limitations: string[] = [];

  // 1. Canonical strict dedup -> the 1,850-style deduped corpus.
  const dedup = projectGeneratedSignalPairsStrictDedup([...rawRows]);
  const rows = dedup.dedupedRows;

  // 2. Formula contract + feasibility.
  const { contract, clampCapCount } = buildFormulaContract(classifier);
  const verdict: PersistedContributionAnalysis["verdict"] =
    contract.missingInputs.length > 0 ? "BLOCKED_MISSING_HISTORICAL_COMPONENTS" : "EXACT_HISTORICAL_RECOMPUTATION_READY";

  // 3. Component availability.
  const componentAvailability: ComponentAvailability[] = COMPONENT_SPECS.map((spec) => {
    const values: number[] = [];
    for (const row of rows) {
      const v = spec.get(row);
      if (v !== null) values.push(v);
    }
    return {
      key: spec.key,
      label: spec.label,
      physicalSource: spec.physicalSource,
      role: spec.role,
      rangeContract: spec.rangeContract,
      formulaWeight: spec.formulaWeight,
      coverageRows: values.length,
      coverageRate: rows.length > 0 ? round6(values.length / rows.length) : null,
      observedMin: values.length > 0 ? round6(Math.min(...values)) : null,
      observedMax: values.length > 0 ? round6(Math.max(...values)) : null,
      blocked: values.length === 0,
    };
  });

  // 4. Unique selected-row cohorts (each exact cohort votes once).
  const hashToVariants = new Map<string, { variants: string[]; observations: number }>();
  for (const variantId of requestedVariantIds) {
    let selected: Row[];
    try {
      selected = evaluateHistoricalFunnelVariant(rows, classifier, variantId).selectedRows;
    } catch (error) {
      limitations.push(`variant_not_executable:${variantId}:${error instanceof Error ? error.message : "unknown"}`);
      continue;
    }
    const ids = selected.map(observationIdOf);
    const hash = computeSelectionHash(ids);
    const existing = hashToVariants.get(hash);
    if (existing) existing.variants.push(variantId);
    else hashToVariants.set(hash, { variants: [variantId], observations: selected.length });
  }
  const canonicalOrder = new Map(requestedVariantIds.map((v, i) => [v, i]));
  const uniqueCohorts: UniqueCohort[] = [...hashToVariants.entries()]
    .map(([selectionHash, { variants, observations }]) => {
      const ordered = [...variants].sort(
        (a, b) => (canonicalOrder.get(a) ?? 0) - (canonicalOrder.get(b) ?? 0) || a.localeCompare(b),
      );
      return {
        cohortId: `COHORT_${selectionHash.slice(0, 12)}`,
        selectionHash,
        canonicalVariantId: ordered[0],
        aliasVariantIds: ordered.slice(1),
        selectedObservations: observations,
      };
    })
    .sort((a, b) => a.canonicalVariantId.localeCompare(b.canonicalVariantId));

  // Selected-row set per canonical cohort (for per-cohort timing analysis).
  const cohortRows = new Map<string, Row[]>();
  for (const cohort of uniqueCohorts) {
    const selected = evaluateHistoricalFunnelVariant(rows, classifier, cohort.canonicalVariantId).selectedRows;
    cohortRows.set(cohort.cohortId, selected);
  }

  // 5. Component band analysis.
  const componentBandAnalysis: ComponentBandAnalysis[] = COMPONENT_SPECS.map((spec) => {
    const order = bandOrderFor(spec.key);
    const bands = groupMetrics(rows, order, (row) => bandOfComponent(spec, row)).map((e) => ({
      band: e.bucket,
      metrics: e.metrics,
    }));
    return { component: spec.key, bands };
  });

  // 6. Fine timing + cumulative gates (full corpus + per cohort).
  const fineFull = groupMetrics(rows, FINE_TIMING_BUCKETS, fineTimingBucketOf);
  const gateFull = buildGateEntries(rows);
  const fineCohorts = uniqueCohorts.map((c) => ({
    cohortId: c.cohortId,
    canonicalVariantId: c.canonicalVariantId,
    buckets: groupMetrics(cohortRows.get(c.cohortId) ?? [], FINE_TIMING_BUCKETS, fineTimingBucketOf),
  }));
  const gateCohorts = uniqueCohorts.map((c) => ({
    cohortId: c.cohortId,
    canonicalVariantId: c.canonicalVariantId,
    gates: buildGateEntries(cohortRows.get(c.cohortId) ?? []),
  }));

  // 7. Correlations with realized return / win indicator.
  const componentOutcomeCorrelations: ComponentOutcomeCorrelation[] = COMPONENT_SPECS.map((spec) => {
    const returnPairs = collectPairs(rows, spec.get, realizedReturnOf);
    const winPairs = collectPairs(rows, spec.get, winIndicatorOf);
    return {
      component: spec.key,
      pearsonReturn: round6(pearsonCorrelation(returnPairs)),
      spearmanReturn: round6(spearmanCorrelation(returnPairs)),
      pearsonWin: round6(pearsonCorrelation(winPairs)),
      spearmanWin: round6(spearmanCorrelation(winPairs)),
      validReturnPairs: returnPairs.length,
      validWinPairs: winPairs.length,
      classification: classifyCorrelationSample(Math.min(returnPairs.length, winPairs.length)),
    };
  });

  // 8. Redundancy matrix (persisted component pairs).
  const componentRedundancyMatrix: RedundancyCell[] = [];
  for (let i = 0; i < COMPONENT_SPECS.length; i++) {
    for (let j = i + 1; j < COMPONENT_SPECS.length; j++) {
      const a = COMPONENT_SPECS[i];
      const b = COMPONENT_SPECS[j];
      const pairs = collectPairs(rows, a.get, b.get);
      const spearman = spearmanCorrelation(pairs);
      const flag = spearman !== null && Math.abs(spearman) >= 0.85 && pairs.length >= 100 ? "HIGH_REDUNDANCY" : "NONE";
      componentRedundancyMatrix.push({
        componentA: a.key,
        componentB: b.key,
        pearson: round6(pearsonCorrelation(pairs)),
        spearman: round6(spearman),
        validPairCount: pairs.length,
        flag,
      });
    }
  }

  // 9. Persisted formula-contribution reconstruction.
  const persistedContributionAnalysis = buildContributionAnalysis(rows, clampCapCount, verdict);

  // 10. Required interaction grids (exactly eight).
  const priceOrder = PRICE_BANDS;
  const scoreOrder = SCORE_BANDS;
  const coverageOrder = COVERAGE_BANDS;
  const valueOrder = [...COMPONENT_VALUE_BANDS];
  const fineOrder = FINE_TIMING_BUCKETS;
  const smSpec = COMPONENT_SPECS.find((s) => s.key === "smartMoney")!;
  const whaleSpec = COMPONENT_SPECS.find((s) => s.key === "whalePublic")!;
  const preSpec = COMPONENT_SPECS.find((s) => s.key === "preEvent")!;

  const interactionAnalysis: InteractionGrid[] = [
    buildInteractionGrid("scoreBand_x_priceBand", "scoreBand", "priceBand", rows, scoreOrder, priceOrder, scoreBandOf, priceBandOf),
    buildInteractionGrid("fineTiming_x_priceBand", "fineTimingBucket", "priceBand", rows, fineOrder, priceOrder, fineTimingBucketOf, priceBandOf),
    buildInteractionGrid("fineTiming_x_scoreBand", "fineTimingBucket", "scoreBand", rows, fineOrder, scoreOrder, fineTimingBucketOf, scoreBandOf),
    buildInteractionGrid("fineTiming_x_coverageBand", "fineTimingBucket", "coverageBand", rows, fineOrder, coverageOrder, fineTimingBucketOf, coverageBandOf),
    buildInteractionGrid("coverageBand_x_priceBand", "coverageBand", "priceBand", rows, coverageOrder, priceOrder, coverageBandOf, priceBandOf),
    buildInteractionGrid("preEventBand_x_priceBand", "preEventBand", "priceBand", rows, valueOrder, priceOrder, (r) => componentValueBandOf(preSpec.get(r)), priceBandOf),
    buildInteractionGrid("smartMoneyBand_x_priceBand", "smartMoneyBand", "priceBand", rows, valueOrder, priceOrder, (r) => componentValueBandOf(smSpec.get(r)), priceBandOf),
    buildInteractionGrid("whalePublicBand_x_priceBand", "whalePublicBand", "priceBand", rows, valueOrder, priceOrder, (r) => componentValueBandOf(whaleSpec.get(r)), priceBandOf),
  ];

  // 11. Monotonicity per persisted component.
  const monotonicityAnalysis: MonotonicityEntry[] = COMPONENT_SPECS.map((spec) => classifyMonotonicity(rows, spec));

  // 12. B2 evidence directions (<= 10, derived from computed evidence).
  const b2EvidenceDirections = buildB2Directions({
    interactionAnalysis,
    monotonicityAnalysis,
    componentRedundancyMatrix,
    componentOutcomeCorrelations,
    contract,
    uniqueCohorts,
    fineFull,
    gateFull,
  });

  if (dedup.hasDuplicateStrictKeyRisk) {
    limitations.push(`strict_dedup_dropped_duplicates:${dedup.droppedDuplicateRows}`);
  }
  limitations.push(
    "missing_historical_inputs_not_fabricated:" + contract.missingInputs.map((m) => m.field).join(","),
  );
  limitations.push("no_p_values_no_causality_descriptive_only");
  limitations.push("research_only_no_model_promotion");

  const result: Omit<ScoreComponentAnalysisResult, "contentHash"> = {
    schemaVersion: SCORE_COMPONENT_ANALYSIS_SCHEMA_VERSION,
    engineVersion: SCORE_COMPONENT_ANALYSIS_ENGINE_VERSION,
    corpusSummary: {
      rawRowCount: rawRows.length,
      strictDedupRowCount: rows.length,
      droppedDuplicateRows: dedup.droppedDuplicateRows,
      strictDedupPolicy: STRICT_DEDUP_POLICY_NAME,
      requestedVariantIds: [...requestedVariantIds],
    },
    formulaContract: contract,
    formulaFeasibility: verdict,
    componentAvailability,
    uniqueCohorts,
    componentBandAnalysis,
    fineTimingAnalysis: { fullCorpus: fineFull, cohorts: fineCohorts },
    cumulativeTimingGateAnalysis: { fullCorpus: gateFull, cohorts: gateCohorts },
    componentOutcomeCorrelations,
    componentRedundancyMatrix,
    persistedContributionAnalysis,
    interactionAnalysis,
    monotonicityAnalysis,
    b2EvidenceDirections,
    limitations,
  };

  const contentHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  return { ...result, contentHash };
}

function buildContributionAnalysis(
  rows: readonly Row[],
  clampCapCount: number,
  verdict: PersistedContributionAnalysis["verdict"],
): PersistedContributionAnalysis {
  const contributions: number[] = [];
  const observed: number[] = [];
  const remainders: number[] = [];
  for (const row of rows) {
    const sm = getSmartMoneyValue(row);
    const whale = getWhalePublicValue(row);
    const pre = getPreEventValue(row);
    const cov = getCoverageValue(row);
    const finalScore = getScoreValue(row);
    if (sm === null || whale === null || pre === null || cov === null || finalScore === null) continue;
    const contribution = 0.25 * sm + 0.15 * whale + 0.2 * pre + 0.05 * cov;
    contributions.push(contribution);
    observed.push(finalScore);
    remainders.push(finalScore - contribution);
  }
  return {
    coveredRows: contributions.length,
    medianPersistedContribution: round6(median(contributions)),
    medianObservedScore: round6(median(observed)),
    medianRemainder: round6(median(remainders)),
    remainderP10: round6(percentile(remainders, 10)),
    remainderP90: round6(percentile(remainders, 90)),
    sourceProvableClampCapCount: clampCapCount,
    verdict,
  };
}

interface B2Context {
  interactionAnalysis: InteractionGrid[];
  monotonicityAnalysis: MonotonicityEntry[];
  componentRedundancyMatrix: RedundancyCell[];
  componentOutcomeCorrelations: ComponentOutcomeCorrelation[];
  contract: ScoreComponentFormulaContract;
  uniqueCohorts: UniqueCohort[];
  fineFull: BucketMetricEntry<FineTimingBucket>[];
  gateFull: GateMetricEntry[];
}

function buildB2Directions(ctx: B2Context): B2EvidenceDirection[] {
  const directions: B2EvidenceDirection[] = [];
  const cohortCount = ctx.uniqueCohorts.length;
  const aliasModels = ctx.uniqueCohorts.flatMap((c) => c.aliasVariantIds);

  // (a) Monotonic components -> reweight candidates.
  for (const mono of ctx.monotonicityAnalysis) {
    if (mono.classification === "MONOTONIC_POSITIVE" || mono.classification === "MONOTONIC_NEGATIVE") {
      directions.push({
        type: "TEST_COMPONENT_REWEIGHT",
        componentOrInteraction: mono.component,
        uniqueSupportingCohorts: cohortCount,
        aliasModelsExcludedFromVote: aliasModels,
        sampleRange: { minN: STRONG_EVIDENCE_MIN_N, maxN: mono.eligibleBands * STRONG_EVIDENCE_MIN_N },
        totalPnl: null,
        medianRoi: null,
        redundancyWarning: null,
        dataLimitation: null,
        reason: `${mono.component} shows ${mono.classification} ROI/PnL across ${mono.eligibleBands} eligible bands`,
      });
    }
  }

  // (b) High-redundancy pairs -> guard (with warning).
  for (const cell of ctx.componentRedundancyMatrix) {
    if (cell.flag === "HIGH_REDUNDANCY") {
      directions.push({
        type: "TEST_COMPONENT_GUARD",
        componentOrInteraction: `${cell.componentA}+${cell.componentB}`,
        uniqueSupportingCohorts: cohortCount,
        aliasModelsExcludedFromVote: aliasModels,
        sampleRange: { minN: cell.validPairCount, maxN: cell.validPairCount },
        totalPnl: null,
        medianRoi: null,
        redundancyWarning: `spearman=${cell.spearman} over N=${cell.validPairCount}`,
        dataLimitation: null,
        reason: `${cell.componentA} and ${cell.componentB} are highly redundant; guard rather than double-weight`,
      });
    }
  }

  // (c) Strongest profitable / toxic interaction cell -> interaction test.
  const strongCells: Array<{ grid: InteractionGrid; cell: InteractionGrid["cells"][number] }> = [];
  for (const grid of ctx.interactionAnalysis) {
    for (const cell of grid.cells) {
      if (cell.strongEvidenceEligible && cell.metrics.flatUnitRoi !== null) strongCells.push({ grid, cell });
    }
  }
  strongCells.sort((a, b) => Math.abs(b.cell.metrics.flatUnitRoi ?? 0) - Math.abs(a.cell.metrics.flatUnitRoi ?? 0));
  for (const { grid, cell } of strongCells.slice(0, 3)) {
    const type: B2EvidenceDirection["type"] = grid.id.startsWith("fineTiming")
      ? "TEST_FINE_TIMING_GATE"
      : grid.colDimension === "priceBand"
        ? "TEST_PRICE_AWARE_SCORING"
        : "TEST_COMPONENT_INTERACTION";
    directions.push({
      type,
      componentOrInteraction: `${grid.id}:${cell.row}x${cell.col}`,
      uniqueSupportingCohorts: cohortCount,
      aliasModelsExcludedFromVote: aliasModels,
      sampleRange: { minN: cell.metrics.observations, maxN: cell.metrics.observations },
      totalPnl: cell.metrics.flatUnitPnl,
      medianRoi: cell.metrics.flatUnitRoi,
      redundancyWarning: null,
      dataLimitation: null,
      reason: `${grid.id} cell ${cell.row}x${cell.col} (N=${cell.metrics.observations}) shows ROI ${cell.metrics.flatUnitRoi}`,
    });
  }

  // (d) Best cumulative fine-timing gate -> fine timing gate test.
  const eligibleGates = ctx.gateFull.filter((g) => isStrongEvidence(g.metrics.observations) && g.metrics.flatUnitRoi !== null);
  eligibleGates.sort((a, b) => (b.metrics.flatUnitRoi ?? 0) - (a.metrics.flatUnitRoi ?? 0));
  if (eligibleGates.length > 0) {
    const g = eligibleGates[0];
    directions.push({
      type: "TEST_TIMING_AWARE_ROUTING",
      componentOrInteraction: g.gate,
      uniqueSupportingCohorts: cohortCount,
      aliasModelsExcludedFromVote: aliasModels,
      sampleRange: { minN: g.metrics.observations, maxN: g.metrics.observations },
      totalPnl: g.metrics.flatUnitPnl,
      medianRoi: g.metrics.flatUnitRoi,
      redundancyWarning: null,
      dataLimitation: null,
      reason: `cumulative gate ${g.gate} (N=${g.metrics.observations}) shows ROI ${g.metrics.flatUnitRoi}`,
    });
  }

  // (e) Missing historical inputs -> capture direction (always last).
  if (ctx.contract.missingInputs.length > 0) {
    directions.push({
      type: "CAPTURE_MISSING_COMPONENT",
      componentOrInteraction: ctx.contract.missingInputs.map((m) => m.field).join("+"),
      uniqueSupportingCohorts: cohortCount,
      aliasModelsExcludedFromVote: aliasModels,
      sampleRange: { minN: 0, maxN: 0 },
      totalPnl: null,
      medianRoi: null,
      redundancyWarning: null,
      dataLimitation: `missing persisted inputs block exact recomputation: ${ctx.contract.missingInputs.map((m) => m.field).join(", ")}`,
      reason: "persisting the missing formula inputs would enable exact historical score recomputation",
    });
  }

  return directions.slice(0, 10);
}

// ------------------------------------------------------------- serializers

export function serializeScoreComponentAnalysisJson(result: ScoreComponentAnalysisResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export interface ScoreComponentAnalysisManifest {
  schemaVersion: number;
  engineVersion: string;
  generatedArtifact: string;
  contentHash: string;
  jsonSha256: string;
  htmlSha256: string;
  rawRowCount: number;
  strictDedupRowCount: number;
  cohortCount: number;
  b2DirectionCount: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildScoreComponentAnalysisManifest(
  result: ScoreComponentAnalysisResult,
  jsonString: string,
  htmlString: string,
): ScoreComponentAnalysisManifest {
  return {
    schemaVersion: result.schemaVersion,
    engineVersion: result.engineVersion,
    generatedArtifact: "score_component_analysis",
    contentHash: result.contentHash,
    jsonSha256: sha256(jsonString),
    htmlSha256: sha256(htmlString),
    rawRowCount: result.corpusSummary.rawRowCount,
    strictDedupRowCount: result.corpusSummary.strictDedupRowCount,
    cohortCount: result.uniqueCohorts.length,
    b2DirectionCount: result.b2EvidenceDirections.length,
  };
}

// ---------------------------------------------------------------- HTML

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(value: number | null): string {
  return value === null ? "--" : String(value);
}

function metricsRow(label: string, m: DecompositionSegmentMetrics): string {
  return `<tr><td>${esc(label)}</td><td>${m.observations}</td><td>${m.wins}</td><td>${m.losses}</td><td>${num(round6(m.flatUnitPnl))}</td><td>${num(round6(m.flatUnitRoi))}</td><td>${num(round6(m.maximumDrawdownUnits))}</td><td>${m.longestLosingStreak}</td><td>${m.workingEventGroups}</td><td>${m.maximumSignalsPerWorkingEvent}</td><td>${m.sampleClass}</td></tr>`;
}

const METRIC_HEADER =
  "<tr><th>segment</th><th>N</th><th>wins</th><th>losses</th><th>PnL</th><th>ROI%</th><th>maxDD</th><th>lossStreak</th><th>eventGroups</th><th>maxPerEvent</th><th>class</th></tr>";

export function renderScoreComponentAnalysisHtml(result: ScoreComponentAnalysisResult): string {
  const c = result;
  const fineRows = c.fineTimingAnalysis.fullCorpus.map((b) => metricsRow(b.bucket, b.metrics)).join("");
  const gateRows = c.cumulativeTimingGateAnalysis.fullCorpus.map((g) => metricsRow(g.gate, g.metrics)).join("");

  const cohortRows = c.uniqueCohorts
    .map(
      (co) =>
        `<tr><td>${esc(co.cohortId)}</td><td>${esc(co.canonicalVariantId)}</td><td>${esc(co.aliasVariantIds.join(", ") || "--")}</td><td>${co.selectedObservations}</td><td><code>${co.selectionHash.slice(0, 16)}</code></td></tr>`,
    )
    .join("");

  const priceCorridorRows = Object.entries(PRICE_CORRIDOR_LABELS)
    .map(([band, label]) => `<tr><td>${esc(band)}</td><td>${esc(label)}</td></tr>`)
    .join("");

  const availRows = c.componentAvailability
    .map(
      (a) =>
        `<tr><td>${esc(a.key)}</td><td>${esc(a.physicalSource)}</td><td>${num(a.formulaWeight)}</td><td>${esc(a.role)}</td><td>${num(a.coverageRate)}</td><td>${num(a.observedMin)}..${num(a.observedMax)}</td><td>${a.blocked ? "BLOCKED" : "OK"}</td></tr>`,
    )
    .join("");

  const missingRows = c.formulaContract.missingInputs
    .map((m) => `<tr><td>${esc(m.field)}</td><td>${num(m.weight)}</td><td>MISSING (not fabricated)</td></tr>`)
    .join("");

  const corrRows = c.componentOutcomeCorrelations
    .map(
      (co) =>
        `<tr><td>${esc(co.component)}</td><td>${num(co.pearsonReturn)}</td><td>${num(co.spearmanReturn)}</td><td>${num(co.pearsonWin)}</td><td>${num(co.spearmanWin)}</td><td>${co.validReturnPairs}</td><td>${co.classification}</td></tr>`,
    )
    .join("");

  const redRows = c.componentRedundancyMatrix
    .map(
      (r) =>
        `<tr><td>${esc(r.componentA)}</td><td>${esc(r.componentB)}</td><td>${num(r.pearson)}</td><td>${num(r.spearman)}</td><td>${r.validPairCount}</td><td>${r.flag === "HIGH_REDUNDANCY" ? "<strong>HIGH_REDUNDANCY</strong>" : "--"}</td></tr>`,
    )
    .join("");

  const monoRows = c.monotonicityAnalysis
    .map((m) => `<tr><td>${esc(m.component)}</td><td>${m.classification}</td><td>${m.eligibleBands}</td></tr>`)
    .join("");

  const b2Rows = c.b2EvidenceDirections
    .map(
      (d, i) =>
        `<tr><td>${i + 1}</td><td>${esc(d.type)}</td><td>${esc(d.componentOrInteraction)}</td><td>${d.uniqueSupportingCohorts}</td><td>${num(d.totalPnl)}</td><td>${num(d.medianRoi)}</td><td>${esc(d.redundancyWarning ?? "--")}</td><td>${esc(d.reason)}</td></tr>`,
    )
    .join("");

  function heatmap(grid: InteractionGrid): string {
    const rowsBody = grid.cells
      .map(
        (cell) =>
          `<tr><td>${esc(cell.row)}</td><td>${esc(cell.col)}</td><td>${cell.metrics.observations}</td><td>${num(cell.metrics.flatUnitPnl)}</td><td>${num(cell.metrics.flatUnitRoi)}</td><td>${cell.strongEvidenceEligible ? "yes" : "no"}</td></tr>`,
      )
      .join("");
    return `<h3>${esc(grid.rowDimension)} &times; ${esc(grid.colDimension)}</h3><table><tr><th>${esc(grid.rowDimension)}</th><th>${esc(grid.colDimension)}</th><th>N</th><th>PnL</th><th>ROI%</th><th>strong?</th></tr>${rowsBody}</table>`;
  }
  const priceTiming = c.interactionAnalysis.find((g) => g.id === "fineTiming_x_priceBand");
  const scorePrice = c.interactionAnalysis.find((g) => g.id === "scoreBand_x_priceBand");
  const scoreTiming = c.interactionAnalysis.find((g) => g.id === "fineTiming_x_scoreBand");

  const contrib = c.persistedContributionAnalysis;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Score Component Analysis (B1)</title><style>
body{font-family:system-ui,Arial,sans-serif;margin:0;padding:24px;color:#1a1a1a;background:#fafafa;}
.banner{background:#7a1020;color:#fff;padding:14px 18px;border-radius:8px;font-weight:700;letter-spacing:.5px;margin-bottom:20px;}
.banner div{font-size:13px;opacity:.9;font-weight:600;}
h1{font-size:22px;} h2{font-size:18px;margin-top:32px;border-bottom:2px solid #ddd;padding-bottom:4px;} h3{font-size:15px;margin-top:18px;}
table{border-collapse:collapse;width:100%;overflow-x:auto;display:block;font-size:12px;margin:8px 0;}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:right;white-space:nowrap;}
th:first-child,td:first-child{text-align:left;}
code{background:#eee;padding:1px 4px;border-radius:3px;}
.meta{font-size:12px;color:#555;}
</style></head><body>
<div class="banner">HISTORICAL COMPONENT RESEARCH ONLY<div>NO AUTOMATIC FORMULA SELECTION</div><div>NO MODEL PROMOTION</div></div>
<h1>Persisted Score Component, Fine Timing &amp; Interaction Analysis</h1>
<p class="meta">Engine ${esc(c.engineVersion)} · raw ${c.corpusSummary.rawRowCount} → strict-dedup ${c.corpusSummary.strictDedupRowCount} (${esc(c.corpusSummary.strictDedupPolicy)}) · contentHash <code>${c.contentHash.slice(0, 16)}</code></p>

<h2>Exact Formula Contract</h2>
<p class="meta">Model ${esc(c.formulaContract.formulaModelId)} · version ${esc(c.formulaContract.metricFormulaVersion)}</p>
<pre><code>${esc(c.formulaContract.rawExpression)}</code></pre>
<p class="meta">Feasibility verdict: <strong>${esc(c.formulaFeasibility)}</strong></p>

<h2>Persisted versus Missing Components</h2>
<table><tr><th>component</th><th>physical source</th><th>weight</th><th>role</th><th>coverage</th><th>range</th><th>status</th></tr>${availRows}</table>
<h3>Missing historical inputs (never fabricated)</h3>
<table><tr><th>field</th><th>weight</th><th>status</th></tr>${missingRows}</table>

<h2>Exact Cohort Aliases</h2>
<table><tr><th>cohort</th><th>canonical variant</th><th>alias variants</th><th>selected rows</th><th>selection hash</th></tr>${cohortRows}</table>

<h2>Fine Timing (0-30m / 30-60m / 1-2h / 2-3h and beyond)</h2>
<table>${METRIC_HEADER}${fineRows}</table>

<h2>Cumulative Entry Gates (30m / 1h / 2h / 3h)</h2>
<table>${METRIC_HEADER}${gateRows}</table>

<h2>Price Corridor Explanation</h2>
<p class="meta">Calculated market-price labels (implied probability / derived decimal odds) — NOT executed sportsbook odds.</p>
<table><tr><th>corridor</th><th>interpretation</th></tr>${priceCorridorRows}</table>

<h2>Price &times; Fine Timing Heatmap</h2>${priceTiming ? heatmap(priceTiming) : ""}
<h2>Score &times; Price Heatmap</h2>${scorePrice ? heatmap(scorePrice) : ""}
<h2>Score &times; Fine Timing Heatmap</h2>${scoreTiming ? heatmap(scoreTiming) : ""}

<h2>Component / Outcome Correlations</h2>
<p class="meta">Descriptive only — no p-values, no causal claims. Fewer than ${CORRELATION_MIN_PAIRS} valid pairs is INSUFFICIENT.</p>
<table><tr><th>component</th><th>Pearson(return)</th><th>Spearman(return)</th><th>Pearson(win)</th><th>Spearman(win)</th><th>pairs</th><th>class</th></tr>${corrRows}</table>

<h2>Redundancy Matrix</h2>
<table><tr><th>A</th><th>B</th><th>Pearson</th><th>Spearman</th><th>N</th><th>flag</th></tr>${redRows}</table>

<h2>Unexplained Score Remainder</h2>
<p class="meta">Remainder = observed final score − persisted-weighted contribution. Reported as an unexplained residual; deliberately NOT attributed to any specific missing input.</p>
<table><tr><th>coveredRows</th><th>median contribution</th><th>median observed</th><th>median remainder</th><th>P10</th><th>P90</th><th>clamp/cap count</th></tr>
<tr><td>${contrib.coveredRows}</td><td>${num(contrib.medianPersistedContribution)}</td><td>${num(contrib.medianObservedScore)}</td><td>${num(contrib.medianRemainder)}</td><td>${num(contrib.remainderP10)}</td><td>${num(contrib.remainderP90)}</td><td>${contrib.sourceProvableClampCapCount}</td></tr></table>

<h2>Monotonicity</h2>
<table><tr><th>component</th><th>classification</th><th>eligible bands</th></tr>${monoRows}</table>

<h2>B2 Evidence Directions (research only — at most ten)</h2>
<table><tr><th>#</th><th>type</th><th>component/interaction</th><th>cohorts</th><th>PnL</th><th>ROI%</th><th>redundancy warning</th><th>reason</th></tr>${b2Rows}</table>

<h2>Data-Capture Limitations</h2>
<ul>${c.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
</body></html>
`;
}
