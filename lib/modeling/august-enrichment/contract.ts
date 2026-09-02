/**
 * AUGUST_ENRICHED_RESEARCH_DATASET_V1 — frozen enrichment contract.
 *
 * Deterministic, LLM-free. This module encodes ONLY:
 *   - the identity of the existing accepted August research BASE population,
 *   - the already-persisted historical enrichment sources,
 *   - the exact (non-fuzzy) join keys,
 *   - the point-in-time safety rule,
 *   - the feature semantics registry, including features proven
 *     NOT_RECOVERABLE for the August cohort by a frozen authoritative audit.
 *
 * It does NOT create a new base population, does not reconstruct history,
 * does not touch C1/C4/C5, and never imputes a missing value.
 */

export const AUGUST_ENRICHED_CONTRACT_VERSION = "august-enriched-research-dataset-v1" as const;
export const NEXT_SEMANTIC_TRANSITION = "RICH_AUGUST_C4_ATTRIBUTE_RECHECK_V2" as const;

/**
 * The existing accepted August research population. NOT created here.
 * Membership, decision timestamp, event start, sport, settlement and the
 * existing C4 eligibility lineage all remain authoritative from this base.
 *
 * This is the identical 18,705 physical-provider-event population that
 * AUGUST_MARKET_FAMILY_PNL_LAB_V1 and the August subset of
 * summer_research_feature_authority_v1 operate on.
 */
export const AUGUST_BASE_POPULATION = {
  id: "EXPANDED_STRATEGIC_T90_MODELING_V1__AUGUST",
  scoreProducerPopulation: "shadow-strategic-sports-v1",
  producerPredicate:
    "generated_signal_pairs WHERE formula_version = 'shadow-strategic-sports-v1'",
  rowUnit: "physical_provider_event",
  onePerPhysicalEvent: true,
  expectedRowCount: 18705,
  laneFiles: {
    train: "expanded_strategic_t90_modeling_v1/train.jsonl",
    validation: "expanded_strategic_t90_modeling_v1/validation.jsonl",
    untouched_test: "expanded_strategic_t90_modeling_v1/untouched_test.jsonl",
  },
  laneArtifactSha256: {
    "train.jsonl":
      "410d1165507c33b3190172d1059f8cf1e4f05bce1a0e1116ca5903457fc9ec2b",
    "validation.jsonl":
      "cbd19811dba8c0fb4c0a617491a25c6f6c51987c08f23520c2a4c0bc5b97c836",
    "untouched_test.jsonl":
      "cdaca7b00b6b1f829742fa4f9710ec10dbdab52517afdff25e23266ed82691bf",
  },
  /** Authoritative base identity key (== generated_signal_pairs.id). */
  identityKey: "id",
  /** Physical-event grouping key retained for lineage only. */
  physicalEventKey: "provider_event_id",
  /** The decision timestamp every point-in-time join is gated against. */
  decisionTimestampField: "created_at",
} as const;

/**
 * Already-persisted historical enrichment sources. Each row of every source
 * is the frozen contemporaneous clone of the SAME research row
 * (`source_row_id -> clone public.generated_signal_pairs.id`), so a value
 * joined by exact `id` was known at that row's decision timestamp.
 */
export const ENRICHMENT_SOURCES = {
  replayInputs: {
    id: "expanded_strategic_t90_replay_inputs_v1",
    file: "expanded_strategic_t90_replay_inputs_v1/replay_inputs_v1.jsonl",
    sha256: "bfe4e377b7fe4cfdcf869855cf077caf330647f335d387b02b097110734394ad",
    joinKey: { base: "id", source: "source_row_id" },
    lineage: "source_row_id -> clone public.generated_signal_pairs.id (exact)",
  },
  taxonomyV2: {
    id: "expanded_strategic_t90_taxonomy_v2",
    file: "expanded_strategic_t90_taxonomy_v2/taxonomy_v2.jsonl",
    sha256: "2079e392084b5acf52cf4107d67273878df137a262dbcdacfd3db0a2962b2407",
    joinKey: { base: "id", source: "source_row_id" },
    lineage:
      "FROZEN_TAXONOMY_V1 explicit metadata; provider_event_id -> exact Gamma event.id; no fuzzy matching; no outcome/price fields used",
  },
} as const;

/**
 * Frozen authoritative feature audit. Its verdict is the reason the
 * NOT_RECOVERABLE features below are NULL — nothing in this mission tried to
 * work around it.
 */
export const FEATURE_AUTHORITY = {
  id: "summer_research_feature_authority_v1",
  manifestSha256:
    "daeed313115328e4c9b1d19e283b8a6f09614022e7b26df202143d9ddcec9002",
  augustCohortEvents: 18705,
  findings: {
    SCORE_COVERAGE_N: 0,
    VOLUME_COVERAGE_N: 0,
  },
} as const;

export type EnrichmentStatus =
  | "RESOLVED"
  | "ENRICHMENT_UNRESOLVED"
  | "NOT_RECOVERABLE";

export interface FeatureSpec {
  key: string;
  group: "score" | "score_version" | "volume" | "identity" | "market" | "money" | "movement" | "coverage" | "price" | "derived";
  semantic: string;
  source: string | null;
  /** When RESOLVED, OBSERVED_AT is this row field; otherwise null. */
  observedAtField: string | null;
  baselineStatus: EnrichmentStatus;
  reason?: string;
}

/**
 * Full feature registry. Volume semantics are kept strictly separate and are
 * never collapsed into one generic column. Score slots are kept separate and
 * are NEVER imputed.
 */
export const FEATURE_REGISTRY: FeatureSpec[] = [
  {
    key: "entry_price",
    group: "price",
    semantic:
      "generated_signal_pairs.entry_price_num — decision-time selected price (== winProbability)",
    source: "expanded_strategic_t90_replay_inputs_v1",
    observedAtField: "created_at",
    baselineStatus: "ENRICHMENT_UNRESOLVED",
  },
  {
    key: "signal_confidence_num",
    group: "score",
    semantic: "generated_signal_pairs.signal_confidence_num (shadow-strategic-sports-v1 population)",
    source: "expanded_strategic_t90_replay_inputs_v1",
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason:
      "summer_research_feature_authority_v1: every persisted score slot NULL on 100% of August rows; no imputation permitted.",
  },
  {
    key: "score",
    group: "score",
    semantic: "generated_signal_pairs.score (persisted Score field)",
    source: "expanded_strategic_t90_replay_inputs_v1",
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason: "summer_research_feature_authority_v1: NULL on 100% of August rows.",
  },
  {
    key: "pre_event_score_num",
    group: "score",
    semantic: "generated_signal_pairs.pre_event_score_num / researchScore",
    source: "expanded_strategic_t90_replay_inputs_v1",
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason: "summer_research_feature_authority_v1: NULL on 100% of August rows.",
  },
  {
    key: "metric_formula_version",
    group: "score_version",
    semantic: "generated_signal_pairs.metric_formula_version",
    source: null,
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason: "Not persisted in any frozen August enrichment source; distinct from formula_version.",
  },
  {
    key: "formula_version",
    group: "score_version",
    semantic: "generated_signal_pairs.formula_version — producer population tag",
    source: "AUGUST_BASE_POPULATION.producerPredicate",
    observedAtField: "created_at",
    baselineStatus: "RESOLVED",
    reason: "Constant for this population by construction: shadow-strategic-sports-v1.",
  },
  ...volumeFeature("volumeUsd", "generated_signal_pairs.volumeUsd"),
  ...volumeFeature("parentEventVolume24hr", "diagnostics.parentEventVolume24hr"),
  ...volumeFeature("recentTradeCash", "diagnostics.recentTradeCash"),
  ...volumeFeature("maxTradeCash", "diagnostics.maxTradeCash"),
  ...volumeFeature("market_volume_usd", "market_volume_usd"),
  {
    key: "market_family",
    group: "market",
    semantic: "taxonomy.market_type (MONEYLINE | SPREAD | TOTAL), frozen FROZEN_TAXONOMY_V1 classification",
    source: "expanded_strategic_t90_taxonomy_v2",
    observedAtField: "created_at",
    baselineStatus: "ENRICHMENT_UNRESOLVED",
  },
  {
    key: "sport_family",
    group: "identity",
    semantic: "taxonomy.sport_family (frozen classification, no price/outcome fields used)",
    source: "expanded_strategic_t90_taxonomy_v2",
    observedAtField: "created_at",
    baselineStatus: "ENRICHMENT_UNRESOLVED",
  },
  {
    key: "league_or_competition",
    group: "identity",
    semantic: "taxonomy.league_or_competition",
    source: "expanded_strategic_t90_taxonomy_v2",
    observedAtField: "created_at",
    baselineStatus: "ENRICHMENT_UNRESOLVED",
  },
  {
    key: "smart_money",
    group: "money",
    semantic: "smart_money / whale-vs-public split",
    source: null,
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason: "Not persisted for the August cohort; barred from fabrication.",
  },
  {
    key: "price_movement",
    group: "movement",
    semantic: "prior price observations / price deltas / movement",
    source: null,
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason: "Delta history not persisted for the August cohort.",
  },
  {
    key: "data_coverage",
    group: "coverage",
    semantic: "data coverage / research coverage proxy",
    source: null,
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason: "Not persisted for the August cohort.",
  },
  {
    key: "liquidity_proxy",
    group: "coverage",
    semantic: "genuine liquidity proxy",
    source: null,
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason: "No genuinely populated liquidity field for the August cohort (recentTradeCash/maxTradeCash absent).",
  },
  {
    key: "pre_event",
    group: "coverage",
    semantic: "pre-event research flag / pre-event snapshot",
    source: null,
    observedAtField: null,
    baselineStatus: "NOT_RECOVERABLE",
    reason: "Not persisted for the August cohort.",
  },
];

function volumeFeature(key: string, semantic: string): FeatureSpec[] {
  return [
    {
      key,
      group: "volume",
      semantic,
      source: null,
      observedAtField: null,
      baselineStatus: "NOT_RECOVERABLE",
      reason:
        "summer_research_feature_authority_v1: VOLUME_COVERAGE_N=0 for the August cohort; each volume semantic kept separate and never collapsed.",
    },
  ];
}

export const VOLUME_SEMANTICS = FEATURE_REGISTRY.filter((f) => f.group === "volume").map((f) => f.key);
export const SCORE_SLOTS = FEATURE_REGISTRY.filter((f) => f.group === "score").map((f) => f.key);
