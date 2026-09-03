/**
 * COMPACT_RESEARCH_MATERIALIZER_V1 — compact, population-aware modeling corpus.
 *
 * Bounded extension of FORWARD_RICH_CAPTURE_V1. Given ONE closed D-1 raw slice
 * from the research clone (immutable generated_signal_pairs decision rows +
 * generated_signal_research_snapshots observations, already normalized by the
 * caller), this layer:
 *
 *   1. collapses repeated raw GSP emissions for the same canonical identity to
 *      the FIRST eligible decision row (RESEARCH_CORPUS_CONTRACT.md §3) —
 *      "first eligible row" C4 semantics are preserved, repeated emissions are
 *      not retained;
 *   2. resolves the mandatory `population_id` and keeps incompatible producer
 *      populations separate (§1);
 *   3. reuses the pure FORWARD_RICH materializer for the PIT-safe feature row +
 *      endpoint-compressed price/score/volume series (§3, §4);
 *   4. attaches the Gamma-authoritative label layer (§5) — clone `signal_result`
 *      is never settlement authority;
 *   5. adapts the compact rows to the frozen research-engine input contract so
 *      the existing, unchanged C4 predicate runs directly on the compact output.
 *
 * Pure: no I/O, no wall-clock, no Map/Set iteration-order dependence.
 */

import {
  evaluateEvent,
  runModel,
  type FrozenModelId,
} from "@/lib/modeling/research-engine/engine";
import { FROZEN_MODELS } from "@/lib/modeling/research-engine/models";
import type {
  ModelResult,
  ResearchEngineInputEvent,
} from "@/lib/modeling/research-engine/types";

import { materializeForwardRichResearch, derivePopulationId } from "./materializeForwardRichResearch";
import type {
  ForwardRichResearchRow,
  ForwardRichSignalPair,
  ForwardRichSnapshotObservation,
  GammaTerminalState,
  PopulationId,
} from "./types";

/** One closed D-1 raw research-clone slice, normalized by the caller. */
export interface CompactCorpusSlice {
  /** D-1 calendar date this slice covers (UTC, `YYYY-MM-DD`). */
  sliceDateUtc: string;
  /** Immutable GSP decision rows in the slice (may contain repeated emissions). */
  signalPairs: ForwardRichSignalPair[];
  /** Immutable GSRS observations in the slice (may contain repeated snapshots). */
  observations: ForwardRichSnapshotObservation[];
  /**
   * Append/cutoff boundary. Only identities whose DECISION_AT is strictly after
   * this instant are materialized. Defaults to the start of `sliceDateUtc`.
   */
  sinceCutoff?: string;
  /** MATERIALIZED_AT — caller-supplied so the core stays clock-free. */
  materializedAt: string;
}

/** Compression funnel with strictly separated units (RESEARCH_CORPUS_CONTRACT.md §0). */
export interface CompactCorpusFunnel {
  /** INPUT: raw GSP decision rows in the slice. */
  inputRawGspRows: number;
  /** INPUT: distinct source events (provider_event_id) in the slice. */
  inputUniqueSourceEvents: number;
  /** INPUT: distinct markets (condition_id) in the slice. */
  inputUniqueMarkets: number;
  /** OUTPUT: compact PIT feature rows produced. */
  outputCompactFeatureRows: number;
  /** OUTPUT: distinct events (provider_event_id) in the compact output. */
  outputUniqueCompactEvents: number;
  /** raw GSP rows / compact feature rows (>= 1). */
  compressionRatio: number;
}

export interface CompactCorpusResult {
  sliceDateUtc: string;
  sinceCutoff: string;
  materializedAt: string;
  /** Compact feature rows, deterministic order, across ALL populations. */
  rows: ForwardRichResearchRow[];
  /** Per-population row counts — proof that incompatible populations stay separate. */
  populationRowCounts: Record<PopulationId, number>;
  funnel: CompactCorpusFunnel;
}

function identityKey(conditionId: string, selectedTokenId: string): string {
  return `${conditionId}::${selectedTokenId}`;
}

function eventKey(pair: ForwardRichSignalPair): string {
  return pair.providerEventId || pair.conditionId;
}

/** Prefer the first concrete Gamma terminal state seen for an identity. */
function mergeGamma(
  current: GammaTerminalState | null | undefined,
  incoming: GammaTerminalState | null | undefined,
): GammaTerminalState | null {
  return (current ?? incoming ?? null) as GammaTerminalState | null;
}

/**
 * Collapse repeated raw GSP emissions for the same canonical identity
 * `(condition_id, selected_token_id)` to the chronologically FIRST decision
 * row. Tiebreak: sourceCreatedAt, then provider_event_id — total, so the
 * collapse is deterministic regardless of input order.
 */
export function collapseRepeatedEmissions(
  pairs: ForwardRichSignalPair[],
): ForwardRichSignalPair[] {
  const firstByIdentity = new Map<string, ForwardRichSignalPair>();
  const countByIdentity = new Map<string, number>();

  for (const pair of pairs) {
    const key = identityKey(pair.conditionId, pair.selectedTokenId);
    countByIdentity.set(key, (countByIdentity.get(key) ?? 0) + 1);
    const held = firstByIdentity.get(key);
    if (held === undefined) {
      firstByIdentity.set(key, pair);
      continue;
    }
    const isEarlier =
      pair.decisionAt < held.decisionAt ||
      (pair.decisionAt === held.decisionAt &&
        (pair.sourceCreatedAt < held.sourceCreatedAt ||
          (pair.sourceCreatedAt === held.sourceCreatedAt &&
            (pair.providerEventId ?? "") < (held.providerEventId ?? ""))));
    firstByIdentity.set(key, {
      ...(isEarlier ? pair : held),
      // Gamma terminal state is identity-level: keep it even if it arrived on a
      // later emission (it is still point-in-time safe — settlement post-dates
      // every decision by construction).
      gammaTerminal: mergeGamma(held.gammaTerminal, pair.gammaTerminal),
      cloneSignalResult:
        (isEarlier ? pair.cloneSignalResult : held.cloneSignalResult) ??
        held.cloneSignalResult ??
        pair.cloneSignalResult ??
        null,
    });
  }

  const collapsed: ForwardRichSignalPair[] = [];
  for (const [key, pair] of firstByIdentity) {
    collapsed.push({
      ...pair,
      populationId: derivePopulationId(pair),
      collapsedCount: countByIdentity.get(key) ?? 1,
    });
  }
  // Deterministic order for downstream materialization.
  collapsed.sort((a, b) =>
    a.decisionAt !== b.decisionAt
      ? a.decisionAt < b.decisionAt
        ? -1
        : 1
      : identityKey(a.conditionId, a.selectedTokenId) <
          identityKey(b.conditionId, b.selectedTokenId)
        ? -1
        : 1,
  );
  return collapsed;
}

const ZERO_POP_COUNTS: Record<PopulationId, number> = {
  AUG_SHADOW_C4_V1: 0,
  SEP_SHADOW_STRATEGIC_V1: 0,
  SEP_PUBLIC_RICH_V1: 0,
};

/** Build the compact, population-aware corpus from one closed D-1 raw slice. */
export function buildCompactCorpus(slice: CompactCorpusSlice): CompactCorpusResult {
  const sinceCutoff =
    slice.sinceCutoff ?? `${slice.sliceDateUtc}T00:00:00.000Z`;

  const collapsedPairs = collapseRepeatedEmissions(slice.signalPairs);

  const rows = materializeForwardRichResearch({
    signalPairs: collapsedPairs,
    observations: slice.observations,
    sinceCutoff,
    materializedAt: slice.materializedAt,
  });

  const populationRowCounts: Record<PopulationId, number> = { ...ZERO_POP_COUNTS };
  for (const row of rows) populationRowCounts[row.populationId] += 1;

  const inputUniqueSourceEvents = new Set(slice.signalPairs.map(eventKey)).size;
  const inputUniqueMarkets = new Set(
    slice.signalPairs.map((p) => p.conditionId),
  ).size;
  const outputUniqueCompactEvents = new Set(
    rows.map((r) => r.providerEventId || r.conditionId),
  ).size;

  const funnel: CompactCorpusFunnel = {
    inputRawGspRows: slice.signalPairs.length,
    inputUniqueSourceEvents,
    inputUniqueMarkets,
    outputCompactFeatureRows: rows.length,
    outputUniqueCompactEvents,
    compressionRatio:
      rows.length === 0
        ? 0
        : Math.round((slice.signalPairs.length / rows.length) * 10_000) / 10_000,
  };

  return {
    sliceDateUtc: slice.sliceDateUtc,
    sinceCutoff,
    materializedAt: slice.materializedAt,
    rows,
    populationRowCounts,
    funnel,
  };
}

// ---------------------------------------------------------------------------
// Research-engine adapter — the existing FROZEN C4 predicate runs unchanged
// on the compact output. No threshold, ordering, settlement or metric logic
// is redefined here.
// ---------------------------------------------------------------------------

export interface CompactEngineAdaptResult {
  populationId: PopulationId;
  /** Rows fed to the engine (terminal WIN/LOSS, valid price/family/eventStart). */
  inputs: ResearchEngineInputEvent[];
  /** Compact rows dropped, by reason — full accounting, no silent loss. */
  dropped: {
    otherPopulation: number;
    notTerminal: number;
    voidLabel: number;
    noMatchOrAmbiguous: number;
    invalidEntryPrice: number;
    missingSportFamily: number;
    missingEventStart: number;
  };
}

/**
 * Adapt one population's compact rows to the frozen research-engine input
 * contract. VOID and OPEN rows are excluded from the engine feed (the engine's
 * settlement is WIN/LOSS only); they are still counted in DATA QUALITY upstream.
 */
export function toResearchEngineInputs(
  rows: ForwardRichResearchRow[],
  populationId: PopulationId,
): CompactEngineAdaptResult {
  const inputs: ResearchEngineInputEvent[] = [];
  const dropped = {
    otherPopulation: 0,
    notTerminal: 0,
    voidLabel: 0,
    noMatchOrAmbiguous: 0,
    invalidEntryPrice: 0,
    missingSportFamily: 0,
    missingEventStart: 0,
  };

  for (const row of rows) {
    if (row.populationId !== populationId) {
      dropped.otherPopulation += 1;
      continue;
    }
    if (row.label === "NO_MATCH" || row.label === "AMBIGUOUS") {
      dropped.noMatchOrAmbiguous += 1;
      continue;
    }
    if (row.label === "VOID") {
      dropped.voidLabel += 1;
      continue;
    }
    if (row.label !== "WIN" && row.label !== "LOSS") {
      dropped.notTerminal += 1;
      continue;
    }
    if (row.entryPrice == null || !(row.entryPrice > 0 && row.entryPrice < 1)) {
      dropped.invalidEntryPrice += 1;
      continue;
    }
    const sportFamily = (row.providerSportFamily ?? "").trim().toLowerCase();
    if (!sportFamily) {
      dropped.missingSportFamily += 1;
      continue;
    }
    if (!row.eventStart) {
      dropped.missingEventStart += 1;
      continue;
    }
    inputs.push({
      physicalEventKey: row.providerEventId || row.conditionId,
      decisionTimestamp: row.decisionAt,
      eventStart: row.eventStart,
      entryPrice: row.entryPrice,
      sportFamily,
      outcome: row.label,
      ref: identityKey(row.conditionId, row.selectedTokenId),
    });
  }

  return { populationId, inputs, dropped };
}

export interface CompactC4Scorecard {
  populationId: PopulationId;
  period: { fromInclusive: string; toInclusive: string } | null;
  /** Distinct physical events with >= 1 compact row satisfying the C4 predicate. */
  uniqueEligibleEvents: number;
  bets: number;
  pnlUnits: number;
  roiPct: number;
  maxDrawdownUnits: number;
  pnlPer100Bets: number;
  /** Daily stability buckets (UTC date -> bets/pnl); weekly when the slice spans weeks. */
  stability: Array<{ bucket: string; bets: number; pnlUnits: number; cumulativePnlUnits: number }>;
  engineModelVersion: string;
  engineResult: ModelResult;
  adapt: CompactEngineAdaptResult;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  const r = Math.round((value + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Run the frozen C4 model on one population's compact output and shape the
 * Founder-facing result (RESEARCH_CORPUS_CONTRACT.md §8, V1 subset).
 */
export function runCompactC4Scorecard(
  rows: ForwardRichResearchRow[],
  populationId: PopulationId,
  modelId: FrozenModelId = "C4",
): CompactC4Scorecard {
  const adapt = toResearchEngineInputs(rows, populationId);
  const result = runModel(modelId, adapt.inputs);

  // C4-eligible unique events: distinct physicalEventKey with >= 1 input row
  // that satisfies the frozen predicate (before one-bet-per-event collapse).
  const predicate = FROZEN_MODELS[modelId].predicate;
  const eligibleEvents = new Set<string>();
  for (const input of adapt.inputs) {
    if (predicate(evaluateEvent(input))) eligibleEvents.add(input.physicalEventKey);
  }

  const decisionDates = adapt.inputs.map((i) => i.decisionTimestamp).sort();
  const period =
    decisionDates.length === 0
      ? null
      : {
          fromInclusive: decisionDates[0].slice(0, 10),
          toInclusive: decisionDates[decisionDates.length - 1].slice(0, 10),
        };

  // Stability: bucket selected bets by UTC decision date, chronological.
  const byBucket = new Map<string, { bets: number; pnlUnits: number }>();
  const orderedBuckets: string[] = [];
  for (const bet of result.selectedBets) {
    const bucket = bet.decisionTimestamp.slice(0, 10);
    let cell = byBucket.get(bucket);
    if (!cell) {
      cell = { bets: 0, pnlUnits: 0 };
      byBucket.set(bucket, cell);
      orderedBuckets.push(bucket);
    }
    cell.bets += 1;
    cell.pnlUnits += bet.pnlU;
  }
  orderedBuckets.sort();
  let cumulative = 0;
  const stability = orderedBuckets.map((bucket) => {
    const cell = byBucket.get(bucket)!;
    cumulative += cell.pnlUnits;
    return {
      bucket,
      bets: cell.bets,
      pnlUnits: round(cell.pnlUnits, 2),
      cumulativePnlUnits: round(cumulative, 2),
    };
  });

  return {
    populationId,
    period,
    uniqueEligibleEvents: eligibleEvents.size,
    bets: result.SELECTED_PHYSICAL_EVENT_N,
    pnlUnits: result.PNL_U,
    roiPct: result.ROI_PCT,
    maxDrawdownUnits: result.MAX_DRAWDOWN_U,
    pnlPer100Bets:
      result.SELECTED_PHYSICAL_EVENT_N === 0
        ? 0
        : round((result.raw.pnlU / result.SELECTED_PHYSICAL_EVENT_N) * 100, 2),
    stability,
    engineModelVersion: result.MODEL_VERSION,
    engineResult: result,
    adapt,
  };
}
