import assert from "node:assert/strict";
import test from "node:test";
import {
  DYNAMIC_AWARE_VAULT_POLICIES,
  bufferedProfitTransfer,
  deriveDevelopmentVolatilityTarget,
  dynamicVaultEfficiency,
  selectDynamicAwareVaultWinner,
} from "../../lib/modeling/dynamicAwareVault";

test("registry contains exactly the seven predeclared arms", () => {
  assert.equal(DYNAMIC_AWARE_VAULT_POLICIES.length, 7);
  assert.equal(new Set(DYNAMIC_AWARE_VAULT_POLICIES.map(policy => policy.id)).size, 7);
  assert.deepEqual(DYNAMIC_AWARE_VAULT_POLICIES.at(-1), { family: "ONE_WAY_RATCHETED_CPPI", id: "LOW_FLOOR_CPPI_DYNAMIC_CONTROL", alpha: .1, multiplier: 1 });
});

test("buffered harvest is profit-only and bounded by target, cycle cap, and free cash", () => {
  const policy = { profitBufferU: 10, profitLockRatio: .2, transferCapPctOfActiveReference: .05 };
  assert.equal(bufferedProfitTransfer(policy, { initialTotal: 50, settledHigh: 59, vault: 0, cycleTransferred: 0, cycleReference: 50, freeActive: 50 }), 0);
  assert.equal(bufferedProfitTransfer(policy, { initialTotal: 50, settledHigh: 80, vault: 0, cycleTransferred: 0, cycleReference: 50, freeActive: 50 }), 2.5);
  assert.equal(bufferedProfitTransfer(policy, { initialTotal: 50, settledHigh: 80, vault: 3.5, cycleTransferred: 0, cycleReference: 50, freeActive: 50 }), .5);
  assert.equal(bufferedProfitTransfer(policy, { initialTotal: 50, settledHigh: 80, vault: 0, cycleTransferred: 2, cycleReference: 50, freeActive: 50 }), .5);
  assert.equal(bufferedProfitTransfer(policy, { initialTotal: 50, settledHigh: 80, vault: 0, cycleTransferred: 0, cycleReference: 50, freeActive: 1 }), 1);
});

test("volatility target is development-only and fails closed", () => {
  const development = Array.from({ length: 20 }, (_, index) => index % 2 ? .02 : -.01);
  const one = deriveDevelopmentVolatilityTarget(development, 14);
  const two = deriveDevelopmentVolatilityTarget([...development], 14);
  assert.equal(one, two);
  assert.throws(() => deriveDevelopmentVolatilityTarget([0, 0, 0], 14));
});

test("eligibility and winner rule are exact and deterministic", () => {
  const control = { id: "DYNAMIC_NO_VAULT", pnl: 100, maximumFall: 20, cvar95MaximumFall: 30, endingVault: 0, skipped: 1, capitalValid: true, noFutureLeakage: true };
  const eligible = { ...control, id: "B", pnl: 82, maximumFall: 16, cvar95MaximumFall: 26, endingVault: 10, skipped: 2 };
  const blocked = { ...eligible, id: "C", pnl: 79.999 };
  assert.equal(selectDynamicAwareVaultWinner([blocked, eligible, control]).winner.id, "B");
  assert.equal(selectDynamicAwareVaultWinner([control, eligible, blocked]).winner.id, "B");
  assert.equal(dynamicVaultEfficiency(10, 0), null);
});
