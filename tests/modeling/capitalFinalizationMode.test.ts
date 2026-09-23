import assert from "node:assert/strict";
import { test } from "node:test";

import { replayDynamicHarvest } from "../../lib/modeling/dynamicAwareVault";

const cutoff = "2026-09-01T12:00:00.000Z";
const candidate = (observationId: string, resolvedAtIso: string, signal_result: "won" | "lost") => ({
  observationId, identity: observationId, matchKey: observationId,
  decisionAtIso: "2026-09-01T10:00:00.000Z", createdAtIso: "2026-09-01T10:00:00.000Z",
  resolvedAtIso, finalScore: 80, dataCoverage: 100, entryPrice: 0.5,
  row: { signal_result } as any,
});

const policy = {
  family: "DYNAMIC_PRINCIPAL_RECOVERY_VAULT_V2" as const,
  id: "PRV2_T25_P50_R1_S0.05_C0.1",
  triggerProfitU: 25, principalTargetU: 50, principalRecoveryRate: 1,
  postRecoverySkimRate: 0.05, transferCapPctOfActiveReference: 0.1,
};

test("KEEP_OPEN_AT_CUTOFF retains unresolved principal at cost while SETTLE_ALL settles it", () => {
  const input = [
    candidate("A", "2026-09-01T11:00:00.000Z", "won"),
    candidate("B", "2026-09-02T11:00:00.000Z", "lost"),
  ];
  const kept = replayDynamicHarvest(input, policy, { finalizationMode: "KEEP_OPEN_AT_CUTOFF", cutoffAtIso: cutoff });
  assert.equal(kept.executed, 2);
  assert.equal(kept.settled, 1);
  assert.equal(kept.open, 1);
  assert.equal(kept.endingOpenPrincipal, kept.ledger.find((row) => row.observationId === "B")!.stake);
  assert.equal(kept.ledger.find((row) => row.observationId === "B")!.netPnl, 0);
  assert.equal(kept.endingVault, 0);
  assert.equal(kept.endingTotal, kept.endingFreeActive + kept.endingOpenPrincipal + kept.endingVault);

  const settled = replayDynamicHarvest(input, policy);
  assert.equal(settled.open, 0);
  assert.equal(settled.settled, 2);
  assert.notEqual(settled.pnl, kept.pnl);
});
