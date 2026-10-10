/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  settlePosition, grossPnlU, economics, economicsByProvenance, economicsByPhysicalGame, dedupeBets, conditionEventIndex,
  sampleSellProof, evaluateSellPath, sellPathSummary, buildSettlementReport, readSubsequentObservations,
  type FrozenBet, type SellObservation, type PositionSettlement,
} from "../../lib/research/inplayPaperSettlement";

const WIN_TOKEN = "tok-win", LOSE_TOKEN = "tok-lose";
const market = (o: Partial<{ conditionId: string; closed: boolean; outcomePrices: string; clobTokenIds: string }> = {}) => ({
  conditionId: "0xC1", closed: true, outcomes: JSON.stringify(["A", "B"]), outcomePrices: JSON.stringify(["1", "0"]),
  clobTokenIds: JSON.stringify([WIN_TOKEN, LOSE_TOKEN]), ...o,
});
let n = 0;
const bet = (o: Partial<FrozenBet> = {}): FrozenBet => ({
  decision_id: `d${++n}`, strategy_id: "CONTROL_PRICE_BUCKET_A", physical_event_id: "ev1", condition_id: "0xc1", token_id: WIN_TOKEN, side: "A",
  market_family: "MONEYLINE", entry_vwap: 0.5, entry_quantity: 5, entry_notional_usd: 2.5, entry_fee_usd: 0.0625, entry_fee_state: "KNOWN",
  observed_at: "2026-10-10T08:00:00.000Z", provenance_class: "DELAYED_PAPER", source_observation_id: "src", ...o,
});
const settle = (b: FrozenBet, m: any) => settlePosition(b, m, new Set([b.physical_event_id]));

test("WIN: 1/vwap-1, exact token", () => {
  const r = settle(bet({ entry_vwap: 0.4 }), market());
  assert.equal(r.outcome, "WIN"); assert.equal(r.gross_pnl_u, 1.5); assert.equal(r.broken_edge, "NONE"); assert.equal(r.winning_token_id, WIN_TOKEN);
});
test("LOSS: -1u and the sibling token of the same condition is settled independently", () => {
  const r = settle(bet({ token_id: LOSE_TOKEN }), market());
  assert.equal(r.outcome, "LOSS"); assert.equal(r.gross_pnl_u, -1); assert.equal(r.winning_token_id, WIN_TOKEN);
});
test("VOID: closed 50/50 refund is 0u", () => {
  const r = settle(bet(), market({ outcomePrices: JSON.stringify(["0.5", "0.5"]) }));
  assert.equal(r.outcome, "VOID"); assert.equal(r.gross_pnl_u, 0);
});
test("unresolved outcomes stay OPEN with the first broken edge, never a loss", () => {
  const openMarket = settle(bet(), market({ closed: false, outcomePrices: JSON.stringify(["0.99", "0.01"]) }));
  assert.equal(openMarket.outcome, "OPEN"); assert.equal(openMarket.gross_pnl_u, null); assert.equal(openMarket.broken_edge, "TOKEN_TO_OUTCOME");
  assert.equal(settle(bet(), market({ outcomePrices: JSON.stringify(["0.97", "0.03"]) })).outcome, "OPEN"); // price near 1 is not settlement
  assert.equal(settle(bet(), market({ outcomePrices: JSON.stringify(["1", "1"]) })).outcome, "OPEN"); // two winners
  const lookup = settle(bet(), null);
  assert.equal(lookup.outcome, "OPEN"); assert.equal(lookup.broken_edge, "GAME_TO_MARKET");
  assert.equal(settle(bet(), market({ conditionId: "0xother" })).broken_edge, "MARKET_TO_CONDITION");
  assert.equal(settle(bet({ token_id: "tok-unknown" }), market()).broken_edge, "MARKET_TO_TOKEN");
  assert.equal(settle(bet({ token_id: null }), market()).broken_edge, "DECISION_TO_TOKEN");
  assert.equal(settle(bet({ market_family: "TOTALS" }), market()).broken_edge, "UNSUPPORTED_MARKET_FAMILY");
  assert.equal(settle(bet({ entry_vwap: 1 }), market()).broken_edge, "ENTRY_PRICE_INVALID");
});
test("one condition attributed to two physical events is ambiguous: OPEN", () => {
  const a = bet({ physical_event_id: "ev1" }), b = bet({ physical_event_id: "ev2" });
  const idx = conditionEventIndex([a, b]);
  const r = settlePosition(a, market(), idx.get("0xc1")!);
  assert.equal(r.outcome, "OPEN"); assert.equal(r.broken_edge, "CONDITION_TO_GAME");
});
test("grossPnlU is pure and OPEN has none", () => {
  assert.equal(grossPnlU("WIN", 0.5), 1); assert.equal(grossPnlU("LOSS", 0.5), -1); assert.equal(grossPnlU("VOID", 0.5), 0);
  assert.equal(grossPnlU("OPEN", 0.5), null); assert.equal(grossPnlU("WIN", null), null);
});

test("economics: settled ROI excludes OPEN; net PnL is UNKNOWN even with a known entry fee; provenance is never blended", () => {
  const rows: PositionSettlement[] = [
    settle(bet({ entry_vwap: 0.5 }), market()), // +1
    settle(bet({ token_id: LOSE_TOKEN, entry_vwap: 0.4 }), market()), // -1
    settle(bet(), market({ closed: false })), // OPEN
    settle(bet({ provenance_class: "LIVE_PROSPECTIVE", entry_vwap: 0.25 }), market()), // +3
  ];
  const e = economics(rows);
  assert.deepEqual([e.positions_n, e.settled_n, e.open_n, e.win_n, e.loss_n, e.void_n], [4, 3, 1, 2, 1, 0]);
  assert.equal(e.gross_pnl_u, 3); assert.equal(e.settled_roi, 1); assert.equal(e.net_pnl_status, "UNKNOWN_NO_ACTUAL_FEE_AUTHORITY");
  assert.ok(rows.every((r) => r.net_pnl_u === null));
  assert.equal(rows[0].entry_fee_schedule_per_1u, 0.025); // reference only, never subtracted
  const bp = economicsByProvenance(rows);
  assert.equal(bp.DELAYED_PAPER.settled_n, 2); assert.equal(bp.DELAYED_PAPER.gross_pnl_u, 0); assert.equal(bp.LIVE_PROSPECTIVE.gross_pnl_u, 3);
  const empty = economics([settle(bet(), market({ closed: false }))]);
  assert.equal(empty.settled_roi, null); assert.equal(empty.gross_pnl_u, null);
});

test("duplicate physical events: two controls on one game are one independent game; duplicate decision ids collapse", () => {
  const a = bet({ physical_event_id: "evX" }), b = bet({ physical_event_id: "evX", token_id: LOSE_TOKEN }), c = bet({ physical_event_id: "evY" });
  assert.equal(dedupeBets([a, a, b, c, c]).length, 3);
  const rows = [a, b, c].map((x) => settle(x, market()));
  const g = economicsByPhysicalGame(rows);
  assert.equal(g.games_n, 2); assert.equal(g.settled_games_n, 2); assert.equal(g.gross_pnl_u, 1); // evX: +1-1=0, evY: +1
  const withOpen = economicsByPhysicalGame([...rows, settle(bet({ physical_event_id: "evX" }), market({ closed: false }))]);
  assert.equal(withOpen.open_games_n, 1); assert.equal(withOpen.settled_games_n, 1);
});

test("idempotency: identical inputs, replayed or reordered, give an identical report", () => {
  const bets = [bet({ physical_event_id: "e1" }), bet({ physical_event_id: "e2", token_id: LOSE_TOKEN })];
  const markets = new Map([["0xc1", market() as any]]);
  const r1 = buildSettlementReport({ bets, markets, observationsByDecision: new Map() });
  const r2 = buildSettlementReport({ bets: [...bets].reverse().concat(bets), markets, observationsByDecision: new Map() });
  assert.deepEqual(r1, r2);
});

// ───────────────────────────── SELL path ─────────────────────────────
const sobs = (min: number, o: Partial<SellObservation> = {}): SellObservation => ({
  id: `o${++n}`, physical_event_id: "ev1", condition_id: "0xc1", token_id: WIN_TOKEN, observed_at: new Date(Date.parse("2026-10-10T08:00:00.000Z") + min * 60_000).toISOString(),
  event_live_status: "LIVE", orderbook_fetch_status: "SUCCESS", best_bid: 0.5, mid_price: 0.51, bid_depth_relevant_usd: 50,
  full_stake_shares: 5, full_stake_exit_vwap: 0.5, full_stake_exit_fully_filled: true, ...o,
});
const cheap = () => bet({ entry_vwap: 0.2, entry_quantity: 12.5, entry_notional_usd: 2.5 });

test("SELL: executable x2/x3/x5 hit only with full-quantity depth proof; first hit time", () => {
  const b = cheap();
  const obs = [
    sobs(1, { best_bid: 0.45, mid_price: 0.46, bid_depth_relevant_usd: 100, full_stake_exit_vwap: 0.44, full_stake_shares: 20 }), // 12.5*0.44=5.5 -> x2 (5.0) yes, x3 (7.5) no
    sobs(5, { best_bid: 0.7, mid_price: 0.71, bid_depth_relevant_usd: 100, full_stake_exit_vwap: 0.69, full_stake_shares: 20 }), // 8.6 -> x3 yes; x5 (12.5) no
    sobs(9, { best_bid: 1, mid_price: 1, bid_depth_relevant_usd: 100, full_stake_exit_vwap: 1, full_stake_shares: 20 }), // 12.5 -> x5 yes
  ];
  const r = evaluateSellPath(b, obs)!;
  assert.equal(r.multiples.x2.status, "HIT"); assert.equal(r.multiples.x2.time_to_hit_s, 60); assert.equal(r.multiples.x2.first_hit_observation_id, obs[0].id);
  assert.equal(r.multiples.x3.time_to_hit_s, 300); assert.equal(r.multiples.x5.time_to_hit_s, 540);
  assert.equal(r.full_position_exit_proven, true); assert.equal(r.max_sellable_fraction_proven, 1);
  assert.equal(r.max_proven_sell_value_usd, 12.5); assert.equal(r.max_gap_between_samples_s, 240);
  assert.equal(sellPathSummary([r]).executable_x5_n, 1);
});
test("SELL: best bid / midpoint without full-quantity depth is never a hit (depth insufficiency)", () => {
  const b = cheap();
  // best bid 0.9 would be x3+ on 12.5 shares, but only ~1.1 shares are bid and the collector sell did not fill
  const thin = sobs(2, { best_bid: 0.9, mid_price: 0.91, bid_depth_relevant_usd: 1, full_stake_exit_vwap: null, full_stake_exit_fully_filled: false, full_stake_shares: 12.5 });
  const r = evaluateSellPath(b, [thin])!;
  assert.equal(r.multiples.x2.status, "UNDETERMINED_DEPTH"); assert.equal(r.multiples.x3.status, "UNDETERMINED_DEPTH");
  assert.equal(r.full_position_exit_proven, false); assert.equal(r.max_proven_sell_value_usd, null);
  assert.ok(r.max_sellable_fraction_proven! < 0.1); assert.equal(r.max_best_bid_upper_bound_usd, 11.25);
  assert.equal(sellPathSummary([r]).executable_x2_n, 0);
  // a smaller collector sell proof (shares < qty) does not prove the full position either
  const p = sampleSellProof(12.5, sobs(1, { full_stake_shares: 5, full_stake_exit_vwap: 0.9, bid_depth_relevant_usd: 0 }));
  assert.equal(p.fraction, 0.4); assert.equal(p.lowerBoundUsd, null);
});
test("SELL: depth proof alone bounds proceeds by the collector band, not the best bid", () => {
  const p = sampleSellProof(10, sobs(1, { full_stake_exit_vwap: null, full_stake_exit_fully_filled: null, best_bid: 0.5, mid_price: 0.5, bid_depth_relevant_usd: 6 }));
  assert.equal(p.fraction, 1); assert.equal(p.lowerBoundUsd, 4.9); assert.equal(p.upperBoundUsd, 5);
});
test("SELL: price-cap impossibility, no samples, and not-reached are distinguished", () => {
  const b = bet(); // entry 0.5: x2 needs price 1.0 (reachable only at 1), x3/x5 impossible
  const r = evaluateSellPath(b, [sobs(1, { best_bid: 0.4, mid_price: 0.41, bid_depth_relevant_usd: 100, full_stake_exit_vwap: 0.39, full_stake_shares: 6 })])!;
  assert.equal(r.multiples.x2.status, "NOT_REACHED_AT_SAMPLES"); assert.equal(r.multiples.x3.status, "IMPOSSIBLE_PRICE_CAP"); assert.equal(r.multiples.x5.status, "IMPOSSIBLE_PRICE_CAP");
  assert.equal(evaluateSellPath(b, [])!.multiples.x2.status, "NO_SUBSEQUENT_SAMPLES");
});
test("SELL: only exact token+condition+event samples strictly after entry with a successful book count", () => {
  const b = cheap();
  const good = sobs(3, { best_bid: 0.6, mid_price: 0.6, bid_depth_relevant_usd: 100, full_stake_exit_vwap: 0.59, full_stake_shares: 20 });
  const r = evaluateSellPath(b, [
    sobs(0, { best_bid: 0.9, full_stake_exit_vwap: 0.9, full_stake_shares: 20 }), // at the entry instant: excluded
    sobs(-1), sobs(2, { token_id: LOSE_TOKEN }), sobs(2, { condition_id: "0xzzz" }), sobs(2, { physical_event_id: "evOther" }),
    sobs(2, { orderbook_fetch_status: "FAILED" }), good, good, // duplicate id collapses
  ])!;
  assert.equal(r.subsequent_samples_n, 1); assert.equal(r.excluded_samples_n, 6);
  assert.equal(evaluateSellPath(bet({ entry_quantity: null }), [good]), null);
});

test("fees: SELL proceeds are gross of exit fees and no net figure is produced anywhere", () => {
  const rep = buildSettlementReport({ bets: [bet()], markets: new Map([["0xc1", market() as any]]), observationsByDecision: new Map() });
  assert.equal(rep.economics.net_pnl_status, "UNKNOWN_NO_ACTUAL_FEE_AUTHORITY");
  assert.ok(!/"net_pnl_u":\s*[\d-]/.test(JSON.stringify(rep)));
  assert.match(rep.disclaimer, /NOT_EXCHANGE_FILLED/);
});

test("runner is read-only: no write verbs, no production, Ireland or order surface", () => {
  const src = (readFileSync("lib/research/inplayPaperSettlement.ts", "utf8") + readFileSync("scripts/research-inplay-paper-settlement.ts", "utf8"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/\.(insert|update|upsert|delete|rpc)\(/.test(src));
  assert.ok(!/nbnldzfsxffztsfrrxqy|ireland|placeOrder|SUPABASE_URL\b/i.test(src));
  assert.match(src, /nppznoujvnyjargjkmnv/);
});

test("observation reader pages by (observed_at,id) on the exact event+token and stops at a short page", async () => {
  const calls: string[] = [];
  const chain: any = { select: () => chain, eq: (c: string, v: string) => { calls.push(`${c}=${v}`); return chain; }, or: () => chain, order: () => chain, limit: () => Promise.resolve({ data: [{ id: "x", observed_at: "2026-10-10T08:01:00Z", best_bid: "0.5" }], error: null }) };
  const rows = await readSubsequentObservations({ from: () => chain } as any, bet());
  assert.equal(rows.length, 1); assert.equal(rows[0].best_bid, 0.5);
  assert.deepEqual(calls, ["physical_event_id=ev1", `token_id=${WIN_TOKEN}`]);
});
