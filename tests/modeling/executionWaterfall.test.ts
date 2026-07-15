import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildExecutionWaterfall } from "../../lib/modeling/executionWaterfall";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const frozen = "C:/WORK/KalshiProPulse/modeling-snapshots/2026-07-15_b2f5dfb5963e/generated_signal_pairs_export.json";

test("frozen execution waterfall reconciles independent latest-base and T90 sets", () => {
  const rows = JSON.parse(readFileSync(frozen, "utf8"));
  const result = buildExecutionWaterfall(rows, loadExecutableFunnelClassifier());
  assert.equal(result.rawSnapshots, 49_400);
  assert.equal(result.baseModelRows, 549);
  assert.equal(result.t90QualifiedRows, 362);
  assert.equal(result.cohortReconciliation.retainedCount, 341);
  assert.equal(result.cohortReconciliation.baseOnlyExitCount, 208);
  assert.equal(result.cohortReconciliation.t90OnlyEntrantCount, 21);
  assert.equal(result.cohortReconciliation.unionCount, 570);
  assert.equal(549, 341 + 208);
  assert.equal(362, 341 + 21);
  assert.equal(570, 341 + 208 + 21);
  assert.equal(result.derivedSportingMatchGroups, 271);
  assert.equal(result.controlExecuted, 177);
  assert.equal(result.controlRejected, 94);
  assert.equal(Object.values(result.exitReasons).reduce((a, b) => a + b.count, 0), 208);
  assert.equal(Object.values(result.entrantReasons).reduce((a, b) => a + b.count, 0), 21);
  assert.equal(result.derivedSportingMatchGroups + result.marketsRankedOutInsideMatches + result.rowsRejectedNoMatchIdentity, 362);
  assert.equal(result.terminalIdentityCount, 570);
  assert.equal(result.reconciliationOverlapCount, 0);
});

test("input permutation does not change reconciliation", () => {
  const rows = JSON.parse(readFileSync(frozen, "utf8"));
  const classifier = loadExecutableFunnelClassifier();
  const a = buildExecutionWaterfall(rows, classifier);
  const b = buildExecutionWaterfall([...rows].reverse(), classifier);
  assert.deepEqual(a.cohortReconciliation, b.cohortReconciliation);
  assert.deepEqual(a.exitReasons, b.exitReasons);
  assert.deepEqual(a.entrantReasons, b.entrantReasons);
});

test("duplicate market attribution is explicitly non-independent", () => {
  const rows = JSON.parse(readFileSync(frozen, "utf8"));
  const result = buildExecutionWaterfall(rows, loadExecutableFunnelClassifier());
  assert.equal(result.duplicateMarketCounterfactual.label, "NON-INDEPENDENT COUNTERFACTUAL");
  assert.equal(result.duplicateMarketCounterfactual.includedInCanonicalTotal, false);
});
