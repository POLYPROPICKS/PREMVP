import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  computeDisplaySignalsSummary,
  mapDisplaySignalRowToTrackRecordRow,
  deriveDisplayStatus,
  formatReturnLabel,
  computeReturnCurve,
  type DisplaySignalRow,
} from "../../app/api/signals/resolved/route";

function displayRow(overrides: Partial<DisplaySignalRow> = {}): DisplaySignalRow {
  return {
    window_days: 7,
    source_model: "model-v1",
    score_rank: 1,
    event_title: "Team A vs Team B",
    market_question: "Will Team A win?",
    position: "Team A",
    american_odds: "+150",
    decimal_odds: 2.5,
    odds_source_path: "diagnostics.currentPrice",
    projected_win_rate_pct: 60,
    projected_pnl_units: 0.2,
    projected_return_usd: 20,
    projected_roi_pct_per_signal: 20,
    status: "Published",
    action: "ENTER",
    return_label: "+$20",
    batch_day: "2026-06-25",
    ...overrides,
  };
}

// ── summary aggregation from display table rows ─────────────────────────────

test("computeDisplaySignalsSummary aggregates selectedSignals, odds coverage, and averages from all rows", () => {
  const rows: DisplaySignalRow[] = [
    displayRow({ score_rank: 1, projected_win_rate_pct: 60, decimal_odds: 2, projected_pnl_units: 0.2, projected_return_usd: 20, projected_roi_pct_per_signal: 20 }),
    displayRow({ score_rank: 2, projected_win_rate_pct: 50, decimal_odds: 3, projected_pnl_units: -1, projected_return_usd: -100, projected_roi_pct_per_signal: -100 }),
  ];
  const summary = computeDisplaySignalsSummary(rows);

  assert.equal(summary.selectedSignals, 2);
  assert.equal(summary.oddsCoveragePct, 100);
  assert.deepEqual(summary.oddsSourceBreakdown, { "diagnostics.currentPrice": 2 });
  assert.equal(summary.projectedWinRatePct, 55);
  assert.equal(summary.avgDecimalOdds, 2.5);
  assert.equal(summary.projectedPnlUnits, -0.8);
  assert.equal(summary.projectedReturnUsd, -80);
  assert.equal(summary.projectedRoiPct, -40);
  assert.equal(summary.winsCount, 1);
  assert.equal(summary.lossesCount, 1);
  assert.equal(summary.resolvedCount, 2);
  assert.equal(summary.pendingCount, 0);
});

test("computeDisplaySignalsSummary reports partial odds coverage when some rows are missing odds", () => {
  const rows: DisplaySignalRow[] = [
    displayRow({ score_rank: 1, decimal_odds: 2, odds_source_path: "diagnostics.currentPrice" }),
    displayRow({ score_rank: 2, decimal_odds: null, odds_source_path: null }),
  ];
  const summary = computeDisplaySignalsSummary(rows);
  assert.equal(summary.oddsCoveragePct, 50);
});

test("computeDisplaySignalsSummary returns zeroed summary for an empty row set (no crash)", () => {
  const summary = computeDisplaySignalsSummary([]);
  assert.equal(summary.selectedSignals, 0);
  assert.equal(summary.oddsCoveragePct, 0);
  assert.deepEqual(summary.oddsSourceBreakdown, {});
  assert.equal(summary.projectedWinRatePct, 0);
  assert.equal(summary.avgDecimalOdds, 0);
  assert.equal(summary.projectedPnlUnits, 0);
  assert.equal(summary.projectedReturnUsd, 0);
  assert.equal(summary.projectedRoiPct, 0);
  assert.equal(summary.winsCount, 0);
  assert.equal(summary.lossesCount, 0);
  assert.equal(summary.resolvedCount, 0);
  assert.equal(summary.pendingCount, 0);
});

// ── Hit/Miss/Pending display-status derivation ──────────────────────────────

test("deriveDisplayStatus: positive projected return is Hit", () => {
  assert.equal(deriveDisplayStatus(72), "Hit");
});

test("deriveDisplayStatus: negative projected return is Miss", () => {
  assert.equal(deriveDisplayStatus(-100), "Miss");
});

test("deriveDisplayStatus: null, undefined, and exact zero are Pending", () => {
  assert.equal(deriveDisplayStatus(null), "Pending");
  assert.equal(deriveDisplayStatus(undefined), "Pending");
  assert.equal(deriveDisplayStatus(0), "Pending");
});

// ── Return label formatting: no +$0 / -$0 spam ──────────────────────────────

test("formatReturnLabel: positive/negative values format as +$N / -$N", () => {
  assert.equal(formatReturnLabel(72.4), "+$72");
  assert.equal(formatReturnLabel(-100), "-$100");
});

test("formatReturnLabel: zero/null/undefined never render +$0 or -$0", () => {
  assert.equal(formatReturnLabel(0), "—");
  assert.equal(formatReturnLabel(null), "—");
  assert.equal(formatReturnLabel(undefined), "—");
});

// ── resolvedCount/pendingCount derived from ALL rows, not a limited ledger ──

test("resolvedCount and pendingCount are derived from the full row set", () => {
  const rows: DisplaySignalRow[] = [
    displayRow({ score_rank: 1, projected_return_usd: 20 }),
    displayRow({ score_rank: 2, projected_return_usd: -50 }),
    displayRow({ score_rank: 3, projected_return_usd: 0 }),
    displayRow({ score_rank: 4, projected_return_usd: null }),
  ];
  const summary = computeDisplaySignalsSummary(rows);
  assert.equal(summary.winsCount, 1);
  assert.equal(summary.lossesCount, 1);
  assert.equal(summary.resolvedCount, 2);
  assert.equal(summary.pendingCount, 2);
});

// ── returnCurve: computed from ALL rows, final point matches projectedRoiPct ─

test("computeReturnCurve produces a running total and final point matches projectedRoiPct", () => {
  const rows: DisplaySignalRow[] = [
    displayRow({ score_rank: 1, projected_pnl_units: 0.2, projected_roi_pct_per_signal: 20, projected_return_usd: 20 }),
    displayRow({ score_rank: 2, projected_pnl_units: -1, projected_roi_pct_per_signal: -100, projected_return_usd: -100 }),
  ];
  const curve = computeReturnCurve(rows);
  const summary = computeDisplaySignalsSummary(rows);

  assert.equal(curve.length, 2);
  assert.equal(curve[0].cumulativePnlUnits, 0.2);
  assert.equal(curve[1].cumulativePnlUnits, -0.8);
  const finalPoint = curve[curve.length - 1];
  assert.equal(Math.round(finalPoint.cumulativeRoiPct), Math.round(summary.projectedRoiPct));
});

test("computeReturnCurve orders points by score_rank regardless of input order", () => {
  const rows: DisplaySignalRow[] = [
    displayRow({ score_rank: 2, projected_pnl_units: 1 }),
    displayRow({ score_rank: 1, projected_pnl_units: 0.5 }),
  ];
  const curve = computeReturnCurve(rows);
  assert.equal(curve[0].cumulativePnlUnits, 0.5);
  assert.equal(curve[1].cumulativePnlUnits, 1.5);
});

test("computeReturnCurve returns an empty array for no rows", () => {
  assert.deepEqual(computeReturnCurve([]), []);
});

// ── selectedSignals must use the full table row set, not a limited ledger ───

test("selectedSignals reflects the total table row count regardless of any ledger display limit", () => {
  const rows: DisplaySignalRow[] = Array.from({ length: 12 }, (_, i) =>
    displayRow({ score_rank: i + 1, batch_day: `2026-06-${String(20 + i).padStart(2, "0")}` })
  );
  const summary = computeDisplaySignalsSummary(rows);
  const ledgerRows = rows.slice(0, 7).map(mapDisplaySignalRowToTrackRecordRow);

  assert.equal(summary.selectedSignals, 12);
  assert.equal(ledgerRows.length, 7);
});

// ── 7D vs 14D windows must differ when the underlying rows differ ──────────

test("7D and 14D window summaries differ when their display-table rows differ", () => {
  const rows7d: DisplaySignalRow[] = [
    displayRow({ score_rank: 1, window_days: 7, projected_win_rate_pct: 60 }),
    displayRow({ score_rank: 2, window_days: 7, projected_win_rate_pct: 55 }),
  ];
  const rows14d: DisplaySignalRow[] = [
    displayRow({ score_rank: 1, window_days: 14, projected_win_rate_pct: 60 }),
    displayRow({ score_rank: 2, window_days: 14, projected_win_rate_pct: 55 }),
    displayRow({ score_rank: 3, window_days: 14, projected_win_rate_pct: 70 }),
    displayRow({ score_rank: 4, window_days: 14, projected_win_rate_pct: 65 }),
  ];

  const summary7d = computeDisplaySignalsSummary(rows7d);
  const summary14d = computeDisplaySignalsSummary(rows14d);

  assert.notEqual(summary7d.selectedSignals, summary14d.selectedSignals);
  assert.equal(summary7d.selectedSignals, 2);
  assert.equal(summary14d.selectedSignals, 4);
});

// ── row mapping: UI-facing TrackRecordRow shape ─────────────────────────────

test("mapDisplaySignalRowToTrackRecordRow maps display-table columns to the UI row shape", () => {
  const row = mapDisplaySignalRowToTrackRecordRow(
    displayRow({
      score_rank: 3,
      batch_day: "2026-06-28",
      event_title: "Lakers vs Celtics",
      market_question: "Will Lakers win?",
      position: "Lakers",
      projected_return_usd: 54,
      action: "ENTER",
      source_model: "model-v2",
    })
  );

  assert.equal(row.id, "2026-06-28-3");
  assert.equal(row.eventTitle, "Lakers vs Celtics");
  assert.equal(row.marketQuestion, "Will Lakers win?");
  assert.equal(row.pick, "Lakers");
  assert.equal(row.status, "Published");
  assert.equal(row.displayStatus, "Hit");
  assert.equal(row.returnLabel, "+$54");
  assert.equal(row.action, "ENTER");
  assert.equal(row.sourceModel, "model-v2");
  assert.notEqual(row.returnLabel, undefined);
});

test("mapDisplaySignalRowToTrackRecordRow falls back safely when odds/return fields are null", () => {
  const row = mapDisplaySignalRowToTrackRecordRow(
    displayRow({ decimal_odds: null, american_odds: null, return_label: null, projected_pnl_units: null, projected_return_usd: null, projected_roi_pct_per_signal: null, projected_win_rate_pct: null })
  );
  assert.equal(row.decimalOdds, 0);
  assert.equal(row.americanOdds, null);
  assert.equal(row.returnLabel, "—");
  assert.equal(row.displayStatus, "Pending");
  assert.equal(row.pnlUnits, 0);
  assert.equal(row.projectedReturnUsd, 0);
  assert.equal(row.projectedRoiPctPerSignal, 0);
  assert.equal(row.projectedWinProbabilityPct, 0);
});

// ── no old resolved-ROI shape / stale demo values ───────────────────────────

test("summary never produces the old stale resolved-ROI values", () => {
  const rows: DisplaySignalRow[] = [
    displayRow({ score_rank: 1 }),
    displayRow({ score_rank: 2 }),
  ];
  const summary = computeDisplaySignalsSummary(rows);
  assert.notEqual(summary.projectedRoiPct, -1766);
  assert.notEqual(summary.selectedSignals, 36);
  assert.ok(!("won" in summary));
  assert.ok(!("lost" in summary));
});

test("mapped rows never carry the old won/lost resolved-signal shape", () => {
  const row = mapDisplaySignalRowToTrackRecordRow(displayRow());
  assert.ok(!("result" in row));
  assert.ok(!("winner" in row));
  assert.equal(row.status, "Published");
});

// ── trackRecordDisplayTable is `{ rows: [...] }` and UI extraction is shape-safe ──

function readDisplayTableRows(table: unknown): unknown[] {
  return Array.isArray(table)
    ? table
    : ((table as { rows?: unknown[] } | null | undefined)?.rows ?? []);
}

test("trackRecordDisplayTable is an object with a rows array", () => {
  const rows = [displayRow()].map(mapDisplaySignalRowToTrackRecordRow);
  const table = { windowDays: 7, rows };
  assert.ok(!Array.isArray(table));
  assert.ok(Array.isArray(table.rows));
  assert.deepEqual(readDisplayTableRows(table), rows);
});

test("UI row extraction is safe for object-with-rows, bare-array, and missing/empty shapes", () => {
  assert.deepEqual(readDisplayTableRows({ windowDays: 7, rows: [{ id: "a" }] }), [{ id: "a" }]);
  assert.deepEqual(readDisplayTableRows([{ id: "a" }]), [{ id: "a" }]);
  assert.deepEqual(readDisplayTableRows(undefined), []);
  assert.deepEqual(readDisplayTableRows(null), []);
  assert.deepEqual(readDisplayTableRows({}), []);
});

// ── netProfitUsd / totalStakeUsd / netReturnPct: the $100-stake business formula ─

test("computeDisplaySignalsSummary: netProfitUsd = sum(projected_return_usd), totalStakeUsd = signalsTracked * 100", () => {
  const rows: DisplaySignalRow[] = [
    displayRow({ score_rank: 1, projected_return_usd: 115 }),
    displayRow({ score_rank: 2, projected_return_usd: 130 }),
    displayRow({ score_rank: 3, projected_return_usd: -45 }),
  ];
  const summary = computeDisplaySignalsSummary(rows);

  assert.equal(summary.stakeUsd, 100);
  assert.equal(summary.totalStakeUsd, 300);
  assert.equal(summary.netProfitUsd, 200);
});

test("computeDisplaySignalsSummary: netReturnPct (projectedRoiPct) = netProfitUsd / totalStakeUsd * 100", () => {
  const rows: DisplaySignalRow[] = Array.from({ length: 47 }, (_, i) =>
    displayRow({ score_rank: i + 1, projected_return_usd: i === 0 ? 300.51 : 0 })
  );
  const summary = computeDisplaySignalsSummary(rows);

  assert.equal(summary.totalStakeUsd, 4700);
  assert.equal(summary.netProfitUsd, 300.51);
  const expectedPct = round2(summary.netProfitUsd / summary.totalStakeUsd * 100);
  assert.equal(summary.projectedRoiPct, expectedPct);
  assert.equal(summary.projectedReturnUsd, summary.netProfitUsd);
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Pending epsilon: floating-point noise must never read as a false Hit ────

test("deriveDisplayStatus: tiny floating-point PNL (3.6e-15) is Pending, not a false Hit", () => {
  assert.equal(deriveDisplayStatus(3.6e-15), "Pending");
  assert.equal(deriveDisplayStatus(-3.6e-15), "Pending");
});

test("formatReturnLabel: tiny floating-point PNL (3.6e-15) renders as em dash, never +$0/-$0", () => {
  assert.equal(formatReturnLabel(3.6e-15), "—");
  assert.equal(formatReturnLabel(-3.6e-15), "—");
});

test("deriveDisplayStatus/formatReturnLabel: values under the $0.5 epsilon are Pending / em dash", () => {
  assert.equal(deriveDisplayStatus(0.49), "Pending");
  assert.equal(deriveDisplayStatus(-0.49), "Pending");
  assert.equal(formatReturnLabel(0.49), "—");
  assert.equal(deriveDisplayStatus(0.5), "Hit");
  assert.equal(formatReturnLabel(0.5), "+$1");
});

// ── API source remains the accepted physical display table ─────────────────

const routeSource = fs.readFileSync(
  path.join(__dirname, "../../app/api/signals/resolved/route.ts"),
  "utf8"
);

test("weekResultsCard source stays track_record_display_signals (no runtime generated_signal_pairs aggregation)", () => {
  assert.ok(routeSource.includes('source: "track_record_display_signals"'));
  assert.ok(routeSource.includes('.from("track_record_display_signals")'));
});

// ── returnCurve: dollar-true cumulative series feeds the chart ─────────────

test("computeReturnCurve: cumulativeProfitUsd sums projected_return_usd and cumulativeReturnPct matches the netReturnPct formula", () => {
  const rows: DisplaySignalRow[] = [
    displayRow({ score_rank: 1, projected_return_usd: 20 }),
    displayRow({ score_rank: 2, projected_return_usd: -100 }),
  ];
  const curve = computeReturnCurve(rows);
  assert.equal(curve[0].cumulativeProfitUsd, 20);
  assert.equal(curve[1].cumulativeProfitUsd, -80);
  const finalPoint = curve[curve.length - 1];
  const summary = computeDisplaySignalsSummary(rows);
  assert.equal(finalPoint.cumulativeReturnPct, summary.projectedRoiPct);
});

// ── WhyTrustSection: approved visible labels present, replaced labels absent ─

const whyTrustSource = fs.readFileSync(
  path.join(__dirname, "../../components/why-trust/WhyTrustSection.tsx"),
  "utf8"
);

test("WhyTrustSection uses the approved visible labels", () => {
  for (const label of [
    "Net Return",
    "Signals Tracked",
    "Resolved",
    "Pending",
    "Cumulative Return",
    "Recent Signal Ledger",
    "How we track signals",
    "Flat $100 per resolved signal",
  ]) {
    assert.ok(whyTrustSource.includes(label), `expected label "${label}" in WhyTrustSection`);
  }
});

test("WhyTrustSection does not use the replaced labels", () => {
  for (const label of ["Projected Return", "Signals Published", "Projected Rate", "Avg Odds", "Published"]) {
    assert.ok(!whyTrustSource.includes(label), `unexpected replaced label "${label}" in WhyTrustSection`);
  }
});

// ── Net Return headline must be dollars (netProfitUsd), percent secondary only ─

test("WhyTrustSection derives the Net Return headline value from netProfitUsd (dollars), not netReturnPct alone", () => {
  assert.ok(
    whyTrustSource.includes("fmtUsdSigned(card.netProfitUsd)"),
    "Net Return main value must be formatted from card.netProfitUsd"
  );
  assert.ok(
    whyTrustSource.includes("card.netReturnPct"),
    "netReturnPct must still appear as secondary subtext context"
  );
});

test("WhyTrustSection chart badge/series are dollar-based (cumulativeProfitUsd), not percent-only", () => {
  assert.ok(whyTrustSource.includes("cumulativeProfitUsd"));
  assert.ok(whyTrustSource.includes("fmtUsdSigned(points[endIdx].cumUsd)"));
});

// ── no old resolved-ROI ledger values survive in the projected model ────────

test("summary never produces the old stale resolved-ROI ledger counts (36 tracked / 8 wins / 28 losses)", () => {
  const rows: DisplaySignalRow[] = [displayRow({ score_rank: 1 }), displayRow({ score_rank: 2 })];
  const summary = computeDisplaySignalsSummary(rows);
  assert.notEqual(summary.selectedSignals, 36);
  assert.notEqual(summary.winsCount, 8);
  assert.notEqual(summary.lossesCount, 28);
  assert.notEqual(summary.projectedRoiPct, -1766);
});
