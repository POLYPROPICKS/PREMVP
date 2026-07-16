import assert from "node:assert/strict";
import test from "node:test";
import type { ScientificCapitalReplay } from "../../lib/modeling/scientificCapitalArchitecture";
import { selectLockedVaultResults, vaultDisplayId, type LockedVaultResult } from "../../lib/modeling/lockedPrimaryVaultFrontier";

const make = (id: string, vault: number, pnl: number, cvar: number, skips = 0): LockedVaultResult => ({
  policy: id === "control"
    ? { family: "NO_VAULT_FIXED100", id: "NO_VAULT_FIXED100" }
    : { family: "STATIC_CAPITAL_FLOOR", id, alpha: 0.2 },
  replay: { endingVault: vault, netPnl: pnl, skippedPositions: skips } as Pick<ScientificCapitalReplay, "endingVault" | "netPnl" | "skippedPositions"> as ScientificCapitalReplay,
  risk: { cvar95TerminalLoss: 0, cvar95MaximumFall: cvar, probabilityBelowInitial: 0 },
  pnlRetainedPct: pnl,
  vaultProtected: vault,
  cvarReduction: 0,
  maximumFallReduction: 0,
});

test("locked Vault selection is deterministic and requires positive protected lower-tail improvement", () => {
  const control = make("control", 0, 10, 8);
  const eligible = make("STATIC_0.2", 5, 9, 7);
  const blocked = make("STATIC_0.3", 6, 9, 8);
  const one = selectLockedVaultResults([blocked, control, eligible]);
  const two = selectLockedVaultResults([eligible, blocked, control]);
  assert.equal(one.balanced.policy.id, "STATIC_0.2");
  assert.equal(one.maxPnl.policy.id, "NO_VAULT_FIXED100");
  assert.deepEqual(one, two);
  assert.equal(vaultDisplayId(control.policy), "NO_VAULT_FIXED1U");
});
