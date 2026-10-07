// UNKNOWN_TRANSPORT_CALLBACK_RECEIVER_V1 -- focused regression set (founder list A-I).
//   node --experimental-test-module-mocks --import tsx --test tests/contur3/unknownTransportCallbackReceiver.test.ts
//
//   A  exact historical Bahamas callback (UNKNOWN_TRANSPORT, venue_order_id null, no submitted_price, terminal=false)
//      -> accepted (route: HTTP 200), persisted, NEEDS_RECONCILIATION
//   B  same-shape duplicate -> idempotent, no second write
//   C  UNKNOWN_TRANSPORT never authorizes MAKER_FALLBACK_1
//   D  stale-claim sweep never expires it as CLAIM_LEASE_EXPIRED_NO_ORDER_EVENT
//   E  later terminal / partial fill -> monotonic upgrade, exposure preserved, no fallback
//   F  later terminal proven zero -> monotonic upgrade, exactly one MAKER_FALLBACK_1
//   G/H the submitted_price guard is untouched for every other shape (fill, zero class, malformed, maker, ...)
//   I  caps / envelope constants untouched
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAmbiguousTransportResult,
  isUnknownTransportNeedsReconciliationCallback,
  mergeAttemptResult,
  normalizeMakerCallbackForAccounting,
  isProvenRejectedBeforeSubmissionZero,
  readExecutionAttempts,
  readIrelandExecutionResult,
  recordResultAndAuthorizeMaker,
  selectExecutorMakerFallbackCommands,
  hasUnresolvedNeedsReconciliation,
  unknownTransportConsistentWithQueueRow,
  type MakerFallbackCommand,
  type MakerFallbackPort,
} from "../../lib/executor/makerFallbackAuthorization";
import { handleOrderEventSubmission, type OrderEventDbPort, type StoredOrderEvent } from "../../lib/executor/executorCallbackContract";
import {
  QUEUE_MAX_ENTRY_PRICE,
  validateOrderEventAgainstQueueRow,
  type EventExecutionQueueRow,
} from "../../lib/executor/executorQueueTypes";
import { reconcileStaleClaims, STALE_CLAIM_REASON, type StaleClaimRow } from "../../lib/executor/staleQueueClaims";

const KICKOFF = "2026-10-06T11:00:00.000Z";
const LATEST = "2026-10-06T11:03:00.000Z";
const FIRST_AT = new Date("2026-10-06T10:45:30.000Z");
const LATER_AT = new Date("2026-10-06T10:50:00.000Z");
const IDEM = "idem_unknown_transport";
const EVENT = "provider:polymarket:bahamas:2026-10-06";

function queueRow(over: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res1", plan_run_id: "plan1", rebalance_run_id: "rb1", match_family_key: EVENT,
    event_title: "A v B", event_slug: "a-v-b", sport: "soccer", league: "x", game_start_iso: KICKOFF,
    condition_id: "cond1", token_id: "tok1", side: "YES", market_slug: "m", market_title: "m", market_family: "TOTALS",
    score: null, coverage: null, tier: "TIER1", stake_usd: 2.5, preferred_entry_iso: "2026-10-06T10:15:00.000Z",
    latest_entry_iso: LATEST, selection_rank: 1, selection_reason: null, status: "CLAIMED",
    order_key: "k", idempotency_key: IDEM,
    diagnostics: { physical_event_id: EVENT, max_entry_price: 0.5, max_stake_usd: 4 },
    ...over,
  } as EventExecutionQueueRow;
}

/** The exact historical shape: no submitted_price, venue_order_id null, terminal=false, exposure unknown. */
const unknown = (extra: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5,
  result_class: "UNKNOWN_TRANSPORT", terminal: false, economic_exposure_proven_zero: null,
  filled_quantity: null, remaining_quantity: null, venue_order_id: null,
  ...extra,
});
const unknownV1 = (v1: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5,
  execution_result_v1: { attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER", outcome: "UNKNOWN_TRANSPORT", terminal: false,
    economic_exposure_proven_zero: null, filled_quantity: null, remaining_quantity: null, venue_order_id: null, ...v1 },
});
/** A later terminal positive fill of the same attempt (carries a venue order id and a submitted price). */
const fill = (extra: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5,
  result_class: "FULL_FILL", terminal: true, economic_exposure_proven_zero: false, filled_quantity: 5, average_fill_price: 0.5,
  venue_order_id: "0xfill", clob_order_id: "0xfill", submitted_price: 0.5, submitted_size: 5, order_status: "matched", success: true,
  ...extra,
});
/** A later terminal proven zero with a venue order id (cancelled, nothing filled). */
const zeroCancelled = (extra: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5,
  result_class: "PROVEN_ZERO_FILL_CANCELLED", terminal: true, economic_exposure_proven_zero: true, filled_quantity: 0,
  venue_order_id: "0xzero", clob_order_id: "0xzero", submitted_price: 0.5, submitted_size: 5, order_status: "CANCELLED", success: false,
  ...extra,
});

function world(row: EventExecutionQueueRow) {
  const st = { row, events: new Map<string, StoredOrderEvent & { raw: Record<string, unknown> }>(), claims: 0, markWrites: 0, statusWrites: [] as string[] };
  const book = { bestBid: 0.3, bestAsk: 0.53, tickSize: 0.01 };
  const maker: MakerFallbackPort = {
    async loadQueueRowByIdempotencyKey(k) { return k === IDEM ? structuredClone(st.row) : null; },
    async fetchBook() { return book; },
    async recordResult(_id, slot, result) {
      const a = readExecutionAttempts(st.row.diagnostics);
      const merged = mergeAttemptResult(a[slot]?.result, result);        // mirrors recordAttemptResultCas (monotonic)
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, [slot]: { ...(a[slot] ?? {}), result: merged } } } };
    },
    async claimMakerFallback(_id, command) {
      const a = readExecutionAttempts(st.row.diagnostics);
      if (a.maker_fallback_1?.command) return false;
      st.claims++;
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, maker_fallback_1: { command } } } };
      return true;
    },
  };
  const orders: OrderEventDbPort = {
    async findQueueRowByIdempotencyKey(k) { return k === IDEM ? structuredClone(st.row) : null; },
    async findOrderEventByIdempotencyKey(k) { return [...st.events.values()].find((e) => e.idempotency_key === k) ?? null; },
    async findOrderEventByClobOrderId(c) { return [...st.events.values()].find((e) => e.clob_order_id === c) ?? null; },
    async updateQueueRowStatus(_id, patch) {
      st.statusWrites.push(patch.status);
      const attempts = st.row.diagnostics.execution_attempts_v1;     // mirrors casWriteQueue: attempts come from the FRESH row
      st.row = { ...st.row, status: patch.status as never, diagnostics: { ...patch.diagnostics, ...(attempts ? { execution_attempts_v1: attempts } : {}) } };
    },
    async markNeedsReconciliation(_id, marker) {                      // mirrors the route's CAS port: status untouched
      if (st.row.status !== "CLAIMED" || !unknownTransportConsistentWithQueueRow(st.row)) return "NOT_CLAIMED";
      if (hasUnresolvedNeedsReconciliation(st.row.diagnostics)) return "ALREADY_MARKED";
      st.markWrites++;
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, needs_reconciliation_v1: marker, queue_mark_result: "NEEDS_RECONCILIATION" } };
      return "WRITTEN";
    },
    async insertOrderEvent(raw) {
      const n = st.events.size + 1;
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      const ev = { id: `e${n}`, created_at: FIRST_AT.toISOString(), idempotency_key: raw.idempotency_key as string,
        condition_id: raw.condition_id as string, token_id: raw.token_id as string, side: raw.side as string, selected_side: null,
        market_slug: null, submitted_size: num(raw.submitted_size), submitted_price: num(raw.submitted_price),
        clob_order_id: (raw.clob_order_id as string | undefined) ?? null, raw };
      st.events.set(ev.id, ev);
      return { ok: true as const, row: ev };
    },
    async updateOrderEventProgression(id, raw) { const next = { ...st.events.get(id)!, raw }; st.events.set(id, next); return next; },
  };
  return { st, maker, orders };
}
/** The route's callback pipeline: result recording / authorization first, then order-event handling. */
async function deliver(w: ReturnType<typeof world>, raw: Record<string, unknown>, now: Date = FIRST_AT) {
  const auth = await recordResultAndAuthorizeMaker(w.maker, raw, now);
  if (auth.kind === "MAKER_CALLBACK_REJECTED") return { auth, order: null };
  const order = await handleOrderEventSubmission(w.orders, normalizeMakerCallbackForAccounting(raw), {
    callbackProvedPreSubmissionZero: isProvenRejectedBeforeSubmissionZero(raw),
    nowIso: now.toISOString(),
  });
  return { auth, order };
}
const takerSlot = (w: ReturnType<typeof world>) => readExecutionAttempts(w.st.row.diagnostics).taker_attempt_1?.result;

// ═══ A. exact Bahamas shape ═════════════════════════════════════════════════════════════════════════════

test("A: the exact historical callback (UNKNOWN_TRANSPORT, venue_order_id null, no submitted_price, terminal=false) is accepted, persisted and NEEDS_RECONCILIATION", async () => {
  for (const [name, raw] of [["top-level", unknown()], ["execution_result_v1", unknownV1()]] as const) {
    assert.equal(isUnknownTransportNeedsReconciliationCallback(raw), true, name);
    const w = world(queueRow());
    const { auth, order } = await deliver(w, raw);
    assert.deepEqual(order, { kind: "NEEDS_RECONCILIATION", queue_id: "q1", duplicate: false }, `${name}: the route maps this to HTTP 200`);
    // typed NEEDS_RECONCILIATION on the existing diagnostics machinery: no new status, row stays CLAIMED
    assert.equal(w.st.row.status, "CLAIMED");
    assert.equal(hasUnresolvedNeedsReconciliation(w.st.row.diagnostics), true);
    assert.equal(w.st.row.diagnostics.queue_mark_result, "NEEDS_RECONCILIATION");
    const marker = w.st.row.diagnostics.needs_reconciliation_v1 as Record<string, unknown>;
    assert.deepEqual([marker.state, marker.reason, marker.attempt_id, marker.terminal, marker.economic_exposure_proven_zero, marker.venue_order_id],
      ["NEEDS_RECONCILIATION", "UNKNOWN_TRANSPORT", "TAKER_ATTEMPT_1", false, null, null]);
    // the attempt result is persisted monotonically on the taker slot -- NOT a fill, NOT a proven zero
    const slot = takerSlot(w);
    assert.equal(slot?.result_class, "UNKNOWN_TRANSPORT");
    assert.equal(slot?.terminal, false);
    assert.equal(slot?.economic_exposure_proven_zero, null);
    assert.equal(slot?.filled_quantity, null);
    // no order event / venue order / price is fabricated, nothing marked EXECUTED, no fallback
    assert.equal(w.st.events.size, 0);
    assert.equal(w.st.statusWrites.length, 0);
    assert.equal(auth.kind, "MAKER_BLOCKED");
  }
});

// ═══ B. duplicate ═══════════════════════════════════════════════════════════════════════════════════════

test("B: a same-shape duplicate is idempotent -- no second marker write, the recorded result is not rewritten, still no fallback", async () => {
  const w = world(queueRow());
  await deliver(w, unknown(), FIRST_AT);
  const firstSlot = structuredClone(takerSlot(w));
  const firstMarker = structuredClone(w.st.row.diagnostics.needs_reconciliation_v1);
  const again = await deliver(w, unknown(), LATER_AT);
  assert.deepEqual(again.order, { kind: "NEEDS_RECONCILIATION", queue_id: "q1", duplicate: true });
  assert.equal(w.st.markWrites, 1, "exactly one marker write");
  assert.deepEqual(takerSlot(w), firstSlot, "the recorded ambiguous result keeps its first received_at");
  assert.deepEqual(w.st.row.diagnostics.needs_reconciliation_v1, firstMarker);
  assert.equal(w.st.events.size, 0);
  assert.equal(w.st.claims, 0);
  assert.equal(w.st.row.status, "CLAIMED");
  // a concurrent burst still writes the marker exactly once
  const c = world(queueRow());
  const outs = await Promise.all([1, 2, 3].map(() => deliver(c, unknown())));
  assert.equal(outs.filter((o) => o.order?.kind === "NEEDS_RECONCILIATION").length, 3);
  assert.equal(c.st.markWrites, 1);
});

// ═══ C. no maker from UNKNOWN ═══════════════════════════════════════════════════════════════════════════

test("C: UNKNOWN_TRANSPORT never authorizes MAKER_FALLBACK_1 (not zero, not terminal), however often it is delivered", async () => {
  const w = world(queueRow());
  for (let i = 0; i < 3; i++) {
    const { auth } = await deliver(w, i % 2 ? unknownV1() : unknown());
    assert.equal(auth.kind, "MAKER_BLOCKED");
    assert.ok(auth.kind === "MAKER_BLOCKED" && auth.reasons.includes("RESULT_CLASS_CANNOT_PROVE_ZERO") && auth.reasons.includes("RESULT_NOT_TERMINAL") && auth.reasons.includes("ZERO_EXPOSURE_NOT_PROVEN"));
  }
  assert.equal(w.st.claims, 0);
  assert.equal(readExecutionAttempts(w.st.row.diagnostics).maker_fallback_1, undefined);
  assert.deepEqual(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], FIRST_AT.getTime()), []);
});

// ═══ D. stale-claim sweep ═══════════════════════════════════════════════════════════════════════════════

function sweepOf(row: EventExecutionQueueRow, hasEvent: boolean) {
  const expired: Array<{ id: string; diagnostics: Record<string, unknown> }> = [];
  const run = () => reconcileStaleClaims({
    async loadExpiredClaims() {
      return [{ id: "q1", status: row.status, latest_entry_iso: LATEST, idempotency_key: IDEM, condition_id: "cond1", token_id: "tok1", side: "YES", diagnostics: row.diagnostics } as StaleClaimRow];
    },
    async hasMatchingOrderEvent() { return hasEvent; },
    async expireClaim(r, _now, diagnostics) { expired.push({ id: r.id, diagnostics }); return true; },
  }, "2026-10-06T11:03:30.000Z", true);
  return { expired, run };
}

test("D: the stale-claim sweep preserves a persisted UNKNOWN_TRANSPORT / NEEDS_RECONCILIATION row (never CLAIM_LEASE_EXPIRED_NO_ORDER_EVENT)", async () => {
  const w = world(queueRow());
  const before = sweepOf(w.st.row, false);                    // control: before the callback is accepted the lease DOES expire
  const control = await before.run();
  assert.equal(control.expired_count, 1);
  assert.equal(before.expired[0].diagnostics.claim_expiry && (before.expired[0].diagnostics.claim_expiry as Record<string, unknown>).reason, STALE_CLAIM_REASON);

  await deliver(w, unknown());
  const after = sweepOf(w.st.row, false);                     // no order event exists for an ambiguous result
  const swept = await after.run();
  assert.deepEqual(after.expired, [], "not expired");
  assert.equal(swept.expired_count, 0);
  assert.equal((swept as Record<string, unknown>).protected_by_unresolved_transport, 1);
  assert.equal(w.st.row.status, "CLAIMED", "unresolved reconciliation state preserved");
  assert.equal(hasUnresolvedNeedsReconciliation(w.st.row.diagnostics), true);
});

// ═══ E. later fill upgrade ══════════════════════════════════════════════════════════════════════════════

test("E: UNKNOWN_TRANSPORT then a terminal / partial positive fill upgrades monotonically, exposure preserved, no fallback", async () => {
  for (const [name, later, cls] of [
    ["FULL_FILL", fill(), "FULL_FILL"],
    ["PARTIAL_FILL", fill({ result_class: "PARTIAL_FILL", terminal: false, filled_quantity: 2, remaining_quantity: 3, order_status: "partially_filled" }), "PARTIAL_FILL"],
  ] as const) {
    const w = world(queueRow());
    await deliver(w, unknown(), FIRST_AT);
    assert.equal(hasUnresolvedNeedsReconciliation(w.st.row.diagnostics), true);
    const up = await deliver(w, later, LATER_AT);
    assert.equal(up.order?.kind, "INSERTED", `${name}: ${JSON.stringify(up.order)}`);
    if (up.order?.kind === "INSERTED") assert.equal(up.order.queueMark.kind, "EXECUTED");
    assert.equal(w.st.row.status, "EXECUTED", `${name}: exposure preserved as an executed order`);
    assert.equal(takerSlot(w)?.result_class, cls);
    assert.ok((takerSlot(w)?.filled_quantity ?? 0) > 0);
    assert.equal(up.auth.kind, "MAKER_BLOCKED");
    assert.equal(w.st.claims, 0, `${name}: no fallback after a fill`);
    assert.equal(w.st.events.size, 1);
    // idempotent replay of the same fill: duplicate, never a second order event / fallback
    const replay = await deliver(w, later, LATER_AT);
    assert.equal(replay.order?.kind, "DUPLICATE");
    assert.equal(w.st.events.size, 1);
    assert.equal(w.st.claims, 0);
    // a stale ambiguous retry arriving after the fill never regresses the recorded fill nor the EXECUTED row
    const stale = await deliver(w, unknown(), LATER_AT);
    assert.notEqual(stale.order?.kind, "NEEDS_RECONCILIATION");
    assert.equal(takerSlot(w)?.result_class, cls);
    assert.equal(w.st.row.status, "EXECUTED");
  }
});

// ═══ F. later proven-zero upgrade ═══════════════════════════════════════════════════════════════════════

test("F: UNKNOWN_TRANSPORT then a terminal proven zero upgrades monotonically and authorizes exactly one MAKER_FALLBACK_1", async () => {
  const preSubmission = {
    event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER",
    queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5,
    result_class: "PROVEN_REJECTED_BEFORE_SUBMISSION", terminal: true, economic_exposure_proven_zero: true,
    filled_quantity: 0, venue_order_id: null, success: false, order_status: "REJECTED",
  };
  for (const [name, later] of [["PROVEN_ZERO_FILL_CANCELLED", zeroCancelled()], ["PROVEN_REJECTED_BEFORE_SUBMISSION", preSubmission]] as const) {
    const w = world(queueRow());
    const first = await deliver(w, unknown(), FIRST_AT);
    assert.equal(first.auth.kind, "MAKER_BLOCKED");
    assert.equal(w.st.claims, 0);
    const up = await deliver(w, later, LATER_AT);
    assert.equal(up.auth.kind, "MAKER_AUTHORIZED", `${name}: ${JSON.stringify(up.auth)}`);
    assert.equal(w.st.claims, 1, `${name}: exactly one MAKER_FALLBACK_1`);
    assert.equal(takerSlot(w)?.result_class, name);
    assert.equal(takerSlot(w)?.terminal, true);
    assert.equal(takerSlot(w)?.economic_exposure_proven_zero, true);
    const cmd = (up.auth as { command: MakerFallbackCommand }).command;
    assert.deepEqual([cmd.attempt_id, cmd.parent_attempt_id, cmd.token_id, cmd.condition_id, cmd.side, cmd.stake_usd],
      ["MAKER_FALLBACK_1", "TAKER_ATTEMPT_1", "tok1", "cond1", "YES", 2.5]);
    assert.ok(up.order?.kind === "INSERTED", `${name}: ${JSON.stringify(up.order)}`);
    // idempotent: replaying the zero never authorizes a second maker; a late ambiguous retry never un-zeroes it
    const replay = await deliver(w, later, LATER_AT);
    assert.equal(replay.auth.kind, "MAKER_ALREADY_AUTHORIZED");
    const late = await deliver(w, unknown(), LATER_AT);
    assert.equal(takerSlot(w)?.result_class, name, "a late ambiguous callback never replaces the recorded terminal zero");
    assert.equal(w.st.claims, 1);
  }
});

// ═══ G / H. the submitted_price guard is NOT weakened for any other shape ═══════════════════════════════

test("G: terminal / fill / zero-class / ordinary callbacks missing submitted_price are still rejected MISSING_SUBMITTED_PRICE", async () => {
  const missing = (raw: Record<string, unknown>) => { const { submitted_price: _p, ...rest } = raw; return rest; };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["FULL_FILL", missing(fill())],
    ["PARTIAL_FILL", missing(fill({ result_class: "PARTIAL_FILL", terminal: false, filled_quantity: 2, order_status: "partially_filled" }))],
    ["PROVEN_ZERO_FILL_CANCELLED", missing(zeroCancelled())],
    ["matched (no result class)", { ...missing(fill()), result_class: undefined, terminal: undefined, economic_exposure_proven_zero: undefined, filled_quantity: undefined, order_status: "matched" }],
    ["ordinary accepted", { event_type: "ORDER_RESULT", idempotency_key: IDEM, queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5, clob_order_id: "0xacc", order_status: "submitted", success: true }],
  ];
  for (const [name, raw] of cases) {
    const w = world(queueRow());
    const { order } = await deliver(w, raw);
    assert.deepEqual(order, { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "MISSING_SUBMITTED_PRICE" }, name);
    assert.equal(w.st.events.size, 0, name);
    assert.equal(w.st.row.status, "CLAIMED", name);
    assert.equal(hasUnresolvedNeedsReconciliation(w.st.row.diagnostics), false, name);
  }
});

test("H: unrecognized / malformed callbacks and every NEAR-miss of the ambiguous shape keep failing closed (no waiver)", async () => {
  const nearMisses: Array<[string, Record<string, unknown>]> = [
    ["unrecognized result class", unknown({ result_class: "UNKNOWN_SOMETHING_ELSE" })],
    ["UNKNOWN_AFTER_SUBMISSION", unknown({ result_class: "UNKNOWN_AFTER_SUBMISSION" })],
    ["terminal=true", unknown({ terminal: true })],
    ["terminal omitted", (() => { const { terminal: _t, ...r } = unknown(); return r; })()],
    ["exposure proven zero reported", unknown({ economic_exposure_proven_zero: true })],
    ["exposure reported false", unknown({ economic_exposure_proven_zero: false })],
    ["filled_quantity 0", unknown({ filled_quantity: 0 })],
    ["filled_quantity > 0", unknown({ filled_quantity: 3 })],
    ["venue_order_id present", unknown({ venue_order_id: "0xabc" })],
    ["clob_order_id present", unknown({ clob_order_id: "0xabc" })],
    ["fill fact executed_size", unknown({ executed_size: 5 })],
    ["fill status matched", unknown({ order_status: "matched" })],
    ["transaction hash", unknown({ transaction_hashes: ["0x1"] })],
    ["wrong attempt id", unknown({ attempt_id: "TAKER_ATTEMPT_2" })],
    ["no execution_mode", unknown({ execution_mode: undefined })],
    ["nested raw_response orderID", unknown({ raw_event_json: { raw_response: { orderID: "0xnested" } } })],
    ["nested raw_response takingAmount", unknown({ raw_response: { takingAmount: "2.5" } })],
    ["reported filled_quantity in v1 envelope while top-level is ambiguous", { ...unknownV1(), filled_quantity: 2 }],
  ];
  for (const [name, raw] of nearMisses) {
    assert.equal(isUnknownTransportNeedsReconciliationCallback(raw), false, name);
    const w = world(queueRow());
    const { order } = await deliver(w, raw);
    assert.deepEqual(order, { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "MISSING_SUBMITTED_PRICE" }, name);
    assert.equal(hasUnresolvedNeedsReconciliation(w.st.row.diagnostics), false, name);
    assert.equal(w.st.markWrites, 0, name);
  }
  // MAKER attempts never receive the waiver
  for (const [name, raw] of [
    ["MAKER_FALLBACK_1", unknown({ attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER", parent_idempotency_key: IDEM, idempotency_key: "maker_key" })],
    ["MAKER_FIRST", unknown({ attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST" })],
  ] as const) {
    assert.equal(isUnknownTransportNeedsReconciliationCallback(raw), false, name);
    const w = world(queueRow());
    const { order } = await deliver(w, raw);
    assert.ok(order === null || (order.kind !== "NEEDS_RECONCILIATION" && order.kind !== "INSERTED"), `${name}: ${JSON.stringify(order)}`);
    assert.equal(w.st.markWrites, 0, name);
  }
  // the exact shape on a row that is not CLAIMED, or already carries a resolved result, gets NO waiver
  for (const [name, row] of [
    ["EXECUTED row", queueRow({ status: "EXECUTED" })],
    ["FAILED row", queueRow({ status: "FAILED" })],
    ["READY row", queueRow({ status: "READY" })],
    ["resolved terminal zero already recorded", queueRow({ diagnostics: { physical_event_id: EVENT, max_entry_price: 0.5, max_stake_usd: 4,
      execution_attempts_v1: { taker_attempt_1: { result: readIrelandExecutionResult(zeroCancelled(), FIRST_AT.toISOString()) } } } })],
  ] as const) {
    const w = world(row);
    const { order } = await deliver(w, unknown());
    assert.ok(order !== null && order.kind !== "NEEDS_RECONCILIATION", `${name}: ${JSON.stringify(order)}`);
    assert.equal(w.st.markWrites, 0, name);
  }
  // a PRESENT price is still validated exactly as before (the waiver is for absence only)
  const w = world(queueRow());
  const { order } = await deliver(w, unknown({ submitted_price: 0.9 }));
  assert.deepEqual(order, { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "PRICE_EXCEEDS_QUEUE_MAX" });
});

test("G/H (pure): validateOrderEventAgainstQueueRow rejects an absent price unless the typed ambiguous waiver is explicitly granted", () => {
  const sub = { queue_id: "q1", reservation_id: "res1", idempotency_key: IDEM, token_id: "tok1", condition_id: "cond1", side: "YES",
    market_slug: null, stake_usd: 2.5, submitted_size: 2.5, submitted_price: null };
  assert.deepEqual(validateOrderEventAgainstQueueRow(sub, queueRow()), { ok: false, reason: "MISSING_SUBMITTED_PRICE" });
  assert.deepEqual(validateOrderEventAgainstQueueRow(sub, queueRow(), { unknownTransportAmbiguous: false }), { ok: false, reason: "MISSING_SUBMITTED_PRICE" });
  assert.deepEqual(validateOrderEventAgainstQueueRow(sub, queueRow(), { unknownTransportAmbiguous: true }), { ok: true });
  // the waiver never relaxes identity / stake checks
  assert.deepEqual(validateOrderEventAgainstQueueRow({ ...sub, token_id: "other" }, queueRow(), { unknownTransportAmbiguous: true }), { ok: false, reason: "TOKEN_ID_MISMATCH" });
  assert.deepEqual(validateOrderEventAgainstQueueRow({ ...sub, stake_usd: 99 }, queueRow(), { unknownTransportAmbiguous: true }), { ok: false, reason: "STAKE_EXCEEDS_QUEUE_MAX" });
  // ... nor a present price
  assert.deepEqual(validateOrderEventAgainstQueueRow({ ...sub, submitted_price: 0.9 }, queueRow(), { unknownTransportAmbiguous: true }), { ok: false, reason: "PRICE_EXCEEDS_QUEUE_MAX" });
});

test("ambiguous-result predicate and monotonic merge", () => {
  const amb = readIrelandExecutionResult(unknown(), FIRST_AT.toISOString())!;
  const zero = readIrelandExecutionResult(zeroCancelled(), FIRST_AT.toISOString())!;
  const full = readIrelandExecutionResult(fill(), FIRST_AT.toISOString())!;
  assert.equal(isAmbiguousTransportResult(amb), true);
  assert.equal(isAmbiguousTransportResult(zero), false);
  assert.equal(isAmbiguousTransportResult(full), false);
  assert.equal(isAmbiguousTransportResult(readIrelandExecutionResult(unknown({ result_class: "UNKNOWN_AFTER_SUBMISSION" }), "")), false);
  const later = { ...amb, received_at_iso: LATER_AT.toISOString() };
  assert.equal(mergeAttemptResult(amb, later), amb, "ambiguous duplicate keeps the first record");
  assert.equal(mergeAttemptResult(zero, amb), zero, "ambiguous never replaces a terminal zero");
  assert.equal(mergeAttemptResult(full, amb), full, "ambiguous never replaces a fill");
  assert.equal(mergeAttemptResult(amb, zero), zero, "terminal zero upgrades ambiguous");
  assert.equal(mergeAttemptResult(amb, full), full, "fill upgrades ambiguous");
  assert.equal(mergeAttemptResult(undefined, amb), amb);
});

// ═══ reviewer hardening (N1 / N2) ══════════════════════════════════════════════════════════════════════

test("N1: the marker protects only an UNRESOLVED row -- a recorded terminal proven zero releases it; a recorded fill keeps it preserved; a stale ambiguous callback never marks a resolved row", async () => {
  // terminal proven zero recorded after the marker (e.g. the zero callback itself was rejected for a missing price)
  const w = world(queueRow());
  await deliver(w, unknown());
  assert.equal(hasUnresolvedNeedsReconciliation(w.st.row.diagnostics), true);
  const zeroResult = readIrelandExecutionResult(zeroCancelled(), LATER_AT.toISOString())!;
  await w.maker.recordResult("q1", "taker_attempt_1", zeroResult);
  assert.equal(hasUnresolvedNeedsReconciliation(w.st.row.diagnostics), false, "exposure proven zero: nothing left unresolved");
  const sweep = sweepOf(w.st.row, false);
  assert.equal((await sweep.run()).expired_count, 1, "an ordinary row is swept again (pre-change behavior for a resolved zero)");
  // a recorded fill (exposure) keeps the row preserved -- it is never silently expired
  const f = world(queueRow());
  await deliver(f, unknown());
  await f.maker.recordResult("q1", "taker_attempt_1", readIrelandExecutionResult(fill(), LATER_AT.toISOString())!);
  assert.equal(hasUnresolvedNeedsReconciliation(f.st.row.diagnostics), true);
  const fSweep = sweepOf(f.st.row, false);
  assert.equal((await fSweep.run()).expired_count, 0);
  // race: a terminal result recorded after the snapshot but before the marker CAS -> the marker write is refused
  const r = world(queueRow());
  const snapshot = structuredClone(r.st.row);
  await r.maker.recordResult("q1", "taker_attempt_1", zeroResult);
  assert.equal(await r.orders.markNeedsReconciliation!("q1", { state: "NEEDS_RECONCILIATION" }), "NOT_CLAIMED");
  assert.equal(hasUnresolvedNeedsReconciliation(r.st.row.diagnostics), false);
  assert.equal(snapshot.status, "CLAIMED");
});

test("N2: a port without the fresh-read CAS marker write fails closed (no stale-snapshot status write)", async () => {
  const w = world(queueRow());
  const { markNeedsReconciliation: _omit, ...legacyPort } = w.orders;
  await recordResultAndAuthorizeMaker(w.maker, unknown(), FIRST_AT);
  await assert.rejects(
    handleOrderEventSubmission(legacyPort as OrderEventDbPort, unknown(), { nowIso: FIRST_AT.toISOString() }),
    /NEEDS_RECONCILIATION_PORT_UNSUPPORTED/,
  );
  assert.equal(w.st.statusWrites.length, 0);
  assert.equal(w.st.row.status, "CLAIMED");
});

// ═══ I. nothing else moved ══════════════════════════════════════════════════════════════════════════════

test("I: the 0.555 hard cap and the Queue price envelope are untouched", () => {
  assert.equal(QUEUE_MAX_ENTRY_PRICE, 0.555);
});
