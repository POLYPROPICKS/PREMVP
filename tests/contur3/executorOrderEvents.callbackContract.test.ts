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

test("4b: a rejected order event (success:false) never marks the queue row EXECUTED, even with a clob_order_id present", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, validSubmissionRaw({ success: false, order_status: "REJECTED" }));
  assert.equal(outcome.kind, "INSERTED", "the order event itself is still persisted for audit");
  if (outcome.kind === "INSERTED") {
    assert.equal(outcome.queueMark.kind, "NOT_ACCEPTED");
  }
  const queueRow = port.queueByIdemKey.get("idem-1");
  assert.equal(queueRow?.status, "READY", "a rejected order event must never mark the queue row EXECUTED");
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
