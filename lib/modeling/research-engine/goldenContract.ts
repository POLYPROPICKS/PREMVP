/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — golden reference contract.
 *
 * These aggregate values are ALREADY-ACCEPTED historical frozen economics
 * for C0/C1/C4/C5. They are recorded here as versioned reference metadata.
 *
 * They were NOT regenerated from an event-level corpus in this mission.
 * `regeneratedFromEventLevelDataInThisMission` is false and must stay false
 * until CANONICAL_MODELING_DATASET_V1 provides a portable canonical dataset.
 *
 * No machine-specific dataset (C:\tmp or any other host path) is required
 * to consume this contract or to run the conformance tests.
 */

export interface GoldenModelEconomics {
  /** Selected physical-event count (= W + L). */
  N: number;
  W: number;
  L: number;
  /** Total settlement in units. */
  PNL_U: number;
  /** Return on flat-1u stake per selected event, percent. */
  ROI_PCT: number;
  /** Chronological maximum drawdown in units (<= 0). */
  MAX_DRAWDOWN_U: number;
}

export const GOLDEN_REFERENCE_CONTRACT_V1 = {
  contractId: "MODEL_RESEARCH_ENGINE_FROZEN_ECONOMICS_GOLDEN_V1",
  contractVersion: "golden-v1",
  modelVersion: "freeze-v1",
  provenance: "HISTORICAL_ACCEPTED_AGGREGATE",
  regeneratedFromEventLevelDataInThisMission: false,
  note:
    "Accepted frozen aggregate economics for C0/C1/C4/C5. Recorded as historical " +
    "reference metadata only. NOT regenerated from event-level data in " +
    "MODEL_RESEARCH_ENGINE_FREEZE_V1. Full event-level regeneration against a " +
    "portable canonical dataset is deferred to CANONICAL_MODELING_DATASET_V1.",
  models: {
    C0: { N: 9282, W: 5023, L: 4259, PNL_U: 554.4, ROI_PCT: 5.9728, MAX_DRAWDOWN_U: -39.83 },
    C1: { N: 3332, W: 1964, L: 1368, PNL_U: 445.69, ROI_PCT: 13.3762, MAX_DRAWDOWN_U: -16.92 },
    C4: { N: 4142, W: 2398, L: 1744, PNL_U: 490.71, ROI_PCT: 11.8472, MAX_DRAWDOWN_U: -15.84 },
    C5: { N: 6893, W: 3844, L: 3049, PNL_U: 586.03, ROI_PCT: 8.5018, MAX_DRAWDOWN_U: -24.46 },
  } satisfies Record<string, GoldenModelEconomics>,

  /**
   * Accepted historical structural contract. Strict-subset membership held
   * with zero exceptions on the accepted historical data.
   */
  structuralContract: {
    relations: ["C1 strict-subset C4", "C4 strict-subset C5"],
    strictSubset: true,
    historicalZeroExceptionMembership: true,
    /**
     * C1 => C4 is a predicate-level tautology (soccer in band always
     * satisfies the soccer branch of C4).
     *
     * C4 => C5 is NOT a predicate-level tautology: a table-tennis event in
     * the price band with lead_time_hours >= 24 satisfies C4 but is excluded
     * by C5. Historically no such row existed (table-tennis markets never
     * carried >= 24h lead time), so C4 strict-subset C5 held with zero
     * exceptions. That empirical zero-exception relation is re-proven on
     * CANONICAL_MODELING_DATASET_V1, not in this mission.
     */
    knownPredicateLevelException: {
      relation: "C4 => C5",
      condition: "sportFamily === 'table-tennis' && leadTimeHours >= 24 && price in [0.50, 0.60)",
      historicallyObserved: false,
      reproofDeferredTo: "CANONICAL_MODELING_DATASET_V1",
    },
  },
} as const;

export type GoldenReferenceContractV1 = typeof GOLDEN_REFERENCE_CONTRACT_V1;
