import type { DynamicHarvestReplay } from "./dynamicAwareVault";
import { minskNightKey } from "./stakeReferenceSchedule";
import { stableHash } from "./scientificCapitalArchitecture";

export const STATE_CARRYING_LABEL = {
  confirmation: "state-carrying historical pseudo-out-of-sample confirmation",
  reset: "BLOCK_LOCAL_RESET_DIAGNOSTIC",
  resetSelectionEligible: false,
} as const;

export interface CarriedVaultState {
  freeActive: number;
  openPrincipal: number;
  active: number;
  vault: number;
  total: number;
  totalHighWater: number;
  activeHighWater: number;
  peakProfit: number;
  principalRecoveryProgress: number;
  currentStakeReference: number;
  remainingTransferAllowance: number;
  openPositionIds: readonly string[];
}

export interface DevelopmentSelectionMetric {
  id: string;
  pnl: number;
  maximumFall: number;
  cvar95: number;
  endingVault: number;
  additionalSkips: number;
  capitalValid: boolean;
  noFutureLeakage: boolean;
}

export function carryBoundaryState(state: CarriedVaultState) {
  const snapshot = Object.freeze({ ...state, openPositionIds: Object.freeze([...state.openPositionIds]) });
  const hash = stableHash(snapshot);
  return { block23End: snapshot, block24Start: snapshot, block23EndHash: hash, block24StartHash: hash };
}

export function selectDevelopmentPolicy(rows: readonly DevelopmentSelectionMetric[], controls: {
  fixedSafePnl: number;
  dynamicMaximumFall: number;
  dynamicCvar95: number;
}) {
  const evaluated = rows.map(row => ({ row, eligible: row.endingVault > 0 && row.pnl > controls.fixedSafePnl && row.maximumFall < controls.dynamicMaximumFall && row.cvar95 < controls.dynamicCvar95 && row.capitalValid && row.noFutureLeakage }));
  const eligible = evaluated.filter(item => item.eligible).map(item => item.row).sort((a, b) => {
    const pnlDifference = b.pnl - a.pnl;
    if (Math.abs(pnlDifference) >= 1) return pnlDifference;
    return a.cvar95 - b.cvar95 || a.maximumFall - b.maximumFall || a.additionalSkips - b.additionalSkips || a.id.localeCompare(b.id);
  });
  return { evaluated, winner: eligible[0] ?? null };
}

export function stateAtBoundary(replay: DynamicHarvestReplay, boundaryMs: number, transferCapPct: number): CarriedVaultState {
  const points = replay.curve.filter(point => point.atIso !== "INITIAL" && point.atIso !== "FINAL" && Date.parse(point.atIso) < boundaryMs);
  const point = points.at(-1) ?? replay.curve[0];
  const openRows = replay.ledger.filter(row => row.stake > 0 && Date.parse(row.decisionAtIso) < boundaryMs && Date.parse(row.resolvedAtIso) >= boundaryMs);
  const block23 = minskNightKey(boundaryMs - 1);
  const blockRows = replay.ledger.filter(row => minskNightKey(Date.parse(row.decisionAtIso)) === block23 && row.stake > 0);
  const currentStakeReference = blockRows.length ? blockRows[0].stake / .03 : point.active;
  const cycleTransferred = replay.transfers.filter(row => row.cycleId === block23).reduce((sum, row) => sum + row.amount, 0);
  const totalHighWater = point.total + point.fallFromTotalPeak;
  const activeHighWater = point.active + point.fallFromActivePeak;
  return {
    freeActive: point.freeActive,
    openPrincipal: point.openPrincipal,
    active: point.active,
    vault: point.vault,
    total: point.total,
    totalHighWater,
    activeHighWater,
    peakProfit: Math.max(totalHighWater - 50, 0),
    principalRecoveryProgress: point.vault,
    currentStakeReference,
    remainingTransferAllowance: Math.max(transferCapPct * currentStakeReference - cycleTransferred, 0),
    openPositionIds: openRows.map(row => row.observationId).sort(),
  };
}

export function chronologicalTailMean95(values: readonly number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => b - a);
  const count = Math.max(1, Math.ceil(ordered.length * .05));
  return ordered.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
}
