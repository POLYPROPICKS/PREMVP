import type { ExecutionCandidate } from "./executionWaterfall";
import { classifyResolvedOutcome } from "./roiPnlContract";
import { createStakeReferenceSchedule, minskNightKey } from "./stakeReferenceSchedule";
import { stableHash } from "./scientificCapitalArchitecture";
import { principalRecoveryTarget, type PrincipalRecoveryPolicy } from "./dynamicPrincipalRecoveryVault";
export interface BufferedProfitPolicy {
    family: "DYNAMIC_BUFFERED_PROFIT_HARVEST_V1";
    id: string;
    profitBufferU: number;
    profitLockRatio: number;
    transferCapPctOfActiveReference: number;
}
export interface VolatilityReservePolicy {
    family: "DYNAMIC_VOLATILITY_TARGETED_RESERVE_V1";
    id: string;
    profitBufferU: 10;
    lookback: 14;
    transferCapPctOfActiveReference: .05;
    targetVol?: number;
}
export type DynamicAwarePolicy = {
    family: "NO_VAULT";
    id: "DYNAMIC_NO_VAULT";
} | BufferedProfitPolicy | VolatilityReservePolicy | PrincipalRecoveryPolicy | {
    family: "ONE_WAY_RATCHETED_CPPI";
    id: "LOW_FLOOR_CPPI_DYNAMIC_CONTROL";
    alpha: .1;
    multiplier: 1;
};
export const DYNAMIC_AWARE_VAULT_POLICIES: readonly DynamicAwarePolicy[] = [
    { family: "NO_VAULT", id: "DYNAMIC_NO_VAULT" },
    { family: "DYNAMIC_BUFFERED_PROFIT_HARVEST_V1", id: "BUFFER_10_LOCK_010_CAP_0025", profitBufferU: 10, profitLockRatio: .1, transferCapPctOfActiveReference: .025 },
    { family: "DYNAMIC_BUFFERED_PROFIT_HARVEST_V1", id: "BUFFER_10_LOCK_020_CAP_005", profitBufferU: 10, profitLockRatio: .2, transferCapPctOfActiveReference: .05 },
    { family: "DYNAMIC_BUFFERED_PROFIT_HARVEST_V1", id: "BUFFER_25_LOCK_020_CAP_005", profitBufferU: 25, profitLockRatio: .2, transferCapPctOfActiveReference: .05 },
    { family: "DYNAMIC_BUFFERED_PROFIT_HARVEST_V1", id: "BUFFER_50_LOCK_025_CAP_005", profitBufferU: 50, profitLockRatio: .25, transferCapPctOfActiveReference: .05 },
    { family: "DYNAMIC_VOLATILITY_TARGETED_RESERVE_V1", id: "VOL_TARGET_14_BUFFER_10_CAP_005", profitBufferU: 10, lookback: 14, transferCapPctOfActiveReference: .05 },
    { family: "ONE_WAY_RATCHETED_CPPI", id: "LOW_FLOOR_CPPI_DYNAMIC_CONTROL", alpha: .1, multiplier: 1 },
] as const;
const round = (value: number) => Math.round(value * 1e8) / 1e8;
export function bufferedProfitTransfer(policy: Pick<BufferedProfitPolicy, "profitBufferU" | "profitLockRatio" | "transferCapPctOfActiveReference">, state: {
    initialTotal: number;
    settledHigh: number;
    vault: number;
    cycleTransferred: number;
    cycleReference: number;
    freeActive: number;
}): number { const values = [policy.profitBufferU, policy.profitLockRatio, policy.transferCapPctOfActiveReference, ...Object.values(state)]; if (!values.every(Number.isFinite) || values.some(value => value < 0))
    throw new Error("invalid buffered-profit state"); const target = policy.profitLockRatio * Math.max(state.settledHigh - state.initialTotal - policy.profitBufferU, 0), desired = Math.max(target - state.vault, 0), remaining = Math.max(policy.transferCapPctOfActiveReference * state.cycleReference - state.cycleTransferred, 0); return round(Math.min(desired, remaining, state.freeActive)); }
function volatility(values: readonly number[]): number { if (values.length < 2)
    return 0; const mean = values.reduce((sum, value) => sum + value, 0) / values.length; return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)); }
export function deriveDevelopmentVolatilityTarget(returns: readonly number[], lookback = 14): number { if (!Number.isInteger(lookback) || lookback < 2 || returns.length < lookback || !returns.every(Number.isFinite))
    throw new Error("insufficient development observations"); const rolling: number[] = []; for (let index = lookback; index <= returns.length; index++) {
    const value = volatility(returns.slice(index - lookback, index));
    if (value > 0 && Number.isFinite(value))
        rolling.push(value);
} if (!rolling.length)
    throw new Error("invalid development volatility target"); rolling.sort((a, b) => a - b); return round(rolling[Math.floor(rolling.length / 2)]); }
export function dynamicVaultEfficiency(numerator: number, cost: number): number | null { return cost > 0 ? round(numerator / cost) : null; }
export interface WinnerMetric {
    id: string;
    pnl: number;
    maximumFall: number;
    cvar95MaximumFall: number;
    endingVault: number;
    skipped: number;
    capitalValid: boolean;
    noFutureLeakage: boolean;
}
export function selectDynamicAwareVaultWinner(rows: readonly WinnerMetric[]) { const control = rows.find(row => row.id === "DYNAMIC_NO_VAULT"); if (!control)
    throw new Error("dynamic control required"); const evaluated = rows.map(row => ({ row, eligible: row.id !== control.id && row.pnl / control.pnl >= .8 && (control.maximumFall - row.maximumFall) / control.maximumFall >= .15 && (control.cvar95MaximumFall - row.cvar95MaximumFall) / control.cvar95MaximumFall >= .1 && row.endingVault > 0 && row.pnl > 0 && row.capitalValid && row.noFutureLeakage })); const eligible = evaluated.filter(item => item.eligible).map(item => item.row).sort((a, b) => { const pnl = b.pnl - a.pnl; if (Math.abs(pnl) >= 1)
    return pnl; return a.cvar95MaximumFall - b.cvar95MaximumFall || a.maximumFall - b.maximumFall || a.skipped - b.skipped || a.id.localeCompare(b.id); }); return { control, eligible: evaluated, winner: eligible[0] ?? control }; }
export interface DynamicTransfer {
    atIso: string;
    cycleId: string;
    amount: number;
    cycleReference: number;
    targetVault: number;
    reason: "BUFFERED_PROFIT" | "VOLATILITY_TARGET" | "PRINCIPAL_RECOVERY";
}
export interface DynamicLedger {
    observationId: string;
    decisionAtIso: string;
    resolvedAtIso: string;
    stake: number;
    result: "win" | "loss";
    netPnl: number;
    terminalReason: "EXECUTED_FULL" | "POSITION_LIMIT" | "EXPOSURE_LIMIT" | "INSUFFICIENT_ACTIVE_CAPACITY";
}
export interface DynamicCurve {
    atIso: string;
    freeActive: number;
    openPrincipal: number;
    active: number;
    vault: number;
    total: number;
    fallFromTotalPeak: number;
    fallFromActivePeak: number;
}
export interface DynamicHarvestReplay {
    policy: DynamicAwarePolicy;
    intendedSignals: number;
    executed: number;
    skipped: number;
    skipReasons: Record<string, number>;
    wins: number;
    losses: number;
    totalStaked: number;
    pnl: number;
    roi: number;
    endingFreeActive: number;
    endingOpenPrincipal: number;
    endingActive: number;
    endingVault: number;
    endingTotal: number;
    minimumTotal: number;
    minimumActive: number;
    minimumFreeActive: number;
    maximumFallFromTotalPeak: number;
    maximumFallFromActivePeak: number;
    maximumConcurrentPositions: number;
    maximumLockedPrincipal: number;
    invalidCapitalStates: number;
    blockPnl: Record<string, number>;
    ledger: DynamicLedger[];
    curve: DynamicCurve[];
    transfers: DynamicTransfer[];
    selectionHash: string;
    executionLedgerHash: string;
    capitalCurveHash: string;
    transferLedgerHash: string;
    settledReturns: number[];
}
export function replayDynamicHarvest(candidates: readonly ExecutionCandidate[], policy: Exclude<DynamicAwarePolicy, {
    family: "ONE_WAY_RATCHETED_CPPI";
}>): DynamicHarvestReplay { if (policy.family === "DYNAMIC_VOLATILITY_TARGETED_RESERVE_V1" && (!policy.targetVol || !Number.isFinite(policy.targetVol) || policy.targetVol <= 0))
    throw new Error("invalid locked volatility target"); const ordered = [...candidates].sort((a, b) => Date.parse(a.decisionAtIso) - Date.parse(b.decisionAtIso) || b.finalScore - a.finalScore || b.dataCoverage - a.dataCoverage || a.entryPrice - b.entryPrice || a.observationId.localeCompare(b.observationId)); const schedule = createStakeReferenceSchedule("MINSK_NIGHT_FIXED_MAX3_V1", 50); let free = 50, vault = 0, settledHigh = 50, totalPeak = 50, activePeak = 50, minTotal = 50, minActive = 50, minFree = 50, maxFall = 0, maxActiveFall = 0, maxConcurrent = 0, maxLocked = 0, invalid = 0, previousSettledTotal = 50; const open: Array<{
    candidate: ExecutionCandidate;
    resolved: number;
    stake: number;
}> = [], ledger: DynamicLedger[] = [], curve: DynamicCurve[] = [], transfers: DynamicTransfer[] = [], blockPnl: Record<string, number> = {}, cycleTransferred = new Map<string, number>(), settledReturns: number[] = []; const point = (atIso: string) => { const principal = round(open.reduce((sum, item) => sum + item.stake, 0)), active = round(free + principal), total = round(active + vault); totalPeak = Math.max(totalPeak, total); activePeak = Math.max(activePeak, active); minTotal = Math.min(minTotal, total); minActive = Math.min(minActive, active); minFree = Math.min(minFree, free); maxFall = Math.max(maxFall, totalPeak - total); maxActiveFall = Math.max(maxActiveFall, activePeak - active); maxConcurrent = Math.max(maxConcurrent, open.length); maxLocked = Math.max(maxLocked, principal); if (free < -.0000001 || vault < -.0000001 || Math.abs(active + vault - total) > .000001)
    invalid++; curve.push({ atIso, freeActive: round(free), openPrincipal: principal, active, vault: round(vault), total, fallFromTotalPeak: round(totalPeak - total), fallFromActivePeak: round(activePeak - active) }); }; point("INITIAL"); const applyHarvest = (at: number) => { const principal = open.reduce((sum, item) => sum + item.stake, 0), active = free + principal, total = active + vault; settledHigh = Math.max(settledHigh, total); const settledReturn = previousSettledTotal ? total / previousSettledTotal - 1 : 0; settledReturns.push(settledReturn); previousSettledTotal = total; if (policy.family === "NO_VAULT")
    return; const cycleId = minskNightKey(at), cycleReference = schedule.referenceFor(at, active), used = cycleTransferred.get(cycleId) ?? 0; let amount = 0; if (policy.family === "DYNAMIC_PRINCIPAL_RECOVERY_VAULT_V2") {
    const target = principalRecoveryTarget(policy, Math.max(settledHigh - 50, 0));
    amount = round(Math.min(Math.max(target - vault, 0), Math.max(policy.transferCapPctOfActiveReference * cycleReference - used, 0), free));
} else { let ratio = policy.family === "DYNAMIC_BUFFERED_PROFIT_HARVEST_V1" ? policy.profitLockRatio : 0; if (policy.family === "DYNAMIC_VOLATILITY_TARGETED_RESERVE_V1" && settledReturns.length >= policy.lookback) {
    const realized = volatility(settledReturns.slice(-policy.lookback));
    ratio = Math.min(.05, .5 * Math.max(realized / policy.targetVol! - 1, 0));
} amount = bufferedProfitTransfer({ profitBufferU: policy.profitBufferU, profitLockRatio: ratio, transferCapPctOfActiveReference: policy.transferCapPctOfActiveReference }, { initialTotal: 50, settledHigh, vault, cycleTransferred: used, cycleReference, freeActive: free }); } if (amount > 0) {
    free = round(free - amount);
    vault = round(vault + amount);
    cycleTransferred.set(cycleId, round(used + amount));
    transfers.push({ atIso: new Date(at).toISOString(), cycleId, amount, cycleReference: round(cycleReference), targetVault: round(vault), reason: policy.family === "DYNAMIC_BUFFERED_PROFIT_HARVEST_V1" ? "BUFFERED_PROFIT" : policy.family === "DYNAMIC_PRINCIPAL_RECOVERY_VAULT_V2" ? "PRINCIPAL_RECOVERY" : "VOLATILITY_TARGET" });
} }; const settle = (through: number) => { const due = open.filter(item => item.resolved <= through).sort((a, b) => a.resolved - b.resolved || a.candidate.observationId.localeCompare(b.candidate.observationId)); for (let index = 0; index < due.length;) {
    const resolved = due[index].resolved, batch: typeof due = [];
    while (index < due.length && due[index].resolved === resolved)
        batch.push(due[index++]);
    for (const item of batch) {
        open.splice(open.indexOf(item), 1);
        const result = classifyResolvedOutcome(item.candidate.row).label as "win" | "loss", pnl = result === "win" ? item.stake * (1 / item.candidate.entryPrice - 1) : -item.stake;
        free = round(free + item.stake + pnl);
        const entry = ledger.find(row => row.observationId === item.candidate.observationId)!;
        entry.netPnl = round(pnl);
        const block = minskNightKey(Date.parse(entry.decisionAtIso));
        blockPnl[block] = round((blockPnl[block] ?? 0) + pnl);
    }
    applyHarvest(resolved);
    point(new Date(resolved).toISOString());
} }; for (let index = 0; index < ordered.length;) {
    const at = Date.parse(ordered[index].decisionAtIso);
    settle(at);
    const batch: ExecutionCandidate[] = [];
    while (index < ordered.length && Date.parse(ordered[index].decisionAtIso) === at)
        batch.push(ordered[index++]);
    for (const candidate of batch) {
        const active = free + open.reduce((sum, item) => sum + item.stake, 0), reference = schedule.referenceFor(at, active), stake = round(.03 * reference), exposure = open.reduce((sum, item) => sum + item.stake, 0);
        let reason: DynamicLedger["terminalReason"] = "EXECUTED_FULL";
        if (open.length >= 36)
            reason = "POSITION_LIMIT";
        else if (exposure + stake > reference + 1e-8)
            reason = "EXPOSURE_LIMIT";
        else if (free + 1e-8 < stake)
            reason = "INSUFFICIENT_ACTIVE_CAPACITY";
        const result = classifyResolvedOutcome(candidate.row).label;
        if ((result !== "win" && result !== "loss") || !Number.isFinite(Date.parse(candidate.resolvedAtIso)))
            throw new Error("invalid candidate");
        ledger.push({ observationId: candidate.observationId, decisionAtIso: candidate.decisionAtIso, resolvedAtIso: candidate.resolvedAtIso, stake: reason === "EXECUTED_FULL" ? stake : 0, result, netPnl: 0, terminalReason: reason });
        if (reason === "EXECUTED_FULL") {
            free = round(free - stake);
            open.push({ candidate, resolved: Date.parse(candidate.resolvedAtIso), stake });
        }
    }
    point(new Date(at).toISOString());
} settle(Infinity); point("FINAL"); const executed = ledger.filter(row => row.stake > 0), pnl = round(executed.reduce((sum, row) => sum + row.netPnl, 0)), totalStaked = round(executed.reduce((sum, row) => sum + row.stake, 0)), last = curve.at(-1)!; return { policy, intendedSignals: candidates.length, executed: executed.length, skipped: candidates.length - executed.length, skipReasons: Object.fromEntries(["POSITION_LIMIT", "EXPOSURE_LIMIT", "INSUFFICIENT_ACTIVE_CAPACITY"].map(reason => [reason, ledger.filter(row => row.terminalReason === reason).length])), wins: executed.filter(row => row.result === "win").length, losses: executed.filter(row => row.result === "loss").length, totalStaked, pnl, roi: round(pnl / totalStaked * 100), endingFreeActive: last.freeActive, endingOpenPrincipal: last.openPrincipal, endingActive: last.active, endingVault: last.vault, endingTotal: last.total, minimumTotal: round(minTotal), minimumActive: round(minActive), minimumFreeActive: round(minFree), maximumFallFromTotalPeak: round(maxFall), maximumFallFromActivePeak: round(maxActiveFall), maximumConcurrentPositions: maxConcurrent, maximumLockedPrincipal: round(maxLocked), invalidCapitalStates: invalid, blockPnl, ledger, curve, transfers, selectionHash: stableHash({ policy, intended: candidates.map(candidate => candidate.observationId).sort() }), executionLedgerHash: stableHash(ledger), capitalCurveHash: stableHash(curve), transferLedgerHash: stableHash(transfers), settledReturns }; }
