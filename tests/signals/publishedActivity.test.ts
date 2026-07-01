import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDisplaySignalsSummary,
  mapDisplaySignalRowToTrackRecordRow,
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
      return_label: "+$54",
      action: "ENTER",
      source_model: "model-v2",
    })
  );

  assert.equal(row.id, "2026-06-28-3");
  assert.equal(row.eventTitle, "Lakers vs Celtics");
  assert.equal(row.marketQuestion, "Will Lakers win?");
  assert.equal(row.pick, "Lakers");
  assert.equal(row.status, "Published");
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
