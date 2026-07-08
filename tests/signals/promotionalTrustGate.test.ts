import test from "node:test";
import assert from "node:assert/strict";
import {
  isPromotionalTrustMetricUsable,
  selectHomepageTopTrustCard,
} from "@/lib/track-record/promotionalTrustGate";
import type { WeekResultsCard } from "@/components/signal-week-results/types";

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
