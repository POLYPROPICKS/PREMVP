/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — public entrypoint.
 *
 * Deterministic, LLM-free encoding of the frozen C0/C1/C4/C5 model family:
 * frozen predicates, physical-event exposure semantics, flat-1u settlement,
 * chronological MaxDD, reusable aggregate metrics, and the accepted golden
 * reference contract.
 *
 * Canonical dataset portability is explicitly out of scope here and is the
 * next semantic transition: CANONICAL_MODELING_DATASET_V1.
 */
export * from "./types";
export * from "./models";
export * from "./settlement";
export * from "./metrics";
export * from "./engine";
export * from "./goldenContract";
export * from "./conformanceMatrix";

export const NEXT_SEMANTIC_TRANSITION = "CANONICAL_MODELING_DATASET_V1";
