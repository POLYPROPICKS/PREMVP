import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import {
  applyResolvedOutcomeToExecutionReconciliation,
  mergeExecutionReconciliationMeta,
  readExecutionReconciliation,
} from "../../lib/executor/executionReconciliation";

const callbackSecret = "test-callback-secret";
process.env.EXECUTOR_CANDIDATES_SECRET = callbackSecret;

type EventRow = Record<string, unknown>;

const queue = {
  id: "30943442-944a-4315-890b-dd8d155ed1fc",
  reservation_id: "90043370-2df4-4fd2-b304-577db36d7666",
  plan_run_id: "plan-economic-response-1",
  rebalance_run_id: "rebalance-economic-response-1",
  match_family_key: "economic-response-match",
  event_title: "Economic response match",
  event_slug: "economic-response-match",
  sport: "soccer",
  league: null,
  game_start_iso: "2026-08-25T12:00:00.000Z",
  condition_id: "0x671ebd9e39fdd2f02b94e760777a9c1cff0b41228dce4f3cd0d741985c658cb4",
  token_id: "104239854151768560966171762972745367000691011492249674399354668327706979042420",
  side: "Yes",
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
  order_key: "economic-response-order",
  idempotency_key: "c6daa3b33974e7dea01f300ff67e80ab",
  diagnostics: {
    max_entry_price: 0.5,
    selected_signal_pair_id: "2dd087ba-bfdf-4c96-b5c6-3fc4a0005e7f",
  },
};

const eventRows: EventRow[] = [];
const sourceSignalPair = {
  id: "2dd087ba-bfdf-4c96-b5c6-3fc4a0005e7f",
  condition_id: queue.condition_id,
  selected_token_id: queue.token_id,
  selected_outcome: queue.side,
};

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
        if (table === "generated_signal_pairs") return { select() { return this; }, eq() { return this; }, async maybeSingle() { return response(sourceSignalPair); } };
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
    clob_order_id: "0x7fcfd65b1efbc8d06d6ffdac7a39cb4271ca997e205f91420519f68e98d50d5b",
    stake_usd: 2.5,
    submitted_price: 0.37,
    submitted_size: 6.75,
    economic_telemetry_v1,
  };
}

test("ECONOMIC_TELEMETRY_V1 same-record enrichment survives lifecycle reconciliation", async () => {
  const { POST } = await import("../../app/api/executor/order-events/route");
  const firstResponse = await POST(request(callback({
    execution_status: "CONFIRMED",
    executed_shares: 6.75,
    average_fill_price: 0.37,
    fee_rate_bps: 0,
    fee_usd_evidence_state: "NOT_YET_AVAILABLE",
    collateral_balance_usd: 68.48146,
    wallet_observation_lifecycle_point: "CURRENT_SNAPSHOT",
    wallet_observed_at: "2026-08-25T10:00:00.000Z",
  })));
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.success, true);
  assert.equal(first.duplicate, false);
  assert.equal(eventRows.length, 1);
  assert.deepEqual(first.economic_telemetry, (eventRows[0].executor_meta as Record<string, unknown>).economic_telemetry_v1);
  assert.notDeepEqual(first.economic_telemetry, { execution_status: "CONFIRMED" });

  const prior = readExecutionReconciliation(eventRows[0].executor_meta);
  assert.ok(prior);
  const lifecycleMeta = mergeExecutionReconciliationMeta(
    eventRows[0].executor_meta as Record<string, unknown>,
    applyResolvedOutcomeToExecutionReconciliation(prior, {
      resolved_at: "2026-08-25T11:00:00.000Z",
      winning_outcome: "NO",
      winning_token_id: "token-economic-response-lost",
    }),
  );
  delete (lifecycleMeta.reconciliation_v1 as Record<string, unknown>).provider_event_id;
  eventRows[0].executor_meta = lifecycleMeta;

  const enrichmentResponse = await POST(request(callback({
    fee_usd: 0,
    spendable_balance_usd: 68.48146,
    wallet_observation_lifecycle_point: "CURRENT_SNAPSHOT",
    wallet_observed_at: "2026-08-25T12:00:00.000Z",
  })));
  assert.equal(enrichmentResponse.status, 200);
  const enrichment = await enrichmentResponse.json();
  assert.equal(enrichment.success, true);
  assert.equal(enrichment.duplicate, true);
  assert.equal(enrichment.event_id, first.event_id);
  assert.equal(eventRows.length, 1);
  assert.deepEqual(enrichment.economic_telemetry, (eventRows[0].executor_meta as Record<string, unknown>).economic_telemetry_v1);
  assert.equal(enrichment.economic_telemetry.executed.executed_shares.value, 6.75);
  assert.equal(enrichment.economic_telemetry.costs.fee_usd.value, 0);
  assert.equal(enrichment.economic_telemetry.wallet.spendable_balance_usd.value, 68.48146);
  assert.equal(enrichment.reconciliation.fill_status, "MATCHED_CONFIRMED");
  assert.equal(enrichment.reconciliation.actual_fill_price, 0.37);
  assert.equal(enrichment.reconciliation.executed_notional_usd, 2.4975);
  assert.equal(enrichment.reconciliation.result_status, "LOST");
  assert.equal(enrichment.reconciliation.gross_pnl_usd, -2.4975);
  assert.equal(enrichment.reconciliation.resolved_at, "2026-08-25T11:00:00.000Z");
  assert.equal(enrichment.reconciliation.settlement_status, "SETTLED_RECONCILED");

  const immutableConflictResponse = await POST(request({
    ...callback({ fee_usd: 0 }),
    submitted_price: 0.369,
  }));
  assert.equal(immutableConflictResponse.status, 409);
  assert.deepEqual(await immutableConflictResponse.json(), {
    success: false,
    error: "IDEMPOTENCY_CONFLICT",
  });
  assert.equal(eventRows.length, 1);
});
