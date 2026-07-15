// Bankroll/Vault Historical Replay (Phase 3B / Roadmap_July2).
//
// THEORETICAL_GROSS_HISTORICAL_REPLAY ONLY. Applies a founder-frozen T-90
// selection overlay + one-signal-per-event ranking + active/vault bankroll
// contract on top of the accepted, unmodified base launch candidate
// (B2_PRICE_FLOOR_030_TIMING_WITHIN_120M = ALT4 + price>=0.30 + timing<120m).
// Never fees/slippage/spread/partial fills; never Ireland; never a claim of
// realized live ROI. This module does NOT alter the base candidate's own
// selection math -- it reuses evaluateHistoricalFunnelVariant, the exact
// exported price/timing predicates, canonical event grouping, canonical
// outcome classification, and strict-dedup identity (getStrictDedupKeyForExportRow).
//
// Pure: no fs/env/network/Supabase, no mutation of input, no forward data.

import { createHash } from "node:crypto";
import { evaluateHistoricalFunnelVariant, getScoreValue, getCoverageValue, getHoursUntilStartValue } from "./historicalFunnelVariants";
import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";
import { BASE_COMPARATOR_ID, passesPriceFloor, passesTimingWithin120m } from "./boundedRoutingExperiments";
import { getEntryPriceValue } from "./scoreComponentAnalysis";
import { buildEventGroupKey } from "./eventGroupSelection";
import { classifyResolvedOutcome } from "./roiPnlContract";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";

type Row = ExportRow;

export const BANKROLL_VAULT_REPLAY_ENGINE_VERSION = "3B-bankroll-vault-replay-v1" as const;

// ---------------------------------------------------------- version identifiers

export const MODEL_POLICY_ID = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M" as const;
export const SELECTION_OVERLAY_VERSION = "T90_ONE_PER_EVENT_SCORE_COVERAGE_V1" as const;
export const BANKROLL_POLICY_VERSION = "ACTIVE50_VAULT50_STAKE_MAX3_OPEN80_POS30_DAY100_V1" as const;

// ---------------------------------------------------------- frozen policy constants

const T90_DECISION_OFFSET_HOURS = 1.5; // decisionAt = eventStart - 90 minutes
const T90_WINDOW_LOWER_HOURS = 1.5; // eventStart - 120 minutes
const T90_WINDOW_UPPER_HOURS = 2.0; // eventStart - 90 minutes (== decisionAt)

const MAX_ACCEPTED_SIGNALS_PER_UTC_DAY = 100;
const MAX_CONCURRENT_POSITIONS = 30;
const MAX_OPEN_EXPOSURE_FRACTION = 0.8;
const PER_SIGNAL_STAKE_FRACTION = 0.03;

export const REJECTION_REASONS = [
  "NO_VALID_EVENT_START",
  "NO_T90_SNAPSHOT",
  "BASE_MODEL_REJECTED",
  "EVENT_RANKED_OUT",
  "DAILY_CAP_REJECTED",
  "CONCURRENT_POSITION_CAP_REJECTED",
  "OPEN_EXPOSURE_CAP_REJECTED",
  "INVALID_RESOLVED_AT",
  "INVALID_ENTRY_PRICE",
  "INVALID_RESULT",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

// ---------------------------------------------------------- helpers

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function observationIdOf(row: Row): string {
  const id = row.id;
  if (typeof id === "string" && id.trim() !== "") return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  const key = getStrictDedupKeyForExportRow(row);
  return key ?? `__anon__${JSON.stringify(row)}`;
}

function strictIdentityOf(row: Row): string | null {
  return getStrictDedupKeyForExportRow(row);
}

function utcDayOf(iso: string): string {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------- 1. T-90 snapshot selection

interface CandidateSnapshot {
  row: Row;
  observationId: string;
  identity: string;
  hoursUntilStart: number;
  createdAtMs: number;
}

/**
 * For every strict signal identity, selects the latest snapshot whose
 * created_at falls in [eventStart-120m, eventStart-90m] (i.e. hoursUntilStart
 * in [1.5, 2.0]). Tie-break: created_at DESC, then observationId ASC. No
 * field recorded after decisionAt can affect this pick -- only rows already
 * inside the window are ever considered. resolved_at is never read here.
 */
function selectT90Snapshots(rows: readonly Row[]): {
  selected: Map<string, CandidateSnapshot>;
  noValidStart: Set<string>;
} {
  const byIdentity = new Map<string, CandidateSnapshot[]>();
  const noValidStart = new Set<string>();

  for (const row of rows) {
    const identity = strictIdentityOf(row);
    if (identity === null) continue;
    const hours = getHoursUntilStartValue(row);
    if (hours === null) {
      noValidStart.add(identity);
      continue;
    }
    if (hours < T90_WINDOW_LOWER_HOURS || hours > T90_WINDOW_UPPER_HOURS) continue;
    const createdAtMs = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
    if (!Number.isFinite(createdAtMs)) continue;
    const snap: CandidateSnapshot = { row, observationId: observationIdOf(row), identity, hoursUntilStart: hours, createdAtMs };
    const arr = byIdentity.get(identity);
    if (arr) arr.push(snap);
    else byIdentity.set(identity, [snap]);
  }

  const selected = new Map<string, CandidateSnapshot>();
  for (const [identity, snaps] of byIdentity) {
    const best = [...snaps].sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs; // DESC
      return a.observationId.localeCompare(b.observationId); // ASC
    })[0];
    selected.set(identity, best);
  }
  return { selected, noValidStart };
}

// ---------------------------------------------------------- 2+3. base model + ranking

interface RankedCandidate {
  snapshot: CandidateSnapshot;
  eventKey: string;
  finalScore: number;
  dataCoverage: number;
  entryPrice: number;
}

const RANK_ORDER: (a: RankedCandidate, b: RankedCandidate) => number = (a, b) => {
  if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore; // DESC
  if (a.dataCoverage !== b.dataCoverage) return b.dataCoverage - a.dataCoverage; // DESC
  if (a.entryPrice !== b.entryPrice) return a.entryPrice - b.entryPrice; // ASC
  if (a.snapshot.createdAtMs !== b.snapshot.createdAtMs) return b.snapshot.createdAtMs - a.snapshot.createdAtMs; // DESC
  return a.snapshot.observationId.localeCompare(b.snapshot.observationId); // ASC
};

// ---------------------------------------------------------- ledgers

export interface DecisionLedgerEntry {
  observationId: string;
  identity: string;
  eventKey: string | null;
  decisionAtIso: string;
  utcDay: string;
  accepted: boolean;
  rejectionReason: RejectionReason | null;
  requestedStake: number;
  actualStake: number;
  activeBankrollBeforeDecision: number;
  entryPrice: number | null;
  finalScore: number | null;
  dataCoverage: number | null;
}

export interface SettlementLedgerEntry {
  observationId: string;
  resolvedAtIso: string;
  outcome: "win" | "loss";
  stake: number;
  netPnl: number;
  activeBankrollAfter: number;
}

export interface VaultSweepLedgerEntry {
  utcDay: string;
  activeBankrollBefore: number;
  vaultBankrollBefore: number;
  sweepAmount: number;
  activeBankrollAfter: number;
  vaultBankrollAfter: number;
}

export interface DailySummary {
  utcDay: string;
  acceptedCount: number;
  rejectedCount: number;
  settlementsCount: number;
  sweepAmount: number;
}

export interface BankrollVaultReplayInput {
  rawRows: readonly Row[];
  classifier: ExecutableFunnelClassifier;
  insuranceBankroll: number;
}

export interface BankrollVaultReplayResult {
  engineVersion: typeof BANKROLL_VAULT_REPLAY_ENGINE_VERSION;
  simulationVersion: "BANKROLL_VAULT_REPLAY_V1";
  modelPolicyId: typeof MODEL_POLICY_ID;
  selectionOverlayVersion: typeof SELECTION_OVERLAY_VERSION;
  bankrollPolicyVersion: typeof BANKROLL_POLICY_VERSION;
  resultLabel: "THEORETICAL_GROSS_HISTORICAL_REPLAY";

  preOverlayBaseline: {
    candidateId: typeof MODEL_POLICY_ID;
    selectedObservations: number;
  };
  postOverlaySelectionHash: string;

  selectedObservations: number;
  canonicalEventGroups: number;
  wins: number;
  losses: number;
  invalidExcluded: number;
  rejectedByReason: Record<RejectionReason, number>;

  grossTheoreticalPnl: number;
  grossTheoreticalRoi: number | null;
  maximumActiveBankrollDrawdown: number;
  maximumTotalCapitalDrawdown: number;
  longestLosingStreak: number;

  maximumSimultaneousPositions: number;
  maximumOpenExposureUnits: number;
  maximumOpenExposurePct: number;
  maximumAcceptedSignalsInOneUtcDay: number;
  reducedBelow3PctStakeOrders: number;

  initialActiveBankroll: number;
  initialVaultBankroll: number;
  endingActiveBankroll: number;
  endingVaultBankroll: number;
  endingTotalCapital: number;
  totalSweptToVault: number;

  decisionLedger: DecisionLedgerEntry[];
  settlementLedger: SettlementLedgerEntry[];
  vaultSweepLedger: VaultSweepLedgerEntry[];
  dailySummaries: DailySummary[];
}

interface OpenPosition {
  observationId: string;
  identity: string;
  entryPrice: number;
  stake: number;
  resolvedAtMs: number;
  win: boolean;
  decisionAtMs: number;
}

export function runBankrollVaultReplay(input: BankrollVaultReplayInput): BankrollVaultReplayResult {
  const { rawRows, classifier, insuranceBankroll } = input;
  if (!Number.isFinite(insuranceBankroll) || insuranceBankroll <= 0) {
    throw new Error("bankroll vault replay: insuranceBankroll must be a positive finite number");
  }

  const rejectedByReason: Record<RejectionReason, number> = Object.fromEntries(
    REJECTION_REASONS.map((r) => [r, 0]),
  ) as Record<RejectionReason, number>;

  // ---- 1. T-90 snapshot selection (canonical strict identity, no future data) ----
  const { selected, noValidStart } = selectT90Snapshots(rawRows);
  rejectedByReason.NO_VALID_EVENT_START += noValidStart.size;

  // Identities with a valid event start but no in-window snapshot.
  const allIdentities = new Set<string>();
  for (const row of rawRows) {
    const identity = strictIdentityOf(row);
    if (identity !== null && getHoursUntilStartValue(row) !== null) allIdentities.add(identity);
  }
  for (const identity of allIdentities) {
    if (!selected.has(identity) && !noValidStart.has(identity)) {
      rejectedByReason.NO_T90_SNAPSHOT += 1;
    }
  }

  const t90Rows = [...selected.values()].map((s) => s.row);

  // ---- 2. base candidate (ALT4 + price>=0.30 + timing<120m), unmodified ----
  const alt4Selected = evaluateHistoricalFunnelVariant(t90Rows, classifier, BASE_COMPARATOR_ID).selectedRows;
  const alt4SelectedIds = new Set(alt4Selected.map(observationIdOf));
  const baseAccepted = alt4Selected.filter((r) => passesPriceFloor(r) && passesTimingWithin120m(r));
  const baseAcceptedIds = new Set(baseAccepted.map(observationIdOf));

  for (const snap of selected.values()) {
    if (!alt4SelectedIds.has(snap.observationId) || !baseAcceptedIds.has(snap.observationId)) {
      rejectedByReason.BASE_MODEL_REJECTED += 1;
    }
  }

  // ---- 3. one-signal-per-event ranking ----
  const candidates: RankedCandidate[] = [];
  for (const row of baseAccepted) {
    const identity = strictIdentityOf(row)!;
    const snap = selected.get(identity)!;
    const score = getScoreValue(row);
    const coverage = getCoverageValue(row);
    const price = getEntryPriceValue(row);
    // Missing score or coverage fails closed -- excluded from ranking entirely.
    if (score === null || coverage === null || price === null) {
      rejectedByReason.EVENT_RANKED_OUT += 1;
      continue;
    }
    candidates.push({ snapshot: snap, eventKey: buildEventGroupKey(row).key, finalScore: score, dataCoverage: coverage, entryPrice: price });
  }

  const byEvent = new Map<string, RankedCandidate[]>();
  for (const c of candidates) {
    const arr = byEvent.get(c.eventKey);
    if (arr) arr.push(c);
    else byEvent.set(c.eventKey, [c]);
  }
  const winners: RankedCandidate[] = [];
  for (const [, group] of byEvent) {
    const sorted = [...group].sort(RANK_ORDER);
    winners.push(sorted[0]);
    rejectedByReason.EVENT_RANKED_OUT += sorted.length - 1;
  }
  const canonicalEventGroups = byEvent.size;

  // ---- decision-time ordering: frozen ranking tuple ----
  const orderedWinners = [...winners].sort(RANK_ORDER);

  // ---- prevalidate resolved_at / entry price / result for each winner ----
  interface PreparedDecision {
    candidate: RankedCandidate;
    decisionAtMs: number;
    decisionAtIso: string;
    resolvedAtMs: number | null;
    outcome: "win" | "loss" | null;
  }
  const prepared: PreparedDecision[] = [];
  for (const c of orderedWinners) {
    const row = c.snapshot.row;
    const startMs = Date.parse((row.diagnostics as Record<string, unknown> | undefined)?.gameStartIso as string);
    const decisionAtMs = startMs - T90_DECISION_OFFSET_HOURS * 3_600_000;
    const decisionAtIso = new Date(decisionAtMs).toISOString();

    const resolvedRaw = row.resolved_at;
    const resolvedAtMs = typeof resolvedRaw === "string" ? Date.parse(resolvedRaw) : NaN;
    if (typeof resolvedRaw !== "string" || !Number.isFinite(resolvedAtMs)) {
      rejectedByReason.INVALID_RESOLVED_AT += 1;
      prepared.push({ candidate: c, decisionAtMs, decisionAtIso, resolvedAtMs: null, outcome: null });
      continue;
    }
    if (c.entryPrice <= 0 || c.entryPrice > 1 || !Number.isFinite(c.entryPrice)) {
      rejectedByReason.INVALID_ENTRY_PRICE += 1;
      prepared.push({ candidate: c, decisionAtMs, decisionAtIso, resolvedAtMs, outcome: null });
      continue;
    }
    const classified = classifyResolvedOutcome(row);
    if (classified.label !== "win" && classified.label !== "loss") {
      rejectedByReason.INVALID_RESULT += 1;
      prepared.push({ candidate: c, decisionAtMs, decisionAtIso, resolvedAtMs, outcome: null });
      continue;
    }
    prepared.push({ candidate: c, decisionAtMs, decisionAtIso, resolvedAtMs, outcome: classified.label });
  }

  const executable = prepared.filter((p) => p.outcome !== null);
  executable.sort((a, b) => (a.decisionAtMs !== b.decisionAtMs ? a.decisionAtMs - b.decisionAtMs : RANK_ORDER(a.candidate, b.candidate)));

  // ---- 4. chronological event-driven simulation ----
  let activeBankroll = insuranceBankroll * 0.5;
  let vaultBankroll = insuranceBankroll * 0.5;
  const initialActiveBankroll = activeBankroll;
  const initialVaultBankroll = vaultBankroll;

  const decisionLedger: DecisionLedgerEntry[] = [];
  const settlementLedger: SettlementLedgerEntry[] = [];
  const vaultSweepLedger: VaultSweepLedgerEntry[] = [];
  const dailySummaries: DailySummary[] = [];

  const openPositions: OpenPosition[] = [];
  const dailyAcceptedCount = new Map<string, number>();
  const dailyRejectedCount = new Map<string, number>();
  const dailySettlementsCount = new Map<string, number>();
  const dailySweepAmount = new Map<string, number>();

  let maximumSimultaneousPositions = 0;
  let maximumOpenExposureUnits = 0;
  let reducedBelow3PctStakeOrders = 0;
  let wins = 0;
  let losses = 0;
  let currentLossStreak = 0;
  let longestLosingStreak = 0;

  let activePeak = activeBankroll;
  let maximumActiveBankrollDrawdown = 0;
  let totalPeak = activeBankroll + vaultBankroll;
  let maximumTotalCapitalDrawdown = 0;

  function updateDrawdowns(): void {
    if (activeBankroll > activePeak) activePeak = activeBankroll;
    const activeDD = activePeak - activeBankroll;
    if (activeDD > maximumActiveBankrollDrawdown) maximumActiveBankrollDrawdown = activeDD;
    const total = activeBankroll + vaultBankroll;
    if (total > totalPeak) totalPeak = total;
    const totalDD = totalPeak - total;
    if (totalDD > maximumTotalCapitalDrawdown) maximumTotalCapitalDrawdown = totalDD;
  }

  type TimelineEvent =
    | { kind: "decision"; atMs: number; decision: PreparedDecision }
    | { kind: "settlement"; atMs: number; position: OpenPosition }
    | { kind: "sweep"; atMs: number; day: string };

  const timeline: TimelineEvent[] = [];
  for (const d of executable) timeline.push({ kind: "decision", atMs: d.decisionAtMs, decision: d });

  // Sweep events are inserted dynamically at each UTC day boundary once we
  // know which days have activity; process settlements as they're opened.
  const allDaySet = new Set<string>();
  for (const d of executable) {
    allDaySet.add(utcDayOf(d.decisionAtIso));
    if (d.resolvedAtMs !== null) allDaySet.add(utcDayOf(new Date(d.resolvedAtMs).toISOString()));
  }
  for (const day of allDaySet) {
    const sweepAtMs = Date.parse(`${day}T23:59:59.999Z`);
    timeline.push({ kind: "sweep", atMs: sweepAtMs, day });
  }

  // Settlement timeline entries are added once a position opens; process by
  // repeatedly picking the earliest pending event (decision/settlement/sweep),
  // honoring the frozen equal-timestamp order: settlements, sweep, decisions.
  const pendingSettlements: TimelineEvent[] = [];
  const sorted = [...timeline].sort((a, b) => a.atMs - b.atMs);

  let i = 0;
  const combined: TimelineEvent[] = [];
  while (i < sorted.length || pendingSettlements.length > 0) {
    const nextFixed = sorted[i];
    const nextSettlement = pendingSettlements[0];
    if (nextSettlement && (!nextFixed || nextSettlement.atMs <= nextFixed.atMs)) {
      combined.push(nextSettlement);
      pendingSettlements.shift();
    } else if (nextFixed) {
      combined.push(nextFixed);
      i++;
      if (nextFixed.kind === "decision" && nextFixed.decision.resolvedAtMs !== null) {
        pendingSettlements.push({ kind: "settlement", atMs: nextFixed.decision.resolvedAtMs, position: null as unknown as OpenPosition });
      }
    } else {
      break;
    }
  }

  // combined now has decision/sweep events fixed, plus placeholder settlement
  // markers without a resolved position yet (position assigned at open time).
  // Re-walk in timestamp order, resolving settlement markers against the
  // actual opened position for that decision.
  const eventsByAtMs = combined.sort((a, b) => {
    if (a.atMs !== b.atMs) return a.atMs - b.atMs;
    const rank = (e: TimelineEvent): number => (e.kind === "settlement" ? 0 : e.kind === "sweep" ? 1 : 2);
    return rank(a) - rank(b);
  });

  const settlementQueueByObservation = new Map<string, TimelineEvent>();

  for (const evt of eventsByAtMs) {
    if (evt.kind === "decision") {
      const d = evt.decision;
      const day = utcDayOf(d.decisionAtIso);
      const accepted0 = (dailyAcceptedCount.get(day) ?? 0) < MAX_ACCEPTED_SIGNALS_PER_UTC_DAY;

      const requestedStake = round8(activeBankroll * PER_SIGNAL_STAKE_FRACTION);
      const currentOpenStake = openPositions.reduce((s, p) => s + p.stake, 0);
      const maxOpenExposureAllowed = activeBankroll * MAX_OPEN_EXPOSURE_FRACTION;
      const remainingExposureCapacity = Math.max(0, maxOpenExposureAllowed - currentOpenStake);
      const positionCapAllows = openPositions.length < MAX_CONCURRENT_POSITIONS;

      let rejectionReason: RejectionReason | null = null;
      let actualStake = 0;

      if (!accepted0) {
        rejectionReason = "DAILY_CAP_REJECTED";
      } else if (!positionCapAllows) {
        rejectionReason = "CONCURRENT_POSITION_CAP_REJECTED";
      } else {
        actualStake = round8(Math.min(requestedStake, activeBankroll, remainingExposureCapacity));
        if (actualStake <= 0) {
          rejectionReason = "OPEN_EXPOSURE_CAP_REJECTED";
        }
      }

      const acceptedNow = rejectionReason === null;
      decisionLedger.push({
        observationId: d.candidate.snapshot.observationId,
        identity: d.candidate.snapshot.identity,
        eventKey: d.candidate.eventKey,
        decisionAtIso: d.decisionAtIso,
        utcDay: day,
        accepted: acceptedNow,
        rejectionReason,
        requestedStake,
        actualStake,
        activeBankrollBeforeDecision: activeBankroll,
        entryPrice: d.candidate.entryPrice,
        finalScore: d.candidate.finalScore,
        dataCoverage: d.candidate.dataCoverage,
      });

      if (!acceptedNow) {
        rejectedByReason[rejectionReason!] += 1;
        dailyRejectedCount.set(day, (dailyRejectedCount.get(day) ?? 0) + 1);
        continue;
      }

      if (actualStake < requestedStake - 1e-9) reducedBelow3PctStakeOrders += 1;

      activeBankroll = round8(activeBankroll - actualStake);
      dailyAcceptedCount.set(day, (dailyAcceptedCount.get(day) ?? 0) + 1);

      const position: OpenPosition = {
        observationId: d.candidate.snapshot.observationId,
        identity: d.candidate.snapshot.identity,
        entryPrice: d.candidate.entryPrice,
        stake: actualStake,
        resolvedAtMs: d.resolvedAtMs!,
        win: d.outcome === "win",
        decisionAtMs: d.decisionAtMs,
      };
      openPositions.push(position);
      settlementQueueByObservation.set(position.observationId, { kind: "settlement", atMs: position.resolvedAtMs, position });

      if (openPositions.length > maximumSimultaneousPositions) maximumSimultaneousPositions = openPositions.length;
      const openStakeNow = openPositions.reduce((s, p) => s + p.stake, 0);
      if (openStakeNow > maximumOpenExposureUnits) maximumOpenExposureUnits = openStakeNow;

      updateDrawdowns();
    } else if (evt.kind === "settlement") {
      // Resolve placeholder settlement markers by matching any open position
      // whose resolvedAtMs equals this event's timestamp (deterministic id order).
      const due = openPositions
        .filter((p) => p.resolvedAtMs === evt.atMs)
        .sort((a, b) => a.observationId.localeCompare(b.observationId));
      for (const position of due) {
        const idx = openPositions.indexOf(position);
        if (idx >= 0) openPositions.splice(idx, 1);

        const netPnl = position.win ? round8(position.stake * (1 / position.entryPrice - 1)) : round8(-position.stake);
        activeBankroll = round8(activeBankroll + position.stake + netPnl);

        if (position.win) {
          wins += 1;
          currentLossStreak = 0;
        } else {
          losses += 1;
          currentLossStreak += 1;
          if (currentLossStreak > longestLosingStreak) longestLosingStreak = currentLossStreak;
        }

        const resolvedIso = new Date(position.resolvedAtMs).toISOString();
        settlementLedger.push({
          observationId: position.observationId,
          resolvedAtIso: resolvedIso,
          outcome: position.win ? "win" : "loss",
          stake: position.stake,
          netPnl,
          activeBankrollAfter: activeBankroll,
        });
        const day = utcDayOf(resolvedIso);
        dailySettlementsCount.set(day, (dailySettlementsCount.get(day) ?? 0) + 1);
        updateDrawdowns();
      }
    } else if (evt.kind === "sweep") {
      const totalCapital = round8(activeBankroll + vaultBankroll);
      const targetActive = round8(totalCapital * 0.5);
      const sweepAmount = activeBankroll > targetActive ? round8(activeBankroll - targetActive) : 0;
      if (sweepAmount > 0) {
        const activeBefore = activeBankroll;
        const vaultBefore = vaultBankroll;
        activeBankroll = round8(activeBankroll - sweepAmount);
        vaultBankroll = round8(vaultBankroll + sweepAmount);
        vaultSweepLedger.push({
          utcDay: evt.day,
          activeBankrollBefore: activeBefore,
          vaultBankrollBefore: vaultBefore,
          sweepAmount,
          activeBankrollAfter: activeBankroll,
          vaultBankrollAfter: vaultBankroll,
        });
        dailySweepAmount.set(evt.day, sweepAmount);
      }
      updateDrawdowns();
    }
  }

  // ---- daily summaries (union of all days with any activity) ----
  const allDays = [...new Set([...dailyAcceptedCount.keys(), ...dailyRejectedCount.keys(), ...dailySettlementsCount.keys(), ...dailySweepAmount.keys()])].sort();
  for (const day of allDays) {
    dailySummaries.push({
      utcDay: day,
      acceptedCount: dailyAcceptedCount.get(day) ?? 0,
      rejectedCount: dailyRejectedCount.get(day) ?? 0,
      settlementsCount: dailySettlementsCount.get(day) ?? 0,
      sweepAmount: dailySweepAmount.get(day) ?? 0,
    });
  }

  const grossTheoreticalPnl = round8(settlementLedger.reduce((s, e) => s + e.netPnl, 0));
  const totalStaked = round8(settlementLedger.reduce((s, e) => s + e.stake, 0));
  const grossTheoreticalRoi = totalStaked > 0 ? round8((grossTheoreticalPnl / totalStaked) * 100) : null;

  const selectedObservations = decisionLedger.filter((d) => d.accepted).length;
  const invalidExcluded = rejectedByReason.INVALID_RESOLVED_AT + rejectedByReason.INVALID_ENTRY_PRICE + rejectedByReason.INVALID_RESULT;

  const executedIds = decisionLedger.filter((d) => d.accepted).map((d) => d.observationId);
  const postOverlaySelectionHash = createHash("sha256")
    .update([...executedIds].sort().join(" "))
    .update("|")
    .update(SELECTION_OVERLAY_VERSION)
    .digest("hex");

  const endingTotalCapital = round8(activeBankroll + vaultBankroll);
  const totalSweptToVault = round8(vaultSweepLedger.reduce((s, e) => s + e.sweepAmount, 0));

  const maximumAcceptedSignalsInOneUtcDay = Math.max(0, ...allDays.map((d) => dailyAcceptedCount.get(d) ?? 0));
  const maximumOpenExposurePct = maximumOpenExposureUnits > 0 ? round8((maximumOpenExposureUnits / activePeak) * 100) : 0;

  return {
    engineVersion: BANKROLL_VAULT_REPLAY_ENGINE_VERSION,
    simulationVersion: "BANKROLL_VAULT_REPLAY_V1",
    modelPolicyId: MODEL_POLICY_ID,
    selectionOverlayVersion: SELECTION_OVERLAY_VERSION,
    bankrollPolicyVersion: BANKROLL_POLICY_VERSION,
    resultLabel: "THEORETICAL_GROSS_HISTORICAL_REPLAY",

    preOverlayBaseline: { candidateId: MODEL_POLICY_ID, selectedObservations: baseAccepted.length },
    postOverlaySelectionHash,

    selectedObservations,
    canonicalEventGroups,
    wins,
    losses,
    invalidExcluded,
    rejectedByReason,

    grossTheoreticalPnl,
    grossTheoreticalRoi,
    maximumActiveBankrollDrawdown: round8(maximumActiveBankrollDrawdown),
    maximumTotalCapitalDrawdown: round8(maximumTotalCapitalDrawdown),
    longestLosingStreak,

    maximumSimultaneousPositions,
    maximumOpenExposureUnits: round8(maximumOpenExposureUnits),
    maximumOpenExposurePct,
    maximumAcceptedSignalsInOneUtcDay,
    reducedBelow3PctStakeOrders,

    initialActiveBankroll: round8(initialActiveBankroll),
    initialVaultBankroll: round8(initialVaultBankroll),
    endingActiveBankroll: round8(activeBankroll),
    endingVaultBankroll: round8(vaultBankroll),
    endingTotalCapital,
    totalSweptToVault,

    decisionLedger,
    settlementLedger,
    vaultSweepLedger,
    dailySummaries,
  };
}

export function serializeBankrollVaultReplayJson(result: BankrollVaultReplayResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export interface BankrollVaultReplayManifest {
  inputSha256: string;
  classifierSha256: string;
  jsonSha256: string;
  simulationVersion: string;
  modelPolicyId: string;
  selectionOverlayVersion: string;
  bankrollPolicyVersion: string;
  generatedAt: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildBankrollVaultReplayManifest(
  result: BankrollVaultReplayResult,
  hashes: { inputSha256: string; classifierSha256: string },
  jsonString: string,
  generatedAtIso: string,
): BankrollVaultReplayManifest {
  return {
    inputSha256: hashes.inputSha256,
    classifierSha256: hashes.classifierSha256,
    jsonSha256: sha256(jsonString),
    simulationVersion: result.simulationVersion,
    modelPolicyId: result.modelPolicyId,
    selectionOverlayVersion: result.selectionOverlayVersion,
    bankrollPolicyVersion: result.bankrollPolicyVersion,
    generatedAt: generatedAtIso,
  };
}
