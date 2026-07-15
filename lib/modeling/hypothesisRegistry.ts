// Unified Hypothesis Registry (Phase 4C.1 / C1).
//
// A deterministic registry snapshot that unifies: the 12 canonical historical
// models, A1 decomposition evidence, A2 cross-model directions, B1 component/
// interaction directions, and B2A bounded candidate results -- with duplicate/
// alias relationships, parent/child lineage, an evidence layer per hypothesis,
// and the next required verification gate. It prevents duplicate hypothesis
// testing, loss of decision history, counting aliases as independent
// evidence, and promoting a historical result without independent proof.
//
// This phase does NOT alter candidate behavior, filters, or score weights; it
// does NOT add a Champion or promote a model; it does NOT use forward data or
// perform walk-forward; it does NOT call Supabase. Pure: no fs/env/network,
// no mutation of input evidence artifacts.
//
// Reuse only: canonical model order (SCORECARD_MODEL_ORDER), existing model
// IDs, B1 exact cohort aliases, B2A candidate/parent IDs -- no second manual
// copy of the 12-model order is created here.

import { createHash } from "node:crypto";
import { SCORECARD_MODEL_ORDER } from "./historicalModelScorecard";
import { BASELINE_VARIANT_ID } from "./historicalFunnelComparison";
import type { ExtendedHistoricalDecomposition } from "./extendedHistoricalDecomposition";
import type { ExtendedHistoricalDashboard } from "./extendedHistoricalDashboard";
import type { ScoreComponentAnalysisResult, B2EvidenceDirection } from "./scoreComponentAnalysis";
import type { BoundedRoutingResult, CandidateDefinition } from "./boundedRoutingExperiments";

export const HYPOTHESIS_REGISTRY_SCHEMA_VERSION = 1 as const;
export const HYPOTHESIS_REGISTRY_ENGINE_VERSION = "4C.1-hypothesis-registry-v1" as const;

export const HYPOTHESIS_TYPES = [
  "BASELINE_MODEL",
  "FILTER_POLICY",
  "PRICE_GUARD",
  "TIMING_GATE",
  "COMBINED_ROUTING_POLICY",
  "EVENT_GROUPING_POLICY",
  "SPORT_SPECIALIST",
  "SCORE_THRESHOLD",
  "COMPONENT_REWEIGHT_DIRECTION",
  "COMPONENT_INTERACTION_DIRECTION",
  "DATA_CAPTURE_REQUIREMENT",
  "RISK_CONCENTRATION_POLICY",
] as const;
export type HypothesisType = (typeof HYPOTHESIS_TYPES)[number];

export const REGISTRY_STATUSES = [
  "OBSERVED_UNTESTED",
  "HISTORICAL_ADVANCE",
  "HISTORICAL_HOLD",
  "HISTORICAL_REJECT",
  "BLOCKED_MISSING_DATA",
  "DEFERRED",
  "DUPLICATE",
] as const;
export type RegistryStatus = (typeof REGISTRY_STATUSES)[number];

export const PROMOTION_STATUS = "NOT_PROMOTED" as const;

export const EVIDENCE_LAYERS = [
  "HISTORICAL_FULL_PERIOD",
  "FORWARD_PENDING",
  "WALK_FORWARD_DEFERRED",
  "MISSING_COMPONENT_CAPTURE_REQUIRED",
] as const;
export type EvidenceLayer = (typeof EVIDENCE_LAYERS)[number];

export const DUPLICATE_STATUSES = [
  "UNIQUE",
  "EXACT_FINGERPRINT_DUPLICATE",
  "EXACT_SELECTION_DUPLICATE",
  "ALIAS_MODEL",
  "RELATED_NOT_DUPLICATE",
] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

export const NEXT_GATES = [
  "NONE",
  "INDEPENDENT_VALIDATION",
  "FORWARD_CAPTURE",
  "MISSING_COMPONENT_CAPTURE",
  "BOUNDED_FOLLOWUP",
  "REVIEW_ONLY",
] as const;
export type NextGate = (typeof NEXT_GATES)[number];

const MISSING_COMPONENT_FIELDS = new Set(["oddsFit", "momentum", "liquidity", "smart_money_score_num", "whale_public_score_num"]);

// ------------------------------------------------------------- fingerprint

export interface HypothesisFingerprintInput {
  type: HypothesisType;
  scope: string;
  parentFingerprint: string | null;
  conditions: Record<string, number | string | boolean>;
}

function normalizeConditionValue(value: number | string | boolean): string {
  if (typeof value === "number") {
    // Fixed 6-decimal normalization collapses .30 / 0.300 / 0.3 to one form.
    return `n:${(Math.round(value * 1e6) / 1e6).toFixed(6)}`;
  }
  if (typeof value === "boolean") return `b:${value}`;
  return `s:${value.trim().replace(/\s+/g, " ")}`;
}

/**
 * Deterministic fingerprint from normalized type/parentFingerprint/scope/
 * conditions. Condition keys are sorted, numeric thresholds normalized to a
 * fixed precision, and string whitespace collapsed -- metrics, titles, and
 * artifact paths are never part of the input contract, so they can never
 * affect the fingerprint. No natural-language similarity is used.
 */
export function computeHypothesisFingerprint(input: HypothesisFingerprintInput): string {
  const sortedKeys = Object.keys(input.conditions).sort();
  const normalized = sortedKeys.map((k) => `${k}=${normalizeConditionValue(input.conditions[k])}`).join("|");
  const payload = `${input.type}::${input.scope}::${input.parentFingerprint ?? "ROOT"}::${normalized}`;
  return createHash("sha256").update(payload).digest("hex");
}

// ------------------------------------------------------------- entity

export interface HypothesisMetrics {
  selectedObservations: number;
  flatUnitPnl: number | null;
  flatUnitRoi: number | null;
  maximumDrawdownUnits: number | null;
  longestLosingStreak: number | null;
}

export interface HypothesisEntry {
  hypothesisId: string;
  fingerprint: string;
  title: string;
  type: HypothesisType;
  scope: string;
  definition: Record<string, unknown>;
  parentHypothesisIds: string[];
  relatedModelIds: string[];
  selectionHash: string | null;
  aliasModelIds: string[];
  sourceEvidenceIds: string[];
  historicalMetrics: HypothesisMetrics | null;
  historicalTriage: string | null;
  registryStatus: RegistryStatus;
  promotionStatus: typeof PROMOTION_STATUS;
  evidenceLayers: EvidenceLayer[];
  duplicateStatus: DuplicateStatus;
  blockedReasons: string[];
  nextRequiredGate: NextGate;
  createdByPhase: string;
  lastEvaluatedPhase: string;
}

export interface EvidenceRecord {
  evidenceId: string;
  phase: string;
  schemaVersion: number;
  engineVersion: string;
  contentHash: string;
  corpusRawRows: number;
  corpusStrictDedupRows: number;
  strictDedupPolicy: string | null;
  supportsHypothesisIds: string[];
  limitations: string[];
}

export interface FrontierRow {
  candidateId: string;
  n: number;
  pnl: number | null;
  roi: number | null;
  maxDD: number;
  longestLosingStreak: number;
  selectionHash: string;
  triage: string;
}

export interface RegistrySummary {
  totalHypotheses: number;
  models: number;
  untested: number;
  historicalAdvance: number;
  historicalHold: number;
  historicalReject: number;
  blockedMissingData: number;
  deferred: number;
  duplicates: number;
  forwardPending: number;
  independentValidationRequired: number;
}

export interface CandidateBudgetHistoryEntry {
  batch: string;
  baseComparators: number;
  candidates: number;
  candidateIds: string[];
}

export interface HypothesisRegistryResult {
  schemaVersion: typeof HYPOTHESIS_REGISTRY_SCHEMA_VERSION;
  engineVersion: typeof HYPOTHESIS_REGISTRY_ENGINE_VERSION;
  corpusSummary: {
    rawRowCount: number;
    strictDedupRowCount: number;
    strictDedupPolicy: string;
  };
  evidenceRecords: EvidenceRecord[];
  hypotheses: HypothesisEntry[];
  modelAliases: Array<{ canonicalModelId: string; aliasModelIds: string[] }>;
  lineageGraph: Array<{ hypothesisId: string; parentHypothesisIds: string[]; childHypothesisIds: string[] }>;
  historicalFrontier: FrontierRow[];
  registrySummary: RegistrySummary;
  candidateBudgetHistory: CandidateBudgetHistoryEntry[];
  limitations: string[];
  contentHash: string;
}

// ------------------------------------------------------------- validation

export interface HypothesisRegistryInput {
  decomposition: ExtendedHistoricalDecomposition;
  dashboard: ExtendedHistoricalDashboard;
  components: ScoreComponentAnalysisResult;
  experiments: BoundedRoutingResult;
}

function fail(msg: string): never {
  throw new Error(`hypothesis registry: ${msg}`);
}

function validateLineage(input: HypothesisRegistryInput): void {
  const { decomposition, dashboard, components, experiments } = input;

  if (decomposition.schemaVersion !== 1) fail("decomposition schemaVersion mismatch");
  if (dashboard.schemaVersion !== 1) fail("dashboard schemaVersion mismatch");
  if (components.schemaVersion !== 1) fail("components schemaVersion mismatch");
  if (experiments.schemaVersion !== 1) fail("experiments schemaVersion mismatch");

  if (typeof decomposition.contentHash !== "string" || decomposition.contentHash.length !== 64) {
    fail("decomposition contentHash missing/invalid");
  }
  if (dashboard.sourceDecompositionHash !== decomposition.contentHash) {
    fail("dashboard.sourceDecompositionHash does not match decomposition.contentHash");
  }
  if (experiments.evidenceProvenance.contentHash !== components.contentHash) {
    fail("B2A evidenceContentHash does not equal B1 contentHash");
  }
  if (experiments.baseComparator !== "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS") {
    fail("B2A base comparator must equal ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS");
  }
  if (experiments.candidateBudget.candidates !== 3 || experiments.candidateBudget.baseComparators !== 1) {
    fail("B2A frozen candidate budget must be exactly 1 base comparator and 3 candidates");
  }

  const rawCounts = [decomposition.rawRowCount, dashboard.corpusSummary.rawRowCount, components.corpusSummary.rawRowCount, experiments.corpusSummary.rawRowCount];
  if (new Set(rawCounts).size !== 1) fail("corpus rawRowCount mismatch across evidence artifacts");

  const dedupCounts = [decomposition.strictDedupRowCount, dashboard.corpusSummary.strictDedupRowCount, components.corpusSummary.strictDedupRowCount, experiments.corpusSummary.strictDedupRowCount];
  if (new Set(dedupCounts).size !== 1) fail("corpus strictDedupRowCount mismatch across evidence artifacts");

  const policies = [decomposition.strictDedupPolicy, components.corpusSummary.strictDedupPolicy, experiments.corpusSummary.strictDedupPolicy];
  if (new Set(policies).size !== 1) fail("strict-dedup policy mismatch across evidence artifacts");
}

// ------------------------------------------------------------- ID helpers

function round6(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

function hid(kind: string, key: string): string {
  return `HYP_${kind}_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

// ------------------------------------------------------------- build

const B1_TYPE_MAP: Record<string, HypothesisType> = {
  TEST_COMPONENT_REWEIGHT: "COMPONENT_REWEIGHT_DIRECTION",
  TEST_COMPONENT_GUARD: "COMPONENT_INTERACTION_DIRECTION",
  TEST_COMPONENT_INTERACTION: "COMPONENT_INTERACTION_DIRECTION",
  TEST_PRICE_AWARE_SCORING: "PRICE_GUARD",
  TEST_TIMING_AWARE_ROUTING: "TIMING_GATE",
  TEST_FINE_TIMING_GATE: "TIMING_GATE",
  TEST_SPORT_ROUTING: "SPORT_SPECIALIST",
  TEST_MARKET_FAMILY_ROUTING: "RISK_CONCENTRATION_POLICY",
  CAPTURE_MISSING_COMPONENT: "DATA_CAPTURE_REQUIREMENT",
};

export function buildHypothesisRegistry(input: HypothesisRegistryInput): HypothesisRegistryResult {
  validateLineage(input);
  const { decomposition, dashboard, components, experiments } = input;

  const limitations: string[] = [
    "REGISTRY_ONLY: no candidate behavior, filters, or score weights changed",
    "no Champion, no model promotion, no live/production status",
    "no forward data, no walk-forward evaluation performed",
  ];

  // ---- evidence records ----
  const evidenceRecords: EvidenceRecord[] = [
    {
      evidenceId: "A1_DECOMPOSITION",
      phase: "A1",
      schemaVersion: decomposition.schemaVersion,
      engineVersion: decomposition.engineVersion,
      contentHash: decomposition.contentHash,
      corpusRawRows: decomposition.rawRowCount,
      corpusStrictDedupRows: decomposition.strictDedupRowCount,
      strictDedupPolicy: decomposition.strictDedupPolicy,
      supportsHypothesisIds: [],
      limitations: [],
    },
    {
      evidenceId: "A2_DASHBOARD",
      phase: "A2",
      schemaVersion: dashboard.schemaVersion,
      engineVersion: dashboard.engineVersion,
      contentHash: dashboard.contentHash,
      corpusRawRows: dashboard.corpusSummary.rawRowCount,
      corpusStrictDedupRows: dashboard.corpusSummary.strictDedupRowCount,
      strictDedupPolicy: null,
      supportsHypothesisIds: [],
      limitations: dashboard.limitations ?? [],
    },
    {
      evidenceId: "B1_COMPONENT_ANALYSIS",
      phase: "B1",
      schemaVersion: components.schemaVersion,
      engineVersion: components.engineVersion,
      contentHash: components.contentHash,
      corpusRawRows: components.corpusSummary.rawRowCount,
      corpusStrictDedupRows: components.corpusSummary.strictDedupRowCount,
      strictDedupPolicy: components.corpusSummary.strictDedupPolicy,
      supportsHypothesisIds: [],
      limitations: components.limitations,
    },
    {
      evidenceId: "B2A_BOUNDED_ROUTING",
      phase: "B2A",
      schemaVersion: experiments.schemaVersion,
      engineVersion: experiments.engineVersion,
      contentHash: experiments.contentHash,
      corpusRawRows: experiments.corpusSummary.rawRowCount,
      corpusStrictDedupRows: experiments.corpusSummary.strictDedupRowCount,
      strictDedupPolicy: experiments.corpusSummary.strictDedupPolicy,
      supportsHypothesisIds: [],
      limitations: experiments.limitations,
    },
  ];

  const hypotheses: HypothesisEntry[] = [];

  // ---- 1. model layer: exactly the 12 canonical models, no second copy ----
  const cohortByModel = new Map<string, { cohortId: string; canonicalVariantId: string; aliasVariantIds: string[]; selectionHash: string }>();
  for (const cohort of components.uniqueCohorts) {
    for (const modelId of [cohort.canonicalVariantId, ...cohort.aliasVariantIds]) {
      cohortByModel.set(modelId, cohort);
    }
  }
  const modelSummaryById = new Map(dashboard.modelSummaries.map((m) => [m.variantId, m]));
  const modelHypothesisIdByModelId = new Map<string, string>();

  for (const modelId of SCORECARD_MODEL_ORDER) {
    const hypothesisId = hid("MODEL", modelId);
    modelHypothesisIdByModelId.set(modelId, hypothesisId);
    const cohort = cohortByModel.get(modelId);
    const isCanonicalInCohort = cohort ? cohort.canonicalVariantId === modelId : true;
    const aliasModelIds = cohort && isCanonicalInCohort ? cohort.aliasVariantIds.filter((id) => id !== modelId) : [];
    const summary = modelSummaryById.get(modelId);
    const fingerprint = computeHypothesisFingerprint({
      type: modelId === BASELINE_VARIANT_ID ? "BASELINE_MODEL" : "FILTER_POLICY",
      scope: "CANONICAL_MODEL",
      parentFingerprint: null,
      conditions: { model_id: modelId },
    });
    hypotheses.push({
      hypothesisId,
      fingerprint,
      title: `Canonical historical model: ${modelId}`,
      type: modelId === BASELINE_VARIANT_ID ? "BASELINE_MODEL" : "FILTER_POLICY",
      scope: "CANONICAL_MODEL",
      definition: { modelId },
      parentHypothesisIds: [],
      relatedModelIds: [modelId],
      selectionHash: cohort?.selectionHash ?? null,
      aliasModelIds,
      sourceEvidenceIds: ["A1_DECOMPOSITION", "A2_DASHBOARD"],
      historicalMetrics: summary
        ? {
            selectedObservations: summary.selectedObservations,
            flatUnitPnl: round6(summary.flatUnitPnl),
            flatUnitRoi: round6(summary.flatUnitRoi),
            maximumDrawdownUnits: round6(summary.maximumDrawdownUnits),
            longestLosingStreak: summary.longestLosingStreak,
          }
        : null,
      historicalTriage: null,
      registryStatus: "OBSERVED_UNTESTED",
      promotionStatus: PROMOTION_STATUS,
      evidenceLayers: ["HISTORICAL_FULL_PERIOD"],
      duplicateStatus: isCanonicalInCohort ? "UNIQUE" : "ALIAS_MODEL",
      blockedReasons: [],
      nextRequiredGate: "REVIEW_ONLY",
      createdByPhase: "A1",
      lastEvaluatedPhase: "A2",
    });
  }

  // ---- 2. B1 evidence-direction layer (<= 10) ----
  const b1DirectionHypothesisIds: string[] = [];
  components.b2EvidenceDirections.forEach((dir: B2EvidenceDirection, index: number) => {
    const type = B1_TYPE_MAP[dir.type];
    if (!type) fail(`unknown B1 direction type: ${dir.type}`);
    const key = `${dir.type}:${dir.componentOrInteraction}:${index}`;
    const hypothesisId = hid("B1DIR", key);
    b1DirectionHypothesisIds.push(hypothesisId);
    const missingFieldsMentioned = [...MISSING_COMPONENT_FIELDS].filter(
      (f) => dir.componentOrInteraction.includes(f) || (dir.dataLimitation ?? "").includes(f),
    );
    const blocked = type === "DATA_CAPTURE_REQUIREMENT" || missingFieldsMentioned.length > 0;
    const fingerprint = computeHypothesisFingerprint({
      type,
      scope: "B1_EVIDENCE_DIRECTION",
      parentFingerprint: null,
      conditions: { direction_type: dir.type, component_or_interaction: dir.componentOrInteraction },
    });
    hypotheses.push({
      hypothesisId,
      fingerprint,
      title: `B1 direction: ${dir.type} (${dir.componentOrInteraction})`,
      type,
      scope: "B1_EVIDENCE_DIRECTION",
      definition: { directionType: dir.type, componentOrInteraction: dir.componentOrInteraction, reason: dir.reason },
      parentHypothesisIds: [],
      relatedModelIds: [],
      selectionHash: null,
      aliasModelIds: [],
      sourceEvidenceIds: ["B1_COMPONENT_ANALYSIS"],
      historicalMetrics: {
        selectedObservations: dir.sampleRange.maxN,
        flatUnitPnl: round6(dir.totalPnl),
        flatUnitRoi: round6(dir.medianRoi),
        maximumDrawdownUnits: null,
        longestLosingStreak: null,
      },
      historicalTriage: null,
      registryStatus: blocked ? "BLOCKED_MISSING_DATA" : "OBSERVED_UNTESTED",
      promotionStatus: PROMOTION_STATUS,
      evidenceLayers: blocked ? ["HISTORICAL_FULL_PERIOD", "MISSING_COMPONENT_CAPTURE_REQUIRED"] : ["HISTORICAL_FULL_PERIOD"],
      duplicateStatus: "UNIQUE",
      blockedReasons: blocked
        ? missingFieldsMentioned.length > 0
          ? missingFieldsMentioned
          : (dir.dataLimitation ? [dir.dataLimitation] : ["missing_historical_component_not_fabricated"])
        : [],
      nextRequiredGate: blocked ? "MISSING_COMPONENT_CAPTURE" : "BOUNDED_FOLLOWUP",
      createdByPhase: "B1",
      lastEvaluatedPhase: "B1",
    });
  });

  // ---- 3. B2A candidate layer: exactly the three frozen candidates ----
  const alt4HypothesisId = modelHypothesisIdByModelId.get("ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS")!;
  const candidateHypothesisIdByCandidateId = new Map<string, string>();
  const duplicateStatusMap: Record<string, DuplicateStatus> = {
    UNIQUE_SELECTION: "UNIQUE",
    EXACT_DUPLICATE_EXISTING_MODEL: "EXACT_SELECTION_DUPLICATE",
    EXACT_DUPLICATE_BATCH_CANDIDATE: "EXACT_SELECTION_DUPLICATE",
  };
  const candidateTypeById: Record<string, HypothesisType> = {
    B2_PRICE_FLOOR_030: "PRICE_GUARD",
    B2_TIMING_WITHIN_120M: "TIMING_GATE",
    B2_PRICE_FLOOR_030_TIMING_WITHIN_120M: "COMBINED_ROUTING_POLICY",
  };

  for (const def of experiments.candidateDefinitions as readonly CandidateDefinition[]) {
    const hypothesisId = hid("B2A", def.id);
    candidateHypothesisIdByCandidateId.set(def.id, hypothesisId);
  }

  for (const def of experiments.candidateDefinitions as readonly CandidateDefinition[]) {
    const hypothesisId = candidateHypothesisIdByCandidateId.get(def.id)!;
    const parentHypothesisId =
      def.parentId === "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS" ? alt4HypothesisId : candidateHypothesisIdByCandidateId.get(def.parentId)!;
    const parentEntry =
      def.parentId === "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS"
        ? hypotheses.find((h) => h.hypothesisId === alt4HypothesisId)!
        : hypotheses.find((h) => h.hypothesisId === parentHypothesisId);
    const metricsSrc = experiments.candidateMetrics.find((m) => m.id === def.id)!;
    const dup = experiments.duplicateAnalysis.find((d) => d.candidateId === def.id)!;
    const triage = experiments.triage.find((t) => t.candidateId === def.id)!;
    const type = candidateTypeById[def.id];
    const conditions: Record<string, number | string | boolean> = {};
    if (def.id === "B2_PRICE_FLOOR_030" || def.id === "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M") {
      conditions.entry_price_num_gte = 0.3;
    }
    if (def.id === "B2_TIMING_WITHIN_120M" || def.id === "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M") {
      conditions.hours_until_start_lt_minutes = 120;
    }
    const fingerprint = computeHypothesisFingerprint({
      type,
      scope: "B2A_BOUNDED_CANDIDATE",
      parentFingerprint: parentEntry?.fingerprint ?? null,
      conditions,
    });
    hypotheses.push({
      hypothesisId,
      fingerprint,
      title: `B2A bounded candidate: ${def.id}`,
      type,
      scope: "B2A_BOUNDED_CANDIDATE",
      definition: { candidateId: def.id, parentId: def.parentId, addedConditions: def.addedConditions },
      parentHypothesisIds: [parentHypothesisId],
      relatedModelIds: [def.id],
      selectionHash: metricsSrc.selectionHash,
      aliasModelIds: [],
      sourceEvidenceIds: ["B2A_BOUNDED_ROUTING"],
      historicalMetrics: {
        selectedObservations: metricsSrc.selectedObservations,
        flatUnitPnl: metricsSrc.flatUnitPnl,
        flatUnitRoi: metricsSrc.flatUnitRoi,
        maximumDrawdownUnits: metricsSrc.maximumDrawdownUnits,
        longestLosingStreak: metricsSrc.longestLosingStreak,
      },
      // Actual B2A per-candidate triage is preserved for reference; the C1
      // registry snapshot classifies all three frozen candidates uniformly
      // per the C1 phase directive below.
      historicalTriage: triage.status,
      registryStatus: "HISTORICAL_ADVANCE",
      promotionStatus: PROMOTION_STATUS,
      evidenceLayers: ["HISTORICAL_FULL_PERIOD", "FORWARD_PENDING", "WALK_FORWARD_DEFERRED"],
      duplicateStatus: duplicateStatusMap[dup.status],
      blockedReasons: [],
      nextRequiredGate: "INDEPENDENT_VALIDATION",
      createdByPhase: "B2A",
      lastEvaluatedPhase: "B2A",
    });
  }

  // ---- exact-fingerprint duplicate pass (registry-wide) ----
  const seenFingerprints = new Map<string, string>(); // fingerprint -> canonical hypothesisId
  for (const h of hypotheses) {
    const existing = seenFingerprints.get(h.fingerprint);
    if (existing && existing !== h.hypothesisId) {
      if (h.duplicateStatus === "UNIQUE") h.duplicateStatus = "EXACT_FINGERPRINT_DUPLICATE";
    } else {
      seenFingerprints.set(h.fingerprint, h.hypothesisId);
    }
  }

  // ---- model aliases ----
  const modelAliases: Array<{ canonicalModelId: string; aliasModelIds: string[] }> = [];
  for (const h of hypotheses) {
    if (h.scope === "CANONICAL_MODEL" && h.aliasModelIds.length > 0) {
      modelAliases.push({ canonicalModelId: h.relatedModelIds[0], aliasModelIds: [...h.aliasModelIds] });
    }
  }

  // ---- lineage graph ----
  const childrenByParent = new Map<string, string[]>();
  for (const h of hypotheses) {
    for (const parentId of h.parentHypothesisIds) {
      const arr = childrenByParent.get(parentId);
      if (arr) arr.push(h.hypothesisId);
      else childrenByParent.set(parentId, [h.hypothesisId]);
    }
  }
  const lineageGraph = hypotheses.map((h) => ({
    hypothesisId: h.hypothesisId,
    parentHypothesisIds: h.parentHypothesisIds,
    childHypothesisIds: childrenByParent.get(h.hypothesisId) ?? [],
  }));

  // ---- historical frontier (B2A candidates only, non-promotional) ----
  const candidateRows: FrontierRow[] = experiments.candidateMetrics.map((m) => ({
    candidateId: m.id,
    n: m.selectedObservations,
    pnl: m.flatUnitPnl,
    roi: m.flatUnitRoi,
    maxDD: m.maximumDrawdownUnits,
    longestLosingStreak: m.longestLosingStreak,
    selectionHash: m.selectionHash,
    triage: experiments.triage.find((t) => t.candidateId === m.id)!.status,
  }));

  function isDominated(a: FrontierRow, b: FrontierRow): boolean {
    // b dominates a if b is >= on pnl/roi and <= on maxDD, with at least one strictly better.
    const pnlA = a.pnl ?? Number.NEGATIVE_INFINITY;
    const pnlB = b.pnl ?? Number.NEGATIVE_INFINITY;
    const roiA = a.roi ?? Number.NEGATIVE_INFINITY;
    const roiB = b.roi ?? Number.NEGATIVE_INFINITY;
    const notWorse = pnlB >= pnlA && roiB >= roiA && b.maxDD <= a.maxDD;
    const strictlyBetter = pnlB > pnlA || roiB > roiA || b.maxDD < a.maxDD;
    return notWorse && strictlyBetter;
  }
  const historicalFrontier = [...candidateRows].sort((a, b) => {
    const aDominated = candidateRows.some((c) => c.candidateId !== a.candidateId && isDominated(a, c));
    const bDominated = candidateRows.some((c) => c.candidateId !== b.candidateId && isDominated(b, c));
    if (aDominated !== bDominated) return aDominated ? 1 : -1;
    const pnlDiff = (b.pnl ?? Number.NEGATIVE_INFINITY) - (a.pnl ?? Number.NEGATIVE_INFINITY);
    if (pnlDiff !== 0) return pnlDiff;
    const roiDiff = (b.roi ?? Number.NEGATIVE_INFINITY) - (a.roi ?? Number.NEGATIVE_INFINITY);
    if (roiDiff !== 0) return roiDiff;
    if (a.maxDD !== b.maxDD) return a.maxDD - b.maxDD;
    return a.candidateId.localeCompare(b.candidateId);
  });

  // ---- registry summary ----
  const registrySummary: RegistrySummary = {
    totalHypotheses: hypotheses.length,
    models: hypotheses.filter((h) => h.scope === "CANONICAL_MODEL").length,
    untested: hypotheses.filter((h) => h.registryStatus === "OBSERVED_UNTESTED").length,
    historicalAdvance: hypotheses.filter((h) => h.registryStatus === "HISTORICAL_ADVANCE").length,
    historicalHold: hypotheses.filter((h) => h.registryStatus === "HISTORICAL_HOLD").length,
    historicalReject: hypotheses.filter((h) => h.registryStatus === "HISTORICAL_REJECT").length,
    blockedMissingData: hypotheses.filter((h) => h.registryStatus === "BLOCKED_MISSING_DATA").length,
    deferred: hypotheses.filter((h) => h.registryStatus === "DEFERRED").length,
    duplicates: hypotheses.filter((h) => h.duplicateStatus !== "UNIQUE" && h.duplicateStatus !== "RELATED_NOT_DUPLICATE").length,
    forwardPending: hypotheses.filter((h) => h.evidenceLayers.includes("FORWARD_PENDING")).length,
    independentValidationRequired: hypotheses.filter((h) => h.nextRequiredGate === "INDEPENDENT_VALIDATION").length,
  };

  const candidateBudgetHistory: CandidateBudgetHistoryEntry[] = [
    {
      batch: "B2A",
      baseComparators: experiments.candidateBudget.baseComparators,
      candidates: experiments.candidateBudget.candidates,
      candidateIds: experiments.candidateDefinitions.map((d) => d.id),
    },
  ];

  const partial: Omit<HypothesisRegistryResult, "contentHash"> = {
    schemaVersion: HYPOTHESIS_REGISTRY_SCHEMA_VERSION,
    engineVersion: HYPOTHESIS_REGISTRY_ENGINE_VERSION,
    corpusSummary: {
      rawRowCount: decomposition.rawRowCount,
      strictDedupRowCount: decomposition.strictDedupRowCount,
      strictDedupPolicy: decomposition.strictDedupPolicy,
    },
    evidenceRecords,
    hypotheses,
    modelAliases,
    lineageGraph,
    historicalFrontier,
    registrySummary,
    candidateBudgetHistory,
    limitations,
  };

  const contentHash = createHash("sha256").update(JSON.stringify(partial)).digest("hex");
  void b1DirectionHypothesisIds;
  return { ...partial, contentHash };
}

// ------------------------------------------------------------- serializers

export function serializeHypothesisRegistryJson(result: HypothesisRegistryResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export interface HypothesisRegistryManifest {
  schemaVersion: number;
  engineVersion: string;
  decompositionSha256: string;
  dashboardSha256: string;
  componentsSha256: string;
  experimentsSha256: string;
  decompositionContentHash: string;
  dashboardContentHash: string;
  componentsContentHash: string;
  experimentsContentHash: string;
  strictDedupPolicy: string;
  rawRowCount: number;
  strictDedupRowCount: number;
  hypothesisCount: number;
  historicalAdvanceCount: number;
  blockedCount: number;
  registryContentHash: string;
  jsonSha256: string;
  htmlSha256: string;
  artifactSha256s: Record<string, string>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildHypothesisRegistryManifest(
  result: HypothesisRegistryResult,
  sourceHashes: { decompositionSha256: string; dashboardSha256: string; componentsSha256: string; experimentsSha256: string },
  jsonString: string,
  htmlString: string,
): HypothesisRegistryManifest {
  const jsonSha256 = sha256(jsonString);
  const htmlSha256 = sha256(htmlString);
  const decompositionRecord = result.evidenceRecords.find((e) => e.evidenceId === "A1_DECOMPOSITION")!;
  const dashboardRecord = result.evidenceRecords.find((e) => e.evidenceId === "A2_DASHBOARD")!;
  const componentsRecord = result.evidenceRecords.find((e) => e.evidenceId === "B1_COMPONENT_ANALYSIS")!;
  const experimentsRecord = result.evidenceRecords.find((e) => e.evidenceId === "B2A_BOUNDED_ROUTING")!;
  return {
    schemaVersion: result.schemaVersion,
    engineVersion: result.engineVersion,
    decompositionSha256: sourceHashes.decompositionSha256,
    dashboardSha256: sourceHashes.dashboardSha256,
    componentsSha256: sourceHashes.componentsSha256,
    experimentsSha256: sourceHashes.experimentsSha256,
    decompositionContentHash: decompositionRecord.contentHash,
    dashboardContentHash: dashboardRecord.contentHash,
    componentsContentHash: componentsRecord.contentHash,
    experimentsContentHash: experimentsRecord.contentHash,
    strictDedupPolicy: result.corpusSummary.strictDedupPolicy,
    rawRowCount: result.corpusSummary.rawRowCount,
    strictDedupRowCount: result.corpusSummary.strictDedupRowCount,
    hypothesisCount: result.hypotheses.length,
    historicalAdvanceCount: result.registrySummary.historicalAdvance,
    blockedCount: result.registrySummary.blockedMissingData,
    registryContentHash: result.contentHash,
    jsonSha256,
    htmlSha256,
    artifactSha256s: {
      "hypothesis_registry.json": jsonSha256,
      "hypothesis_registry.html": htmlSha256,
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

export function renderHypothesisRegistryHtml(result: HypothesisRegistryResult): string {
  const c = result;
  const summaryRows = Object.entries(c.registrySummary)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`)
    .join("");

  const frontierRows = c.historicalFrontier
    .map(
      (f) =>
        `<tr><td>${esc(f.candidateId)}</td><td>${f.n}</td><td>${num(f.pnl)}</td><td>${num(f.roi)}</td><td>${num(f.maxDD)}</td><td>${f.longestLosingStreak}</td><td>${esc(f.triage)}</td></tr>`,
    )
    .join("");

  const stateRows = c.hypotheses
    .map(
      (h) =>
        `<tr><td>${esc(h.hypothesisId)}</td><td>${esc(h.title)}</td><td>${esc(h.type)}</td><td>${esc(h.registryStatus)}</td><td>${esc(h.promotionStatus)}</td><td>${esc(h.duplicateStatus)}</td><td>${esc(h.nextRequiredGate)}</td></tr>`,
    )
    .join("");

  const lineageRows = c.lineageGraph
    .filter((l) => l.parentHypothesisIds.length > 0 || l.childHypothesisIds.length > 0)
    .map((l) => `<tr><td>${esc(l.hypothesisId)}</td><td>${esc(l.parentHypothesisIds.join(", ") || "--")}</td><td>${esc(l.childHypothesisIds.join(", ") || "--")}</td></tr>`)
    .join("");

  const aliasRows = c.modelAliases
    .map((a) => `<tr><td>${esc(a.canonicalModelId)}</td><td>${esc(a.aliasModelIds.join(", "))}</td></tr>`)
    .join("");
  const dupRows = c.hypotheses
    .filter((h) => h.duplicateStatus !== "UNIQUE")
    .map((h) => `<tr><td>${esc(h.hypothesisId)}</td><td>${esc(h.duplicateStatus)}</td></tr>`)
    .join("");

  const blockedRows = c.hypotheses
    .filter((h) => h.registryStatus === "BLOCKED_MISSING_DATA")
    .map((h) => `<tr><td>${esc(h.hypothesisId)}</td><td>${esc(h.title)}</td><td>${esc(h.blockedReasons.join(", "))}</td></tr>`)
    .join("");

  const deferredRows = c.hypotheses
    .filter((h) => h.registryStatus === "DEFERRED")
    .map((h) => `<tr><td>${esc(h.hypothesisId)}</td><td>${esc(h.title)}</td></tr>`)
    .join("");

  const gateRows = c.hypotheses
    .map((h) => `<tr><td>${esc(h.hypothesisId)}</td><td>${esc(h.nextRequiredGate)}</td></tr>`)
    .join("");

  const budgetRows = c.candidateBudgetHistory
    .map((b) => `<tr><td>${esc(b.batch)}</td><td>${b.baseComparators}</td><td>${b.candidates}</td><td>${esc(b.candidateIds.join(", "))}</td></tr>`)
    .join("");

  const evidenceRows = c.evidenceRecords
    .map(
      (e) =>
        `<tr><td>${esc(e.evidenceId)}</td><td>${esc(e.phase)}</td><td><code>${e.contentHash.slice(0, 16)}</code></td><td>${e.corpusRawRows}</td><td>${e.corpusStrictDedupRows}</td></tr>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Hypothesis Registry (C1)</title><style>
body{font-family:system-ui,Arial,sans-serif;margin:0;padding:24px;color:#1a1a1a;background:#fafafa;}
.banner{background:#7a1020;color:#fff;padding:14px 18px;border-radius:8px;font-weight:700;margin-bottom:20px;}
.banner div{font-size:13px;opacity:.9;}
h1{font-size:22px;} h2{font-size:18px;margin-top:32px;border-bottom:2px solid #ddd;padding-bottom:4px;}
table{border-collapse:collapse;width:100%;overflow-x:auto;display:block;font-size:12px;margin:8px 0;}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:right;white-space:nowrap;}
th:first-child,td:first-child{text-align:left;}
code{background:#eee;padding:1px 4px;border-radius:3px;}
@media (max-width:390px){body{padding:8px;} table{font-size:10px;}}
@media print{body{background:#fff;}}
</style></head><body>
<div class="banner">HYPOTHESIS REGISTRY — HISTORICAL RESEARCH ONLY<div>NO AUTOMATIC CHAMPION</div><div>NO MODEL PROMOTION</div><div>NO LIVE CHANGE</div></div>
<h1>Unified Hypothesis Registry</h1>

<h2>Corpus &amp; Evidence Lineage</h2>
<p>raw ${c.corpusSummary.rawRowCount} → strict-dedup ${c.corpusSummary.strictDedupRowCount} (${esc(c.corpusSummary.strictDedupPolicy)}) · registryContentHash <code>${c.contentHash.slice(0, 16)}</code></p>
<table><tr><th>evidence</th><th>phase</th><th>contentHash</th><th>rawRows</th><th>dedupRows</th></tr>${evidenceRows}</table>

<h2>Registry Summary</h2>
<table><tr><th>metric</th><th>value</th></tr>${summaryRows}</table>

<h2>B2A Historical Frontier</h2>
<table><tr><th>candidate</th><th>N</th><th>PnL</th><th>ROI%</th><th>maxDD</th><th>lossStreak</th><th>triage</th></tr>${frontierRows}</table>

<h2>Hypothesis State Table</h2>
<table><tr><th>id</th><th>title</th><th>type</th><th>registryStatus</th><th>promotionStatus</th><th>duplicateStatus</th><th>nextGate</th></tr>${stateRows}</table>

<h2>Parent-Child Lineage Graph</h2>
<table><tr><th>hypothesis</th><th>parents</th><th>children</th></tr>${lineageRows}</table>

<h2>Duplicate and Alias Map</h2>
<h3>Model aliases (B1)</h3>
<table><tr><th>canonical model</th><th>alias models</th></tr>${aliasRows}</table>
<h3>Duplicate hypotheses</h3>
<table><tr><th>id</th><th>status</th></tr>${dupRows}</table>

<h2>Blocked-Data Hypotheses</h2>
<table><tr><th>id</th><th>title</th><th>reasons</th></tr>${blockedRows}</table>

<h2>Deferred Hypotheses</h2>
<table><tr><th>id</th><th>title</th></tr>${deferredRows}</table>

<h2>Next Required Gate</h2>
<table><tr><th>id</th><th>gate</th></tr>${gateRows}</table>

<h2>Candidate-Budget History</h2>
<table><tr><th>batch</th><th>baseComparators</th><th>candidates</th><th>candidateIds</th></tr>${budgetRows}</table>

<h2>Limitations</h2>
<ul>${c.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
</body></html>
`;
}
