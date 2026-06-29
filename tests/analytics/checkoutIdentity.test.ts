import test from "node:test";
import assert from "node:assert/strict";
import { resolveDistinctId } from "../../lib/analytics/identity";
import { captureServerEvent } from "../../lib/analytics/serverCapture";
import { PPP_EVENTS } from "../../lib/analytics/events";

const TOKEN = "phc_test_token_value";

// Mirrors how app/api/checkout/create/route.ts composes identity stitching:
//   distinctId = resolveDistinctId({ body, headers }) ?? leadIntentId
// then captures the checkout event under that id. Uses the REAL helpers + a fake
// fetch so the composition is exercised, not mocked away.
async function runCheckoutCapture(opts: {
  body: Record<string, unknown>;
  headers: Headers;
  leadIntentId: string;
}): Promise<{ distinctId: string; identityStitched: boolean }> {
  const browserId = resolveDistinctId({ body: opts.body, headers: opts.headers });
  const distinctId = browserId ?? opts.leadIntentId;

  let posted: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    posted = JSON.parse(String(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await captureServerEvent(PPP_EVENTS.CHECKOUT_START, {
    env: { NEXT_PUBLIC_POSTHOG_KEY: TOKEN },
    fetchImpl,
    distinctId,
    properties: { identity_stitched: Boolean(browserId) },
  });

  return {
    distinctId: String(posted.distinct_id),
    identityStitched: Boolean(
      (posted.properties as Record<string, unknown>).identity_stitched
    ),
  };
}

test("checkout capture uses the browser distinct id when provided (body)", async () => {
  const result = await runCheckoutCapture({
    body: { analyticsDistinctId: "browser-person-1" },
    headers: new Headers(),
    leadIntentId: "lead-uuid",
  });
  assert.equal(result.distinctId, "browser-person-1");
  assert.equal(result.identityStitched, true);
});

test("checkout capture uses the browser distinct id from header fallback", async () => {
  const result = await runCheckoutCapture({
    body: {},
    headers: new Headers({ "x-posthog-distinct-id": "browser-person-2" }),
    leadIntentId: "lead-uuid",
  });
  assert.equal(result.distinctId, "browser-person-2");
  assert.equal(result.identityStitched, true);
});

test("checkout capture falls back to leadIntentId without a distinct id", async () => {
  const result = await runCheckoutCapture({
    body: {},
    headers: new Headers(),
    leadIntentId: "lead-uuid-fallback",
  });
  assert.equal(result.distinctId, "lead-uuid-fallback");
  assert.equal(result.identityStitched, false);
});

test("an email is never accepted as the checkout distinct id (falls back)", async () => {
  const result = await runCheckoutCapture({
    body: { analyticsDistinctId: "buyer@example.com" },
    headers: new Headers(),
    leadIntentId: "lead-uuid-fallback",
  });
  assert.equal(result.distinctId, "lead-uuid-fallback");
  assert.equal(result.identityStitched, false);
});
