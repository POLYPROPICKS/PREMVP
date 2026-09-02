/**
 * AUGUST_ENRICHED_RESEARCH_DATASET_V1 — public entrypoint.
 *
 * Deterministic, LLM-free join of already-persisted point-in-time attributes
 * onto the EXISTING accepted August research base population. Creates no new
 * base, reconstructs no history, changes no C1/C4/C5 logic, imputes nothing.
 */
export * from "./contract";
export * from "./types";
export * from "./enrich";
export * from "./mainDbLineage";

export const AUGUST_ENRICHED_ARTIFACT_ID = "AUGUST_ENRICHED_RESEARCH_DATASET_V1" as const;
