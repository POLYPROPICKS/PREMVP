import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildLegacySevenDayProofFromRows,
  type DbRow,
} from "../../app/api/signals/resolved/route";

// Regression coverage for Phase 2 of UI_recovery_plan1: Latest Resolved Signals
// (mode=latest&days=14&limit=7) must render from the old independent
// generated_signal_pairs contract when track_record_window_results has no rows
// for the window, instead of depending on the read-model / WhyTrust pipeline.

const routeSource = fs.readFileSync(
  path.join(__dirname, "../../app/api/signals/resolved/route.ts"),
  "utf8"
);

function legacyDbRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: "row-1",
    created_at: "2026-06-25T12:00:00.000Z",
    resolved_at: "2026-06-26T12:00:00.000Z",
    condition_id: "cond-1",
    selected_outcome: "Team A",
    winning_outcome: "Team A",
    signal_result: "won",
    realized_return_pct: 50,
    metric_formula_version: null,
    entry_price_num: 0.6,
    premium_signal: { eventTitle: "Team A vs Team B" },
    diagnostics: null,
    ...overrides,
  };
}

test("legacy proof builder produces non-empty signals for a 14-day window (source-agnostic, no read-model dependency)", () => {
  const rows = [
    legacyDbRow({ id: "r1", condition_id: "c1" }),
    legacyDbRow({ id: "r2", condition_id: "c2", signal_result: "lost", realized_return_pct: null }),
  ];
  const proof = buildLegacySevenDayProofFromRows(rows, 14);
  assert.ok(proof.signals.length > 0, "legacy builder must return signals regardless of window size");
});

test("route: Latest mode falls back to the legacy generated_signal_pairs contract for non-7-day windows when read-model signals are empty", () => {
  // Must NOT touch the existing 7-day-only gate (asserted by publishedActivity.test.ts).
  assert.ok(routeSource.includes("isLatestMode && windowDays === LEGACY_PROOF_WINDOW_DAYS"));
  // New fallback path: latest mode, any window other than the 7-day proof window,
  // triggered only when the read-model produced zero rows for this window —
  // reusing the SAME single generated_signal_pairs query (no second live query).
  assert.ok(
    routeSource.includes("isLatestMode && windowDays !== LEGACY_PROOF_WINDOW_DAYS && windowRows.length === 0"),
    "route must wire a legacy generated_signal_pairs fallback for Latest signals outside the 7-day proof window"
  );
  const occurrences = routeSource.split('.from("generated_signal_pairs")').length - 1;
  assert.equal(occurrences, 1, "the fallback must reuse the existing single generated_signal_pairs query, not add a second one");
});
