/**
 * BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1 — POLICY / MODEL REGISTRY.
 *
 * One place that maps a model id → a deterministic membership predicate over a
 * `ModelReadyRow`. C0/C1/C4/C5 predicates are IMPORTED VERBATIM from the frozen
 * research engine (`lib/modeling/research-engine/models.ts`) — never re-encoded.
 * C2/C3 are COMPOSED from the same exported frozen constants
 * (`ENTRY_PRICE_BAND`, `C4_LEAD_TIME_HOURS_THRESHOLD`, `SOCCER_FAMILY`), so
 * there is still exactly one threshold authority. CONTRACT_A_FILTER_SIM_CURRENT
 * delegates to `contractAFilterSim.ts` (which imports the canonical
 * market-anchor decision and drift-guards its numeric gates).
 */
import {
  FROZEN_MODELS,
  ENTRY_PRICE_BAND,
  C4_LEAD_TIME_HOURS_THRESHOLD,
  SOCCER_FAMILY,
  type EvaluatedEvent,
} from "../research-engine";
import { contractAFilterVerdict } from "./contractAFilterSim";
import type { ModelReadyRow } from "./types";

export type PolicyId =
  | "C0"
  | "C1"
  | "C2"
  | "C3"
  | "C4"
  | "C5"
  | "CONTRACT_A_FILTER_SIM_CURRENT";

export const ALL_POLICY_IDS: PolicyId[] = [
  "C0",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "CONTRACT_A_FILTER_SIM_CURRENT",
];

/** The minimal frozen-predicate input shape (subset of research-engine EvaluatedEvent). */
function toFrozenEvaluated(row: ModelReadyRow): EvaluatedEvent {
  return {
    physicalEventKey: row.physical_event_id,
    decisionTimestamp: row.decision_at,
    eventStart: row.event_start ?? row.decision_at,
    entryPrice: row.entry_price ?? Number.NaN,
    sportFamily: row.sport,
    outcome: row.terminal_status === "WIN" ? "WIN" : "LOSS",
    leadTimeHours: row.lead_time_hours ?? Number.NaN,
  };
}

function inBand(p: number): boolean {
  return p >= ENTRY_PRICE_BAND.minInclusive && p < ENTRY_PRICE_BAND.maxExclusive;
}

export interface PolicyEvaluation {
  pass: boolean;
  reason: string;
}

export interface RegisteredPolicy {
  id: PolicyId;
  role: string;
  predicateDescription: string;
  /** Deterministic membership predicate over one model-ready identity. */
  evaluate: (row: ModelReadyRow) => PolicyEvaluation;
}

function frozen(id: "C0" | "C1" | "C4" | "C5"): RegisteredPolicy {
  const m = FROZEN_MODELS[id];
  return {
    id,
    role: m.ROLE,
    predicateDescription: m.predicateDescription,
    evaluate: (row) => {
      if (row.entry_price == null) return { pass: false, reason: "MISSING_ENTRY_PRICE" };
      const ev = toFrozenEvaluated(row);
      // sport / lead needed by some predicates — fail-closed if missing where used
      if ((id === "C1") && row.sport === "unknown")
        return { pass: false, reason: "SPORT_UNKNOWN" };
      if ((id === "C4") && row.sport === "unknown" && row.lead_time_hours == null)
        return { pass: false, reason: "SPORT_AND_LEAD_UNKNOWN" };
      const pass = m.predicate(ev);
      return { pass, reason: pass ? "PASS" : "PREDICATE_FALSE" };
    },
  };
}

const C2: RegisteredPolicy = {
  id: "C2",
  role: "LEAD_GE_24H",
  predicateDescription: `0.50 <= entry_price < 0.60 AND lead_time_hours >= ${C4_LEAD_TIME_HOURS_THRESHOLD}`,
  evaluate: (row) => {
    if (row.entry_price == null) return { pass: false, reason: "MISSING_ENTRY_PRICE" };
    if (row.lead_time_hours == null) return { pass: false, reason: "MISSING_LEAD_TIME" };
    const pass =
      inBand(row.entry_price) && row.lead_time_hours >= C4_LEAD_TIME_HOURS_THRESHOLD;
    return { pass, reason: pass ? "PASS" : "PREDICATE_FALSE" };
  },
};

const C3: RegisteredPolicy = {
  id: "C3",
  role: "SOCCER_AND_LEAD_GE_24H",
  predicateDescription: `0.50 <= entry_price < 0.60 AND sport_family = ${SOCCER_FAMILY} AND lead_time_hours >= ${C4_LEAD_TIME_HOURS_THRESHOLD}`,
  evaluate: (row) => {
    if (row.entry_price == null) return { pass: false, reason: "MISSING_ENTRY_PRICE" };
    if (row.sport === "unknown") return { pass: false, reason: "SPORT_UNKNOWN" };
    if (row.lead_time_hours == null) return { pass: false, reason: "MISSING_LEAD_TIME" };
    const pass =
      inBand(row.entry_price) &&
      row.sport === SOCCER_FAMILY &&
      row.lead_time_hours >= C4_LEAD_TIME_HOURS_THRESHOLD;
    return { pass, reason: pass ? "PASS" : "PREDICATE_FALSE" };
  },
};

const CONTRACT_A_FILTER_SIM_CURRENT: RegisteredPolicy = {
  id: "CONTRACT_A_FILTER_SIM_CURRENT",
  role: "CURRENT CONTRACT A CANDIDATE FILTER (pre-Reservation gates only)",
  predicateDescription:
    "formula-version ∈ planning set · score>=50 · entry_price present · lead>0 · NOT bad-bucket · computeTier != null · resolveMarketAnchorDecision().allowed",
  evaluate: (row) => {
    const v = contractAFilterVerdict(row);
    return { pass: v.pass, reason: v.reason };
  },
};

export const POLICY_REGISTRY: Record<PolicyId, RegisteredPolicy> = {
  C0: frozen("C0"),
  C1: frozen("C1"),
  C2,
  C3,
  C4: frozen("C4"),
  C5: frozen("C5"),
  CONTRACT_A_FILTER_SIM_CURRENT,
};

/* ------------------------------------------------------------------ *
 * OFFLINE MODELING RUNTIME CONTRACT + operator status (single authority)
 *
 * FREEZE_AND_CANONICALIZE_DETERMINISTIC_MODELING_PLANE_V1. This is an extension
 * of THIS registry module — not a second registry. Every analytical model the
 * offline plane can evaluate (the 7 registered policies above + the 3 fixed
 * Contract-A correction candidates produced by
 * scripts/modeling/offline-replay-contract-a-candidates.ts) is a deterministic
 * code function with NO LLM / network / database dependency at replay. STATUS
 * and DASHBOARD_DEFAULT_VISIBLE describe the CURRENT operator surface only; they
 * do not rewrite any historical model result.
 * ------------------------------------------------------------------ */

export type ModelRuntimeKind = "DETERMINISTIC_CODE";

export interface ModelRuntimeContract {
  MODEL_ID: string;
  MODEL_VERSION: string;
  RUNTIME_KIND: ModelRuntimeKind;
  LLM_DEPENDENCY_AT_RUNTIME: false;
  NETWORK_DEPENDENCY_AT_REPLAY: false;
  DATABASE_DEPENDENCY_AT_REPLAY: false;
  CANONICAL_PREDICATE_OWNER: string;
  STATUS: string;
  DASHBOARD_DEFAULT_VISIBLE: boolean;
}

const FROZEN_PREDICATE_OWNER = "lib/modeling/research-engine/models.ts (FROZEN_MODELS, freeze-v1)";
const COMPOSED_PREDICATE_OWNER =
  "lib/modeling/offline-replay/policyRegistry.ts (composed from frozen ENTRY_PRICE_BAND / C4_LEAD_TIME_HOURS_THRESHOLD / SOCCER_FAMILY constants)";
const CONTRACT_A_PREDICATE_OWNER =
  "lib/modeling/offline-replay/contractAFilterSim.ts + lib/contur3/taxonomy.ts::resolveMarketAnchorDecision (imported verbatim)";
const CANDIDATE_PREDICATE_OWNER =
  "scripts/modeling/offline-replay-contract-a-candidates.ts (fixed ContractAAblation constants: minEntryPrice 0.50 / skipBadBucket / restrictToMarketClasses)";

const FROZEN_FAMILY_VERSION = "research-engine-freeze-v1";
const CONTRACT_A_SIM_VERSION = "contract-a-filter-sim-current-v1";
const CONTRACT_A_CANDIDATE_VERSION = "contract-a-correction-candidates-v1";

function contract(
  id: string,
  version: string,
  owner: string,
  status: string,
  dashboardDefaultVisible: boolean,
): ModelRuntimeContract {
  return {
    MODEL_ID: id,
    MODEL_VERSION: version,
    RUNTIME_KIND: "DETERMINISTIC_CODE",
    LLM_DEPENDENCY_AT_RUNTIME: false,
    NETWORK_DEPENDENCY_AT_REPLAY: false,
    DATABASE_DEPENDENCY_AT_REPLAY: false,
    CANONICAL_PREDICATE_OWNER: owner,
    STATUS: status,
    DASHBOARD_DEFAULT_VISIBLE: dashboardDefaultVisible,
  };
}

export const MODEL_RUNTIME_CONTRACT: Record<string, ModelRuntimeContract> = {
  C0: contract("C0", FROZEN_FAMILY_VERSION, FROZEN_PREDICATE_OWNER, "ACTIVE_REFERENCE", true),
  C5: contract("C5", FROZEN_FAMILY_VERSION, FROZEN_PREDICATE_OWNER, "REDUNDANT_WITH_C0_CURRENT_WINDOW", false),
  C1: contract("C1", FROZEN_FAMILY_VERSION, FROZEN_PREDICATE_OWNER, "RESEARCH_REFERENCE_NOT_ACTIVE_OPERATOR_MODEL", false),
  C4: contract("C4", FROZEN_FAMILY_VERSION, FROZEN_PREDICATE_OWNER, "REDUNDANT_WITH_C1_CURRENT_WINDOW", false),
  C2: contract("C2", FROZEN_FAMILY_VERSION, COMPOSED_PREDICATE_OWNER, "ZERO_SELECTION_CURRENT_WINDOW", false),
  C3: contract("C3", FROZEN_FAMILY_VERSION, COMPOSED_PREDICATE_OWNER, "ZERO_SELECTION_CURRENT_WINDOW", false),
  CONTRACT_A_FILTER_SIM_CURRENT: contract(
    "CONTRACT_A_FILTER_SIM_CURRENT",
    CONTRACT_A_SIM_VERSION,
    CONTRACT_A_PREDICATE_OWNER,
    "ACTIVE_CURRENT_POLICY_SIMULATION",
    true,
  ),
  CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF: contract(
    "CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF",
    CONTRACT_A_CANDIDATE_VERSION,
    CANDIDATE_PREDICATE_OWNER,
    "ACTIVE_CORRECTION_CANDIDATE",
    true,
  ),
  CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF: contract(
    "CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF",
    CONTRACT_A_CANDIDATE_VERSION,
    CANDIDATE_PREDICATE_OWNER,
    "ACTIVE_CORRECTION_CANDIDATE",
    true,
  ),
  // C0_REFERENCE is the candidate artifact's in-context C0 echo. It is NOT a
  // separate operator model — C0 already carries this lane.
  C0_REFERENCE: contract(
    "C0_REFERENCE",
    FROZEN_FAMILY_VERSION,
    FROZEN_PREDICATE_OWNER,
    "DUPLICATE_OF_C0_DO_NOT_RENDER_AS_SEPARATE_OPERATOR_MODEL",
    false,
  ),
};

/** The 4 lanes the PRIMARY operator comparison renders by default. */
export const DASHBOARD_DEFAULT_MODELS: string[] = Object.values(MODEL_RUNTIME_CONTRACT)
  .filter((c) => c.DASHBOARD_DEFAULT_VISIBLE)
  .map((c) => c.MODEL_ID);

export function resolvePolicies(models: string[] | "all"): RegisteredPolicy[] {
  if (models === "all") return ALL_POLICY_IDS.map((id) => POLICY_REGISTRY[id]);
  return models.map((m) => {
    const p = POLICY_REGISTRY[m as PolicyId];
    if (!p) throw new Error(`offline-replay: unknown model "${m}". Known: ${ALL_POLICY_IDS.join(", ")}`);
    return p;
  });
}
