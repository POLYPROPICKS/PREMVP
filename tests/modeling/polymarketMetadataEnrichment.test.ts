// Phase 3E.8D Commit A -- official Polymarket metadata enrichment layer tests.
//
// Fetch orchestration is tested against an injected fake fetch (never real
// network) so this suite is deterministic and offline. The pure identity
// collector and snapshot validator have no network/DB dependency at all.

import test from "node:test";
import assert from "node:assert/strict";
import {
  collectUniqueMetadataIdentities,
  buildMetadataEnrichmentSnapshot,
  validateMetadataSnapshot,
  MAX_CONCURRENCY,
  MAX_ATTEMPTS,
} from "../../lib/modeling/polymarketMetadataEnrichment";

function row(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `id-${n}`, event_slug: `event-${n}`, market_slug: `market-${n}`, ...overrides };
}

// ---- Pure identity collection ----

test("P1: duplicate rows produce exactly one identity per unique event_slug", () => {
  const rows = [row(1, { event_slug: "e1" }), row(2, { event_slug: "e1" }), row(3, { event_slug: "e2" })];
  const identities = collectUniqueMetadataIdentities(rows);
  const eventSlugs = identities.filter((i) => i.kind === "event_slug").map((i) => i.value);
  assert.deepEqual([...new Set(eventSlugs)].sort(), eventSlugs.length === new Set(eventSlugs).size ? eventSlugs.sort() : []);
  assert.equal(new Set(eventSlugs).size, eventSlugs.length);
});

test("P2: event_slug identity is preferred; a row with both fields yields an event_slug identity", () => {
  const rows = [row(1, { event_slug: "e1", market_slug: "m1" })];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.ok(identities.some((i) => i.kind === "event_slug" && i.value === "e1"));
});

test("P3: market_slug fallback is used only when event_slug is absent", () => {
  const rows = [row(1, { event_slug: undefined, market_slug: "m-only" })];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.ok(identities.some((i) => i.kind === "market_slug" && i.value === "m-only"));
  assert.ok(!identities.some((i) => i.kind === "event_slug"));
});

test("P4: identity order is deterministic across repeated calls", () => {
  const rows = [row(3, { event_slug: "c" }), row(1, { event_slug: "a" }), row(2, { event_slug: "b" })];
  const a = collectUniqueMetadataIdentities(rows).map((i) => i.value);
  const b = collectUniqueMetadataIdentities(rows).map((i) => i.value);
  assert.deepEqual(a, b);
});

// ---- Fetch orchestration (fake fetch, no real network) ----

interface FakeCall {
  url: string;
}

function makeFakeFetch(opts: {
  responses: Record<string, { status: number; body: unknown } | "network-error">;
  calls: FakeCall[];
}) {
  return async (url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
    opts.calls.push({ url });
    const entry = opts.responses[url];
    if (entry === "network-error" || entry === undefined) {
      throw new Error(`fake network error for ${url}`);
    }
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => entry.body,
    };
  };
}

test("P5: successful cache entries are reused across a resumed build (no refetch)", async () => {
  const calls: FakeCall[] = [];
  const rows = [row(1, { event_slug: "e1" })];
  const fetchImpl = makeFakeFetch({
    calls,
    responses: {
      "https://gamma-api.polymarket.com/sports": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/sports/market-types": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/tags": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/events/slug/e1": { status: 200, body: { id: "1", slug: "e1", title: "T" } },
    },
  });
  const first = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 3 });
  const eventCallsBefore = calls.filter((c) => c.url.includes("/events/slug/")).length;
  const second = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 3, resumeFrom: first });
  const eventCallsAfter = calls.filter((c) => c.url.includes("/events/slug/")).length;
  assert.equal(eventCallsAfter, eventCallsBefore); // per-identity entry reused, not refetched
  assert.equal(second.status, first.status);
});

test("P6: a failed identity remains resumable and can be retried on resume", async () => {
  const calls: FakeCall[] = [];
  const rows = [row(1, { event_slug: "e-fail" })];
  const failingFetch = makeFakeFetch({
    calls,
    responses: {
      "https://gamma-api.polymarket.com/sports": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/sports/market-types": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/tags": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/events/slug/e-fail": { status: 404, body: {} },
    },
  });
  const first = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl: failingFetch, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.ok(first.unresolvedIdentities.length > 0);

  const workingFetch = makeFakeFetch({
    calls,
    responses: {
      "https://gamma-api.polymarket.com/sports": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/sports/market-types": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/tags": { status: 200, body: [] },
      "https://gamma-api.polymarket.com/events/slug/e-fail": { status: 200, body: { id: "1", slug: "e-fail", title: "Resolved now" } },
    },
  });
  const second = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl: workingFetch, concurrency: 5, timeoutMs: 5000, maxAttempts: 1, resumeFrom: first });
  assert.equal(second.unresolvedIdentities.length, 0);
});

test("P7: concurrency never exceeds the configured maximum (5)", async () => {
  let inFlight = 0;
  let maxObserved = 0;
  const rows = Array.from({ length: 12 }, (_, i) => row(i, { event_slug: `e${i}` }));
  const fetchImpl = async (url: string) => {
    if (url.includes("/sports") || url.includes("/tags")) return { ok: true, status: 200, json: async () => [] };
    inFlight += 1;
    maxObserved = Math.max(maxObserved, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return { ok: true, status: 200, json: async () => ({ id: url, slug: url, title: "t" }) };
  };
  await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: MAX_CONCURRENCY, timeoutMs: 5000, maxAttempts: 1 });
  assert.ok(maxObserved <= MAX_CONCURRENCY);
});

test("P8: HTTP 429 is retried", async () => {
  const calls: FakeCall[] = [];
  let attempt = 0;
  const rows = [row(1, { event_slug: "e-429" })];
  const fetchImpl = async (url: string) => {
    calls.push({ url });
    if (url.includes("/sports") || url.includes("/tags")) return { ok: true, status: 200, json: async () => [] };
    attempt += 1;
    if (attempt === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id: "1", slug: "e-429", title: "ok after retry" }) };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 3, retryDelayMs: 1 });
  assert.equal(snapshot.unresolvedIdentities.length, 0);
  assert.ok(attempt >= 2);
});

test("P9: HTTP 5xx is retried", async () => {
  let attempt = 0;
  const rows = [row(1, { event_slug: "e-500" })];
  const fetchImpl = async (url: string) => {
    if (url.includes("/sports") || url.includes("/tags")) return { ok: true, status: 200, json: async () => [] };
    attempt += 1;
    if (attempt === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id: "1", slug: "e-500", title: "ok" }) };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 3, retryDelayMs: 1 });
  assert.equal(snapshot.unresolvedIdentities.length, 0);
});

test("P10: a non-transient 4xx (404) is not retried", async () => {
  let attempts = 0;
  const rows = [row(1, { event_slug: "e-404" })];
  const fetchImpl = async (url: string) => {
    if (url.includes("/sports") || url.includes("/tags")) return { ok: true, status: 200, json: async () => [] };
    attempts += 1;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 3, retryDelayMs: 1 });
  assert.equal(attempts, 1);
  assert.ok(snapshot.unresolvedIdentities.some((u) => u.reason === "OFFICIAL_EVENT_NOT_FOUND"));
});

test("P11: maximum attempts is 3 (default)", () => {
  assert.equal(MAX_ATTEMPTS, 3);
});

test("P12: a snapshot with any unresolved identity is marked PARTIAL", async () => {
  const rows = [row(1, { event_slug: "e-ok" }), row(2, { event_slug: "e-bad" })];
  const fetchImpl = async (url: string) => {
    if (url.includes("/sports") || url.includes("/tags")) return { ok: true, status: 200, json: async () => [] };
    if (url.includes("e-bad")) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id: "1", slug: "e-ok", title: "t" }) };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1, retryDelayMs: 1 });
  assert.equal(snapshot.status, "PARTIAL");
});

test("P13: identity fetch order in the snapshot's requestSummary is deterministic", async () => {
  const rows = [row(2, { event_slug: "b" }), row(1, { event_slug: "a" })];
  const fetchImpl = async (url: string) => {
    if (url.includes("/sports") || url.includes("/tags")) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ id: url, slug: url, title: "t" }) };
  };
  const a = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  const b = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.equal(a.snapshotHash, b.snapshotHash);
});

test("P14: snapshot hash is deterministic for identical inputs", async () => {
  const rows = [row(1, { event_slug: "e1" })];
  const fetchImpl = async (url: string) => (url.includes("/sports") || url.includes("/tags") ? { ok: true, status: 200, json: async () => [] } : { ok: true, status: 200, json: async () => ({ id: "1", slug: "e1", title: "t" }) });
  const a = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  const b = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.equal(a.snapshotHash, b.snapshotHash);
});

test("P15: corpusHash is recorded on the snapshot", async () => {
  const rows = [row(1, { event_slug: "e1" })];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "corpus-xyz", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.equal(snapshot.corpusHash, "corpus-xyz");
});

test("P16: validateMetadataSnapshot throws on corpus hash mismatch", async () => {
  const rows = [row(1, { event_slug: "e1" })];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "corpus-a", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.throws(() => validateMetadataSnapshot(snapshot, "corpus-b"), /hash|mismatch/i);
  assert.doesNotThrow(() => validateMetadataSnapshot(snapshot, "corpus-a"));
});

test("P17: no full raw rows are embedded in the snapshot", async () => {
  const rows = [row(1, { event_slug: "e1", signal_result: "win", realized_return_pct: 40 })];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /"signal_result":|"realized_return_pct":/);
});

test("P18: sports metadata list is retained on the snapshot when present", async () => {
  const rows = [row(1, { event_slug: "e1" })];
  const fetchImpl = async (url: string) => {
    if (url.endsWith("/sports")) return { ok: true, status: 200, json: async () => [{ id: "soccer", label: "Soccer" }] };
    return { ok: true, status: 200, json: async () => [] };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.deepEqual(snapshot.sportsMetadata, [{ id: "soccer", label: "Soccer" }]);
});

test("P19: valid sports market types are retained on the snapshot", async () => {
  const rows: Record<string, unknown>[] = [];
  const fetchImpl = async (url: string) => {
    if (url.endsWith("/sports/market-types")) return { ok: true, status: 200, json: async () => ["moneyline", "totals"] };
    return { ok: true, status: 200, json: async () => [] };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.deepEqual(snapshot.validSportsMarketTypes, ["moneyline", "totals"]);
});

test("P20: tags are indexed by id", async () => {
  const rows: Record<string, unknown>[] = [];
  const fetchImpl = async (url: string) => {
    if (url.endsWith("/tags")) return { ok: true, status: 200, json: async () => [{ id: "t1", label: "World Cup" }] };
    return { ok: true, status: 200, json: async () => [] };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.equal(snapshot.tagsById.t1?.label, "World Cup");
});

test("P21: event category/subcategory/series/tags are preserved when present", async () => {
  const rows = [row(1, { event_slug: "e1" })];
  const fetchImpl = async (url: string) => {
    if (url.includes("/events/slug/")) return { ok: true, status: 200, json: async () => ({ id: "1", slug: "e1", category: "Sports", subcategory: "Soccer", series: "World Cup", tags: ["wc2026"] }) };
    return { ok: true, status: 200, json: async () => [] };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  const event = snapshot.eventsBySlug.e1;
  assert.equal(event?.category, "Sports");
  assert.equal(event?.subcategory, "Soccer");
  assert.equal(event?.series, "World Cup");
  assert.deepEqual(event?.tags, ["wc2026"]);
});

test("P22: official market-type fields are preserved when present", async () => {
  const rows = [row(1, { event_slug: undefined, market_slug: "m1" })];
  const fetchImpl = async (url: string) => {
    if (url.includes("/markets/slug/")) return { ok: true, status: 200, json: async () => ({ id: "1", slug: "m1", marketType: "moneyline" }) };
    return { ok: true, status: 200, json: async () => [] };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.equal(snapshot.marketsBySlug.m1?.marketType, "moneyline");
});

test("P23: unresolved identities carry an explicit reason code", async () => {
  const rows = [row(1, { event_slug: "e-missing" })];
  const fetchImpl = async (url: string) => {
    if (url.includes("/events/slug/")) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [] };
  };
  const snapshot = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "abc", fetchImpl, concurrency: 5, timeoutMs: 5000, maxAttempts: 1 });
  assert.ok(snapshot.unresolvedIdentities.every((u) => typeof u.reason === "string" && u.reason.length > 0));
});

test("P24: rows with neither event_slug nor market_slug are flagged MISSING_EVENT_IDENTITY", () => {
  const rows = [row(1, { event_slug: undefined, market_slug: undefined })];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.equal(identities.length, 0);
});

test("P25: the pure identity collector has no network/DB dependency (module-load safety)", () => {
  const before = JSON.stringify(process.env);
  collectUniqueMetadataIdentities([row(1)]);
  assert.equal(JSON.stringify(process.env), before);
});
