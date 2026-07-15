// Bounded Observable Routing Experiments Engine (Phase 4B.2A / B2A).
//
// An isolated historical experiment engine that evaluates EXACTLY THREE
// frozen candidate routing policies against the ALT4 base comparator. Each
// candidate is ALT4's canonical selection with one bounded, source-provable
// observable filter added (a >= 0.30 entry-price floor, a known-start
// within-120-minutes timing gate, or their composition). The engine does NOT
// reconstruct or reweight the score formula, does NOT fabricate the missing
// historical inputs (oddsFit / momentum / liquidity / the corpus-absent
// smart-money & whale-public columns), does NOT create permanent
// strategy/model registry entries, and never promotes a model or names a
// Champion.
//
// Reuse only -- no new business math: strict dedup
// (generatedSignalPairsDedupPolicy), ALT4 selection
// (evaluateHistoricalFunnelVariant), canonical entry price / timing adapters
// (getEntryPriceValue / getHoursUntilStartValue), ROI/PnL + equity
// (computeSegmentMetrics), band adapters + fine timing / cumulative gates
// (extendedHistoricalDecomposition + scoreComponentAnalysis), event grouping
// (eventGroupSelection), sport/market classifiers (sportMarketPerformance-
// Slice), and stable selection hashing (scoreComponentAnalysis). Pure: no
// fs/env/network/Supabase, no forward rows, no mutation of input.

import { createHash } from "node:crypto";
import {
  projectGeneratedSignalPairsStrictDedup,
  STRICT_DEDUP_POLICY_NAME,
} from "./generatedSignalPairsDedupPolicy";
import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";
import { evaluateHistoricalFunnelVariant, getHoursUntilStartValue } from "./historicalFunnelVariants";
import {
  computeSegmentMetrics,
  priceBandOf,
  scoreBandOf,
  coverageBandOf,
  type DecompositionSegmentMetrics,
} from "./extendedHistoricalDecomposition";
import {
  computeSelectionHash,
  getEntryPriceValue,
  fineTimingBucketOf,
  isWithinCumulativeGate,
  CUMULATIVE_TIMING_GATES,
  type CumulativeTimingGate,
} from "./scoreComponentAnalysis";
import { SCORECARD_MODEL_ORDER } from "./historicalModelScorecard";
import { classifySport, classifyMarketType } from "./sportMarketPerformanceSlice";
import { groupRowsByEventGroup } from "./eventGroupSelection";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";

type Row = ExportRow;

export const BOUNDED_ROUTING_ENGINE_VERSION = "4B.2A-bounded-routing-experiments-v1" as const;
export const BOUNDED_ROUTING_SCHEMA_VERSION = 1 as const;

export const BASE_COMPARATOR_ID = "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS" as const;

export const PRICE_FLOOR = 0.3 as const;
export const TIMING_UPPER_HOURS = 2 as const;

export const CANDIDATE_IDS = [
  "B2_PRICE_FLOOR_030",
  "B2_TIMING_WITHIN_120M",
  "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M",
] as const;
export type CandidateId = (typeof CANDIDATE_IDS)[number];

export interface CandidateDefinition {
  id: CandidateId;
  parentId: string;
  addedConditions: string[];
}

// Frozen, fixed-order candidate definitions -- no dynamic generation, no
// threshold search, no candidate discovery, no fourth candidate.
export const CANDIDATE_DEFINITIONS: readonly CandidateDefinition[] = [
  {
    id: "B2_PRICE_FLOOR_030",
    parentId: BASE_COMPARATOR_ID,
    addedConditions: ["finite entry_price_num with 0 < price <= 1 and price >= 0.30 (missing/invalid fails closed)"],
  },
  {
    id: "B2_TIMING_WITHIN_120M",
    parentId: BASE_COMPARATOR_ID,
    addedConditions: ["known canonical event start with 0 <= hoursUntilStart < 2 (unknown/already-started fails closed; never resolved_at)"],
  },
  {
    id: "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M",
    parentId: "B2_PRICE_FLOOR_030",
    addedConditions: ["known canonical event start with 0 <= hoursUntilStart < 2 (unknown/already-started fails closed; never resolved_at)"],
  },
];

// ------------------------------------------------------------ predicates

/** ALT4 + entry-price floor: finite, 0 < price <= 1, price >= 0.30. Fail-closed. */
export function passesPriceFloor(row: Row): boolean {
  const p = getEntryPriceValue(row);
  return p !== null && p >= PRICE_FLOOR;
}

/** ALT4 + timing gate: known canonical start, 0 <= hoursUntilStart < 2. Fail-closed. */
export function passesTimingWithin120m(row: Row): boolean {
  const h = getHoursUntilStartValue(row);
  return h !== null && h >= 0 && h < TIMING_UPPER_HOURS;
}

// ------------------------------------------------------------ identity

function observationIdOf(row: Row): string {
  const id = row.id;
  if (typeof id === "string" && id.trim() !== "") return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  const key = getStrictDedupKeyForExportRow(row);
  return key ?? `__anon__${JSON.stringify(row)}`;
}

function selectionHashOf(rows: readonly Row[]): string {
  return computeSelectionHash(rows.map(observationIdOf));
}

function round6(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

// ------------------------------------------------------------ metrics

export interface MetricsBlock {
  id: string;
  selectedObservations: number;
  wins: number;
  losses: number;
  voidOrInvalid: number;
  winRate: number | null;
  flatUnitPnl: number | null;
  flatUnitRoi: number | null;
  maximumDrawdownUnits: number;
  longestLosingStreak: number;
  workingEventGroups: number;
  maximumSignalsPerWorkingEvent: number;
  averageEntryPrice: number | null;
  timingCoveredRows: number;
  timingCoveragePct: number | null;
  selectionHash: string;
}

function buildMetricsBlock(id: string, rows: readonly Row[]): MetricsBlock {
  const m = computeSegmentMetrics(rows);
  const prices: number[] = [];
  let timingCovered = 0;
  for (const row of rows) {
    const p = getEntryPriceValue(row);
    if (p !== null) prices.push(p);
    if (getHoursUntilStartValue(row) !== null) timingCovered += 1;
  }
  return {
    id,
    selectedObservations: m.observations,
    wins: m.wins,
    losses: m.losses,
    voidOrInvalid: m.voidOrInvalid,
    winRate: round6(m.winRate),
    flatUnitPnl: round6(m.flatUnitPnl),
    flatUnitRoi: round6(m.flatUnitRoi),
    maximumDrawdownUnits: round6(m.maximumDrawdownUnits) ?? 0,
    longestLosingStreak: m.longestLosingStreak,
    workingEventGroups: m.workingEventGroups,
    maximumSignalsPerWorkingEvent: m.maximumSignalsPerWorkingEvent,
    averageEntryPrice: prices.length > 0 ? round6(prices.reduce((s, p) => s + p, 0) / prices.length) : null,
    timingCoveredRows: timingCovered,
    timingCoveragePct: rows.length > 0 ? round6((timingCovered / rows.length) * 100) : null,
    selectionHash: selectionHashOf(rows),
  };
}

// ------------------------------------------------------------ deltas

export interface DeltaBlock {
  candidateId: CandidateId;
  againstId: string;
  deltaN: number;
  deltaPnl: number | null;
  deltaRoiPercentagePoints: number | null;
  deltaMaxDrawdownUnits: number;
  deltaLongestLosingStreak: number;
  deltaEventGroups: number;
  deltaMaximumSignalsPerEvent: number;
}

function deltaBlock(candidateId: CandidateId, cand: MetricsBlock, against: MetricsBlock): DeltaBlock {
  const sub = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : round6(a - b);
  return {
    candidateId,
    againstId: against.id,
    deltaN: cand.selectedObservations - against.selectedObservations,
    deltaPnl: sub(cand.flatUnitPnl, against.flatUnitPnl),
    deltaRoiPercentagePoints: sub(cand.flatUnitRoi, against.flatUnitRoi),
    deltaMaxDrawdownUnits: round6(cand.maximumDrawdownUnits - against.maximumDrawdownUnits) ?? 0,
    deltaLongestLosingStreak: cand.longestLosingStreak - against.longestLosingStreak,
    deltaEventGroups: cand.workingEventGroups - against.workingEventGroups,
    deltaMaximumSignalsPerEvent: cand.maximumSignalsPerWorkingEvent - against.maximumSignalsPerWorkingEvent,
  };
}

// ------------------------------------------------- removed-row attribution

export interface AttributionBucket {
  key: string;
  observations: number;
}

export interface RemovedRowAttribution {
  candidateId: CandidateId;
  parentId: string;
  removedObservations: number;
  removedPnl: number | null;
  removedRoi: number | null;
  removedWins: number;
  removedLosses: number;
  removedMaximumDrawdownUnits: number;
  removedLongestLosingStreak: number;
  byPriceBand: AttributionBucket[];
  byFineTimingBucket: AttributionBucket[];
  byScoreBand: AttributionBucket[];
  byCoverageBand: AttributionBucket[];
  bySport: AttributionBucket[];
  byMarketFamily: AttributionBucket[];
  bySingleVsMultiSignalEvent: AttributionBucket[];
}

function attributeBy(rows: readonly Row[], keyOf: (row: Row) => string): AttributionBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = keyOf(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, observations]) => ({ key, observations }));
}

function singleVsMultiKeyMap(rows: readonly Row[]): Map<Row, string> {
  const groups = groupRowsByEventGroup(rows);
  const map = new Map<Row, string>();
  for (const group of groups.values()) {
    const label = group.length > 1 ? "MULTI_SIGNAL_EVENT" : "SINGLE_SIGNAL_EVENT";
    for (const row of group) map.set(row, label);
  }
  return map;
}

function buildRemovedAttribution(
  candidateId: CandidateId,
  parentId: string,
  parentRows: readonly Row[],
  candidateRows: readonly Row[],
): RemovedRowAttribution {
  const kept = new Set(candidateRows.map(observationIdOf));
  const removed = parentRows.filter((r) => !kept.has(observationIdOf(r)));
  const m = computeSegmentMetrics(removed);
  const svm = singleVsMultiKeyMap(removed);
  return {
    candidateId,
    parentId,
    removedObservations: removed.length,
    removedPnl: round6(m.flatUnitPnl),
    removedRoi: round6(m.flatUnitRoi),
    removedWins: m.wins,
    removedLosses: m.losses,
    removedMaximumDrawdownUnits: round6(m.maximumDrawdownUnits) ?? 0,
    removedLongestLosingStreak: m.longestLosingStreak,
    byPriceBand: attributeBy(removed, priceBandOf),
    byFineTimingBucket: attributeBy(removed, fineTimingBucketOf),
    byScoreBand: attributeBy(removed, scoreBandOf),
    byCoverageBand: attributeBy(removed, coverageBandOf),
    bySport: attributeBy(removed, (r) => classifySport(r).sportKey),
    byMarketFamily: attributeBy(removed, (r) => classifyMarketType(r).marketKey),
    bySingleVsMultiSignalEvent: attributeBy(removed, (r) => svm.get(r) ?? "SINGLE_SIGNAL_EVENT"),
  };
}

// ------------------------------------------------------------ duplicates

export type DuplicateStatus = "EXACT_DUPLICATE_EXISTING_MODEL" | "EXACT_DUPLICATE_BATCH_CANDIDATE" | "UNIQUE_SELECTION";

export interface DuplicateAnalysisEntry {
  candidateId: CandidateId;
  selectionHash: string;
  status: DuplicateStatus;
  duplicateOf: string | null;
}

// ------------------------------------------------------------ triage

export type TriageStatus =
  | "ADVANCE_BROAD_FOLLOWUP"
  | "ADVANCE_RISK_EFFICIENT_FOLLOWUP"
  | "HOLD_MIXED"
  | "REJECT_DOMINATED"
  | "REJECT_DUPLICATE";

export interface TriageInputMetrics {
  selectedObservations: number;
  flatUnitPnl: number | null;
  flatUnitRoi: number | null;
  maximumDrawdownUnits: number;
}

/**
 * Deterministic triage relative to the direct parent. A non-unique selection
 * can never advance (REJECT_DUPLICATE). No Champion, no promotion, no live
 * wording is ever produced.
 */
export function classifyTriage(cand: TriageInputMetrics, parent: TriageInputMetrics, isUnique: boolean): TriageStatus {
  if (!isUnique) return "REJECT_DUPLICATE";
  const cPnl = cand.flatUnitPnl ?? Number.NEGATIVE_INFINITY;
  const pPnl = parent.flatUnitPnl ?? Number.NEGATIVE_INFINITY;
  const cRoi = cand.flatUnitRoi ?? Number.NEGATIVE_INFINITY;
  const pRoi = parent.flatUnitRoi ?? Number.NEGATIVE_INFINITY;
  const cDD = cand.maximumDrawdownUnits;
  const pDD = parent.maximumDrawdownUnits;

  if (cand.selectedObservations >= 200 && cPnl > pPnl && cRoi > pRoi && cDD <= pDD) {
    return "ADVANCE_BROAD_FOLLOWUP";
  }
  if (cand.selectedObservations >= 200 && cRoi > pRoi && cDD < pDD && cPnl >= 0.8 * pPnl) {
    return "ADVANCE_RISK_EFFICIENT_FOLLOWUP";
  }
  if (cPnl <= pPnl && cRoi <= pRoi && cDD >= pDD) {
    return "REJECT_DOMINATED";
  }
  return "HOLD_MIXED";
}

export interface TriageEntry {
  candidateId: CandidateId;
  parentId: string;
  status: TriageStatus;
  rationale: string;
}

// ------------------------------------------------- timing sensitivity

export interface TimingSensitivity {
  subWindows: Array<{ bucket: string; metrics: DecompositionSegmentMetrics }>;
  cumulativeGates: Array<{ gate: CumulativeTimingGate; metrics: DecompositionSegmentMetrics }>;
}

const TIMING_SUBWINDOWS = ["T_0_TO_30M", "T_30_TO_60M", "T_60_TO_120M", "T_120_TO_180M"] as const;

function buildTimingSensitivity(alt4Rows: readonly Row[]): TimingSensitivity {
  return {
    subWindows: TIMING_SUBWINDOWS.map((bucket) => ({
      bucket,
      metrics: computeSegmentMetrics(alt4Rows.filter((r) => fineTimingBucketOf(r) === bucket)),
    })),
    cumulativeGates: CUMULATIVE_TIMING_GATES.map((gate) => ({
      gate,
      metrics: computeSegmentMetrics(alt4Rows.filter((r) => isWithinCumulativeGate(getHoursUntilStartValue(r), gate))),
    })),
  };
}

// ------------------------------------------------------------ evidence

interface EvidenceProvenance {
  contentHash: string;
  rawRowCount: number;
  strictDedupRowCount: number;
  strictDedupPolicy: string;
}

function validateEvidence(evidence: unknown, rawRowCount: number, strictDedupRowCount: number): EvidenceProvenance {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("evidence: must be a JSON object");
  }
  const ev = evidence as Record<string, unknown>;
  const contentHash = ev.contentHash;
  if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error("evidence: contentHash is missing or not a 64-hex sha256");
  }
  const summary = ev.corpusSummary;
  if (!summary || typeof summary !== "object") {
    throw new Error("evidence: corpusSummary is missing");
  }
  const s = summary as Record<string, unknown>;
  if (s.strictDedupPolicy !== STRICT_DEDUP_POLICY_NAME) {
    throw new Error(`evidence: strict-dedup policy mismatch (expected ${STRICT_DEDUP_POLICY_NAME}, got ${String(s.strictDedupPolicy)})`);
  }
  if (s.rawRowCount !== rawRowCount) {
    throw new Error(`evidence: corpus rawRowCount mismatch (evidence ${String(s.rawRowCount)} vs corpus ${rawRowCount})`);
  }
  if (s.strictDedupRowCount !== strictDedupRowCount) {
    throw new Error(`evidence: corpus strictDedupRowCount mismatch (evidence ${String(s.strictDedupRowCount)} vs corpus ${strictDedupRowCount})`);
  }
  return { contentHash, rawRowCount, strictDedupRowCount, strictDedupPolicy: STRICT_DEDUP_POLICY_NAME };
}

// ------------------------------------------------------------ build

export interface BoundedRoutingInput {
  rawRows: readonly Row[];
  classifier: ExecutableFunnelClassifier;
  evidence: unknown;
}

export interface NextC1RegistryInput {
  candidateId: CandidateId;
  parentId: string;
  selectionHash: string;
  triageStatus: TriageStatus;
  duplicateStatus: DuplicateStatus;
}

export interface BoundedRoutingResult {
  schemaVersion: typeof BOUNDED_ROUTING_SCHEMA_VERSION;
  engineVersion: typeof BOUNDED_ROUTING_ENGINE_VERSION;
  corpusSummary: {
    rawRowCount: number;
    strictDedupRowCount: number;
    droppedDuplicateRows: number;
    strictDedupPolicy: string;
  };
  evidenceProvenance: EvidenceProvenance;
  candidateBudget: { baseComparators: number; candidates: number; frozen: true };
  baseComparator: string;
  candidateDefinitions: readonly CandidateDefinition[];
  baseMetrics: MetricsBlock;
  candidateMetrics: MetricsBlock[];
  parentComparisons: DeltaBlock[];
  baseComparisons: DeltaBlock[];
  removedRowAttribution: RemovedRowAttribution[];
  duplicateAnalysis: DuplicateAnalysisEntry[];
  timingSensitivity: TimingSensitivity;
  triage: TriageEntry[];
  nextC1RegistryInputs: NextC1RegistryInput[];
  limitations: string[];
  contentHash: string;
}

export function buildBoundedRoutingExperiments(input: BoundedRoutingInput): BoundedRoutingResult {
  const { rawRows, classifier, evidence } = input;

  // 1. Canonical strict dedup.
  const dedup = projectGeneratedSignalPairsStrictDedup([...rawRows]);
  const rows = dedup.dedupedRows;

  // 2. Evidence provenance (fail closed on any mismatch).
  const evidenceProvenance = validateEvidence(evidence, rawRows.length, rows.length);

  // 3. ALT4 base selection (canonical, unchanged).
  const alt4Result = evaluateHistoricalFunnelVariant(rows, classifier, BASE_COMPARATOR_ID);
  const alt4Rows = alt4Result.selectedRows;

  // 4. Frozen candidate selections (ALT4 + bounded observable filters).
  const priceRows = alt4Rows.filter(passesPriceFloor);
  const timingRows = alt4Rows.filter(passesTimingWithin120m);
  const comboRows = priceRows.filter(passesTimingWithin120m);

  const candidateRowsById: Record<CandidateId, Row[]> = {
    B2_PRICE_FLOOR_030: priceRows,
    B2_TIMING_WITHIN_120M: timingRows,
    B2_PRICE_FLOOR_030_TIMING_WITHIN_120M: comboRows,
  };

  const baseMetrics = buildMetricsBlock(BASE_COMPARATOR_ID, alt4Rows);
  const candidateMetrics = CANDIDATE_IDS.map((id) => buildMetricsBlock(id, candidateRowsById[id]));
  const metricsById = new Map<string, MetricsBlock>(candidateMetrics.map((m) => [m.id, m]));

  const parentMetricsFor = (id: CandidateId): MetricsBlock => {
    const parentId = CANDIDATE_DEFINITIONS.find((c) => c.id === id)!.parentId;
    return parentId === BASE_COMPARATOR_ID ? baseMetrics : metricsById.get(parentId)!;
  };
  const parentRowsFor = (id: CandidateId): Row[] => {
    const parentId = CANDIDATE_DEFINITIONS.find((c) => c.id === id)!.parentId;
    return parentId === BASE_COMPARATOR_ID ? alt4Rows : candidateRowsById[parentId as CandidateId];
  };

  // 5. Parent + ALT4 deltas.
  const parentComparisons = CANDIDATE_IDS.map((id) => deltaBlock(id, metricsById.get(id)!, parentMetricsFor(id)));
  const baseComparisons = CANDIDATE_IDS.map((id) => deltaBlock(id, metricsById.get(id)!, baseMetrics));

  // 6. Removed-row attribution vs direct parent.
  const removedRowAttribution = CANDIDATE_IDS.map((id) =>
    buildRemovedAttribution(id, CANDIDATE_DEFINITIONS.find((c) => c.id === id)!.parentId, parentRowsFor(id), candidateRowsById[id]),
  );

  // 7. Duplicate safety vs ALT4, all 12 existing models, and other candidates.
  const existingHashes = new Map<string, string>(); // hash -> modelId
  for (const modelId of SCORECARD_MODEL_ORDER) {
    try {
      const selected = evaluateHistoricalFunnelVariant(rows, classifier, modelId).selectedRows;
      const hash = selectionHashOf(selected);
      if (!existingHashes.has(hash)) existingHashes.set(hash, modelId);
    } catch {
      // Non-executable (e.g. ambiguous alias) models cannot collide; skip.
    }
  }
  const duplicateAnalysis: DuplicateAnalysisEntry[] = [];
  const seenBatchHashes = new Map<string, CandidateId>();
  for (const id of CANDIDATE_IDS) {
    const hash = metricsById.get(id)!.selectionHash;
    let status: DuplicateStatus;
    let duplicateOf: string | null;
    if (existingHashes.has(hash)) {
      status = "EXACT_DUPLICATE_EXISTING_MODEL";
      duplicateOf = existingHashes.get(hash) ?? null;
    } else if (seenBatchHashes.has(hash)) {
      status = "EXACT_DUPLICATE_BATCH_CANDIDATE";
      duplicateOf = seenBatchHashes.get(hash) ?? null;
    } else {
      status = "UNIQUE_SELECTION";
      duplicateOf = null;
      seenBatchHashes.set(hash, id);
    }
    duplicateAnalysis.push({ candidateId: id, selectionHash: hash, status, duplicateOf });
  }

  // 8. Timing sensitivity (analysis only, ALT4 base, no candidate IDs).
  const timingSensitivity = buildTimingSensitivity(alt4Rows);

  // 9. Deterministic triage.
  const dupById = new Map(duplicateAnalysis.map((d) => [d.candidateId, d]));
  const triage: TriageEntry[] = CANDIDATE_IDS.map((id) => {
    const cand = metricsById.get(id)!;
    const parent = parentMetricsFor(id);
    const isUnique = dupById.get(id)!.status === "UNIQUE_SELECTION";
    const status = classifyTriage(cand, parent, isUnique);
    return {
      candidateId: id,
      parentId: CANDIDATE_DEFINITIONS.find((c) => c.id === id)!.parentId,
      status,
      rationale: `N=${cand.selectedObservations}, PnL=${cand.flatUnitPnl}, ROI=${cand.flatUnitRoi}, MaxDD=${cand.maximumDrawdownUnits} vs parent PnL=${parent.flatUnitPnl}, ROI=${parent.flatUnitRoi}, MaxDD=${parent.maximumDrawdownUnits}; unique=${isUnique}`,
    };
  });

  // 10. Next C1 registry inputs (data only -- no registry mutation here).
  const nextC1RegistryInputs: NextC1RegistryInput[] = CANDIDATE_IDS.map((id) => ({
    candidateId: id,
    parentId: CANDIDATE_DEFINITIONS.find((c) => c.id === id)!.parentId,
    selectionHash: metricsById.get(id)!.selectionHash,
    triageStatus: triage.find((t) => t.candidateId === id)!.status,
    duplicateStatus: dupById.get(id)!.status,
  }));

  const limitations = [
    "HISTORICAL_BOUNDED_EXPERIMENT_ONLY: no Champion, no promotion, no live change",
    "no permanent strategy/model registry entry created in this phase",
    "score formula weights unchanged; missing inputs (oddsFit, momentum, liquidity, corpus-absent smart_money/whale_public) not fabricated",
    "descriptive only: removed-row attribution and timing sensitivity carry no causal claim",
    "candidates recomputed from canonical raw corpus; B1 evidence numbers are rationale only, never hardcoded",
  ];

  const partial: Omit<BoundedRoutingResult, "contentHash"> = {
    schemaVersion: BOUNDED_ROUTING_SCHEMA_VERSION,
    engineVersion: BOUNDED_ROUTING_ENGINE_VERSION,
    corpusSummary: {
      rawRowCount: rawRows.length,
      strictDedupRowCount: rows.length,
      droppedDuplicateRows: dedup.droppedDuplicateRows,
      strictDedupPolicy: STRICT_DEDUP_POLICY_NAME,
    },
    evidenceProvenance,
    candidateBudget: { baseComparators: 1, candidates: 3, frozen: true },
    baseComparator: BASE_COMPARATOR_ID,
    candidateDefinitions: CANDIDATE_DEFINITIONS,
    baseMetrics,
    candidateMetrics,
    parentComparisons,
    baseComparisons,
    removedRowAttribution,
    duplicateAnalysis,
    timingSensitivity,
    triage,
    nextC1RegistryInputs,
    limitations,
  };

  const contentHash = createHash("sha256").update(JSON.stringify(partial)).digest("hex");
  return { ...partial, contentHash };
}

// ------------------------------------------------------------ serializers

export function serializeBoundedRoutingJson(result: BoundedRoutingResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export interface BoundedRoutingManifest {
  schemaVersion: number;
  engineVersion: string;
  inputSha256: string;
  classifierSha256: string;
  evidenceSha256: string;
  evidenceContentHash: string;
  strictDedupPolicy: string;
  rawRowCount: number;
  strictDedupRowCount: number;
  baseComparatorId: string;
  candidateIds: string[];
  experimentContentHash: string;
  jsonSha256: string;
  htmlSha256: string;
  artifactSha256s: Record<string, string>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildBoundedRoutingManifest(
  result: BoundedRoutingResult,
  hashes: { inputSha256: string; classifierSha256: string; evidenceSha256: string },
  jsonString: string,
  htmlString: string,
): BoundedRoutingManifest {
  const jsonSha256 = sha256(jsonString);
  const htmlSha256 = sha256(htmlString);
  return {
    schemaVersion: result.schemaVersion,
    engineVersion: result.engineVersion,
    inputSha256: hashes.inputSha256,
    classifierSha256: hashes.classifierSha256,
    evidenceSha256: hashes.evidenceSha256,
    evidenceContentHash: result.evidenceProvenance.contentHash,
    strictDedupPolicy: result.corpusSummary.strictDedupPolicy,
    rawRowCount: result.corpusSummary.rawRowCount,
    strictDedupRowCount: result.corpusSummary.strictDedupRowCount,
    baseComparatorId: result.baseComparator,
    candidateIds: [...CANDIDATE_IDS],
    experimentContentHash: result.contentHash,
    jsonSha256,
    htmlSha256,
    artifactSha256s: {
      "bounded_routing_experiments.json": jsonSha256,
      "bounded_routing_experiments.html": htmlSha256,
    },
  };
}

// ---------------------------------------------------------------- HTML

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function num(value: number | null): string {
  return value === null ? "--" : String(value);
}

function metricsRow(m: MetricsBlock): string {
  return `<tr><td>${esc(m.id)}</td><td>${m.selectedObservations}</td><td>${m.wins}</td><td>${m.losses}</td><td>${num(m.winRate)}</td><td>${num(m.flatUnitPnl)}</td><td>${num(m.flatUnitRoi)}</td><td>${num(m.maximumDrawdownUnits)}</td><td>${m.longestLosingStreak}</td><td>${m.workingEventGroups}</td><td>${m.maximumSignalsPerWorkingEvent}</td><td>${num(m.averageEntryPrice)}</td><td>${m.timingCoveredRows}</td><td>${num(m.timingCoveragePct)}</td></tr>`;
}
const METRIC_HEADER =
  "<tr><th>id</th><th>N</th><th>wins</th><th>losses</th><th>winRate</th><th>PnL</th><th>ROI%</th><th>maxDD</th><th>lossStreak</th><th>eventGroups</th><th>maxPerEvent</th><th>avgPrice</th><th>timingCovered</th><th>timingCov%</th></tr>";

function deltaTable(rows: DeltaBlock[]): string {
  const body = rows
    .map(
      (d) =>
        `<tr><td>${esc(d.candidateId)}</td><td>${esc(d.againstId)}</td><td>${d.deltaN}</td><td>${num(d.deltaPnl)}</td><td>${num(d.deltaRoiPercentagePoints)}</td><td>${num(d.deltaMaxDrawdownUnits)}</td><td>${d.deltaLongestLosingStreak}</td><td>${d.deltaEventGroups}</td><td>${d.deltaMaximumSignalsPerEvent}</td></tr>`,
    )
    .join("");
  return `<table><tr><th>candidate</th><th>vs</th><th>ΔN</th><th>ΔPnL</th><th>ΔROI pp</th><th>ΔmaxDD</th><th>ΔlossStreak</th><th>ΔeventGroups</th><th>ΔmaxPerEvent</th></tr>${body}</table>`;
}

function attributionList(buckets: AttributionBucket[]): string {
  if (buckets.length === 0) return "<em>none</em>";
  return buckets.map((b) => `${esc(b.key)}:${b.observations}`).join(", ");
}

function frontierSvg(base: MetricsBlock, candidates: MetricsBlock[]): string {
  const points = [base, ...candidates];
  const rois = points.map((p) => p.flatUnitRoi ?? 0);
  const dds = points.map((p) => p.maximumDrawdownUnits);
  const minRoi = Math.min(...rois, 0);
  const maxRoi = Math.max(...rois, 0);
  const maxDd = Math.max(...dds, 1);
  const W = 360;
  const H = 200;
  const pad = 30;
  const x = (dd: number): number => pad + (maxDd === 0 ? 0 : (dd / maxDd) * (W - 2 * pad));
  const y = (roi: number): number => H - pad - (maxRoi === minRoi ? 0 : ((roi - minRoi) / (maxRoi - minRoi)) * (H - 2 * pad));
  const dots = points
    .map((p, i) => {
      const cx = x(p.maximumDrawdownUnits);
      const cy = y(p.flatUnitRoi ?? 0);
      const color = i === 0 ? "#333" : "#2b6cb0";
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${color}"><title>${esc(p.id)} ROI=${num(p.flatUnitRoi)} maxDD=${num(p.maximumDrawdownUnits)}</title></circle>`;
    })
    .join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="ROI vs MaxDrawdown frontier"><rect x="0" y="0" width="${W}" height="${H}" fill="#fff" stroke="#ccc"/><text x="${W / 2}" y="${H - 6}" font-size="11" text-anchor="middle">MaxDrawdown (units) →</text><text x="12" y="${H / 2}" font-size="11" text-anchor="middle" transform="rotate(-90 12 ${H / 2})">ROI% →</text>${dots}</svg>`;
}

export function renderBoundedRoutingHtml(result: BoundedRoutingResult): string {
  const c = result;
  const candidateCards = c.candidateMetrics
    .map((m) => {
      const def = c.candidateDefinitions.find((d) => d.id === m.id)!;
      const tri = c.triage.find((t) => t.candidateId === m.id)!;
      const dup = c.duplicateAnalysis.find((d) => d.candidateId === m.id)!;
      return `<div class="card"><h3>${esc(m.id)}</h3><p class="meta">parent: ${esc(def.parentId)}</p><p class="meta">added: ${esc(def.addedConditions.join("; "))}</p><table>${METRIC_HEADER}${metricsRow(m)}</table><p>triage: <strong>${esc(tri.status)}</strong> · duplicate: ${esc(dup.status)}${dup.duplicateOf ? " (" + esc(dup.duplicateOf) + ")" : ""}</p></div>`;
    })
    .join("");

  const removedRows = c.removedRowAttribution
    .map(
      (a) =>
        `<tr><td>${esc(a.candidateId)}</td><td>${esc(a.parentId)}</td><td>${a.removedObservations}</td><td>${num(a.removedPnl)}</td><td>${num(a.removedRoi)}</td><td>${a.removedWins}</td><td>${a.removedLosses}</td><td>${num(a.removedMaximumDrawdownUnits)}</td><td>${a.removedLongestLosingStreak}</td></tr><tr><td colspan="9" class="attr">price[${attributionList(a.byPriceBand)}] · timing[${attributionList(a.byFineTimingBucket)}] · score[${attributionList(a.byScoreBand)}] · coverage[${attributionList(a.byCoverageBand)}] · sport[${attributionList(a.bySport)}] · market[${attributionList(a.byMarketFamily)}] · event[${attributionList(a.bySingleVsMultiSignalEvent)}]</td></tr>`,
    )
    .join("");

  const timingSub = c.timingSensitivity.subWindows
    .map((s) => `<tr><td>${esc(s.bucket)}</td><td>${s.metrics.observations}</td><td>${num(round6(s.metrics.flatUnitPnl))}</td><td>${num(round6(s.metrics.flatUnitRoi))}</td><td>${num(round6(s.metrics.maximumDrawdownUnits))}</td></tr>`)
    .join("");
  const timingGate = c.timingSensitivity.cumulativeGates
    .map((g) => `<tr><td>${esc(g.gate)}</td><td>${g.metrics.observations}</td><td>${num(round6(g.metrics.flatUnitPnl))}</td><td>${num(round6(g.metrics.flatUnitRoi))}</td><td>${num(round6(g.metrics.maximumDrawdownUnits))}</td></tr>`)
    .join("");

  const dupRows = c.duplicateAnalysis
    .map((d) => `<tr><td>${esc(d.candidateId)}</td><td><code>${d.selectionHash.slice(0, 16)}</code></td><td>${esc(d.status)}</td><td>${esc(d.duplicateOf ?? "--")}</td></tr>`)
    .join("");

  const triageRows = c.triage
    .map((t) => `<tr><td>${esc(t.candidateId)}</td><td>${esc(t.parentId)}</td><td><strong>${esc(t.status)}</strong></td><td>${esc(t.rationale)}</td></tr>`)
    .join("");

  const c1Rows = c.nextC1RegistryInputs
    .map((r) => `<tr><td>${esc(r.candidateId)}</td><td>${esc(r.parentId)}</td><td><code>${r.selectionHash.slice(0, 16)}</code></td><td>${esc(r.triageStatus)}</td><td>${esc(r.duplicateStatus)}</td></tr>`)
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Bounded Routing Experiments (B2A)</title><style>
body{font-family:system-ui,Arial,sans-serif;margin:0;padding:24px;color:#1a1a1a;background:#fafafa;}
.banner{background:#7a1020;color:#fff;padding:14px 18px;border-radius:8px;font-weight:700;margin-bottom:20px;}
.banner div{font-size:13px;opacity:.9;}
h1{font-size:22px;} h2{font-size:18px;margin-top:32px;border-bottom:2px solid #ddd;padding-bottom:4px;} h3{font-size:15px;}
table{border-collapse:collapse;width:100%;overflow-x:auto;display:block;font-size:12px;margin:8px 0;}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:right;white-space:nowrap;}
th:first-child,td:first-child{text-align:left;}
td.attr{text-align:left;white-space:normal;font-size:11px;color:#444;}
.card{border:1px solid #ccc;border-radius:8px;padding:12px;margin:12px 0;background:#fff;}
.meta{font-size:12px;color:#555;margin:2px 0;}
code{background:#eee;padding:1px 4px;border-radius:3px;}
@media print{body{background:#fff;}}
</style></head><body>
<div class="banner">HISTORICAL BOUNDED EXPERIMENT ONLY<div>NO AUTOMATIC CHAMPION</div><div>NO MODEL PROMOTION</div><div>NO LIVE CHANGE</div></div>
<h1>Bounded Observable Routing Experiments</h1>

<h2>Corpus &amp; Evidence Provenance</h2>
<p class="meta">Engine ${esc(c.engineVersion)} · raw ${c.corpusSummary.rawRowCount} → strict-dedup ${c.corpusSummary.strictDedupRowCount} (${esc(c.corpusSummary.strictDedupPolicy)}) · experimentContentHash <code>${c.contentHash.slice(0, 16)}</code></p>
<p class="meta">Evidence contentHash <code>${esc(c.evidenceProvenance.contentHash.slice(0, 16))}</code> · evidence raw ${c.evidenceProvenance.rawRowCount} / dedup ${c.evidenceProvenance.strictDedupRowCount}</p>

<h2>Frozen Candidate Budget</h2>
<p class="meta">Exactly 1 base comparator (${esc(c.baseComparator)}) and 3 frozen candidates — no dynamic generation, no threshold search, no fourth candidate.</p>

<h2>Base ALT4 Metrics</h2>
<table>${METRIC_HEADER}${metricsRow(c.baseMetrics)}</table>

<h2>Three Candidate Cards</h2>
${candidateCards}

<h2>Parent Delta Table</h2>
${deltaTable(c.parentComparisons)}

<h2>ALT4 Delta Table</h2>
${deltaTable(c.baseComparisons)}

<h2>PnL / ROI / MaxDrawdown Frontier</h2>
${frontierSvg(c.baseMetrics, c.candidateMetrics)}

<h2>Removed-Row Attribution (descriptive only)</h2>
<table><tr><th>candidate</th><th>parent</th><th>removedN</th><th>removedPnl</th><th>removedRoi</th><th>removedWins</th><th>removedLosses</th><th>removedMaxDD</th><th>removedLossStreak</th></tr>${removedRows}</table>

<h2>Timing Sensitivity (ALT4, analysis only)</h2>
<h3>Sub-windows</h3>
<table><tr><th>bucket</th><th>N</th><th>PnL</th><th>ROI%</th><th>maxDD</th></tr>${timingSub}</table>
<h3>Cumulative gates</h3>
<table><tr><th>gate</th><th>N</th><th>PnL</th><th>ROI%</th><th>maxDD</th></tr>${timingGate}</table>

<h2>Duplicate Analysis</h2>
<table><tr><th>candidate</th><th>selectionHash</th><th>status</th><th>duplicateOf</th></tr>${dupRows}</table>

<h2>Deterministic Triage</h2>
<p class="meta">No Champion. No production recommendation. No live change.</p>
<table><tr><th>candidate</th><th>parent</th><th>status</th><th>rationale</th></tr>${triageRows}</table>

<h2>Limitations</h2>
<ul>${c.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>

<h2>Exact Next C1 Registry Inputs</h2>
<p class="meta">Data only — this phase creates no registry entry. C1 (Unified Hypothesis Registry) consumes these rows.</p>
<table><tr><th>candidate</th><th>parent</th><th>selectionHash</th><th>triage</th><th>duplicate</th></tr>${c1Rows}</table>
</body></html>
`;
}
