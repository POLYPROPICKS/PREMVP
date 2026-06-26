// LIQUIDITY_MODEL — pure entry/exit executable-return simulation.
//
// Each simulation enters a YES long at the best ask for `stakeUsd`, then
// immediately tests exiting into the bid book at 5/10/15% slippage bands.
// Executable@N% means the full position exits within an N% slippage band.
// Returns null metrics where book data is missing — no midpoint fantasy.

import {
  computeEntryExitReturn,
  getBestBidAsk,
} from "./orderbookMath";
import type {
  ParsedOrderBook,
  SimulationRow,
  SnapshotRow,
} from "./types";

export const DEFAULT_SIMULATION_STAKE_USD = 10;
export const DEFAULT_SIMULATION_LIMIT = 5000;

const SLIPPAGE_LEVELS = [0.05, 0.1, 0.15] as const;

export interface SimulationInput {
  tokenId: string;
  marketId: string | null;
  normalizedSport: SnapshotRow["normalized_sport"];
  normalizedMarketFamily: SnapshotRow["normalized_market_family"];
  phaseBucket: SnapshotRow["phase_bucket"];
  book: ParsedOrderBook;
}

/**
 * Build an entry/exit simulation row from a single orderbook.
 * stakeUsd defaults to LIQUIDITY_SIMULATION_STAKE_USD (10).
 */
export function buildEntryExitSimulation(
  input: SimulationInput,
  stakeUsd: number = DEFAULT_SIMULATION_STAKE_USD,
  simulatedAt: string = new Date().toISOString(),
  feePct = 0,
): SimulationRow {
  const { bestAsk } = getBestBidAsk(input.book);
  const shares = bestAsk && bestAsk > 0 && stakeUsd > 0 ? stakeUsd / bestAsk : null;

  const r5 = computeEntryExitReturn(input.book, stakeUsd, SLIPPAGE_LEVELS[0], feePct);
  const r10 = computeEntryExitReturn(input.book, stakeUsd, SLIPPAGE_LEVELS[1], feePct);
  const r15 = computeEntryExitReturn(input.book, stakeUsd, SLIPPAGE_LEVELS[2], feePct);

  return {
    token_id: input.tokenId,
    market_id: input.marketId,
    normalized_sport: input.normalizedSport,
    normalized_market_family: input.normalizedMarketFamily,
    simulated_at: simulatedAt,
    phase_bucket: input.phaseBucket,
    stake_usd: stakeUsd,
    entry_price: bestAsk,
    shares,
    exit_proceeds_5pct_usd: r5.exitProceedsUsd,
    exit_proceeds_10pct_usd: r10.exitProceedsUsd,
    exit_proceeds_15pct_usd: r15.exitProceedsUsd,
    net_return_5pct_pct: r5.netReturnPct,
    net_return_10pct_pct: r10.netReturnPct,
    net_return_15pct_pct: r15.netReturnPct,
    executable_5pct: r5.fullyFilled,
    executable_10pct: r10.fullyFilled,
    executable_15pct: r15.fullyFilled,
  };
}

/**
 * Select which snapshots to simulate. Groups OK/PARTIAL snapshots by token and
 * keeps the most recent per token (one round-trip per token per run), capped at
 * `limit`. Snapshots without usable book data are skipped.
 */
export function selectEntryExitPairs(
  snapshots: SnapshotRow[],
  limit: number = DEFAULT_SIMULATION_LIMIT,
): SimulationInput[] {
  const latestByToken = new Map<string, SnapshotRow>();
  for (const s of snapshots) {
    if (s.status !== "OK" && s.status !== "PARTIAL") continue;
    if (!s.bids?.length && !s.asks?.length) continue;
    const existing = latestByToken.get(s.token_id);
    if (!existing || Date.parse(s.captured_at) >= Date.parse(existing.captured_at)) {
      latestByToken.set(s.token_id, s);
    }
  }

  const inputs: SimulationInput[] = [];
  for (const s of latestByToken.values()) {
    inputs.push({
      tokenId: s.token_id,
      marketId: s.market_id,
      normalizedSport: s.normalized_sport,
      normalizedMarketFamily: s.normalized_market_family,
      phaseBucket: s.phase_bucket,
      book: { tokenId: s.token_id, bids: s.bids ?? [], asks: s.asks ?? [] },
    });
  }

  // Deterministic order, then cap.
  inputs.sort((a, b) => a.tokenId.localeCompare(b.tokenId));
  return inputs.slice(0, Math.max(0, limit));
}

export interface SimulationFlagSummary {
  simulations: number;
  executable5pct: number;
  executable10pct: number;
  executable15pct: number;
  tokens: number;
}

/** Aggregate executable flags across simulation rows. */
export function summarizeSimulationFlags(rows: SimulationRow[]): SimulationFlagSummary {
  const tokens = new Set<string>();
  let e5 = 0;
  let e10 = 0;
  let e15 = 0;
  for (const r of rows) {
    tokens.add(r.token_id);
    if (r.executable_5pct) e5 += 1;
    if (r.executable_10pct) e10 += 1;
    if (r.executable_15pct) e15 += 1;
  }
  return {
    simulations: rows.length,
    executable5pct: e5,
    executable10pct: e10,
    executable15pct: e15,
    tokens: tokens.size,
  };
}
