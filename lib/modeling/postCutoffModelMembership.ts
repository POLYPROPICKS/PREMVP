// Frozen post-cutoff model membership + forward metrics (Phase 3E.8E.2D).
//
// A pure, deterministic forward-evaluation module. It consumes the canonical
// PostCutoffEvaluationDataset (Phase 3E.8E.2C), runs exactly the three frozen
// variants (PRIMARY / ALT2 / ALT1) through the existing frozen evaluator --
// never re-deriving any threshold, exclusion, grouping, or tie-break -- maps
// the selected evaluator rows back to canonical observation keys, and computes
// PnL/ROI, equity/drawdown, event concentration, and UTC weekly metrics using
// the existing canonical contracts. It returns deterministically sorted output
// with a SHA-256 result hash.
//
// This module does NOT: refit or promote a model, choose a champion, read
// fs/network/env/Supabase, call the system clock or a random source, mutate any
// input, store a raw row, or re-implement a second ROI formula. The only new
// math is a small local strict equity walk composed solely from the canonical
// computeRowReturnPct.

import { createHash } from "node:crypto";

import type {
  PostCutoffEvaluationDataset,
  ForwardEvaluationObservation,
} from "./postCutoffEvaluationDataset";
import { toFrozenEvaluatorRow } from "./postCutoffEvaluationDataset";
import { buildObservationKey } from "./postCutoffObservation";
import { buildEventGroupKey } from "./eventGroupSelection";
import { computeFlatStakeRoiSummary, computeRowReturnPct } from "./roiPnlContract";
import {
  evaluateHistoricalFunnelVariant,
  loadExecutableFunnelClassifier,
} from "./historicalFunnelVariants";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";

/** The three frozen variants, in locked evaluation/output order. Never extend or rename. */
export const POST_CUTOFF_FROZEN_VARIANT_IDS = [
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT2_TS_SCORE_GE_65",
  "ALT1_CANONICAL_EVENT_GROUPING",
] as const;

export type PostCutoffFrozenVariantId = (typeof POST_CUTOFF_FROZEN_VARIANT_IDS)[number];

export interface PostCutoffWeeklyModelMetrics {
  weekBucket: string;
  selectedObservationCount: number;
  winCount: number;
  lossCount: number;
  invalidRowCount: number;
  totalPnlUnits: number | null;
  roiPct: number | null;
  cumulativePnlUnits: number | null;
  currentDrawdownUnits: number | null;
  maxDrawdownUnits: number | null;
}

export interface PostCutoffEventConcentration {
  eventGroupCount: number;
  multiSignalEventGroupCount: number;
  maxSignalsPerEvent: number;
}

export interface PostCutoffModelResult {
  variantId: PostCutoffFrozenVariantId;
  inputObservationCount: number;
  selectedObservationCount: number;
  selectedObservationKeys: string[];

  winCount: number;
  lossCount: number;
  invalidRowCount: number;
  totalPnlUnits: number | null;
  roiPct: number | null;

  finalEquityUnits: number | null;
  peakEquityUnits: number | null;
  currentDrawdownUnits: number | null;
  maxDrawdownUnits: number | null;

  eventConcentration: PostCutoffEventConcentration;
  weeklyMetrics: PostCutoffWeeklyModelMetrics[];
}

export interface PostCutoffFrozenModelEvaluation {
  schemaVersion: 1;
  cutoffResolvedAtExclusive: string;
  datasetHash: string;
  inputObservationCount: number;
  models: PostCutoffModelResult[];
  evaluationHash: string;
}

/** Thrown for a structurally invalid dataset or an unmappable selected row. Carries only safe canonical identity fields. */
export class PostCutoffModelIntegrityError extends Error {
  constructor(message: string) {
    super(`post-cutoff model integrity: ${message}`);
    this.name = "PostCutoffModelIntegrityError";
  }
}

const HEX_64 = /^[0-9a-f]{64}$/;

function validateDataset(dataset: PostCutoffEvaluationDataset): void {
  if (dataset.schemaVersion !== 1) {
    throw new PostCutoffModelIntegrityError(`schemaVersion must be 1`);
  }
  if (typeof dataset.datasetHash !== "string" || !HEX_64.test(dataset.datasetHash)) {
    throw new PostCutoffModelIntegrityError(`datasetHash must be 64 lowercase hex characters`);
  }
  if (dataset.uniqueObservationCount !== dataset.observations.length) {
    throw new PostCutoffModelIntegrityError(
      `uniqueObservationCount (${dataset.uniqueObservationCount}) does not match observations length (${dataset.observations.length})`,
    );
  }
}

/** Per-row equity input: null returnPct with unresolved label = no bet; a non-null invalidReason = financially invalid. */
interface RowFinancials {
  returnPct: number | null;
  invalid: boolean;
}

function rowFinancials(observation: ForwardEvaluationObservation): RowFinancials {
  const computed = computeRowReturnPct(toFrozenEvaluatorRow(observation));
  return { returnPct: computed.returnPct, invalid: computed.invalidReason !== null };
}

/**
 * Compares two observations for the canonical forward ordering: resolvedAt
 * ascending, then observationKey ascending. Input ordering never affects the
 * result.
 */
function compareObservations(a: ForwardEvaluationObservation, b: ForwardEvaluationObservation): number {
  if (a.resolvedAt < b.resolvedAt) return -1;
  if (a.resolvedAt > b.resolvedAt) return 1;
  if (a.observationKey < b.observationKey) return -1;
  if (a.observationKey > b.observationKey) return 1;
  return 0;
}

interface EquityResult {
  finalEquityUnits: number | null;
  peakEquityUnits: number | null;
  currentDrawdownUnits: number | null;
  maxDrawdownUnits: number | null;
}

/**
 * Strict flat-unit equity walk over already-ordered observations, composed only
 * from the canonical computeRowReturnPct. Cumulative and peak start at 0;
 * drawdown = peak - equity. If any selected row is financially invalid under
 * strict mode, every equity metric is null (the model is never omitted).
 * Unresolved rows place no bet.
 */
function computeEquity(orderedSelected: ForwardEvaluationObservation[]): EquityResult {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const observation of orderedSelected) {
    const fin = rowFinancials(observation);
    if (fin.invalid) {
      return { finalEquityUnits: null, peakEquityUnits: null, currentDrawdownUnits: null, maxDrawdownUnits: null };
    }
    if (fin.returnPct === null) continue; // unresolved: no bet
    cumulative += fin.returnPct / 100;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return {
    finalEquityUnits: cumulative,
    peakEquityUnits: peak,
    currentDrawdownUnits: peak - cumulative,
    maxDrawdownUnits: maxDrawdown,
  };
}

/**
 * Event concentration over the selected observations, using the canonical
 * buildEventGroupKey. A row whose only key is the condition-id fallback (no
 * valid event identity) is not merged into a shared bucket -- it is counted as
 * its own synthetic isolated group keyed by observationKey. This synthetic
 * fallback is local to concentration only.
 */
function computeConcentration(selected: ForwardEvaluationObservation[]): PostCutoffEventConcentration {
  const groupSizes = new Map<string, number>();
  for (const observation of selected) {
    const { key, source } = buildEventGroupKey(toFrozenEvaluatorRow(observation));
    const groupKey = source === "condition_fallback" ? `synthetic:${observation.observationKey}` : key;
    groupSizes.set(groupKey, (groupSizes.get(groupKey) ?? 0) + 1);
  }
  let maxSignalsPerEvent = 0;
  let multiSignalEventGroupCount = 0;
  for (const size of groupSizes.values()) {
    if (size > maxSignalsPerEvent) maxSignalsPerEvent = size;
    if (size > 1) multiSignalEventGroupCount += 1;
  }
  return { eventGroupCount: groupSizes.size, multiSignalEventGroupCount, maxSignalsPerEvent };
}

function summarizeRoi(observations: ForwardEvaluationObservation[]) {
  const roi = computeFlatStakeRoiSummary(
    observations.map(toFrozenEvaluatorRow),
    { strict: true, stakeUnits: 1 },
  );
  return {
    winCount: roi.winCount,
    lossCount: roi.lossCount,
    invalidRowCount: roi.rowsInvalidResultLabel + roi.rowsInvalidMissingReturn + roi.rowsInvalidEntryPrice,
    totalPnlUnits: roi.totalPnlUnits,
    roiPct: roi.roiPct,
  };
}

/**
 * UTC weekly metrics over the ordered selected observations. Weekly PnL/ROI use
 * only that week's rows (strict). Cumulative PnL and drawdown are a running
 * portfolio path through week end; a financially invalid row blocks the running
 * financial values from its point forward, while all counts stay available.
 */
function computeWeekly(orderedSelected: ForwardEvaluationObservation[]): PostCutoffWeeklyModelMetrics[] {
  // resolvedAt-ascending order implies weekBucket is non-decreasing, so weeks
  // appear as contiguous runs.
  const buckets: string[] = [];
  const byBucket = new Map<string, ForwardEvaluationObservation[]>();
  for (const observation of orderedSelected) {
    const existing = byBucket.get(observation.weekBucket);
    if (existing) {
      existing.push(observation);
    } else {
      byBucket.set(observation.weekBucket, [observation]);
      buckets.push(observation.weekBucket);
    }
  }
  buckets.sort();

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let blocked = false;

  const out: PostCutoffWeeklyModelMetrics[] = [];
  for (const bucket of buckets) {
    const rows = byBucket.get(bucket)!;
    const weekRoi = summarizeRoi(rows);

    // Advance the running portfolio path through this week's rows (in order).
    for (const observation of rows) {
      const fin = rowFinancials(observation);
      if (fin.invalid) {
        blocked = true;
        continue;
      }
      if (blocked || fin.returnPct === null) continue;
      cumulative += fin.returnPct / 100;
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    out.push({
      weekBucket: bucket,
      selectedObservationCount: rows.length,
      winCount: weekRoi.winCount,
      lossCount: weekRoi.lossCount,
      invalidRowCount: weekRoi.invalidRowCount,
      totalPnlUnits: weekRoi.totalPnlUnits,
      roiPct: weekRoi.roiPct,
      cumulativePnlUnits: blocked ? null : cumulative,
      currentDrawdownUnits: blocked ? null : peak - cumulative,
      maxDrawdownUnits: blocked ? null : maxDrawdown,
    });
  }
  return out;
}

function evaluateVariant(
  variantId: PostCutoffFrozenVariantId,
  observations: ForwardEvaluationObservation[],
  observationByKey: Map<string, ForwardEvaluationObservation>,
  classifier: ExecutableFunnelClassifier,
): PostCutoffModelResult {
  const rows = observations.map(toFrozenEvaluatorRow);
  const evaluation = evaluateHistoricalFunnelVariant(rows, classifier, variantId);

  // Map each selected evaluator row back to exactly one dataset observation via
  // the canonical condition_id/token_id/resolved_at tuple. Never by index.
  const selected: ForwardEvaluationObservation[] = [];
  for (const row of evaluation.selectedRows) {
    const key = buildObservationKey(row);
    const observation = key === null ? undefined : observationByKey.get(key);
    if (observation === undefined) {
      throw new PostCutoffModelIntegrityError(
        `variant ${variantId}: selected row does not map to a unique observation ` +
          `(condition_id=${String(row["condition_id"])}, token_id=${String(row["token_id"])}, resolved_at=${String(row["resolved_at"])})`,
      );
    }
    selected.push(observation);
  }

  const orderedSelected = [...selected].sort(compareObservations);
  const roi = summarizeRoi(orderedSelected);
  const equity = computeEquity(orderedSelected);

  return {
    variantId,
    inputObservationCount: observations.length,
    selectedObservationCount: orderedSelected.length,
    selectedObservationKeys: orderedSelected.map((o) => o.observationKey),
    winCount: roi.winCount,
    lossCount: roi.lossCount,
    invalidRowCount: roi.invalidRowCount,
    totalPnlUnits: roi.totalPnlUnits,
    roiPct: roi.roiPct,
    finalEquityUnits: equity.finalEquityUnits,
    peakEquityUnits: equity.peakEquityUnits,
    currentDrawdownUnits: equity.currentDrawdownUnits,
    maxDrawdownUnits: equity.maxDrawdownUnits,
    eventConcentration: computeConcentration(orderedSelected),
    weeklyMetrics: computeWeekly(orderedSelected),
  };
}

/**
 * Evaluates exactly the three frozen post-cutoff models over the canonical
 * evaluation dataset and returns deterministic, content-hashed forward metrics.
 * The classifier defaults to the frozen registry loader but is injectable so
 * the core evaluation stays a pure function of its inputs. Never mutates the
 * dataset.
 */
export function evaluatePostCutoffFrozenModels(
  dataset: PostCutoffEvaluationDataset,
  classifier: ExecutableFunnelClassifier = loadExecutableFunnelClassifier(),
): PostCutoffFrozenModelEvaluation {
  validateDataset(dataset);

  const observationByKey = new Map<string, ForwardEvaluationObservation>();
  for (const observation of dataset.observations) {
    if (observationByKey.has(observation.observationKey)) {
      throw new PostCutoffModelIntegrityError(`duplicate observation key ${observation.observationKey}`);
    }
    observationByKey.set(observation.observationKey, observation);
  }

  const observations = [...dataset.observations];
  const models = POST_CUTOFF_FROZEN_VARIANT_IDS.map((variantId) =>
    evaluateVariant(variantId, observations, observationByKey, classifier),
  );

  const inputObservationCount = dataset.observations.length;
  const hashPayload = JSON.stringify({
    schemaVersion: 1,
    cutoffResolvedAtExclusive: dataset.cutoffResolvedAtExclusive,
    datasetHash: dataset.datasetHash,
    inputObservationCount,
    models,
  });
  const evaluationHash = createHash("sha256").update(hashPayload).digest("hex");

  return {
    schemaVersion: 1,
    cutoffResolvedAtExclusive: dataset.cutoffResolvedAtExclusive,
    datasetHash: dataset.datasetHash,
    inputObservationCount,
    models,
    evaluationHash,
  };
}
