/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — reusable ordering + metrics.
 *
 * Deterministic across runs and platforms: no wall-clock, no Map/Set
 * iteration order dependence, total ordering on every tiebreak.
 */
import type { EvaluatedEvent, SelectedBet } from "./types";

/** Round to `dp` decimal places, avoiding -0. */
export function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  const r = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Stable chronological comparator with a total tiebreak chain so that any
 * two distinct rows have a deterministic order regardless of input order.
 */
export function compareChronologically(
  a: EvaluatedEvent,
  b: EvaluatedEvent,
): number {
  if (a.decisionTimestamp !== b.decisionTimestamp) {
    return a.decisionTimestamp < b.decisionTimestamp ? -1 : 1;
  }
  if (a.eventStart !== b.eventStart) {
    return a.eventStart < b.eventStart ? -1 : 1;
  }
  if (a.physicalEventKey !== b.physicalEventKey) {
    return a.physicalEventKey < b.physicalEventKey ? -1 : 1;
  }
  if (a.entryPrice !== b.entryPrice) {
    return a.entryPrice - b.entryPrice;
  }
  if (a.sportFamily !== b.sportFamily) {
    return a.sportFamily < b.sportFamily ? -1 : 1;
  }
  const aRef = a.ref ?? "";
  const bRef = b.ref ?? "";
  if (aRef !== bRef) {
    return aRef < bRef ? -1 : 1;
  }
  return 0;
}

/** Sort a copy of the events into stable chronological order. */
export function sortChronologically(
  events: EvaluatedEvent[],
): EvaluatedEvent[] {
  return [...events].sort(compareChronologically);
}

/**
 * Chronological maximum drawdown, in units, over an already chronologically
 * ordered list of selected bets. Return value is <= 0.
 */
export function maxDrawdownU(orderedBets: SelectedBet[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  for (const bet of orderedBets) {
    cumulative += bet.pnlU;
    if (cumulative > peak) {
      peak = cumulative;
    }
    const drawdown = cumulative - peak;
    if (drawdown < maxDd) {
      maxDd = drawdown;
    }
  }
  return maxDd;
}

export interface AggregateMetrics {
  SELECTED_PHYSICAL_EVENT_N: number;
  WINS: number;
  LOSSES: number;
  PNL_U: number;
  ROI_PCT: number;
  MAX_DRAWDOWN_U: number;
  raw: { pnlU: number; roiPct: number; maxDrawdownU: number };
}

/**
 * Reusable aggregate metrics over an already chronologically ordered list of
 * selected bets. ROI is on the flat-1u stake per selected event.
 */
export function aggregateMetrics(orderedBets: SelectedBet[]): AggregateMetrics {
  const n = orderedBets.length;
  let wins = 0;
  let pnlU = 0;
  for (const bet of orderedBets) {
    if (bet.outcome === "WIN") {
      wins += 1;
    }
    pnlU += bet.pnlU;
  }
  const losses = n - wins;
  const roiPct = n === 0 ? 0 : (pnlU / n) * 100;
  const maxDd = maxDrawdownU(orderedBets);
  return {
    SELECTED_PHYSICAL_EVENT_N: n,
    WINS: wins,
    LOSSES: losses,
    PNL_U: round(pnlU, 2),
    ROI_PCT: round(roiPct, 4),
    MAX_DRAWDOWN_U: round(maxDd, 2),
    raw: { pnlU, roiPct, maxDrawdownU: maxDd },
  };
}
