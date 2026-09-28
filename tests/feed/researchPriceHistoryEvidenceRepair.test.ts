import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchResearchPriceHistorySafe } from "../../lib/feed/polymarketClient";
import { selectNearestAtOrBefore } from "../../lib/feed/buildLandingCards";
import type { PolymarketPricePoint } from "../../lib/feed/types";

// FORWARD_PRICE_MOMENTUM_EVIDENCE_REPAIR_V1 regression:
//
// The canonical CLOB `/prices-history` response is `{ history: [{ t, p }] }`,
// not a bare array of `{ timestamp, price }`. fetchPriceHistorySafe() mistyped
// the response, so priceHistory was always empty/malformed in production and
// enrichMarket() silently fell through to the Gamma 24h-change fallback (or
// nothing at all), leaving price1hAgo/price6hAgo/delta1hPp/delta6hPp null for
// S2_WIDE_SCORER rows. fetchResearchPriceHistorySafe() parses the real shape;
// selectNearestAtOrBefore() replaces the live path's ascending-unsafe .find()
// walk for research only.
//
// Run with: node --import tsx --test tests/feed/researchPriceHistoryEvidenceRepair.test.ts

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("1-3: canonical { history: [{ t, p }] } normalizes to valid internal points, t as unix seconds, p as numeric price", async () => {
  stubFetch({
    history: [
      { t: 1000, p: 0.42 },
      { t: 2000, p: 0.46 },
    ],
  });

  const result = await fetchResearchPriceHistorySafe("token-1");

  assert.ok(result);
  assert.equal(result!.length, 2);
  assert.equal(result![0].timestamp, new Date(1000 * 1000).toISOString());
  assert.equal(result![0].price, 0.42);
  assert.equal(result![1].timestamp, new Date(2000 * 1000).toISOString());
  assert.equal(result![1].price, 0.46);
});

test("4: malformed points are dropped, never zero-filled", async () => {
  stubFetch({
    history: [
      { t: 1000, p: 0.42 },
      { t: "not-a-number", p: 0.5 },
      { t: 3000, p: "not-a-number" },
      { t: null, p: null },
      {},
      { t: 4000, p: 0.51 },
    ],
  });

  const result = await fetchResearchPriceHistorySafe("token-1");

  assert.ok(result);
  assert.equal(result!.length, 2);
  assert.deepEqual(
    result!.map((p) => p.price),
    [0.42, 0.51],
  );
});

test("request uses interval=1d and fidelity=60 for research (sufficient lookback to resolve a true 6h reference)", async () => {
  let requestedUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ history: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await fetchResearchPriceHistorySafe("token-1");

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("interval"), "1d");
  assert.equal(url.searchParams.get("fidelity"), "60");
  assert.equal(url.searchParams.get("market"), "token-1");
});

test("empty/absent history returns null, not an empty-array or fabricated value", async () => {
  stubFetch({ history: [] });
  assert.equal(await fetchResearchPriceHistorySafe("token-1"), null);

  stubFetch({});
  assert.equal(await fetchResearchPriceHistorySafe("token-1"), null);
});

test("defensive compatibility: also accepts the previous bare-array internal shape", async () => {
  stubFetch([
    { timestamp: "2026-01-01T00:00:00.000Z", price: 0.3 },
    { timestamp: "2026-01-01T01:00:00.000Z", price: 0.35 },
  ]);

  const result = await fetchResearchPriceHistorySafe("token-1");
  assert.ok(result);
  assert.equal(result!.length, 2);
  assert.equal(result![0].price, 0.3);
});

// ── 5-8: nearest-at-or-before selection ────────────────────────────────────

function pts(...entries: Array<[string, number]>): PolymarketPricePoint[] {
  return entries.map(([timestamp, price]) => ({ timestamp, price }));
}

test("5: nearest-at-or-before selection is correct for a 1h target", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const series = pts(
    ["2026-01-01T09:00:00.000Z", 0.40],
    ["2026-01-01T10:30:00.000Z", 0.42], // nearest <= 11:00 (now - 1h)
    ["2026-01-01T11:30:00.000Z", 0.45], // after the 1h cutoff, excluded
  );
  const oneHourAgo = now - 3_600_000;
  const result = selectNearestAtOrBefore(series, oneHourAgo);
  assert.equal(result?.price, 0.42);
});

test("6: nearest-at-or-before selection is correct for a 6h target", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const series = pts(
    ["2026-01-01T05:00:00.000Z", 0.30],
    ["2026-01-01T05:55:00.000Z", 0.33], // nearest <= 06:00 (now - 6h)
    ["2026-01-01T06:05:00.000Z", 0.36], // after the 6h cutoff, excluded
  );
  const sixHoursAgo = now - 21_600_000;
  const result = selectNearestAtOrBefore(series, sixHoursAgo);
  assert.equal(result?.price, 0.33);
});

test("7: no future point is ever selected, even if it is numerically closer", () => {
  const target = Date.parse("2026-01-01T06:00:00.000Z");
  const series = pts(
    ["2026-01-01T05:00:00.000Z", 0.20],
    ["2026-01-01T06:00:01.000Z", 0.99], // 1 second in the future — must not win
  );
  const result = selectNearestAtOrBefore(series, target);
  assert.equal(result?.price, 0.20);
});

test("8: insufficient history (no point at or before the target) returns null", () => {
  const target = Date.parse("2026-01-01T00:00:00.000Z");
  const series = pts(["2026-01-01T01:00:00.000Z", 0.5]); // only a future point exists
  const result = selectNearestAtOrBefore(series, target);
  assert.equal(result, null);
});

// ── 9-10: wiring — research-wide scorer uses the corrected path; live path is untouched ──

const BUILD_LANDING_CARDS_SRC = readFileSync(
  join(__dirname, "../../lib/feed/buildLandingCards.ts"),
  "utf8",
);

test("9: scoreOneResearchMarket() calls enrichMarket() with { researchPriceHistory: true }", () => {
  assert.ok(
    /enrichMarket\(\s*adapted\.candidate\.event,\s*adapted\.candidate\.market,\s*adapted\.candidate\.warnings,\s*adapted\.forcedOutcome,\s*\{ researchPriceHistory: true \},?\s*\)/.test(
      BUILD_LANDING_CARDS_SRC,
    ),
    "expected the wide research scorer's enrichMarket() call to pass { researchPriceHistory: true }",
  );
});

test("10: the live/public enrichMarket() call sites pass no researchPriceHistory option (default/live path unchanged)", () => {
  assert.ok(
    BUILD_LANDING_CARDS_SRC.includes(
      "const enriched = await enrichMarket(candidate.event, candidate.market, candidate.warnings);",
    ),
    "expected the upcoming-candidates live enrichMarket() call to remain unchanged (4 args, no research option)",
  );
  assert.ok(
    /deps\.enrichMarket\(candidate\.event, candidate\.market, candidate\.warnings, candidate\.forcedOutcome\)/.test(
      BUILD_LANDING_CARDS_SRC,
    ),
    "expected the primary-loop deps.enrichMarket() call to remain unchanged (4 args, no research option)",
  );
});

test("enrichMarket() signature declares researchPriceHistory as an explicit option, not inferred from warning strings", () => {
  assert.ok(
    /options\?: \{ researchPriceHistory\?: boolean \}/.test(BUILD_LANDING_CARDS_SRC),
    "expected an explicit typed research option on enrichMarket()",
  );
  assert.ok(
    /const useResearchPriceHistory = options\?\.researchPriceHistory === true;/.test(BUILD_LANDING_CARDS_SRC),
    "expected the research switch to read the explicit option, not warnings",
  );
});
