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
import { evaluateHistoricalFunnelVariant, getScoreValue, getCoverageValue, isEsports } from "./historicalFunnelVariants";
import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";
import { BASE_COMPARATOR_ID, passesPriceFloor, passesTimingWithin120m } from "./boundedRoutingExperiments";
import { getEntryPriceValue, computeSelectionHash } from "./scoreComponentAnalysis";
import { classifyResolvedOutcome } from "./roiPnlContract";
import { computeSegmentMetrics } from "./extendedHistoricalDecomposition";
import { projectGeneratedSignalPairsStrictDedup } from "./generatedSignalPairsDedupPolicy";
import type { ExecutableFunnelClassifier } from "./executableFunnelClassifier";
import {
  buildHistoricalSportingMatchIdentityIndex,
  type HistoricalMatchIdentityConfidence,
} from "./historicalSportingMatchIdentity";

type Row = ExportRow;

export const BANKROLL_VAULT_REPLAY_ENGINE_VERSION = "3B-bankroll-vault-replay-v1.3" as const;

// ---------------------------------------------------------- version identifiers

export const MODEL_POLICY_ID = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M" as const;
export const SELECTION_OVERLAY_VERSION = "T90_STRONG_MATCH_SCORE_COVERAGE_V1" as const;
export const HISTORICAL_SELECTION_OVERLAY_VERSION = "T90_HISTORICAL_DERIVED_MATCH_V1" as const;
export const BANKROLL_POLICY_VERSION = "ACTIVE50_VAULT50_STAKE_MAX3_OPEN80_POS30_DAY100_V1" as const;

// ---------------------------------------------------------- frozen policy constants

const T90_DECISION_OFFSET_HOURS = 1.5; // decisionAt = eventStart - 90 minutes
const MAX_ACCEPTED_SIGNALS_PER_UTC_DAY = 100;
const MAX_CONCURRENT_POSITIONS = 30;
const MAX_OPEN_EXPOSURE_FRACTION = 0.8;
const PER_SIGNAL_STAKE_FRACTION = 0.03;

export const REJECTION_REASONS = [
  "NO_VALID_EVENT_START",
  "NO_T90_SNAPSHOT",
  "BASE_MODEL_REJECTED",
  "EVENT_RANKED_OUT",
  "NO_STRONG_SPORTING_MATCH_KEY",
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

// ---------------------------------------------------------- candidate snapshot

interface CandidateSnapshot {
  row: Row;
  observationId: string;
  identity: string;
  createdAtMs: number;
}

// ---------------------------------------------------------- strong sporting-match key

export type StrongSportingMatchKeySource = "match_family_key" | "canonical_event_key" | "parent_event_key";

/**
 * Fix 3: execution-level sporting-match identity uses ONLY the three
 * strongest existing fields, in this exact priority -- never event_slug/
 * event_title/market_slug/condition_id as an execution-level fallback (those
 * are per-market, not per-match, and would let multiple markets of the same
 * real sporting match each receive their own key). A row without any of
 * these three fields has no defensible sporting-match identity and cannot be
 * executed (NO_STRONG_SPORTING_MATCH_KEY).
 */
function strongSportingMatchKeyOf(row: Row): { key: string; source: StrongSportingMatchKeySource } | null {
  const matchFamily = row.match_family_key;
  if (typeof matchFamily === "string" && matchFamily.trim() !== "") {
    return { key: `match:${matchFamily.trim().toLowerCase()}`, source: "match_family_key" };
  }
  const canonical = row.canonical_event_key;
  if (typeof canonical === "string" && canonical.trim() !== "") {
    return { key: `canonical:${canonical.trim().toLowerCase()}`, source: "canonical_event_key" };
  }
  const parent = row.parent_event_key;
  if (typeof parent === "string" && parent.trim() !== "") {
    return { key: `parent:${parent.trim().toLowerCase()}`, source: "parent_event_key" };
  }
  return null;
}

// ---------------------------------------------------------- ranking

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
  matchIdentityMode?: MatchIdentityMode;
}

export type MatchIdentityMode = "strong-provider-only" | "historical-derived-v1";

export interface BankrollVaultReplayResult {
  engineVersion: typeof BANKROLL_VAULT_REPLAY_ENGINE_VERSION;
  simulationVersion: "BANKROLL_VAULT_REPLAY_V1_3";
  modelPolicyId: typeof MODEL_POLICY_ID;
  selectionOverlayVersion: typeof SELECTION_OVERLAY_VERSION | typeof HISTORICAL_SELECTION_OVERLAY_VERSION;
  bankrollPolicyVersion: typeof BANKROLL_POLICY_VERSION;
  resultLabel: "THEORETICAL_GROSS_HISTORICAL_REPLAY";

  preOverlayBaseline: {
    candidateId: typeof MODEL_POLICY_ID;
    selectedObservations: number;
  };
  // Exact, unmodified B2A base-candidate metrics -- reused verbatim, never
  // locally recomputed. On the canonical real corpus these must equal the
  // frozen B2A values (560 / 0f9368b7... / 278 / 282 / 82.5912 / 14.748429 / 407).
  baseCandidateSelectedObservations: number;
  baseCandidateSelectionHash: string;
  baseCandidateWins: number;
  baseCandidateLosses: number;
  baseCandidateFlatUnitPnl: number | null;
  baseCandidateFlatUnitRoi: number | null;
  baseCandidateWorkingEventGroups: number;

  t90QualifiedObservations: number;
  qualifiedSportingMatchGroups: number;
  executedSportingMatchGroups: number;
  // Independent diagnostic: runs the canonical exported isEsports predicate
  // directly over the final accepted rows -- not a tautological membership
  // check against an already-esports-filtered set.
  acceptedEsportsObservations: number;

  strongSportingMatchQualifiedRows: number;
  strongSportingMatchGroups: number;
  rowsRejectedNoStrongSportingMatchKey: number;
  eventGroupKeySourceCounts: Record<StrongSportingMatchKeySource, number>;
  historicalMatchIdentityMode: MatchIdentityMode;
  highConfidenceRows: number;
  uniquelyLinkedRows: number;
  ambiguousRejectedRows: number;
  derivedMatchGroups: number;
  derivedMatchCollisionCount: number;
  derivedMatchKeySourceCounts: Record<Extract<HistoricalMatchIdentityConfidence, "HIGH_PAIR_START" | "UNIQUE_SAME_START_LINK">, number>;

  postOverlaySelectionHash: string;

  selectedObservations: number;
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
  const historicalMatchIdentityMode = input.matchIdentityMode ?? "strong-provider-only";
  const selectionOverlayVersion = historicalMatchIdentityMode === "historical-derived-v1"
    ? HISTORICAL_SELECTION_OVERLAY_VERSION
    : SELECTION_OVERLAY_VERSION;
  if (!Number.isFinite(insuranceBankroll) || insuranceBankroll <= 0) {
    throw new Error("bankroll vault replay: insuranceBankroll must be a positive finite number");
  }

  const rejectedByReason: Record<RejectionReason, number> = Object.fromEntries(
    REJECTION_REASONS.map((r) => [r, 0]),
  ) as Record<RejectionReason, number>;

  // ---- 1. canonical strict dedup (reused verbatim, not reimplemented) ----
  const dedup = projectGeneratedSignalPairsStrictDedup([...rawRows]);
  const dedupedRows = dedup.dedupedRows;

  // ---- 2. exact existing B2A base-candidate selector, verbatim ----
  // B2_PRICE_FLOOR_030_TIMING_WITHIN_120M = ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS
  // (score>=65, eSports excluded by the unmodified classifier bundle) AND
  // entry price >= 0.30 AND 0 <= hoursUntilStart < 2. This reuses
  // evaluateHistoricalFunnelVariant + the exact exported price/timing
  // predicates -- the exact same call B2A itself makes for this candidate --
  // so its selectedObservations/selectionHash/wins/losses/PnL/ROI/
  // workingEventGroups are byte-identical to the accepted B2A run.
  const alt4Selected = evaluateHistoricalFunnelVariant(dedupedRows, classifier, BASE_COMPARATOR_ID).selectedRows;
  const baseCandidateRows = alt4Selected.filter((r) => passesPriceFloor(r) && passesTimingWithin120m(r));
  const baseCandidateMetrics = computeSegmentMetrics(baseCandidateRows);
  const baseCandidateSelectionHash = computeSelectionHash(baseCandidateRows.map(observationIdOf));

  // ---- 3. TRUE T-90 raw-snapshot selection (Fix 1) ----
  // For every strict signal identity, group the RAW (non-deduped) rows and
  // select the latest raw snapshot with created_at <= decisionAt
  // (eventStart - 90 minutes), computed from that identity's own
  // diagnostics.gameStartIso. Strict dedup's global latest-created-before-
  // resolved policy is NEVER applied before this step -- a later, post-
  // decisionAt raw snapshot for the same identity can never displace an
  // earlier valid pre-decision one, because rows recorded after decisionAt
  // are excluded from consideration entirely before the "latest" pick runs.
  // resolved_at is never read here. Tie-break: created_at DESC, then
  // observationId ASC.
  interface RawSnapshotCandidate {
    row: Row;
    observationId: string;
    createdAtMs: number;
    decisionAtMs: number | null;
  }
  const byIdentity = new Map<string, RawSnapshotCandidate[]>();
  for (const row of rawRows) {
    const identity = strictIdentityOf(row);
    if (identity === null) continue;
    const createdAtMs = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
    if (!Number.isFinite(createdAtMs)) continue;
    const startIso = (row.diagnostics as Record<string, unknown> | undefined)?.gameStartIso;
    const startMs = typeof startIso === "string" ? Date.parse(startIso) : NaN;
    const decisionAtMs = Number.isFinite(startMs) ? startMs - T90_DECISION_OFFSET_HOURS * 3_600_000 : null;
    const candidate: RawSnapshotCandidate = { row, observationId: observationIdOf(row), createdAtMs, decisionAtMs };
    const arr = byIdentity.get(identity);
    if (arr) arr.push(candidate);
    else byIdentity.set(identity, [candidate]);
  }

  const t90Selected = new Map<string, CandidateSnapshot>();
  for (const [identity, snaps] of byIdentity) {
    const withValidStart = snaps.filter((s) => s.decisionAtMs !== null);
    if (withValidStart.length === 0) {
      rejectedByReason.NO_VALID_EVENT_START += 1;
      continue;
    }
    const eligible = withValidStart.filter((s) => s.createdAtMs <= s.decisionAtMs!);
    if (eligible.length === 0) {
      rejectedByReason.NO_T90_SNAPSHOT += 1;
      continue;
    }
    const best = [...eligible].sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs; // DESC
      return a.observationId.localeCompare(b.observationId); // ASC
    })[0];
    t90Selected.set(identity, { row: best.row, observationId: best.observationId, identity, createdAtMs: best.createdAtMs });
  }

  // ---- canonical model eligibility on the T-90-selected snapshots ----
  const t90SnapshotRows = [...t90Selected.values()].map((s) => s.row);
  const alt4OnT90 = evaluateHistoricalFunnelVariant(t90SnapshotRows, classifier, BASE_COMPARATOR_ID).selectedRows;
  const t90QualifiedRows = alt4OnT90.filter((r) => passesPriceFloor(r) && passesTimingWithin120m(r));
  const t90QualifiedIds = new Set(t90QualifiedRows.map(observationIdOf));
  for (const snap of t90Selected.values()) {
    if (!t90QualifiedIds.has(snap.observationId)) rejectedByReason.BASE_MODEL_REJECTED += 1;
  }

  function toSnapshot(row: Row): CandidateSnapshot {
    const identity = strictIdentityOf(row) ?? observationIdOf(row);
    return t90Selected.get(identity) ?? { row, observationId: observationIdOf(row), identity, createdAtMs: Date.parse(String(row.created_at)) };
  }

  // ---- 4. one-strong-sporting-match ranking (Fix 3) ----
  // Execution-level grouping uses ONLY match_family_key -> canonical_event_key
  // -> parent_event_key -- never event_slug/event_title/market_slug/
  // condition_id as a fallback (those identify a market, not a match).
  const eventGroupKeySourceCounts: Record<StrongSportingMatchKeySource, number> = {
    match_family_key: 0,
    canonical_event_key: 0,
    parent_event_key: 0,
  };
  const historicalIndex = historicalMatchIdentityMode === "historical-derived-v1"
    ? buildHistoricalSportingMatchIdentityIndex(rawRows)
    : null;
  if (historicalIndex && historicalIndex.derivedMatchCollisionCount !== 0) {
    throw new Error(`bankroll vault replay: historical match identity collision count ${historicalIndex.derivedMatchCollisionCount}`);
  }
  const derivedMatchKeySourceCounts = { HIGH_PAIR_START: 0, UNIQUE_SAME_START_LINK: 0 };
  let highConfidenceRows = 0;
  let uniquelyLinkedRows = 0;
  let ambiguousRejectedRows = 0;
  const candidates: RankedCandidate[] = [];
  let rowsRejectedNoStrongSportingMatchKey = 0;
  for (const row of t90QualifiedRows) {
    const strongKey = strongSportingMatchKeyOf(row);
    const historicalEvidence = strongKey === null ? historicalIndex?.byObservationId.get(observationIdOf(row)) : undefined;
    const eventKey = strongKey?.key ?? historicalEvidence?.key ?? null;
    if (eventKey === null) {
      if (historicalIndex) ambiguousRejectedRows += 1;
      rejectedByReason.NO_STRONG_SPORTING_MATCH_KEY += 1;
      rowsRejectedNoStrongSportingMatchKey += 1;
      continue;
    }
    const score = getScoreValue(row);
    const coverage = getCoverageValue(row);
    const price = getEntryPriceValue(row);
    // Missing score or coverage fails closed -- excluded from ranking entirely.
    if (score === null || coverage === null || price === null) {
      rejectedByReason.EVENT_RANKED_OUT += 1;
      continue;
    }
    if (strongKey) eventGroupKeySourceCounts[strongKey.source] += 1;
    else if (historicalEvidence?.confidence === "HIGH_PAIR_START") {
      highConfidenceRows += 1;
      derivedMatchKeySourceCounts.HIGH_PAIR_START += 1;
    } else if (historicalEvidence?.confidence === "UNIQUE_SAME_START_LINK") {
      uniquelyLinkedRows += 1;
      derivedMatchKeySourceCounts.UNIQUE_SAME_START_LINK += 1;
    }
    candidates.push({ snapshot: toSnapshot(row), eventKey, finalScore: score, dataCoverage: coverage, entryPrice: price });
  }
  const strongSportingMatchQualifiedRows = candidates.length;

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
  const qualifiedSportingMatchGroups = byEvent.size;
  const strongSportingMatchGroups = byEvent.size;
  const derivedMatchGroups = new Set(candidates.filter((c) => c.eventKey.startsWith("historical:v1:")).map((c) => c.eventKey)).size;
  const rankedSportingMatchGroups = winners.length;
  if (rankedSportingMatchGroups !== qualifiedSportingMatchGroups) {
    throw new Error("bankroll vault replay: invariant violated -- ranked sporting-match groups must equal qualified sporting-match groups");
  }
  const executedEventKeys = winners.map((w) => w.eventKey);
  if (new Set(executedEventKeys).size !== executedEventKeys.length) {
    throw new Error("bankroll vault replay: invariant violated -- duplicate executed sporting-match key");
  }

  // ---- decision-time ordering: frozen ranking tuple ----
  const orderedWinners = [...winners].sort(RANK_ORDER);
  const winnerRowById = new Map(winners.map((w) => [w.snapshot.observationId, w.snapshot.row]));

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
  const executedSportingMatchGroups = selectedObservations;
  const invalidExcluded = rejectedByReason.INVALID_RESOLVED_AT + rejectedByReason.INVALID_ENTRY_PRICE + rejectedByReason.INVALID_RESULT;

  const executedIds = decisionLedger.filter((d) => d.accepted).map((d) => d.observationId);
  const postOverlaySelectionHash = createHash("sha256")
    .update([...executedIds].sort().join(" "))
    .update("|")
    .update(selectionOverlayVersion)
    .digest("hex");

  const endingTotalCapital = round8(activeBankroll + vaultBankroll);
  const totalSweptToVault = round8(vaultSweepLedger.reduce((s, e) => s + e.sweepAmount, 0));

  const maximumAcceptedSignalsInOneUtcDay = Math.max(0, ...allDays.map((d) => dailyAcceptedCount.get(d) ?? 0));
  const maximumOpenExposurePct = maximumOpenExposureUnits > 0 ? round8((maximumOpenExposureUnits / activePeak) * 100) : 0;

  return {
    engineVersion: BANKROLL_VAULT_REPLAY_ENGINE_VERSION,
    simulationVersion: "BANKROLL_VAULT_REPLAY_V1_3",
    modelPolicyId: MODEL_POLICY_ID,
    selectionOverlayVersion,
    bankrollPolicyVersion: BANKROLL_POLICY_VERSION,
    resultLabel: "THEORETICAL_GROSS_HISTORICAL_REPLAY",

    preOverlayBaseline: { candidateId: MODEL_POLICY_ID, selectedObservations: baseCandidateRows.length },
    baseCandidateSelectedObservations: baseCandidateRows.length,
    baseCandidateSelectionHash,
    baseCandidateWins: baseCandidateMetrics.wins,
    baseCandidateLosses: baseCandidateMetrics.losses,
    baseCandidateFlatUnitPnl: baseCandidateMetrics.flatUnitPnl,
    baseCandidateFlatUnitRoi: baseCandidateMetrics.flatUnitRoi,
    baseCandidateWorkingEventGroups: baseCandidateMetrics.workingEventGroups,

    t90QualifiedObservations: t90QualifiedRows.length,
    qualifiedSportingMatchGroups,
    executedSportingMatchGroups,
    // Independent: runs the canonical exported isEsports predicate directly
    // over the final accepted rows' own data -- not a subset-membership
    // tautology.
    acceptedEsportsObservations: executedIds.filter((id) => {
      const row = winnerRowById.get(id);
      return row !== undefined && isEsports(row);
    }).length,

    strongSportingMatchQualifiedRows,
    strongSportingMatchGroups,
    rowsRejectedNoStrongSportingMatchKey,
    eventGroupKeySourceCounts,
    historicalMatchIdentityMode,
    highConfidenceRows,
    uniquelyLinkedRows,
    ambiguousRejectedRows,
    derivedMatchGroups,
    derivedMatchCollisionCount: historicalIndex?.derivedMatchCollisionCount ?? 0,
    derivedMatchKeySourceCounts,

    postOverlaySelectionHash,

    selectedObservations,
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
