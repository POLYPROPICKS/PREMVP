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
import {
  mapQueueRowToIrelandCandidate,
  primaryMakerSubmissionOpen,
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
// T-13.5: the production T10 decision lead (13.4-14.7 min), before primary_maker_cancel_by (T-12:40).
const NOW = Date.parse("2026-07-19T18:46:30.000Z");          // latest entry T-3
const AFTER_LATEST = Date.parse("2026-07-19T18:58:00.000Z");
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
  // Live ask 0.52 => maker limit 0.51 (inside the TOTALS band); an ask of 0.50 would give 0.49 (odds 2.04, outside).
  const { event } = await decide([weak], { d: deps({ "b-token": bookOf("b-token", [[0.45, 100]], [[0.52, 10], [0.60, 100]]) }) });
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

test("MAKER_FIRST is queued as an explicit primary-maker instruction, never translated into TAKER", async () => {
  const { result, repo } = await run(true, [A]);
  assert.equal(result.queued_count, 1);
  const row = repo.queueRows[0];
  assert.equal(row.selection_reason, "T10_ECONOMIC_ACTION_MAKER_FIRST_V1");
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  assert.equal(c.execution_mode, "MAKER_FIRST");
  assert.equal(c.taker, null);
  assert.deepEqual(c.maker, { maker_limit_price: 0.5, maker_shares: 5 });
  assert.equal(c.minimum_order_size, 5);
  assert.equal(row.stake_usd, 2.5, "stake never increased");
  assert.equal(row.diagnostics.max_entry_price, 0.5, "price cap = frozen maker limit <= P_BUY_MAX");
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
  assert.equal(wire.price_authority_version, "T30_EXACT_BID_ANCHOR_V1");
  assert.equal(wire.price_authority_observation_id, "T30_BOOK:T_MINUS_30-run:a-token:Yes");
  assert.equal(Date.parse(wire.latest_entry_iso), Date.parse("2026-07-19T18:57:00.000Z"));
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
    [[A], { ...LIVE, "a-token": bookOf("a-token", [[0.50, 100]], [[0.52, 100]], 0.01, null) }, /T10_ECON_GUARD_MIN_ORDER_SIZE_UNKNOWN/],
    // 9 shares x 0.50 = $4.50 > $4.00 ceiling.
    [[A], { ...LIVE, "a-token": bookOf("a-token", [[0.50, 100]], [[0.52, 100]], 0.01, 9) }, /T10_ECON_GUARD_MIN_ORDER_HEADROOM_ABOVE_MAX_STAKE/],
    [[B], { ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]], 0.01, null) }, /T10_ECON_GUARD_MIN_ORDER_SIZE_UNKNOWN/],
    [[B], { ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]], 0.01, 9) }, /T10_ECON_GUARD_MIN_ORDER_HEADROOM_ABOVE_MAX_STAKE/],
    // Insufficient taker depth after resize: $2.50 fills, but only 5.5 shares <= limit exist for a minimum of 6.
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

// ── LIVE_EXECUTION_FINAL_ACTIVATION_V1: adaptive minimum-order headroom + MAKER_FIRST timing ──

// M: STRONG, P_BUY_MAX 0.53, live ask 0.54 -> maker limit 0.53; taker limit 0.51 has no depth -> MAKER_FIRST.
const M: Row = { cond: "m-ml", token: "m-token", family: "MONEYLINE", type: "MONEYLINE", t10: [0.52, 0.54], t30: [0.53, 0.54] };
const mBook = (min: number | null = 5) => ({ ...LIVE, "m-token": bookOf("m-token", [[0.52, 100]], [[0.54, 100]], 0.01, min) });
const LATEST_ENTRY = "2026-07-19T18:57:00.000Z";
const CANCEL_BY = "2026-07-19T18:47:20.000Z";                // latest_entry - 580 s = kickoff - 12m40s

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

test("FULL PATH: Reservation -> T30 -> T10 -> $2.50 fails ONLY minimum size -> $2.65 -> Queue -> MAKER_FIRST timing -> terminal ZERO -> one fallback on the wire", async () => {
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
  assert.equal(row.latest_entry_iso, LATEST_ENTRY, "latest_entry unchanged");
  for (const [k, v] of Object.entries({ base_stake_usd: 2.5, authorized_stake_usd: 2.65, max_stake_usd: 4,
    stake_adjustment_reason: "VENUE_MINIMUM_ORDER_SIZE", minimum_order_size: 5, required_minimum_notional_usd: 2.65, max_entry_price: 0.53 })) {
    assert.equal(row.diagnostics[k], v, k);
  }
  assert.ok((row.diagnostics.mechanical_guard_trace as string[]).includes("MIN_ORDER_HEADROOM_STAKE_APPLIED"));
  assert.ok(readT10FrozenContract(row).ok);
  // Ireland-facing MAKER_FIRST candidate (timestamptz read-back form).
  const wire = mapQueueRowToIrelandCandidate({ ...row, status: "READY", latest_entry_iso: "2026-07-19T18:57:00+00:00" }, NOW);
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

  // Terminal proven ZERO -> result recorded -> zero exposure re-verified -> exactly one MAKER_FALLBACK_1.
  const w = fallbackWorld(row);
  const callbackNow = new Date(Date.parse(CANCEL_BY) + 5_000);
  const auth = await recordResultAndAuthorizeMaker(w.port, primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), callbackNow);
  assert.equal(auth.kind, "MAKER_AUTHORIZED");
  assert.equal(fallbackPublicationRetryable(auth), false, "published -> callback may be acknowledged");
  const dup = await recordResultAndAuthorizeMaker(w.port, primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), callbackNow);
  assert.equal(dup.kind, "MAKER_ALREADY_AUTHORIZED");
  assert.equal(w.st.claims, 1, "duplicate terminal ZERO -> one fallback only");
  // Visible through maker_fallback_commands with the exact released wire shape.
  const cmds = selectExecutorMakerFallbackCommands([w.st.row], callbackNow.getTime());
  assert.equal(cmds.length, 1);
  const cmd = cmds[0];
  assert.deepEqual(Object.keys(cmd).sort(), WIRE_FALLBACK_COMMAND_KEYS);
  assert.equal(cmd.attempt_id, "MAKER_FALLBACK_1");
  assert.equal(cmd.parent_attempt_id, "MAKER_FIRST");
  assert.deepEqual([cmd.condition_id, cmd.token_id, cmd.side, cmd.physical_event_id], [row.condition_id, row.token_id, row.side, EVENT]);
  assert.equal(cmd.stake_usd, 2.65, "inherits the parent authorized stake, never more");
  assert.equal(cmd.max_stake_usd, 4);
  assert.equal(cmd.limit_price, 0.53);
  assert.equal(cmd.quantity, 5);
  assert.ok(cmd.quantity * cmd.limit_price <= cmd.stake_usd + 1e-6);
  assert.equal(cmd.deadline_iso, LATEST_ENTRY, "fallback never beyond latest_entry");
  assert.equal(selectExecutorMakerFallbackCommands([w.st.row], Date.parse(LATEST_ENTRY)).length, 0);
});

test("normal $2.50 regression: required stake <= $2.50 stays exactly $2.50 with no adjustment (MAKER and TAKER)", async () => {
  const maker = await run(true, [A]);
  const m = maker.repo.queueRows[0];
  assert.equal(m.stake_usd, 2.5);
  assert.equal(m.diagnostics.stake_adjustment_reason, null);
  assert.equal(m.diagnostics.authorized_stake_usd, 2.5);
  assert.equal((m.diagnostics.t10_economic_action_v1 as any).stake_authorization.required_minimum_notional_usd, 2.5);
  assert.ok(!(m.diagnostics.mechanical_guard_trace as string[]).includes("MIN_ORDER_HEADROOM_STAKE_APPLIED"));
  const taker = await run(true, [A, B]);
  const t = taker.repo.queueRows[0];
  assert.equal(t.selection_reason, "T10_ECONOMIC_ACTION_TAKER_FIRST_V1");
  assert.equal(t.stake_usd, 2.5);
  assert.equal(t.diagnostics.stake_adjustment_reason, null);
});

test("headroom between $2.50 and $4.00 authorizes the EXACT minimum sufficient stake (MAKER and TAKER re-walk)", async () => {
  for (const [min, stake] of [[6, 3], [5.5, 2.75], [7.99, 4]] as const) {
    const { repo } = await run(true, [A], { ...LIVE, "a-token": bookOf("a-token", [[0.50, 100]], [[0.52, 100]], 0.01, min) });
    const row = repo.queueRows[0];
    assert.equal(row.stake_usd, stake, `min ${min}`);
    assert.equal((row.diagnostics.t10_economic_action_v1 as any).maker.maker_shares >= min, true);
    assert.ok(readT10FrozenContract(row).ok);
  }
  // TAKER: $2.50 fills 5 shares at 0.50 < minimum 6 -> the ACTUAL $3.00 is re-walked on the book.
  const { repo } = await run(true, [B], { ...LIVE, "b-token": bookOf("b-token", [[0.45, 100]], [[0.50, 10], [0.60, 100]], 0.01, 6) });
  const row = repo.queueRows[0];
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  assert.equal(c.execution_mode, "TAKER_FIRST");
  assert.equal(row.stake_usd, 3);
  assert.equal(c.taker.authorized_raw_vwap, 0.5);
  assert.ok(c.taker.authorized_effective_cost <= c.p_buy_max, "fee-inclusive cost <= P_BUY_MAX at the increased stake");
  assert.ok(c.taker.price_limit <= c.p_buy_max && c.taker.price_limit <= 0.54);
  assert.equal(c.stake_authorization.stake_adjustment_reason, "VENUE_MINIMUM_ORDER_SIZE");
  assert.equal(c.stake_authorization.required_minimum_notional_usd, 3);
  assert.ok(readT10FrozenContract(row).ok);
  assert.equal(mapQueueRowToIrelandCandidate({ ...row, id: "q" }, NOW).execution_mode, "TAKER");
});

test("headroom never relaxes economics: P_BUY_MAX, the 0.54 cap and depth are proven before and after resize", async () => {
  // TAKER selected on a deep book, but at re-verification $2.50 is blocked by DEPTH (not minimum): never resized.
  const thinAtGuard = (n: number) => bookOf("b-token", [[0.45, 100]], n === 1 ? [[0.50, 10], [0.60, 100]] : [[0.50, 2], [0.60, 100]], 0.01, 6);
  const { result, repo } = await run(true, [B], { ...LIVE, "b-token": thinAtGuard } as never);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes.map((o) => o.reason).join(","), /T10_ECON_GUARD_FULL_STAKE_UNAVAILABLE/);
  // Price authority above P_BUY_MAX / 0.54 is rejected by the strict reader even with headroom evidence.
  const { repo: r2 } = await run(true, [M], mBook(5));
  const row = r2.queueRows[0];
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  for (const broken of [{ ...c, p_buy_max: 0.55 }, { ...c, maker: { maker_limit_price: 0.54, maker_shares: 5 } }]) {
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

test("timing: a T10 at/after primary_maker_cancel_by fails closed (reserve never weakened); after latest_entry nothing executes", async () => {
  for (const now of [Date.parse(CANCEL_BY), Date.parse("2026-07-19T18:50:00.000Z")]) {
    const { event, d } = await decide([A], { now });
    const g = await reverifySelectedAction({ event, nowMs: now, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
    assert.equal(g.ok, false);
    assert.match(!g.ok ? g.reason : "", /T10_ECON_GUARD_AFTER_PRIMARY_MAKER_CANCEL_BY/);
  }
  const late = Date.parse("2026-07-19T18:57:00.000Z");
  const { event, d } = await decide([A], { now: late });
  const g = await reverifySelectedAction({ event, nowMs: late, exposureExists: false, fetchExactTokenOrderbook: d.fetchExactTokenOrderbook });
  assert.equal(g.ok, false);
});

test("fallback blocking on the adaptive row: partial / positive / UNKNOWN never authorize; deterministic blocks are acknowledged", async () => {
  const { repo } = await run(true, [M], mBook(5));
  const row = { ...repo.queueRows[0], id: "q-adaptive", status: "EXECUTED" as const };
  const at = new Date(Date.parse(CANCEL_BY) + 5_000);
  for (const [outcome, extra] of [["PARTIAL_FILL_CANCELLED", { filled_quantity: 2, average_fill_price: 0.53 }], ["FULL_FILL", { filled_quantity: 5, average_fill_price: 0.53 }],
    ["UNKNOWN_AFTER_SUBMISSION", {}], ["PARTIAL_FILL", { filled_quantity: 1 }]] as const) {
    const w = fallbackWorld(row);
    const auth = await recordResultAndAuthorizeMaker(w.port, primaryCallback(row, outcome, extra), at);
    assert.notEqual(auth.kind, "MAKER_AUTHORIZED", outcome);
    assert.equal(w.st.claims, 0, outcome);
    assert.equal(selectExecutorMakerFallbackCommands([w.st.row], at.getTime()).length, 0);
  }
  // Transient publication failure is retryable (never acknowledged); a deterministic block is final.
  const noBook = fallbackWorld(row);
  noBook.port.fetchBook = async () => null;
  const blocked = await recordResultAndAuthorizeMaker(noBook.port, primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), at);
  assert.deepEqual(blocked, { kind: "MAKER_BLOCKED", reasons: ["BOOK_UNAVAILABLE"] });
  assert.equal(fallbackPublicationRetryable(blocked), true);
  assert.equal(fallbackPublicationRetryable({ kind: "MAKER_BLOCKED", reasons: ["AUTHORIZATION_ERROR"] }), true);
  assert.equal(fallbackPublicationRetryable({ kind: "MAKER_BLOCKED", reasons: ["DEADLINE_PASSED"] }), false);
  const lateZero = await recordResultAndAuthorizeMaker(fallbackWorld(row).port, primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), new Date(LATEST_ENTRY));
  assert.equal(lateZero.kind, "MAKER_BLOCKED");
  assert.equal(fallbackPublicationRetryable(lateZero), false);
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

test("LIVE BUG (DR Congo): ask 0.57 outside the old band => MAKER_FIRST limit 0.54; TAKER never pays 0.57", async () => {
  const { event } = await decide([DRC], { d: deps(drcBook()) });
  const ev = event.decision.evaluations[0];
  assert.equal(ev.priceAuthority.pBuyMax, 0.54, "P_BUY_MAX = min(T30 bid 0.56, cap 0.54)");
  assert.equal(ev.taker.eligible, false);
  assert.equal(ev.taker.rawVwap, null, "no taker fill at 0.57 or anywhere above P_BUY_MAX / 0.54");
  assert.equal(ev.maker.eligible, true);
  assert.equal(ev.maker.limitPrice, 0.54);
  assert.equal(event.decision.action, "MAKER_FIRST");
  assert.equal(ev.support.maker.MAKER_SUPPORT_PRICE_SOURCE, "MAKER_LIMIT");
  assert.equal(ev.support.maker.SUPPORT_PRICE, 0.54);
  assert.equal(ev.support.taker.TAKER_SUPPORT_PRICE_SOURCE, "EXECUTABLE_CURRENT_ASK");
  assert.equal(ev.support.taker.SUPPORT_PRICE, 0.57);
  assert.equal([ev.support.SUPPORT_BAND_MIN, ev.support.SUPPORT_BAND_MAX].join(".."), "1.7..2");
  // Re-verification keeps every price authority.
  const guard = await reverifySelectedAction({ event, nowMs: NOW, exposureExists: false, fetchExactTokenOrderbook: deps(drcBook()).fetchExactTokenOrderbook });
  assert.equal(guard.ok, true);
  if (guard.ok) {
    assert.equal(guard.contract.execution_mode, "MAKER_FIRST");
    assert.equal(guard.contract.maker!.maker_limit_price, 0.54);
    assert.ok(guard.contract.maker!.maker_limit_price <= guard.contract.p_buy_max);
    assert.ok(guard.contract.maker!.maker_limit_price <= guard.contract.hard_price_cap);
    assert.equal(guard.contract.taker, null);
  }
});

test("maker support is judged on maker_limit: limit odds outside the band => rejected even when the ask is inside", async () => {
  // Ask 0.50 (odds 2.00, inside) but the limit floor(min(P_BUY_MAX 0.50, 0.49)) = 0.49 (odds 2.04, outside).
  const row: Row = { cond: "ml-edge", token: "edge-token", family: "MONEYLINE", type: "MONEYLINE", t10: [0.49, 0.50], t30: [0.50, 0.51] };
  const book = { "edge-token": bookOf("edge-token", [[0.49, 100]], [[0.50, 100]], 0.01, 5) };
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

test("FULL PATH (MONEYLINE band + maker authority): Reservation -> T30 -> T10 ask 0.57 -> MAKER_FIRST 0.54 -> Queue -> Ireland wire -> terminal ZERO -> one fallback", async () => {
  const { result, repo, res } = await run(true, [DRC], drcBook());
  assert.equal(result.queued_count, 1);
  assert.equal(res.status, "QUEUED");
  const row = { ...repo.queueRows[0], id: "q-drc", status: "EXECUTED" as const };
  assert.equal(row.market_family, "MONEYLINE");
  const c = row.diagnostics.t10_economic_action_v1 as Record<string, any>;
  assert.equal(c.execution_mode, "MAKER_FIRST");
  assert.equal(c.p_buy_max, 0.54);
  assert.equal(c.hard_price_cap, 0.54);
  assert.deepEqual(c.maker, { maker_limit_price: 0.54, maker_shares: 5 });
  assert.equal(c.taker, null);
  // PR #462 adaptive headroom preserved: $2.50 buys 4.63 < 5 shares => smallest cent stake $2.70 (<= $4.00).
  assert.equal(c.stake_usd, 2.7);
  assert.equal(c.stake_authorization.base_stake_usd, 2.5);
  assert.equal(c.stake_authorization.max_stake_usd, 4);
  // Timing contract preserved.
  assert.equal(c.fallback_deadline_iso, LATEST_ENTRY);
  assert.equal(c.primary_maker_cancel_by_iso, CANCEL_BY);
  assert.equal(c.required_min_remaining_seconds, 580);
  // Auditable per-action support evidence.
  const audit = row.diagnostics.t10_support_audit_v1 as Record<string, any>;
  assert.equal(audit.maker.MAKER_SUPPORT_PRICE_SOURCE, "MAKER_LIMIT");
  assert.equal(audit.maker.SUPPORT_PRICE, 0.54);
  assert.ok(Math.abs(audit.maker.SUPPORT_DECIMAL_ODDS - 1.851852) < 1e-5);
  assert.equal(audit.taker.TAKER_SUPPORT_PRICE_SOURCE, "EXECUTABLE_CURRENT_ASK");
  assert.equal(audit.taker.SUPPORT_PRICE, 0.57);
  assert.equal(audit.SUPPORT_BAND_MIN, 1.7);
  assert.equal(audit.SUPPORT_BAND_MAX, 2);
  assert.ok(readT10FrozenContract(row).ok);
  // Ireland wire.
  const wire = mapQueueRowToIrelandCandidate({ ...row, status: "READY", latest_entry_iso: "2026-07-19T18:57:00+00:00" }, NOW);
  assert.equal(wire.execution_mode, "MAKER_FIRST");
  assert.equal(wire.maker_limit_price, 0.54);
  assert.equal(wire.price_cap, 0.54);
  assert.equal(wire.maker_shares, 5);
  assert.equal(wire.required_min_remaining_seconds, 580);
  assert.equal(primaryMakerSubmissionOpen(wire, NOW), true);
  // Terminal ZERO -> exactly one MAKER_FALLBACK_1.
  const w = fallbackWorld(row);
  const callbackNow = new Date(Date.parse(CANCEL_BY) + 5_000);
  const cb = { ...primaryCallback(row, "PROVEN_ZERO_FILL_CANCELLED"), submitted_price: 0.54 };
  const auth = await recordResultAndAuthorizeMaker(w.port, cb, callbackNow);
  assert.equal(auth.kind, "MAKER_AUTHORIZED");
  assert.equal(fallbackPublicationRetryable(auth), false);
  const dup = await recordResultAndAuthorizeMaker(w.port, cb, callbackNow);
  assert.equal(dup.kind, "MAKER_ALREADY_AUTHORIZED");
  assert.equal(w.st.claims, 1);
  const cmds = selectExecutorMakerFallbackCommands([w.st.row], callbackNow.getTime());
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].attempt_id, "MAKER_FALLBACK_1");
  assert.equal(cmds[0].limit_price <= 0.54, true);
  assert.equal(cmds[0].deadline_iso, LATEST_ENTRY);
});
