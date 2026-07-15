import test from "node:test";
import assert from "node:assert/strict";
import { compareStakePolicies } from "../../lib/modeling/stakeAllocationOptimizer";

test("three policy IDs are stable and share the same unique candidates", () => {
  const result = compareStakePolicies([]);
  assert.deepEqual(result.map((x) => x.policyId), ["CONTROL_ACTIVE3_SHRINKING_V1", "FIXED_CYCLE_MAX3_V1", "ROBUST_LCB_TIERED_MAX3_V1"]);
  assert.ok(result.every((x) => x.uniqueMatchCandidates === 0));
});

test("PRIMARY and Shadows carry identical selected policy parameters", () => {
  const selectedStakePolicy = "ROBUST_LCB_TIERED_MAX3_V1";
  const selectedVaultPolicy = "A0.75_T1.5_R0.5_S0.25";
  const models = ["PRIMARY", "SHADOW_1", "SHADOW_2"].map((model) => ({ model, selectedStakePolicy, selectedVaultPolicy }));
  assert.equal(new Set(models.map((x) => x.selectedStakePolicy)).size, 1);
  assert.equal(new Set(models.map((x) => x.selectedVaultPolicy)).size, 1);
});
