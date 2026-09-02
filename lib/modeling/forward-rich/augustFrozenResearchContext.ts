/**
 * FORWARD_RICH_CAPTURE_V1 — canonical tracked research context.
 *
 * This module is the single tracked source of truth for the frozen August
 * diagnostic findings that motivate forward rich capture. It is DIAGNOSTIC
 * CONTEXT ONLY:
 *   - NOT_FORWARD_VALIDATED — computed on a fixed historical window;
 *   - NO_PRODUCTION_MODEL_CHANGE — C0/C1/C4/C5 predicates are unchanged;
 *   - it does not gate, rank, or select anything at runtime.
 *
 * CURRENT_STATE.yaml is intentionally NOT edited to accept this record — the
 * frozen numbers live here so forward materialized rows can be evaluated
 * against the same hypothesis keys later (FORWARD_RICH_CAPTURE_RELEASE_V1).
 */

export type FrozenHypothesisStatus =
  | "FROZEN_DIAGNOSTIC_HYPOTHESIS"
  | "NOT_FORWARD_VALIDATED"
  | "NO_PRODUCTION_MODEL_CHANGE";

export interface FrozenResearchCohort {
  id: string;
  label: string;
  /** Exact signal-side classification key this cohort is defined by. */
  selector: Record<string, string>;
  decisionPeriod?: { fromInclusive: string; toInclusive: string };
  n: number;
  pnlUnits: number;
  roiPct: number;
  maxDrawdownUnits: number;
  status: FrozenHypothesisStatus[];
}

export const AUGUST_C4_BASELINE: FrozenResearchCohort = {
  id: "AUGUST_C4_BASELINE",
  label: "August C4 baseline",
  selector: { model: "C4" },
  decisionPeriod: { fromInclusive: "2026-08-05", toInclusive: "2026-08-25" },
  n: 4117,
  pnlUnits: 474.56,
  roiPct: 11.5269,
  maxDrawdownUnits: -16.41,
  status: ["NOT_FORWARD_VALIDATED", "NO_PRODUCTION_MODEL_CHANGE"],
};

const HYPOTHESES: readonly FrozenResearchCohort[] = [
  {
    id: "C4_SOCCER_FIRST_TO_SCORE",
    label: "C4 + market_type_raw = soccer_first_to_score",
    selector: { model: "C4", market_type_raw: "soccer_first_to_score" },
    decisionPeriod: { fromInclusive: "2026-08-05", toInclusive: "2026-08-25" },
    n: 621,
    pnlUnits: 103.29,
    roiPct: 16.63,
    maxDrawdownUnits: -13.31,
    status: [
      "FROZEN_DIAGNOSTIC_HYPOTHESIS",
      "NOT_FORWARD_VALIDATED",
      "NO_PRODUCTION_MODEL_CHANGE",
    ],
  },
  {
    id: "C4_SOCCER_EXACT_SCORE",
    label: "C4 + market_type_raw = soccer_exact_score",
    selector: { model: "C4", market_type_raw: "soccer_exact_score" },
    n: 196,
    pnlUnits: 113.13,
    roiPct: 57.72,
    maxDrawdownUnits: -6.0,
    status: [
      "FROZEN_DIAGNOSTIC_HYPOTHESIS",
      "NOT_FORWARD_VALIDATED",
      "NO_PRODUCTION_MODEL_CHANGE",
    ],
  },
  {
    id: "C4_UWCL",
    label: "C4 + provider_sport_code = uwcl",
    selector: { model: "C4", provider_sport_code: "uwcl" },
    n: 87,
    pnlUnits: 22.35,
    roiPct: 25.69,
    maxDrawdownUnits: -3.0,
    status: [
      "FROZEN_DIAGNOSTIC_HYPOTHESIS",
      "NOT_FORWARD_VALIDATED",
      "NO_PRODUCTION_MODEL_CHANGE",
    ],
  },
];

export const AUGUST_FROZEN_HYPOTHESES: readonly FrozenResearchCohort[] =
  Object.freeze(HYPOTHESES);

/**
 * Exact signal-side classification keys future materialized rows must preserve
 * so these hypotheses can be evaluated forward. Reuses existing deterministic
 * semantics — no fuzzy classification, no new taxonomy.
 */
export const FORWARD_EVALUATION_KEYS = Object.freeze([
  { field: "marketTypeRaw", value: "soccer_first_to_score" },
  { field: "marketTypeRaw", value: "soccer_exact_score" },
  { field: "providerSportCode", value: "uwcl" },
] as const);

export const AUGUST_FROZEN_RESEARCH_CONTEXT = Object.freeze({
  contextId: "FORWARD_RICH_CAPTURE_V1__AUGUST_FROZEN_CONTEXT",
  baseline: AUGUST_C4_BASELINE,
  hypotheses: AUGUST_FROZEN_HYPOTHESES,
  forwardEvaluationKeys: FORWARD_EVALUATION_KEYS,
  nextSemanticTransition: "FORWARD_RICH_CAPTURE_RELEASE_V1",
});
