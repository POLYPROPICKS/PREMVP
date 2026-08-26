import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

// Regression test for the Horbury callback (queue 3e7ed426-f25c-4874-8e19-c4c8757a68fc,
// clob order 0xd37e1fa5...): a pre-existing execution whose stored order-event row and
// Ireland's retried accepted_open payload both predate the submitted_size field. Every
// other identity field matches. Prior to the fix, buildEconomicTelemetry/
// buildExecutionReconciliation required submitted_size unconditionally and threw,
// collapsing into HTTP 500 ECONOMIC_TELEMETRY_PERSISTENCE_FAILED on every retry and
// permanently blocking Ireland's callback drain.

const callbackSecret = "test-callback-secret";
process.env.EXECUTOR_CANDIDATES_SECRET = callbackSecret;

type EventRow = Record<string, unknown>;

const queue = {
  id: "3e7ed426-f25c-4874-8e19-c4c8757a68fc",
  reservation_id: "675efd97-6491-4986-a164-e7967dccf4a1",
  condition_id: "0x5e60c1eeda6683554e87fb5af318e265175cd3d76f2f7fd54c70fd1bee1247ab",
  token_id: "13808861454833442524206548411739151014335612520467050304443910162270774443085",
  side: "Yes",
  stake_usd: 2.5,
  status: "EXECUTED",
  idempotency_key: "bff1c9857b7cb4411b486a3835a0c6ab",
  diagnostics: {
    max_entry_price: 0.45,
    selected_signal_pair_id: "9dbcb089-1447-442b-839b-cbf4b802f78a",
  },
};

const eventRows: EventRow[] = [
  {
    id: "e207462a-1595-4438-a679-5c7e27236c70",
    created_at: "2026-08-25T18:00:53.958732+00:00",
    idempotency_key: queue.idempotency_key,
    clob_order_id: "0xd37e1fa52c9762f9478c697f4d0a0003c6cb790d75ab8b443641e3d96b32f9f6",
    condition_id: queue.condition_id,
    token_id: queue.token_id,
    side: "Yes",
    submitted_price: 0.45,
    submitted_size: null,
    stake_usd: 2.5,
    executor_meta: null,
  },
];

function response(data: unknown) {
  return { data, error: null };
}

function eventQuery() {
  let filters: Record<string, unknown> = {};
  let mutation: Record<string, unknown> | null = null;
  const query = {
    select(_columns: string) { return query; },
    eq(column: string, value: unknown) { filters[column] = value; return query; },
    update(record: Record<string, unknown>) { mutation = record; return query; },
    async maybeSingle() {
      return response(eventRows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null);
    },
    async single() {
      const row = eventRows.find((item) => Object.entries(filters).every(([key, value]) => item[key] === value));
      if (!row) return { data: null, error: { message: "row not found" } };
      if (mutation) Object.assign(row, mutation);
      return response(row);
    },
  };
  return query;
}

function queueQuery() {
  const query = {
    select(_columns: string) { return query; },
    eq(_column: string, _value: unknown) { return query; },
    async maybeSingle() { return response(queue); },
    async single() { return response(queue); },
  };
  return query;
}

const sourceSignalPair = {
  id: "9dbcb089-1447-442b-839b-cbf4b802f78a",
  condition_id: queue.condition_id,
  selected_token_id: queue.token_id,
  selected_outcome: queue.side,
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(table: string) {
        if (table === "executor_order_events") return eventQuery();
        if (table === "event_execution_queue") return queueQuery();
        if (table === "generated_signal_pairs") {
          return { select() { return this; }, eq() { return this; }, async maybeSingle() { return response(sourceSignalPair); } };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
  },
});

function request(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost/api/executor/order-events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-executor-secret": callbackSecret },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// Exact shape of Ireland's retried accepted_open callback for the live Horbury
// execution: no submitted_size field anywhere in the payload.
const legacyAcceptedOpenCallback = {
  side: "Yes",
  state: "accepted_open",
  order_id: "0xd37e1fa52c9762f9478c697f4d0a0003c6cb790d75ab8b443641e3d96b32f9f6",
  queue_id: queue.id,
  token_id: queue.token_id,
  stake_usd: 2.5,
  candidate_id: queue.id,
  condition_id: queue.condition_id,
  execution_id: 163,
  clob_order_id: "0xd37e1fa52c9762f9478c697f4d0a0003c6cb790d75ab8b443641e3d96b32f9f6",
  reservation_id: queue.reservation_id,
  idempotency_key: queue.idempotency_key,
  max_entry_price: 0.45,
  submitted_price: 0.45,
};

test("legacy accepted_open callback without submitted_size persists economic telemetry instead of 500ing", async () => {
  const { POST } = await import("../../app/api/executor/order-events/route");
  const first = await POST(request(legacyAcceptedOpenCallback));
  const firstBody = await first.json();
  assert.equal(first.status, 200, `expected 200, got ${first.status}: ${JSON.stringify(firstBody)}`);
  assert.equal(firstBody.success, true);

  const expectedRequestedShares = queue.stake_usd / 0.45;
  assert.equal(firstBody.economic_telemetry.requested.requested_shares, expectedRequestedShares);
  assert.equal(firstBody.reconciliation.requested_shares, expectedRequestedShares);
  assert.equal(firstBody.reconciliation.fill_status, "ACCEPTED_OPEN");

  // Ireland retries the identical callback (the durable-blocking scenario). Must
  // stay 200, never regress to 500 on the retry path.
  const retry = await POST(request(legacyAcceptedOpenCallback));
  const retryBody = await retry.json();
  assert.equal(retry.status, 200, `expected 200 on retry, got ${retry.status}: ${JSON.stringify(retryBody)}`);
  assert.equal(retryBody.duplicate, true);
});
