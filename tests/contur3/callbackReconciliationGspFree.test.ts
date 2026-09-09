// B4: CALLBACK RECONCILIATION IS GSP-FREE
//   node --experimental-test-module-mocks --import tsx --test tests/contur3/callbackReconciliationGspFree.test.ts
//
// Business result under test: persistExecutionReconciliation (the callback
// route's reconciliation step) resolves Queue + immutable order-event +
// callback identity WITHOUT reading generated_signal_pairs. source_signal_pair_id
// remains historical/diagnostic lineage carried through Queue's own
// diagnostics -- it is never a live read prerequisite, and its absence must
// never block a valid reconciliation. Fail-closed identity conflict handling,
// duplicate/idempotent callback behavior, and reconciliation persistence
// guards are unchanged.
//
// Enters through the REAL production route (POST /api/executor/order-events)
// -- never a hand-assembled reconciliation object.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

const callbackSecret = "test-callback-secret";
process.env.EXECUTOR_CANDIDATES_SECRET = callbackSecret;

type EventRow = Record<string, unknown>;

let gspReadCount = 0;

function baseQueue(overrides: Record<string, unknown> = {}) {
  return {
    id: "b4-queue-1",
    reservation_id: "b4-reservation-1",
    plan_run_id: "plan-b4-1",
    rebalance_run_id: "rebalance-b4-1",
    match_family_key: "b4-match",
    event_title: "B4 GSP-free callback fixture",
    event_slug: "b4-gsp-free-event",
    sport: "soccer",
    league: null,
    game_start_iso: "2026-09-10T12:00:00.000Z",
    condition_id: "0xb4-condition-id",
    token_id: "b4-token-id",
    side: "Yes",
    market_slug: "b4-market",
    market_title: "b4-market",
    market_family: "allowed_fullmatch_moneyline",
    score: 80,
    coverage: 60,
    tier: "TIER1",
    stake_usd: 2.5,
    preferred_entry_iso: "2026-09-10T11:30:00.000Z",
    latest_entry_iso: "2026-09-10T11:55:00.000Z",
    selection_rank: 1,
    selection_reason: null,
    status: "READY",
    order_key: "b4-order-key",
    idempotency_key: "b4-idempotency-key",
    diagnostics: { max_entry_price: 0.5, selected_signal_pair_id: "b4-source-signal-pair-id" },
    ...overrides,
  };
}

function response(data: unknown) {
  return { data, error: null };
}

function makeEventQuery(eventRows: EventRow[]) {
  return function eventQuery() {
    let filters: Record<string, unknown> = {};
    let mutation: Record<string, unknown> | null = null;
    let inserted: Record<string, unknown> | null = null;
    const query = {
      select(_columns: string) { return query; },
      eq(column: string, value: unknown) { filters[column] = value; return query; },
      insert(record: Record<string, unknown>) { inserted = record; return query; },
      update(record: Record<string, unknown>) { mutation = record; return query; },
      async maybeSingle() {
        return response(eventRows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null);
      },
      async single() {
        if (inserted) {
          const row = { ...inserted, id: `event-b4-${eventRows.length + 1}`, created_at: "2026-09-10T10:00:00.000Z" };
          eventRows.push(row);
          return response(row);
        }
        const row = eventRows.find((item) => Object.entries(filters).every(([key, value]) => item[key] === value));
        if (!row) return { data: null, error: { message: "row not found" } };
        if (mutation) Object.assign(row, mutation);
        return response(row);
      },
    };
    return query;
  };
}

function makeQueueQuery(queue: Record<string, unknown>) {
  return function queueQuery() {
    let mutation: Record<string, unknown> | null = null;
    const query = {
      select(_columns: string) { return query; },
      eq(_column: string, _value: unknown) { return query; },
      update(record: Record<string, unknown>) { mutation = record; return query; },
      async maybeSingle() { return response(queue); },
      async single() { return response(queue); },
      then(resolve: (value: { data: null; error: null }) => unknown) {
        if (mutation) Object.assign(queue, mutation);
        return Promise.resolve(resolve({ data: null, error: null }));
      },
    };
    return query;
  };
}

let currentQueue: Record<string, unknown> = baseQueue();
let currentEventRows: EventRow[] = [];

// node:test's mock.module can only mock a given module specifier ONCE per
// process, so the mock is installed a single time at module load and reads
// through the mutable currentQueue/currentEventRows refs each call --
// installMock() below just swaps what those refs point to per test.
mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(table: string) {
        if (table === "executor_order_events") return makeEventQuery(currentEventRows)();
        if (table === "event_execution_queue") return makeQueueQuery(currentQueue)();
        if (table === "generated_signal_pairs") {
          // B4: this table must NEVER be read by callback reconciliation.
          // Counting (rather than throwing) lets every test assert the
          // exact call count even if a future regression only partially
          // reintroduces the read.
          gspReadCount += 1;
          return { select() { return this; }, eq() { return this; }, async maybeSingle() { return response(null); } };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
  },
});

function installMock(queue: Record<string, unknown>, eventRows: EventRow[]) {
  gspReadCount = 0;
  currentQueue = queue;
  currentEventRows = eventRows;
}

function request(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost/api/executor/order-events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-executor-secret": callbackSecret },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function validCallback(queue: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    queue_id: queue.id,
    reservation_id: queue.reservation_id,
    condition_id: queue.condition_id,
    token_id: queue.token_id,
    side: queue.side,
    idempotency_key: queue.idempotency_key,
    clob_order_id: "0xb4-clob-order-id",
    stake_usd: queue.stake_usd,
    submitted_price: 0.4,
    submitted_size: 6.25,
    ...overrides,
  };
}

// ── A, B: valid Queue-backed callback, zero GSP reads, source_signal_pair_id stays lineage ──

test("CB4-1: a valid callback persists reconciliation with zero generated_signal_pairs reads, and source_signal_pair_id survives as lineage only", async () => {
  const queue = baseQueue();
  installMock(queue, []);
  const { POST } = await import("../../app/api/executor/order-events/route");

  const res = await POST(request(validCallback(queue)));
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(gspReadCount, 0, "callback reconciliation must never read generated_signal_pairs");
  assert.ok(body.reconciliation, "reconciliation must be persisted for a valid callback");
  assert.equal(body.reconciliation.queue_id, queue.id);
  assert.equal(body.reconciliation.condition_id, queue.condition_id);
  assert.equal(body.reconciliation.token_id, queue.token_id);
  assert.equal(body.reconciliation.side, queue.side);
  // Lineage only -- carried straight from Queue diagnostics, never validated
  // against a GSP row.
  assert.equal(body.reconciliation.source_signal_pair_id, "b4-source-signal-pair-id");
});

// ── C: source_signal_pair_id absent from Queue diagnostics still succeeds ──

test("CB4-2: a valid callback with NO source_signal_pair_id anywhere in Queue diagnostics still reconciles successfully with zero GSP reads", async () => {
  const queue = baseQueue({ diagnostics: { max_entry_price: 0.5 } });
  installMock(queue, []);
  const { POST } = await import("../../app/api/executor/order-events/route");

  const res = await POST(request(validCallback(queue)));
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(gspReadCount, 0);
  assert.ok(body.reconciliation);
  assert.equal(body.reconciliation.source_signal_pair_id, null, "no lineage available is a valid, non-blocking state");
});

// ── D: identity conflicts still fail closed exactly as before ──
//
// condition_id/token_id/side/queue_id/reservation_id conflicts are caught by
// the upstream queue-policy validation in handleOrderEventSubmission (before
// persistExecutionReconciliation is ever reached) -- that gate is untouched
// by this PR. Its failure responses don't carry a `success` key (they use
// `{ error, reason }` or `{ error }` shapes); the invariant this test proves
// is simply: never a 200, and never a GSP read.

for (const [label, patch] of [
  ["CONDITION_ID", { condition_id: "0x-wrong-condition-id" }],
  ["TOKEN_ID", { token_id: "wrong-token-id" }],
  ["SIDE", { side: "No" }],
  ["QUEUE_ID", { queue_id: "some-other-queue-id" }],
  ["RESERVATION_ID", { reservation_id: "some-other-reservation-id" }],
] as const) {
  test(`CB4-3-${label}: a callback whose ${label} conflicts with Queue identity fails closed (never 200), with zero GSP reads`, async () => {
    const queue = baseQueue();
    installMock(queue, []);
    const { POST } = await import("../../app/api/executor/order-events/route");

    const res = await POST(request(validCallback(queue, patch as Record<string, unknown>)));
    const body = await res.json();

    assert.notEqual(res.status, 200, JSON.stringify(body));
    assert.equal(gspReadCount, 0, "a fail-closed identity conflict must never reach a GSP read");
  });
}

test("CB4-3-CLOB_ORDER_ID: a retry callback with the SAME idempotency_key but a DIFFERENT clob_order_id fails closed, with zero GSP reads", async () => {
  const queue = baseQueue();
  const eventRows: EventRow[] = [];
  installMock(queue, eventRows);
  const { POST } = await import("../../app/api/executor/order-events/route");

  const first = await POST(request(validCallback(queue)));
  const firstBody = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  assert.equal(eventRows.length, 1);

  const retry = await POST(request(validCallback(queue, { clob_order_id: "0x-a-different-clob-order-id" })));
  const retryBody = await retry.json();

  assert.notEqual(retry.status, 200, JSON.stringify(retryBody));
  assert.equal(retryBody.success, false);
  assert.equal(eventRows.length, 1, "a conflicting retry must never insert a second event row");
  assert.equal(gspReadCount, 0, "a fail-closed clob_order_id conflict must never reach a GSP read");
});

// ── E: duplicate/idempotent callback behavior is unchanged ──

test("CB4-4: an identical duplicate callback returns duplicate:true, persists no second event row, and still performs zero GSP reads", async () => {
  const queue = baseQueue();
  const eventRows: EventRow[] = [];
  installMock(queue, eventRows);
  const { POST } = await import("../../app/api/executor/order-events/route");

  const first = await POST(request(validCallback(queue)));
  const firstBody = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  assert.equal(firstBody.duplicate, false);
  assert.equal(eventRows.length, 1);

  const second = await POST(request(validCallback(queue)));
  const secondBody = await second.json();
  assert.equal(second.status, 200, JSON.stringify(secondBody));
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.event_id, firstBody.event_id);
  assert.equal(eventRows.length, 1, "a duplicate callback must never insert a second order-event row");
  assert.equal(gspReadCount, 0);
});

// ── F: economic telemetry + reconciliation persistence guards unchanged ──

test("CB4-5: economic telemetry is built and persisted alongside reconciliation, and the persistence update is still guarded by idempotency_key + clob_order_id", async () => {
  const queue = baseQueue();
  const eventRows: EventRow[] = [];
  installMock(queue, eventRows);
  const { POST } = await import("../../app/api/executor/order-events/route");

  const res = await POST(request(validCallback(queue)));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.economic_telemetry, "economic telemetry must still be built and returned");
  assert.ok(body.reconciliation, "reconciliation must still be built and returned");

  // Persistence guard: the stored row must carry both identity keys the
  // update() call filters on (idempotency_key + clob_order_id), proving the
  // guarded update actually matched and wrote through.
  const stored = eventRows[0];
  assert.equal(stored.idempotency_key, queue.idempotency_key);
  assert.equal(stored.clob_order_id, "0xb4-clob-order-id");
  const storedMeta = stored.executor_meta as Record<string, unknown>;
  assert.ok(storedMeta.reconciliation_v1, "reconciliation_v1 must be persisted into executor_meta");
  assert.ok(storedMeta.economic_telemetry_v1, "economic_telemetry_v1 must be persisted into executor_meta");
});
