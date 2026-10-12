// TELEMETRY-08C transport: Gamma `GET /events?id=..&limit=N` batch of CURRENT event starts.
//   node --import tsx --test tests/contur3/gammaEventStartsBatch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPolymarketEventStartsByIds, GAMMA_EVENTS_BATCH_LIMIT } from "../../lib/feed/polymarketClient";

async function withFetch<T>(impl: (url: string) => Promise<Response>, run: (urls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => { urls.push(String(input)); return impl(String(input)); }) as typeof fetch;
  try { return await run(urls); } finally { globalThis.fetch = original; }
}
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

test("batch: one request with every id and an explicit limit; scalar projection only; acquisition time precedes the response", async () => {
  const before = Date.now();
  const out = await withFetch(
    () => json([{ id: 11, gameId: 5, startTime: "2026-10-12T10:00:00Z", endDate: "2026-10-12T12:00:00Z", markets: [{ huge: true }] }, { id: "12", gameId: null }]),
    async (urls) => { const r = await fetchPolymarketEventStartsByIds(["11", "12"]); assert.equal(urls.length, 1); assert.match(urls[0], /\/events\?id=11&id=12&limit=2$/); return r; },
  );
  assert.ok(out);
  assert.deepEqual(out.events, [
    { id: "11", gameId: "5", startTime: "2026-10-12T10:00:00Z", endDate: "2026-10-12T12:00:00Z", endDateIso: null },
    { id: "12", gameId: null, startTime: null, endDate: null, endDateIso: null },
  ]);
  assert.ok(out.acquiredAtMs >= before && out.acquiredAtMs <= Date.now());
  assert.equal(out.requestedN, 2);
});

test("batch: oversized, duplicated, empty or non-numeric id lists are refused before any request (no unbounded provider calls)", async () => {
  await withFetch(() => json([]), async (urls) => {
    const ids = Array.from({ length: GAMMA_EVENTS_BATCH_LIMIT + 1 }, (_, i) => String(i + 1));
    assert.equal(GAMMA_EVENTS_BATCH_LIMIT, 20, "Gamma silently truncates beyond its default page of 20");
    assert.equal(await fetchPolymarketEventStartsByIds(ids), null);
    assert.equal(await fetchPolymarketEventStartsByIds(["1", "1"]), null);
    assert.equal(await fetchPolymarketEventStartsByIds([]), null);
    assert.equal(await fetchPolymarketEventStartsByIds(["1a"]), null);
    assert.equal(urls.length, 0);
  });
});

test("batch: HTTP error, non-list body and transport failure are null (caller fails closed); missing ids are NOT repaired here", async () => {
  assert.equal(await withFetch(() => json({ error: "x" }, 500), () => fetchPolymarketEventStartsByIds(["1"])), null);
  assert.equal(await withFetch(() => json({ not: "a list" }), () => fetchPolymarketEventStartsByIds(["1"])), null);
  assert.equal(await withFetch(() => Promise.reject(new Error("net")), () => fetchPolymarketEventStartsByIds(["1"])), null);
  const partial = await withFetch(() => json([{ id: "1", startTime: "2026-10-12T10:00:00Z" }]), () => fetchPolymarketEventStartsByIds(["1", "2"]));
  assert.deepEqual(partial?.events.map((e) => e.id), ["1"], "id 2 is simply absent: completeness is proven by the caller");
});
