import { createHash } from "node:crypto";
import type { ExecutionCandidate } from "./executionWaterfall";
import { classifyResolvedOutcome } from "./roiPnlContract";
import { createStakeReferenceSchedule, isInsideMinskOperationalWindow, minskNightKey } from "./stakeReferenceSchedule";

export const SCIENTIFIC_CAPITAL_ARCHITECTURE_VERSION = "SCIENTIFIC_CAPITAL_ARCHITECTURE_V1" as const;
export const STARTING_CAPITAL_USD = 10_000;
export const FIXED_STAKE_USD = 100;

export type ScientificCapitalPolicy =
  | { family: "NO_VAULT_FIXED100"; id: "NO_VAULT_FIXED100" }
  | { family: "STATIC_CAPITAL_FLOOR"; id: string; alpha: number }
  | { family: "HIGH_WATERMARK_DRAWDOWN_FLOOR"; id: string; alpha: number }
  | { family: "ONE_WAY_RATCHETED_CPPI"; id: string; alpha: number; multiplier: number };

export interface ScientificCapacity { maxOpenPositions: number; maxOpenExposurePct: number; maxAcceptedPerOperatingDay?: number; operationWindowOnly?: boolean; stakePolicy?: "FIXED_100" | "DYNAMIC_ACTIVE_3PCT"; initialTotalCapital?: number; fixedStake?: number }
export interface CapitalLedgerRow { observationId: string; decisionAtIso: string; resolvedAtIso: string; operatingDay: string; stake: number; entryPrice: number; result: "win" | "loss"; netPnl: number; terminalReason: "EXECUTED_FULL" | "WINDOW_EXCLUDED" | "DAILY_LIMIT" | "POSITION_LIMIT" | "EXPOSURE_LIMIT" | "INSUFFICIENT_ACTIVE_CAPACITY" }
export interface CapitalCurvePoint { atIso: string; freeActive: number; openPrincipal: number; active: number; vault: number; total: number; fallFromTotalPeak: number; fallFromActivePeak: number }
export interface CapitalTransfer { atIso: string; amount: number; reason: "INITIAL_STATIC" | "HIGH_WATERMARK_RATCHET" | "CPPI_FLOOR_RATCHET" }
export interface ScientificCapitalReplay {
  version: typeof SCIENTIFIC_CAPITAL_ARCHITECTURE_VERSION; policy: ScientificCapitalPolicy; capacity: ScientificCapacity;
  eligibleMatches: number; executedMatches: number; skippedPositions: number; skipReasons: Record<string, number>;
  wins: number; losses: number; totalStaked: number; netPnl: number; roi: number | null;
  endingActive: number; endingVault: number; endingTotal: number; minimumTotal: number;
  maximumFallFromTotalPeak: number; maximumFallFromActivePeak: number; invalidCapitalStates: number;
  blockPnl: Record<string, number>; ledger: CapitalLedgerRow[]; curve: CapitalCurvePoint[]; transfers: CapitalTransfer[];
  executionLedgerHash: string; capitalCurveHash: string;
}

export interface CapitalPolicyScore { policy: ScientificCapitalPolicy; confirmationPnl: number; cvar95MaxFall: number; probabilityBelowInitial: number; endingVault: number; skippedPositions: number; spaConsistent: number; spaUpper: number }
export interface BootstrapRiskSummary { p10EndingCapital: number; medianEndingCapital: number; p90EndingCapital: number; cvar95TerminalLoss: number; cvar95MaximumFall: number; probabilityBelowInitial: number }
export interface DevelopmentPolicyMetric { policy: ScientificCapitalPolicy; developmentPnl: number; maximumFall: number; skippedPositions: number }
export interface FinalArchitectureCell {
  model: string;
  stakePolicy: "FIXED_100" | "DYNAMIC_ACTIVE_3PCT";
  selectionHash: string;
  eligibleForFinalSelection: boolean;
  confirmation: { netPnl: number; invalidCapitalStates: number; maximumFallFromTotalPeak: number; risk: { cvar95MaximumFall: number; probabilityBelowInitial: number } };
}

const round = (value: number) => Math.round(value * 1e8) / 1e8;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function stableHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

const fmt = (value: number) => value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
function staticPolicy(alpha: number): ScientificCapitalPolicy { return { family: "STATIC_CAPITAL_FLOOR", id: `STATIC_${fmt(alpha)}`, alpha }; }
function hwmPolicy(alpha: number): ScientificCapitalPolicy { return { family: "HIGH_WATERMARK_DRAWDOWN_FLOOR", id: `HWM_${fmt(alpha)}`, alpha }; }
function cppiPolicy(alpha: number, multiplier: number): ScientificCapitalPolicy { return { family: "ONE_WAY_RATCHETED_CPPI", id: `CPPI_${fmt(alpha)}_${fmt(multiplier)}`, alpha, multiplier }; }

export function buildCapitalPolicyGrid(refineAround: readonly ScientificCapitalPolicy[]): ScientificCapitalPolicy[] {
  const policies: ScientificCapitalPolicy[] = [{ family: "NO_VAULT_FIXED100", id: "NO_VAULT_FIXED100" }];
  for (const alpha of [.1, .2, .3, .4, .5, .6]) policies.push(staticPolicy(alpha));
  for (const alpha of [.1, .2, .3, .4, .5, .6]) policies.push(hwmPolicy(alpha));
  for (const alpha of [.2, .4, .6]) for (const multiplier of [.25, .5, .75, 1]) policies.push(cppiPolicy(alpha, multiplier));
  const candidates: ScientificCapitalPolicy[] = [];
  for (const policy of refineAround.slice(0, 3)) {
    if (policy.family === "NO_VAULT_FIXED100") continue;
    for (const delta of [-.05, .05]) {
      const alpha = round(policy.alpha + delta); if (alpha < .05 || alpha > .7) continue;
      candidates.push(policy.family === "STATIC_CAPITAL_FLOOR" ? staticPolicy(alpha) : policy.family === "HIGH_WATERMARK_DRAWDOWN_FLOOR" ? hwmPolicy(alpha) : cppiPolicy(alpha, policy.multiplier));
    }
    if (policy.family === "ONE_WAY_RATCHETED_CPPI") for (const delta of [-.125, .125]) {
      const multiplier = round(policy.multiplier + delta); if (multiplier >= .125 && multiplier <= 1) candidates.push(cppiPolicy(policy.alpha, multiplier));
    }
  }
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  for (const policy of candidates.sort((a, b) => a.id.localeCompare(b.id))) if (byId.size < 35) byId.set(policy.id, policy);
  return [...byId.values()];
}

export function selectDevelopmentParetoPolicies(rows: readonly DevelopmentPolicyMetric[], limit = 3): ScientificCapitalPolicy[] {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 3) throw new Error("development Pareto limit must be between 1 and 3");
  if (!rows.length) throw new Error("development policy metrics are required");
  const frontier = rows.filter((candidate) => !rows.some((other) => other.policy.id !== candidate.policy.id
    && other.developmentPnl >= candidate.developmentPnl
    && other.maximumFall <= candidate.maximumFall
    && other.skippedPositions <= candidate.skippedPositions
    && (other.developmentPnl > candidate.developmentPnl || other.maximumFall < candidate.maximumFall || other.skippedPositions < candidate.skippedPositions)));
  return frontier.sort((a, b) => b.developmentPnl - a.developmentPnl || a.maximumFall - b.maximumFall || a.skippedPositions - b.skippedPositions || a.policy.id.localeCompare(b.policy.id)).slice(0, limit).map((row) => row.policy);
}

export function buildMinskOperatingDaySplit(blocks: readonly string[]) {
  const ordered = [...new Set(blocks)].sort(); const cut = Math.floor(ordered.length * .7);
  return { development: ordered.slice(0, cut), confirmation: ordered.slice(cut), lockedBeforeConfirmation: true as const };
}

function validatePolicy(policy: ScientificCapitalPolicy): void {
  if (policy.family === "NO_VAULT_FIXED100") return;
  if (!Number.isFinite(policy.alpha) || policy.alpha < .05 || policy.alpha > .7) throw new Error("invalid capital policy alpha");
  if (policy.family === "ONE_WAY_RATCHETED_CPPI" && (!Number.isFinite(policy.multiplier) || policy.multiplier < .125 || policy.multiplier > 1)) throw new Error("invalid CPPI multiplier");
}

export function replayScientificCapitalPolicy(candidates: readonly ExecutionCandidate[], policy: ScientificCapitalPolicy, capacity: ScientificCapacity): ScientificCapitalReplay {
  validatePolicy(policy);
  const dailyLimit = capacity.maxAcceptedPerOperatingDay ?? 100;
  const initialTotalCapital = capacity.initialTotalCapital ?? STARTING_CAPITAL_USD;
  const fixedStake = capacity.fixedStake ?? FIXED_STAKE_USD;
  if (!Number.isInteger(capacity.maxOpenPositions) || capacity.maxOpenPositions <= 0 || !Number.isFinite(capacity.maxOpenExposurePct) || capacity.maxOpenExposurePct <= 0 || capacity.maxOpenExposurePct > 1 || !Number.isInteger(dailyLimit) || dailyLimit <= 0) throw new Error("invalid capacity");
  if (!Number.isFinite(initialTotalCapital) || initialTotalCapital <= 0 || !Number.isFinite(fixedStake) || fixedStake <= 0) throw new Error("invalid capital scale");
  if (new Set(candidates.map((candidate) => candidate.observationId)).size !== candidates.length) throw new Error("duplicate observationId in execution candidates");
  const ordered = [...candidates].sort((a, b) => Date.parse(a.decisionAtIso) - Date.parse(b.decisionAtIso) || b.finalScore - a.finalScore || b.dataCoverage - a.dataCoverage || a.entryPrice - b.entryPrice || a.observationId.localeCompare(b.observationId));
  const stakePolicy = capacity.stakePolicy ?? "FIXED_100";
  const stakeSchedule = createStakeReferenceSchedule("MINSK_NIGHT_FIXED_MAX3_V1", initialTotalCapital);
  let free = initialTotalCapital;
  let vault = 0;
  let settledHigh = initialTotalCapital;
  let totalPeak = initialTotalCapital;
  let activePeak = initialTotalCapital;
  let minimumTotal = initialTotalCapital;
  let maxTotalFall = 0;
  let maxActiveFall = 0;
  let invalid = 0;
  const open: Array<{ candidate: ExecutionCandidate; resolved: number; stake: number }> = [];
  const ledger: CapitalLedgerRow[] = [];
  const curve: CapitalCurvePoint[] = [];
  const transfers: CapitalTransfer[] = [];
  const blockPnl: Record<string, number> = {};
  const acceptedByOperatingDay = new Map<string, number>();
  const transfer = (amount: number, atIso: string, reason: CapitalTransfer["reason"]) => {
    const moved = round(Math.max(0, Math.min(free, amount)));
    if (moved > 0) {
      free = round(free - moved);
      vault = round(vault + moved);
      transfers.push({ atIso, amount: moved, reason });
    }
  };
  if (policy.family === "STATIC_CAPITAL_FLOOR") transfer(policy.alpha * initialTotalCapital, "INITIAL", "INITIAL_STATIC");
  if (policy.family === "HIGH_WATERMARK_DRAWDOWN_FLOOR") transfer(policy.alpha * initialTotalCapital, "INITIAL", "HIGH_WATERMARK_RATCHET");
  if (policy.family === "ONE_WAY_RATCHETED_CPPI") transfer(policy.alpha * initialTotalCapital, "INITIAL", "CPPI_FLOOR_RATCHET");
  activePeak = free;
  const point = (atIso: string) => {
    const openPrincipal = round(open.reduce((sum, item) => sum + item.stake, 0));
    const active = round(free + openPrincipal);
    const total = round(active + vault);
    totalPeak = Math.max(totalPeak, total);
    activePeak = Math.max(activePeak, active);
    minimumTotal = Math.min(minimumTotal, total);
    maxTotalFall = Math.max(maxTotalFall, totalPeak - total);
    maxActiveFall = Math.max(maxActiveFall, activePeak - active);
    if (![free, openPrincipal, active, vault, total].every(Number.isFinite) || free < -1e-7 || vault < -1e-7 || Math.abs(active + vault - total) > 1e-6) invalid++;
    curve.push({ atIso, freeActive: free, openPrincipal, active, vault, total, fallFromTotalPeak: round(totalPeak - total), fallFromActivePeak: round(activePeak - active) });
  };
  point("INITIAL");
  const applyPolicy = (at: number) => {
    const active = free + open.reduce((sum, item) => sum + item.stake, 0);
    const total = active + vault;
    settledHigh = Math.max(settledHigh, total);
    if (policy.family === "HIGH_WATERMARK_DRAWDOWN_FLOOR") transfer(policy.alpha * settledHigh - vault, new Date(at).toISOString(), "HIGH_WATERMARK_RATCHET");
    if (policy.family === "ONE_WAY_RATCHETED_CPPI") transfer(policy.alpha * settledHigh - vault, new Date(at).toISOString(), "CPPI_FLOOR_RATCHET");
  };
  const settle = (through: number) => {
    const due = open.filter((item) => item.resolved <= through).sort((a, b) => a.resolved - b.resolved || a.candidate.observationId.localeCompare(b.candidate.observationId));
    for (let index = 0; index < due.length;) {
      const resolved = due[index].resolved;
      const batch: typeof due = [];
      while (index < due.length && due[index].resolved === resolved) batch.push(due[index++]);
      for (const item of batch) {
        open.splice(open.indexOf(item), 1);
        const result = classifyResolvedOutcome(item.candidate.row).label;
        const pnl = result === "win" ? item.stake * (1 / item.candidate.entryPrice - 1) : -item.stake;
        free = round(free + item.stake + pnl);
        const entry = ledger.find((value) => value.observationId === item.candidate.observationId);
        if (!entry) throw new Error("executed settlement is missing from ledger");
        entry.netPnl = round(pnl);
        blockPnl[entry.operatingDay] = round((blockPnl[entry.operatingDay] ?? 0) + pnl);
      }
      applyPolicy(resolved);
      point(new Date(resolved).toISOString());
    }
  };
  for (let index = 0; index < ordered.length;) {
    const at = Date.parse(ordered[index].decisionAtIso);
    if (!Number.isFinite(at)) throw new Error("invalid decision timestamp");
    settle(at);
    const batch: ExecutionCandidate[] = [];
    while (index < ordered.length && Date.parse(ordered[index].decisionAtIso) === at) batch.push(ordered[index++]);
    for (const candidate of batch) {
      const resolved = Date.parse(candidate.resolvedAtIso);
      const outcome = classifyResolvedOutcome(candidate.row).label;
      if (!Number.isFinite(resolved) || resolved < at || !Number.isFinite(candidate.entryPrice) || candidate.entryPrice <= 0 || candidate.entryPrice > 1 || (outcome !== "win" && outcome !== "loss")) throw new Error("invalid candidate settlement or price");
      const operatingDay = minskNightKey(at);
      const acceptedToday = acceptedByOperatingDay.get(operatingDay) ?? 0;
      const active = free + open.reduce((sum, item) => sum + item.stake, 0);
      const exposure = open.reduce((sum, item) => sum + item.stake, 0);
      const cycleReference = stakePolicy === "DYNAMIC_ACTIVE_3PCT" ? stakeSchedule.referenceFor(at, active) : active;
      const requestedStake = stakePolicy === "DYNAMIC_ACTIVE_3PCT" ? round(.03 * cycleReference) : fixedStake;
      let reason: CapitalLedgerRow["terminalReason"] = "EXECUTED_FULL";
      if (capacity.operationWindowOnly && !isInsideMinskOperationalWindow(at)) reason = "WINDOW_EXCLUDED";
      else if (acceptedToday >= dailyLimit) reason = "DAILY_LIMIT";
      else if (open.length >= capacity.maxOpenPositions) reason = "POSITION_LIMIT";
      else if (requestedStake <= 0 || exposure + requestedStake > cycleReference * capacity.maxOpenExposurePct + 1e-8) reason = "EXPOSURE_LIMIT";
      else if (policy.family === "ONE_WAY_RATCHETED_CPPI" && exposure + requestedStake > policy.multiplier * Math.max(0, active + vault - policy.alpha * settledHigh) + 1e-8) reason = "EXPOSURE_LIMIT";
      else if (free + 1e-8 < requestedStake) reason = "INSUFFICIENT_ACTIVE_CAPACITY";
      const entry: CapitalLedgerRow = { observationId: candidate.observationId, decisionAtIso: candidate.decisionAtIso, resolvedAtIso: candidate.resolvedAtIso, operatingDay, stake: reason === "EXECUTED_FULL" ? requestedStake : 0, entryPrice: candidate.entryPrice, result: outcome, netPnl: 0, terminalReason: reason };
      ledger.push(entry);
      if (reason === "EXECUTED_FULL") {
        free = round(free - requestedStake);
        open.push({ candidate, resolved, stake: requestedStake });
        acceptedByOperatingDay.set(operatingDay, acceptedToday + 1);
      }
    }
    point(new Date(at).toISOString());
  }
  settle(Infinity);
  point("FINAL");
  const executed = ledger.filter((entry) => entry.stake > 0);
  const netPnl = round(executed.reduce((sum, entry) => sum + entry.netPnl, 0));
  const totalStaked = round(executed.reduce((sum, entry) => sum + entry.stake, 0));
  const skipReasons = Object.fromEntries(["WINDOW_EXCLUDED", "DAILY_LIMIT", "POSITION_LIMIT", "EXPOSURE_LIMIT", "INSUFFICIENT_ACTIVE_CAPACITY"].map((reason) => [reason, ledger.filter((entry) => entry.terminalReason === reason).length]));
  return { version: SCIENTIFIC_CAPITAL_ARCHITECTURE_VERSION, policy, capacity: { ...capacity, maxAcceptedPerOperatingDay: dailyLimit }, eligibleMatches: candidates.length, executedMatches: executed.length, skippedPositions: candidates.length - executed.length, skipReasons, wins: executed.filter((entry) => entry.result === "win").length, losses: executed.filter((entry) => entry.result === "loss").length, totalStaked, netPnl, roi: totalStaked ? round(netPnl / totalStaked * 100) : null, endingActive: round(free), endingVault: vault, endingTotal: round(free + vault), minimumTotal: round(minimumTotal), maximumFallFromTotalPeak: round(maxTotalFall), maximumFallFromActivePeak: round(maxActiveFall), invalidCapitalStates: invalid, blockPnl, ledger, curve, transfers, executionLedgerHash: stableHash(ledger), capitalCurveHash: stableHash(curve) };
}

export function selectCapitalPolicy(scores: readonly CapitalPolicyScore[]): CapitalPolicyScore {
  const control = scores.find((score) => score.policy.family === "NO_VAULT_FIXED100"); if (!control) throw new Error("NO_VAULT_FIXED100 benchmark is required");
  const eligible = scores.filter((score) => score.policy.family === "NO_VAULT_FIXED100" || (score.confirmationPnl > control.confirmationPnl && score.spaConsistent <= .1));
  return [...eligible].sort((a, b) => b.confirmationPnl - a.confirmationPnl || (Math.abs(b.confirmationPnl - a.confirmationPnl) < 100 ? a.cvar95MaxFall - b.cvar95MaxFall || a.probabilityBelowInitial - b.probabilityBelowInitial || b.endingVault - a.endingVault || a.skippedPositions - b.skippedPositions || a.policy.id.length - b.policy.id.length : 0) || a.policy.id.localeCompare(b.policy.id))[0];
}

export function selectFinalArchitectureCells<T extends FinalArchitectureCell>(cells: readonly T[], drawdownCeilingUsd: number): { pnlMax: T; riskMin: T; scientificWinner: T } {
  if (!Number.isFinite(drawdownCeilingUsd) || drawdownCeilingUsd <= 0) throw new Error("invalid drawdown ceiling");
  const valid = cells.filter((cell) => cell.eligibleForFinalSelection && cell.confirmation.invalidCapitalStates === 0 && cell.confirmation.maximumFallFromTotalPeak <= drawdownCeilingUsd);
  if (!valid.length) throw new Error("no final architecture satisfies the freeze gates");
  const pnlMax = [...valid].sort((a, b) => b.confirmation.netPnl - a.confirmation.netPnl || a.selectionHash.localeCompare(b.selectionHash))[0];
  const riskMin = [...valid].sort((a, b) => a.confirmation.risk.cvar95MaximumFall - b.confirmation.risk.cvar95MaximumFall || a.confirmation.risk.probabilityBelowInitial - b.confirmation.risk.probabilityBelowInitial || b.confirmation.netPnl - a.confirmation.netPnl || a.selectionHash.localeCompare(b.selectionHash))[0];
  const scientificWinner = [...valid.filter((cell) => cell.confirmation.netPnl >= pnlMax.confirmation.netPnl - FIXED_STAKE_USD)].sort((a, b) => a.confirmation.risk.cvar95MaximumFall - b.confirmation.risk.cvar95MaximumFall || a.confirmation.risk.probabilityBelowInitial - b.confirmation.risk.probabilityBelowInitial || (a.stakePolicy === "FIXED_100" ? 0 : 1) - (b.stakePolicy === "FIXED_100" ? 0 : 1) || a.model.localeCompare(b.model) || a.selectionHash.localeCompare(b.selectionHash))[0];
  return { pnlMax, riskMin, scientificWinner };
}

export function bootstrapCapitalRisk(blockPnl: readonly number[], blockLength: number, samples = 20_000, seed = 20260716, initialTotalCapital = STARTING_CAPITAL_USD): BootstrapRiskSummary {
  if (!blockPnl.length || !blockPnl.every(Number.isFinite) || !Number.isInteger(blockLength) || blockLength <= 0 || !Number.isInteger(samples) || samples <= 0) throw new Error("invalid bootstrap input");
  if (!Number.isFinite(initialTotalCapital) || initialTotalCapital <= 0) throw new Error("invalid bootstrap initial capital");
  let state = seed >>> 0; const random = () => { state += 0x6d2b79f5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
  const terminals: number[] = [], falls: number[] = [], terminalLosses: number[] = []; const restartProbability = 1 / blockLength;
  for (let sample = 0; sample < samples; sample++) { let index = Math.floor(random() * blockPnl.length), capital = initialTotalCapital, peak = capital, maximumFall = 0; for (let draw = 0; draw < blockPnl.length; draw++) { if (draw === 0 || random() < restartProbability) index = Math.floor(random() * blockPnl.length); else index = (index + 1) % blockPnl.length; capital += blockPnl[index]; peak = Math.max(peak, capital); maximumFall = Math.max(maximumFall, peak - capital); } terminals.push(round(capital)); falls.push(round(maximumFall)); terminalLosses.push(round(Math.max(0, initialTotalCapital - capital))); }
  const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b), percentile = (values: readonly number[], q: number) => sorted(values)[Math.floor((values.length - 1) * q)];
  const tailMean = (values: readonly number[]) => { const ordered = sorted(values), start = Math.floor(ordered.length * .95), tail = ordered.slice(start); return round(tail.reduce((sum, value) => sum + value, 0) / tail.length); };
  return { p10EndingCapital: percentile(terminals, .1), medianEndingCapital: percentile(terminals, .5), p90EndingCapital: percentile(terminals, .9), cvar95TerminalLoss: tailMean(terminalLosses), cvar95MaximumFall: tailMean(falls), probabilityBelowInitial: round(terminals.filter((value) => value < initialTotalCapital).length / samples) };
}
