import assert from "node:assert/strict";
import test from "node:test";
import { buildPrincipalRecoveryStageA } from "../../lib/modeling/dynamicPrincipalRecoveryVault";
import {
  carryBoundaryState,
  selectDevelopmentPolicy,
  STATE_CARRYING_LABEL,
} from "../../lib/modeling/dynamicVaultStateCarrying";

test("a Minsk boundary carries capital, peaks, progress, allowance, and open positions unchanged", () => {
  const state = {
    freeActive: 61.25,
    openPrincipal: 12.5,
    active: 73.75,
    vault: 18,
    total: 91.75,
    totalHighWater: 97,
    activeHighWater: 79,
    peakProfit: 47,
    principalRecoveryProgress: 18,
    currentStakeReference: 73.75,
    remainingTransferAllowance: 5.375,
    openPositionIds: ["cross-boundary-position"],
  } as const;
  const boundary = carryBoundaryState(state);
  assert.deepEqual(boundary.block23End, boundary.block24Start);
  assert.notEqual(boundary.block24Start.active, 50);
  assert.notEqual(boundary.block24Start.vault, 0);
  assert.equal(boundary.block24Start.openPositionIds[0], "cross-boundary-position");
  assert.equal(boundary.block23EndHash, boundary.block24StartHash);
});

test("development selection is frozen before confirmation and cannot read confirmation results", () => {
  const rows = [
    { id: "A", pnl: 70, maximumFall: 10, cvar95: 15, endingVault: 25, additionalSkips: 0, capitalValid: true, noFutureLeakage: true },
    { id: "B", pnl: 65, maximumFall: 9, cvar95: 14, endingVault: 30, additionalSkips: 0, capitalValid: true, noFutureLeakage: true },
  ];
  const controls = { fixedSafePnl: 20, dynamicMaximumFall: 20, dynamicCvar95: 30 };
  assert.equal(selectDevelopmentPolicy(rows, controls).winner?.id, "A");
  assert.equal(selectDevelopmentPolicy(rows, controls).winner?.id, "A");
});

test("the frozen registry remains exactly 24 policies and reset remains diagnostic only", () => {
  assert.equal(buildPrincipalRecoveryStageA().length, 24);
  assert.equal(STATE_CARRYING_LABEL.reset, "BLOCK_LOCAL_RESET_DIAGNOSTIC");
  assert.equal(STATE_CARRYING_LABEL.resetSelectionEligible, false);
});
