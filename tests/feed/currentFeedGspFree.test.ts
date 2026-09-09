// B5: LANDING FEED IS GSP-FREE
//   node --experimental-test-module-mocks --import tsx --test tests/feed/currentFeedGspFree.test.ts
//
// Business result under test: the production landing-feed cache-hit path
// (readCurrentServingSignalPairs, consumed by GET /api/feed/landing-cards)
// resolves current, non-expired scorer evidence entirely from
// current_signal_pair_serving (bounded current identity) + primary_evidence_outbox
// (exact durable payload), looked up ONLY by the exact observed_at values the
// bounded Serving rows reference -- never generated_signal_pairs, never a
// historical/unordered scan of the outbox.

import { mock, test } from "node:test";
import assert from "node:assert/strict";

let gspReadCount = 0;

type Row = Record<string, unknown>;

function response(data: unknown) {
  return { data, error: null };
}

function makeServingQuery(rows: Row[]) {
  // Filtering is trusted to Postgres in production; this mock returns the
  // exact rows a correctly-filtered query would have, so the test proves the
  // JS-side join/mapping logic, not Postgres's WHERE clause.
  const query: Record<string, unknown> = {
    select() { return query; },
    eq() { return query; },
    not() { return query; },
    is() { return query; },
    gt() { return query; },
    or() { return query; },
    order() { return query; },
    limit(n: number) {
      return Promise.resolve(response(rows.slice(0, n)));
    },
  };
  return query;
}

function makeOutboxQuery(rows: Row[]) {
  const query: Record<string, unknown> = {
    select() { return query; },
    in(_column: string, values: string[]) {
      return Promise.resolve(
        response(rows.filter((row) => values.includes(String(row.observed_at))))
      );
    },
  };
  return query;
}

let currentServingRows: Row[] = [];
let currentOutboxRows: Row[] = [];
let servingError: { message: string } | null = null;
let outboxError: { message: string } | null = null;

mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(table: string) {
        if (table === "current_signal_pair_serving") {
          if (servingError) {
            return { select() { return this; }, eq() { return this; }, not() { return this; }, is() { return this; }, gt() { return this; }, or() { return this; }, order() { return this; }, limit() { return Promise.resolve({ data: null, error: servingError }); } };
          }
          return makeServingQuery(currentServingRows);
        }
        if (table === "primary_evidence_outbox") {
          if (outboxError) {
            return { select() { return this; }, in() { return Promise.resolve({ data: null, error: outboxError }); } };
          }
          return makeOutboxQuery(currentOutboxRows);
        }
        if (table === "generated_signal_pairs") {
          // B5: this table must NEVER be read by the current landing-feed path.
          gspReadCount += 1;
          return { select() { return this; }, eq() { return this; }, gt() { return this; }, or() { return this; }, order() { return this; }, limit() { return Promise.resolve(response([])); } };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
  },
});

function premiumSignal(overrides: Record<string, unknown> = {}) {
  return {
    id: "sig-1",
    league: "MLB",
    time: "7:05 PM ET",
    eventTitle: "Yankees vs Phillies",
    confidenceLabel: "Strong",
    position: "Yankees",
    profit: "+12%",
    winProbability: 78,
    price: "0.42",
    ctaLabel: "View",
    metrics: [],
    ...overrides,
  };
}

function marketSource(overrides: Record<string, unknown> = {}) {
  return {
    id: "market-1",
    sourceLabel: "Polymarket",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo: "5m ago",
    headline: "Yankees vs Phillies - Moneyline",
    subline: "42¢",
    delta: "+3%",
    ...overrides,
  };
}

function diagnostics(overrides: Record<string, unknown> = {}) {
  return {
    conditionId: "cond-1",
    selectedTokenId: "tok-1",
    selectedOutcome: "Yankees",
    currentPrice: 0.42,
    price1hAgo: null,
    price6hAgo: null,
    delta1hPp: null,
    delta6hPp: null,
    spread: null,
    openInterest: null,
    recentTradeCash: null,
    maxTradeCash: null,
    selectedTradeCount: null,
    totalTradeCount: null,
    holderConcentrationScore: null,
    dataCoverage: 60,
    formulaUsed: "v2-lite-growth-safe",
    ...overrides,
  };
}

function evidenceEntry(observationId: string, overrides: Record<string, unknown> = {}) {
  return {
    observation_id: observationId,
    premium_signal: premiumSignal(),
    market_source: marketSource(),
    diagnostics: diagnostics(),
    score: null,
    ...overrides,
  };
}

function reset() {
  gspReadCount = 0;
  currentServingRows = [];
  currentOutboxRows = [];
  servingError = null;
  outboxError = null;
}

// ── A, B: valid current evidence, zero GSP reads, correct contract ──

test("CF5-1: valid current serving + outbox evidence produces a CachedSignalPair with zero generated_signal_pairs reads", async () => {
  reset();
  const observedAt = "2026-09-10T12:00:00.000Z";
  currentServingRows = [
    { observation_id: "obs-1", observed_at: observedAt, expires_at: "2026-09-10T18:00:00.000Z" },
  ];
  currentOutboxRows = [
    { observed_at: observedAt, evidence_rows: [evidenceEntry("obs-1")] },
  ];

  const { readCurrentServingSignalPairs } = await import("../../lib/feed/cacheGeneratedSignals");
  const pairs = await readCurrentServingSignalPairs(4);

  assert.equal(gspReadCount, 0, "must never read generated_signal_pairs");
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].id, "obs-1");
  assert.deepEqual(pairs[0].premiumSignal, premiumSignal());
  assert.deepEqual(pairs[0].marketSource, marketSource());
  assert.deepEqual(pairs[0].diagnostics, diagnostics());
  assert.equal(pairs[0].createdAt, observedAt);
  assert.equal(pairs[0].expiresAt, "2026-09-10T18:00:00.000Z");
});

// ── C: expired evidence excluded (bounded by the Serving query itself) ──

test("CF5-2: a Serving row the query itself would exclude as expired never surfaces (query boundary, not client-side filtering)", async () => {
  reset();
  // The production query applies .gt("expires_at", now) server-side; this
  // test proves readCurrentServingSignalPairs does not independently
  // re-admit rows the query excluded -- an empty Serving result (as if the
  // expired row were already filtered by Postgres) yields an empty output,
  // never a GSP fallback.
  currentServingRows = [];
  currentOutboxRows = [];

  const { readCurrentServingSignalPairs } = await import("../../lib/feed/cacheGeneratedSignals");
  const pairs = await readCurrentServingSignalPairs(4);

  assert.deepEqual(pairs, []);
  assert.equal(gspReadCount, 0);
});

// ── D: evidence outside the bounded current authority (no matching outbox entry) is not surfaced ──

test("CF5-3: a Serving row with no matching primary_evidence_outbox entry is excluded, not surfaced with partial/fabricated data", async () => {
  reset();
  const observedAt = "2026-09-10T12:00:00.000Z";
  currentServingRows = [
    { observation_id: "obs-missing", observed_at: observedAt, expires_at: "2026-09-10T18:00:00.000Z" },
  ];
  // Outbox row exists for this observed_at cycle, but its evidence_rows does
  // NOT contain an entry for obs-missing (e.g. a row that failed the RPC's
  // own identity guard and was never captured).
  currentOutboxRows = [
    { observed_at: observedAt, evidence_rows: [evidenceEntry("some-other-observation-id")] },
  ];

  const { readCurrentServingSignalPairs } = await import("../../lib/feed/cacheGeneratedSignals");
  const pairs = await readCurrentServingSignalPairs(4);

  assert.deepEqual(pairs, []);
  assert.equal(gspReadCount, 0, "unresolvable evidence must never trigger a GSP lookup");
});

// ── E: limit/order semantics remain deterministic ──

test("CF5-4: results preserve the Serving query's own bounded order and respect the limit", async () => {
  reset();
  const observedAt = "2026-09-10T12:00:00.000Z";
  currentServingRows = [
    { observation_id: "obs-a", observed_at: observedAt, expires_at: "2026-09-10T18:00:00.000Z" },
    { observation_id: "obs-b", observed_at: observedAt, expires_at: "2026-09-10T18:00:00.000Z" },
    { observation_id: "obs-c", observed_at: observedAt, expires_at: "2026-09-10T18:00:00.000Z" },
  ];
  currentOutboxRows = [
    {
      observed_at: observedAt,
      evidence_rows: [
        evidenceEntry("obs-a", { premium_signal: premiumSignal({ id: "sig-a" }) }),
        evidenceEntry("obs-b", { premium_signal: premiumSignal({ id: "sig-b" }) }),
        evidenceEntry("obs-c", { premium_signal: premiumSignal({ id: "sig-c" }) }),
      ],
    },
  ];

  const { readCurrentServingSignalPairs } = await import("../../lib/feed/cacheGeneratedSignals");
  const pairs = await readCurrentServingSignalPairs(2);

  assert.equal(pairs.length, 2, "must respect the requested limit");
  assert.deepEqual(pairs.map((p) => p.id), ["obs-a", "obs-b"], "must preserve the Serving query's own bounded order");
});

// ── F: missing/malformed current evidence uses safe fallback, never GSP ──

test("CF5-5: a query error on Serving throws (route's existing safe-fallback catch handles it), never falls back to GSP", async () => {
  reset();
  servingError = { message: "simulated Serving read failure" };

  const { readCurrentServingSignalPairs } = await import("../../lib/feed/cacheGeneratedSignals");
  await assert.rejects(() => readCurrentServingSignalPairs(4));
  assert.equal(gspReadCount, 0, "a Serving failure must never trigger a GSP read");
});

test("CF5-6: malformed evidence (missing premium_signal) is excluded rather than surfaced or crashing", async () => {
  reset();
  const observedAt = "2026-09-10T12:00:00.000Z";
  currentServingRows = [
    { observation_id: "obs-bad", observed_at: observedAt, expires_at: "2026-09-10T18:00:00.000Z" },
  ];
  currentOutboxRows = [
    { observed_at: observedAt, evidence_rows: [{ observation_id: "obs-bad", market_source: marketSource(), diagnostics: diagnostics() }] },
  ];

  const { readCurrentServingSignalPairs } = await import("../../lib/feed/cacheGeneratedSignals");
  const pairs = await readCurrentServingSignalPairs(4);

  assert.deepEqual(pairs, []);
  assert.equal(gspReadCount, 0);
});

test("CF5-7: an outbox query error throws (never silently substitutes GSP)", async () => {
  reset();
  currentServingRows = [
    { observation_id: "obs-1", observed_at: "2026-09-10T12:00:00.000Z", expires_at: "2026-09-10T18:00:00.000Z" },
  ];
  outboxError = { message: "simulated outbox read failure" };

  const { readCurrentServingSignalPairs } = await import("../../lib/feed/cacheGeneratedSignals");
  await assert.rejects(() => readCurrentServingSignalPairs(4));
  assert.equal(gspReadCount, 0);
});
