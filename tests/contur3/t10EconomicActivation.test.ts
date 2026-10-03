// T10_EXACT_MARKET_EXECUTION_EVIDENCE_AND_MONEY_ACTIVATION_V1 — focused deterministic tests.
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
import { mapQueueRowToIrelandCandidate, type EventExecutionQueueRow, type NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import type { FinalT3MarketObservation } from "../../lib/executor/reservationMarketBaseline";

const KICKOFF = "2026-07-19T19:00:00.000Z";
const NOW = Date.parse("2026-07-19T18:52:00.000Z");          // T-8, latest entry T-3
const AFTER_LATEST = Date.parse("2026-07-19T18:58:00.000Z");
const T10_AT = "2026-07-19T18:48:00.000Z";
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

// A: SPREADS (B family priority #1): STRONG, P_BUY_MAX 0.50, live ask 0.52 -> maker only.
const A: Row = { cond: "a-spread", token: "a-token", family: "SPREADS", type: "SPREAD", t10: [0.50, 0.52], t30: [0.50, 0.52] };
// B: TOTALS (B family priority #4): STRONG, P_BUY_MAX 0.53, live ask 0.50 -> safe taker.
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
  const thin = bookOf("b-token", [[0.45, 100]], [[0.50, 2], [0.52, 100]]); // only $1 at <= L(0.51)
  const { event } = await decide([B], { d: deps({ "b-token": thin }) });
  assert.equal(event.decision.evaluations[0].taker.rejectReason, "TAKER_FULL_STAKE_DEPTH_INSUFFICIENT");
  assert.notEqual(event.decision.action, "TAKER_FIRST");
});

test("8-9: TAKER limit L bounds fee-inclusive cost by P_BUY_MAX; cost <= P_BUY_MAX is eligible", async () => {
  assert.equal(takerPriceLimit(0.53, 0.05, 0.01, 0.54), 0.51);   // 0.52*(1+0.05*0.48)=0.5325 > 0.53
  assert.equal(takerPriceLimit(0.50, 0.05, 0.01, 0.54), 0.48);
  assert.equal(takerPriceLimit(0.53, 0, 0.01, 0.54), 0.53);
  for (const L of [0.51, 0.48]) assert.ok(L * (1 + 0.05 * (1 - L)) <= (L === 0.51 ? 0.53 : 0.50));
  // cost above P_BUY_MAX: ask only at 0.52 for B (P_BUY_MAX 0.53, L 0.51) -> no taker
  const { event: worse } = await decide([B], { d: deps({ "b-token": bookOf("b-token", [[0.51, 100]], [[0.52, 100]]) }) });
  assert.notEqual(worse.decision.action, "TAKER_FIRST");
  const { event } = await decide([B]);
  const sel = event.decision.selected!;
  assert.equal(event.decision.action, "TAKER_FIRST");
  assert.equal(sel.taker.effectiveCost, 0.5125); // (2.5 + 5*0.05*0.25) / 5
  assert.ok(sel.taker.effectiveCost! <= sel.priceAuthority.pBuyMax!);
});

test("10: WEAK reference can never TAKER (maker only)", async () => {
  // T10 witness rejected by source-quality spread -> only the T30 witness -> WEAK.
  const weak: Row = { ...B, t10: [0.40, 0.53] };
  const { event } = await decide([weak]);
  const ev = event.decision.evaluations[0];
  assert.equal(ev.referenceStatus, "WEAK");
  assert.equal(ev.taker.rejectReason, "TAKER_REQUIRES_STRONG");
  assert.equal(event.decision.action, "MAKER_FIRST");
});

test("11-12: MAKER uses provider tick + P_BUY_MAX; never bestBid + tick", async () => {
  assert.equal(makerLimitPrice(0.53, 0.56, 0.001, 0.54), 0.53);
  assert.equal(makerLimitPrice(0.53, 0.531, 0.001, 0.54), 0.53);
  assert.equal(makerLimitPrice(0.53, 0.53, 0.01, 0.54), 0.52);
  assert.equal(makerLimitPrice(0.53, 0.53, 0.001, 0.54), 0.529);
  assert.equal(makerLimitPrice(0.50, 0.50, 0.01, 0.54), 0.49);
  const lowBid = bookOf("a-token", [[0.30, 100]], [[0.52, 100]], 0.001);
  const { event } = await decide([A], { d: deps({ "a-token": lowBid }) });
  assert.equal(event.decision.action, "MAKER_FIRST");
  assert.equal(event.decision.selected!.maker.limitPrice, 0.5, "min(P_BUY_MAX 0.50, ask-tick 0.519) — not bid 0.30 + tick");
});

test("13: a wide raw spread alone no longer kills a safe economic TAKER", async () => {
  assert.ok((LIVE["b-token"].book!.asks[0].price - LIVE["b-token"].book!.bids[0].price) > 0.03);
  const { event, d } = await decide([B]);
  const g = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
  assert.ok(g.ok);
  assert.equal(g.ok && g.contract.spread_telemetry, 0.05);
});

test("14: re-fetch worse than frozen economics => no Queue", async () => {
  const moving = (n: number) => n === 1 ? LIVE["b-token"] : bookOf("b-token", [[0.45, 100]], [[0.52, 100]]);
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
  assert.equal(event.decision.selected!.candidateIdentity.tokenId, "b-token", "TOTALS beats SPREADS on economics");
});

test("17-18: event exposure and latest entry block every sibling", async () => {
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

test("22: real rank-4 evidence remains SKIP", async () => {
  const under: Row = { cond: "r4", token: "under", side: "Under", family: "TOTALS", type: "TOTAL", t10: [0.02, 0.51], t30: [0.02, 0.52] };
  const over: Row = { cond: "r4", token: "over", side: "Over", family: "TOTALS", type: "TOTAL", t10: [0.49, 0.98], t30: [0.48, 0.98] };
  const { event } = await decide([under, over], { d: deps({
    under: bookOf("under", [[0.02, 100]], [[0.51, 100]]), over: bookOf("over", [[0.49, 100]], [[0.98, 100]]) }) });
  assert.equal(event.decision.action, "SKIP");
  assert.equal(event.decision.evaluations.find((e) => e.candidateIdentity.tokenId === "under")!.referenceStatus, "UNRESOLVED");
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
      planning_final_identity_evidence: { condition_id: "a-spread", token_id: "a-token", side: "Yes" } },
  } as NightEventReservationRow;
}
function repoOf(reservations: NightEventReservationRow[]): RebalanceRepoPort & { queueRows: EventExecutionQueueRow[]; queued: Set<string> } {
  const queueRows: EventExecutionQueueRow[] = [];
  const queued = new Set<string>();
  return {
    queueRows, queued,
    async loadActiveReservations() { return reservations.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING"); },
    async loadQueuedReservationIds() { return new Set(queued); },
    async markReservationsExpired() {},
    async markReservationSkipped(id) { const r = reservations.find((x) => x.id === id); if (r) r.status = "SKIPPED"; },
    async insertQueueRow(row) { queueRows.push(row); if (row.reservation_id) queued.add(row.reservation_id); },
    async markReservationQueued(id) { const r = reservations.find((x) => x.id === id); if (r) r.status = "QUEUED"; },
  };
}
async function run(on: boolean | undefined, rows: Row[] = [A, B], books = LIVE, o: { repo?: ReturnType<typeof repoOf>; res?: NightEventReservationRow } = {}) {
  const res = o.res ?? reservation();
  const repo = o.repo ?? repoOf([res]);
  const u = universes(rows);
  const d = deps(books);
  const result = await runEventRebalance(NOW, { write: true }, {
    repo, readFinalT3Universe: async () => u.t10, readT30Universe: async () => u.t30,
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
  assert.equal(c.price_authority_version, "T30_EXACT_BID_ANCHOR_V1");
  assert.equal(c.price_authority_observation_id, "T30_BOOK:T_MINUS_30-run:b-token:Yes");
  assert.equal(c.p_buy_max, 0.53);
  assert.equal(c.token_id, "b-token");
  assert.equal(c.stake_usd, 2.5);
  assert.equal(c.latest_entry_iso, "2026-07-19T18:57:00.000Z");
  assert.equal(c.taker.price_limit, 0.51);
  assert.equal(c.taker.authorized_raw_vwap, 0.5);
  assert.equal(c.taker.authorized_effective_cost, 0.5125);
  assert.equal(c.taker.fee_rate, 0.05);
  assert.equal(c.tick_size, 0.01);
  assert.equal(row.diagnostics.max_entry_price, 0.51, "Ireland price cap = fee-inclusive limit <= P_BUY_MAX");
  assert.ok(!JSON.stringify(row.diagnostics).includes("\"asks\""), "no raw ladder persisted");
  const wire = mapQueueRowToIrelandCandidate(row, NOW);
  assert.equal(wire.execution_mode, "TAKER");
  assert.equal(wire.max_entry_price, 0.51);
  // Re-run: same reservation can never produce a second row.
  res.status = "REBALANCE_PENDING";
  const again = await run(true, [A, B], LIVE, { repo, res });
  assert.equal(again.result.already_queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
});

test("MAKER_FIRST is never queued and never translated into TAKER (Ireland contract lacks primary maker)", async () => {
  const { result, repo } = await run(true, [A]);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(result.queued_count, 0);
  assert.match(result.outcomes.map((o) => o.reason).join(","), /MAKER_FIRST_AWAITING_IRELAND_COMPATIBILITY/);
});

test("21: activation OFF (default and explicit) preserves released B priority + LIVE_GUARD", async () => {
  assert.equal(isT10EconomicActivationOn({}), false);
  assert.equal(isT10EconomicActivationOn({ T10_ECONOMIC_ACTION_ACTIVATION: "on" }), false);
  assert.equal(isT10EconomicActivationOn({ T10_ECONOMIC_ACTION_ACTIVATION: "ON" }), true);
  for (const on of [false, undefined]) {
    // B priority picks SPREADS (a-token); released LIVE_GUARD passes (spread 0.02).
    const { repo, d } = await run(on);
    assert.equal(repo.queueRows.length, 1);
    assert.equal(repo.queueRows[0].token_id, "a-token");
    assert.equal(repo.queueRows[0].diagnostics.source_authority, "COMPLETED_T3_AB_FINAL_IDENTITY");
    assert.equal(repo.queueRows[0].diagnostics.max_entry_price, 0.54);
    assert.deepEqual(d.calls, ["a-token"], "OFF never touches the economic evidence path");
  }
  // OFF: released raw spread gate still rejects B alone (spread 0.05).
  const { repo } = await run(false, [B]);
  assert.equal(repo.queueRows.length, 0);
});
