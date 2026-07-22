// PREMVP <-> Ireland order-events callback contract tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Exercises the FULL order-event submission orchestration
// (handleOrderEventSubmission) through an injected in-memory OrderEventDbPort
// that faithfully reproduces PostgREST insert / unique-violation semantics —
// no live Supabase, no network. The route handler itself is a thin wrapper
// around this exact function; testing it here is testing the route's real
// behavior, not a trivial helper in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  handleOrderEventSubmission,
  projectCanonicalOrderEventPayload,
  deriveOrderEventFillFields,
  type OrderEventDbPort,
  type StoredOrderEvent,
  type InsertOrderEventFailure,
} from "../../lib/executor/executorCallbackContract";
import type { EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

const root = process.cwd();

function baseQueueRow(overrides: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "queue-1",
    reservation_id: "res-1",
    plan_run_id: "plan-1",
    rebalance_run_id: "rebalance-1",
    match_family_key: "argentina-vs-egypt",
    event_title: "Argentina vs Egypt",
    event_slug: "argentina-vs-egypt",
    sport: "soccer",
    league: null,
    game_start_iso: "2026-07-07T16:00:00.000Z",
    condition_id: "cond-1",
    token_id: "token-1",
    side: "Argentina",
    market_slug: "argentina-vs-egypt-moneyline",
    market_title: "argentina-vs-egypt-moneyline",
    market_family: "allowed_fullmatch_moneyline",
    score: 80,
    coverage: 60,
    tier: "TIER1",
    stake_usd: 3,
    preferred_entry_iso: "2026-07-07T14:50:00.000Z",
    latest_entry_iso: "2026-07-07T15:57:00.000Z",
    selection_rank: 1,
    selection_reason: null,
    status: "READY",
    order_key: "cond-1:token-1:Argentina",
    idempotency_key: "idem-1",
    diagnostics: { max_entry_price: 0.6 },
    ...overrides,
  };
}

function validSubmissionRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_id: "token-1",
    idempotency_key: "idem-1",
    condition_id: "cond-1",
    side: "Argentina",
    market_slug: "argentina-vs-egypt-moneyline",
    submitted_size: 3,
    submitted_price: 0.55,
    clob_order_id: "clob-1",
    event_type: "ORDER_PLACED",
    source: "ireland_queue_only",
    ...overrides,
  };
}

function makeFakePort(
  queueRows: EventExecutionQueueRow[] = [baseQueueRow()]
): OrderEventDbPort & { eventsById: Map<string, StoredOrderEvent>; queueByIdemKey: Map<string, EventExecutionQueueRow> } {
  const queueByIdemKey = new Map(queueRows.map((r) => [r.idempotency_key as string, r]));
  const eventsByIdemKey = new Map<string, StoredOrderEvent>();
  const eventsByClob = new Map<string, StoredOrderEvent>();
  const eventsById = new Map<string, StoredOrderEvent>();
  let nextId = 1;
  return {
    eventsById,
    queueByIdemKey,
    async findQueueRowByIdempotencyKey(key) {
      return queueByIdemKey.get(key) ?? null;
    },
    async findOrderEventByIdempotencyKey(key) {
      return eventsByIdemKey.get(key) ?? null;
    },
    async findOrderEventByClobOrderId(clobOrderId) {
      return eventsByClob.get(clobOrderId) ?? null;
    },
    async updateQueueRowStatus(queueId, patch) {
      for (const row of queueByIdemKey.values()) {
        if (row.id === queueId) {
          row.status = patch.status;
          row.diagnostics = patch.diagnostics;
        }
      }
    },
    async insertOrderEvent(record, _queueRow): Promise<{ ok: true; row: StoredOrderEvent } | InsertOrderEventFailure> {
      const canonical = projectCanonicalOrderEventPayload(record);
      if (canonical.idempotency_key && eventsByIdemKey.has(canonical.idempotency_key)) {
        return { ok: false, code: "UNIQUE_VIOLATION_IDEMPOTENCY_KEY", message: "duplicate key value violates unique constraint" };
      }
      if (canonical.clob_order_id && eventsByClob.has(canonical.clob_order_id)) {
        return { ok: false, code: "UNIQUE_VIOLATION_CLOB_ORDER_ID", message: "duplicate key value violates unique constraint" };
      }
      const row: StoredOrderEvent = {
        id: `evt-${nextId++}`,
        created_at: new Date().toISOString(),
        idempotency_key: canonical.idempotency_key || null,
        condition_id: canonical.condition_id,
        token_id: canonical.token_id,
        side: canonical.side,
        selected_side: typeof record.selected_side === "string" ? record.selected_side : null,
        market_slug: canonical.market_slug,
        submitted_size: canonical.submitted_size,
        submitted_price: canonical.submitted_price,
        clob_order_id: canonical.clob_order_id,
      };
      if (row.idempotency_key) eventsByIdemKey.set(row.idempotency_key, row);
      if (row.clob_order_id) eventsByClob.set(row.clob_order_id, row);
      eventsById.set(row.id, row);
      return { ok: true, row };
    },
  };
}

test("1: missing token_id is rejected", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ token_id: undefined }));
  assert.equal(outcome.kind, "REJECTED_MISSING_TOKEN_ID");
});

test("2: missing idempotency_key is rejected", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ idempotency_key: undefined }));
  assert.equal(outcome.kind, "REJECTED_MISSING_IDEMPOTENCY_KEY");
});

test("3: the insert payload passed to the port never contains queue_id", async () => {
  const port = makeFakePort();
  const seen: Record<string, unknown>[] = [];
  const spyPort: OrderEventDbPort = {
    ...port,
    async insertOrderEvent(record, queueRow) {
      seen.push(record);
      return port.insertOrderEvent(record, queueRow);
    },
  };
  const outcome = await handleOrderEventSubmission(spyPort, validSubmissionRaw());
  assert.equal(outcome.kind, "INSERTED");
  assert.equal(seen.length, 1);
  assert.equal("queue_id" in seen[0], false);
});

test("4: first insert returns a canonical event row and terminal-marks the matching READY queue row EXECUTED (accepted order: has clob_order_id, success not false)", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw());
  assert.equal(outcome.kind, "INSERTED");
  if (outcome.kind === "INSERTED") {
    assert.ok(outcome.row.id);
    assert.equal(outcome.row.idempotency_key, "idem-1");
    assert.equal(outcome.queueMark.kind, "EXECUTED");
  }
  const queueRow = port.queueByIdemKey.get("idem-1");
  assert.equal(queueRow?.status, "EXECUTED");
  assert.equal((queueRow?.diagnostics as Record<string, unknown>).clob_order_id, "clob-1");
});

test("5: an identical duplicate submission returns the same canonical row, no second insert, idempotent queue mark (already EXECUTED)", async () => {
  const port = makeFakePort();
  const first = await handleOrderEventSubmission(port, validSubmissionRaw());
  assert.equal(first.kind, "INSERTED");
  const second = await handleOrderEventSubmission(port, validSubmissionRaw());
  assert.equal(second.kind, "DUPLICATE");
  if (first.kind === "INSERTED" && second.kind === "DUPLICATE") {
    assert.equal(second.row.id, first.row.id);
    assert.equal(second.queueMark.kind, "ALREADY_EXECUTED", "repeating an accepted callback must be idempotent, not re-mark or duplicate");
  }
  assert.equal(port.eventsById.size, 1);
});

test("4b: a rejected order event (success:false) never marks the queue row EXECUTED -- it marks it FAILED instead, even with a clob_order_id present", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ success: false, order_status: "REJECTED" }));
  assert.equal(outcome.kind, "INSERTED", "the order event itself is still persisted for audit");
  if (outcome.kind === "INSERTED") {
    assert.equal(outcome.queueMark.kind, "FAILED");
  }
  const queueRow = port.queueByIdemKey.get("idem-1");
  assert.equal(queueRow?.status, "FAILED", "a rejected order event must never mark the queue row EXECUTED");
  assert.notEqual(queueRow?.status, "EXECUTED");
});

test("4c: an order event with no clob_order_id (order was never placed) never marks the queue row EXECUTED", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ clob_order_id: undefined }));
  assert.equal(outcome.kind, "INSERTED");
  if (outcome.kind === "INSERTED") assert.equal(outcome.queueMark.kind, "NOT_ACCEPTED");
  assert.equal(port.queueByIdemKey.get("idem-1")?.status, "READY");
});

test("6: a conflicting duplicate (same idempotency_key, different economic payload) is rejected", async () => {
  const port = makeFakePort();
  const first = await handleOrderEventSubmission(port, validSubmissionRaw());
  assert.equal(first.kind, "INSERTED");
  const conflicting = await handleOrderEventSubmission(port, validSubmissionRaw({ submitted_price: 0.5, clob_order_id: "clob-1" }));
  assert.equal(conflicting.kind, "CONFLICT_IDEMPOTENCY");
  assert.equal(port.eventsById.size, 1);
});

test("7: a clob_order_id collision under a different idempotency_key is rejected", async () => {
  const port = makeFakePort([baseQueueRow(), baseQueueRow({ id: "queue-2", idempotency_key: "idem-2", token_id: "token-2", condition_id: "cond-2", side: "Egypt", order_key: "cond-2:token-2:Egypt" })]);
  const first = await handleOrderEventSubmission(port, validSubmissionRaw());
  assert.equal(first.kind, "INSERTED");
  const second = await handleOrderEventSubmission(
    port,
    validSubmissionRaw({ idempotency_key: "idem-2", token_id: "token-2", condition_id: "cond-2", side: "Egypt", clob_order_id: "clob-1" }),
  );
  assert.equal(second.kind, "CONFLICT_CLOB_ORDER_ID");
  assert.equal(port.eventsById.size, 1);
});

test("8: a queue-policy mismatch (stake exceeds cap) is rejected before insert", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ submitted_size: 999 }));
  assert.equal(outcome.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
  assert.equal(port.eventsById.size, 0);
});

test("9: no queue row found for the idempotency_key does not block order-event persistence, but queueMark reports QUEUE_ROW_NOT_FOUND", async () => {
  const port = makeFakePort([]);
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw());
  assert.equal(outcome.kind, "INSERTED", "persistence must still succeed even with no matching queue row");
  if (outcome.kind === "INSERTED") {
    assert.equal(outcome.queueMark.kind, "QUEUE_ROW_NOT_FOUND");
  }
  assert.equal(port.eventsById.size, 1);
});

test("10: a concurrent unique-violation race (identical payload) is not trusted from the pre-check alone -- it re-reads the canonical row and returns duplicate", async () => {
  const port = makeFakePort();
  const winnerOutcome = await handleOrderEventSubmission(port, validSubmissionRaw({ clob_order_id: undefined }));
  assert.equal(winnerOutcome.kind, "INSERTED");

  let preCheckCalls = 0;
  const racyPort: OrderEventDbPort = {
    ...port,
    async findOrderEventByIdempotencyKey(key) {
      preCheckCalls += 1;
      // Simulate the race window: the pre-check ran BEFORE the concurrent
      // writer's row was visible, so it lies (returns null) exactly once.
      if (preCheckCalls === 1) return null;
      return port.findOrderEventByIdempotencyKey(key);
    },
  };
  const outcome = await handleOrderEventSubmission(racyPort, validSubmissionRaw({ clob_order_id: undefined }));
  assert.equal(outcome.kind, "DUPLICATE");
  assert.equal(preCheckCalls, 2, "must re-read after the unique violation, not trust the stale pre-check");
  assert.equal(port.eventsById.size, 1);
});

test("11: a concurrent unique-violation race with a conflicting payload is rejected after re-read, not accepted", async () => {
  const port = makeFakePort();
  const winnerOutcome = await handleOrderEventSubmission(port, validSubmissionRaw({ clob_order_id: undefined }));
  assert.equal(winnerOutcome.kind, "INSERTED");

  let preCheckCalls = 0;
  const racyPort: OrderEventDbPort = {
    ...port,
    async findOrderEventByIdempotencyKey(key) {
      preCheckCalls += 1;
      if (preCheckCalls === 1) return null;
      return port.findOrderEventByIdempotencyKey(key);
    },
  };
  const outcome = await handleOrderEventSubmission(racyPort, validSubmissionRaw({ submitted_price: 0.5, clob_order_id: undefined }));
  assert.equal(outcome.kind, "CONFLICT_IDEMPOTENCY");
  assert.equal(port.eventsById.size, 1);
});

test("12: a sanitized database error surfaces as DB_ERROR without leaking raw internals", async () => {
  const port = makeFakePort();
  const failingPort: OrderEventDbPort = {
    ...port,
    async insertOrderEvent() {
      return { ok: false, code: "OTHER", message: "connection to server failed: FATAL password authentication failed for user \"svc\"" };
    },
  };
  const outcome = await handleOrderEventSubmission(failingPort, validSubmissionRaw());
  assert.equal(outcome.kind, "DB_ERROR");
});

test("13: the route source file no longer inserts queue_id", () => {
  const source = readFileSync(path.join(root, "app/api/executor/order-events/route.ts"), "utf8");
  assert.doesNotMatch(source, /queue_id\s*:/);
});

test("14: the route source file does not insert match_family_key -- not a real live column", () => {
  const source = readFileSync(path.join(root, "app/api/executor/order-events/route.ts"), "utf8");
  assert.doesNotMatch(source, /match_family_key\s*:/);
});

test("15: the route source file does not insert reservation_id -- not a real live column", () => {
  const source = readFileSync(path.join(root, "app/api/executor/order-events/route.ts"), "utf8");
  assert.doesNotMatch(source, /reservation_id\s*:/);
});

test("16: policy validation (when a queue row exists) still occurs before any insert is attempted; a missing queue row no longer blocks insert", async () => {
  const port = makeFakePort([]);
  let insertCalls = 0;
  const spyPort: OrderEventDbPort = {
    ...port,
    async insertOrderEvent(record, queueRow) {
      insertCalls += 1;
      return port.insertOrderEvent(record, queueRow);
    },
  };
  const notFound = await handleOrderEventSubmission(spyPort, validSubmissionRaw());
  assert.equal(notFound.kind, "INSERTED", "a missing queue row must not prevent persistence");
  assert.equal(insertCalls, 1);
  insertCalls = 0;

  const policyPort = makeFakePort();
  const spyPolicyPort: OrderEventDbPort = {
    ...policyPort,
    async insertOrderEvent(record, queueRow) {
      insertCalls += 1;
      return policyPort.insertOrderEvent(record, queueRow);
    },
  };
  const mismatch = await handleOrderEventSubmission(spyPolicyPort, validSubmissionRaw({ submitted_size: 999 }));
  assert.equal(mismatch.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
  assert.equal(insertCalls, 0, "must not insert when queue policy validation fails");
});

// ── Rejected order events: terminal-mark the queue row FAILED ──────────────
//
// Production incident: old founder-battle-batch rows received ORDER_REJECTED
// callbacks from ireland_batch_queue_consumer, but stayed READY until the
// founder manually marked them FAILED -- risking a rejected intent remaining
// active and being re-scanned later.

test("17: an ORDER_REJECTED order-event marks the matching READY queue row FAILED", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ order_status: "ORDER_REJECTED" }));
  assert.equal(outcome.kind, "INSERTED");
  if (outcome.kind === "INSERTED") assert.equal(outcome.queueMark.kind, "FAILED");
  assert.equal(port.queueByIdemKey.get("idem-1")?.status, "FAILED");
});

test("18: a rejected order-event stores the rejection reason/error message in queue diagnostics", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(
    port,
    validSubmissionRaw({ order_status: "ORDER_REJECTED", error_message: "invalid amount for a marketable BUY order ($0.9963), min size: $1" }),
  );
  assert.equal(outcome.kind, "INSERTED");
  const queueRow = port.queueByIdemKey.get("idem-1");
  const diag = queueRow?.diagnostics as Record<string, unknown>;
  assert.equal(diag.queue_mark_result, "ORDER_REJECTED");
  assert.equal(diag.rejection_reason, "invalid amount for a marketable BUY order ($0.9963), min size: $1");
  assert.ok(diag.order_event_id, "order_event_id must be recorded when available");
  if (outcome.kind === "INSERTED") assert.equal(diag.order_event_id, outcome.row.id);
});

test("19: a duplicate rejected callback is idempotent -- already FAILED means no second update", async () => {
  const port = makeFakePort();
  const first = await handleOrderEventSubmission(port, validSubmissionRaw({ order_status: "ORDER_REJECTED", clob_order_id: undefined }));
  assert.equal(first.kind, "INSERTED");
  if (first.kind === "INSERTED") assert.equal(first.queueMark.kind, "FAILED");
  assert.equal(port.queueByIdemKey.get("idem-1")?.status, "FAILED");

  // Same canonical payload -> DUPLICATE, must not re-write or downgrade anything.
  const second = await handleOrderEventSubmission(port, validSubmissionRaw({ order_status: "ORDER_REJECTED", clob_order_id: undefined }));
  assert.equal(second.kind, "DUPLICATE");
  if (second.kind === "DUPLICATE") assert.equal(second.queueMark.kind, "ALREADY_FAILED");
  assert.equal(port.queueByIdemKey.get("idem-1")?.status, "FAILED");
});

test("20: a rejected callback never overwrites an already-EXECUTED queue row", async () => {
  const port = makeFakePort();
  const accepted = await handleOrderEventSubmission(port, validSubmissionRaw());
  assert.equal(accepted.kind, "INSERTED");
  if (accepted.kind === "INSERTED") assert.equal(accepted.queueMark.kind, "EXECUTED");
  assert.equal(port.queueByIdemKey.get("idem-1")?.status, "EXECUTED");

  // A later, distinct rejected event (different clob_order_id, so it's a
  // genuinely new economic event, not a duplicate/conflict of the first)
  // targeting the same idempotency_key/queue row must never downgrade it.
  const rejectedLater = await handleOrderEventSubmission(
    port,
    validSubmissionRaw({ idempotency_key: "idem-1", clob_order_id: "clob-2", order_status: "ORDER_REJECTED" }),
  );
  // The conflicting economic payload for the same idempotency_key is itself
  // rejected as a conflict -- but even so, prove the queue row was never touched.
  assert.equal(rejectedLater.kind, "CONFLICT_IDEMPOTENCY");
  assert.equal(port.queueByIdemKey.get("idem-1")?.status, "EXECUTED", "EXECUTED must never be downgraded to FAILED");
});

test("21: an accepted callback still marks EXECUTED (regression guard for the e83e8e3 fix)", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw());
  assert.equal(outcome.kind, "INSERTED");
  if (outcome.kind === "INSERTED") assert.equal(outcome.queueMark.kind, "EXECUTED");
  assert.equal(port.queueByIdemKey.get("idem-1")?.status, "EXECUTED");
});

test("22: an explicit accepted:false with no clob_order_id still marks the queue row FAILED (no order id required to classify a rejection)", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ clob_order_id: undefined, accepted: false, reason: "insufficient balance" }));
  assert.equal(outcome.kind, "INSERTED");
  if (outcome.kind === "INSERTED") assert.equal(outcome.queueMark.kind, "FAILED");
  const queueRow = port.queueByIdemKey.get("idem-1");
  assert.equal(queueRow?.status, "FAILED");
  assert.equal((queueRow?.diagnostics as Record<string, unknown>).rejection_reason, "insufficient balance");
});

test("23: a missing queue row for a rejected order-event still persists the event and returns queueMark QUEUE_ROW_NOT_FOUND (not FAILED, nothing to mark)", async () => {
  const port = makeFakePort([]);
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ order_status: "ORDER_REJECTED" }));
  assert.equal(outcome.kind, "INSERTED", "persistence must still succeed even with no matching queue row");
  if (outcome.kind === "INSERTED") assert.equal(outcome.queueMark.kind, "QUEUE_ROW_NOT_FOUND");
});

test("24: the rejected-marking code path does not depend on queue_id/reservation_id/match_family_key columns (shared static route guards)", () => {
  const source = readFileSync(path.join(root, "app/api/executor/order-events/route.ts"), "utf8");
  assert.doesNotMatch(source, /queue_id\s*:/);
  assert.doesNotMatch(source, /match_family_key\s*:/);
  assert.doesNotMatch(source, /reservation_id\s*:/);
});

// ── Fill/cost normalization (deriveOrderEventFillFields) ───────────────────
//
// Production incident, 2026-07-22: 4 accepted EXECUTED rows had
// clob_order_id/transaction_hashes/submitted_price/stake_usd populated and
// raw_event_json HAS_CONTENT, but normalized submitted_size, making_amount,
// taking_amount, and response_json_sanitized all stayed NULL. Root cause:
// the route only read the exact top-level snake_case field name with a
// naive typeof check, and for making_amount/taking_amount used str() against
// a `numeric` DB column (a JS number always fails that check -> null),
// never falling back to raw_event_json.raw_response's camelCase CLOB
// response shape (makingAmount/takingAmount) or to executed_size/filled_price.

const LIVE_ACCEPTED_PAYLOAD = {
  success: true,
  order_status: "matched",
  submitted_price: 0.47,
  filled_price: 0.47,
  executed_size: 2.34,
  making_amount: 1.0998,
  taking_amount: 2.34,
  fee_usd: null as number | null,
  fee_notes: "FEE_NOT_RETURNED_BY_EXECUTOR_RESULT",
  raw_event_json: {
    raw_response: {
      status: "matched",
      success: true,
      orderID: "0xabc123",
      makingAmount: "1.0998",
      takingAmount: "2.34",
      transactionsHashes: ["0xdeadbeef"],
    },
  },
};

test("Fill-1 (regression, production shape): submitted_size/making_amount/taking_amount/submitted_price all populate from the live accepted payload", () => {
  const fill = deriveOrderEventFillFields(LIVE_ACCEPTED_PAYLOAD);
  assert.equal(fill.submitted_size, 2.34);
  assert.equal(fill.making_amount, 1.0998);
  assert.equal(fill.taking_amount, 2.34);
  assert.equal(fill.submitted_price, 0.47);
  assert.equal(typeof fill.submitted_size, "number");
  assert.equal(typeof fill.making_amount, "number");
  assert.equal(typeof fill.taking_amount, "number");
});

test("Fill-2: response_json_sanitized is populated from raw_event_json.raw_response when not explicitly provided", () => {
  const fill = deriveOrderEventFillFields(LIVE_ACCEPTED_PAYLOAD);
  assert.ok(fill.response_json_sanitized);
  assert.equal(fill.response_json_sanitized?.status, "matched");
  assert.equal(fill.response_json_sanitized?.orderID, "0xabc123");
});

test("Fill-3: making_amount/taking_amount fall back to the nested camelCase CLOB response (makingAmount/takingAmount) when only that shape is present, and are coerced to numbers not strings", () => {
  const payload = {
    raw_event_json: {
      raw_response: { makingAmount: "0.55", takingAmount: "1.10" },
    },
  };
  const fill = deriveOrderEventFillFields(payload);
  assert.equal(fill.making_amount, 0.55);
  assert.equal(fill.taking_amount, 1.1);
  assert.equal(typeof fill.making_amount, "number");
  assert.equal(typeof fill.taking_amount, "number");
});

test("Fill-4: submitted_size falls back through executed_size then taking_amount then raw_response.takingAmount, in that order", () => {
  assert.equal(deriveOrderEventFillFields({ submitted_size: 5 }).submitted_size, 5, "explicit submitted_size wins");
  assert.equal(deriveOrderEventFillFields({ executed_size: 7 }).submitted_size, 7, "falls back to executed_size");
  assert.equal(deriveOrderEventFillFields({ taking_amount: 9 }).submitted_size, 9, "falls back to taking_amount");
  assert.equal(
    deriveOrderEventFillFields({ raw_event_json: { raw_response: { takingAmount: "11" } } }).submitted_size,
    11,
    "falls back to nested raw_response.takingAmount",
  );
});

test("Fill-5: submitted_price falls back to filled_price only when submitted_price is absent", () => {
  assert.equal(deriveOrderEventFillFields({ submitted_price: 0.6, filled_price: 0.9 }).submitted_price, 0.6, "explicit submitted_price wins over filled_price");
  assert.equal(deriveOrderEventFillFields({ filled_price: 0.42 }).submitted_price, 0.42);
});

test("Fill-6: an explicit non-null top-level value is never overwritten by a derived value", () => {
  const payload = {
    submitted_size: 3,
    making_amount: 2,
    taking_amount: 4,
    executed_size: 999,
    raw_event_json: { raw_response: { makingAmount: "999", takingAmount: "999" } },
  };
  const fill = deriveOrderEventFillFields(payload);
  assert.equal(fill.submitted_size, 3);
  assert.equal(fill.making_amount, 2);
  assert.equal(fill.taking_amount, 4);
});

test("Fill-7: fee_usd/fee_notes/observed_* are never touched or fabricated by fill derivation (not part of its return shape)", () => {
  const fill = deriveOrderEventFillFields(LIVE_ACCEPTED_PAYLOAD);
  assert.equal("fee_usd" in fill, false);
  assert.equal("fee_notes" in fill, false);
  assert.equal("observed_best_bid" in fill, false);
  assert.equal("observed_best_ask" in fill, false);
  assert.equal("observed_spread" in fill, false);
});

test("Fill-8: missing/garbage fill data yields null, never throws or fabricates a number", () => {
  assert.deepEqual(deriveOrderEventFillFields({}), {
    submitted_size: null,
    submitted_price: null,
    making_amount: null,
    taking_amount: null,
    response_json_sanitized: null,
  });
  const garbage = deriveOrderEventFillFields({
    making_amount: "not-a-number",
    taking_amount: NaN,
    raw_event_json: { raw_response: "not-an-object" },
  });
  assert.equal(garbage.making_amount, null);
  assert.equal(garbage.taking_amount, null);
  assert.equal(garbage.response_json_sanitized, null);
});

test("Fill-9 (route wiring, static source check): the route uses deriveOrderEventFillFields for making_amount/taking_amount/submitted_size/submitted_price/response_json_sanitized, and no longer str()-casts making_amount/taking_amount against the numeric DB columns", () => {
  const source = readFileSync(path.join(root, "app/api/executor/order-events/route.ts"), "utf8");
  assert.match(source, /deriveOrderEventFillFields/);
  assert.match(source, /making_amount:\s*fill\.making_amount/);
  assert.match(source, /taking_amount:\s*fill\.taking_amount/);
  assert.match(source, /submitted_size:\s*fill\.submitted_size/);
  assert.match(source, /submitted_price:\s*fill\.submitted_price/);
  assert.match(source, /response_json_sanitized:\s*fill\.response_json_sanitized/);
  assert.doesNotMatch(source, /making_amount:\s*str\(/);
  assert.doesNotMatch(source, /taking_amount:\s*str\(/);
});

test("Fill-10: fee_usd is never inferred -- an explicit null fee_usd in the callback stays null end-to-end through handleOrderEventSubmission (no queue-policy/insert path fabricates it)", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(
    port,
    validSubmissionRaw({ ...LIVE_ACCEPTED_PAYLOAD, fee_usd: null }),
  );
  assert.equal(outcome.kind, "INSERTED");
  // handleOrderEventSubmission/StoredOrderEvent do not carry fee_usd at all
  // (fee_usd is a route-level insert-record field, not part of the shared
  // canonical/orchestration contract) -- this proves the orchestration layer
  // never derives or requires a fee value to accept the order event.
  assert.equal("fee_usd" in (outcome as { row?: StoredOrderEvent }).row!, false);
});
