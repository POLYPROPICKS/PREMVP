/**
 * BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1 — public entrypoint.
 *
 * A thin, reusable, OFFLINE research evaluator. Future model comparisons run
 * from here — no new schema discovery, no production queries, no per-model
 * ad-hoc scripts.
 *
 *   IMMUTABLE RESEARCH EVIDENCE  (modelReadyView)
 *           ↓
 *   NORMALIZED MODEL-READY VIEW  (ModelReadyRow[])
 *           ↓
 *   POLICY / MODEL REGISTRY      (policyRegistry: C0..C5 + CONTRACT_A_FILTER_SIM_CURRENT)
 *           ↓
 *   ONE REPLAY RUNNER            (replayRunner.runReplay)
 *           ↓
 *   STANDARD RESULT TABLES       (StandardResult / GroupedResult)
 */
export * from "./types";
export { loadModelReadyView, DEFAULT_EVIDENCE_DIR } from "./modelReadyView";
export {
  POLICY_REGISTRY,
  ALL_POLICY_IDS,
  resolvePolicies,
  MODEL_RUNTIME_CONTRACT,
  DASHBOARD_DEFAULT_MODELS,
  type PolicyId,
  type RegisteredPolicy,
  type ModelRuntimeContract,
  type ModelRuntimeKind,
} from "./policyRegistry";
export {
  contractAFilterVerdict,
  computeContractATier,
  CONTRACT_A_FILTER_SIM_RULES,
  CONTRACT_A_SIM_MIRRORED_CONSTANTS,
  type ContractAAblation,
  type ContractAFilterVerdict,
} from "./contractAFilterSim";
export { runReplay, type ReplayParams } from "./replayRunner";
