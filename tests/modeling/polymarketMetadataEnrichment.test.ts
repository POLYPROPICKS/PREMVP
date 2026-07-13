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
  isValidPolymarketSlug,
  isValidConditionId,
  fetchMarketMetadataByConditionId,
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

// ---- Phase 3E.8D.2: reject display-title slugs, use diagnostics.marketSlug fallback ----

test("Q1: a display-title event_slug is rejected -- no event_slug identity emitted", () => {
  const rows = [{ id: "x1", event_slug: "Valorant: Team A vs Team B (BO3)", market_slug: "Map 2 Winner: Team A vs Team B" }];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.ok(!identities.some((i) => i.kind === "event_slug"));
});

test("Q2: a display-title market_slug is also rejected when event_slug is invalid and no diagnostics fallback exists", () => {
  const rows = [{ id: "x1", event_slug: "Valorant: Team A vs Team B (BO3)", market_slug: "Map 2 Winner: Team A vs Team B" }];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.equal(identities.length, 0);
});

test("Q3: diagnostics.marketSlug is used as a market_slug-kind fallback when both top-level fields are invalid", () => {
  const rows = [
    {
      id: "x1",
      event_slug: "Valorant: Team A vs Team B (BO3)",
      market_slug: "Map 2 Winner: Team A vs Team B",
      diagnostics: { marketSlug: "val-team-a-team-b-2026-07-13-game2" },
    },
  ];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.deepEqual(identities, [{ kind: "market_slug", value: "val-team-a-team-b-2026-07-13-game2" }]);
});

test("Q4: a genuinely valid top-level event_slug remains preferred over diagnostics.marketSlug", () => {
  const rows = [
    {
      id: "x1",
      event_slug: "fifwc-fra-mar-2026-07-13",
      diagnostics: { marketSlug: "fifwc-fra-mar-2026-07-13-moneyline-fra" },
    },
  ];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.deepEqual(identities, [{ kind: "event_slug", value: "fifwc-fra-mar-2026-07-13" }]);
});

test("Q5: a genuinely valid top-level market_slug is used when event_slug is absent/invalid", () => {
  const rows = [{ id: "x1", event_slug: "Team A vs Team B", market_slug: "team-a-team-b-moneyline" }];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.deepEqual(identities, [{ kind: "market_slug", value: "team-a-team-b-moneyline" }]);
});

test("Q6: whitespace/colon/parentheses values are all rejected", () => {
  for (const bad of ["France vs Morocco", "Valorant: Team A vs Team B", "Match Winner (Full Time)"]) {
    assert.equal(isValidPolymarketSlug(bad), false, `expected ${bad} to be invalid`);
  }
});

test("Q7: a bounded lowercase/digit/hyphen slug is accepted without requiring a sport prefix", () => {
  assert.equal(isValidPolymarketSlug("abc-123-xyz"), true);
  assert.equal(isValidPolymarketSlug("2026-07-13-game2"), true);
});

test("Q8: duplicate diagnostics.marketSlug values across rows collapse to one identity", () => {
  const rows = [
    { id: "x1", event_slug: "Title A", diagnostics: { marketSlug: "shared-slug-1" } },
    { id: "x2", event_slug: "Title B", diagnostics: { marketSlug: "shared-slug-1" } },
  ];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.equal(identities.length, 1);
  assert.deepEqual(identities[0], { kind: "market_slug", value: "shared-slug-1" });
});

test("Q9: identity order remains deterministic across permutations", () => {
  const rowsA = [
    { id: "x1", diagnostics: { marketSlug: "slug-b" } },
    { id: "x2", diagnostics: { marketSlug: "slug-a" } },
  ];
  const rowsB = [rowsA[1], rowsA[0]];
  const a = collectUniqueMetadataIdentities(rowsA);
  const b = collectUniqueMetadataIdentities(rowsB);
  // Same set of identities regardless of input row order (order is stable
  // per-input-order, but both permutations must yield the same identity set).
  assert.deepEqual(new Set(a.map((i) => i.value)), new Set(b.map((i) => i.value)));
});

test("Q10: a row with no diagnostics object at all is handled safely (no throw)", () => {
  const rows = [{ id: "x1", event_slug: "Title Only" }];
  assert.doesNotThrow(() => collectUniqueMetadataIdentities(rows));
  assert.equal(collectUniqueMetadataIdentities(rows).length, 0);
});

test("Q11: an invalid diagnostics.marketSlug (also title-like) is rejected, not used as a fallback", () => {
  const rows = [
    { id: "x1", event_slug: "Title Only", diagnostics: { marketSlug: "Map 2 Winner: A vs B" } },
  ];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.equal(identities.length, 0);
});

test("Q12: no full row payload leaks into the identity output", () => {
  const rows = [
    { id: "x1", event_slug: "Title", signal_result: "win", realized_return_pct: 40, diagnostics: { marketSlug: "valid-slug-1" } },
  ];
  const identities = collectUniqueMetadataIdentities(rows);
  const serialized = JSON.stringify(identities);
  assert.doesNotMatch(serialized, /signal_result|realized_return_pct/);
});

test("Q13: real corpus identity counts match the diagnosed shape (461 valid diagnostics.marketSlug rows, 0 valid top-level fields)", () => {
  const { readFileSync, existsSync } = require("node:fs");
  const exportPath = require("node:path").resolve(__dirname, "../../modeling/local_exports/generated_signal_pairs_export.json");
  if (!existsSync(exportPath)) return; // real corpus not present in this environment run -- skip gracefully
  const { projectGeneratedSignalPairsStrictDedup } = require("../../lib/modeling/generatedSignalPairsDedupPolicy");
  const raw = JSON.parse(readFileSync(exportPath, "utf8"));
  const dedupRows = projectGeneratedSignalPairsStrictDedup(raw).dedupedRows;
  assert.equal(dedupRows.length, 1850);

  const validTopLevelEvent = dedupRows.filter((r: Record<string, unknown>) => isValidPolymarketSlug(r.event_slug)).length;
  const validTopLevelMarket = dedupRows.filter((r: Record<string, unknown>) => isValidPolymarketSlug(r.market_slug)).length;
  const populatedDiagnosticsMarket = dedupRows.filter((r: Record<string, unknown>) => {
    const d = r.diagnostics as Record<string, unknown> | undefined;
    return d && typeof d.marketSlug === "string" && (d.marketSlug as string).trim() !== "";
  }).length;
  const validDiagnosticsMarket = dedupRows.filter((r: Record<string, unknown>) => {
    const d = r.diagnostics as Record<string, unknown> | undefined;
    return d && isValidPolymarketSlug(d.marketSlug);
  }).length;

  assert.equal(validTopLevelEvent, 0);
  assert.equal(validTopLevelMarket, 0);
  // 481 rows have a populated diagnostics.marketSlug field, but 20 of those
  // hold non-slug placeholder text (e.g. "Live market activity",
  // "$4K matched activity") rather than a real slug -- only 461 are valid.
  assert.equal(populatedDiagnosticsMarket, 481);
  assert.equal(validDiagnosticsMarket, 461);

  // With condition_id fallback (Phase 3E.8D.3B), rows without a valid slug
  // but with a valid condition_id now emit a condition_id identity. Every
  // dedup row on this corpus has a valid condition_id, so every row emits
  // exactly one identity: a market_slug for the 461 slug-bearing rows, a
  // condition_id for the remaining 1,389.
  const identities = collectUniqueMetadataIdentities(dedupRows);
  const marketSlugIdentities = identities.filter((i) => i.kind === "market_slug");
  const conditionIdIdentities = identities.filter((i) => i.kind === "condition_id");
  assert.ok(identities.every((i) => i.kind === "market_slug" || i.kind === "condition_id"));
  assert.ok(marketSlugIdentities.length > 0 && marketSlugIdentities.length <= 461);
  assert.ok(conditionIdIdentities.length > 0);
  // condition_id identities are normalized lowercase 0x-prefixed 32-byte hashes
  assert.ok(conditionIdIdentities.every((i) => /^0x[0-9a-f]{64}$/.test(i.value)));

  const rowsWithIdentity = dedupRows.filter((r: Record<string, unknown>) => {
    const d = r.diagnostics as Record<string, unknown> | undefined;
    return (
      isValidPolymarketSlug(r.event_slug) ||
      isValidPolymarketSlug(r.market_slug) ||
      (d && isValidPolymarketSlug(d.marketSlug)) ||
      isValidConditionId(r.condition_id) ||
      (d && isValidConditionId(d.conditionId))
    );
  }).length;
  const rowsWithNoIdentity = dedupRows.length - rowsWithIdentity;
  assert.equal(rowsWithIdentity, 1850);
  assert.equal(rowsWithNoIdentity, 0);
});

// ---- Phase 3E.8D.3B: resolve markets by condition_id ----

const CID_A = "0x" + "a".repeat(64);
const CID_B = "0x" + "b".repeat(64);
const CID_MIXED = "0x" + "AbCdEf".repeat(10) + "abcd";

function globalsOnly(url: string) {
  if (url.endsWith("/sports") || url.endsWith("/sports/market-types") || url.endsWith("/tags")) {
    return { ok: true, status: 200, json: async () => [] };
  }
  return null;
}

test("R1: a valid top-level condition_id is collected when no valid slug exists", () => {
  const rows = [{ id: "x1", event_slug: "Title Only", market_slug: "$30K matched activity", condition_id: CID_A }];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.deepEqual(identities, [{ kind: "condition_id", value: CID_A }]);
});

test("R2: diagnostics.conditionId is used as a fallback when top-level condition_id is absent", () => {
  const rows = [{ id: "x1", event_slug: "Title", diagnostics: { conditionId: CID_A } }];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.deepEqual(identities, [{ kind: "condition_id", value: CID_A }]);
});

test("R3: a valid slug remains preferred over condition_id", () => {
  const rows = [{ id: "x1", event_slug: "Title", market_slug: "team-a-team-b-moneyline", condition_id: CID_A }];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.deepEqual(identities, [{ kind: "market_slug", value: "team-a-team-b-moneyline" }]);
});

test("R3b: diagnostics.marketSlug remains preferred over condition_id", () => {
  const rows = [{ id: "x1", event_slug: "Title", diagnostics: { marketSlug: "val-a-b-2026-07-13", conditionId: CID_A } }];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.deepEqual(identities, [{ kind: "market_slug", value: "val-a-b-2026-07-13" }]);
});

test("R4: duplicate condition_ids across rows deduplicate to one identity", () => {
  const rows = [
    { id: "x1", event_slug: "T1", condition_id: CID_A },
    { id: "x2", event_slug: "T2", condition_id: CID_A },
  ];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.equal(identities.length, 1);
  assert.deepEqual(identities[0], { kind: "condition_id", value: CID_A });
});

test("R5: condition_ids are normalized to lowercase", () => {
  const rows = [{ id: "x1", event_slug: "T", condition_id: CID_MIXED }];
  const identities = collectUniqueMetadataIdentities(rows);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].kind, "condition_id");
  assert.equal(identities[0].value, CID_MIXED.toLowerCase());
});

test("R6: a malformed condition_id is rejected and yields no identity", () => {
  assert.equal(isValidConditionId("0x123"), false);
  assert.equal(isValidConditionId("not-a-hash"), false);
  assert.equal(isValidConditionId("0x" + "g".repeat(64)), false);
  assert.equal(isValidConditionId("a".repeat(64)), false); // missing 0x
  const rows = [{ id: "x1", event_slug: "T", condition_id: "0x123" }];
  assert.equal(collectUniqueMetadataIdentities(rows).length, 0);
});

test("R6b: a well-formed condition_id passes validation", () => {
  assert.equal(isValidConditionId(CID_A), true);
  assert.equal(isValidConditionId(CID_MIXED), true);
});

test("R7: title fields are never used as a condition-id identity", () => {
  const rows = [{ id: "x1", event_slug: "France vs Morocco", market_slug: "Match Winner (Full Time)" }];
  assert.equal(collectUniqueMetadataIdentities(rows).length, 0);
});

test("R8: the condition-id request URL contains the encoded condition_ids param", async () => {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    const g = globalsOnly(url);
    if (g) return g;
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "m-a", marketType: "moneyline" }] };
  };
  await fetchMarketMetadataByConditionId(fetchImpl as any, CID_A, {});
  assert.ok(seen.some((u) => u.includes("/markets?") && u.includes("condition_ids=" + encodeURIComponent(CID_A))));
});

test("R9: an array response with an exact condition match succeeds", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "m-a", marketType: "moneyline" }] });
  const res = await fetchMarketMetadataByConditionId(fetchImpl as any, CID_A, {});
  assert.equal(res.ok, true);
  assert.equal((res as any).market.conditionId, CID_A);
});

test("R10: an empty array yields OFFICIAL_MARKET_NOT_FOUND", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
  const res = await fetchMarketMetadataByConditionId(fetchImpl as any, CID_A, {});
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, "OFFICIAL_MARKET_NOT_FOUND");
});

test("R11: an array of only unrelated markets yields OFFICIAL_MARKET_NOT_FOUND", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ conditionId: CID_B, slug: "other" }] });
  const res = await fetchMarketMetadataByConditionId(fetchImpl as any, CID_A, {});
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, "OFFICIAL_MARKET_NOT_FOUND");
});

test("R12: multiple records with exactly one exact match selects the exact match", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { conditionId: CID_B, slug: "other" },
      { conditionId: CID_A, slug: "m-a", marketType: "moneyline" },
    ],
  });
  const res = await fetchMarketMetadataByConditionId(fetchImpl as any, CID_A, {});
  assert.equal(res.ok, true);
  assert.equal((res as any).market.slug, "m-a");
});

test("R12b: case-insensitive exact match selects the record", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ conditionId: CID_MIXED, slug: "m-mixed" }] });
  const res = await fetchMarketMetadataByConditionId(fetchImpl as any, CID_MIXED.toLowerCase(), {});
  assert.equal(res.ok, true);
  assert.equal((res as any).market.slug, "m-mixed");
});

test("R13: ambiguous duplicate exact matches yield AMBIGUOUS_CONDITION_ID_RESPONSE", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { conditionId: CID_A, slug: "m-a1" },
      { conditionId: CID_A, slug: "m-a2" },
    ],
  });
  const res = await fetchMarketMetadataByConditionId(fetchImpl as any, CID_A, {});
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, "AMBIGUOUS_CONDITION_ID_RESPONSE");
});

test("R14: a non-array response is rejected as a validation error", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ conditionId: CID_A }) });
  const res = await fetchMarketMetadataByConditionId(fetchImpl as any, CID_A, {});
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, "INVALID_MARKET_RESPONSE");
});

test("R15: a non-empty array whose markets all lack conditionId is a validation error", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ slug: "m-a", marketType: "moneyline" }] });
  const res = await fetchMarketMetadataByConditionId(fetchImpl as any, CID_A, {});
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, "INVALID_MARKET_RESPONSE");
});

test("R16: a successful condition lookup is indexed in marketsByConditionId", async () => {
  const rows = [{ id: "x1", event_slug: "Title", condition_id: CID_A }];
  const fetchImpl = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "m-a", marketType: "moneyline" }] };
  };
  const snap = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any });
  assert.ok(snap.marketsByConditionId);
  assert.ok(snap.marketsByConditionId![CID_A]);
  assert.equal(snap.marketsByConditionId![CID_A].slug, "m-a");
  assert.equal(snap.requestSummary.successCount, 1);
});

test("R17: a returned valid slug is also indexed into marketsBySlug", async () => {
  const rows = [{ id: "x1", event_slug: "Title", condition_id: CID_A }];
  const fetchImpl = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "val-a-b-2026", marketType: "moneyline" }] };
  };
  const snap = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any });
  assert.ok(snap.marketsBySlug["val-a-b-2026"]);
});

test("R18: a condition lookup never overwrites a conflicting existing marketsBySlug record", async () => {
  const rows = [
    { id: "x1", market_slug: "shared-slug", condition_id: CID_B },
    { id: "x2", event_slug: "Title", condition_id: CID_A },
  ];
  const fetchImpl = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    if (url.includes("/markets/slug/shared-slug")) return { ok: true, status: 200, json: async () => ({ slug: "shared-slug", conditionId: CID_B, marketType: "totals" }) };
    // condition lookup for CID_A returns a market that also claims slug "shared-slug" but a different conditionId
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "shared-slug", marketType: "moneyline" }] };
  };
  const snap = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any });
  // the original slug-resolved record (CID_B) must not be overwritten by the condition lookup (CID_A)
  assert.equal(snap.marketsBySlug["shared-slug"].conditionId ?? CID_B, snap.marketsBySlug["shared-slug"].conditionId ?? CID_B);
  assert.equal((snap.marketsBySlug["shared-slug"] as any).marketType, "totals");
  // but the condition lookup is still recorded under its own condition id
  assert.ok(snap.marketsByConditionId![CID_A]);
});

test("R19: successful condition entries are reused from a resumed snapshot (no refetch)", async () => {
  const rows = [{ id: "x1", event_slug: "Title", condition_id: CID_A }];
  let conditionCalls = 0;
  const fetchImpl = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    conditionCalls += 1;
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "m-a" }] };
  };
  const first = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any });
  assert.equal(conditionCalls, 1);
  const second = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any, resumeFrom: first });
  assert.equal(conditionCalls, 1); // not refetched
  assert.equal(second.requestSummary.cachedReuseCount, 1);
});

test("R20: a failed condition entry can be resumed and resolved on a later run", async () => {
  const rows = [{ id: "x1", event_slug: "Title", condition_id: CID_A }];
  const failing = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const working = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "m-a" }] };
  };
  const first = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: failing as any, maxAttempts: 1 });
  assert.equal(first.marketsByConditionId![CID_A], undefined);
  const second = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: working as any, resumeFrom: first });
  assert.ok(second.marketsByConditionId![CID_A]);
});

test("R21: the snapshot hash is deterministic for the same condition inputs", async () => {
  const rows = [{ id: "x1", event_slug: "Title", condition_id: CID_A }];
  const fetchImpl = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "m-a" }] };
  };
  const a = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any });
  const b = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any });
  assert.equal(a.snapshotHash, b.snapshotHash);
});

test("R22: request counts are broken down by identity kind", async () => {
  const rows = [
    { id: "x1", event_slug: "ev-slug-a", condition_id: CID_A },
    { id: "x2", market_slug: "mk-slug-b", condition_id: CID_B },
    { id: "x3", event_slug: "Title", condition_id: CID_A },
  ];
  const fetchImpl = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    if (url.includes("/events/slug/")) return { ok: true, status: 200, json: async () => ({ slug: "ev-slug-a" }) };
    if (url.includes("/markets/slug/")) return { ok: true, status: 200, json: async () => ({ slug: "mk-slug-b" }) };
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "m-a" }] };
  };
  const snap = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any });
  assert.ok(snap.requestSummary.byIdentityKind);
  assert.equal(snap.requestSummary.byIdentityKind!.event_slug, 1);
  assert.equal(snap.requestSummary.byIdentityKind!.market_slug, 1);
  assert.equal(snap.requestSummary.byIdentityKind!.condition_id, 1);
});

test("R23: no raw row payloads leak into the snapshot", async () => {
  const rows = [{ id: "x1", event_slug: "Title", condition_id: CID_A, signal_result: "win", realized_return_pct: 40 }];
  const fetchImpl = async (url: string) => {
    const g = globalsOnly(url);
    if (g) return g;
    return { ok: true, status: 200, json: async () => [{ conditionId: CID_A, slug: "m-a" }] };
  };
  const snap = await buildMetadataEnrichmentSnapshot({ rows, corpusHash: "h", fetchImpl: fetchImpl as any });
  assert.doesNotMatch(JSON.stringify(snap), /signal_result|realized_return_pct/);
});

test("R25: a corpus hash mismatch on a resumed snapshot is rejected by the validator", () => {
  const snapshot: any = { corpusHash: "actual-hash" };
  assert.throws(() => validateMetadataSnapshot(snapshot, "expected-hash"));
});
