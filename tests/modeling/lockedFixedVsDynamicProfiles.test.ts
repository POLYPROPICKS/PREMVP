import assert from "node:assert/strict";
import test from "node:test";
import { assertLockedFourArmProfiles, LOCKED_CPPI_04_05, LOCKED_NO_VAULT } from "../../lib/modeling/lockedFixedVsDynamicProfiles";
import { stableHash, type ScientificCapitalReplay } from "../../lib/modeling/scientificCapitalArchitecture";

test("locked four-arm guard rejects a fifth arm and changed CPPI parameters", () => {
  assert.deepEqual(LOCKED_CPPI_04_05, { family: "ONE_WAY_RATCHETED_CPPI", id: "CPPI_0.4_0.5", alpha: .4, multiplier: .5 });
  assert.equal(LOCKED_NO_VAULT.family, "NO_VAULT_FIXED100");
  const replay = { ledger: [{ observationId: "a", stake: 1 }], policy: LOCKED_NO_VAULT, capacity: {}, curve: [], invalidCapitalStates: 0 } as unknown as ScientificCapitalReplay;
  const row = { id: "FIXED_1U_NO_VAULT" as const, replay, selectionHash: "x", maximumConcurrentPositions: 1, maximumLockedPrincipal: 1, capitalValid: true };
  assert.throws(() => assertLockedFourArmProfiles([row, row, row, row, row], stableHash(["a"])));
});
