// PREMVP <-> Ireland queue-mark EXECUTED verification tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Exercises the FULL EXECUTED-verification orchestration
// (handleQueueMarkExecuted) through an injected in-memory QueueMarkDbPort —
// no live Supabase, no network. The route handler is a thin wrapper around
// this exact function for the EXECUTED path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  handleQueueMarkExecuted,
  rejectsExecutedRegression,
  QUEUE_MARK_ACCEPTED_STATUSES,
  QUEUE_PERSISTED_STATUSES,
  isQueueMarkAcceptedStatus,
  type QueueMarkDbPort,
  type QueueMarkRow,
  type StoredOrderEvent,
} from "../../lib/executor/executorCallbackContract";

const root = process.cwd();

function baseRow(overrides: Partial<QueueMarkRow> = {}): QueueMarkRow {
  return {
    id: "q-1",
    status: "READY",
    idempotency_key: "idem-1",
    condition_id: "cond-1",
    token_id: "token-1",
    side: "Argentina",
    order_key: "cond-1:token-1:Argentina",
    match_family_key: "argentina-vs-egypt",
    stake_usd: 3,
    diagnostics: {},
    ...overrides,
  };
}

function baseEvent(overrides: Partial<StoredOrderEvent> = {}): StoredOrderEvent {
  return {
    id: "evt-1",
    created_at: "2026-07-07T15:00:00.000Z",
    idempotency_key: "idem-1",
    condition_id: "cond-1",
    token_id: "token-1",
    side: "Argentina",
    selected_side: null,
    market_slug: "argentina-vs-egypt-moneyline",
    submitted_size: 3,
    submitted_price: 0.55,
    clob_order_id: "clob-1",
    ...overrides,
  };
}

function makeFakePort(row: QueueMarkRow, events: StoredOrderEvent[] = []): QueueMarkDbPort & { updateCalls: number } {
  let current = { ...row, diagnostics: { ...row.diagnostics } };
  let updateCalls = 0;
  return {
    get updateCalls() {
      return updateCalls;
    },
    async findQueueRow() {
      return { ...current, diagnostics: { ...current.diagnostics } };
    },
    async findOrderEventForIdentity(input) {
      return (
        events.find(
          (e) =>
            e.idempotency_key === input.idempotency_key &&
            e.condition_id === input.condition_id &&
            e.token_id === input.token_id &&
            (e.side ?? e.selected_side) === input.side,
        ) ?? null
      );
    },
    async updateQueueStatus(queueId, patch) {
      updateCalls += 1;
      current = { ...current, status: patch.status, diagnostics: patch.diagnostics };
      return { ...current, diagnostics: { ...current.diagnostics } };
    },
  };
}

test("10: EXECUTED with live_order_confirmed=false is rejected", async () => {
  const port = makeFakePort(baseRow());
  const outcome = await handleQueueMarkExecuted(port, { queueId: "q-1", liveOrderConfirmed: false, markHistoryEntry: {} });
  assert.equal(outcome.kind, "REJECTED_CONFIRMATION_REQUIRED");
  assert.equal(port.updateCalls, 0);
});

test("11: EXECUTED with no matching order-event returns a rejection, no queue mutation", async () => {
  const port = makeFakePort(baseRow(), []);
  const outcome = await handleQueueMarkExecuted(port, { queueId: "q-1", liveOrderConfirmed: true, markHistoryEntry: {} });
  assert.equal(outcome.kind, "REJECTED_ORDER_EVENT_REQUIRED");
  assert.equal(port.updateCalls, 0);
});

test("12: EXECUTED with a mismatched condition_id/token_id/side is rejected (no cross-identity match)", async () => {
  const port = makeFakePort(baseRow(), [baseEvent({ token_id: "other-token" })]);
  const outcome = await handleQueueMarkExecuted(port, { queueId: "q-1", liveOrderConfirmed: true, markHistoryEntry: {} });
  assert.equal(outcome.kind, "REJECTED_ORDER_EVENT_REQUIRED");
});

test("12b: a queue row with no idempotency_key cannot be verified and is rejected", async () => {
  const port = makeFakePort(baseRow({ idempotency_key: null }), [baseEvent()]);
  const outcome = await handleQueueMarkExecuted(port, { queueId: "q-1", liveOrderConfirmed: true, markHistoryEntry: {} });
  assert.equal(outcome.kind, "REJECTED_MISSING_IDEMPOTENCY_KEY");
});

test("13: selected_side fallback is accepted for the identity cross-check", async () => {
  const port = makeFakePort(baseRow(), [baseEvent({ side: null, selected_side: "Argentina" })]);
  const outcome = await handleQueueMarkExecuted(port, { queueId: "q-1", liveOrderConfirmed: true, markHistoryEntry: {} });
  assert.equal(outcome.kind, "UPDATED");
});

test("13b: a matching order-event permits EXECUTED", async () => {
  const port = makeFakePort(baseRow(), [baseEvent()]);
  const outcome = await handleQueueMarkExecuted(port, { queueId: "q-1", liveOrderConfirmed: true, markHistoryEntry: { status: "EXECUTED" } });
  assert.equal(outcome.kind, "UPDATED");
  if (outcome.kind === "UPDATED") assert.equal(outcome.row.status, "EXECUTED");
  assert.equal(port.updateCalls, 1);
});

test("14+15: repeated EXECUTED is an idempotent no-op with no duplicate audit history mutation", async () => {
  const port = makeFakePort(baseRow(), [baseEvent()]);
  const first = await handleQueueMarkExecuted(port, { queueId: "q-1", liveOrderConfirmed: true, markHistoryEntry: { status: "EXECUTED", n: 1 } });
  assert.equal(first.kind, "UPDATED");
  assert.equal(port.updateCalls, 1);

  const second = await handleQueueMarkExecuted(port, { queueId: "q-1", liveOrderConfirmed: true, markHistoryEntry: { status: "EXECUTED", n: 2 } });
  assert.equal(second.kind, "IDEMPOTENT_NO_OP");
  // no second updateQueueStatus call at all -- true no-op, not a re-append.
  assert.equal(port.updateCalls, 1);
});

test("16: EXECUTED never regresses to a non-EXECUTED status (shared guard)", () => {
  assert.equal(rejectsExecutedRegression("EXECUTED", "FAILED"), true);
  assert.equal(rejectsExecutedRegression("EXECUTED", "EXECUTED"), false);
  assert.equal(rejectsExecutedRegression("READY", "FAILED"), false);
});

test("19: the runtime-accepted mark statuses are a subset of the full persisted union (single shared source)", () => {
  for (const status of QUEUE_MARK_ACCEPTED_STATUSES) {
    assert.ok((QUEUE_PERSISTED_STATUSES as readonly string[]).includes(status), `${status} must be in the persisted union`);
  }
  assert.ok(isQueueMarkAcceptedStatus("EXECUTED"));
  assert.ok(!isQueueMarkAcceptedStatus("READY"));
  assert.ok(!isQueueMarkAcceptedStatus("SENT"));
  assert.ok(!isQueueMarkAcceptedStatus("CANCELLED"));
});

test("the mark route imports the shared status contract, not a private duplicate array", () => {
  const source = readFileSync(path.join(root, "app/api/executor/queue/mark/route.ts"), "utf8");
  assert.match(source, /executorCallbackContract/);
});

test("the mark route delegates EXECUTED verification to handleQueueMarkExecuted", () => {
  const source = readFileSync(path.join(root, "app/api/executor/queue/mark/route.ts"), "utf8");
  assert.match(source, /handleQueueMarkExecuted/);
});
