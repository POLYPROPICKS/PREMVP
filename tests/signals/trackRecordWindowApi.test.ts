import test from "node:test";
import assert from "node:assert/strict";
import {
  hasRenderableWindowRows,
  computeWindowResultsSummary,
  computeWindowReturnCurve,
  mapWindowResultRowToTrackRecordRow,
  type WindowResultRow,
} from "../../app/api/signals/resolved/route";

// Regression coverage for the July 4 incident: `track_record_window_summary.status`
// sitting in a non-"ready" state (tracking-live) must not erase real resolved
// rows that the read-model already returned. See docs/operations/
// TRACK_RECORD_REFRESH_RUNBOOK.md for the incident write-up.

function windowResultRow(overrides: Partial<WindowResultRow> = {}): WindowResultRow {
  return {
    window_days: 14,
    source_row_id: "11111111-1111-1111-1111-111111111111",
    score_rank: 1,
    shown_batch_day: "2026-06-27",
    normalized_match_key: "team a vs team b",
    match_key: "team-a-vs-team-b-event",
    signal_key: "team-a-vs-team-b|Team A",
    event_title: "Team A vs Team B",
    market_question: "Will Team A win?",
    selected_outcome: "Team A",
    signal_result: "won",
    display_status: "Hit",
    is_resolved: true,
    resolved_at: "2026-06-28T12:00:00.000Z",
    winning_outcome: "Team A",
    entry_price_num: 0.5,
    decimal_odds: 2,
    real_pnl_usd: 100,
    return_label: "+$100",
    ...overrides,
  };
}

test("hasRenderableWindowRows: true when the read-model returned resolved rows, regardless of summary status", () => {
  const rows = [windowResultRow(), windowResultRow({ source_row_id: "row-2", display_status: "Miss", signal_result: "lost", real_pnl_usd: -100 })];
  assert.equal(hasRenderableWindowRows(rows), true);
});

test("hasRenderableWindowRows: false only when the read-model query actually returned nothing", () => {
  assert.equal(hasRenderableWindowRows([]), false);
});

test("computeWindowResultsSummary: real resolved/win/loss counts and PnL are derived straight from rows (no status gate)", () => {
  const rows = [
    windowResultRow({ source_row_id: "row-1" }),
    windowResultRow({ source_row_id: "row-2", display_status: "Miss", signal_result: "lost", real_pnl_usd: -100 }),
    windowResultRow({ source_row_id: "row-3", is_resolved: false, display_status: "Pending", real_pnl_usd: 0 }),
  ];
  const summary = computeWindowResultsSummary(rows);
  assert.equal(summary.signalsTracked, 3);
  assert.equal(summary.resolvedCount, 2);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.winsCount, 1);
  assert.equal(summary.lossesCount, 1);
  assert.equal(summary.netProfitUsd, 0);
});

test("computeWindowReturnCurve: produces renderable points from real resolved rows even when window is tracking-live", () => {
  const rows = [
    windowResultRow({ source_row_id: "row-1" }),
    windowResultRow({ source_row_id: "row-2", display_status: "Miss", signal_result: "lost", real_pnl_usd: -100, resolved_at: "2026-06-29T12:00:00.000Z" }),
  ];
  const curve = computeWindowReturnCurve(rows);
  assert.ok(curve.length > 0, "return curve must not be empty when resolved rows exist");
});

test("mapWindowResultRowToTrackRecordRow: still prefers shown_batch_day over resolved_at (no regression from PR #39)", () => {
  const row = windowResultRow({ shown_batch_day: "2026-06-27", resolved_at: "2026-07-02T00:00:00.000Z" });
  const mapped = mapWindowResultRowToTrackRecordRow(row);
  assert.equal(mapped.createdAt, "2026-06-27");
});

test("mapWindowResultRowToTrackRecordRow: falls back to resolved_at when shown_batch_day is missing", () => {
  const row = windowResultRow({ shown_batch_day: null, resolved_at: "2026-07-02T00:00:00.000Z" });
  const mapped = mapWindowResultRowToTrackRecordRow(row);
  assert.equal(mapped.createdAt, "2026-07-02T00:00:00.000Z");
});
