import test from "node:test";
import assert from "node:assert/strict";
import { allocateStakeCapacity } from "../../lib/modeling/stakeAllocationOptimizer";

const candidate = (id: string, edge: number) => ({ observationId: id, decisionAtMs: 100, resolvedAtMs: 1000, robustExpectedRoi: edge, requestedTier: 1 as const, finalScore: 70, dataCoverage: 80, entryPrice: 0.5, createdAtMs: 1 });

test("reference maximum does not shrink and allocation is input-order invariant", () => {
  const input = [candidate("a", 0.4), candidate("b", 0.3)];
  const a = allocateStakeCapacity(input, { cycleReferenceActiveBankroll: 100, maxStakePct: 0.03 });
  const b = allocateStakeCapacity([...input].reverse(), { cycleReferenceActiveBankroll: 100, maxStakePct: 0.03 });
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((x) => x.maxStakePerMatch), [3, 3]);
  assert.ok(a.every((x) => x.actualStake <= 3));
});

test("capacity reduction targets weakest robust edge and enforces limits", () => {
  const input = Array.from({ length: 31 }, (_, i) => candidate(String(i).padStart(2, "0"), 1 - i / 100));
  const result = allocateStakeCapacity(input, { cycleReferenceActiveBankroll: 100, maxStakePct: 0.03 });
  assert.ok(result.filter((x) => x.actualStake > 0).length <= 30);
  assert.ok(result.reduce((s, x) => s + x.actualStake, 0) <= 80 + 1e-8);
  assert.equal(result.at(-1)?.observationId, "30");
});
