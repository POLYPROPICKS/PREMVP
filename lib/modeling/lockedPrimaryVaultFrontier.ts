import type { ScientificCapitalPolicy, ScientificCapitalReplay } from "./scientificCapitalArchitecture";

export interface LockedVaultResult { policy: ScientificCapitalPolicy; replay: ScientificCapitalReplay; risk: { cvar95TerminalLoss: number; cvar95MaximumFall: number; probabilityBelowInitial: number }; pnlRetainedPct: number; vaultProtected: number; cvarReduction: number; maximumFallReduction: number }
const familyRank: Record<ScientificCapitalPolicy["family"], number> = { NO_VAULT_FIXED100: 0, STATIC_CAPITAL_FLOOR: 1, HIGH_WATERMARK_DRAWDOWN_FLOOR: 2, ONE_WAY_RATCHETED_CPPI: 3 };
export function vaultDisplayId(policy: ScientificCapitalPolicy): string { return policy.family === "NO_VAULT_FIXED100" ? "NO_VAULT_FIXED1U" : policy.id; }
export function selectLockedVaultResults(rows: readonly LockedVaultResult[]) {
  const control = rows.find((row) => row.policy.family === "NO_VAULT_FIXED100"); if (!control) throw new Error("NO_VAULT_FIXED1U control is required");
  const maxPnl = [...rows].sort((a, b) => b.replay.netPnl - a.replay.netPnl || a.replay.skippedPositions - b.replay.skippedPositions || familyRank[a.policy.family] - familyRank[b.policy.family] || a.policy.id.localeCompare(b.policy.id))[0];
  const minTailRisk = [...rows].sort((a, b) => a.risk.cvar95MaximumFall - b.risk.cvar95MaximumFall || a.policy.id.localeCompare(b.policy.id))[0];
  const maxProtection = [...rows].sort((a, b) => b.replay.endingVault - a.replay.endingVault || a.risk.cvar95MaximumFall - b.risk.cvar95MaximumFall || a.policy.id.localeCompare(b.policy.id))[0];
  const eligible = rows.filter((row) => row.replay.endingVault > 0 && row.replay.netPnl > 0 && row.risk.cvar95MaximumFall < control.risk.cvar95MaximumFall);
  const balanced = eligible.length ? [...eligible].sort((a, b) => b.pnlRetainedPct - a.pnlRetainedPct || b.replay.endingVault - a.replay.endingVault || a.risk.cvar95MaximumFall - b.risk.cvar95MaximumFall || a.replay.skippedPositions - b.replay.skippedPositions || familyRank[a.policy.family] - familyRank[b.policy.family] || a.policy.id.localeCompare(b.policy.id))[0] : control;
  return { control, maxPnl, minTailRisk, maxProtection, balanced, balancedEligibleCount: eligible.length };
}
