import test from "node:test";
import assert from "node:assert/strict";
import { evaluateVaultPolicy, optimizeVaultPolicies } from "../../lib/modeling/vaultPolicyOptimizer";

test("vault uses realized equity, recovers principal once, and never refills active", () => {
  const result = evaluateVaultPolicy([10, 50, -20, 10], { id: "x", initialActivePct: 1, principalRecoveryTrigger: 1.5, principalRecoveryAmount: 0.5, highWatermarkSweepPct: 0.25 });
  assert.equal(result.ledger.filter((x) => x.kind === "PRINCIPAL_RECOVERY").length, 1);
  assert.ok(result.ledger.every((x) => x.sweepAmount >= 0));
});

test("fixed-seed bootstrap selection is reproducible", () => {
  const a = optimizeVaultPolicies([5, -2, 4, -1], 2000, 20260715);
  const b = optimizeVaultPolicies([5, -2, 4, -1], 2000, 20260715);
  assert.deepEqual(a, b);
});
