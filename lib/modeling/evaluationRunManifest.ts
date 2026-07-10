// Reproducible evaluation run manifest (Phase 3E.5).
//
// Records exactly what an evaluation run consumed and produced, so the run
// can be reproduced and audited. The runId is a deterministic SHA-256 over
// the stable inputs (git commit, input hash, classifier hash, engine
// version, ordered requested variant ids) -- createdAt is recorded but never
// contributes to the runId. Never embeds raw rows, env values, tokens, or
// Supabase URLs. Pure: no fs/env/network access (the caller supplies all
// values, including the already-computed hashes).

import { createHash } from "node:crypto";

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export interface StakePolicyRecord {
  unit: string;
  plainLanguage: string;
}

export interface SkippedVariantRecord {
  variantId: string;
  reason: string;
}

export interface ManifestInputs {
  gitCommit: string;
  gitBranch: string;
  inputArtifactPath: string;
  inputSha256: string;
  inputRowCount: number;
  inputFirstResolvedAt: string | null;
  inputLastResolvedAt: string | null;
  dedupPolicy: string;
  classifierPath: string;
  classifierSha256: string;
  classifierSchemaVersion: number;
  comparisonEngineVersion: string;
  requestedVariantIds: string[];
  executedVariantIds: string[];
  skippedVariantsAndReasons: SkippedVariantRecord[];
  normalizedStakePolicy: StakePolicyRecord;
  roiContractSource: string;
  eventIdentityPolicy: string;
  knownLimitations: string[];
  commands: string[];
  createdAt: string;
}

export interface EvaluationRunManifest extends ManifestInputs {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  runId: string;
}

/**
 * Deterministic runId over stable run-defining inputs only. createdAt and
 * any presentation-only fields are excluded, so two runs of the same inputs
 * at different wall-clock times share a runId.
 */
export function computeRunId(inputs: ManifestInputs): string {
  const stable = [
    inputs.gitCommit,
    inputs.inputSha256,
    inputs.classifierSha256,
    inputs.comparisonEngineVersion,
    inputs.requestedVariantIds.join(","),
  ].join("|");
  return createHash("sha256").update(stable).digest("hex");
}

/** Builds the full manifest object. Pure: derives runId, copies inputs. */
export function buildEvaluationRunManifest(inputs: ManifestInputs): EvaluationRunManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId: computeRunId(inputs),
    ...inputs,
  };
}
