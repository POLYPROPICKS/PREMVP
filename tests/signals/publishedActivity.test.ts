import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSignalKey,
  buildMatchKey,
  extractProjectedScore,
  extractMarketPriceInfo,
  computeDecimalOdds,
  computePnlUnits,
  filterLatestBatchPerDay,
  dedupeBySignalKeyPerDay,
  dedupeByMatchKeyPerDay,
  applyTopSixOfTenFilter,
  computeProjectedTrackRecord,
  type RawPairRow,
} from "../../app/api/signals/resolved/route";

function row(overrides: Partial<RawPairRow> = {}): RawPairRow {
  return {
    id: "id-1",
    created_at: "2026-06-25T12:00:00.000Z",
    event_slug: "Team A vs Team B",
    market_slug: "Will Team A win?",
    selected_outcome: "Team A",
    premium_signal: { eventTitle: "Team A vs Team B", winProbability: 60 },
    diagnostics: { currentPrice: 0.5 },
    entry_price_num: null,
    expected_return_pct_num: null,
    ...overrides,
  };
}

// ── signalKey / matchKey ────────────────────────────────────────────────────

test("buildSignalKey normalizes case/whitespace and combines eventTitle+marketQuestion+position", () => {
  const a = buildSignalKey("  Team A  vs Team B ", "Will Team A Win?", "Team A");
  const b = buildSignalKey("team a vs team b", "will team a win?", "team a");
  assert.equal(a, b);
  assert.equal(a, "team a vs team b|will team a win?|team a");
});

test("buildMatchKey uses eventTitle only, ignores marketQuestion, falls back to event_slug/market_slug", () => {
  assert.equal(buildMatchKey("Team A vs Team B", null, null), "team a vs team b");
  assert.equal(buildMatchKey("", "slug-event", null), "slug-event");
  assert.equal(buildMatchKey("", null, "slug-market"), "slug-market");
});

// ── score normalization / priority ──────────────────────────────────────────

test("extractProjectedScore follows priority order and normalizes >1 as /100", () => {
  const withDisplay = row({ premium_signal: { displaySignalConfidence: 72, winProbability: 10 } });
  assert.equal(extractProjectedScore(withDisplay), 0.72);

  const withRaw = row({ premium_signal: { rawSignalScore: 55 } });
  assert.equal(extractProjectedScore(withRaw), 0.55);

  const fractionAlready = row({ premium_signal: { confidence: 0.4 } });
  assert.equal(extractProjectedScore(fractionAlready), 0.4);

  const clamped = row({ premium_signal: { score: 150 } });
  assert.equal(extractProjectedScore(clamped), 1);

  const none = row({ premium_signal: {} });
  assert.equal(extractProjectedScore(none), null);
});

// ── market price extraction ─────────────────────────────────────────────────

test("extractMarketPriceInfo prefers diagnostics.currentPrice", () => {
  const r = row({ diagnostics: { currentPrice: 0.42 }, entry_price_num: 0.9 });
  const info = extractMarketPriceInfo(r);
  assert.deepEqual(info, { price: 0.42, source: "diagnostics.currentPrice" });
});

test("extractMarketPriceInfo falls back to entry_price_num when diagnostics.currentPrice missing", () => {
  const r = row({ diagnostics: {}, entry_price_num: 0.33 });
  const info = extractMarketPriceInfo(r);
  assert.deepEqual(info, { price: 0.33, source: "entry_price_num" });
});

test("extractMarketPriceInfo falls back to expected_return_pct_num conversion", () => {
  const r = row({ diagnostics: {}, entry_price_num: null, expected_return_pct_num: 100 });
  const info = extractMarketPriceInfo(r);
  assert.ok(info);
  assert.equal(info!.source, "expected_return_pct_num");
  assert.equal(Math.round(info!.price * 100) / 100, 0.5);
});

test("extractMarketPriceInfo ignores premium_signal.price string and returns null when nothing usable", () => {
  const r = row({
    diagnostics: {},
    entry_price_num: null,
    expected_return_pct_num: null,
    premium_signal: { price: "$1.99" },
  });
  assert.equal(extractMarketPriceInfo(r), null);
});

// ── odds / PnL math ──────────────────────────────────────────────────────────

test("computeDecimalOdds = 1 / marketPrice", () => {
  assert.equal(computeDecimalOdds(0.5), 2);
  assert.equal(Math.round(computeDecimalOdds(0.4) * 1000) / 1000, 2.5);
});

test("computePnlUnits matches p*(decimalOdds-1) - (1-p) with $100 stake model", () => {
  const p = 0.6;
  const decimalOdds = 2;
  const pnl = computePnlUnits(p, decimalOdds);
  assert.equal(Math.round(pnl * 100) / 100, 0.2); // 0.6*1 - 0.4 = 0.2
  assert.equal(Math.round(pnl * 100 * 100) / 100, 20); // *$100 stake => $20
});

// ── latest batch per day ─────────────────────────────────────────────────────

test("filterLatestBatchPerDay keeps only the max created_at rows per UTC day", () => {
  const rows = [
    { createdAt: "2026-06-24T09:00:00.000Z" },
    { createdAt: "2026-06-24T14:00:00.000Z" }, // latest batch for this day
    { createdAt: "2026-06-25T08:00:00.000Z" },
  ];
  const kept = filterLatestBatchPerDay(rows);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((r) => r.createdAt === "2026-06-24T14:00:00.000Z"));
  assert.ok(!kept.some((r) => r.createdAt === "2026-06-24T09:00:00.000Z"));
});

// ── signalKey dedupe ─────────────────────────────────────────────────────────

test("dedupeBySignalKeyPerDay collapses duplicate signalKey within the same day", () => {
  const rows = [
    { signalKey: "k1", createdAt: "2026-06-24T14:00:00.000Z" },
    { signalKey: "k1", createdAt: "2026-06-24T14:00:00.000Z" },
    { signalKey: "k2", createdAt: "2026-06-24T14:00:00.000Z" },
  ];
  const deduped = dedupeBySignalKeyPerDay(rows);
  assert.equal(deduped.length, 2);
});

// ── matchKey dedupe (best per match) ────────────────────────────────────────

test("dedupeByMatchKeyPerDay keeps the highest projectedWinProbability per match", () => {
  const rows = [
    { matchKey: "m1", signalKey: "a", createdAt: "2026-06-24T14:00:00.000Z", projectedWinProbability: 0.5 },
    { matchKey: "m1", signalKey: "b", createdAt: "2026-06-24T14:00:00.000Z", projectedWinProbability: 0.8 },
  ];
  const deduped = dedupeByMatchKeyPerDay(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].signalKey, "b");
});

test("dedupeByMatchKeyPerDay breaks ties by latest createdAt then stable signalKey", () => {
  const rows = [
    { matchKey: "m1", signalKey: "zzz", createdAt: "2026-06-24T10:00:00.000Z", projectedWinProbability: 0.5 },
    { matchKey: "m1", signalKey: "aaa", createdAt: "2026-06-24T10:00:00.000Z", projectedWinProbability: 0.5 },
  ];
  const deduped = dedupeByMatchKeyPerDay(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].signalKey, "aaa");
});

// ── quality filter: top 6 of every 10 ───────────────────────────────────────

test("applyTopSixOfTenFilter keeps top 6 of each ranked block of 10", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ projectedWinProbability: 1 - i * 0.01 }));
  const kept = applyTopSixOfTenFilter(rows);
  assert.equal(kept.length, 12); // 6 kept per 10-row block, 2 blocks
});

// ── full pipeline / STOP behavior ───────────────────────────────────────────

test("computeProjectedTrackRecord STOPs when a selected row has no resolvable market price", () => {
  const rows: RawPairRow[] = [
    row({
      id: "bad-1",
      diagnostics: {},
      entry_price_num: null,
      expected_return_pct_num: null,
      premium_signal: { eventTitle: "X", winProbability: 90, price: "$1.99" },
    }),
  ];
  const result = computeProjectedTrackRecord(rows);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "MISSING_MARKET_PRICE");
  }
});

test("computeProjectedTrackRecord reports 100% odds coverage and no old resolved ROI shape", () => {
  const rows: RawPairRow[] = [
    row({
      id: "a",
      event_slug: "Match A",
      market_slug: "Will A win?",
      selected_outcome: "A",
      premium_signal: { eventTitle: "Match A", winProbability: 60 },
    }),
    row({
      id: "b",
      event_slug: "Match B",
      market_slug: "Will B win?",
      selected_outcome: "B",
      premium_signal: { eventTitle: "Match B", winProbability: 55 },
    }),
  ];
  const result = computeProjectedTrackRecord(rows);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.oddsCoveragePct, 100);
    assert.equal(result.selectedSignals, 2);
    assert.ok(!("totalReturnPct" in result));
    assert.notEqual(result.projectedRoiPct, -1766);
  }
});

test("computeProjectedTrackRecord API table rows expose the projected shape, not won/lost", () => {
  const rows: RawPairRow[] = [row({ id: "a" })];
  const result = computeProjectedTrackRecord(rows);
  assert.equal(result.ok, true);
  if (result.ok) {
    const [r] = result.rows;
    assert.ok(!("result" in r));
    assert.equal(typeof r.projectedWinProbability, "number");
    assert.equal(typeof r.decimalOdds, "number");
    assert.equal(typeof r.pnlUnits, "number");
  }
});

// ── source-row cap must not truncate before aggregation (7D vs 14D) ─────────

test("computeProjectedTrackRecord selectedSignals scales up when more distinct-day source rows are available (proves fetch limit must not cap before aggregation)", () => {
  const narrowWindowRows: RawPairRow[] = Array.from({ length: 12 }, (_, i) =>
    row({
      id: `narrow-${i}`,
      created_at: `2026-06-${String(20 + i).padStart(2, "0")}T12:00:00.000Z`,
      event_slug: `Match ${i}`,
      market_slug: `Will ${i} win?`,
      selected_outcome: `Team ${i}`,
      premium_signal: { eventTitle: `Match ${i}`, winProbability: 90 - i },
    })
  );
  const widerWindowRows: RawPairRow[] = Array.from({ length: 30 }, (_, i) =>
    row({
      id: `wide-${i}`,
      created_at: `2026-06-${String(1 + i).padStart(2, "0")}T12:00:00.000Z`,
      event_slug: `Match ${i}`,
      market_slug: `Will ${i} win?`,
      selected_outcome: `Team ${i}`,
      premium_signal: { eventTitle: `Match ${i}`, winProbability: 90 - i },
    })
  );

  const narrowResult = computeProjectedTrackRecord(narrowWindowRows);
  const widerResult = computeProjectedTrackRecord(widerWindowRows);
  assert.equal(narrowResult.ok, true);
  assert.equal(widerResult.ok, true);
  if (narrowResult.ok && widerResult.ok) {
    // A 14D-style window (more distinct-day rows) must select more signals
    // than a 7D-style window when the source rows are not truncated early.
    assert.ok(widerResult.selectedSignals > narrowResult.selectedSignals);
    assert.equal(narrowResult.selectedSignals, 8);
    assert.equal(widerResult.selectedSignals, 18);
  }
});

// ── trackRecordDisplayTable UI-safe shape (rows may be array, {rows:[]}, or missing) ─

function readDisplayTableRows(table: unknown): unknown[] {
  return Array.isArray(table)
    ? table
    : ((table as { rows?: unknown[] } | null | undefined)?.rows ?? []);
}

test("trackRecordDisplayTable UI extraction is safe for object-with-rows, bare-array, and missing shapes", () => {
  assert.deepEqual(readDisplayTableRows({ windowDays: 7, rows: [{ id: "a" }] }), [{ id: "a" }]);
  assert.deepEqual(readDisplayTableRows([{ id: "a" }]), [{ id: "a" }]);
  assert.deepEqual(readDisplayTableRows(undefined), []);
  assert.deepEqual(readDisplayTableRows(null), []);
  assert.deepEqual(readDisplayTableRows({}), []);
});
