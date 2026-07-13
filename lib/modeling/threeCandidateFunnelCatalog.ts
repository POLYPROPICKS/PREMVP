// Three-candidate executable funnel catalog builder (Phase 3E.8A).
//
// Produces a machine-readable catalog of the three active candidates
// (PRIMARY_V1_AVOID_NBA_NHL_COV_CAP, ALT2_TS_SCORE_GE_65,
// ALT1_CANONICAL_EVENT_GROUPING) by DERIVING every step descriptor from the
// classifier's own orderedFunnel records -- the same records the evaluator
// (lib/modeling/historicalFunnelVariants.ts) dispatches on. Because the
// documentation is derived from the source of truth, documented order and
// behavior cannot drift from executed order and behavior. This module
// documents; it never changes a predicate, threshold, or the classifier.
// Pure: no fs/env/network access.

import {
  getBundle,
  type ExecutableFunnelClassifier,
  type BundleRecord,
  type FunnelStep,
} from "./executableFunnelClassifier";
import { EVENT_GROUP_KEY_FIELD_PRIORITY } from "./eventGroupSelection";

export const THREE_CANDIDATE_IDS = [
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT2_TS_SCORE_GE_65",
  "ALT1_CANONICAL_EVENT_GROUPING",
] as const;

export const FILTER_TAXONOMY_CATEGORIES = [
  "ELIGIBILITY_GATE",
  "NUMERIC_THRESHOLD",
  "CATEGORY_EXCLUSION",
  "DERIVED_BUCKET_EXCLUSION",
  "TIME_WINDOW_EXCLUSION",
  "SORT_PRIORITY",
  "EVENT_GROUPING",
  "ROW_SELECTION",
  "STAKE_POLICY",
  "METADATA_ONLY",
] as const;
export type FilterTaxonomyCategory = (typeof FILTER_TAXONOMY_CATEGORIES)[number];

export type CatalogAction = "REQUIRE" | "EXCLUDE" | "SORT" | "GROUP" | "KEEP" | "STAKE" | "ANNOTATE";

export type MissingDataBehavior =
  | "FAIL_CLOSED"
  | "PASS_OPEN"
  | "BLOCK_VARIANT"
  | "SORT_AS_ZERO"
  | "NOT_APPLICABLE";

const EVENT_GROUP_PRIORITY: readonly string[] = EVENT_GROUP_KEY_FIELD_PRIORITY;

export interface CatalogStep {
  stepNumber: number;
  classifierAction: FunnelStep["action"];
  action: CatalogAction;
  taxonomyCategory: FilterTaxonomyCategory;
  semanticPurpose: string;
  fieldSemantic: string | null;
  physicalSourcePaths: string[];
  operator: string;
  thresholdOrRule: unknown;
  missingDataBehavior: MissingDataBehavior;
  evaluatorHandler: string;
  changesRowCount: boolean;
  countedAsActiveFilter: boolean;
  sourceEvidence: Array<{ file: string; symbol: string }>;
  limitationFlags: string[];
}

export interface CatalogCandidate {
  variantId: string;
  displayRole: string;
  runStatus: string;
  executionStatus: string;
  identityConfidence: "MEDIUM" | "STRONG" | "WEAK" | "NOT_APPLICABLE";
  formulaModel: string | null;
  orderedSteps: CatalogStep[];
  activeFilterCount: number;
  rowReducingStepCount: number;
  orderingStepCount: number;
  groupingStepCount: number;
  knownLimitations: string[];
  robustnessObservations: string[];
}

export type OverlapValue = "YES" | "NO" | "PARTIAL" | "NOT_APPLICABLE" | "DATA_BLOCKED";

export interface OverlapRow {
  rule: string;
  PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: OverlapValue;
  ALT2_TS_SCORE_GE_65: OverlapValue;
  ALT1_CANONICAL_EVENT_GROUPING: OverlapValue;
}

export interface SemanticFieldRow {
  semanticField: string;
  physicalSource: string;
  adapter: string;
  PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: OverlapValue;
  ALT2_TS_SCORE_GE_65: OverlapValue;
  ALT1_CANONICAL_EVENT_GROUPING: OverlapValue;
  missingBehavior: string;
}

export interface ThreeCandidateFunnelCatalog {
  schemaVersion: 1;
  generatedFrom: { classifierSchemaVersion: number; candidateIds: string[]; derivedFrom: string };
  candidates: CatalogCandidate[];
  overlapMatrix: OverlapRow[];
  semanticFieldMatrix: SemanticFieldRow[];
  unresolvedDataDependencies: string[];
}

const DISPLAY_ROLE: Record<string, string> = {
  PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: "SELECTIVE_RESEARCH_CANDIDATE",
  ALT2_TS_SCORE_GE_65: "MANDATORY_CORE_COMPARATOR",
  ALT1_CANONICAL_EVENT_GROUPING: "STRONG_WATCH_EVENT_GROUPING_CANDIDATE",
};

function fieldSemanticOf(step: FunnelStep): string | null {
  switch (step.field) {
    case "signal_confidence_num":
      return "score";
    case "data_coverage_num":
      return "coverage";
    case "data_coverage_num+entry_price_num":
      return "coverage+entry_price";
    case "league":
      return "league";
    case "hours_until_start_num":
      return "timing";
    case "signal_result":
      return "result";
    case "eventGroupKey":
      return "event_identity";
    default:
      return null;
  }
}

function taxonomyOf(step: FunnelStep): FilterTaxonomyCategory {
  switch (step.action) {
    case "INPUT":
    case "CALCULATE":
    case "OUTPUT":
      return "METADATA_ONLY";
    case "REQUIRE":
      if (step.field === null && step.exactRule && (step.exactRule as { predicate?: string }).predicate === "isAllowed(r)") {
        return "ELIGIBILITY_GATE";
      }
      return "NUMERIC_THRESHOLD";
    case "EXCLUDE":
      if (step.field === "league") return "CATEGORY_EXCLUSION";
      if (step.field === "data_coverage_num+entry_price_num") return "DERIVED_BUCKET_EXCLUSION";
      if (step.field === "hours_until_start_num") return "TIME_WINDOW_EXCLUSION";
      return "CATEGORY_EXCLUSION";
    case "ORDER":
      return "SORT_PRIORITY";
    case "GROUP":
      return "EVENT_GROUPING";
    case "KEEP":
      return "ROW_SELECTION";
    case "STAKE":
      return "STAKE_POLICY";
    default:
      return "METADATA_ONLY";
  }
}

function catalogActionOf(step: FunnelStep): CatalogAction {
  switch (step.action) {
    case "REQUIRE":
      return "REQUIRE";
    case "EXCLUDE":
      return "EXCLUDE";
    case "ORDER":
      return "SORT";
    case "GROUP":
      return "GROUP";
    case "KEEP":
      return "KEEP";
    case "STAKE":
      return "STAKE";
    default:
      return "ANNOTATE";
  }
}

function operatorOf(step: FunnelStep, taxonomy: FilterTaxonomyCategory): string {
  const rule = (step.exactRule ?? {}) as Record<string, unknown>;
  if (taxonomy === "ELIGIBILITY_GATE") return "CUSTOM_PREDICATE";
  if (taxonomy === "NUMERIC_THRESHOLD" && rule.operator === ">=") return ">=";
  if (step.field === "league") return "REGEX_EXCLUDE";
  if (step.field === "data_coverage_num+entry_price_num") return "DERIVED_RANGE_EXCLUDE";
  if (step.field === "hours_until_start_num") return "DERIVED_RANGE_EXCLUDE";
  if (step.field === "signal_result" && rule.operator === "!=") return "!=";
  if (step.action === "ORDER") return "SORT_DESC";
  if (step.action === "GROUP") return "GROUP_BY";
  if (step.action === "KEEP") return "KEEP_FIRST";
  return "CUSTOM_PREDICATE";
}

function physicalSourcePathsOf(fieldSemantic: string | null, step: FunnelStep): string[] {
  switch (fieldSemantic) {
    case "score":
      return ["signal_confidence_num", "score", "signal_score", "pre_event_score_num"];
    case "coverage":
      return ["diagnostics.dataCoverage"];
    case "coverage+entry_price":
      return ["diagnostics.dataCoverage", "entry_price_num"];
    case "league":
      return ["market_slug", "event_slug"];
    case "timing":
      return ["diagnostics.gameStartIso", "created_at"];
    case "result":
      return ["signal_result"];
    case "event_identity":
      return [...EVENT_GROUP_PRIORITY];
    default:
      // eligibility gate reads metric_formula_version.
      if (step.field === null && (step.exactRule as { predicate?: string })?.predicate === "isAllowed(r)") {
        return ["metric_formula_version"];
      }
      return [];
  }
}

function missingDataBehaviorOf(step: FunnelStep, taxonomy: FilterTaxonomyCategory): MissingDataBehavior {
  switch (taxonomy) {
    case "ELIGIBILITY_GATE":
      return "FAIL_CLOSED";
    case "NUMERIC_THRESHOLD":
      return "FAIL_CLOSED"; // getScoreValue/getCoverageValue null -> removed
    case "CATEGORY_EXCLUSION":
    case "DERIVED_BUCKET_EXCLUSION":
    case "TIME_WINDOW_EXCLUSION":
      return "PASS_OPEN"; // missing field -> predicate not matched -> row kept
    case "SORT_PRIORITY":
      return "SORT_AS_ZERO"; // getScoreOrZero/getCoverageOrZero
    default:
      return "NOT_APPLICABLE";
  }
}

function evaluatorHandlerOf(step: FunnelStep, taxonomy: FilterTaxonomyCategory): string {
  switch (taxonomy) {
    case "ELIGIBILITY_GATE":
      return "applyRequire -> isAllowedFormulaVersion";
    case "NUMERIC_THRESHOLD":
      return step.field === "data_coverage_num"
        ? "applyRequire -> getCoverageValue >= threshold"
        : "applyRequire -> getScoreValue >= threshold";
    case "CATEGORY_EXCLUSION":
      if (step.field === "league") return "applyExclude -> isNbaOrNhl (regex over market_slug+event_slug)";
      if (step.field === "signal_result") return "applyExclude -> signal_result !== 'VOID'";
      return "applyExclude";
    case "DERIVED_BUCKET_EXCLUSION":
      return "applyExclude -> isBadBucket (coverage 50-74 AND price 0.44-0.58)";
    case "TIME_WINDOW_EXCLUSION":
      return "applyExclude -> getHoursUntilStartValue in [6,24)";
    case "SORT_PRIORITY":
      return "flushOrder -> getScoreOrZero/getCoverageOrZero";
    case "EVENT_GROUPING":
      return "groupRowsByEventGroup -> buildEventGroupKey";
    case "ROW_SELECTION":
      return (step.exactRule as { keep?: string })?.keep === "all_eligible"
        ? "keep-all passthrough (no reduction)"
        : "selectFirstPerEventGroup (first per group)";
    case "STAKE_POLICY":
      return "stakePrimary (diagnostic metadata only; never removes rows)";
    default:
      return "n/a";
  }
}

function changesRowCountOf(step: FunnelStep, taxonomy: FilterTaxonomyCategory): boolean {
  if (taxonomy === "ELIGIBILITY_GATE" || taxonomy === "NUMERIC_THRESHOLD") return true;
  if (taxonomy === "CATEGORY_EXCLUSION" || taxonomy === "DERIVED_BUCKET_EXCLUSION" || taxonomy === "TIME_WINDOW_EXCLUSION") return true;
  if (taxonomy === "ROW_SELECTION") {
    return (step.exactRule as { keep?: string })?.keep !== "all_eligible";
  }
  return false;
}

const ACTIVE_FILTER_TAXONOMIES = new Set<FilterTaxonomyCategory>([
  "ELIGIBILITY_GATE",
  "NUMERIC_THRESHOLD",
  "CATEGORY_EXCLUSION",
  "DERIVED_BUCKET_EXCLUSION",
  "TIME_WINDOW_EXCLUSION",
]);

function buildStep(step: FunnelStep): CatalogStep {
  const taxonomy = taxonomyOf(step);
  const fieldSemantic = fieldSemanticOf(step);
  const changesRowCount = changesRowCountOf(step, taxonomy);
  return {
    stepNumber: step.step,
    classifierAction: step.action,
    action: catalogActionOf(step),
    taxonomyCategory: taxonomy,
    semanticPurpose: step.plainLanguage,
    fieldSemantic,
    physicalSourcePaths: physicalSourcePathsOf(fieldSemantic, step),
    operator: operatorOf(step, taxonomy),
    thresholdOrRule: step.exactRule,
    missingDataBehavior: missingDataBehaviorOf(step, taxonomy),
    evaluatorHandler: evaluatorHandlerOf(step, taxonomy),
    changesRowCount,
    countedAsActiveFilter: ACTIVE_FILTER_TAXONOMIES.has(taxonomy),
    sourceEvidence: step.sourceEvidence.map((e) => ({ file: e.path ?? "", symbol: e.symbol ?? "" })),
    limitationFlags: step.currentDatasetAvailability === "AVAILABLE_VIA_DIAGNOSTICS" ? ["FIELD_ONLY_IN_DIAGNOSTICS_JSON"] : [],
  };
}

function robustnessObservationsOf(variantId: string): string[] {
  if (variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP") {
    return [
      "Analysis metadata only (no behavior change): the score >= 72 numeric threshold produced the dominant historical row-reduction contribution in the robustness audit; the NBA/NHL, bad-bucket, and timing exclusions contributed comparatively little on the observed corpus.",
      "Model name wording ('AVOID_NBA_NHL_COV_CAP') emphasizes the exclusions, but the measured filter contribution is dominated by the score gate -- name wording and measured contribution are distinct.",
    ];
  }
  if (variantId === "ALT2_TS_SCORE_GE_65") {
    return [
      "Weekly PnL concentration requires continued observation before any promotion.",
      "This is the exact TS score>=65 variant with no smart-money guard; it is NOT the Python smart-money variant.",
    ];
  }
  return [
    "Event identity uses the canonical buildEventGroupKey helper; identity confidence is MEDIUM (event_slug tier) -- exploratory only, not production-grade.",
  ];
}

function identityConfidenceOf(bundle: BundleRecord): CatalogCandidate["identityConfidence"] {
  const hasGrouping = bundle.orderedFunnel.some((s) => s.action === "GROUP");
  return hasGrouping ? "MEDIUM" : "NOT_APPLICABLE";
}

function buildCandidate(classifier: ExecutableFunnelClassifier, variantId: string): CatalogCandidate {
  const bundle = getBundle(classifier, variantId);
  if (!bundle) throw new Error(`three-candidate catalog: unknown bundle ${variantId}`);
  const orderedSteps = bundle.orderedFunnel.map(buildStep);
  return {
    variantId,
    displayRole: DISPLAY_ROLE[variantId] ?? "UNSPECIFIED",
    runStatus: bundle.runStatus,
    executionStatus: bundle.runStatus === "AMBIGUOUS_ALIAS_NOT_EXECUTABLE" ? "NOT_EXECUTABLE" : "EXECUTABLE",
    identityConfidence: identityConfidenceOf(bundle),
    formulaModel: bundle.formulaModelId,
    orderedSteps,
    activeFilterCount: orderedSteps.filter((s) => s.countedAsActiveFilter).length,
    rowReducingStepCount: orderedSteps.filter((s) => s.changesRowCount).length,
    orderingStepCount: orderedSteps.filter((s) => s.taxonomyCategory === "SORT_PRIORITY").length,
    groupingStepCount: orderedSteps.filter((s) => s.taxonomyCategory === "EVENT_GROUPING").length,
    knownLimitations: bundle.plainLanguageBlocker ? [bundle.plainLanguageBlocker] : [],
    robustnessObservations: robustnessObservationsOf(variantId),
  };
}

// ---- Overlap + semantic matrices (derived from the built candidates) ----

function hasStep(c: CatalogCandidate, predicate: (s: CatalogStep) => boolean): boolean {
  return c.orderedSteps.some(predicate);
}

function scoreThreshold(c: CatalogCandidate): number | null {
  const s = c.orderedSteps.find((x) => x.fieldSemantic === "score" && x.taxonomyCategory === "NUMERIC_THRESHOLD");
  return s ? (s.thresholdOrRule as { value: number }).value : null;
}

function referencesSmartMoneyInSort(c: CatalogCandidate): boolean {
  return c.orderedSteps.some(
    (s) => s.taxonomyCategory === "SORT_PRIORITY" && JSON.stringify(s.thresholdOrRule).includes("smartMoney"),
  );
}

function buildOverlapMatrix(cs: CatalogCandidate[]): OverlapRow[] {
  const byId = new Map(cs.map((c) => [c.variantId, c]));
  const P = byId.get("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const A2 = byId.get("ALT2_TS_SCORE_GE_65")!;
  const A1 = byId.get("ALT1_CANONICAL_EVENT_GROUPING")!;

  const row = (
    rule: string,
    p: OverlapValue,
    a2: OverlapValue,
    a1: OverlapValue,
  ): OverlapRow => ({
    rule,
    PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: p,
    ALT2_TS_SCORE_GE_65: a2,
    ALT1_CANONICAL_EVENT_GROUPING: a1,
  });

  const yn = (b: boolean): OverlapValue => (b ? "YES" : "NO");
  const geN = (c: CatalogCandidate, n: number): OverlapValue => (scoreThreshold(c) === n ? "YES" : "NO");
  const coverageUse = (c: CatalogCandidate): OverlapValue =>
    hasStep(c, (s) => (s.fieldSemantic ?? "").includes("coverage")) ? "YES" : "NO";
  const smartMoney = (c: CatalogCandidate): OverlapValue =>
    referencesSmartMoneyInSort(c) ? "DATA_BLOCKED" : "NO";

  return [
    row("formula_eligibility", yn(hasStep(P, (s) => s.taxonomyCategory === "ELIGIBILITY_GATE")), yn(hasStep(A2, (s) => s.taxonomyCategory === "ELIGIBILITY_GATE")), yn(hasStep(A1, (s) => s.taxonomyCategory === "ELIGIBILITY_GATE"))),
    row("score_ge_65", geN(P, 65), geN(A2, 65), geN(A1, 65)),
    row("score_ge_72", geN(P, 72), geN(A2, 72), geN(A1, 72)),
    row("coverage", coverageUse(P), coverageUse(A2), coverageUse(A1)),
    row("entry_price_bucket", yn(hasStep(P, (s) => s.taxonomyCategory === "DERIVED_BUCKET_EXCLUSION")), yn(hasStep(A2, (s) => s.taxonomyCategory === "DERIVED_BUCKET_EXCLUSION")), yn(hasStep(A1, (s) => s.taxonomyCategory === "DERIVED_BUCKET_EXCLUSION"))),
    row("nba_nhl_exclusion", yn(hasStep(P, (s) => s.taxonomyCategory === "CATEGORY_EXCLUSION" && s.fieldSemantic === "league")), yn(hasStep(A2, (s) => s.taxonomyCategory === "CATEGORY_EXCLUSION" && s.fieldSemantic === "league")), yn(hasStep(A1, (s) => s.taxonomyCategory === "CATEGORY_EXCLUSION" && s.fieldSemantic === "league"))),
    row("timing_exclusion", yn(hasStep(P, (s) => s.taxonomyCategory === "TIME_WINDOW_EXCLUSION")), yn(hasStep(A2, (s) => s.taxonomyCategory === "TIME_WINDOW_EXCLUSION")), yn(hasStep(A1, (s) => s.taxonomyCategory === "TIME_WINDOW_EXCLUSION"))),
    row("event_grouping", yn(hasStep(P, (s) => s.taxonomyCategory === "EVENT_GROUPING")), yn(hasStep(A2, (s) => s.taxonomyCategory === "EVENT_GROUPING")), yn(hasStep(A1, (s) => s.taxonomyCategory === "EVENT_GROUPING"))),
    row("one_row_per_event_keep", yn(hasStep(P, (s) => s.taxonomyCategory === "ROW_SELECTION" && s.changesRowCount)), yn(hasStep(A2, (s) => s.taxonomyCategory === "ROW_SELECTION" && s.changesRowCount)), yn(hasStep(A1, (s) => s.taxonomyCategory === "ROW_SELECTION" && s.changesRowCount))),
    row("smart_money", smartMoney(P), smartMoney(A2), smartMoney(A1)),
    row("stake_adjustment", "NO", "NO", "NO"),
  ];
}

function buildSemanticFieldMatrix(cs: CatalogCandidate[]): SemanticFieldRow[] {
  const byId = new Map(cs.map((c) => [c.variantId, c]));
  const P = byId.get("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const A2 = byId.get("ALT2_TS_SCORE_GE_65")!;
  const A1 = byId.get("ALT1_CANONICAL_EVENT_GROUPING")!;

  const usesSemantic = (c: CatalogCandidate, sem: string): OverlapValue =>
    c.orderedSteps.some((s) => (s.fieldSemantic ?? "").includes(sem)) ? "YES" : "NO";

  return [
    { semanticField: "formula version", physicalSource: "metric_formula_version", adapter: "isAllowedFormulaVersion", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: "NO", ALT2_TS_SCORE_GE_65: "NO", ALT1_CANONICAL_EVENT_GROUPING: "NO", missingBehavior: "not gated by any of the three candidates (eligibility gate is only present in ALT_SM_GUARD)" },
    { semanticField: "score", physicalSource: "signal_confidence_num -> score -> signal_score -> pre_event_score_num", adapter: "getScoreValue", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: usesSemantic(P, "score"), ALT2_TS_SCORE_GE_65: usesSemantic(A2, "score"), ALT1_CANONICAL_EVENT_GROUPING: usesSemantic(A1, "score"), missingBehavior: "FAIL_CLOSED on REQUIRE; SORT_AS_ZERO on ordering" },
    { semanticField: "coverage", physicalSource: "diagnostics.dataCoverage", adapter: "getCoverageValue", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: usesSemantic(P, "coverage"), ALT2_TS_SCORE_GE_65: usesSemantic(A2, "coverage"), ALT1_CANONICAL_EVENT_GROUPING: usesSemantic(A1, "coverage"), missingBehavior: "FAIL_CLOSED on REQUIRE; PASS_OPEN inside bad-bucket; SORT_AS_ZERO on ordering" },
    { semanticField: "entry price", physicalSource: "entry_price_num", adapter: "getEntryPrice", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: usesSemantic(P, "entry_price"), ALT2_TS_SCORE_GE_65: "NO", ALT1_CANONICAL_EVENT_GROUPING: "NO", missingBehavior: "PASS_OPEN inside bad-bucket exclusion" },
    { semanticField: "league", physicalSource: "market_slug + event_slug", adapter: "isNbaOrNhl (regex)", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: usesSemantic(P, "league"), ALT2_TS_SCORE_GE_65: "NO", ALT1_CANONICAL_EVENT_GROUPING: "NO", missingBehavior: "PASS_OPEN (no slug -> not matched -> kept)" },
    { semanticField: "timing", physicalSource: "diagnostics.gameStartIso - created_at", adapter: "getHoursUntilStartValue", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: usesSemantic(P, "timing"), ALT2_TS_SCORE_GE_65: "NO", ALT1_CANONICAL_EVENT_GROUPING: "NO", missingBehavior: "PASS_OPEN (no timestamps -> not excluded)" },
    { semanticField: "event identity", physicalSource: EVENT_GROUP_PRIORITY.join(" -> "), adapter: "buildEventGroupKey", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: usesSemantic(P, "event_identity"), ALT2_TS_SCORE_GE_65: "NO", ALT1_CANONICAL_EVENT_GROUPING: usesSemantic(A1, "event_identity"), missingBehavior: "collapses to condition_id fallback; MEDIUM confidence at event_slug tier" },
    { semanticField: "condition/token identity", physicalSource: "condition_id + token_id", adapter: "getStrictDedupKeyForExportRow (applied at dedup, before funnels)", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: "YES", ALT2_TS_SCORE_GE_65: "YES", ALT1_CANONICAL_EVENT_GROUPING: "YES", missingBehavior: "row excluded from the deduplicated corpus entirely" },
    { semanticField: "smart money", physicalSource: "smart_money_score_num", adapter: "getSmartMoneyValue", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: referencesSmartMoneyInSort(P) ? "DATA_BLOCKED" : "NO", ALT2_TS_SCORE_GE_65: "NO", ALT1_CANONICAL_EVENT_GROUPING: referencesSmartMoneyInSort(A1) ? "DATA_BLOCKED" : "NO", missingBehavior: "0% coverage in current canonical export; not used by ALT2 TS; smart-money variants remain unvalidated" },
    { semanticField: "result", physicalSource: "signal_result", adapter: "classifyResolvedOutcome (roiPnlContract)", PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: "YES", ALT2_TS_SCORE_GE_65: "YES", ALT1_CANONICAL_EVENT_GROUPING: "YES", missingBehavior: "unresolved rows excluded from ROI, not a loss" },
  ];
}

export interface BuildOptions {
  classifier: ExecutableFunnelClassifier;
  candidateIds: readonly string[];
}

/**
 * Builds the three-candidate funnel catalog by deriving each step descriptor
 * from the classifier's orderedFunnel records. Pure and deterministic; no
 * fs/env/network access; never mutates the classifier.
 */
export function buildThreeCandidateFunnelCatalog(options: BuildOptions): ThreeCandidateFunnelCatalog {
  const { classifier, candidateIds } = options;
  const candidates = candidateIds.map((id) => buildCandidate(classifier, id));

  return {
    schemaVersion: 1,
    generatedFrom: {
      classifierSchemaVersion: classifier.schemaVersion,
      candidateIds: [...candidateIds],
      derivedFrom: "classifier.orderedFunnel (same records the evaluator dispatches on)",
    },
    candidates,
    overlapMatrix: buildOverlapMatrix(candidates),
    semanticFieldMatrix: buildSemanticFieldMatrix(candidates),
    unresolvedDataDependencies: [
      "smart_money_score_num absent from the canonical export (0% coverage) -> smart-money ordering tie-breaks and smart-money variants remain unvalidated.",
      "coverage/timing/league fields live in the diagnostics JSON blob, not flat physical columns -> depend on the diagnostics blob being exported intact.",
    ],
  };
}
