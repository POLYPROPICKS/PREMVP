import type { ScientificCapitalPolicy, ScientificCapitalReplay } from "./scientificCapitalArchitecture";
import { stableHash } from "./scientificCapitalArchitecture";

export const LOCKED_CPPI_04_05: ScientificCapitalPolicy = { family: "ONE_WAY_RATCHETED_CPPI", id: "CPPI_0.4_0.5", alpha: .4, multiplier: .5 };
export const LOCKED_NO_VAULT: ScientificCapitalPolicy = { family: "NO_VAULT_FIXED100", id: "NO_VAULT_FIXED100" };
export type LockedProfileId = "FIXED_1U_NO_VAULT" | "FIXED_1U_CPPI_0.4_0.5" | "DYNAMIC_ACTIVE_3PCT_NO_VAULT" | "DYNAMIC_ACTIVE_3PCT_CPPI_0.4_0.5";
export interface LockedProfileResult { id: LockedProfileId; replay: ScientificCapitalReplay; selectionHash: string; maximumConcurrentPositions: number; maximumLockedPrincipal: number; capitalValid: boolean; }

export function maximumConcurrentPositions(replay: ScientificCapitalReplay): number {
  const events = replay.ledger.filter(row => row.stake > 0).flatMap(row => [{ at: Date.parse(row.decisionAtIso), delta: 1 }, { at: Date.parse(row.resolvedAtIso), delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0, maximum = 0; for (const event of events) { current += event.delta; maximum = Math.max(maximum, current); } return maximum;
}
export function profileResult(id: LockedProfileId, replay: ScientificCapitalReplay): LockedProfileResult {
  return { id, replay, selectionHash: stableHash({ id, policy: replay.policy, capacity: replay.capacity, intendedIds: replay.ledger.map(row => row.observationId).sort() }), maximumConcurrentPositions: maximumConcurrentPositions(replay), maximumLockedPrincipal: Math.max(...replay.curve.map(point => point.openPrincipal)), capitalValid: replay.invalidCapitalStates === 0 && replay.curve.every(point => point.active >= -1e-8 && point.vault >= -1e-8) };
}
export function assertLockedFourArmProfiles(rows: readonly LockedProfileResult[], intendedIdsSha256: string): void {
  if (rows.length !== 4 || new Set(rows.map(row => row.id)).size !== 4) throw new Error("exactly four profiles are required");
  for (const row of rows) { if (stableHash(row.replay.ledger.map(entry => entry.observationId).sort()) !== intendedIdsSha256) throw new Error("profile intended ID sequence mismatch"); if (row.id.startsWith("FIXED") && row.replay.ledger.filter(entry => entry.stake > 0).some(entry => entry.stake !== 1)) throw new Error("fixed profile stake mismatch"); }
}
