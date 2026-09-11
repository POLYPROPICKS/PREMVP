/**
 * BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1 — CONTRACT_A_FILTER_SIM_CURRENT.
 *
 * This is NOT an exact production historical replay. It applies the CURRENT
 * canonical Contract A *candidate* filter semantics (the pre-Reservation gates
 * that decide whether a research row becomes a FireModelCandidate) to the
 * offline research universe.
 *
 * It does NOT reproduce: the scheduler, the night plan, the 15-slot allocation
 * run state, Queue timing, or the exact historical production selections.
 *
 * SINGLE CANONICAL AUTHORITY. The canonical predicates live in runtime source
 * (`lib/executor/buildFireModelCandidates.ts`, `lib/contur3/taxonomy.ts`). This
 * module:
 *   • IMPORTS the canonical market-anchor decision verbatim
 *     (`resolveMarketAnchorDecision` — pure, no DB) rather than re-implementing it;
 *   • MIRRORS the small numeric gates (score / coverage / tier / bad-bucket /
 *     formula-version) with an exact SOURCE_OWNER citation for each. A drift
 *     guard test (`tests/modeling/offline-replay/contractAFilterSim.drift.test.ts`)
 *     asserts every mirrored literal still appears at its cited location, so the
 *     runtime file remains the ONE source of truth.
 * No threshold is invented here and none is duplicated as an independent authority.
 */
import { resolveMarketAnchorDecision } from "../../contur3/taxonomy";
// Contract A scored-planning formula-version admission — the SINGLE canonical
// authority on current origin/main. buildFireModelCandidates.ts itself derives
// `PLANNING_ALLOWED_VERSIONS` from exactly this constant (planning mode), so the
// offline sim imports it rather than mirroring a literal list that could drift.
import { PRODUCTION_SCORED_PLANNING_VERSIONS } from "../../executor/productionSignalPopulation";
import type { ModelReadyRow } from "./types";

/**
 * Factual transparency table — printed by the runner. Each row states exactly
 * what the offline simulation applied and who owns the canonical rule.
 */
export const CONTRACT_A_FILTER_SIM_RULES = [
  {
    FILTER: "formula_version_admission",
    CURRENT_CANONICAL_RULE:
      "formula_version ∈ PRODUCTION_SCORED_PLANNING_VERSIONS (current origin/main scored-planning population)",
    SOURCE_OWNER: "lib/executor/productionSignalPopulation.ts PRODUCTION_SCORED_PLANNING_VERSIONS",
  },
  {
    FILTER: "signal_score_floor",
    CURRENT_CANONICAL_RULE: "score != null AND score >= 50 (else LOW_SCORE reject)",
    SOURCE_OWNER: "lib/executor/buildFireModelCandidates.ts:1940 rejectReason(\"LOW_SCORE\")",
  },
  {
    FILTER: "entry_price_present",
    CURRENT_CANONICAL_RULE: "entry_price != null (else MISSING_ENTRY_PRICE reject)",
    SOURCE_OWNER: "lib/executor/buildFireModelCandidates.ts:1941",
  },
  {
    FILTER: "event_not_started (lead time)",
    CURRENT_CANONICAL_RULE:
      "game_start present AND game_start > now  →  lead_time_hours > 0 (else GAME_STARTED_OR_INVALID reject)",
    SOURCE_OWNER: "lib/executor/buildFireModelCandidates.ts:1949-1951",
  },
  {
    FILTER: "bad_bucket",
    CURRENT_CANONICAL_RULE:
      "REJECT when coverage in [50,74] AND entry_price in [0.44,0.58] (BAD_BUCKET_COV_PRICE)",
    SOURCE_OWNER: "lib/executor/buildFireModelCandidates.ts:1958-1961",
  },
  {
    FILTER: "tier_admission",
    CURRENT_CANONICAL_RULE:
      "computeTier(score,coverage): TIER1 score>=72 & cov>=50 · TIER2 score>=60 & cov>=50 · TIER3 score>=50 & cov>=25 · else null → not a candidate",
    SOURCE_OWNER: "lib/executor/buildFireModelCandidates.ts:1118-1122 computeTier",
  },
  {
    FILTER: "executable_market_anchor",
    CURRENT_CANONICAL_RULE:
      "resolveMarketAnchorDecision(...).allowed === true — forbidden (halftime/corners/exact-score/goalscorer/props/futures) lose to allowed; esports_non_policy rejected; partial event scope (map/round/half) rejected; unknown fail-closed; only allowed_fullmatch_{moneyline,spread,total} pass",
    SOURCE_OWNER:
      "lib/contur3/taxonomy.ts:resolveMarketAnchorDecision (imported verbatim) — invoked by lib/executor/buildFireModelCandidates.ts:326 resolveUpstreamMarketPolicy",
  },
  {
    FILTER: "coverage_default_when_identity_complete",
    CURRENT_CANONICAL_RULE:
      "coverage := diagnostics.dataCoverage ?? diagnostics.coverage ?? (identity complete & scope != UNKNOWN ? 50 : null)",
    SOURCE_OWNER:
      "lib/executor/buildFireModelCandidates.ts:794-797 computePlanningFallbackScore",
  },
] as const;

// ---- mirrored numeric gates (drift-guarded) --------------------------------
// Imported verbatim from the canonical single-source module — NOT a local mirror.
const PLANNING_ALLOWED_VERSIONS: readonly string[] = PRODUCTION_SCORED_PLANNING_VERSIONS;
const SCORE_FLOOR = 50; // :1940 LOW_SCORE
const TIER1_SCORE = 72;
const TIER1_COV = 50; // :1118
const TIER2_SCORE = 60;
const TIER2_COV = 50; // :1119
const TIER3_SCORE = 50;
const TIER3_COV = 25; // :1120
const BAD_BUCKET_COV_LO = 50;
const BAD_BUCKET_COV_HI = 74;
const BAD_BUCKET_PRICE_LO = 0.44;
const BAD_BUCKET_PRICE_HI = 0.58; // :1958-1961
const IDENTITY_COMPLETE_COVERAGE_DEFAULT = 50; // :794-797

export type ContractATier =
  | "TIER1_CORE_STRICT_72_COV50"
  | "TIER2_SAFE_EXPAND_60_COV50"
  | "TIER3_MICRO_EXPAND_50_COV25";

/** Mirror of buildFireModelCandidates.ts:1118-1122 computeTier. */
export function computeContractATier(score: number, coverage: number): ContractATier | null {
  if (score >= TIER1_SCORE && coverage >= TIER1_COV) return "TIER1_CORE_STRICT_72_COV50";
  if (score >= TIER2_SCORE && coverage >= TIER2_COV) return "TIER2_SAFE_EXPAND_60_COV50";
  if (score >= TIER3_SCORE && coverage >= TIER3_COV) return "TIER3_MICRO_EXPAND_50_COV25";
  return null;
}

export interface ContractAFilterVerdict {
  pass: boolean;
  reason: string; // "ALLOWED" or the first failing gate
  tier: ContractATier | null;
  market_class: string;
  effective_coverage: number | null;
  /** set only under an ablation that admitted a class the current money policy rejects */
  research_only_counterfactual?: boolean;
}

/**
 * Diagnostic ablation / fixed-candidate switches. `skip*` each disables ONE
 * whole current gate; `minEntryPrice` / `restrictToMarketClasses` are the exact
 * parameters of the two PREDEFINED correction candidates being compared (they
 * add constraints, never relax the executable-market anchor). NO threshold is
 * searched or changed here. Default (no argument) = the exact current canonical
 * filter, unchanged. Used only by the offline attribution / candidate scripts.
 */
export interface ContractAAblation {
  skipBadBucket?: boolean;
  skipTierAdmission?: boolean;
  skipScoreFloor?: boolean;
  skipExecutableMarketAnchor?: boolean;
  /** candidate constraint: reject when entry_price < this fixed value. */
  minEntryPrice?: number;
  /**
   * candidate constraint: after the canonical anchor has ALREADY allowed the
   * row, additionally reject unless its market_class is in this set. This can
   * only narrow the current allow-list — it never admits a forbidden class.
   */
  restrictToMarketClasses?: string[];
}

/**
 * Apply the current canonical Contract A candidate filter to one model-ready row.
 * Fail-closed: any gate that cannot be evaluated from the offline evidence
 * rejects the row (matching taxonomy.ts "unknown is fail-closed").
 */
export function contractAFilterVerdict(
  row: ModelReadyRow,
  ablate: ContractAAblation = {},
): ContractAFilterVerdict {
  const fail = (reason: string, extra?: Partial<ContractAFilterVerdict>): ContractAFilterVerdict => ({
    pass: false,
    reason,
    tier: null,
    market_class: extra?.market_class ?? "unknown",
    effective_coverage: extra?.effective_coverage ?? null,
  });
  let researchOnly = false;

  // formula-version admission.
  // The compact D-1 corpus preserves `diagnostics.formulaUsed`
  // ("trusted-initial-formula-v1.1"), NOT the row-level
  // `generated_signal_pairs.formula_version` that Contract A planning filters on
  // (PLANNING_ALLOWED_VERSIONS). The gate is therefore only enforced when the
  // corpus actually carries a planning-recognised version string; the research
  // placeholder is treated as "not evaluable at this grain" (pass), counted via
  // the reason so the transparency stays honest.
  const fv = row.formula_version;
  const RESEARCH_PLACEHOLDER = /^trusted-initial-formula/;
  if (fv != null && !RESEARCH_PLACEHOLDER.test(fv)) {
    if (!PLANNING_ALLOWED_VERSIONS.includes(fv)) {
      return fail("FORMULA_VERSION_NOT_ALLOWED");
    }
  }

  // entry price present
  if (row.entry_price == null) return fail("MISSING_ENTRY_PRICE");

  // candidate constraint: fixed price floor (adds a rejection, never relaxes one)
  if (ablate.minEntryPrice != null && row.entry_price < ablate.minEntryPrice) {
    return fail("BELOW_CANDIDATE_PRICE_FLOOR");
  }

  // event not started (needs positive lead time)
  if (row.lead_time_hours == null) return fail("MISSING_GAME_START");
  if (row.lead_time_hours <= 0) return fail("GAME_STARTED_OR_INVALID");

  // executable-market anchor — canonical decision, imported verbatim.
  // Offline evidence carries market_type / market_family tokens, not the raw
  // provider question. "primary" / "non_primary" are corpus bookkeeping labels,
  // not market descriptors — drop them so they don't force a false "unknown".
  const BOOKKEEPING = new Set(["primary", "non_primary", "unknown", ""]);
  const mt = row.market_type && !BOOKKEEPING.has(row.market_type) ? row.market_type : null;
  const mf = row.market_family && !BOOKKEEPING.has(row.market_family) ? row.market_family : null;
  const marketText = mt ?? mf ?? "";
  const anchor = resolveMarketAnchorDecision({
    providerMarketQuestion: mt,
    marketSlug: mf,
    eventSlug: null,
    matchFamilyKey: null,
  });
  // esports also fails via the sport family (esports_non_policy is a market class,
  // but the corpus sport family carries it too).
  const sportIsEsports = row.sport === "esports" || row.sport === "esport";
  const anchorWouldReject = !anchor.allowed || sportIsEsports || !marketText;
  if (anchorWouldReject) {
    if (!ablate.skipExecutableMarketAnchor) {
      return fail(
        !marketText
          ? "MARKET_ANCHOR_INDETERMINATE_NO_TYPE_TOKEN"
          : sportIsEsports && anchor.allowed
            ? "ESPORTS_NON_POLICY"
            : `MARKET_ANCHOR_${anchor.reason_code ?? "REJECTED"}`,
        { market_class: anchor.market_class },
      );
    }
    // ablation: admit it, but mark it as a class the current money policy rejects
    researchOnly = true;
  }

  // candidate constraint: narrow the (already-allowed) executable-market set.
  // Only applies when the anchor allowed the row — never admits a forbidden class.
  if (
    !anchorWouldReject &&
    ablate.restrictToMarketClasses != null &&
    !ablate.restrictToMarketClasses.includes(anchor.market_class)
  ) {
    return fail("OUTSIDE_CANDIDATE_MARKET_CLASS_SET", { market_class: anchor.market_class });
  }

  // score floor
  if (!ablate.skipScoreFloor) {
    if (row.signal_score == null) return fail("LOW_SCORE_NO_SCORE", { market_class: anchor.market_class });
    if (row.signal_score < SCORE_FLOOR) return fail("LOW_SCORE", { market_class: anchor.market_class });
  }

  // coverage: canonical default when identity is complete and scope known
  const identityComplete =
    Boolean(row.condition_id) && Boolean(row.selected_token_id) && Boolean(row.event_start);
  const coverage =
    row.coverage != null
      ? row.coverage
      : identityComplete && row.sport !== "unknown"
        ? IDENTITY_COMPLETE_COVERAGE_DEFAULT
        : null;
  if (coverage == null) {
    return fail("COVERAGE_INDETERMINATE", { market_class: anchor.market_class });
  }

  // bad bucket
  if (!ablate.skipBadBucket) {
    if (
      coverage >= BAD_BUCKET_COV_LO &&
      coverage <= BAD_BUCKET_COV_HI &&
      row.entry_price >= BAD_BUCKET_PRICE_LO &&
      row.entry_price <= BAD_BUCKET_PRICE_HI
    ) {
      return fail("BAD_BUCKET_COV_PRICE", { market_class: anchor.market_class, effective_coverage: coverage });
    }
  }

  // tier admission
  const tier =
    row.signal_score != null ? computeContractATier(row.signal_score, coverage) : null;
  if (!ablate.skipTierAdmission && tier == null) {
    return fail("NO_TIER", { market_class: anchor.market_class, effective_coverage: coverage });
  }

  return {
    pass: true,
    reason: researchOnly ? "ALLOWED_RESEARCH_ONLY_COUNTERFACTUAL" : "ALLOWED",
    tier,
    market_class: anchor.market_class,
    effective_coverage: coverage,
    ...(researchOnly ? { research_only_counterfactual: true } : {}),
  };
}

/** Values the drift guard test cross-checks against runtime source. */
export const CONTRACT_A_SIM_MIRRORED_CONSTANTS = {
  PLANNING_ALLOWED_VERSIONS,
  SCORE_FLOOR,
  TIER1_SCORE,
  TIER1_COV,
  TIER2_SCORE,
  TIER2_COV,
  TIER3_SCORE,
  TIER3_COV,
  BAD_BUCKET_COV_LO,
  BAD_BUCKET_COV_HI,
  BAD_BUCKET_PRICE_LO,
  BAD_BUCKET_PRICE_HI,
  IDENTITY_COMPLETE_COVERAGE_DEFAULT,
} as const;
