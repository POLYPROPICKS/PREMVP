// Contour identity continuity at the PREMVP callback boundary, DEV process (default contour).
// Mismatch -> 409 before any DB access; absent contour_id -> explicit legacy compatibility (request
// proceeds to normal validation). fetch is stubbed to prove the 409 path performs zero DB traffic.

import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.CONSTRUCTOR_ACTIVE_CONTOUR;
process.env.EXECUTOR_CANDIDATES_SECRET = "dev-secret";
process.env.SUPABASE_URL = "http://dev.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dev-key";

let fetchCalls = 0;
globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("NETWORK_FORBIDDEN_IN_TEST"); }) as typeof fetch;

import { checkCallbackContour } from "../../lib/constructor/contourIdentity";
import { getContour } from "../../lib/constructor/registry";

const headers = { "x-executor-secret": "dev-secret", "content-type": "application/json" };

test("pure verdicts: match, mismatch, malformed, legacy-absent (DEV only)", () => {
  const dev = getContour("DEV_LIVE");
  const shadow = getContour("PROD_SHADOW");
  assert.deepEqual(checkCallbackContour(dev, "DEV_LIVE"), { ok: true, basis: "MATCH" });
  assert.deepEqual(checkCallbackContour(dev, "PROD_SHADOW"), { ok: false, code: "CONTOUR_ID_MISMATCH" });
  assert.deepEqual(checkCallbackContour(dev, 7), { ok: false, code: "CONTOUR_ID_MALFORMED" });
  assert.deepEqual(checkCallbackContour(dev, " "), { ok: false, code: "CONTOUR_ID_MALFORMED" });
  assert.deepEqual(checkCallbackContour(dev, undefined), { ok: true, basis: "LEGACY_UNSPECIFIED" });
  assert.deepEqual(checkCallbackContour(shadow, undefined), { ok: false, code: "CONTOUR_ID_REQUIRED" });
});

for (const [name, mod, base] of [
  ["queue/mark", "../../app/api/executor/queue/mark/route", { queue_id: "q1", status: "CLAIMED", source: "ireland_queue_only" }],
  ["order-events", "../../app/api/executor/order-events/route", { event: "x" }],
] as const) {
  test(`DEV ${name}: foreign contour_id -> 409 CONTOUR_ID_MISMATCH, zero DB traffic`, async () => {
    const { POST } = (await import(mod)) as { POST: (r: never) => Promise<Response> };
    const res = await POST(new Request("http://localhost/x", { method: "POST", headers, body: JSON.stringify({ ...base, contour_id: "PROD_SHADOW" }) }) as never);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "CONTOUR_ID_MISMATCH");
    assert.equal(fetchCalls, 0);
  });
  test(`DEV ${name}: absent contour_id is legacy-compatible (not a 409)`, async () => {
    const { POST } = (await import(mod)) as { POST: (r: never) => Promise<Response> };
    const res = await POST(new Request("http://localhost/x", { method: "POST", headers, body: JSON.stringify({}) }) as never);
    assert.notEqual(res.status, 409);
    assert.notEqual(res.status, 403);
  });
}
