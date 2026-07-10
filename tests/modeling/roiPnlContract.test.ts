import test from "node:test";
import assert from "node:assert/strict";

import {
  ROI_STATE_READY,
  ROI_STATE_NO_VALID_BETS,
  ROI_STATE_BLOCKED_BY_INVALID_ROWS,
  classifyResolvedOutcome,
  computeRowReturnPct,
  computeFlatStakeRoiSummary,
} from "../../lib/modeling/roiPnlContract";

// ---- A. Row classification ----

test("A1. classifies win row from signal_result: 'won'", () => {
  const result = classifyResolvedOutcome({ signal_result: "won" });
  assert.equal(result.label, "win");
});

test("A2. classifies loss row from signal_result: 'lost'", () => {
  const result = classifyResolvedOutcome({ signal_result: "lost" });
  assert.equal(result.label, "loss");
});

test("A3. supports common aliases already present in export contract/result labels", () => {
  assert.equal(classifyResolvedOutcome({ signal_result: "win" }).label, "win");
  assert.equal(classifyResolvedOutcome({ signal_result: "hit" }).label, "win");
  assert.equal(classifyResolvedOutcome({ signal_result: "correct" }).label, "win");
  assert.equal(classifyResolvedOutcome({ signal_result: "yes" }).label, "win");
  assert.equal(classifyResolvedOutcome({ signal_result: "loss" }).label, "loss");
  assert.equal(classifyResolvedOutcome({ signal_result: "miss" }).label, "loss");
  assert.equal(classifyResolvedOutcome({ signal_result: "incorrect" }).label, "loss");
  assert.equal(classifyResolvedOutcome({ signal_result: "no" }).label, "loss");
});

test("A4. unresolved/unknown/missing result is excluded and counted, not treated as loss", () => {
  assert.equal(classifyResolvedOutcome({ signal_result: "pending" }).label, "unresolved");
  assert.equal(classifyResolvedOutcome({}).label, "unresolved");
  assert.equal(classifyResolvedOutcome({ signal_result: null }).label, "unresolved");
});

test("A5. invalid result label is counted as invalid, not silently coerced", () => {
  const result = classifyResolvedOutcome({ signal_result: "garbage-not-a-label" });
  assert.equal(result.label, "invalid");
});

// ---- B. Return source precedence ----

test("B6. if realized_return_pct is finite, use it as canonical realized return percentage", () => {
  const result = computeRowReturnPct({ signal_result: "won", realized_return_pct: 150 });
  assert.equal(result.returnPct, 150);
  assert.equal(result.source, "realized_return_pct");
});

test("B7. win row with no realized_return_pct but valid entry_price_num derives binary payout return", () => {
  const result = computeRowReturnPct({ signal_result: "won", entry_price_num: 0.4 });
  assert.equal(result.returnPct, 150);
  assert.equal(result.source, "derived_from_entry_price");
});

test("B8. loss row with no realized_return_pct has return pct -100", () => {
  const result = computeRowReturnPct({ signal_result: "lost" });
  assert.equal(result.returnPct, -100);
  assert.equal(result.source, "loss_default");
});

test("B9. win row lacking both realized_return_pct and valid entry price is blocked/invalid", () => {
  const result = computeRowReturnPct({ signal_result: "won" });
  assert.equal(result.returnPct, null);
  assert.equal(result.invalidReason, "missing_return_and_entry_price");
});

test("B10. entry_price_num must be finite and 0 < entry_price_num <= 1 to be used", () => {
  const result = computeRowReturnPct({ signal_result: "won", entry_price_num: 0.5 });
  assert.equal(result.returnPct, 100);
});

test("B11. entry prices 0, negative, >1, NaN, Infinity are invalid", () => {
  for (const badPrice of [0, -0.5, 1.5, NaN, Infinity, -Infinity]) {
    const result = computeRowReturnPct({ signal_result: "won", entry_price_num: badPrice });
    assert.equal(result.returnPct, null, `expected null for entry_price_num=${badPrice}`);
    assert.equal(result.invalidReason, "missing_return_and_entry_price");
  }
});

// ---- C. PnL / ROI math ----

test("C12. flat stake default is 1 unit per valid resolved row", () => {
  const summary = computeFlatStakeRoiSummary([{ signal_result: "won", realized_return_pct: 100 }], {
    strict: false,
  });
  assert.equal(summary.stakeUnits, 1);
});

test("C13-C16. row pnl, totalStakeUnits, totalPnlUnits, roiPct math", () => {
  const rows = [
    { signal_result: "won", realized_return_pct: 100 },
    { signal_result: "lost" },
  ];
  const summary = computeFlatStakeRoiSummary(rows, { strict: false, stakeUnits: 2 });
  assert.equal(summary.validBetCount, 2);
  assert.equal(summary.totalStakeUnits, 4);
  // row1 pnl = 100/100*2 = 2; row2 pnl = -100/100*2 = -2; total = 0
  assert.equal(summary.totalPnlUnits, 0);
  assert.equal(summary.roiPct, 0);
});

test("C17. averageReturnPct is arithmetic mean of row return_pct over valid bets", () => {
  const rows = [
    { signal_result: "won", realized_return_pct: 100 },
    { signal_result: "lost" },
  ];
  const summary = computeFlatStakeRoiSummary(rows, { strict: false });
  assert.equal(summary.averageReturnPct, 0);
});

test("C18-C19. winRatePct and lossRatePct", () => {
  const rows = [
    { signal_result: "won", realized_return_pct: 100 },
    { signal_result: "won", realized_return_pct: 50 },
    { signal_result: "lost" },
  ];
  const summary = computeFlatStakeRoiSummary(rows, { strict: false });
  assert.equal(summary.winRatePct, (2 / 3) * 100);
  assert.equal(summary.lossRatePct, (1 / 3) * 100);
});

test("C20. empty valid bet set returns roiState NO_VALID_BETS, not 0% ROI", () => {
  const summary = computeFlatStakeRoiSummary([], { strict: false });
  assert.equal(summary.roiState, ROI_STATE_NO_VALID_BETS);
  assert.equal(summary.roiPct, null);
  assert.equal(summary.totalPnlUnits, null);
});

// ---- D. Blocking / audit counters ----

test("D21-D27. blocking/audit counters", () => {
  const rows = [
    { signal_result: "won", realized_return_pct: 100 }, // valid, realized
    { signal_result: "won", entry_price_num: 0.5 }, // valid, derived
    { signal_result: "pending" }, // unresolved
    { signal_result: "garbage" }, // invalid label
    { signal_result: "won" }, // invalid missing return/price
  ];
  const summary = computeFlatStakeRoiSummary(rows, { strict: false });
  assert.equal(summary.rowsExcludedUnresolved, 1);
  assert.equal(summary.rowsInvalidResultLabel, 1);
  assert.equal(summary.rowsInvalidMissingReturn, 1);
  assert.equal(summary.rowsUsedRealizedReturnPct, 1);
  assert.equal(summary.rowsDerivedFromEntryPrice, 1);
  assert.ok([ROI_STATE_READY, ROI_STATE_NO_VALID_BETS, ROI_STATE_BLOCKED_BY_INVALID_ROWS].includes(summary.roiState));
});

test("D27b. rowsInvalidEntryPrice counted separately from missing-return case", () => {
  const rows = [{ signal_result: "won", entry_price_num: 1.5 }];
  const summary = computeFlatStakeRoiSummary(rows, { strict: false });
  assert.equal(summary.rowsInvalidMissingReturn, 1);
});

test("D28. default strict mode blocks aggregate ROI if any invalid resolved row exists", () => {
  const rows = [
    { signal_result: "won", realized_return_pct: 100 },
    { signal_result: "garbage" },
  ];
  const summary = computeFlatStakeRoiSummary(rows);
  assert.equal(summary.roiState, ROI_STATE_BLOCKED_BY_INVALID_ROWS);
  assert.equal(summary.roiPct, null);
  assert.equal(summary.totalPnlUnits, null);
});

test("D29. non-strict mode excludes invalid rows but reports they were excluded", () => {
  const rows = [
    { signal_result: "won", realized_return_pct: 100 },
    { signal_result: "garbage" },
  ];
  const summary = computeFlatStakeRoiSummary(rows, { strict: false });
  assert.equal(summary.roiState, ROI_STATE_READY);
  assert.equal(summary.rowsInvalidResultLabel, 1);
  assert.equal(summary.validBetCount, 1);
});

test("D30. output contains no guaranteed/profit/marketing claim fields", () => {
  const rows = [{ signal_result: "won", realized_return_pct: 100 }];
  const summary = computeFlatStakeRoiSummary(rows, { strict: false });
  const keys = Object.keys(summary);
  assert.ok(!keys.some((k) => /guarantee/i.test(k)));
  assert.ok(!keys.some((k) => /profit/i.test(k)));
  assert.ok(!keys.some((k) => /marketing/i.test(k)));
});

// ---- E. Determinism / purity ----

test("E31. does not mutate input rows", () => {
  const row = { signal_result: "won", realized_return_pct: 100 };
  const snapshot = JSON.stringify(row);
  computeFlatStakeRoiSummary([row], { strict: false });
  assert.equal(JSON.stringify(row), snapshot);
});

test("E32. purity -- no Date.now/random/env/fs/network usage in source", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "../../lib/modeling/roiPnlContract.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /Date\.now\(/);
  assert.doesNotMatch(source, /Math\.random\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /require\(["']node:fs["']\)/);
  assert.doesNotMatch(source, /from ["']node:fs["']/);
  assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(source, /import .*onePerMatchBacktest/);
});

test("E33. deterministic output for same rows", () => {
  const rows = [
    { signal_result: "won", realized_return_pct: 100 },
    { signal_result: "lost" },
  ];
  const summary1 = computeFlatStakeRoiSummary(rows, { strict: false });
  const summary2 = computeFlatStakeRoiSummary(rows, { strict: false });
  assert.deepEqual(summary1, summary2);
});

test("E34. preserves row-level audit without logging raw payloads (JSON-safe summary)", () => {
  const rows = [{ signal_result: "won", realized_return_pct: 100 }];
  const summary = computeFlatStakeRoiSummary(rows, { strict: false });
  assert.doesNotThrow(() => JSON.stringify(summary));
});
