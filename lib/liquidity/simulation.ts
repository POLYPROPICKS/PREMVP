// LIQUIDITY_MODEL — pure entry/exit executable-return simulation.
//
// Pairs an EARLIER pre-match snapshot (entry phase) with a LATER snapshot (exit
// phase) for the same token. Entry buys YES at the entry snapshot's best ask;
// exit sells the whole position into the exit snapshot's bid book (executable,
// no midpoint fantasy). executable@N% means: the position fully exits AND the
// net executable return is >= N%. Default stake = $10. Fee default 0.

import { computeExecutableExit, getBestBidAsk } from "./orderbookMath";
import type {
  OrderBookLevel,
  ParsedOrderBook,
  PhaseBucket,
  SimulationRow,
  SnapshotRow,
} from "./types";

export const DEFAULT_SIMULATION_STAKE_USD = 10;
export const DEFAULT_SIMULATION_LIMIT = 5000;

export const ENTRY_PHASES: ReadonlySet<PhaseBucket> = new Set<PhaseBucket>([
  "T_12H",
  "T_6H",
  "T_3H",
  "T_2H",
  "T_1H",
  "T_30M",
]);

export const EXIT_PHASES: ReadonlySet<PhaseBucket> = new Set<PhaseBucket>([
  "T_15M",
  "T_10M",
  "T_5M",
  "LIVE_0_5M",
  "LIVE_5_15M",
]);

export interface EntryExitPair {
  entry: SnapshotRow;
  exit: SnapshotRow;
}

function isUsable(s: SnapshotRow): boolean {
  if (s.snapshot_status === "failed") return false;
  const bids = s.book_levels_json?.bids ?? [];
  const asks = s.book_levels_json?.asks ?? [];
  return bids.length > 0 || asks.length > 0;
}

/**
 * Select entry/exit snapshot pairs per token: each entry-phase snapshot is
 * paired with the latest later exit-phase snapshot. Bounded by `limit`,
 * deterministic order (token, then entry capture time).
 */
export function selectEntryExitPairs(
  snapshots: SnapshotRow[],
  limit: number = DEFAULT_SIMULATION_LIMIT,
): EntryExitPair[] {
  const byToken = new Map<string, SnapshotRow[]>();
  for (const s of snapshots) {
    if (!isUsable(s)) continue;
    const arr = byToken.get(s.token_id) ?? [];
    arr.push(s);
    byToken.set(s.token_id, arr);
  }

  const pairs: EntryExitPair[] = [];
  for (const arr of byToken.values()) {
    const entries = arr
      .filter((s) => ENTRY_PHASES.has(s.phase_bucket))
      .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
    const exits = arr
      .filter((s) => EXIT_PHASES.has(s.phase_bucket))
      .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
    for (const entry of entries) {
      const entryT = Date.parse(entry.captured_at);
      let bestExit: SnapshotRow | null = null;
      for (const exit of exits) {
        if (Date.parse(exit.captured_at) > entryT) bestExit = exit; // latest wins
      }
      if (bestExit) pairs.push({ entry, exit: bestExit });
    }
  }

  pairs.sort(
    (a, b) =>
      a.entry.token_id.localeCompare(b.entry.token_id) ||
      Date.parse(a.entry.captured_at) - Date.parse(b.entry.captured_at),
  );
  return pairs.slice(0, Math.max(0, limit));
}

function bookFromSnapshot(s: SnapshotRow): ParsedOrderBook {
  return {
    tokenId: s.token_id,
    bids: s.book_levels_json?.bids ?? [],
    asks: s.book_levels_json?.asks ?? [],
  };
}

function totalBidUsd(bids: OrderBookLevel[]): number {
  return bids.reduce((sum, l) => sum + l.price * l.size, 0);
}

/** Build one entry/exit simulation row from a snapshot pair. */
export function buildEntryExitSimulation(
  pair: EntryExitPair,
  simulationRunId: string,
  stakeUsd: number = DEFAULT_SIMULATION_STAKE_USD,
  feePct = 0,
): SimulationRow {
  const { entry, exit } = pair;
  const entryAsk = entry.best_ask;
  const exitBook = bookFromSnapshot(exit);
  const exitBids = exitBook.bids;
  const { bestBid: exitBestBid } = getBestBidAsk(exitBook);

  let shares: number | null = null;
  let netReturnPct: number | null = null;
  let grossReturnPct: number | null = null;
  let slippagePct: number | null = null;
  let exitPossible = false;
  let proceeds: number | null = null;

  if (entryAsk !== null && entryAsk > 0 && stakeUsd > 0) {
    shares = stakeUsd / entryAsk;
    const fill = computeExecutableExit(exitBids, shares);
    exitPossible = fill.fullyFilled;
    proceeds = fill.proceedsUsd;
    netReturnPct = ((proceeds * (1 - feePct) - stakeUsd) / stakeUsd) * 100;
    if (fill.avgPrice !== null) {
      slippagePct = ((entryAsk - fill.avgPrice) / entryAsk) * 100;
    }
    if (exitBestBid !== null) {
      grossReturnPct = ((exitBestBid - entryAsk) / entryAsk) * 100;
    }
  }

  const exitLiquidityUsd = totalBidUsd(exitBids);
  const net = netReturnPct;
  const executable5 = exitPossible && net !== null && net >= 5;
  const executable10 = exitPossible && net !== null && net >= 10;
  const executable15 = exitPossible && net !== null && net >= 15;

  return {
    simulation_run_id: simulationRunId,
    condition_id: entry.condition_id,
    token_id: entry.token_id,
    opposing_token_id: entry.opposing_token_id,
    event_slug: entry.event_slug,
    market_slug: entry.market_slug,
    normalized_sport: entry.normalized_sport,
    league: entry.league,
    normalized_market_family: entry.normalized_market_family,
    match_family_key: entry.match_family_key,
    selected_outcome: entry.selected_outcome,
    game_start_iso: entry.game_start_iso,
    entry_captured_at: entry.captured_at,
    exit_captured_at: exit.captured_at,
    entry_phase_bucket: entry.phase_bucket,
    exit_phase_bucket: exit.phase_bucket,
    entry_best_ask: entryAsk,
    entry_best_bid: entry.best_bid,
    entry_mid_price: entry.mid_price,
    exit_best_bid: exitBestBid,
    exit_best_ask: exit.best_ask,
    exit_mid_price: exit.mid_price,
    stake_usd: stakeUsd,
    gross_return_pct: grossReturnPct,
    estimated_slippage_pct: slippagePct,
    estimated_fee_pct: feePct,
    net_return_pct: netReturnPct,
    exit_liquidity_usd: exitLiquidityUsd,
    exit_possible_boolean: exitPossible,
    executable_5pct_boolean: executable5,
    executable_10pct_boolean: executable10,
    executable_15pct_boolean: executable15,
    entry_market_volume_usd: entry.market_volume_usd,
    exit_market_volume_usd: exit.market_volume_usd,
    volume_gate_threshold_usd: entry.volume_gate_threshold_usd,
    market_family_gate_status: entry.market_family_gate_status,
    exit_reason: exitPossible ? "executable_exit" : "insufficient_exit_depth",
    model_version: "liquidity_pool_mvp_v1",
    diagnostics: {
      entry_phase: entry.phase_bucket,
      exit_phase: exit.phase_bucket,
      shares,
      proceeds_usd: proceeds,
    },
  };
}

export interface SimulationFlagSummary {
  tokens: number;
  simulations: number;
  executable5pct: number;
  executable10pct: number;
  executable15pct: number;
}

/** Aggregate executable flags across simulation rows. */
export function summarizeSimulationFlags(rows: SimulationRow[]): SimulationFlagSummary {
  const tokens = new Set<string>();
  let e5 = 0;
  let e10 = 0;
  let e15 = 0;
  for (const r of rows) {
    tokens.add(r.token_id);
    if (r.executable_5pct_boolean) e5 += 1;
    if (r.executable_10pct_boolean) e10 += 1;
    if (r.executable_15pct_boolean) e15 += 1;
  }
  return {
    tokens: tokens.size,
    simulations: rows.length,
    executable5pct: e5,
    executable10pct: e10,
    executable15pct: e15,
  };
}
