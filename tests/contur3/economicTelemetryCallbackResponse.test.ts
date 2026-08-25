import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

const callbackSecret = "test-callback-secret";
process.env.EXECUTOR_CANDIDATES_SECRET = callbackSecret;

type EventRow = Record<string, unknown>;

const queue = {
  id: "queue-economic-response-1",
  reservation_id: "reservation-economic-response-1",
  plan_run_id: "plan-economic-response-1",
  rebalance_run_id: "rebalance-economic-response-1",
  match_family_key: "economic-response-match",
  event_title: "Economic response match",
  event_slug: "economic-response-match",
  sport: "soccer",
  league: null,
  game_start_iso: "2026-08-25T12:00:00.000Z",
  condition_id: "condition-economic-response-1",
  token_id: "token-economic-response-1",
  side: "YES",
  market_slug: "economic-response-market",
  market_title: "economic-response-market",
  market_family: "allowed_fullmatch_moneyline",
  score: 80,
  coverage: 60,
  tier: "TIER1",
  stake_usd: 2.5,
  preferred_entry_iso: "2026-08-25T11:30:00.000Z",
  latest_entry_iso: "2026-08-25T11:55:00.000Z",
  selection_rank: 1,
  selection_reason: null,
  status: "READY",
  order_key: "condition-economic-response-1:token-economic-response-1:YES",
  idempotency_key: "idem-economic-response-1",
  diagnostics: { max_entry_price: 0.5 },
};

const eventRows: EventRow[] = [];

function response(data: unknown) {
  return { data, error: null };
}

function eventQuery() {
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
        const row = { ...inserted, id: `event-economic-response-${eventRows.length + 1}`, created_at: "2026-08-25T10:00:00.000Z" };
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
}

function queueQuery() {
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
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(table: string) {
        if (table === "executor_order_events") return eventQuery();
        if (table === "event_execution_queue") return queueQuery();
        if (table === "generated_signal_pairs") return { select() { return this; }, eq() { return this; }, async maybeSingle() { return response(null); } };
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

function callback(economic_telemetry_v1: Record<string, unknown>): Record<string, unknown> {
  return {
    queue_id: queue.id,
    reservation_id: queue.reservation_id,
    condition_id: queue.condition_id,
    token_id: queue.token_id,
    side: queue.side,
    idempotency_key: queue.idempotency_key,
    clob_order_id: "clob-economic-response-1",
    stake_usd: 2.5,
    submitted_price: 0.46,
    submitted_size: 5.43,
    economic_telemetry_v1,
  };
}

test("ECONOMIC_TELEMETRY_V1 callback responses acknowledge the persisted canonical record for insert and enrichment", async () => {
  const { POST } = await import("../../app/api/executor/order-events/route");
  const firstResponse = await POST(request(callback({ execution_status: "CONFIRMED" })));
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.success, true);
  assert.equal(first.duplicate, false);
  assert.equal(eventRows.length, 1);
  assert.deepEqual(first.economic_telemetry, (eventRows[0].executor_meta as Record<string, unknown>).economic_telemetry_v1);
  assert.notDeepEqual(first.economic_telemetry, { execution_status: "CONFIRMED" });

  const enrichmentResponse = await POST(request(callback({ execution_status: "MATCHED", executed_shares: 5.43, average_fill_price: 0.45, fee_usd: 0.01 })));
  assert.equal(enrichmentResponse.status, 200);
  const enrichment = await enrichmentResponse.json();
  assert.equal(enrichment.success, true);
  assert.equal(enrichment.duplicate, true);
  assert.equal(enrichment.event_id, first.event_id);
  assert.equal(eventRows.length, 1);
  assert.deepEqual(enrichment.economic_telemetry, (eventRows[0].executor_meta as Record<string, unknown>).economic_telemetry_v1);
  assert.equal(enrichment.economic_telemetry.executed.executed_shares.value, 5.43);
  assert.equal(enrichment.economic_telemetry.costs.fee_usd.value, 0.01);
});
