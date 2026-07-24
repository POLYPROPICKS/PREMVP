import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchGammaWeatherPage, GammaFetchError } from "../../lib/weather/integrations/gamma/readOnlyGammaFetch";
import { buildGammaProofReport, runGammaReadOnlyProof } from "../../lib/weather/reporting/gammaReadOnlyProof";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("read-only Gamma boundary rejects non-2xx, timeout, and oversized bodies", async () => {
  globalThis.fetch = (async () => new Response("no", { status: 503 })) as typeof fetch;
  await assert.rejects(fetchGammaWeatherPage(), (error: unknown) => error instanceof GammaFetchError && error.code === "HTTP_STATUS");
  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
  await assert.rejects(fetchGammaWeatherPage({ timeoutMs: 1 }), (error: unknown) => error instanceof GammaFetchError && error.code === "TIMEOUT");
  globalThis.fetch = (async () => new Response("x".repeat(20), { status: 200, headers: { "content-type": "application/json", "content-length": "20" } })) as typeof fetch;
  await assert.rejects(fetchGammaWeatherPage({ maxBytes: 10 }), (error: unknown) => error instanceof GammaFetchError && error.code === "RESPONSE_TOO_LARGE");
  globalThis.fetch = (async () => new Response("[]", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
  await assert.rejects(fetchGammaWeatherPage(), (error: unknown) => error instanceof GammaFetchError && error.code === "CONTENT_TYPE");
});

test("proof pipeline validates a real-shaped envelope without DB writes and reports only metadata", async () => {
  const body = JSON.stringify([{ id: "evt", title: "Temperature in KJFK", markets: [{ id: "market", condition_id: "condition", question: "Temperature at KJFK", outcomes: ["Yes", "No"], clobTokenIds: ["token-yes", "token-no"] }] }]);
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const proof = await runGammaReadOnlyProof({ now: () => "2026-07-24T00:00:00.000Z" });
  assert.equal(proof.snapshot.rawMarkets, 1);
  assert.equal(proof.snapshot.contracts, 2);
  assert.equal(proof.databaseWrites, 0);
  assert.equal(proof.supabaseAccess, 0);
  const report = buildGammaProofReport(proof);
  assert.ok(!report.json.includes(body));
  assert.equal(proof.responseSha256.length, 64);
  assert.ok(proof.traces.every((trace) => typeof trace.elapsed_ms === "number" && "first_rejection_reason" in trace));
  assert.match(report.markdown, /postgres_proven: NO/);
});

test("malformed Gamma JSON fails closed before identity extraction", async () => {
  globalThis.fetch = (async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  await assert.rejects(runGammaReadOnlyProof(), /GAMMA_PROOF_VALIDATION:INVALID_JSON/);
});
