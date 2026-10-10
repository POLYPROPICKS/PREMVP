// Research-only settlement, 1u economics and executable SELL-path diagnostics for FROZEN paper BET decisions.
// DBClone-only, read-only: derives results from research_inplay_paper_decisions + research_inplay_core_path_observations
// and the canonical provider resolver. Never mutates a decision, never touches money-path, Ireland or serving code.
// Pure functions (no I/O) plus a bounded read-only runner at the bottom of the file.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GammaMarket } from "../feed/resolveSignalOutcome";
import { classifySiblingSettlement, type SiblingSettlementState } from "../modeling/t10-offpolicy/siblingOffPolicy";
import { DECISION_TABLE, OBSERVATION_TABLE } from "./inplayPaperDecisions";

export const SETTLEMENT_REPORT_VERSION = "INPLAY_PAPER_SETTLEMENT_V1";
export const SUPPORTED_MARKET_FAMILY = "MONEYLINE";
/** Band the telemetry collector used for exit depth / exit VWAP (computeExecutableExit slippage, computeDepthWithinPct). */
export const COLLECTOR_EXIT_BAND_PCT = 0.02;
export const SELL_MULTIPLES = [2, 3, 5] as const;
export type SellMultiple = (typeof SELL_MULTIPLES)[number];

const EPS = 1e-9;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ───────────────────────────── inputs ─────────────────────────────
export type FrozenBet = {
  decision_id: string; strategy_id: string; physical_event_id: string; provider_game_id?: string | null;
  condition_id: string | null; token_id: string | null; side: string | null; market_family: string | null; market_slug?: string | null;
  entry_vwap: number | null; entry_quantity: number | null; entry_notional_usd: number | null;
  entry_fee_usd?: number | null; entry_fee_state?: string | null;
  observed_at: string | null; provenance_class: string | null; source_observation_id: string | null;
};

export type SellObservation = {
  id: string; physical_event_id: string; condition_id: string; token_id: string; observed_at: string;
  event_live_status: string; orderbook_fetch_status: string;
  best_bid: number | null; mid_price: number | null; bid_depth_relevant_usd: number | null;
  full_stake_shares: number | null; full_stake_exit_vwap: number | null; full_stake_exit_fully_filled: boolean | null;
};

// ───────────────────────────── PART A/B: settlement + 1u economics ─────────────────────────────
export type Outcome = "WIN" | "LOSS" | "VOID" | "OPEN";
/** First broken edge of Frozen BET -> physical game -> market/condition -> token -> terminal outcome. */
export type MappingEdge =
  | "NONE" | "DECISION_TO_TOKEN" | "GAME_TO_MARKET" | "MARKET_TO_CONDITION" | "CONDITION_TO_GAME" | "MARKET_TO_TOKEN"
  | "TOKEN_TO_OUTCOME" | "UNSUPPORTED_MARKET_FAMILY" | "ENTRY_PRICE_INVALID";

export type PositionSettlement = {
  decision_id: string; strategy_id: string; physical_event_id: string; condition_id: string | null; token_id: string | null;
  provenance_class: string | null;
  outcome: Outcome; reason: string; broken_edge: MappingEdge; winning_token_id: string | null;
  entry_vwap: number | null;
  /** Per 1u virtual stake. null while OPEN or entry price invalid. */
  gross_pnl_u: number | null;
  /** Always null: no actual fill => no actual fee authority. See entry_fee_schedule_per_1u for reference only. */
  net_pnl_u: null;
  net_pnl_status: "UNKNOWN_NO_ACTUAL_FEE_AUTHORITY";
  entry_fee_schedule_per_1u: number | null;
};

const EDGE_BY_SETTLEMENT: Record<string, MappingEdge> = {
  NO_EXACT_IDENTITY: "DECISION_TO_TOKEN", NO_PROVIDER_MARKET: "GAME_TO_MARKET", NOT_RESOLVED_BY_RUN: "GAME_TO_MARKET",
  LOOKUP_FAILED: "GAME_TO_MARKET", PROVIDER_CONDITION_MISMATCH: "MARKET_TO_CONDITION", TOKEN_NOT_IN_PROVIDER_MARKET: "MARKET_TO_TOKEN",
  MARKET_OPEN: "TOKEN_TO_OUTCOME", CLOSED_WITHOUT_SINGLE_WINNER: "TOKEN_TO_OUTCOME", UNRESOLVED_OTHER: "TOKEN_TO_OUTCOME",
};

/** WIN: 1/vwap - 1. LOSS: -1. VOID: 0. Anything else (OPEN) has no PnL. */
export function grossPnlU(outcome: Outcome, entryVwap: number | null): number | null {
  if (outcome === "LOSS") return -1;
  if (outcome === "VOID") return 0;
  if (outcome === "WIN") return finite(entryVwap) && entryVwap > 0 && entryVwap < 1 ? r6(1 / entryVwap - 1) : null;
  return null;
}

const open = (bet: FrozenBet, reason: string, edge: MappingEdge): PositionSettlement => base(bet, "OPEN", reason, edge, null);
function base(bet: FrozenBet, outcome: Outcome, reason: string, edge: MappingEdge, winningTokenId: string | null): PositionSettlement {
  const v = finite(bet.entry_vwap) ? bet.entry_vwap : null;
  const pnl = grossPnlU(outcome, v);
  // A settled WIN with an unusable entry price must not pretend to have a PnL: it stays OPEN with an exact reason.
  if (outcome === "WIN" && pnl === null) return { ...base(bet, "OPEN", "ENTRY_PRICE_INVALID", "ENTRY_PRICE_INVALID", winningTokenId) };
  const feeUsd = finite(bet.entry_fee_usd) && bet.entry_fee_state === "KNOWN" ? bet.entry_fee_usd : null;
  const notional = finite(bet.entry_notional_usd) && bet.entry_notional_usd > 0 ? bet.entry_notional_usd : null;
  return {
    decision_id: bet.decision_id, strategy_id: bet.strategy_id, physical_event_id: bet.physical_event_id, condition_id: bet.condition_id,
    token_id: bet.token_id, provenance_class: bet.provenance_class, outcome, reason, broken_edge: edge, winning_token_id: winningTokenId,
    entry_vwap: v, gross_pnl_u: outcome === "OPEN" ? null : pnl, net_pnl_u: null, net_pnl_status: "UNKNOWN_NO_ACTUAL_FEE_AUTHORITY",
    entry_fee_schedule_per_1u: feeUsd !== null && notional !== null ? r6(feeUsd / notional) : null,
  };
}

/**
 * Exact token-level settlement of ONE frozen BET. `market` is the provider market fetched BY ITS CONDITION ID.
 * `conditionEvents` lists every physical event that frozen BETs attribute to that condition: more than one means the
 * game->market edge is ambiguous and the position stays OPEN. Never infers from price drift, titles or scores.
 */
export function settlePosition(bet: FrozenBet, market: GammaMarket | null, conditionEvents: ReadonlySet<string>): PositionSettlement {
  if (bet.market_family !== SUPPORTED_MARKET_FAMILY) return open(bet, `MARKET_FAMILY_${bet.market_family ?? "NULL"}_UNSUPPORTED`, "UNSUPPORTED_MARKET_FAMILY");
  if (!bet.condition_id || !bet.token_id) return open(bet, "NO_EXACT_IDENTITY", "DECISION_TO_TOKEN");
  if (!finite(bet.entry_vwap) || bet.entry_vwap <= 0 || bet.entry_vwap >= 1) return open(bet, "ENTRY_PRICE_INVALID", "ENTRY_PRICE_INVALID");
  if (conditionEvents.size > 1) return open(bet, "CONDITION_ATTRIBUTED_TO_MULTIPLE_PHYSICAL_EVENTS", "CONDITION_TO_GAME");
  const s = classifySiblingSettlement({ conditionId: bet.condition_id, tokenId: bet.token_id, market });
  const map: Partial<Record<SiblingSettlementState, Outcome>> = { SETTLED_WIN: "WIN", SETTLED_LOSS: "LOSS", VOID_PUSH: "VOID" };
  const outcome = map[s.state];
  if (outcome) return base(bet, outcome, s.reason, "NONE", s.winningTokenId);
  return open(bet, s.reason, EDGE_BY_SETTLEMENT[s.reason] ?? "TOKEN_TO_OUTCOME");
}

/** Idempotent: the same decision_id appearing twice (replay, overlapping pages) is counted once. */
export function dedupeBets(bets: readonly FrozenBet[]): FrozenBet[] {
  const seen = new Map<string, FrozenBet>();
  for (const b of bets) if (!seen.has(b.decision_id)) seen.set(b.decision_id, b);
  return [...seen.values()].sort((a, b) => (a.decision_id < b.decision_id ? -1 : 1));
}

export function conditionEventIndex(bets: readonly FrozenBet[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const b of bets) {
    if (!b.condition_id) continue;
    const key = b.condition_id.toLowerCase();
    const s = m.get(key) ?? new Set<string>();
    s.add(b.physical_event_id); m.set(key, s);
  }
  return m;
}

export type EconomicsBlock = {
  positions_n: number; settled_n: number; open_n: number; win_n: number; loss_n: number; void_n: number;
  /** Sum of per-1u gross PnL over settled positions. null when nothing settled. */
  gross_pnl_u: number | null;
  /** gross_pnl_u / settled_n (each settled position is a 1u stake). null when nothing settled. OPEN excluded. */
  settled_roi: number | null;
  net_pnl_status: "UNKNOWN_NO_ACTUAL_FEE_AUTHORITY";
};

export function economics(rows: readonly PositionSettlement[]): EconomicsBlock {
  const settled = rows.filter((r) => r.outcome !== "OPEN" && r.gross_pnl_u !== null);
  const gross = settled.reduce((a, r) => a + (r.gross_pnl_u as number), 0);
  return {
    positions_n: rows.length, settled_n: settled.length, open_n: rows.length - settled.length,
    win_n: settled.filter((r) => r.outcome === "WIN").length, loss_n: settled.filter((r) => r.outcome === "LOSS").length,
    void_n: settled.filter((r) => r.outcome === "VOID").length,
    gross_pnl_u: settled.length ? r6(gross) : null, settled_roi: settled.length ? r6(gross / settled.length) : null,
    net_pnl_status: "UNKNOWN_NO_ACTUAL_FEE_AUTHORITY",
  };
}

/** DELAYED_PAPER must never be blended with LIVE_PROSPECTIVE (or TIMING_UNPROVEN). */
export function economicsByProvenance(rows: readonly PositionSettlement[]): Record<string, EconomicsBlock> {
  const out: Record<string, EconomicsBlock> = {};
  for (const cls of [...new Set(rows.map((r) => r.provenance_class ?? "UNCLASSIFIED"))].sort())
    out[cls] = economics(rows.filter((r) => (r.provenance_class ?? "UNCLASSIFIED") === cls));
  return out;
}

export function economicsByStrategy(rows: readonly PositionSettlement[]): Record<string, EconomicsBlock> {
  const out: Record<string, EconomicsBlock> = {};
  for (const id of [...new Set(rows.map((r) => r.strategy_id))].sort()) out[id] = economics(rows.filter((r) => r.strategy_id === id));
  return out;
}

/**
 * Physical-game view: several controls betting the same game are correlated, so the independent unit is the game.
 * A game's net is the sum of its settled positions; a game with any OPEN position is itself OPEN for this view.
 */
export function economicsByPhysicalGame(rows: readonly PositionSettlement[]) {
  const games = new Map<string, PositionSettlement[]>();
  for (const r of rows) { const g = games.get(r.physical_event_id); if (g) g.push(r); else games.set(r.physical_event_id, [r]); }
  let settledGames = 0, openGames = 0, gross = 0, stakes = 0;
  for (const g of games.values()) {
    if (g.some((r) => r.outcome === "OPEN")) { openGames++; continue; }
    settledGames++; gross += g.reduce((a, r) => a + (r.gross_pnl_u as number), 0); stakes += g.length;
  }
  return {
    games_n: games.size, settled_games_n: settledGames, open_games_n: openGames,
    gross_pnl_u: settledGames ? r6(gross) : null, settled_roi: settledGames ? r6(gross / stakes) : null,
  };
}

// ───────────────────────────── PART C: executable SELL path ─────────────────────────────
export type HitStatus = "HIT" | "NOT_REACHED_AT_SAMPLES" | "IMPOSSIBLE_PRICE_CAP" | "UNDETERMINED_DEPTH" | "NO_SUBSEQUENT_SAMPLES";
export type MultipleResult = { status: HitStatus; first_hit_at: string | null; time_to_hit_s: number | null; first_hit_observation_id: string | null };

export type SellPathResult = {
  decision_id: string; token_id: string; entry_quantity: number; entry_notional_usd: number;
  /** Observations strictly after the frozen entry observation, same exact token+condition, orderbook SUCCESS. */
  subsequent_samples_n: number; excluded_samples_n: number;
  /** A sample proved the WHOLE entry quantity sellable inside the collector exit band. */
  full_position_exit_proven: boolean;
  max_sellable_fraction_proven: number | null;
  /** Largest PROVEN lower bound of full-quantity SELL proceeds (gross of any exit fee). Not a realized profit. */
  max_proven_sell_value_usd: number | null;
  /** Context only, NOT executable: entry_quantity x best_bid ignores depth. */
  max_best_bid_upper_bound_usd: number | null;
  /** max_proven_sell_value_usd / entry_notional_usd: conservative full-position return multiple. null when nothing proven. */
  max_proven_return_multiple: number | null;
  /** Exit-fee authority is never available for a paper position: proceeds above are gross of any exit fee. */
  exit_fee_authority: "UNKNOWN_PROCEEDS_GROSS_OF_EXIT_FEE";
  multiples: Record<`x${SellMultiple}`, MultipleResult>;
  max_gap_between_samples_s: number | null;
  sampling_caveat: "SPARSE_SAMPLES_NO_CONTINUOUS_WINDOW_DURATION_CLAIM";
};

/**
 * Per-sample proof about selling `qty` shares of the exact token. Only conservative, depth-aware bounds are produced;
 * midpoint, last trade and a bare best bid are never treated as an executable full-quantity price.
 *  - exit-VWAP proof: the collector's own sell of obs.full_stake_shares filled inside the band at exit_vwap. Selling
 *    FEWER shares can only average a higher price, so shares >= qty proves proceeds >= qty * exit_vwap.
 *  - depth proof: bid_depth_relevant_usd is sum(price*size) over bids priced >= (1-band)*mid, every price <= best_bid,
 *    so the band holds at least depth/best_bid shares, each priced >= (1-band)*mid.
 */
export function sampleSellProof(qty: number, o: SellObservation): { fraction: number; lowerBoundUsd: number | null; upperBoundUsd: number | null } {
  let fraction = 0;
  let lower: number | null = null;
  const consider = (f: number, value: number | null) => {
    fraction = Math.max(fraction, Math.min(1, f));
    if (f >= 1 - EPS && value !== null) lower = Math.max(lower ?? 0, value);
  };
  const filled = o.full_stake_exit_fully_filled === true;
  if (filled && finite(o.full_stake_exit_vwap) && o.full_stake_exit_vwap > 0 && o.full_stake_exit_vwap <= 1 && finite(o.full_stake_shares) && o.full_stake_shares > 0)
    consider(o.full_stake_shares / qty, qty * o.full_stake_exit_vwap);
  if (finite(o.best_bid) && o.best_bid > 0 && finite(o.mid_price) && o.mid_price > 0 && finite(o.bid_depth_relevant_usd) && o.bid_depth_relevant_usd >= 0) {
    const sharesAtLeast = o.bid_depth_relevant_usd / o.best_bid;
    consider(sharesAtLeast / qty, qty * (1 - COLLECTOR_EXIT_BAND_PCT) * o.mid_price);
  }
  return { fraction: r6(fraction), lowerBoundUsd: lower === null ? null : r6(lower), upperBoundUsd: finite(o.best_bid) && o.best_bid >= 0 ? r6(qty * o.best_bid) : null };
}

export function evaluateSellPath(bet: FrozenBet, observations: readonly SellObservation[]): SellPathResult | null {
  const qty = bet.entry_quantity, notional = bet.entry_notional_usd, entryAt = ms(bet.observed_at);
  if (!bet.token_id || !bet.condition_id || !finite(qty) || qty <= 0 || !finite(notional) || notional <= 0 || !Number.isFinite(entryAt)) return null;
  const vwap = bet.entry_vwap;
  const samples: SellObservation[] = [];
  const seen = new Set<string>();
  let excluded = 0;
  for (const o of [...observations].sort((a, b) => ms(a.observed_at) - ms(b.observed_at) || (a.id < b.id ? -1 : 1))) {
    if (seen.has(o.id)) continue; // idempotent over overlapping pages
    seen.add(o.id);
    const exact = o.token_id === bet.token_id && o.condition_id.toLowerCase() === bet.condition_id.toLowerCase() && o.physical_event_id === bet.physical_event_id;
    // LIVE-only: a post-game (non-LIVE) book prices a known result and is never a hypothetical exit.
    if (!exact || !(ms(o.observed_at) > entryAt) || o.orderbook_fetch_status !== "SUCCESS" || o.event_live_status !== "LIVE") { excluded++; continue; }
    samples.push(o);
  }
  const multiples = {} as Record<`x${SellMultiple}`, MultipleResult>;
  const proofs = samples.map((o) => ({ o, p: sampleSellProof(qty, o) }));
  for (const n of SELL_MULTIPLES) {
    const target = n * notional;
    const none = (status: HitStatus): MultipleResult => ({ status, first_hit_at: null, time_to_hit_s: null, first_hit_observation_id: null });
    if (finite(vwap) && n * vwap > 1 + EPS) { multiples[`x${n}`] = none("IMPOSSIBLE_PRICE_CAP"); continue; }
    const hit = proofs.find(({ p }) => p.lowerBoundUsd !== null && p.lowerBoundUsd >= target - EPS);
    if (hit) { multiples[`x${n}`] = { status: "HIT", first_hit_at: new Date(ms(hit.o.observed_at)).toISOString(), time_to_hit_s: Math.round((ms(hit.o.observed_at) - entryAt) / 1000), first_hit_observation_id: hit.o.id }; continue; }
    if (!proofs.length) { multiples[`x${n}`] = none("NO_SUBSEQUENT_SAMPLES"); continue; }
    const everRoom = proofs.some(({ p }) => p.upperBoundUsd === null || p.upperBoundUsd >= target - EPS);
    multiples[`x${n}`] = none(everRoom ? "UNDETERMINED_DEPTH" : "NOT_REACHED_AT_SAMPLES");
  }
  const gaps = proofs.slice(1).map((x, i) => (ms(x.o.observed_at) - ms(proofs[i].o.observed_at)) / 1000);
  const lowers = proofs.map((x) => x.p.lowerBoundUsd).filter((v): v is number => v !== null);
  const uppers = proofs.map((x) => x.p.upperBoundUsd).filter((v): v is number => v !== null);
  return {
    decision_id: bet.decision_id, token_id: bet.token_id, entry_quantity: qty, entry_notional_usd: notional,
    subsequent_samples_n: proofs.length, excluded_samples_n: excluded,
    full_position_exit_proven: proofs.some(({ p }) => p.fraction >= 1 - EPS),
    max_sellable_fraction_proven: proofs.length ? Math.max(...proofs.map((x) => x.p.fraction)) : null,
    max_proven_sell_value_usd: lowers.length ? Math.max(...lowers) : null,
    max_best_bid_upper_bound_usd: uppers.length ? Math.max(...uppers) : null,
    max_proven_return_multiple: lowers.length ? r6(Math.max(...lowers) / notional) : null,
    exit_fee_authority: "UNKNOWN_PROCEEDS_GROSS_OF_EXIT_FEE",
    multiples, max_gap_between_samples_s: gaps.length ? Math.max(...gaps) : null,
    sampling_caveat: "SPARSE_SAMPLES_NO_CONTINUOUS_WINDOW_DURATION_CLAIM",
  };
}

export function sellPathSummary(rows: readonly (SellPathResult | null)[]) {
  const have = rows.filter((r): r is SellPathResult => r !== null);
  const hits = (n: SellMultiple) => have.filter((r) => r.multiples[`x${n}`].status === "HIT").length;
  const count = (n: SellMultiple, s: HitStatus) => have.filter((r) => r.multiples[`x${n}`].status === s).length;
  return {
    positions_n: rows.length, evaluable_n: have.length, full_position_exit_proven_n: have.filter((r) => r.full_position_exit_proven).length,
    executable_x2_n: hits(2), executable_x3_n: hits(3), executable_x5_n: hits(5),
    impossible_price_cap: { x2: count(2, "IMPOSSIBLE_PRICE_CAP"), x3: count(3, "IMPOSSIBLE_PRICE_CAP"), x5: count(5, "IMPOSSIBLE_PRICE_CAP") },
    undetermined_depth: { x2: count(2, "UNDETERMINED_DEPTH"), x3: count(3, "UNDETERMINED_DEPTH"), x5: count(5, "UNDETERMINED_DEPTH") },
    caveat: "DESCRIPTIVE_DIAGNOSTIC_NOT_REALIZED_PROFIT",
  };
}

// ───────────────────────────── bounded read-only runner ─────────────────────────────
export const BET_PAGE_SIZE = 200;
export const OBS_PAGE_SIZE = 500;
export const MAX_OBS_PAGES_PER_BET = 4;
/** Half-open UTC-day window on the decision's admission_observed_at: [from, to). Both ISO strings. */
export type UtcWindow = { from: string; to: string } | null;
export function utcDayWindow(day: string): UtcWindow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) throw new Error(`INPLAY_SETTLEMENT_BAD_UTC_DAY:${day}`);
  const from = new Date(`${day}T00:00:00.000Z`);
  return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() };
}
const BET_COLUMNS = "decision_id,strategy_id,physical_event_id,provider_game_id,condition_id,token_id,side,market_family,market_slug,entry_vwap,entry_quantity,entry_notional_usd,entry_fee_usd,entry_fee_state,observed_at,provenance_class,source_observation_id";
const OBS_COLUMNS = "id,physical_event_id,condition_id,token_id,observed_at,event_live_status,orderbook_fetch_status,best_bid,mid_price,bid_depth_relevant_usd,full_stake_shares,full_stake_exit_vwap,full_stake_exit_fully_filled";

function fail(stage: string, error: { message: string } | null) { if (error) throw new Error(`INPLAY_SETTLEMENT_${stage}:${error.message}`); }
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toBet(r: Record<string, unknown>): FrozenBet {
  return { ...(r as unknown as FrozenBet), entry_vwap: num(r.entry_vwap), entry_quantity: num(r.entry_quantity), entry_notional_usd: num(r.entry_notional_usd), entry_fee_usd: num(r.entry_fee_usd) };
}
function toObs(r: Record<string, unknown>): SellObservation {
  return { ...(r as unknown as SellObservation), best_bid: num(r.best_bid), mid_price: num(r.mid_price), bid_depth_relevant_usd: num(r.bid_depth_relevant_usd),
    full_stake_shares: num(r.full_stake_shares), full_stake_exit_vwap: num(r.full_stake_exit_vwap) };
}

export type SettlementReport = ReturnType<typeof buildSettlementReport>;

export function buildSettlementReport(input: { bets: readonly FrozenBet[]; markets: ReadonlyMap<string, GammaMarket | null>; observationsByDecision: ReadonlyMap<string, readonly SellObservation[]> }) {
  const bets = dedupeBets(input.bets);
  const index = conditionEventIndex(bets);
  const positions = bets.map((b) => settlePosition(b, b.condition_id ? input.markets.get(b.condition_id.toLowerCase()) ?? null : null, index.get((b.condition_id ?? "").toLowerCase()) ?? new Set()));
  const sell = bets.map((b) => evaluateSellPath(b, input.observationsByDecision.get(b.decision_id) ?? []));
  const missing = positions.filter((p) => p.outcome === "OPEN");
  const reasons: Record<string, number> = {};
  for (const p of missing) { const k = `${p.broken_edge}:${p.reason}`; reasons[k] = (reasons[k] ?? 0) + 1; }
  return {
    version: SETTLEMENT_REPORT_VERSION, settlement_source: "PROVIDER_GAMMA_CLOB_MARKET_CLOSED_SINGLE_OUTCOME_GTE_0.99_VIA_EXISTING_RESOLVER_BY_CONDITION_ID_AND_EXACT_TOKEN",
    economics: economics(positions), by_provenance: economicsByProvenance(positions), by_strategy: economicsByStrategy(positions),
    by_physical_game: economicsByPhysicalGame(positions), missing_outcome_reasons: reasons,
    sell_path: sellPathSummary(sell), positions, sell_paths: sell.filter((s): s is SellPathResult => s !== null),
    disclaimer: "VIRTUAL_1U_PAPER_ECONOMICS_NOT_EXCHANGE_FILLED_PROFIT",
  };
}

/** Frozen BET rows only (immutable after freeze); WAITING/SKIP are never read. Read-only. */
export async function readFrozenBets(db: SupabaseClient, window: UtcWindow = null): Promise<FrozenBet[]> {
  const out: FrozenBet[] = [];
  for (let from = 0; ; from += BET_PAGE_SIZE) {
    let sel = db.from(DECISION_TABLE).select(BET_COLUMNS).eq("status", "BET");
    if (window) sel = sel.gte("admission_observed_at", window.from).lt("admission_observed_at", window.to);
    const q = await sel.order("decision_id", { ascending: true }).range(from, from + BET_PAGE_SIZE - 1);
    fail("BET_READ", q.error);
    const page = (q.data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page.map(toBet));
    if (page.length < BET_PAGE_SIZE) return out;
  }
}

/** Index-aligned read (physical_event_id, observed_at) for ONE bet's exact token after its frozen entry observation. */
export async function readSubsequentObservations(db: SupabaseClient, bet: FrozenBet): Promise<SellObservation[]> {
  if (!bet.token_id || !bet.observed_at) return [];
  const out: SellObservation[] = [];
  let cursor = { at: bet.observed_at, id: "00000000-0000-0000-0000-000000000000" };
  for (let page = 0; page < MAX_OBS_PAGES_PER_BET; page++) {
    const q = await db.from(OBSERVATION_TABLE).select(OBS_COLUMNS).eq("physical_event_id", bet.physical_event_id).eq("token_id", bet.token_id)
      .or(`observed_at.gt.${cursor.at},and(observed_at.eq.${cursor.at},id.gt.${cursor.id})`)
      .order("observed_at", { ascending: true }).order("id", { ascending: true }).limit(OBS_PAGE_SIZE);
    fail("OBSERVATION_READ", q.error);
    const rows = ((q.data ?? []) as unknown as Record<string, unknown>[]).map(toObs);
    out.push(...rows);
    if (rows.length < OBS_PAGE_SIZE) break;
    cursor = { at: rows[rows.length - 1].observed_at, id: rows[rows.length - 1].id };
  }
  return out;
}

async function collectInputs(db: SupabaseClient, fetchMarket: (conditionId: string) => Promise<GammaMarket | null>, concurrency: number, window: UtcWindow) {
  const bets = dedupeBets(await readFrozenBets(db, window));
  const conditions = new Map<string, string>(); // lower-cased key -> provider-cased id, one provider lookup per condition
  for (const b of bets) if (b.condition_id && !conditions.has(b.condition_id.toLowerCase())) conditions.set(b.condition_id.toLowerCase(), b.condition_id);
  const markets = new Map<string, GammaMarket | null>();
  const entries = [...conditions];
  for (let i = 0; i < entries.length; i += concurrency)
    await Promise.all(entries.slice(i, i + concurrency).map(async ([key, id]) => { markets.set(key, (await fetchMarket(id)) ?? (await fetchMarket(id))); }));
  const observationsByDecision = new Map<string, SellObservation[]>();
  for (let i = 0; i < bets.length; i += concurrency)
    await Promise.all(bets.slice(i, i + concurrency).map(async (b) => { observationsByDecision.set(b.decision_id, await readSubsequentObservations(db, b)); }));
  return { bets, markets, observationsByDecision };
}

export async function runSettlementReport(db: SupabaseClient, fetchMarket: (conditionId: string) => Promise<GammaMarket | null>, concurrency = 4, window: UtcWindow = null) {
  return buildSettlementReport(await collectInputs(db, fetchMarket, concurrency, window));
}

// ───────────────────────────── daily A/B/C report ─────────────────────────────
export type DecisionRow = { decision_id: string; strategy_id: string; status: string; physical_event_id: string; provenance_class: string | null; admission_observed_at: string | null };
export const STRATEGY_BANDS: Record<string, string> = {
  CONTROL_PRICE_BUCKET_A: "0.48-0.52", CONTROL_PRICE_BUCKET_B: "0.53-0.58", CONTROL_PRICE_BUCKET_C: "0.35-0.44",
};
const DECISION_COLUMNS = "decision_id,strategy_id,status,physical_event_id,provenance_class,admission_observed_at";

/** Frozen decision counts per strategy. Counted per decision row; physical games are the independent unit. Read-only, aggregated in-process. */
export function strategyDecisionSummary(rows: readonly DecisionRow[]) {
  const uniq = [...new Map(rows.map((r) => [r.decision_id, r])).values()];
  const out: Record<string, unknown> = {};
  for (const id of [...new Set(uniq.map((r) => r.strategy_id))].sort()) {
    const mine = uniq.filter((r) => r.strategy_id === id);
    const n = (st: string) => mine.filter((r) => r.status === st).length;
    const bets = mine.filter((r) => r.status === "BET");
    const prov: Record<string, number> = {};
    for (const r of bets) { const k = r.provenance_class ?? "UNCLASSIFIED"; prov[k] = (prov[k] ?? 0) + 1; }
    out[id] = {
      price_band_entry_vwap: STRATEGY_BANDS[id] ?? "UNKNOWN_STRATEGY_BAND", bet_n: n("BET"), skip_n: n("SKIP"), waiting_n: n("WAITING"),
      distinct_games: new Set(mine.map((r) => r.physical_event_id)).size, distinct_games_with_bet: new Set(bets.map((r) => r.physical_event_id)).size,
      bet_provenance: Object.fromEntries(Object.entries(prov).sort()),
    };
  }
  return out;
}

/** Explicit missing-authority flags. Absence of evidence is reported as a count, never as zero cost or zero return. */
export function missingEvidence(bets: readonly FrozenBet[], positions: readonly PositionSettlement[], sell: readonly (SellPathResult | null)[]) {
  const edge = (...e: MappingEdge[]) => positions.filter((p) => e.includes(p.broken_edge)).length;
  return {
    fees_unknown_n: bets.filter((b) => !(b.entry_fee_state === "KNOWN" && finite(b.entry_fee_usd))).length,
    exit_fees_unknown_n: bets.length, // exit fee authority never exists for a paper position
    settlement_unavailable_n: positions.filter((p) => p.outcome === "OPEN").length,
    snapshot_delayed_n: bets.filter((b) => b.provenance_class === "DELAYED_PAPER").length,
    timing_unproven_n: bets.filter((b) => b.provenance_class !== "DELAYED_PAPER" && b.provenance_class !== "LIVE_PROSPECTIVE").length,
    insufficient_depth_n: sell.filter((s) => s !== null && !s.full_position_exit_proven).length,
    ambiguous_market_identity_n: edge("CONDITION_TO_GAME", "MARKET_TO_CONDITION", "GAME_TO_MARKET", "UNSUPPORTED_MARKET_FAMILY"),
    missing_token_linkage_n: edge("DECISION_TO_TOKEN", "MARKET_TO_TOKEN"),
    missing_executable_exit_n: sell.filter((s) => s === null || !s.full_position_exit_proven).length,
    unevaluable_sell_path_n: sell.filter((s) => s === null).length,
  };
}

export function independenceBlock(positions: readonly PositionSettlement[]) {
  const g = economicsByPhysicalGame(positions);
  return {
    unique_physical_games: g.games_n, correlated_token_observations: positions.length, independent_settled_games: g.settled_games_n,
    sample_limitation: g.settled_games_n < 30 ? "SAMPLE_TOO_SMALL_NO_ALPHA_INFERENCE" : "SAMPLE_SIZE_NOT_THE_BINDING_LIMIT_FEES_STILL_UNKNOWN",
  };
}

export function buildDailyReport(input: { window: UtcWindow; decisions: readonly DecisionRow[]; bets: readonly FrozenBet[]; markets: ReadonlyMap<string, GammaMarket | null>; observationsByDecision: ReadonlyMap<string, readonly SellObservation[]> }) {
  const bets = dedupeBets(input.bets);
  const core = buildSettlementReport({ bets, markets: input.markets, observationsByDecision: input.observationsByDecision });
  const sell = bets.map((b) => evaluateSellPath(b, input.observationsByDecision.get(b.decision_id) ?? []));
  return {
    report: "INPLAY_PAPER_DAILY_ECONOMICS_V1",
    utc_window_half_open_on_admission_observed_at: input.window ?? "ALL_FROZEN_DECISIONS_NO_DAY_FILTER",
    decision_timestamp_authority: "FROZEN_AT_AND_OBSERVED_AT_FROM_research_inplay_paper_decisions_IMMUTABLE",
    data_provenance: "DBClone nppznoujvnyjargjkmnv, research_inplay_paper_decisions + research_inplay_core_path_observations, provider settlement via existing resolver",
    strategies: strategyDecisionSummary(input.decisions),
    settlement: core.economics, settlement_by_strategy: core.by_strategy, settlement_by_provenance: core.by_provenance,
    independence: independenceBlock(core.positions),
    executable_exits: core.sell_path, missing_evidence: missingEvidence(bets, core.positions, sell),
    missing_outcome_reasons: core.missing_outcome_reasons, positions: core.positions, sell_paths: core.sell_paths,
    disclaimer: core.disclaimer,
  };
}

export async function readDecisionRows(db: SupabaseClient, window: UtcWindow = null): Promise<DecisionRow[]> {
  const out: DecisionRow[] = [];
  for (let from = 0; ; from += BET_PAGE_SIZE * 5) {
    let sel = db.from(DECISION_TABLE).select(DECISION_COLUMNS);
    if (window) sel = sel.gte("admission_observed_at", window.from).lt("admission_observed_at", window.to);
    const q = await sel.order("decision_id", { ascending: true }).range(from, from + BET_PAGE_SIZE * 5 - 1);
    fail("DECISION_READ", q.error);
    const page = (q.data ?? []) as unknown as DecisionRow[];
    out.push(...page);
    if (page.length < BET_PAGE_SIZE * 5) return out;
  }
}

export async function runDailyReport(db: SupabaseClient, fetchMarket: (conditionId: string) => Promise<GammaMarket | null>, window: UtcWindow = null) {
  const decisions = await readDecisionRows(db, window);
  return buildDailyReport({ window, decisions, ...(await collectInputs(db, fetchMarket, 4, window)) });
}
