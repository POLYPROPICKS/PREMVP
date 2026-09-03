/**
 * FORWARD_RICH_CAPTURE_V1 — public entrypoint.
 *
 * Deterministic, no-LLM forward rich research capture:
 *  - immutable score observation contract persisted into the existing GSRS ledger
 *    (see lib/feed/researchScoreObservation.ts + lib/feed/cacheResearchSnapshots.ts);
 *  - a daily append/cutoff materializer over immutable GSRS + generated_signal_pairs
 *    observations, with an explicit four-instant time contract and no post-decision
 *    leakage;
 *  - the frozen August diagnostic research context (baseline + three hypotheses).
 *
 * Next semantic transition: FORWARD_RICH_CAPTURE_RELEASE_V1.
 */
export * from "./types";
export * from "./materializeForwardRichResearch";
export * from "./augustFrozenResearchContext";
export * from "./compactCorpus";

export const NEXT_SEMANTIC_TRANSITION = "COMPACT_CORPUS_FORWARD_MODEL_SCOREBOARD_V1";
