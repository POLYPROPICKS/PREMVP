// PROD_SHADOW (moneyMovement=disabled) must reject executor CALLBACKS before any execution-lifecycle
// mutation: queue mark and order-events POST. fetch is stubbed to count outbound traffic (the Supabase
// client is fetch-based), so "zero mutation" is observed, not assumed.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CONSTRUCTOR_ACTIVE_CONTOUR = "PROD_SHADOW";
process.env.SHADOW_EXECUTOR_CANDIDATES_SECRET = "shadow-secret-placeholder";
process.env.SHADOW_SUPABASE_URL = "http://shadow.invalid";
process.env.SHADOW_SUPABASE_SERVICE_ROLE_KEY = "shadow-key-placeholder";
for (const k of ["EXECUTOR_CANDIDATES_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k];

let fetchCalls = 0;
globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("NETWORK_FORBIDDEN_IN_TEST"); }) as typeof fetch;

const headers = { "x-executor-secret": "shadow-secret-placeholder", "content-type": "application/json" };
const body = JSON.stringify({ queue_id: "q1", status: "EXECUTED", source: "ireland_queue_only", live_order_confirmed: true, contour_id: "PROD_SHADOW" });

test("passive: queue/mark POST -> 403 blocked, zero DB traffic; 401 without secret", async () => {
  const { POST } = await import("../../app/api/executor/queue/mark/route");
  const url = "http://localhost/api/executor/queue/mark";
  assert.equal((await POST(new Request(url, { method: "POST", body }) as never)).status, 401);
  const res = await POST(new Request(url, { method: "POST", headers, body }) as never);
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/);
  assert.equal(fetchCalls, 0);
});

test("passive: order-events POST -> 403 blocked before maker-fallback/ledger/queue-mark, zero DB traffic", async () => {
  const { POST } = await import("../../app/api/executor/order-events/route");
  const url = "http://localhost/api/executor/order-events";
  assert.equal((await POST(new Request(url, { method: "POST", body }) as never)).status, 401);
  const res = await POST(new Request(url, { method: "POST", headers, body }) as never);
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/);
  assert.equal(fetchCalls, 0);
});
