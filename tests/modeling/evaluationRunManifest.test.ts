// Phase 3E.5 Commit B -- reproducible run manifest tests.
//
// The manifest makes an evaluation run reproducible: a deterministic runId
// derived from stable inputs (git commit, input hash, classifier hash,
// engine version, ordered requested variant ids), and a record of what ran,
// what was skipped, and the exact stake/ROI/identity policies -- with no raw
// rows, env values, tokens, or Supabase URLs.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvaluationRunManifest,
  computeRunId,
  MANIFEST_SCHEMA_VERSION,
  type ManifestInputs,
} from "../../lib/modeling/evaluationRunManifest";

function baseInputs(): ManifestInputs {
  return {
    gitCommit: "abc1234",
    gitBranch: "claude/dqa-r1-baseline-verify-itidmp",
    inputArtifactPath: "modeling/local_exports/generated_signal_pairs_export.json",
    inputSha256: "a".repeat(64),
    inputRowCount: 1657,
    inputFirstResolvedAt: "2026-05-01T00:00:00Z",
    inputLastResolvedAt: "2026-06-16T00:00:00Z",
    dedupPolicy: "strict_latest_created_before_resolved",
    rawInputRowCount: 49400,
    deduplicatedInputRowCount: 1657,
    duplicateRowsRemoved: 47743,
    dedupApplied: true,
    dedupIdentityFields: ["condition_id", "token_id"],
    dedupOrderingField: "created_at",
    dedupResolutionBoundaryField: "resolved_at",
    classifierPath: "modeling/model_registry/executable_funnel_classifier.json",
    classifierSha256: "b".repeat(64),
    classifierSchemaVersion: 1,
    comparisonEngineVersion: "3E.4-comparison-v1",
    requestedVariantIds: ["BASELINE_V1_CONTROL", "ALT2_TS_SCORE_GE_65"],
    executedVariantIds: ["BASELINE_V1_CONTROL", "ALT2_TS_SCORE_GE_65"],
    skippedVariantsAndReasons: [{ variantId: "MODEL_A", reason: "SKIPPED_DUPLICATE_ALIAS" }],
    normalizedStakePolicy: { unit: "FLAT_1_UNIT", plainLanguage: "1 unit" },
    roiContractSource: "lib/modeling/roiPnlContract.ts",
    eventIdentityPolicy: "MEDIUM event_slug allowed for exploratory only",
    knownLimitations: ["ALT1 canonical is exploratory identity-limited"],
    commands: ["node --import tsx scripts/modeling/strategies/run-historical-funnel-comparison.ts"],
    createdAt: "2026-07-10T00:00:00Z",
  };
}

test("M1: same stable inputs produce the same runId", () => {
  const a = computeRunId(baseInputs());
  const b = computeRunId(baseInputs());
  assert.equal(a, b);
});

test("M2: changed input hash changes the runId", () => {
  const a = computeRunId(baseInputs());
  const b = computeRunId({ ...baseInputs(), inputSha256: "c".repeat(64) });
  assert.notEqual(a, b);
});

test("M3: changed classifier hash changes the runId", () => {
  const a = computeRunId(baseInputs());
  const b = computeRunId({ ...baseInputs(), classifierSha256: "d".repeat(64) });
  assert.notEqual(a, b);
});

test("M4: changed variant list changes the runId", () => {
  const a = computeRunId(baseInputs());
  const b = computeRunId({ ...baseInputs(), requestedVariantIds: ["BASELINE_V1_CONTROL"] });
  assert.notEqual(a, b);
});

test("M5: createdAt does not affect the runId", () => {
  const a = computeRunId({ ...baseInputs(), createdAt: "2026-07-10T00:00:00Z" });
  const b = computeRunId({ ...baseInputs(), createdAt: "2030-01-01T12:34:56Z" });
  assert.equal(a, b);
});

test("M6: manifest records the git commit", () => {
  const m = buildEvaluationRunManifest(baseInputs());
  assert.equal(m.gitCommit, "abc1234");
  assert.equal(m.schemaVersion, MANIFEST_SCHEMA_VERSION);
});

test("M7: manifest records both historical limitations and normalized stake", () => {
  const m = buildEvaluationRunManifest(baseInputs());
  assert.ok(m.knownLimitations.length > 0);
  assert.equal(m.normalizedStakePolicy.unit, "FLAT_1_UNIT");
});

test("M8: manifest records skipped variants and reasons", () => {
  const m = buildEvaluationRunManifest(baseInputs());
  assert.deepEqual(m.skippedVariantsAndReasons, [{ variantId: "MODEL_A", reason: "SKIPPED_DUPLICATE_ALIAS" }]);
});

test("M9: manifest contains no raw rows", () => {
  const m = buildEvaluationRunManifest(baseInputs());
  const serialized = JSON.stringify(m);
  // Raw row payloads carry result/return values; the manifest may name the
  // dedup identity FIELDS (condition_id/token_id) as metadata, which is not a
  // raw row, so only row-value keys are forbidden here.
  assert.doesNotMatch(serialized, /"signal_result":|"realized_return_pct":|"entry_price_num":/);
});

test("M10: manifest contains no env values / tokens / supabase urls", () => {
  const m = buildEvaluationRunManifest({ ...baseInputs() });
  const serialized = JSON.stringify(m);
  assert.doesNotMatch(serialized, /SUPABASE_URL|SERVICE_ROLE|apikey|bearer|eyJ[A-Za-z0-9]/i);
});

test("M11: runId is stable regardless of requested-variant array identity but not order", () => {
  const a = computeRunId(baseInputs());
  const b = computeRunId({ ...baseInputs(), requestedVariantIds: ["ALT2_TS_SCORE_GE_65", "BASELINE_V1_CONTROL"] });
  // Order is part of the run definition, so a different order is a different run.
  assert.notEqual(a, b);
});

test("M12: manifest records raw, dedup, and removed counts plus dedupApplied", () => {
  const m = buildEvaluationRunManifest(baseInputs());
  assert.equal(m.rawInputRowCount, 49400);
  assert.equal(m.deduplicatedInputRowCount, 1657);
  assert.equal(m.duplicateRowsRemoved, 47743);
  assert.equal(m.dedupApplied, true);
  assert.deepEqual(m.dedupIdentityFields, ["condition_id", "token_id"]);
  assert.equal(m.dedupOrderingField, "created_at");
  assert.equal(m.dedupResolutionBoundaryField, "resolved_at");
});

test("M13: duplicateRowsRemoved equals raw minus dedup", () => {
  const m = buildEvaluationRunManifest(baseInputs());
  assert.equal(m.duplicateRowsRemoved, m.rawInputRowCount - m.deduplicatedInputRowCount);
});
