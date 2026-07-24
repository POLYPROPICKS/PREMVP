import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchGammaWeatherPage, GammaFetchError, gammaWeatherUrl, GAMMA_RESPONSE_CAP_BYTES } from "../../lib/weather/integrations/gamma/readOnlyGammaFetch";
import { buildGammaProofReport, runGammaReadOnlyProof } from "../../lib/weather/reporting/gammaReadOnlyProof";
import { validateGammaPage } from "../../lib/weather/inventory/gammaInventory";
import { adaptGammaWeatherPage } from "../../lib/weather/integrations/gamma/gammaWeatherAdapter";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("default proof request is one cap-preserving Gamma keyset page without retry or pagination", () => {
  const url = gammaWeatherUrl();
  assert.equal(url.pathname, "/markets/keyset");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.get("active"), "true");
  assert.equal(url.searchParams.get("closed"), "false");
  assert.equal(url.searchParams.get("ascending"), "true");
  assert.equal(url.searchParams.has("offset"), false);
  assert.equal(url.searchParams.has("after_cursor"), false);
  assert.equal(GAMMA_RESPONSE_CAP_BYTES, 1_048_576);
});

test("flat keyset wrapper validates and emits authoritative market and token identities", () => {
  const wrapper = { $schema: "market-keyset", markets: [{ id: "market", conditionId: "condition-flat", question: "Temperature at KJFK", outcomes: JSON.stringify(["Yes", "No"]), clobTokenIds: JSON.stringify(["token-flat-yes", "token-flat-no"]) }], next_cursor: "cursor" };
  const adapted = adaptGammaWeatherPage(validateGammaPage(wrapper, "keyset:0"));
  assert.equal(adapted.markets.length, 1);
  assert.equal(adapted.markets[0].conditionId, "condition-flat");
  assert.deepEqual(adapted.markets[0].outcomes.map((outcome) => outcome.tokenId), ["token-flat-yes", "token-flat-no"]);
  assert.ok(adapted.markets[0].outcomes.every((outcome) => outcome.canonicalContractId.includes("weather-contract:")));
});

test("nested events remain compatible while malformed flat records fail closed", () => {
  const nested = [{ id: "event", markets: [{ id: "market", condition_id: "condition-nested", outcomes: ["Yes"], clobTokenIds: ["token-nested"] }] }];
  assert.equal(adaptGammaWeatherPage(validateGammaPage(nested, "events:0")).markets.length, 1);
  const malformed = { markets: [{ id: "market", outcomes: ["Yes"], clobTokenIds: ["token"] }] };
  const result = adaptGammaWeatherPage(validateGammaPage(malformed, "keyset:bad"));
  assert.equal(result.markets.length, 0);
  assert.equal(result.trace.firstRejectionReason, "MISSING_CONDITION_ID");
  const malformedEncoded = { markets: [{ id: "market", conditionId: "condition", outcomes: "not-json", clobTokenIds: JSON.stringify(["token"]) }] };
  assert.equal(adaptGammaWeatherPage(validateGammaPage(malformedEncoded, "keyset:encoded")).markets.length, 0);
  assert.throws(() => validateGammaPage({ markets: [], next_cursor: 1 }, "keyset:cursor"), /GAMMA_ENVELOPE_INVALID/);
});

test("proof separates raw, identity-valid, and Weather-attributed selection counts", async () => {
  const flatMarkets = Array.from({ length: 10 }, (_, index) => ({ id: `market-${index}`, conditionId: `condition-${index}`, question: "Politics at KJFK", outcomes: ["Yes", "No"], clobTokenIds: [`token-${index}-yes`, `token-${index}-no`] }));
  globalThis.fetch = (async () => new Response(JSON.stringify({ markets: flatMarkets, next_cursor: "cursor" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const proof = await runGammaReadOnlyProof();
  assert.equal(proof.snapshot.rawMarkets, 10);
  assert.equal(proof.snapshot.identityValidMarkets, 10);
  assert.equal(proof.snapshot.identityContracts, 20);
  assert.equal(proof.snapshot.weatherAttributedMarkets, 0);
  assert.equal(proof.snapshot.weatherAttributedContracts, 0);
  assert.equal(proof.snapshot.attributionCounts.REJECTED, 10);
  assert.equal(proof.traces.find((trace) => trace.stage === "attribution")?.first_rejection_reason, "NON_WEATHER");
  const report = buildGammaProofReport(proof);
  assert.match(report.markdown, /Identity-valid markets: 10/);
  assert.match(report.markdown, /Identity contracts: 20/);
  assert.match(report.markdown, /Weather-attributed markets: 0/);
  assert.match(report.markdown, /Weather-attributed contracts: 0/);
  assert.doesNotMatch(report.markdown, /accepted markets|Raw\/accepted\/contracts/i);
});

test("malformed encoded identities fail closed with the typed rejection", () => {
  const malformedCases = [
    { outcomes: JSON.stringify({ outcome: "Yes" }), clobTokenIds: JSON.stringify(["token"]) },
    { outcomes: JSON.stringify(["Yes", 2]), clobTokenIds: JSON.stringify(["token-yes", "token-no"]) },
    { outcomes: JSON.stringify(["Yes", ""]), clobTokenIds: JSON.stringify(["token-yes", "token-no"]) },
    { outcomes: JSON.stringify(["Yes"]), clobTokenIds: JSON.stringify(["token-yes", "token-no"]) },
  ];
  for (const malformed of malformedCases) {
    const result = adaptGammaWeatherPage(validateGammaPage({ markets: [{ id: "market", conditionId: "condition", ...malformed }] }, "keyset:malformed"));
    assert.equal(result.markets.length, 0);
    assert.equal(result.trace.firstRejectionReason, "MALFORMED_OUTCOMES_OR_TOKENS");
  }
});

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
  assert.equal(proof.snapshot.identityContracts, 2);
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
