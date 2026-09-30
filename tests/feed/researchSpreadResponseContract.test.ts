import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fetchSpreadSafe } from "../../lib/feed/polymarketClient";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("CLOB spread scalar passes through; missing and invalid evidence stays null", async () => {
  const reply = (body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body))) as typeof fetch;
  };

  reply({ spread: "0.01" });
  assert.equal(await fetchSpreadSafe("token-1"), 0.01);
  reply({ spread: 0 });
  assert.equal(await fetchSpreadSafe("token-1"), 0);
  for (const body of [{}, { spread: "" }, { spread: "NaN" }, { spread: -0.01 }]) {
    reply(body);
    assert.equal(await fetchSpreadSafe("token-1"), null);
  }
});
