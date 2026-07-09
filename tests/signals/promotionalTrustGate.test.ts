import test from "node:test";
import assert from "node:assert/strict";
import {
  isPromotionalTrustMetricUsable,
  selectHomepageTopTrustCard,
  buildQualifiedResolvedDisplaySet,
  buildQualifiedCumulativeReturnCurve,
  buildCanonicalProofCard,
  type QualifiedCurveRow,
  type CanonicalProofSignal,
} from "@/lib/track-record/promotionalTrustGate";
import type { WeekResultsCard } from "@/components/signal-week-results/types";

function makeRows(winnerCount: number, nonWinnerCount: number): QualifiedCurveRow[] {
  const rows: QualifiedCurveRow[] = [];
  for (let i = 0; i < winnerCount; i++) {
    rows.push({ id: `w${i}`, isWinner: true, returnUsd: 40 });
  }
  for (let i = 0; i < nonWinnerCount; i++) {
    rows.push({ id: `l${i}`, isWinner: false, returnUsd: -100 });
  }
  return rows;
}

function makeCard(overrides: Partial<WeekResultsCard>): WeekResultsCard {
  return {
    cardType: "signal-week-results",
    schemaVersion: "week-results-v1-legacy-proof",
    source: "generated_signal_pairs_legacy_7d_proof",
    status: "ready",
    window: { label: "Past 7 days", days: 7, startedAt: "2026-07-01T00:00:00Z", endedAt: "2026-07-08T00:00:00Z" },
    title: "Signals tracked this week",
    subtitle: "Real tracking, not a performance guarantee",
    sampleSizeStatus: "enough_data",
    selectedSignals: 0,
    oddsCoveragePct: 100,
    oddsSourceBreakdown: {},
    projectedWinRatePct: 0,
    avgDecimalOdds: 0,
    projectedPnlUnits: 0,
    projectedReturnUsd: 0,
    projectedRoiPct: 0,
    stakeUsd: 100,
    totalStakeUsd: 0,
    netProfitUsd: 0,
    netReturnPct: 0,
    signalsTracked: 0,
    resolvedCount: 0,
    pendingCount: 0,
    winsCount: 0,
    lossesCount: 0,
    returnCurve: [],
    trackRecordDisplayTable: { windowDays: 7, rows: [] },
    ...overrides,
  };
}

test("isPromotionalTrustMetricUsable rejects below 60 percent winners", () => {
  assert.equal(
    isPromotionalTrustMetricUsable({ resolvedCount: 10, winsCount: 5, netProfitUsd: 42 }),
    false
  );
});

test("isPromotionalTrustMetricUsable rejects negative PnL even with enough winners", () => {
  assert.equal(
    isPromotionalTrustMetricUsable({ resolvedCount: 10, winsCount: 7, netProfitUsd: -1 }),
    false
  );
});

test("isPromotionalTrustMetricUsable accepts 6 of 10 winners with non-negative PnL", () => {
  assert.equal(
    isPromotionalTrustMetricUsable({ resolvedCount: 10, winsCount: 6, netProfitUsd: 0 }),
    true
  );
  assert.equal(
    isPromotionalTrustMetricUsable({ resolvedCount: 10, winsCount: 6, netProfitUsd: 12.5 }),
    true
  );
});

test("isPromotionalTrustMetricUsable rejects zero resolved rows (no fabricated proof from an empty window)", () => {
  assert.equal(
    isPromotionalTrustMetricUsable({ resolvedCount: 0, winsCount: 0, netProfitUsd: 0 }),
    false
  );
});

test("selectHomepageTopTrustCard does not fall back to broad weekResultsCard when curated latest signals are insufficient or non-promotable", () => {
  const weekResultsCard = makeCard({
    source: "track_record_window_results",
    schemaVersion: "week-results-v3-resolved",
    resolvedCount: 46,
    winsCount: 26,
    lossesCount: 20,
    netProfitUsd: -71,
    netReturnPct: -1.55,
  });

  const result = selectHomepageTopTrustCard({
    legacyCard: null,
    weekResultsCardTemplate: weekResultsCard,
    curatedSignals: [
      { result: "won", returnPct: 40 },
      { result: "lost", returnPct: -100 },
      { result: "lost", returnPct: -100 },
    ],
  });

  assert.equal(result, null);
});

test("selectHomepageTopTrustCard does not use weekResultsCard's own negative aggregate even when legacyCard is absent and curatedSignals is empty", () => {
  const weekResultsCard = makeCard({
    resolvedCount: 46,
    winsCount: 26,
    netProfitUsd: -71,
  });

  const result = selectHomepageTopTrustCard({
    legacyCard: null,
    weekResultsCardTemplate: weekResultsCard,
    curatedSignals: [],
  });

  assert.equal(result, null);
});

test("selectHomepageTopTrustCard can derive a promotable card from curated latest resolved signals when gate passes", () => {
  const weekResultsCard = makeCard({ resolvedCount: 46, winsCount: 26, netProfitUsd: -71 });

  const result = selectHomepageTopTrustCard({
    legacyCard: null,
    weekResultsCardTemplate: weekResultsCard,
    curatedSignals: [
      { result: "won", returnPct: 40 },
      { result: "won", returnPct: 25 },
      { result: "won", returnPct: 15 },
      { result: "won", returnPct: 10 },
      { result: "won", returnPct: 5 },
      { result: "lost", returnPct: -100 },
      { result: "won", returnPct: 30 },
    ],
  });

  assert.notEqual(result, null);
  assert.equal(result!.winsCount, 6);
  assert.equal(result!.resolvedCount, 7);
  assert.ok(result!.netProfitUsd >= 0);
});

test("selectHomepageTopTrustCard prefers a promotable legacyCard over deriving from curated signals", () => {
  const legacyCard = makeCard({ resolvedCount: 7, winsCount: 6, netProfitUsd: 120 });
  const weekResultsCard = makeCard({ resolvedCount: 46, winsCount: 26, netProfitUsd: -71 });

  const result = selectHomepageTopTrustCard({
    legacyCard,
    weekResultsCardTemplate: weekResultsCard,
    curatedSignals: [],
  });

  assert.equal(result, legacyCard);
});

test("selectHomepageTopTrustCard rejects a legacyCard that itself fails the gate, then tries curated signals", () => {
  const legacyCard = makeCard({ resolvedCount: 5, winsCount: 1, netProfitUsd: -300 });
  const weekResultsCard = makeCard({ resolvedCount: 46, winsCount: 26, netProfitUsd: -71 });

  const result = selectHomepageTopTrustCard({
    legacyCard,
    weekResultsCardTemplate: weekResultsCard,
    curatedSignals: [
      { result: "won", returnPct: 10 },
      { result: "won", returnPct: 10 },
      { result: "won", returnPct: 10 },
    ],
  });

  assert.notEqual(result, null);
  assert.notEqual(result, legacyCard);
  assert.equal(result!.winsCount, 3);
});

test("buildQualifiedResolvedDisplaySet builds 14W 9L from 25-row pool", () => {
  const rows = makeRows(14, 11);
  const selected = buildQualifiedResolvedDisplaySet(rows);
  assert.equal(selected.length, 23);
  assert.equal(selected.filter((r) => r.isWinner).length, 14);
  assert.equal(selected.filter((r) => !r.isWinner).length, 9);
});

test("buildQualifiedResolvedDisplaySet builds 26W 17L from 46-row pool with 26 winners and 20 non-winners", () => {
  const rows = makeRows(26, 20);
  const selected = buildQualifiedResolvedDisplaySet(rows);
  assert.equal(selected.length, 43);
  assert.equal(selected.filter((r) => r.isWinner).length, 26);
  assert.equal(selected.filter((r) => !r.isWinner).length, 17);
});

test("buildQualifiedResolvedDisplaySet builds 27W 18L from 46-row pool with 27 winners and 19 non-winners", () => {
  const rows = makeRows(27, 19);
  const selected = buildQualifiedResolvedDisplaySet(rows);
  assert.equal(selected.length, 45);
  assert.equal(selected.filter((r) => r.isWinner).length, 27);
  assert.equal(selected.filter((r) => !r.isWinner).length, 18);
});

test("buildQualifiedResolvedDisplaySet never adds a loser-only tail when no winners remain", () => {
  const rows = makeRows(0, 30);
  const selected = buildQualifiedResolvedDisplaySet(rows);
  assert.equal(selected.length, 0);
});

test("buildQualifiedCumulativeReturnCurve uses actual returns from selected rows only", () => {
  const rows: QualifiedCurveRow[] = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, isWinner: true, returnUsd: 40 })),
    { id: "l0", isWinner: false, returnUsd: -100 },
    { id: "l1", isWinner: false, returnUsd: -100 },
    { id: "l2", isWinner: false, returnUsd: -100 },
    { id: "l3", isWinner: false, returnUsd: -100 },
    // excluded from the graph: 5th non-winner in a block of only 6 winners
    { id: "l4", isWinner: false, returnUsd: -100000 },
  ];

  const curve = buildQualifiedCumulativeReturnCurve(rows);
  assert.equal(curve.length, 10);
  const finalPoint = curve[curve.length - 1];
  assert.equal(finalPoint.cumulativeProfitUsd, 6 * 40 - 4 * 100);
});

test("buildQualifiedCumulativeReturnCurve preserves selected order by bucket rule", () => {
  const rows = makeRows(8, 6);
  const selected = buildQualifiedResolvedDisplaySet(rows);
  const ids = selected.map((r) => r.id);
  assert.deepEqual(ids, [
    "w0", "w1", "w2", "w3", "w4", "w5", "l0", "l1", "l2", "l3",
    "w6", "w7", "l4",
  ]);

  const curve = buildQualifiedCumulativeReturnCurve(rows);
  assert.equal(curve.length, 13);
});

test("buildQualifiedResolvedDisplaySet still selects the same 6W:4L rows", () => {
  assert.equal(buildQualifiedResolvedDisplaySet(makeRows(14, 11)).length, 23);
  assert.equal(buildQualifiedResolvedDisplaySet(makeRows(26, 20)).length, 43);
  assert.equal(buildQualifiedResolvedDisplaySet(makeRows(27, 19)).length, 45);
});

test("buildQualifiedCumulativeReturnCurve plots selected rows chronologically, not bucket order", () => {
  const rows: QualifiedCurveRow[] = [
    { id: "W1", isWinner: true, returnUsd: 40, createdAt: "2026-01-01" },
    { id: "W2", isWinner: true, returnUsd: 41, createdAt: "2026-01-03" },
    { id: "W3", isWinner: true, returnUsd: 42, createdAt: "2026-01-05" },
    { id: "W4", isWinner: true, returnUsd: 43, createdAt: "2026-01-07" },
    { id: "W5", isWinner: true, returnUsd: 44, createdAt: "2026-01-09" },
    { id: "W6", isWinner: true, returnUsd: 45, createdAt: "2026-01-10" },
    { id: "L1", isWinner: false, returnUsd: -100, createdAt: "2026-01-02" },
    { id: "L2", isWinner: false, returnUsd: -101, createdAt: "2026-01-04" },
    { id: "L3", isWinner: false, returnUsd: -102, createdAt: "2026-01-06" },
    { id: "L4", isWinner: false, returnUsd: -103, createdAt: "2026-01-08" },
  ];

  // Bucket-selection order is W1..W6,L1..L4 (one full block, no tail); the
  // chronological plot order interleaves them by createdAt instead.
  const curve = buildQualifiedCumulativeReturnCurve(rows);
  const expectedCumulative = [40, -60, -19, -120, -78, -180, -137, -240, -196, -151];
  assert.deepEqual(
    curve.map((p) => p.cumulativeProfitUsd),
    expectedCumulative
  );
});

test("chronological plotting keeps same selected IDs and same final cumulative value", () => {
  const rows = makeRows(8, 6).map((r, i) => ({ ...r, createdAt: `2026-01-${String(30 - i).padStart(2, "0")}` }));

  const selected = buildQualifiedResolvedDisplaySet(rows);
  const curve = buildQualifiedCumulativeReturnCurve(rows);

  assert.equal(curve.length, selected.length);
  const expectedFinal = selected.reduce((s, r) => s + r.returnUsd, 0);
  assert.equal(curve[curve.length - 1].cumulativeProfitUsd, round2(expectedFinal));
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── buildCanonicalProofCard — canonical Latest Resolved proof card ───────────

function makeProofSignal(overrides: Partial<CanonicalProofSignal> & { id: string }): CanonicalProofSignal {
  return {
    eventTitle: `Event ${overrides.id}`,
    pick: "Team A",
    result: "won",
    returnPct: 40,
    europeanOdds: 1.4,
    americanOdds: "-250",
    resolvedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function threeWinsTwoLosses(): CanonicalProofSignal[] {
  return [
    makeProofSignal({ id: "w1", result: "won", returnPct: 80, resolvedAt: "2026-07-01T00:00:00Z" }),
    makeProofSignal({ id: "l1", result: "lost", returnPct: -100, resolvedAt: "2026-07-02T00:00:00Z" }),
    makeProofSignal({ id: "w2", result: "won", returnPct: 90, resolvedAt: "2026-07-03T00:00:00Z" }),
    makeProofSignal({ id: "l2", result: "lost", returnPct: -100, resolvedAt: "2026-07-04T00:00:00Z" }),
    makeProofSignal({ id: "w3", result: "won", returnPct: 70, resolvedAt: "2026-07-05T00:00:00Z" }),
  ];
}

test("buildCanonicalProofCard builds a valid 3W/2L positive card from exact selected rows", () => {
  const rows = threeWinsTwoLosses();
  const card = buildCanonicalProofCard(rows);

  assert.notEqual(card, null);
  assert.equal(card!.resolvedCount, 5);
  assert.equal(card!.winsCount, 3);
  assert.equal(card!.lossesCount, 2);
  assert.equal(card!.signalsTracked, 5);
  assert.equal(card!.trackRecordDisplayTable.rows.length, 5);

  // PnL equals the sum of the exact rows: 80 + 90 + 70 - 100 - 100 = 40.
  assert.equal(card!.netProfitUsd, 40);
  assert.equal(
    card!.netProfitUsd,
    rows.reduce((s, r) => s + (r.returnPct ?? 0), 0)
  );
  assert.equal(card!.projectedReturnUsd, 40);

  // Chips: 3 green (Hit) / 2 red (non-Hit).
  const table = card!.trackRecordDisplayTable.rows;
  assert.equal(table.filter((r) => r.displayStatus === "Hit").length, 3);
  assert.equal(table.filter((r) => r.displayStatus !== "Hit").length, 2);

  // Return curve is built from the same rows and ends at the same PnL.
  assert.equal(card!.returnCurve.length, 5);
  assert.equal(card!.returnCurve[card!.returnCurve.length - 1].cumulativeProfitUsd, 40);
});

test("buildCanonicalProofCard rejects negative total return", () => {
  const rows = threeWinsTwoLosses().map((r) =>
    r.result === "won" ? { ...r, returnPct: 30 } : r
  );
  // 30*3 - 100*2 = -110 → rejected even though wins > losses.
  assert.equal(buildCanonicalProofCard(rows), null);
});

test("buildCanonicalProofCard rejects fewer than 5 rows", () => {
  assert.equal(buildCanonicalProofCard(threeWinsTwoLosses().slice(0, 4)), null);
  assert.equal(buildCanonicalProofCard([]), null);
});

test("buildCanonicalProofCard rejects wins <= losses", () => {
  const rows = [
    makeProofSignal({ id: "w1", result: "won", returnPct: 300 }),
    makeProofSignal({ id: "w2", result: "won", returnPct: 300 }),
    makeProofSignal({ id: "l1", result: "lost", returnPct: -100 }),
    makeProofSignal({ id: "l2", result: "lost", returnPct: -100 }),
    makeProofSignal({ id: "l3", result: "lost", returnPct: -100 }),
  ];
  // Positive PnL (+200) but 2W/3L → rejected.
  assert.equal(buildCanonicalProofCard(rows), null);
});

test("buildCanonicalProofCard rejects non-won/lost rows so push/void can never count as proof", () => {
  const rows = [...threeWinsTwoLosses(), makeProofSignal({ id: "p1", result: "push", returnPct: 0 })];
  assert.equal(buildCanonicalProofCard(rows), null);
});

test("buildCanonicalProofCard never leaks a broad 26/49-style aggregate — counts always equal the input rows", () => {
  const card = buildCanonicalProofCard(threeWinsTwoLosses());
  assert.notEqual(card, null);
  assert.notEqual(card!.resolvedCount, 49);
  assert.notEqual(card!.winsCount, 26);
  assert.equal(card!.resolvedCount, card!.winsCount + card!.lossesCount);
  assert.equal(card!.selectedSignals, card!.trackRecordDisplayTable.rows.length);
  assert.equal(card!.pendingCount, 0);
});

test("buildCanonicalProofCard table and curve contain only the input row ids (no template rows leak)", () => {
  const rows = threeWinsTwoLosses();
  const card = buildCanonicalProofCard(rows);
  const inputIds = new Set(rows.map((r) => r.id));
  for (const tableRow of card!.trackRecordDisplayTable.rows) {
    assert.ok(inputIds.has(tableRow.id));
  }
  assert.equal(card!.trackRecordDisplayTable.rows.length, inputIds.size);
  assert.equal(card!.returnCurve.length, rows.length);
});

test("same-day rows use deterministic tie-breaker (sourceOrder, then id)", () => {
  const rows: QualifiedCurveRow[] = [
    { id: "W6", isWinner: true, returnUsd: 45, createdAt: "2026-01-01", sourceOrder: 6 },
    { id: "W1", isWinner: true, returnUsd: 40, createdAt: "2026-01-01", sourceOrder: 1 },
    { id: "W3", isWinner: true, returnUsd: 42, createdAt: "2026-01-01", sourceOrder: 3 },
    { id: "W2", isWinner: true, returnUsd: 41, createdAt: "2026-01-01", sourceOrder: 2 },
    { id: "W5", isWinner: true, returnUsd: 44, createdAt: "2026-01-01", sourceOrder: 5 },
    { id: "W4", isWinner: true, returnUsd: 43, createdAt: "2026-01-01", sourceOrder: 4 },
    { id: "L1", isWinner: false, returnUsd: -100, createdAt: "2026-01-01", sourceOrder: 10 },
    { id: "L2", isWinner: false, returnUsd: -101, createdAt: "2026-01-01", sourceOrder: 11 },
    { id: "L3", isWinner: false, returnUsd: -102, createdAt: "2026-01-01", sourceOrder: 12 },
    { id: "L4", isWinner: false, returnUsd: -103, createdAt: "2026-01-01", sourceOrder: 13 },
  ];

  const curve = buildQualifiedCumulativeReturnCurve(rows);
  assert.equal(curve.length, 10);
  // All same createdAt → order must follow sourceOrder ascending regardless
  // of input array order.
  const expectedFinal = rows.reduce((s, r) => s + r.returnUsd, 0);
  assert.equal(curve[curve.length - 1].cumulativeProfitUsd, round2(expectedFinal));
  assert.equal(curve[0].cumulativeProfitUsd, 40);
  assert.equal(curve[1].cumulativeProfitUsd, 81);
});
