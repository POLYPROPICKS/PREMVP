// T10_EXACT_MARKET_EXECUTION_EVIDENCE_AND_MONEY_ACTIVATION_V1 / T30_MONEY_GATE_REMOVAL_V1 — focused deterministic tests.
// Live action is decided from the CURRENT T10 book only; T30 is research telemetry and never gates, prices or ranks.
import test from "node:test";
import assert from "node:assert/strict";
import { parseOrderBook } from "../../lib/liquidity/orderbookMath";
import { fetchTokenFeeSchedule, parseTokenFeeSchedule, type TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import {
  decideT10EconomicEvent,
  isT10EconomicActivationOn,
  makerLimitPrice,
  reverifySelectedAction,
  takerFeeUsd,
  takerPriceLimit,
  walkTakerFill,
} from "../../lib/executor/t10EconomicActivation";
import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import { evaluateMakerPlacement } from "../../lib/executor/t10EconomicActionPolicy";
import {
  mapQueueRowToIrelandCandidate,
  primaryMakerSubmissionOpen,
  QUEUE_MAX_ENTRY_PRICE,
  QueueWireContractError,
  readT10FrozenContract,
  validateOrderEventAgainstQueueRow,
  type EventExecutionQueueRow,
  type NightEventReservationRow,
} from "../../lib/executor/executorQueueTypes";
import {
  fallbackPublicationRetryable,
  readExecutionAttempts,
  recordResultAndAuthorizeMaker,
  selectExecutorMakerFallbackCommands,
  deriveT10FallbackLimit,
  type MakerFallbackPort,
} from "../../lib/executor/makerFallbackAuthorization";
import {
  bStrategySupportRegion,
  isBSupportEligible,
  isBSupportFamilyEligible,
  isBSupportPriceInBand,
  type FinalT3MarketObservation,
} from "../../lib/executor/reservationMarketBaseline";

const KICKOFF = "2026-07-19T19:00:00.000Z";
// T-13.5: a decision well before primary_maker_cancel_by (T-1:00) -- valid. The production decision lead is ~T-20
// (LIVE_BETTING_RECOVERY_FINAL_HOTFIX_V2; see liveRecoveryHotfixV2.test.ts); latest entry is event start + 3 minutes.
const NOW = Date.parse("2026-07-19T18:46:30.000Z");
const AFTER_LATEST = Date.parse("2026-07-19T19:03:00.000Z");   // exactly latest_entry (T+3:00): no new entry
const T10_AT = "2026-07-19T18:46:00.000Z";
const T30_AT = "2026-07-19T18:35:00.000Z";
const EVENT = "provider:polymarket:event-1:2026-07-19";
const RES_ID = "res-econ";

type Row = { cond: string; token: string; family: string; type: string; t10: [number | null, number]; t30: [number, number] | null; side?: string };
function obs(r: Row, phase: "T_MINUS_10" | "T_MINUS_30"): FinalT3MarketObservation {
  const [bid, ask] = phase === "T_MINUS_10" ? r.t10 : r.t30!;
  return {
    capture_run_id: `${phase}-run`, reservation_id: RES_ID, physical_event_id: EVENT, provider_event_id: "event-1",
    event_start_iso: KICKOFF, observation_phase: phase, condition_id: r.cond, token_id: r.token, side: r.side ?? "Yes",
    canonical_market_family: r.family, canonical_market_type: r.type, market_slug: r.cond,
    best_bid: bid, best_ask: ask, ask_decimal_odds: 1 / ask, orderbook_fetch_status: "SUCCESS",
    observed_at: phase === "T_MINUS_10" ? T10_AT : T30_AT,
  };
}
const universes = (rows: Row[]) => ({
  t10: rows.map((r) => obs(r, "T_MINUS_10")),
  t30: rows.filter((r) => r.t30).map((r) => obs(r, "T_MINUS_30")),
});

// A: MONEYLINE (generic live candidate; SPREADS is observation-only and has dedicated negative tests below): current bid 0.50 / ask 0.52. With deep ask depth (LIVE) it is a safe TAKER;
// with only $0.52 of ask depth at <= the taker limit (LIVE_A_MAKER) the full stake cannot be taken -> MAKER_FIRST at the bid.
const A: Row = { cond: "a-money", token: "a-token", family: "MONEYLINE", type: "MONEYLINE", t10: [0.50, 0.52], t30: [0.50, 0.52] };
// B: TOTALS (B family priority #4, below MONEYLINE): current ask 0.50 with $5 depth -> safe taker (T30 irrelevant).
const B: Row = { cond: "b-total", token: "b-token", family: "TOTALS", type: "TOTAL", t10: [0.52, 0.53], t30: [0.53, 0.54] };

type Lv = [number, number];
const bookOf = (tokenId: string, bids: Lv[], asks: Lv[], tick: number | null = 0.01, min: number | null = 5): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 3,
  book: { tokenId, bids: bids.map(([price, size]) => ({ price, size })), asks: asks.map(([price, size]) => ({ price, size })),
    tickSize: tick, minimumOrderSize: min, providerTimestampMs: NOW },
});
const LIVE: Record<string, FetchOrderBookResult> = {
  "a-token": bookOf("a-token", [[0.50, 100]], [[0.52, 100]]),
  // Wide raw spread (0.05): telemetry only.
  "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]]),
};
// A with thin ask depth: no full-stake taker fill at <= the taker limit, maker limit = current best bid 0.50.
const A_THIN_ASKS: Lv[] = [[0.52, 1], [0.60, 100]];
const aBook = (min: number | null = 5, tick: number | null = 0.01) => bookOf("a-token", [[0.50, 100]], A_THIN_ASKS, tick, min);
const LIVE_A_MAKER: Record<string, FetchOrderBookResult> = { ...LIVE, "a-token": aBook() };
const fee = (tokenId: string, rate = 0.05): TokenFeeScheduleResult => ({
  ok: true, tokenId, conditionId: null, feesEnabled: true, takerRate: rate, exponent: 1, feeType: "sports_fees_v3",
  formulaVersion: "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1", source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID",
  observedAtIso: new Date(NOW).toISOString(), latencyMs: 1,
});

function deps(books: Record<string, FetchOrderBookResult | ((n: number) => FetchOrderBookResult)> = LIVE, fees: (t: string) => TokenFeeScheduleResult = fee) {
  const calls: string[] = [];
  const counts: Record<string, number> = {};
  return {
    calls,
    fetchExactTokenOrderbook: async (tokenId: string) => {
      calls.push(tokenId);
      counts[tokenId] = (counts[tokenId] ?? 0) + 1;
      const b = books[tokenId];
      return typeof b === "function" ? b(counts[tokenId]) : b ?? { ok: false, tokenId, latencyMs: 1, errorCode: "HTTP_ERROR" };
    },
    fetchTokenFeeSchedule: async (tokenId: string) => fees(tokenId),
  };
}

async function decide(rows: Row[], o: { now?: number; exposure?: boolean; d?: ReturnType<typeof deps> } = {}) {
  const u = universes(rows);
  const d = o.d ?? deps();
  const event = await decideT10EconomicEvent({ physicalEventId: EVENT, eventStartIso: KICKOFF, t10Universe: u.t10, t30Universe: u.t30,
    nowMs: o.now ?? NOW, exposureExists: o.exposure ?? false, deps: d });
  return { event, d };
}

// ── evidence carriers ───────────────────────────────────────────────────────

test("1-3: /book parser preserves the ask ladder, provider tick and min order size", () => {
  const b = parseOrderBook({ asset_id: "t", timestamp: "1791008925012", tick_size: "0.01", min_order_size: "5",
    bids: [{ price: "0.48", size: "10" }], asks: [{ price: "0.53", size: "2" }, { price: "0.51", size: "7" }] }, "t")!;
  assert.deepEqual(b.asks, [{ price: 0.51, size: 7 }, { price: 0.53, size: 2 }]);
  assert.equal(b.tickSize, 0.01);
  assert.equal(b.minimumOrderSize, 5);
  assert.equal(b.providerTimestampMs, 1791008925012);
  const none = parseOrderBook({ asset_id: "t", asks: [], bids: [] }, "t")!;
  assert.equal(none.tickSize, null, "absent tick is null, never assumed");
  assert.equal(none.minimumOrderSize, null);
  assert.equal(parseOrderBook({ asset_id: "t", tick_size: "1", asks: [], bids: [] }, "t")!.tickSize, null);
  assert.equal(parseOrderBook({ asset_id: "t", tick_size: "abc", asks: [], bids: [] }, "t")!.tickSize, null);
});

test("2: missing tick => no MAKER and no TAKER (tick never defaulted)", async () => {
  const { event } = await decide([B], { d: deps({ "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10]], null) }) });
  assert.equal(event.decision.action, "SKIP");
  const ev = event.decision.evaluations[0];
  assert.equal(ev.maker.rejectReason, "TICK_UNKNOWN");
  assert.equal(ev.taker.eligible, false);
});

test("4: fee schedule parses the token-specific Gamma market", () => {
  const payload = [{ conditionId: "0xc", clobTokenIds: "[\"t1\",\"t2\"]", feesEnabled: true, feeType: "sports_fees_v3",
    feeSchedule: { exponent: 1, rate: 0.05, takerOnly: true, rebateRate: 0.15 } }];
  const r = parseTokenFeeSchedule(payload, "t2", "x", 1);
  assert.ok(r.ok);
  assert.equal(r.ok && r.takerRate, 0.05);
  assert.equal(r.ok && r.conditionId, "0xc");
  const off = parseTokenFeeSchedule([{ clobTokenIds: ["t1"], feesEnabled: false }], "t1", "x", 1);
  assert.ok(off.ok && off.takerRate === 0 && off.feesEnabled === false, "explicit feesEnabled=false is the only zero fee");
});

test("5: fee failure fails closed (parser, transport) and blocks TAKER", async () => {
  const bad: [unknown, string][] = [
    [[], "FEE_MARKET_NOT_FOUND"],
    [[{ clobTokenIds: ["t"] }, { clobTokenIds: ["t"] }], "FEE_MARKET_AMBIGUOUS"],
    [[{ clobTokenIds: ["t"] }], "FEE_ENABLED_FLAG_MISSING"],
    [[{ clobTokenIds: ["t"], feesEnabled: true }], "FEE_SCHEDULE_MISSING"],
    [[{ clobTokenIds: ["t"], feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 2 } }], "FEE_SCHEDULE_UNSUPPORTED"],
    [[{ clobTokenIds: ["t"], feesEnabled: true, feeSchedule: { rate: "0.05", exponent: 1 } }], "FEE_RATE_INVALID"],
    [{ not: "array" }, "FEE_PAYLOAD_NOT_ARRAY"],
  ];
  for (const [payload, code] of bad) {
    const r = parseTokenFeeSchedule(payload, "t", "x", 1);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.errorCode, code);
  }
  const http = await fetchTokenFeeSchedule("t", { fetchImpl: (async () => new Response("x", { status: 500 })) as typeof fetch });
  assert.equal(!http.ok && http.errorCode, "FEE_HTTP_500");
  const thrown = await fetchTokenFeeSchedule("t", { fetchImpl: (async () => { throw new Error("net"); }) as typeof fetch });
  assert.equal(!thrown.ok && thrown.errorCode, "FEE_FETCH_FAILED");
  const { event } = await decide([B], { d: deps(LIVE, (t) => ({ ok: false, tokenId: t, errorCode: "FEE_HTTP_500", latencyMs: 1 })) });
  assert.equal(event.decision.evaluations[0].taker.rejectReason, "TAKER_FEE_EVIDENCE_MISSING");
  assert.notEqual(event.decision.action, "TAKER_FIRST");
});

// ── TAKER economics ─────────────────────────────────────────────────────────

test("6: full $2.50 VWAP walks the ladder, not bestAsk; fee = C*rate*p*(1-p) per fill", () => {
  const w = walkTakerFill([{ price: 0.50, sizeShares: 2 }, { price: 0.51, sizeShares: 100 }], 2.5, 0.51, 0.05);
  // 2 sh @0.50 ($1.00) + 1.5/0.51 sh @0.51
  const shares = 2 + 1.5 / 0.51;
  assert.ok(w.filled);
  assert.equal(w.rawVwap, Math.round((2.5 / shares) * 1e6) / 1e6);
  assert.notEqual(w.rawVwap, 0.50);
  const expectedFee = takerFeeUsd(2, 0.5, 0.05) + takerFeeUsd(1.5 / 0.51, 0.51, 0.05);
  assert.equal(w.feeUsd, Math.round(expectedFee * 1e6) / 1e6);
  assert.equal(takerFeeUsd(5, 0.5, 0.05), 0.0625);
  assert.equal(w.effectiveCost, Math.round(((2.5 + expectedFee) / shares) * 1e6) / 1e6);
});

test("7: insufficient ladder depth at the fee-inclusive limit => no TAKER", async () => {
  const thin = bookOf("b-token", [[0.45, 100]], [[0.50, 2], [0.55, 100]]); // only $1 at <= L(0.54)
  const { event } = await decide([B], { d: deps({ "b-token": thin }) });
  assert.equal(event.decision.evaluations[0].taker.rejectReason, "TAKER_FULL_STAKE_DEPTH_INSUFFICIENT");
  assert.notEqual(event.decision.action, "TAKER_FIRST");
});

test("8-9: TAKER limit L bounds the fee-inclusive cost by the HARD CAP (no T30 anchor); cost <= cap is eligible", async () => {
  assert.equal(takerPriceLimit(0.54, 0.05, 0.01, 0.54), 0.52);   // 0.53*(1+0.05*0.47)=0.5425 > 0.54; 0.52 -> 0.5325
  assert.equal(takerPriceLimit(0.53, 0.05, 0.01, 0.54), 0.51);   // pure-function cases unchanged
  assert.equal(takerPriceLimit(0.50, 0.05, 0.01, 0.54), 0.48);
  assert.equal(takerPriceLimit(0.53, 0, 0.01, 0.54), 0.53);
  assert.ok(0.52 * (1 + 0.05 * (1 - 0.52)) <= 0.54);
  // LIVE_BETTING_RECOVERY_FINAL_HOTFIX_V2: the canonical hard cap is 0.555 -> the highest on-tick TAKER limit at fee rate 0.05 is 0.54.
  assert.equal(QUEUE_MAX_ENTRY_PRICE, 0.555);
  assert.equal(takerPriceLimit(QUEUE_MAX_ENTRY_PRICE, 0.05, 0.01, QUEUE_MAX_ENTRY_PRICE), 0.54);   // 0.54*(1+0.05*0.46)=0.55242 <= 0.555; 0.55 -> 0.5623
  // ask only at 0.55: above L(0.54) -> fee-inclusive cost 0.5623 > 0.555 -> no taker
  const { event: worse } = await decide([B], { d: deps({ "b-token": bookOf("b-token", [[0.53, 100]], [[0.55, 100]]) }) });
  assert.notEqual(worse.decision.action, "TAKER_FIRST");
  // ask at 0.53 / 0.54: fee-inclusive 0.542455 / 0.55242 <= 0.555 -> eligible (the old 0.54 cap refused both)
  for (const [ask, cost] of [[0.53, 0.542455], [0.54, 0.55242]] as const) {
    const { event: edge } = await decide([B], { d: deps({ "b-token": bookOf("b-token", [[0.51, 100]], [[ask, 100]]) }) });
    assert.equal(edge.decision.action, "TAKER_FIRST", `ask ${ask}`);
    assert.ok(Math.abs(edge.decision.selected!.taker.effectiveCost! - cost) < 1e-4, `ask ${ask}: effective ${edge.decision.selected!.taker.effectiveCost}`);
    assert.ok(edge.decision.selected!.taker.rawVwap! <= QUEUE_MAX_ENTRY_PRICE && edge.decision.selected!.taker.effectiveCost! <= QUEUE_MAX_ENTRY_PRICE);
  }
  const { event } = await decide([B]);
  const sel = event.decision.selected!;
  assert.equal(event.decision.action, "TAKER_FIRST");
  assert.equal(sel.taker.effectiveCost, 0.5125); // (2.5 + 5*0.05*0.25) / 5
  assert.equal(sel.priceAuthority.pBuyMax, 0.555, "TAKER price ceiling = hard cap");
  assert.ok(sel.taker.effectiveCost! <= sel.priceAuthority.pBuyMax!);
});

test("10: the reference grade (WEAK / UNRESOLVED) is telemetry only and never blocks a TAKER", async () => {
  // Capture-time T10 spread is wide (source-quality fail) and there is no T30 at all -> reference UNRESOLVED.
  const weak: Row = { ...B, t10: [0.40, 0.53], t30: null };
  const { event } = await decide([weak]);
  const ev = event.decision.evaluations[0];
  assert.equal(ev.referenceStatus, "UNRESOLVED");
  assert.equal(ev.taker.eligible, true, "the live ladder + fee decide, not the reference grade");
  assert.equal(event.decision.action, "TAKER_FIRST");
});

test("11-12: MAKER = floor_to_tick(min(current best bid, ask - tick, cap)); never bid + tick, never ask - tick across a wide spread", async () => {
  assert.equal(makerLimitPrice(0.53, 0.56, 0.001, 0.54), 0.53);
  assert.equal(makerLimitPrice(0.53, 0.531, 0.001, 0.54), 0.53);
  assert.equal(makerLimitPrice(0.52, 0.53, 0.01, 0.54), 0.52);
  assert.equal(makerLimitPrice(0.53, 0.53, 0.01, 0.54), 0.52, "pure formula: still strictly below the ask (parity with the callback side)");
  assert.equal(makerLimitPrice(0.49, 0.50, 0.01, 0.54), 0.49);
  // The money path uses the full placement rule: a locked / crossed current book fails closed.
  assert.equal(evaluateMakerPlacement(0.53, 0.53, 0.01, 0.54).limit, null);
  assert.equal(evaluateMakerPlacement(0.55, 0.53, 0.01, 0.54).reason, "MAKER_BOOK_CROSSED");
  assert.equal(evaluateMakerPlacement(null, 0.53, 0.01, 0.54).reason, "MAKER_BEST_BID_MISSING");
  assert.equal(evaluateMakerPlacement(0.52, 0.53, null, 0.54).reason, "TICK_UNKNOWN");
  assert.equal(makerLimitPrice(0.58, 0.60, 0.01, 0.54), 0.54, "hard cap binds");
  assert.equal(makerLimitPrice(0.30, 0.52, 0.001, 0.54), 0.3, "a wide spread is NOT jumped to ask - tick (0.519)");
  // Live: bid 0.30 / ask 0.52 -> limit 0.30, outside the MONEYLINE band -> SKIP (no full-stake taker depth either).
  const lowBid = bookOf("a-token", [[0.30, 100]], A_THIN_ASKS, 0.001);
  const { event } = await decide([A], { d: deps({ "a-token": lowBid }) });
  assert.equal(event.decision.action, "SKIP");
  const ev = event.decision.evaluations[0];
  assert.equal(ev.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(ev.support.maker.SUPPORT_PRICE, 0.3);
  // Bid 0.51 / ask 0.52 / tick 0.001 -> 0.51: neither ask - tick (0.519) nor bid + tick (0.511).
  const tight = bookOf("a-token", [[0.51, 100]], A_THIN_ASKS, 0.001);
  const { event: e2 } = await decide([A], { d: deps({ "a-token": tight }) });
  assert.equal(e2.decision.action, "MAKER_FIRST");
  assert.equal(e2.decision.selected!.maker.limitPrice, 0.51);
  assert.equal(e2.decision.selected!.priceAuthority.pBuyMax, 0.51, "MAKER price ceiling = the current-book limit");
});

test("13: a wide raw spread alone no longer kills a safe economic TAKER", async () => {
  assert.ok((LIVE["b-token"].book!.asks[0].price - LIVE["b-token"].book!.bids[0].price) > 0.03);
  const { event, d } = await decide([B]);
  const g = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
  assert.ok(g.ok);
  assert.equal(g.ok && g.contract.spread_telemetry, 0.05);
});

test("14: re-fetch worse than frozen economics => no Queue", async () => {
  const moving = (n: number) => n === 1 ? LIVE["b-token"] : bookOf("b-token", [[0.45, 100]], [[0.56, 100]]);
  const d = deps({ ...LIVE, "b-token": moving });
  const { event } = await decide([B], { d });
  assert.equal(event.decision.action, "TAKER_FIRST");
  const g = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
  assert.equal(g.ok, false);
  assert.match(!g.ok ? g.reason : "", /^T10_ECON_GUARD_FULL_STAKE_UNAVAILABLE/);
  const tickMoved = (n: number) => n === 1 ? LIVE["b-token"] : bookOf("b-token", [[0.45, 100]], [[0.50, 10]], 0.001);
  const d2 = deps({ "b-token": tickMoved });
  const { event: e2 } = await decide([B], { d: d2 });
  const g2 = await reverifySelectedAction({ event: e2, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: d2.fetchExactTokenOrderbook });
  assert.equal(!g2.ok && g2.reason, "T10_ECON_GUARD_TICK_CHANGED");
});

test("15: exact token never changes after selection (foreign book rejected, only selected token re-fetched)", async () => {
  const swapped = (n: number) => n === 1 ? LIVE["b-token"] : bookOf("a-token", [[0.45, 100]], [[0.40, 100]]);
  const d = deps({ ...LIVE, "b-token": swapped });
  const { event } = await decide([A, B], { d });
  const before = d.calls.length;
  const g = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
  assert.deepEqual(d.calls.slice(before), ["b-token"]);
  assert.equal(!g.ok && g.reason, "T10_ECON_GUARD_BOOK_UNAVAILABLE:BOOK_TOKEN_MISMATCH");
});

test("16: family priority cannot override the economic winner", async () => {
  const { event } = await decide([A, B]);
  assert.equal(event.decision.action, "TAKER_FIRST");
  assert.equal(event.decision.selected!.candidateIdentity.tokenId, "b-token", "TOTALS beats MONEYLINE on economics");
});

test("17-18: event exposure and latest entry (event start + 3m) block every sibling", async () => {
  // T+2:59 is still inside the entry window: the same event decides normally. T+3:00 blocks.
  const beforeLatest = Date.parse(KICKOFF) + 179_000;
  const { event: ok } = await decide([A, B], { now: beforeLatest });
  assert.equal(ok.decision.action, "TAKER_FIRST");
  assert.equal(ok.beforeLatestEntry, true);
  const { event: exp } = await decide([A, B], { exposure: true });
  assert.equal(exp.decision.action, "SKIP");
  assert.equal(exp.decision.reason, "EVENT_EXPOSURE_EXISTS");
  const { event: late } = await decide([A, B], { now: AFTER_LATEST });
  assert.equal(late.decision.action, "SKIP");
  assert.equal(late.decision.reason, "EVENT_AFTER_LATEST_ENTRY");
  // guard re-checks both independently of the frozen decision
  const { event, d } = await decide([B]);
  for (const [now, exposure, reason] of [[NOW, true, "T10_ECON_GUARD_EXPOSURE_EXISTS"], [AFTER_LATEST, false, "T10_ECON_GUARD_AFTER_LATEST_ENTRY"]] as const) {
    const g = await reverifySelectedAction({ event, nowMs: now, exposureExists: exposure, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
    assert.equal(!g.ok && g.reason, reason);
  }
});

test("22: real rank-4 evidence: the bid-less Under (0.02/0.51) is never a MAKER; capture-grade UNRESOLVED no longer vetoes, a TAKER needs real ask depth + fee", async () => {
  const under: Row = { cond: "r4", token: "under", side: "Under", family: "TOTALS", type: "TOTAL", t10: [0.02, 0.51], t30: [0.02, 0.52] };
  const over: Row = { cond: "r4", token: "over", side: "Over", family: "TOTALS", type: "TOTAL", t10: [0.49, 0.98], t30: [0.48, 0.98] };
  const thin = { under: bookOf("under", [[0.02, 100]], [[0.51, 1], [0.70, 100]]), over: bookOf("over", [[0.49, 100]], [[0.98, 100]]) };
  const { event: noDepth } = await decide([under, over], { d: deps(thin) });
  assert.equal(noDepth.decision.action, "SKIP", "no full-stake depth for the taker; the bid-less maker is outside the band");
  const ev = noDepth.decision.evaluations.find((e) => e.candidateIdentity.tokenId === "under")!;
  assert.equal(ev.referenceStatus, "UNRESOLVED", "telemetry only");
  assert.equal(ev.maker.eligible, false);
  assert.equal(ev.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(ev.support.maker.SUPPORT_PRICE, 0.02, "the empty bid is never jumped to ask - tick");
  const deep = { under: bookOf("under", [[0.02, 100]], [[0.51, 100]]), over: thin.over };
  const { event } = await decide([under, over], { d: deps(deep) });
  assert.equal(event.decision.action, "TAKER_FIRST", "ask 0.51 is in band, full stake + fee proven on the current ladder");
  assert.equal(event.decision.selected!.candidateIdentity.tokenId, "under");
  assert.ok(event.decision.selected!.taker.effectiveCost! <= 0.54);
  assert.equal(event.decision.evaluations.find((e) => e.candidateIdentity.tokenId === "over")!.taker.rejectReason, "FOUNDER_TOTALS_OVER_LIVE_OFF_2026_10_10", "TOTALS Over is live-OFF (Founder); still evaluated for telemetry");
});

// ── real decision path (runEventRebalance) ──────────────────────────────────

function reservation(): NightEventReservationRow {
  return {
    id: RES_ID, plan_run_id: "night-plan:2026-07-19", plan_date_minsk: "2026-07-19",
    window_start_iso: "2026-07-19T14:00:00.000Z", window_end_iso: "2026-07-20T05:00:00.000Z",
    match_family_key: "pair:a-vs-b:2026-07-19", event_slug: "a-vs-b", event_title: "A vs B", sport: "soccer", league: null,
    strategic_scope: "WC", game_start_iso: KICKOFF, event_tier: "TIER1", event_score: 80, best_snapshot_id: null,
    reservation_rank: 1, status: "RESERVED", selection_reason: null, physical_event_id: EVENT, event_start_iso: KICKOFF,
    diagnostics: { contract_a_stage: "PLANNING", source_lineage: { provider_event_id: "event-1" },
      planning_final_identity_evidence: { condition_id: "a-money", token_id: "a-token", side: "Yes" } },
  } as NightEventReservationRow;
}
function repoOf(reservations: NightEventReservationRow[], prior: EventExecutionQueueRow[] = [], exposureLoader = true): RebalanceRepoPort & { queueRows: EventExecutionQueueRow[]; queued: Set<string> } {
  const queueRows: EventExecutionQueueRow[] = [];
  const queued = new Set<string>();
  return {
    queueRows, queued,
    ...(exposureLoader ? { async loadEventExposureQueueRows(r: NightEventReservationRow) {
      return [...prior, ...queueRows].filter((q) => q.reservation_id === r.id || q.match_family_key === r.match_family_key ||
        q.diagnostics?.physical_event_id === r.physical_event_id);
    } } : {}),
    async loadActiveReservations() { return reservations.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING"); },
    async loadQueuedReservationIds() { return new Set(queued); },
    async markReservationsExpired() {},
    async markReservationSkipped(id) { const r = reservations.find((x) => x.id === id); if (r) r.status = "SKIPPED"; },
    async insertQueueRow(row) { queueRows.push(row); if (row.reservation_id) queued.add(row.reservation_id); },
    async markReservationQueued(id) { const r = reservations.find((x) => x.id === id); if (r) r.status = "QUEUED"; },
  };
}
async function run(on: boolean | undefined, rows: Row[] = [A, B], books = LIVE, o: { repo?: ReturnType<typeof repoOf>; res?: NightEventReservationRow;
  readT30?: () => Promise<FinalT3MarketObservation[]> } = {}) {
  const res = o.res ?? reservation();
  const repo = o.repo ?? repoOf([res]);
  const u = universes(rows);
  const d = deps(books);
  const result = await runEventRebalance(NOW, { write: true }, {
    repo, readFinalT3Universe: async () => u.t10, readT30Universe: o.readT30 ?? (async () => u.t30),
    recordStrategyDecision: async () => ({ total: 2, selected: 1, written: 2 }),
    fetchExactTokenOrderbook: d.fetchExactTokenOrderbook, fetchTokenFeeSchedule: d.fetchTokenFeeSchedule,
    writeGuardTelemetry: async () => {},
    ...(on === undefined ? {} : { t10EconomicActivation: on }),
  });
  return { result, repo, d, res };
}

test("19-20: activation ON -> exactly one immutable Queue row freezing mode, token and price authority", async () => {
  const { result, repo, res } = await run(true);
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
  const row = repo.queueRows[0];
  assert.deepEqual([row.condition_id, row.token_id, row.side], ["b-total", "b-token", "Yes"]);
  assert.equal(row.selection_reason, "T10_ECONOMIC_ACTION_TAKER_FIRST_V1");
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  assert.equal(c.execution_mode, "TAKER_FIRST");
  assert.equal(c.price_authority_version, "T10_CURRENT_BOOK_EXECUTION_AUTHORITY_V1");
  assert.equal(c.price_authority_observation_id, "T10_CURRENT_BOOK:b-total:b-token:Yes:2026-07-19T18:46:30.000Z", "current execution book lineage, never a T30 key");
  assert.deepEqual(c.t30_telemetry_v1, { observation_key: "T30_BOOK:T_MINUS_30-run:b-token:Yes", LIVE_AUTHORITY: false }, "T30 survives as telemetry only");
  assert.equal(c.p_buy_max, 0.555, "TAKER ceiling = hard cap");
  assert.equal(c.token_id, "b-token");
  assert.equal(c.stake_usd, 2.7, "TAKER_MIN_NOTIONAL_CONTRACT: min 5 x taker price_limit 0.54 (execution envelope)");
  assert.equal(c.latest_entry_iso, "2026-07-19T19:03:00.000Z", "latest entry = event start + 3m");
  assert.equal(c.taker.price_limit, 0.54);
  assert.equal(c.taker.authorized_raw_vwap, 0.5);
  assert.equal(c.taker.authorized_effective_cost, 0.5125);
  assert.equal(c.taker.fee_rate, 0.05);
  assert.equal(c.tick_size, 0.01);
  assert.equal(row.diagnostics.max_entry_price, 0.54, "Ireland price cap = fee-inclusive limit <= hard cap");
  assert.ok(!JSON.stringify(row.diagnostics).includes("\"asks\""), "no raw ladder persisted");
  const wire = mapQueueRowToIrelandCandidate(row, NOW);
  assert.equal(wire.execution_mode, "TAKER");
  assert.equal(wire.max_entry_price, 0.54);
  // Re-run: same reservation can never produce a second row.
  res.status = "REBALANCE_PENDING";
  const again = await run(true, [A, B], LIVE, { repo, res });
  assert.equal(again.result.already_queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
});

test("MAKER_FIRST is queued as an explicit primary-maker instruction, never translated into TAKER", async () => {
  const { result, repo } = await run(true, [A], LIVE_A_MAKER);
  assert.equal(result.queued_count, 1);
  const row = repo.queueRows[0];
  assert.equal(row.selection_reason, "T10_ECONOMIC_ACTION_MAKER_FIRST_V1");
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  assert.equal(c.execution_mode, "MAKER_FIRST");
  assert.equal(c.taker, null);
  assert.deepEqual(c.maker, { maker_limit_price: 0.5, maker_shares: 5 });
  assert.equal(c.minimum_order_size, 5);
  assert.equal(row.stake_usd, 2.5, "stake never increased");
  assert.equal(row.diagnostics.max_entry_price, 0.5, "price cap = frozen current-book maker limit (the best bid)");
  // Read back from the timestamptz column ("+00:00") the frozen deadline still matches.
  const dbRow = { ...row, id: "q-maker", latest_entry_iso: row.latest_entry_iso.replace(".000Z", "+00:00") };
  const wire = mapQueueRowToIrelandCandidate(dbRow, NOW);
  assert.equal(wire.execution_mode, "MAKER_FIRST");
  assert.equal(wire.attempt_id, "MAKER_FIRST");
  assert.equal(wire.maker_limit_price, 0.5);
  assert.equal(wire.maker_shares, 5);
  assert.equal(wire.requested_quantity, 5);
  assert.equal(wire.tick_size, 0.01);
  assert.equal(wire.minimum_order_size, 5);
  assert.equal(wire.p_buy_max, 0.5);
  assert.equal(wire.price_cap, 0.5);
  assert.equal(wire.stake_usd, 2.5);
  assert.equal(wire.price_authority_version, "T10_CURRENT_BOOK_EXECUTION_AUTHORITY_V1");
  assert.equal(wire.price_authority_observation_id, "T10_CURRENT_BOOK:a-money:a-token:Yes:2026-07-19T18:46:30.000Z");
  assert.equal(Date.parse(wire.latest_entry_iso), Date.parse("2026-07-19T19:03:00.000Z"));
  assert.equal(wire.idempotency_key, row.idempotency_key);
  // Malformed MAKER_FIRST data fails closed: never emitted, never a TAKER.
  for (const broken of [
    { ...c, maker: null }, { ...c, maker: { maker_limit_price: 0.505, maker_shares: 5 } },
    { ...c, maker: { maker_limit_price: 0.5, maker_shares: 4.9 } }, { ...c, minimum_order_size: null },
    { ...c, p_buy_max: 0.49 }, { ...c, execution_mode: "MAKER" }, { ...c, price_authority_observation_id: "" },
    { ...c, token_id: "other" }, { ...c, latest_entry_iso: "2026-07-19T18:58:00.000Z" }, { ...c, latest_entry_iso: null },
  ]) {
    assert.throws(() => mapQueueRowToIrelandCandidate({ ...row, diagnostics: { ...row.diagnostics, t10_economic_action_v1: broken } }, NOW),
      QueueWireContractError);
  }
});

test("minimum order: unknown fails closed; headroom above $4.00 or short depth for the minimum SKIPs (TAKER_FIRST and MAKER_FIRST)", async () => {
  const cases: Array<[Row[], Record<string, FetchOrderBookResult>, RegExp]> = [
    [[A], { ...LIVE, "a-token": aBook(null) }, /T10_ECON_GUARD_MIN_ORDER_SIZE_UNKNOWN/],
    // 9 shares x 0.50 = $4.50 > $4.00 ceiling.
    [[A], { ...LIVE, "a-token": aBook(9) }, /T10_ECON_GUARD_MIN_ORDER_HEADROOM_ABOVE_MAX_STAKE/],
    [[B], { ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]], 0.01, null) }, /T10_ECON_GUARD_MIN_ORDER_SIZE_UNKNOWN/],
    [[B], { ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]], 0.01, 9) }, /T10_ECON_GUARD_MIN_ORDER_HEADROOM_ABOVE_MAX_STAKE/],
    // Insufficient taker depth after resize: $2.50 fills, but only 5.5 shares <= limit (0.54) exist for a minimum of 6.
    [[B], { ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 5.5], [0.60, 100]], 0.01, 6) }, /T10_ECON_GUARD_TAKER_BELOW_MIN_ORDER_SIZE:.*depth_short_for_minimum/],
  ];
  for (const [rows, books, reason] of cases) {
    const { result, repo } = await run(true, rows, books);
    assert.equal(repo.queueRows.length, 0);
    assert.match(result.outcomes.map((o) => o.reason).join(","), reason);
  }
});

test("event exposure: any prior Queue attempt on the physical event that is not proven zero blocks the ON path", async () => {
  const prior = (over: Partial<EventExecutionQueueRow>): EventExecutionQueueRow => ({
    id: "q-prior", reservation_id: "res-other", plan_run_id: "p0", rebalance_run_id: "r0", match_family_key: "other",
    event_title: null, event_slug: null, sport: null, league: null, game_start_iso: KICKOFF, condition_id: "x", token_id: "x-token",
    side: "Yes", market_slug: null, market_title: null, market_family: null, score: null, coverage: null, tier: "TIER1",
    stake_usd: 2.5, preferred_entry_iso: KICKOFF, latest_entry_iso: KICKOFF, selection_rank: 1, selection_reason: null,
    status: "EXECUTED", order_key: null, idempotency_key: "k0", diagnostics: { physical_event_id: EVENT }, ...over,
  });
  const zero = { result_class: "PROVEN_ZERO_FILL_EXPIRED", terminal: true, filled_quantity: 0, economic_exposure_proven_zero: true };
  const blocked: EventExecutionQueueRow[] = [
    prior({}),                                                                      // accepted, nothing recorded
    prior({ status: "FAILED" }),                                                    // rejection signal is not zero proof
    prior({ status: "EXPIRED", selection_reason: "MISSED" }),                       // not the evidence-checked sweep
    prior({ diagnostics: { physical_event_id: EVENT, execution_attempts_v1: { taker_attempt_1: { result: { ...zero, result_class: "PARTIAL_FILL", filled_quantity: 2 } } } } }),
    prior({ diagnostics: { physical_event_id: EVENT, execution_attempts_v1: { maker_first: { result: { ...zero, result_class: "UNKNOWN_AFTER_SUBMISSION", terminal: null, filled_quantity: null, economic_exposure_proven_zero: null } } } } }),
    prior({ diagnostics: { physical_event_id: EVENT, execution_attempts_v1: { taker_attempt_1: { result: zero }, maker_fallback_1: { command: { attempt_id: "MAKER_FALLBACK_1" } } } } }),
    // A later SKIPPED / CANCELLED / swept status never erases a recorded partial or UNKNOWN result.
    prior({ status: "SKIPPED", diagnostics: { physical_event_id: EVENT, execution_attempts_v1: { maker_first: { result: { ...zero, result_class: "PARTIAL_FILL_CANCELLED", filled_quantity: 2, economic_exposure_proven_zero: false } } } } }),
    prior({ status: "CANCELLED", diagnostics: { physical_event_id: EVENT, execution_attempts_v1: { taker_attempt_1: { result: { ...zero, result_class: "UNKNOWN_AFTER_SUBMISSION", terminal: null, filled_quantity: null, economic_exposure_proven_zero: null } } } } }),
    prior({ status: "EXPIRED", selection_reason: "LATEST_ENTRY_WINDOW_PASSED", diagnostics: { physical_event_id: EVENT, execution_attempts_v1: { maker_first: { result: { ...zero, result_class: "FULL_FILL", filled_quantity: 5, economic_exposure_proven_zero: false } } } } }),
  ];
  for (const p of blocked) {
    const res = reservation();
    const { result, repo } = await run(true, [A, B], LIVE, { res, repo: repoOf([res], [p]) });
    assert.equal(repo.queueRows.length, 0, JSON.stringify(p.diagnostics));
    assert.match(result.outcomes.map((o) => o.reason).join(","), /EVENT_EXPOSURE_EXISTS/);
  }
  const clear: EventExecutionQueueRow[] = [
    prior({ status: "SKIPPED" }),
    prior({ status: "EXPIRED", selection_reason: "LATEST_ENTRY_WINDOW_PASSED" }),
    prior({ diagnostics: { physical_event_id: EVENT, execution_attempts_v1: { taker_attempt_1: { result: zero } } } }),
  ];
  for (const p of clear) {
    const res = reservation();
    const { repo } = await run(true, [A, B], LIVE, { res, repo: repoOf([res], [p]) });
    assert.equal(repo.queueRows.length, 1);
  }
  // No exposure authority available -> unproven -> fail closed.
  const res = reservation();
  const { repo } = await run(true, [A, B], LIVE, { res, repo: repoOf([res], [], false) });
  assert.equal(repo.queueRows.length, 0);
});

test("21: activation OFF (default and explicit) preserves released B priority + LIVE_GUARD", async () => {
  assert.equal(isT10EconomicActivationOn({}), false);
  assert.equal(isT10EconomicActivationOn({ T10_ECONOMIC_ACTION_ACTIVATION: "on" }), false);
  assert.equal(isT10EconomicActivationOn({ T10_ECONOMIC_ACTION_ACTIVATION: "ON" }), true);
  for (const on of [false, undefined]) {
    // B priority picks MONEYLINE (a-token); released LIVE_GUARD passes (spread 0.02).
    const { repo, d } = await run(on);
    assert.equal(repo.queueRows.length, 1);
    assert.equal(repo.queueRows[0].token_id, "a-token");
    assert.equal(repo.queueRows[0].diagnostics.source_authority, "COMPLETED_T3_AB_FINAL_IDENTITY");
    assert.equal(repo.queueRows[0].diagnostics.max_entry_price, 0.555, "released path uses the single canonical cap");
    assert.deepEqual(d.calls, ["a-token"], "OFF never touches the economic evidence path");
  }
  // OFF: released raw spread gate still rejects B alone (spread 0.05).
  const { repo } = await run(false, [B]);
  assert.equal(repo.queueRows.length, 0);
});

// ── LIVE_EXECUTION_FINAL_ACTIVATION_V1: adaptive minimum-order headroom + MAKER_FIRST timing ──

// M: current bid 0.53 / ask 0.56 -> maker limit 0.53 (the best bid); the ask is above the taker limit 0.54 (no depth) -> MAKER_FIRST.
const M: Row = { cond: "m-ml", token: "m-token", family: "MONEYLINE", type: "MONEYLINE", t10: [0.53, 0.56], t30: [0.53, 0.56] };
const mBook = (min: number | null = 5) => ({ ...LIVE, "m-token": bookOf("m-token", [[0.53, 100]], [[0.56, 100]], 0.01, min) });
const LATEST_ENTRY = "2026-07-19T19:03:00.000Z";             // event start + 3 minutes
const CANCEL_BY = "2026-07-19T18:59:00.000Z";                // event start - 60 s (SINGLE_MAKER_PREGAME_CONTRACT_V1; a fixed offset, not derived from latest_entry)

const WIRE_FALLBACK_COMMAND_KEYS = [
  "attempt_id", "authorized_at_iso", "condition_id", "deadline_iso", "execution_mode", "execution_side", "idempotency_key",
  "limit_price", "market_family", "max_stake_usd", "parent_attempt_id", "parent_idempotency_key", "parent_queue_id",
  "physical_event_id", "price_cap", "quantity", "reservation_id", "side", "stake_usd", "status", "strategy_variant",
  "strategy_version", "token_id",
].sort();

function fallbackWorld(row: EventExecutionQueueRow, book = { bestBid: 0.52, bestAsk: 0.54, tickSize: 0.01 }) {
  const st = { row, claims: 0 };
  const port: MakerFallbackPort = {
    async loadQueueRowByIdempotencyKey(k) { return k === st.row.idempotency_key ? structuredClone(st.row) : null; },
    async fetchBook() { return book; },
    async recordResult(_id, slot, result) {
      const a = readExecutionAttempts(st.row.diagnostics);
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, [slot]: { ...(a[slot] ?? {}), result } } } };
    },
    async claimMakerFallback(_id, command) {
      const a = readExecutionAttempts(st.row.diagnostics);
      if (a.maker_fallback_1?.command) return false;
      st.claims++;
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, maker_fallback_1: { command } } } };
      return true;
    },
  };
  return { st, port };
}
const primaryCallback = (row: EventExecutionQueueRow, outcome: string, extra: Record<string, unknown> = {}) => ({
  idempotency_key: row.idempotency_key, condition_id: row.condition_id, token_id: row.token_id, side: row.side,
  attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST", submitted_price: 0.53, submitted_size: 5,
  execution_result_v1: { attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST", outcome, venue_order_id: "v-1", ...extra },
});

test("FULL PATH: Reservation -> T30 -> T10 -> $2.50 fails ONLY minimum size -> $2.65 -> Queue -> MAKER_FIRST timing -> terminal ZERO -> NO fallback (single maker)", async () => {
  // $2.50 / 0.53 = 4.71 shares < minimum 5: the only blocker.
  const { result, repo, res } = await run(true, [M], mBook(5));
  assert.equal(result.queued_count, 1);
  assert.equal(res.status, "QUEUED");
  const row = { ...repo.queueRows[0], id: "q-adaptive", status: "EXECUTED" as const };
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  // T10 execution contract.
  assert.equal(c.execution_mode, "MAKER_FIRST");
  assert.equal(c.p_buy_max, 0.53);
  assert.deepEqual(c.maker, { maker_limit_price: 0.53, maker_shares: 5 });
  assert.equal(c.stake_usd, 2.65);
  assert.deepEqual(c.stake_authorization, { base_stake_usd: 2.5, authorized_stake_usd: 2.65, max_stake_usd: 4,
    stake_adjustment_reason: "VENUE_MINIMUM_ORDER_SIZE", minimum_order_size: 5, required_minimum_notional_usd: 2.65 });
  assert.equal(c.fallback_deadline_iso, LATEST_ENTRY);
  assert.equal(c.primary_maker_cancel_by_iso, CANCEL_BY);
  assert.equal(c.required_min_remaining_seconds, 580);
  // Queue row (frozen authorized stake + auditable diagnostics).
  assert.equal(row.stake_usd, 2.65, "smallest sufficient stake, NOT $4.00 and NOT SKIP");
  assert.equal(row.latest_entry_iso, LATEST_ENTRY, "latest_entry = event start + 3m");
  for (const [k, v] of Object.entries({ base_stake_usd: 2.5, authorized_stake_usd: 2.65, max_stake_usd: 4,
    stake_adjustment_reason: "VENUE_MINIMUM_ORDER_SIZE", minimum_order_size: 5, required_minimum_notional_usd: 2.65, max_entry_price: 0.53 })) {
    assert.equal(row.diagnostics[k], v, k);
  }
  assert.ok((row.diagnostics.mechanical_guard_trace as string[]).includes("MIN_ORDER_HEADROOM_STAKE_APPLIED"));
  assert.ok(readT10FrozenContract(row).ok);
  // Ireland-facing MAKER_FIRST candidate (timestamptz read-back form).
  const wire = mapQueueRowToIrelandCandidate({ ...row, status: "READY", latest_entry_iso: "2026-07-19T19:03:00+00:00" }, NOW);
  assert.equal(wire.execution_mode, "MAKER_FIRST");
  assert.equal(wire.stake_usd, 2.65);
  assert.equal(wire.max_stake_usd, 4);
  assert.equal(wire.maker_limit_price, 0.53);
  assert.equal(wire.maker_shares, 5);
  assert.equal(wire.requested_quantity, 5);
  assert.equal(wire.price_cap, 0.53);
  assert.equal(wire.primary_maker_cancel_by_iso, CANCEL_BY);
  assert.equal(wire.fallback_deadline_iso, LATEST_ENTRY);
  assert.equal(wire.required_min_remaining_seconds, 580);
  assert.ok(wire.required_min_remaining_seconds! >= 580);
  assert.equal(primaryMakerSubmissionOpen(wire, NOW), true);
  assert.equal(primaryMakerSubmissionOpen(wire, Date.parse(CANCEL_BY)), false, "no primary at/after cancel_by");
  // Callback/accounting authority accepts exactly the frozen notional; never more.
  const sub = { queue_id: row.id, reservation_id: row.reservation_id, idempotency_key: row.idempotency_key, token_id: row.token_id,
    condition_id: row.condition_id, side: row.side, market_slug: null, stake_usd: 2.65, submitted_size: 5, submitted_price: 0.53 };
  assert.deepEqual(validateOrderEventAgainstQueueRow(sub, row), { ok: true });
  assert.equal(validateOrderEventAgainstQueueRow({ ...sub, submitted_price: 0.54 }, row).ok, false);

  // Terminal proven ZERO -> result recorded -> event closed: NO MAKER_FALLBACK_1 after MAKER_FIRST.
  const w = fallbackWorld(row);
  const callbackNow = new Date(Date.parse(CANCEL_BY) - 5_000);
  const auth = await recordResultAndAuthorizeMaker(w.port, primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), callbackNow);
  assert.deepEqual(auth, { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_first" });
  assert.equal(fallbackPublicationRetryable(auth), false, "nothing to publish -> callback may be acknowledged");
  const dup = await recordResultAndAuthorizeMaker(w.port, primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), callbackNow);
  assert.equal(dup.kind, "RESULT_RECORDED_NO_FURTHER_ATTEMPT");
  assert.equal(w.st.claims, 0, "MAX_MAKER_ATTEMPTS_PER_EVENT = 1: terminal ZERO never authorizes a second maker");
  assert.equal(selectExecutorMakerFallbackCommands([w.st.row], callbackNow.getTime()).length, 0, "nothing on maker_fallback_commands");
});

test("normal $2.50 regression: required stake <= $2.50 stays exactly $2.50 with no adjustment (MAKER and TAKER)", async () => {
  const maker = await run(true, [A], LIVE_A_MAKER);
  const m = maker.repo.queueRows[0];
  assert.equal(m.stake_usd, 2.5);
  assert.equal(m.diagnostics.stake_adjustment_reason, null);
  assert.equal(m.diagnostics.authorized_stake_usd, 2.5);
  assert.equal((m.diagnostics.t10_economic_action_v1 as any).stake_authorization.required_minimum_notional_usd, 2.5);
  assert.ok(!(m.diagnostics.mechanical_guard_trace as string[]).includes("MIN_ORDER_HEADROOM_STAKE_APPLIED"));
  // TAKER: the execution envelope (min x price_limit 0.54) must itself be <= $2.50: min 4 => 2.16.
  const taker = await run(true, [A, B], { ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]], 0.01, 4) });
  const t = taker.repo.queueRows[0];
  assert.equal(t.selection_reason, "T10_ECONOMIC_ACTION_TAKER_FIRST_V1");
  assert.equal(t.stake_usd, 2.5);
  assert.equal(t.diagnostics.stake_adjustment_reason, null);
});

test("headroom between $2.50 and $4.00 authorizes the EXACT minimum sufficient stake (MAKER and TAKER re-walk)", async () => {
  for (const [min, stake] of [[6, 3], [5.5, 2.75], [7.99, 4]] as const) {
    const { repo } = await run(true, [A], { ...LIVE, "a-token": aBook(min) });
    const row = repo.queueRows[0];
    assert.equal(row.stake_usd, stake, `min ${min}`);
    assert.equal((row.diagnostics.t10_economic_action_v1 as any).maker.maker_shares >= min, true);
    assert.ok(readT10FrozenContract(row).ok);
  }
  // TAKER: minimum 6 at the 0.54 price limit => the ACTUAL $3.24 (execution envelope) is re-walked on the book.
  const { repo } = await run(true, [B], { ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]], 0.01, 6) });
  const row = repo.queueRows[0];
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  assert.equal(c.execution_mode, "TAKER_FIRST");
  assert.equal(row.stake_usd, 3.24);
  assert.equal(c.taker.authorized_raw_vwap, 0.5);
  assert.ok(c.taker.authorized_effective_cost <= c.p_buy_max, "fee-inclusive cost <= P_BUY_MAX at the increased stake");
  assert.ok(c.taker.price_limit <= c.p_buy_max && c.taker.price_limit <= 0.54);
  assert.equal(c.stake_authorization.stake_adjustment_reason, "VENUE_MINIMUM_ORDER_SIZE");
  assert.equal(c.stake_authorization.required_minimum_notional_usd, 3.24);
  assert.ok(readT10FrozenContract(row).ok);
  assert.equal(mapQueueRowToIrelandCandidate({ ...row, id: "q" }, NOW).execution_mode, "TAKER");
});

test("headroom never relaxes economics: P_BUY_MAX, the 0.555 cap and depth are proven before and after resize", async () => {
  // TAKER selected on a deep book, but at re-verification $2.50 is blocked by DEPTH (not minimum): never resized.
  const thinAtGuard = (n: number) => bookOf("b-token", [[0.45, 100]], n === 1 ? [[0.50, 10], [0.60, 100]] : [[0.50, 2], [0.60, 100]], 0.01, 6);
  const { result, repo } = await run(true, [B], { ...LIVE, "b-token": thinAtGuard } as never);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes.map((o) => o.reason).join(","), /T10_ECON_GUARD_FULL_STAKE_UNAVAILABLE/);
  // Price authority above P_BUY_MAX / the 0.555 hard cap is rejected by the strict reader even with headroom evidence.
  const { repo: r2 } = await run(true, [M], mBook(5));
  const row = r2.queueRows[0];
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  for (const broken of [{ ...c, p_buy_max: 0.56 }, { ...c, maker: { maker_limit_price: 0.54, maker_shares: 5 } },
    { ...c, p_buy_max: 0.56, maker: { maker_limit_price: 0.56, maker_shares: 5 } }]) {
    assert.equal(readT10FrozenContract({ ...row, diagnostics: { ...row.diagnostics, t10_economic_action_v1: broken } }).ok, false);
  }
});

test("strict contract: a stake above $2.50 requires valid minimum-order headroom evidence and stays <= $4.00", async () => {
  const { repo } = await run(true, [M], mBook(5));
  const row = repo.queueRows[0];
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  const sa = c.stake_authorization;
  const variant = (stake: number, contract: Record<string, unknown>, diag: Record<string, unknown> = {}) =>
    readT10FrozenContract({ ...row, stake_usd: stake, diagnostics: { ...row.diagnostics, ...diag, t10_economic_action_v1: { ...contract, stake_usd: stake } } });
  assert.equal(variant(2.65, c).ok, true);
  // Silent promotion: $4.00 / $2.65 without evidence.
  assert.equal(variant(4, { ...c, stake_authorization: undefined }).ok, false);
  assert.equal(variant(2.65, { ...c, stake_authorization: null }).ok, false);
  // Above the minimum sufficient stake.
  assert.equal(variant(2.7, { ...c, stake_authorization: { ...sa, authorized_stake_usd: 2.7 } }).ok, false);
  // Wrong reason / ceiling / minimum / required notional.
  assert.equal(variant(2.65, { ...c, stake_authorization: { ...sa, stake_adjustment_reason: "DEPTH" } }).ok, false);
  assert.equal(variant(2.65, { ...c, stake_authorization: { ...sa, max_stake_usd: 5 } }).ok, false);
  assert.equal(variant(2.65, c, { max_stake_usd: 2.65 }).ok, false);
  assert.equal(variant(2.65, { ...c, stake_authorization: { ...sa, minimum_order_size: 4 } }).ok, false);
  assert.equal(variant(2.65, { ...c, stake_authorization: { ...sa, required_minimum_notional_usd: 2.4 } }).ok, false);
  // Headroom where $2.50 already met the minimum (limit 0.50 -> 5 shares) is invalid.
  assert.equal(variant(2.65, { ...c, maker: { maker_limit_price: 0.5, maker_shares: 5 } }, { max_entry_price: 0.5 }).ok, false);
  // Above the hard ceiling.
  assert.equal(variant(4.01, { ...c, stake_authorization: { ...sa, authorized_stake_usd: 4.01, required_minimum_notional_usd: 4.01 } }).ok, false);
  // A $2.50 row may not carry an adjustment reason.
  assert.equal(variant(2.5, { ...c, stake_authorization: { ...sa, authorized_stake_usd: 2.5 } }).ok, false);
  // Missing / inconsistent MAKER_FIRST timing never reaches the wire.
  for (const t of [{ primary_maker_cancel_by_iso: undefined }, { required_min_remaining_seconds: 579 },
    { fallback_deadline_iso: "2026-07-19T18:58:00.000Z" }, { primary_maker_cancel_by_iso: "2026-07-19T18:48:00.000Z" }]) {
    assert.throws(() => mapQueueRowToIrelandCandidate({ ...row, id: "q", diagnostics: { ...row.diagnostics, t10_economic_action_v1: { ...c, ...t } } }, NOW),
      QueueWireContractError);
  }
});

test("timing: a T10 MAKER_FIRST at/after primary_maker_cancel_by (T-1:00) fails closed -- including at/after kickoff; after latest_entry nothing executes", async () => {
  for (const now of [Date.parse(CANCEL_BY), Date.parse("2026-07-19T18:59:30.000Z"), Date.parse(KICKOFF), Date.parse(KICKOFF) + 60_000]) {
    const { event, d } = await decide([A], { now, d: deps(LIVE_A_MAKER) });
    const g = await reverifySelectedAction({ event, nowMs: now, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
    assert.equal(g.ok, false);
    assert.match(!g.ok ? g.reason : "", /T10_ECON_GUARD_AFTER_PRIMARY_MAKER_CANCEL_BY/);
  }
  // latest_entry is event start + 3m: T+2:59 still executes (TAKER_FIRST); T+3:00 and later never does.
  for (const [now, ok] of [[Date.parse(KICKOFF) + 179_000, true], [Date.parse(LATEST_ENTRY), false], [Date.parse(LATEST_ENTRY) + 60_000, false]] as const) {
    const { event, d } = await decide([B], { now });
    const g = await reverifySelectedAction({ event, nowMs: now, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
    assert.equal(g.ok, ok, `now=${new Date(now).toISOString()}`);
    if (!ok) assert.equal(event.decision.action, "SKIP");
  }
});

test("MAKER_FIRST adaptive row: no outcome (partial / positive / UNKNOWN / terminal ZERO) ever authorizes a fallback; nothing is retryable", async () => {
  const { repo } = await run(true, [M], mBook(5));
  const row = { ...repo.queueRows[0], id: "q-adaptive", status: "EXECUTED" as const };
  const at = new Date(Date.parse(CANCEL_BY) - 5_000);
  for (const [outcome, extra] of [["PARTIAL_FILL_CANCELLED", { filled_quantity: 2, average_fill_price: 0.53 }], ["FULL_FILL", { filled_quantity: 5, average_fill_price: 0.53 }],
    ["UNKNOWN_AFTER_SUBMISSION", {}], ["PARTIAL_FILL", { filled_quantity: 1 }], ["PROVEN_ZERO_FILL_CANCELLED", {}], ["PROVEN_ZERO_FILL_EXPIRED", {}]] as const) {
    const w = fallbackWorld(row);
    const auth = await recordResultAndAuthorizeMaker(w.port, primaryCallback(row, outcome, extra), at);
    assert.deepEqual(auth, { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_first" }, outcome);
    assert.equal(w.st.claims, 0, outcome);
    assert.equal(fallbackPublicationRetryable(auth), false, outcome);
    assert.equal(selectExecutorMakerFallbackCommands([w.st.row], at.getTime()).length, 0);
  }
  // Even an unavailable book can no longer matter: there is no publication to retry.
  const noBook = fallbackWorld(row);
  noBook.port.fetchBook = async () => null;
  const none = await recordResultAndAuthorizeMaker(noBook.port, primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), at);
  assert.equal(none.kind, "RESULT_RECORDED_NO_FURTHER_ATTEMPT");
  assert.equal(fallbackPublicationRetryable(none), false);
  // Transient publication failure on the TAKER fallback path stays retryable; deterministic blocks are final.
  assert.equal(fallbackPublicationRetryable({ kind: "MAKER_BLOCKED", reasons: ["BOOK_UNAVAILABLE"] }), true);
  assert.equal(fallbackPublicationRetryable({ kind: "MAKER_BLOCKED", reasons: ["AUTHORIZATION_ERROR"] }), true);
  assert.equal(fallbackPublicationRetryable({ kind: "MAKER_BLOCKED", reasons: ["DEADLINE_PASSED"] }), false);
});


// ── MONEYLINE_SUPPORT_AND_MAKER_PRICE_AUTHORITY_FIX_V1 ──────────────────────────────────────────────
const askRow = (family: string, type: string, ask: number, odds = 1 / ask) =>
  ({ ...obs({ cond: "x", token: "x", family, type, t10: [ask - 0.01, ask], t30: null }, "T_MINUS_10"), ask_decimal_odds: odds });

test("ML band: MONEYLINE 1.70..2.00 boundaries at the current-ask seam; other families unchanged", () => {
  const ml = (odds: number) => isBSupportEligible(askRow("MONEYLINE", "MONEYLINE", 1 / odds, odds));
  assert.equal(ml(1.69), false, "1.69 is outside the new band");
  assert.equal(ml(1.70), true, "1.70 boundary accepted");
  assert.equal(ml(1.754), true, "the live DR Congo ask 0.57 is now inside the candidate band");
  assert.equal(ml(2.00), true, "2.00 boundary accepted");
  assert.equal(ml(2.01), false, "above 2.00 rejected");
  const other = (family: string, type: string, odds: number) => isBSupportEligible(askRow(family, type, 1 / odds, odds));
  assert.equal(other("TOTALS", "TOTAL", 1.84), false);
  assert.equal(other("TOTALS", "TOTAL", 1.85), true);
  assert.equal(other("SPREADS", "SPREAD", 1.75), false, "SPREADS band is NOT widened");
  assert.equal(other("SPREADS", "SPREAD", 1.85), true);
  assert.deepEqual(bStrategySupportRegion("MONEYLINE"), { min: 1.7, max: 2 });
  assert.deepEqual(bStrategySupportRegion("SPREADS"), { min: 1.85, max: 2 });
  assert.deepEqual(bStrategySupportRegion("TOTALS"), { min: 1.85, max: 2 });
  assert.deepEqual(bStrategySupportRegion("TOTAL_CORNERS"), { min: 2.25, max: 2.5 });
  // Family admission is price-agnostic.
  assert.equal(isBSupportFamilyEligible(askRow("MONEYLINE", "MONEYLINE", 0.3)), true);
  assert.equal(isBSupportFamilyEligible(askRow("MONEYLINE", "TOTAL", 0.55)), false);
  assert.equal(isBSupportPriceInBand("MONEYLINE", 0.54), true);
  assert.equal(isBSupportPriceInBand("TOTALS", 0.54), true);
  assert.equal(isBSupportPriceInBand("MONEYLINE", 1 / 1.7), true);
  assert.equal(isBSupportPriceInBand("MONEYLINE", 0.6), false);
});

// DR Congo natural production case: T30 0.56/0.57, T10 0.56/0.57, tick 0.01, minimum_order_size 5.
const DRC: Row = { cond: "drc-ml", token: "drc-token", family: "MONEYLINE", type: "MONEYLINE", t10: [0.56, 0.57], t30: [0.56, 0.57] };
const drcBook = (min: number | null = 5) => ({ ...LIVE, "drc-token": bookOf("drc-token", [[0.56, 100]], [[0.57, 100]], 0.01, min) });

test("LIVE BUG (DR Congo): ask 0.57 outside the old band => MAKER_FIRST limit 0.55 (cap 0.555 floored to the tick); TAKER never pays 0.57", async () => {
  const { event } = await decide([DRC], { d: deps(drcBook()) });
  const ev = event.decision.evaluations[0];
  assert.equal(ev.priceAuthority.pBuyMax, 0.55, "MAKER ceiling = floor_to_tick(min(best bid 0.56, ask - tick 0.56, cap 0.555))");
  assert.equal(ev.taker.eligible, false);
  assert.equal(ev.taker.rawVwap, null, "no taker fill at 0.57 or anywhere above P_BUY_MAX / 0.555");
  assert.equal(ev.maker.eligible, true);
  assert.equal(ev.maker.limitPrice, 0.55);
  assert.equal(event.decision.action, "MAKER_FIRST");
  assert.equal(ev.support.maker.MAKER_SUPPORT_PRICE_SOURCE, "MAKER_LIMIT");
  assert.equal(ev.support.maker.SUPPORT_PRICE, 0.55);
  assert.equal(ev.support.taker.TAKER_SUPPORT_PRICE_SOURCE, "EXECUTABLE_CURRENT_ASK");
  assert.equal(ev.support.taker.SUPPORT_PRICE, 0.57);
  assert.equal([ev.support.SUPPORT_BAND_MIN, ev.support.SUPPORT_BAND_MAX].join(".."), "1.7..2");
  // Re-verification keeps every price authority.
  const guard = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: deps(drcBook()).fetchExactTokenOrderbook });
  assert.equal(guard.ok, true);
  if (guard.ok) {
    assert.equal(guard.contract.execution_mode, "MAKER_FIRST");
    assert.equal(guard.contract.maker!.maker_limit_price, 0.55);
    assert.ok(guard.contract.maker!.maker_limit_price <= guard.contract.p_buy_max);
    assert.ok(guard.contract.maker!.maker_limit_price <= guard.contract.hard_price_cap);
    assert.equal(guard.contract.taker, null);
  }
});

test("maker support is judged on maker_limit: limit odds outside the band => rejected even when the ask is inside", async () => {
  // Ask 0.50 (odds 2.00, inside) but the limit floor(min(best bid 0.49, 0.49)) = 0.49 (odds 2.04, outside). Thin ask depth: no taker.
  const row: Row = { cond: "ml-edge", token: "edge-token", family: "MONEYLINE", type: "MONEYLINE", t10: [0.49, 0.50], t30: [0.50, 0.51] };
  const book = { "edge-token": bookOf("edge-token", [[0.49, 100]], [[0.50, 1], [0.60, 100]], 0.01, 5) };
  const { event } = await decide([row], { d: deps(book) });
  const ev = event.decision.evaluations[0];
  assert.equal(ev.maker.eligible, false);
  assert.equal(ev.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(event.decision.action, "SKIP");
});

test("re-verification fails closed when the refreshed maker limit leaves the support band (ask drops)", async () => {
  const { event } = await decide([DRC], { d: deps(drcBook()) });
  const dropped = { "drc-token": bookOf("drc-token", [[0.48, 100]], [[0.50, 100]], 0.01, 5) };   // limit 0.49 => odds 2.04
  const guard = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: deps(dropped).fetchExactTokenOrderbook });
  assert.equal(guard.ok, false);
  if (!guard.ok) assert.match(guard.reason, /MAKER_SUPPORT_PRICE_OUTSIDE_BAND/);
});

test("FULL PATH (MONEYLINE band + maker authority): Reservation -> T30 -> T10 ask 0.57 -> MAKER_FIRST 0.55 -> Queue -> Ireland wire -> terminal ZERO -> no fallback", async () => {
  const { result, repo, res } = await run(true, [DRC], drcBook());
  assert.equal(result.queued_count, 1);
  assert.equal(res.status, "QUEUED");
  const row = { ...repo.queueRows[0], id: "q-drc", status: "EXECUTED" as const };
  assert.equal(row.market_family, "MONEYLINE");
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  assert.equal(c.execution_mode, "MAKER_FIRST");
  assert.equal(c.p_buy_max, 0.55);
  assert.equal(c.hard_price_cap, 0.555);
  assert.deepEqual(c.maker, { maker_limit_price: 0.55, maker_shares: 5 });
  assert.equal(c.taker, null);
  // PR #462 adaptive headroom preserved: $2.50 buys 4.54 < 5 shares => smallest cent stake $2.75 (<= $4.00).
  assert.equal(c.stake_usd, 2.75);
  assert.equal(c.stake_authorization.base_stake_usd, 2.5);
  assert.equal(c.stake_authorization.max_stake_usd, 4);
  // Timing contract preserved.
  assert.equal(c.fallback_deadline_iso, LATEST_ENTRY);
  assert.equal(c.primary_maker_cancel_by_iso, CANCEL_BY);
  assert.equal(c.required_min_remaining_seconds, 580);
  // Auditable per-action support evidence.
  const audit = row.diagnostics.t10_support_audit_v1 as Record<string, any>;
  assert.equal(audit.maker.MAKER_SUPPORT_PRICE_SOURCE, "MAKER_LIMIT");
  assert.equal(audit.maker.SUPPORT_PRICE, 0.55);
  assert.ok(Math.abs(audit.maker.SUPPORT_DECIMAL_ODDS - 1.818182) < 1e-5);
  assert.equal(audit.taker.TAKER_SUPPORT_PRICE_SOURCE, "EXECUTABLE_CURRENT_ASK");
  assert.equal(audit.taker.SUPPORT_PRICE, 0.57);
  assert.equal(audit.SUPPORT_BAND_MIN, 1.7);
  assert.equal(audit.SUPPORT_BAND_MAX, 2);
  assert.ok(readT10FrozenContract(row).ok);
  // Ireland wire.
  const wire = mapQueueRowToIrelandCandidate({ ...row, status: "READY", latest_entry_iso: "2026-07-19T19:03:00+00:00" }, NOW);
  assert.equal(wire.execution_mode, "MAKER_FIRST");
  assert.equal(wire.maker_limit_price, 0.55);
  assert.equal(wire.price_cap, 0.55);
  assert.equal(wire.maker_shares, 5);
  assert.equal(wire.required_min_remaining_seconds, 580);
  assert.equal(primaryMakerSubmissionOpen(wire, NOW), true);
  // Terminal ZERO -> recorded, event closed: NO MAKER_FALLBACK_1 after MAKER_FIRST.
  const w = fallbackWorld(row);
  const callbackNow = new Date(Date.parse(CANCEL_BY) + 5_000);
  const cb = { ...primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), submitted_price: 0.55 };
  const auth = await recordResultAndAuthorizeMaker(w.port, cb, callbackNow);
  assert.deepEqual(auth, { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_first" });
  assert.equal(fallbackPublicationRetryable(auth), false);
  const dup = await recordResultAndAuthorizeMaker(w.port, cb, callbackNow);
  assert.equal(dup.kind, "RESULT_RECORDED_NO_FURTHER_ATTEMPT");
  assert.equal(w.st.claims, 0);
  assert.equal(selectExecutorMakerFallbackCommands([w.st.row], callbackNow.getTime()).length, 0);
});

// ── T30_MONEY_GATE_REMOVAL_V1: T30 is research telemetry, never a live gate / price / rank ───────────

const strip = (c: Record<string, any>) => { const { t30_telemetry_v1: _t, reference_status: _r, ...rest } = c; return rest; };
const contractOf = (row: EventExecutionQueueRow) => row.diagnostics.t10_economic_action_v1 as Record<string, any>;

test("T30 REMOVED (TAKER): missing / empty / unusable / unreadable T30 never blocks a safe TAKER and never changes the frozen contract", async () => {
  const variants: Array<[string, Row[], (() => Promise<FinalT3MarketObservation[]>) | undefined]> = [
    ["with usable T30", [B], undefined],
    ["no T30 row", [{ ...B, t30: null }], undefined],
    ["wide T30 (spread 0.50)", [{ ...B, t30: [0.10, 0.60] }], undefined],
    ["wildly different T30", [{ ...B, t30: [0.20, 0.22] }], undefined],
    ["T30 universe empty", [B], async () => []],
    ["T30 universe unreadable", [B], async () => { throw new Error("t30 unreadable"); }],
  ];
  let baseline: Record<string, unknown> | null = null;
  for (const [name, rows, readT30] of variants) {
    const { result, repo } = await run(true, rows, LIVE, readT30 ? { readT30 } : {});
    assert.equal(result.queued_count, 1, name);
    const row = repo.queueRows[0];
    const c = contractOf(row);
    assert.equal(c.execution_mode, "TAKER_FIRST", name);
    assert.equal(c.price_authority_version, "T10_CURRENT_BOOK_EXECUTION_AUTHORITY_V1", name);
    assert.match(c.price_authority_observation_id, /^T10_CURRENT_BOOK:/, name);
    assert.equal(c.t30_telemetry_v1.LIVE_AUTHORITY, false, name);
    assert.ok(readT10FrozenContract(row).ok, name);
    const frozen = { ...strip(c), max_entry_price: row.diagnostics.max_entry_price, stake: row.stake_usd, sel: row.selection_reason };
    baseline = baseline ?? frozen;
    assert.deepEqual(frozen, baseline, `${name}: changing only T30 must not change the live contract`);
  }
  // Telemetry survives exactly when a T30 observation existed.
  const withT30 = contractOf((await run(true, [B])).repo.queueRows[0]);
  const withoutT30 = contractOf((await run(true, [{ ...B, t30: null }])).repo.queueRows[0]);
  assert.equal(withT30.t30_telemetry_v1.observation_key, "T30_BOOK:T_MINUS_30-run:b-token:Yes");
  assert.equal(withoutT30.t30_telemetry_v1.observation_key, null);
});

test("T30 REMOVED (MAKER): missing / empty / unusable / unreadable T30 never blocks a safe MAKER and never changes the frozen contract", async () => {
  const variants: Array<[string, Row[], (() => Promise<FinalT3MarketObservation[]>) | undefined]> = [
    ["with usable T30", [A], undefined],
    ["no T30 row", [{ ...A, t30: null }], undefined],
    ["wide T30 (spread 0.50)", [{ ...A, t30: [0.10, 0.60] }], undefined],
    ["T30 bid far BELOW the current bid", [{ ...A, t30: [0.05, 0.07] }], undefined],
    ["T30 universe empty", [A], async () => []],
    ["T30 universe unreadable", [A], async () => { throw new Error("t30 unreadable"); }],
  ];
  let baseline: Record<string, unknown> | null = null;
  for (const [name, rows, readT30] of variants) {
    const { result, repo } = await run(true, rows, LIVE_A_MAKER, readT30 ? { readT30 } : {});
    assert.equal(result.queued_count, 1, name);
    const row = repo.queueRows[0];
    const c = contractOf(row);
    assert.equal(c.execution_mode, "MAKER_FIRST", name);
    assert.deepEqual(c.maker, { maker_limit_price: 0.5, maker_shares: 5 }, `${name}: limit = current best bid`);
    assert.equal(c.p_buy_max, 0.5, name);
    assert.ok(readT10FrozenContract(row).ok, name);
    const frozen = { ...strip(c), max_entry_price: row.diagnostics.max_entry_price, stake: row.stake_usd };
    baseline = baseline ?? frozen;
    assert.deepEqual(frozen, baseline, `${name}: changing only T30 must not change the live contract`);
  }
});

test("EXAMPLE A (Sri Lanka - Mauritius pattern): TOTALS bid 0.54 / ask 0.69 / tick 0.01, no usable T30 -> MAKER_FIRST 0.54 through Queue and Ireland wire", async () => {
  const SL: Row = { cond: "sl-total", token: "sl-token", family: "TOTALS", type: "TOTAL", t10: [0.54, 0.69], t30: null };
  const books = { ...LIVE, "sl-token": bookOf("sl-token", [[0.54, 100]], [[0.69, 100]], 0.01, 5) };
  const { result, repo, d } = await run(true, [SL], books);
  assert.equal(result.queued_count, 1);
  const row = { ...repo.queueRows[0], id: "q-sl" };
  const c = contractOf(row);
  assert.equal(c.execution_mode, "MAKER_FIRST");
  assert.equal(c.maker.maker_limit_price, 0.54);
  assert.equal(c.p_buy_max, 0.54);
  assert.equal(c.hard_price_cap, 0.555);
  assert.equal(c.stake_usd, 2.7, "venue-minimum headroom only: 5 shares x 0.54");
  assert.equal(c.t30_telemetry_v1.observation_key, null);
  const audit = row.diagnostics.t10_support_audit_v1 as Record<string, any>;
  assert.equal(audit.maker.SUPPORT_PRICE, 0.54);
  assert.ok(Math.abs(audit.maker.SUPPORT_DECIMAL_ODDS - 1.851852) < 1e-5, "decimal odds ~1.85185 inside TOTALS 1.85..2.00");
  assert.equal(audit.maker.SUPPORT_PRICE_IN_BAND, true);
  assert.equal(audit.taker.SUPPORT_PRICE_IN_BAND, false, "ask 0.69 is never bought");
  assert.deepEqual(d.calls.slice(0, 1), ["sl-token"], "exact token only");
  const wire = mapQueueRowToIrelandCandidate({ ...row, status: "READY", latest_entry_iso: "2026-07-19T19:03:00+00:00" }, NOW);
  assert.equal(wire.execution_mode, "MAKER_FIRST");
  assert.equal(wire.maker_limit_price, 0.54);
  assert.equal(wire.price_cap, 0.54);
});

test("EXAMPLE B: MONEYLINE bid 0.05 / ask 0.50 / tick 0.01 -> maker limit 0.05 is far outside the band -> SKIP, nothing queued", async () => {
  const SB: Row = { cond: "sb-money", token: "sb-token", family: "MONEYLINE", type: "MONEYLINE", t10: [0.05, 0.50], t30: null };
  const books = { ...LIVE, "sb-token": bookOf("sb-token", [[0.05, 100]], [[0.50, 1], [0.60, 100]], 0.01, 5) };
  const { event } = await decide([SB], { d: deps(books) });
  const ev = event.decision.evaluations[0];
  assert.equal(ev.maker.eligible, false);
  assert.equal(ev.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(ev.support.maker.SUPPORT_PRICE, 0.05, "never jumped to ask - tick");
  assert.equal(event.decision.action, "SKIP");
  const { result, repo } = await run(true, [SB], books);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes.map((o) => o.reason).join(","), /T10_ECON_SKIP/);
});

test("TAKER fee evidence is fetched for a T30-less candidate and is still mandatory; ask outside the band needs no fee", async () => {
  const seen: string[] = [];
  const d = deps(LIVE, (t) => { seen.push(t); return fee(t); });
  const { event } = await decide([{ ...B, t30: null }], { d });
  assert.deepEqual(seen, ["b-token"], "fee fetch no longer depends on a STRONG reference grade");
  assert.equal(event.decision.action, "TAKER_FIRST");
  const none = await decide([{ ...B, t30: null }], { d: deps(LIVE, (t) => ({ ok: false, tokenId: t, errorCode: "FEE_HTTP_500", latencyMs: 1 })) });
  assert.equal(none.event.decision.evaluations[0].taker.rejectReason, "TAKER_FEE_EVIDENCE_MISSING");
  assert.notEqual(none.event.decision.action, "TAKER_FIRST");
  const outside: string[] = [];
  const SL: Row = { cond: "sl-total", token: "sl-token", family: "TOTALS", type: "TOTAL", t10: [0.54, 0.69], t30: null };
  await decide([SL], { d: deps({ ...LIVE, "sl-token": bookOf("sl-token", [[0.54, 100]], [[0.69, 100]]) }, (t) => { outside.push(t); return fee(t); }) });
  assert.deepEqual(outside, []);
});

test("re-verification: maker limit is re-derived from the REFRESHED best bid but can never exceed the frozen current-book ceiling", async () => {
  const { event } = await decide([A], { d: deps(LIVE_A_MAKER) });
  assert.equal(event.decision.action, "MAKER_FIRST");
  assert.equal(event.decision.selected!.priceAuthority.pBuyMax, 0.5);
  const guard = (book: FetchOrderBookResult) =>
    reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: deps({ "a-token": book }).fetchExactTokenOrderbook });
  // Bid rose to 0.52 / ask 0.55: limit stays at the frozen ceiling 0.50 (never raised after selection).
  const rose = await guard(bookOf("a-token", [[0.52, 100]], [[0.55, 100]]));
  assert.ok(rose.ok);
  if (rose.ok) {
    assert.equal(rose.contract.maker!.maker_limit_price, 0.5);
    assert.equal(rose.contract.p_buy_max, 0.5);
    assert.match(rose.contract.price_authority_observation_id, /^T10_CURRENT_BOOK:a-money:a-token:Yes:/);
    assert.equal(rose.contract.t30_telemetry_v1.LIVE_AUTHORITY, false);
  }
  // Bid fell to 0.48 (odds 2.08): the refreshed limit leaves the band -> fail closed.
  const fell = await guard(bookOf("a-token", [[0.48, 100]], [[0.52, 100]]));
  assert.equal(fell.ok, false);
  if (!fell.ok) assert.match(fell.reason, /MAKER_SUPPORT_PRICE_OUTSIDE_BAND/);
  // Bid disappeared: the current best bid is the placement authority -> fail closed.
  const noBid = await guard(bookOf("a-token", [], [[0.52, 100]]));
  assert.equal(!noBid.ok && noBid.reason, "T10_ECON_GUARD_MAKER_BEST_BID_MISSING");
  // Crossed refreshed book -> no valid passive limit -> fail closed.
  const crossed = await guard(bookOf("a-token", [[0.52, 100]], [[0.52, 100]]));
  assert.equal(!crossed.ok && crossed.reason, "T10_ECON_GUARD_MAKER_LIMIT_INVALID");
});

test("TAKER_FIRST still outranks MAKER_FIRST through the real path; one physical event => one Queue row", async () => {
  // A has a safe maker (limit 0.50), B has a safe taker: the taker wins and exactly one row exists.
  const { result, repo } = await run(true, [A, B], LIVE_A_MAKER);
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.queueRows[0].token_id, "b-token");
  assert.equal(contractOf(repo.queueRows[0]).execution_mode, "TAKER_FIRST");
  // Two safe takers (A and B on deep books): still ONE row, the lower fee-inclusive cost wins, never family priority.
  const two = await run(true, [A, B], LIVE);
  assert.equal(two.repo.queueRows.length, 1);
  assert.equal(two.repo.queueRows[0].token_id, "b-token");
});

test("MONEYLINE band behaviour unchanged through the live path: 1.70..2.00 admits ask 0.57 as a MAKER candidate; support bands untouched", async () => {
  assert.deepEqual(bStrategySupportRegion("MONEYLINE"), { min: 1.7, max: 2 });
  assert.deepEqual(bStrategySupportRegion("SPREADS"), { min: 1.85, max: 2 });
  assert.deepEqual(bStrategySupportRegion("TOTALS"), { min: 1.85, max: 2 });
  assert.deepEqual(bStrategySupportRegion("TOTAL_CORNERS"), { min: 2.25, max: 2.5 });
  const { event } = await decide([{ ...DRC, t30: null }], { d: deps(drcBook()) });
  assert.equal(event.decision.action, "MAKER_FIRST");
  assert.equal(event.decision.selected!.maker.limitPrice, 0.55);
  // Ask 0.60 (odds 1.667) is outside 1.70..2.00 for the taker; the maker (bid 0.58 -> limit 0.55) is judged on its own price.
  const wide = await decide([{ ...DRC, t10: [0.58, 0.60], t30: null }], { d: deps({ ...LIVE, "drc-token": bookOf("drc-token", [[0.58, 100]], [[0.60, 100]], 0.01, 5) }) });
  assert.equal(wide.event.decision.evaluations[0].taker.rejectReason, "TAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(wide.event.decision.action, "MAKER_FIRST");
});

test("a TAKER on a token whose capture-time reference grade is UNRESOLVED is queued and accepted by the strict Queue / Ireland readers (grade is telemetry)", async () => {
  // Wide capture-time T10 spread and no T30 at all -> reference UNRESOLVED; the live ladder + fee decide.
  const unresolved: Row = { ...B, t10: [0.40, 0.53], t30: null };
  const { result, repo } = await run(true, [unresolved]);
  assert.equal(result.queued_count, 1);
  const row = { ...repo.queueRows[0], id: "q-unresolved" };
  const c = contractOf(row);
  assert.equal(c.reference_status, "UNRESOLVED");
  assert.equal(c.execution_mode, "TAKER_FIRST");
  assert.equal(c.t30_telemetry_v1.observation_key, null);
  assert.ok(readT10FrozenContract(row).ok, "reference_status is never read by the frozen-contract reader");
  const wire = mapQueueRowToIrelandCandidate({ ...row, status: "READY" }, NOW);
  assert.equal(wire.execution_mode, "TAKER");
  assert.equal(wire.max_entry_price, 0.54);
});

test("MAKER_FALLBACK_1 after a TAKER_FIRST parent is bounded by the parent price cap (taker limit) and the hard cap, never by T30", async () => {
  const { repo } = await run(true, [B]);
  const row = { ...repo.queueRows[0], id: "q-taker-parent", status: "EXECUTED" as const };
  assert.equal(contractOf(row).p_buy_max, 0.555);
  const parentCap = row.diagnostics.max_entry_price as number;
  assert.equal(parentCap, 0.54);
  const derive = (bestAsk: number) => deriveT10FallbackLimit({ queue: row, book: { bestAsk, tickSize: 0.01, minimumOrderSize: 5 }, priceCap: parentCap, stakeUsd: row.stake_usd });
  const tight = derive(0.51);
  assert.ok(tight.ok);
  if (tight.ok) assert.equal(tight.limit_price, 0.5, "ask - tick binds");
  // A far-away ask cannot lift the fallback above the parent cap 0.54; the TAKER parent stake ($2.70 = 5 x 0.54) buys the minimum there.
  const far = derive(0.7);
  assert.deepEqual(far, { ok: true, limit_price: 0.54, quantity: 5 });
  // The legacy $2.50 stake still fails closed at the cap (4.62 shares < the 5-share minimum).
  assert.deepEqual(deriveT10FallbackLimit({ queue: row, book: { bestAsk: 0.7, tickSize: 0.01, minimumOrderSize: 5 }, priceCap: parentCap, stakeUsd: 2.5 }),
    { ok: false, reason: "BELOW_MINIMUM_ORDER_SIZE" });
});

// ── TAKER_MIN_NOTIONAL_CONTRACT_HOTFIX_V1: TAKER stake authority >= the Ireland execution envelope ──
// Live production: min 5, TAKER price_limit 0.54, PREMVP froze $2.65 / $2.50, Ireland required $2.70 and rejected both.
const bAsks = (asks: Lv[], min: number | null = 5) => ({ ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], asks, 0.01, min) });

test("TAKER_MIN_NOTIONAL 1/2: live shape (min 5, limit 0.54) authorizes $2.70 for ask 0.53 (was 2.65) AND ask 0.50 (was 2.50)", async () => {
  for (const [ask, currentBook] of [[0.53, 2.65], [0.5, 2.5]] as const) {
    const { repo } = await run(true, [B], bAsks([[ask, 100]]));
    assert.equal(repo.queueRows.length, 1, `ask ${ask}`);
    const row = { ...repo.queueRows[0], id: "q-min-notional" };
    const c = contractOf(row);
    assert.equal(c.execution_mode, "TAKER_FIRST");
    assert.equal(c.taker.price_limit, 0.54);
    assert.equal(c.stake_usd, 2.7);
    const sa = c.stake_authorization;
    assert.equal(sa.base_stake_usd, 2.5);
    assert.equal(sa.max_stake_usd, 4);
    assert.equal(sa.minimum_order_size, 5);
    assert.equal(sa.required_minimum_notional_usd, 2.7, "canonical field carries the MAXIMUM authoritative requirement");
    assert.equal(sa.current_book_required_minimum_notional_usd, currentBook);
    assert.equal(sa.execution_envelope_required_minimum_notional_usd, 2.7);
    assert.equal(sa.authorized_stake_usd, 2.7);
    assert.equal(sa.stake_adjustment_reason, "VENUE_MINIMUM_ORDER_SIZE");
    assert.equal(row.diagnostics.minimum_order_size, 5);
    assert.equal(row.diagnostics.required_minimum_notional_usd, 2.7);
    assert.equal(row.diagnostics.current_book_required_minimum_notional_usd, currentBook);
    assert.equal(row.diagnostics.execution_envelope_required_minimum_notional_usd, 2.7);
    assert.equal(row.diagnostics.authorized_stake_usd, 2.7);
    // Re-walked on the ACTUAL stake: full depth, raw VWAP <= price_limit, fee-inclusive cost <= 0.555, quantity >= minimum.
    assert.equal(c.taker.authorized_raw_vwap, ask);
    assert.ok(c.taker.authorized_raw_vwap <= c.taker.price_limit);
    assert.ok(c.taker.authorized_effective_cost <= 0.555);
    assert.ok(row.stake_usd / c.taker.authorized_raw_vwap >= 5, "authorized stake buys the venue minimum quantity");
    assert.ok(row.stake_usd >= 5 * c.taker.price_limit - 1e-9, "stake covers the Ireland minimum notional at the max raw price");
    assert.ok(readT10FrozenContract(row).ok);
    const wire = mapQueueRowToIrelandCandidate({ ...row, status: "READY" }, NOW);
    assert.equal(wire.execution_mode, "TAKER");
    assert.equal(wire.stake_usd, 2.7);
  }
});

test("TAKER_MIN_NOTIONAL 3: price_limit 0.55 with min 5 => execution envelope 2.75", async () => {
  const d = deps(bAsks([[0.5, 100]]), (t) => fee(t, 0.01));
  const { event } = await decide([B], { d });
  assert.equal(event.decision.action, "TAKER_FIRST");
  const g = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
  assert.ok(g.ok);
  if (!g.ok) return;
  const c = g.contract;
  assert.equal(c.taker!.price_limit, 0.55);
  assert.equal(c.stake_authorization.execution_envelope_required_minimum_notional_usd, 2.75);
  assert.equal(c.stake_authorization.required_minimum_notional_usd, 2.75);
  assert.equal(c.stake_usd, 2.75);
});

test("TAKER_MIN_NOTIONAL 4: execution envelope above $4.00 fails closed even when the current book alone would fit", async () => {
  // min 7.5 at ask 0.50: current book needs 3.75 (<= 4) but the envelope 7.5 x 0.54 = 4.05 > 4.00 => SKIP.
  const { result, repo } = await run(true, [B], bAsks([[0.5, 100]], 7.5));
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes.map((o) => o.reason).join(","), /T10_ECON_GUARD_MIN_ORDER_HEADROOM_ABOVE_MAX_STAKE: required_usd=4\.05/);
  // Exactly $4.00 (min 7.4 x 0.54 = 3.996 -> 4.00) is still allowed.
  const ok = await run(true, [B], bAsks([[0.5, 100]], 7.4));
  assert.equal(ok.repo.queueRows[0].stake_usd, 4);
});

test("TAKER_MIN_NOTIONAL 5: headroom re-walk re-proves depth, raw VWAP <= limit and the fee-inclusive 0.555 hard cap", async () => {
  // Depth: the base $2.50 fills but the $2.70 envelope stake cannot be filled at <= the limit => fail closed.
  const thin = (n: number) => bAsks(n === 1 ? [[0.5, 100]] : [[0.5, 5.2]])["b-token"];
  const d = deps({ ...LIVE, "b-token": thin as never });
  const { event } = await decide([B], { d });
  assert.equal(event.decision.action, "TAKER_FIRST");
  const g = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
  assert.equal(g.ok, false);
  assert.match(!g.ok ? g.reason : "", /^T10_ECON_GUARD_HEADROOM_FULL_STAKE_UNAVAILABLE: stake=2\.7/);
  // Hard cap: even if a (corrupted) frozen P_BUY_MAX / fee admitted the base stake, the re-walk after headroom is bounded by 0.555.
  const d2 = deps(bAsks([[0.54, 100]]));
  const { event: e2 } = await decide([B], { d: d2 });
  assert.equal(e2.decision.action, "TAKER_FIRST");
  const sel = e2.decision.selected!;
  const exec = e2.executions.get(`${sel.candidateIdentity.conditionId}|${sel.candidateIdentity.tokenId}|${sel.candidateIdentity.side}`)!;
  (sel.priceAuthority as { pBuyMax: number }).pBuyMax = 0.6;
  (exec.fee as { takerRate: number }).takerRate = 0.2;   // 0.54 x (1 + 0.2 x 0.46) = 0.5897 > 0.555
  const g2 = await reverifySelectedAction({ event: e2, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: d2.fetchExactTokenOrderbook });
  assert.equal(g2.ok, false);
  assert.match(!g2.ok ? g2.reason : "", /^T10_ECON_GUARD_HEADROOM_EFFECTIVE_COST_ABOVE_HARD_CAP/);
});

test("TAKER_MIN_NOTIONAL 6: MAKER adaptive stake is unchanged and carries no TAKER-only diagnostics", async () => {
  const { repo } = await run(true, [A], { ...LIVE, "a-token": aBook(5.5) });
  const row = repo.queueRows[0];
  assert.equal(row.stake_usd, 2.75);
  const sa = contractOf(row).stake_authorization;
  assert.equal(sa.required_minimum_notional_usd, 2.75);
  assert.equal(sa.current_book_required_minimum_notional_usd, undefined);
  assert.equal(sa.execution_envelope_required_minimum_notional_usd, undefined);
  assert.ok(readT10FrozenContract(row).ok);
});

// ── LIVE_MONEY_FAMILY_AUTHORITY_V1: SPREADS is observation-only; it must never win or starve a live family ──

const SP = (extra: Partial<Row> = {}): Row => ({ cond: "sp-spread", token: "sp-token", family: "SPREADS", type: "SPREAD", t10: [0.50, 0.52], t30: [0.50, 0.52], ...extra });
const TOT: Row = { cond: "tot-total", token: "tot-token", family: "TOTALS", type: "TOTAL", t10: [0.50, 0.52], t30: [0.50, 0.52] };
const ML: Row = { cond: "ml-money", token: "ml-token", family: "MONEYLINE", type: "MONEYLINE", t10: [0.50, 0.52], t30: [0.50, 0.52] };
const COR: Row = { cond: "cor-corners", token: "cor-token", family: "TOTAL_CORNERS", type: "TOTAL_CORNERS", t10: [0.42, 0.43], t30: [0.42, 0.43] };
const familyBooks: Record<string, FetchOrderBookResult> = Object.fromEntries([SP(), TOT, ML, COR].map((r) =>
  [r.token, bookOf(r.token, [[r.t10[0]!, 100]], [[r.t10[1], 100]])]));
// TOTAL_CORNERS needs the raw provider proof and the exact corners slug to be family-eligible.
const withCornersProof = (rows: FinalT3MarketObservation[]) => rows.map((o) => o.canonical_market_family === "TOTAL_CORNERS"
  ? { ...o, provider_market_type_raw: "total_corners", market_slug: "total-corners" } : o);

async function runLive(on: boolean, rows: Row[]) {
  const res = reservation();
  const repo = repoOf([res]);
  const u = universes(rows);
  const t10 = withCornersProof(u.t10);
  const d = deps(familyBooks);
  const recorded: { variant: string; selected: string | null; reason: string }[] = [];
  await runEventRebalance(NOW, { write: true }, {
    repo, readFinalT3Universe: async () => t10, readT30Universe: async () => withCornersProof(u.t30),
    recordStrategyDecision: async (i) => { recorded.push({ variant: i.strategyVariant, selected: i.selectedIdentity?.tokenId ?? null, reason: i.decisionReason }); return { total: 1, selected: 1, written: 1 }; },
    fetchExactTokenOrderbook: d.fetchExactTokenOrderbook, fetchTokenFeeSchedule: d.fetchTokenFeeSchedule,
    writeGuardTelemetry: async () => {}, t10EconomicActivation: on,
  });
  return { queued: repo.queueRows.map((r) => r.token_id), recorded, rows: repo.queueRows };
}

test("SPREADS-FIRST-STARVATION OFF: SPREADS cannot win the live B choice and starve an allowed family", async () => {
  for (const [other, token] of [[TOT, "tot-token"], [ML, "ml-token"], [COR, "cor-token"]] as const) {
    const { queued, recorded, rows } = await runLive(false, [SP(), other]);
    assert.deepEqual(queued, [token], `SPREADS + ${other.family} => live selects ${other.family}`);
    assert.equal(rows[0].market_family, other.family);
    // Telemetry/research arm is unchanged: B still prefers SPREADS and records it.
    assert.equal(recorded.find((r) => r.variant === "B_FOUR_MARKET_PRIORITY_V1")!.selected, "sp-token", "telemetry B still sees SPREADS");
    assert.equal(recorded.find((r) => r.variant === "B_FOUR_MARKET_PRIORITY_V1")!.reason, "PRIORITY_SPREADS_IN_SUPPORT");
  }
  const only = await runLive(false, [SP()]);
  assert.equal(only.queued.length, 0, "only SPREADS => Queue = 0");
  // Input order and the SPREADS exact-identity order never change the live pick.
  assert.deepEqual((await runLive(false, [TOT, SP(), SP({ cond: "sp-spread-2", token: "sp-token-2" })])).queued, ["tot-token"]);
});

test("SPREADS-FIRST-STARVATION ON: SPREADS cannot compete economically against any live family", async () => {
  // SPREADS gets the strictly better economics (bid 0.50 / ask 0.50 vs 0.52) and still never wins.
  const better = SP({ t10: [0.50, 0.50], t30: [0.50, 0.50] });
  const books = { ...familyBooks, "sp-token": bookOf("sp-token", [[0.50, 100]], [[0.50, 100]]) };
  for (const [other, token] of [[TOT, "tot-token"], [ML, "ml-token"], [COR, "cor-token"]] as const) {
    const u = universes([better, other]);
    const event = await decideT10EconomicEvent({ physicalEventId: EVENT, eventStartIso: KICKOFF, t10Universe: withCornersProof(u.t10),
      t30Universe: withCornersProof(u.t30), nowMs: NOW, exposureExists: false, deps: deps(books) });
    assert.equal(event.decision.selected?.candidateIdentity.tokenId, token, `SPREADS + ${other.family}`);
    const sp = event.decision.evaluations.find((e) => e.candidateIdentity.tokenId === "sp-token")!;
    assert.equal(sp.taker.eligible, false);
    assert.equal(sp.maker.eligible, false);
    assert.ok(!(await runLive(true, [better, other])).queued.includes("sp-token"));
  }
  assert.equal((await runLive(true, [better])).queued.length, 0, "only SPREADS => Queue = 0");
});
