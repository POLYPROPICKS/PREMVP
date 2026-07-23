import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fetchPolymarketActiveEvents } from "../../lib/feed/polymarketClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("active-events request uses the Gamma-accepted volume24hr order field", async () => {
  let requestedUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await fetchPolymarketActiveEvents({ limit: 20, offset: 0 });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/events");
  assert.equal(url.searchParams.get("active"), "true");
  assert.equal(url.searchParams.get("closed"), "false");
  assert.equal(url.searchParams.get("order"), "volume24hr");
  assert.equal(url.searchParams.get("ascending"), "false");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.get("offset"), "0");
});
