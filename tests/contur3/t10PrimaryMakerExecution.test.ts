// T10 primary-maker callbacks, fallback isolation and T10 fallback price authority.
//   node --import tsx --test tests/contur3/t10PrimaryMakerExecution.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMakerFallbackCommand,
  evaluateMakerEligibility,
  normalizeMakerCallbackForAccounting,
  readExecutionAttempts,
  readIrelandExecutionResult,
  recordResultAndAuthorizeMaker,
  t10MakerLimitPrice,
  type MakerFallbackCommand,
  type MakerFallbackPort,
} from "../../lib/executor/makerFallbackAuthorization";
import { makerLimitPrice } from "../../lib/executor/t10EconomicActivation";
import { handleOrderEventSubmission, type OrderEventDbPort, type StoredOrderEvent } from "../../lib/executor/executorCallbackContract";
import type { EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

const NOW = new Date("2026-10-01T18:00:00.000Z");
const IDEM = "idem_t10_1";
const EVENT = "provider:polymarket:777:2026-10-01";

function contract(mode: "TAKER_FIRST" | "MAKER_FIRST", over: Record<string, unknown> = {}) {
  return {
    execution_policy_version: "T10_ECONOMIC_ACTION_EXECUTION_V1", economic_policy_version: "T10_ECONOMIC_ACTION_POLICY_V1",
    execution_mode: mode, price_authority_version: "T30_EXACT_BID_ANCHOR_V1", price_authority_observation_id: "T30_BOOK:run:tok1:YES",
    p_buy_max: 0.5, reference_status: "STRONG", physical_event_id: EVENT, condition_id: "cond1", token_id: "tok1", side: "YES",
    market_family: "TOTALS", stake_usd: 2.5, hard_price_cap: 0.54, latest_entry_iso: "2026-10-01T18:50:00.000Z",
    tick_size: 0.01, minimum_order_size: 5, spread_telemetry: 0.02, activation_switch: "T10_ECONOMIC_ACTION_ACTIVATION",
    taker: mode === "TAKER_FIRST" ? { price_limit: 0.49 } : null,
    maker: mode === "MAKER_FIRST" ? { maker_limit_price: 0.5, maker_shares: 5 } : null,
    ...over,
  };
}

function queueRow(mode: "TAKER_FIRST" | "MAKER_FIRST" | null, over: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res1", plan_run_id: "plan1", rebalance_run_id: "rb1", match_family_key: EVENT,
    event_title: "A v B", event_slug: "a-v-b", sport: "soccer", league: "x", game_start_iso: "2026-10-01T19:00:00.000Z",
    condition_id: "cond1", token_id: "tok1", side: "YES", market_slug: "m", market_title: "m", market_family: "TOTALS",
    score: null, coverage: null, tier: "TIER1", stake_usd: 2.5, preferred_entry_iso: "2026-10-01T17:00:00.000Z",
    latest_entry_iso: "2026-10-01T18:50:00.000Z", selection_rank: 1, selection_reason: null, status: "SENT",
    order_key: "k", idempotency_key: IDEM,
    diagnostics: {
      physical_event_id: EVENT, max_entry_price: mode === "MAKER_FIRST" ? 0.5 : mode === "TAKER_FIRST" ? 0.49 : 0.54,
      max_stake_usd: 4, ...(mode ? { t10_economic_action_v1: contract(mode) } : {}),
    },
    ...over,
  };
}

function fakePort(row: EventExecutionQueueRow, book: { bestBid: number | null; bestAsk: number | null; tickSize: number | null; minimumOrderSize?: number | null } = { bestBid: 0.3, bestAsk: 0.52, tickSize: 0.01 }) {
  const state = { row, claims: 0, slots: [] as string[] };
  const port: MakerFallbackPort = {
    async loadQueueRowByIdempotencyKey(k) { return k === IDEM ? structuredClone(state.row) : null; },
    async fetchBook() { return book; },
    async recordResult(_id, slot, result) {
      state.slots.push(slot);
      const a = readExecutionAttempts(state.row.diagnostics);
      state.row = { ...state.row, diagnostics: { ...state.row.diagnostics, execution_attempts_v1: { ...a, [slot]: { result } } } };
    },
    async claimMakerFallback(_id, command: MakerFallbackCommand) {
      const a = readExecutionAttempts(state.row.diagnostics);
      if (a.maker_fallback_1?.command) return false;
      state.claims++;
      state.row = { ...state.row, diagnostics: { ...state.row.diagnostics, execution_attempts_v1: { ...a, maker_fallback_1: { command } } } };
      return true;
    },
  };
  return { port, state };
}

const primary = (outcome: string, v1: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES",
  stake_usd: 2.5, submitted_size: 5, submitted_price: 0.5, clob_order_id: "v-1",
  execution_result_v1: { attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST", outcome, venue_order_id: "v-1", requested_quantity: 5, ...v1 },
  ...extra,
});

const OUTCOMES = [
  "FULL_FILL", "PARTIAL_FILL", "PARTIAL_FILL_CANCELLED", "PARTIAL_FILL_EXPIRED", "PROVEN_ZERO_FILL_CANCELLED",
  "PROVEN_ZERO_FILL_EXPIRED", "PROVEN_REJECTED_BEFORE_SUBMISSION", "UNKNOWN_AFTER_SUBMISSION", "UNKNOWN_TRANSPORT",
];

// ── 1. primary maker callback ───────────────────────────────────────────────

test("primary MAKER_FIRST: every released execution_result_v1.outcome is consumed on the maker_first slot, never a fallback", async () => {
  for (const outcome of OUTCOMES) {
    const filled = outcome.startsWith("PROVEN_") ? 0 : outcome.startsWith("UNKNOWN") ? null : outcome === "FULL_FILL" ? 5 : 2;
    const f = fakePort(queueRow("MAKER_FIRST"));
    const out = await recordResultAndAuthorizeMaker(f.port, primary(outcome, { filled_quantity: filled, fee_usd: 0 }), NOW);
    assert.deepEqual(out, { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_first" }, outcome);
    assert.deepEqual(f.state.slots, ["maker_first"]);
    assert.equal(f.state.claims, 0, "MAKER_FIRST never authorizes MAKER_FALLBACK_1");
    const r = readExecutionAttempts(f.state.row.diagnostics).maker_first!.result!;
    assert.equal(r.result_class, outcome);
    assert.equal(r.filled_quantity, filled, "venue-reported only");
    // Partial, positive fill or UNKNOWN never means zero exposure.
    assert.equal(r.economic_exposure_proven_zero, outcome.startsWith("PROVEN_") ? true : outcome.startsWith("UNKNOWN") ? null : false);
  }
});

test("primary MAKER_FIRST callback is rejected unless the Queue froze MAKER_FIRST and identity/price/quantity match", async () => {
  const cases: Array<[EventExecutionQueueRow, Record<string, unknown>, string]> = [
    [queueRow("TAKER_FIRST"), primary("FULL_FILL"), "PRIMARY_MAKER_NOT_FROZEN_ON_QUEUE_ROW"],
    [queueRow(null), primary("FULL_FILL"), "PRIMARY_MAKER_NOT_FROZEN_ON_QUEUE_ROW"],
    [queueRow("MAKER_FIRST"), primary("FULL_FILL", {}, { token_id: "tok2" }), "PRIMARY_MAKER_IDENTITY_MISMATCH"],
    [queueRow("MAKER_FIRST"), primary("FULL_FILL", {}, { side: undefined }), "PRIMARY_MAKER_IDENTITY_MISMATCH"],
    [queueRow("MAKER_FIRST"), primary("FULL_FILL", {}, { submitted_price: 0.51 }), "PRIMARY_MAKER_PRICE_ABOVE_FROZEN_LIMIT"],
    [queueRow("MAKER_FIRST"), primary("FULL_FILL", { requested_quantity: 5.5 }), "PRIMARY_MAKER_QUANTITY_ABOVE_FROZEN_SHARES"],
    [queueRow("MAKER_FIRST"), primary("FULL_FILL", { attempt_id: "MAKER_FALLBACK_1" }), "PRIMARY_MAKER_ATTEMPT_IDENTITY_INVALID"],
    [queueRow("MAKER_FIRST"), primary("FULL_FILL", {}, { execution_mode: "TAKER" }), "PRIMARY_MAKER_ATTEMPT_IDENTITY_INVALID"],
    [queueRow("MAKER_FIRST"), primary("FULL_FILL", {}, { idempotency_key: "other" }), "PRIMARY_MAKER_QUEUE_ROW_NOT_FOUND"],
    [queueRow("MAKER_FIRST", { diagnostics: { ...queueRow("MAKER_FIRST").diagnostics, max_entry_price: 0.54 } }), primary("FULL_FILL"), "PRIMARY_MAKER_FROZEN_CONTRACT_INVALID"],
  ];
  for (const [row, raw, reason] of cases) {
    const f = fakePort(row);
    const out = await recordResultAndAuthorizeMaker(f.port, raw, NOW);
    assert.deepEqual(out, { kind: "MAKER_CALLBACK_REJECTED", reason }, reason);
    assert.deepEqual(f.state.slots, [], "rejected before any mutation");
  }
});

test("primary MAKER_FIRST accounting: only venue-reported fill and fee facts survive", () => {
  const partial = normalizeMakerCallbackForAccounting(primary("PARTIAL_FILL_CANCELLED",
    { filled_quantity: 2, average_fill_price: 0.5, fee_usd: 0 }, { order_status: "CANCELLED" }));
  assert.equal(partial.executed_shares, 2);
  assert.equal(partial.average_fill_price, 0.5);
  assert.equal(partial.executed_notional_usd, 1);
  assert.equal(partial.fee_usd, 0);
  const zero = normalizeMakerCallbackForAccounting(primary("PROVEN_ZERO_FILL_EXPIRED",
    { filled_quantity: 0 }, { executed_size: 5, filled_price: 0.5, order_status: "matched" }));
  assert.equal(zero.executed_size, undefined);
  assert.equal(zero.filled_price, undefined);
  assert.equal(zero.order_status, "unfilled");
  const noFee = normalizeMakerCallbackForAccounting(primary("FULL_FILL", { filled_quantity: 5, average_fill_price: 0.5 }));
  assert.equal("fee_usd" in noFee, false, "fee never invented");
});

// ── order-event contract: frozen mode is binding ───────────────────────────

function orderPort(row: EventExecutionQueueRow) {
  const st = { row, statuses: [] as string[] };
  const port: OrderEventDbPort = {
    async findQueueRowByIdempotencyKey(k) { return k === st.row.idempotency_key ? structuredClone(st.row) : null; },
    async findOrderEventByIdempotencyKey() { return null; },
    async findOrderEventByClobOrderId() { return null; },
    async updateQueueRowStatus(_id, patch) { st.statuses.push(patch.status); st.row = { ...st.row, status: patch.status as never }; },
    async insertOrderEvent(raw) {
      const ev: StoredOrderEvent = { id: "e1", created_at: NOW.toISOString(), idempotency_key: raw.idempotency_key as string,
        condition_id: "cond1", token_id: "tok1", side: "YES", selected_side: null, market_slug: null,
        submitted_size: raw.submitted_size as number, submitted_price: raw.submitted_price as number, clob_order_id: raw.clob_order_id as string };
      return { ok: true, row: ev };
    },
    async updateOrderEventProgression() { throw new Error("unused"); },
  };
  return { port, st };
}

test("order events: MAKER_FIRST row accepts only its primary maker; primary maker never lands on a TAKER row", async () => {
  const taker = { idempotency_key: IDEM, queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES",
    stake_usd: 2.5, submitted_size: 5, submitted_price: 0.5, clob_order_id: "v-1" };
  const a = orderPort(queueRow("MAKER_FIRST", { status: "READY" }));
  assert.deepEqual(await handleOrderEventSubmission(a.port, taker),
    { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "MAKER_FIRST_ROW_REQUIRES_PRIMARY_MAKER_ATTEMPT" });
  const b = orderPort(queueRow("TAKER_FIRST", { status: "READY" }));
  assert.deepEqual(await handleOrderEventSubmission(b.port, primary("FULL_FILL")),
    { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "PRIMARY_MAKER_NOT_FROZEN_ON_QUEUE_ROW" });
  const c = orderPort(queueRow("MAKER_FIRST", { status: "READY" }));
  assert.deepEqual(await handleOrderEventSubmission(c.port, primary("FULL_FILL", {}, { submitted_size: 5.2 })),
    { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "PRIMARY_MAKER_SIZE_ABOVE_FROZEN_SHARES" });
  // A partial fill whose remainder was cancelled is an executed order, never FAILED.
  const d = orderPort(queueRow("MAKER_FIRST", { status: "READY" }));
  const out = await handleOrderEventSubmission(d.port, primary("PARTIAL_FILL_CANCELLED", { filled_quantity: 2 }, { order_status: "CANCELLED" }));
  assert.equal(out.kind, "INSERTED");
  assert.deepEqual(d.st.statuses, ["EXECUTED"]);
});

// ── 2. fallback isolation ───────────────────────────────────────────────────

const takerZero = (over: Record<string, unknown> = {}) => ({
  idempotency_key: IDEM, condition_id: "cond1", token_id: "tok1", side: "YES",
  execution_result_v1: { attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER", outcome: "PROVEN_ZERO_FILL_CANCELLED",
    requested_quantity: 5, filled_quantity: 0, ...over },
});

test("a MAKER_FIRST Queue row can never authorize MAKER_FALLBACK_1", async () => {
  const f = fakePort(queueRow("MAKER_FIRST"));
  const out = await recordResultAndAuthorizeMaker(f.port, takerZero(), NOW);
  assert.deepEqual(out, { kind: "MAKER_BLOCKED", reasons: ["PRIMARY_MAKER_ROW_NO_FALLBACK"] });
  assert.deepEqual(f.state.slots, [], "a TAKER result is never recorded on a MAKER_FIRST row");
  const r = readIrelandExecutionResult(takerZero().execution_result_v1 as Record<string, unknown> & object, NOW.toISOString());
  assert.equal(r, null, "outcome is read only from the execution_result_v1 envelope");
  const verdict = evaluateMakerEligibility({ result: readIrelandExecutionResult(takerZero(), NOW.toISOString()), queue: queueRow("MAKER_FIRST"), nowMs: NOW.getTime() });
  assert.ok(verdict.reasons.includes("PRIMARY_MAKER_ROW_NO_FALLBACK"));
});

test("MAKER_FALLBACK_1 requires TAKER_ATTEMPT_1 + authoritative terminal ZERO (released outcome)", async () => {
  for (const [over, ok] of [
    [{}, true],
    [{ outcome: "PROVEN_ZERO_FILL_EXPIRED" }, true],
    [{ outcome: "PARTIAL_FILL_CANCELLED", filled_quantity: 1 }, false],
    [{ outcome: "UNKNOWN_AFTER_SUBMISSION", filled_quantity: null }, false],
    [{ outcome: "UNKNOWN_TRANSPORT", filled_quantity: 0 }, false],
    [{ filled_quantity: null }, false],
    [{ economic_exposure_proven_zero: false }, false],
    [{ terminal: false }, false],
  ] as const) {
    const f = fakePort(queueRow("TAKER_FIRST"), { bestBid: 0.3, bestAsk: 0.52, tickSize: 0.01 });
    const out = await recordResultAndAuthorizeMaker(f.port, takerZero(over), NOW);
    assert.equal(out.kind === "MAKER_AUTHORIZED", ok, JSON.stringify(over));
  }
});

// ── 6. T10 fallback price authority ─────────────────────────────────────────

test("T10 fallback price = floor_tick(min(P_BUY_MAX, ask - tick, parent cap, 0.54)), never bestBid + tick", async () => {
  // P_BUY_MAX 0.50, parent cap 0.49 (fee-inclusive taker limit), ask 0.52, bid 0.30 -> 0.49, not 0.31.
  const cmd = (row: EventExecutionQueueRow, book: Parameters<typeof buildMakerFallbackCommand>[0]["book"]) =>
    buildMakerFallbackCommand({ queue: row, book, deadlineIso: "2026-10-01T18:50:00.000Z", nowIso: NOW.toISOString() });
  const book = { bestBid: 0.3, bestAsk: 0.52, tickSize: 0.01 };
  const lowMin = queueRow("TAKER_FIRST", { diagnostics: { ...queueRow("TAKER_FIRST").diagnostics, t10_economic_action_v1: contract("TAKER_FIRST", { minimum_order_size: 5 }) } });
  const a = cmd(lowMin, book);
  assert.ok(a.ok);
  assert.equal(a.ok && a.command.limit_price, 0.49);
  assert.equal(a.ok && a.command.quantity, 5.1);
  assert.equal(a.ok && a.command.stake_usd, 2.5, "stake never increased");
  // ask - tick binds below P_BUY_MAX.
  const b = cmd(lowMin, { bestBid: 0.3, bestAsk: 0.47, tickSize: 0.01 });
  assert.equal(b.ok && b.command.limit_price, 0.46);
  // P_BUY_MAX binds below the parent cap.
  const pb = queueRow("TAKER_FIRST", { diagnostics: { ...queueRow("TAKER_FIRST").diagnostics, max_entry_price: 0.54, t10_economic_action_v1: contract("TAKER_FIRST", { p_buy_max: 0.45 }) } });
  assert.equal((cmd(pb, book) as { ok: true; command: MakerFallbackCommand }).command.limit_price, 0.45);
  // Minimum order: below-minimum and unknown fail closed; quantity never inflated.
  const highMin = queueRow("TAKER_FIRST", { diagnostics: { ...queueRow("TAKER_FIRST").diagnostics, t10_economic_action_v1: contract("TAKER_FIRST", { minimum_order_size: 6 }) } });
  assert.deepEqual(cmd(highMin, book), { ok: false, reason: "BELOW_MINIMUM_ORDER_SIZE" });
  assert.deepEqual(cmd(lowMin, { ...book, minimumOrderSize: 5.5 }), { ok: false, reason: "BELOW_MINIMUM_ORDER_SIZE" });
  assert.deepEqual(cmd(lowMin, { ...book, minimumOrderSize: Number.NaN }), { ok: false, reason: "MINIMUM_ORDER_SIZE_UNKNOWN" });
  const noMin = queueRow("TAKER_FIRST", { diagnostics: { ...queueRow("TAKER_FIRST").diagnostics, t10_economic_action_v1: contract("TAKER_FIRST", { minimum_order_size: null }) } });
  assert.deepEqual(cmd(noMin, book), { ok: false, reason: "T10_CONTRACT_INVALID" });
  // Tick drift / incomplete book fail closed.
  assert.deepEqual(cmd(lowMin, { ...book, tickSize: 0.001 }), { ok: false, reason: "T10_TICK_CHANGED" });
  assert.deepEqual(cmd(lowMin, { ...book, bestAsk: null }), { ok: false, reason: "T10_BOOK_INCOMPLETE" });
  // Legacy non-T10 rows keep bestBid + tick.
  const legacy = cmd(queueRow(null), { bestBid: 0.48, bestAsk: 0.5, tickSize: 0.01 });
  assert.equal(legacy.ok && legacy.command.limit_price, 0.49);
});

test("T10 fallback end-to-end: zero-proof TAKER_ATTEMPT_1 on a T10 row authorizes a P_BUY_MAX-bound maker on the same token", async () => {
  const f = fakePort(queueRow("TAKER_FIRST"), { bestBid: 0.3, bestAsk: 0.52, tickSize: 0.01, minimumOrderSize: 5 });
  const out = await recordResultAndAuthorizeMaker(f.port, takerZero(), NOW);
  assert.equal(out.kind, "MAKER_AUTHORIZED");
  const c = (out as { command: MakerFallbackCommand }).command;
  assert.deepEqual([c.token_id, c.condition_id, c.side, c.limit_price, c.stake_usd], ["tok1", "cond1", "YES", 0.49, 2.5]);
  assert.ok(c.limit_price <= 0.5 && c.limit_price <= 0.54);
});

test("callback-side maker formula is identical to the frozen policy formula", () => {
  for (const [p, a, t, cap] of [[0.5, 0.52, 0.01, 0.54], [0.53, 0.5, 0.01, 0.54], [0.537, 0.6, 0.001, 0.54], [0.2, 0.2, 0.01, 0.54], [0.5, 0.52, 0, 0.54]]) {
    assert.equal(t10MakerLimitPrice(p, a, t, cap), makerLimitPrice(p, a, t, cap));
  }
});
