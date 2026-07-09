import test from "node:test";
import assert from "node:assert/strict";
import {
  auditOutcomeResolutionConsistency,
  type OutcomeResolutionAuditRow,
} from "../../lib/modeling/datasetAudit/outcomeResolutionConsistency";

test("counts win-labelled rows missing both valid entry price and realized return as winWithoutPriceOrReturnCount", () => {
  const rows: OutcomeResolutionAuditRow[] = [{ signal_result: "won" }];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithoutPriceOrReturnCount, 1);
  assert.equal(result.hasBlockingViolations, true);
});

test("counts win-labelled rows missing entry price but having realized return as not blocking", () => {
  const rows: OutcomeResolutionAuditRow[] = [{ signal_result: "won", realized_return_pct: 100 }];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithoutPriceOrReturnCount, 0);
  assert.equal(result.winWithRealizedReturnCount, 1);
  assert.equal(result.hasBlockingViolations, false);
});

test("counts win-labelled rows with entry price as not blocking", () => {
  const rows: OutcomeResolutionAuditRow[] = [{ signal_result: "won", entry_price_num: 0.5 }];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithoutPriceOrReturnCount, 0);
  assert.equal(result.winWithValidEntryPriceCount, 1);
  assert.equal(result.hasBlockingViolations, false);
});

test("does not count loss-labelled rows without entry price as quirk risk", () => {
  const rows: OutcomeResolutionAuditRow[] = [{ signal_result: "lost" }];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithoutPriceOrReturnCount, 0);
  assert.equal(result.lossWithoutEntryPriceCount, 1);
  assert.equal(result.hasBlockingViolations, false);
});

test("counts unresolved/unknown rows separately", () => {
  const rows: OutcomeResolutionAuditRow[] = [
    { signal_result: "pending" },
    { signal_result: null },
    {},
  ];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.unresolvedOrUnknownRows, 3);
  assert.equal(result.winLabelRows, 0);
  assert.equal(result.lossLabelRows, 0);
});

test("supports result aliases: signal_result, result, outcome_status", () => {
  const rows: OutcomeResolutionAuditRow[] = [
    { signal_result: "won", entry_price_num: 0.5 },
    { result: "won", entry_price_num: 0.5 },
    { outcome_status: "won", entry_price_num: 0.5 },
  ];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winLabelRows, 3);
});

test("supports entry price aliases: entry_price_num, entryPrice, entry_price", () => {
  const rows: OutcomeResolutionAuditRow[] = [
    { signal_result: "won", entry_price_num: 0.5 },
    { signal_result: "won", entryPrice: 0.5 },
    { signal_result: "won", entry_price: 0.5 },
  ];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithValidEntryPriceCount, 3);
  assert.equal(result.winWithoutPriceOrReturnCount, 0);
});

test("supports realized return aliases: realized_return_pct, realizedReturnPct", () => {
  const rows: OutcomeResolutionAuditRow[] = [
    { signal_result: "won", realized_return_pct: 100 },
    { signal_result: "won", realizedReturnPct: 50 },
  ];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithRealizedReturnCount, 2);
  assert.equal(result.winWithoutPriceOrReturnCount, 0);
});

test("valid realized return allows 0", () => {
  const rows: OutcomeResolutionAuditRow[] = [{ signal_result: "won", realized_return_pct: 0 }];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithRealizedReturnCount, 1);
  assert.equal(result.winWithoutPriceOrReturnCount, 0);
});

test("valid entry price must be > 0, not just present", () => {
  const rows: OutcomeResolutionAuditRow[] = [{ signal_result: "won", entry_price_num: 0 }];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithValidEntryPriceCount, 0);
  assert.equal(result.winWithoutPriceOrReturnCount, 1);
});

test("labels are matched case-insensitively", () => {
  const rows: OutcomeResolutionAuditRow[] = [
    { signal_result: "WON", entry_price_num: 0.5 },
    { signal_result: "Lost" },
  ];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winLabelRows, 1);
  assert.equal(result.lossLabelRows, 1);
});

test("returns no ROI/PnL/profit fields", () => {
  const rows: OutcomeResolutionAuditRow[] = [{ signal_result: "won", entry_price_num: 0.5 }];
  const result = auditOutcomeResolutionConsistency(rows);

  const serialized = JSON.stringify(result).toLowerCase();
  assert.ok(!serialized.includes("\"roi\""));
  assert.ok(!serialized.includes("\"pnl\""));
  assert.ok(!serialized.includes("profit"));
});

test("does not mutate input rows", () => {
  const rows: OutcomeResolutionAuditRow[] = [{ signal_result: "won", entry_price_num: 0.5 }];
  const snapshot = JSON.parse(JSON.stringify(rows));

  auditOutcomeResolutionConsistency(rows);

  assert.deepEqual(rows, snapshot);
});

test("sets hasBlockingViolations true when winWithoutPriceOrReturnCount > 0", () => {
  const rows: OutcomeResolutionAuditRow[] = [
    { signal_result: "won", entry_price_num: 0.5 },
    { signal_result: "won" },
  ];
  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.winWithoutPriceOrReturnCount, 1);
  assert.equal(result.hasBlockingViolations, true);
});

test("full diagnostics shape across a mixed fixture", () => {
  const rows: OutcomeResolutionAuditRow[] = [
    { signal_result: "won", entry_price_num: 0.5 }, // win, valid price
    { signal_result: "won", realized_return_pct: 100 }, // win, valid return
    { signal_result: "won" }, // win, at risk (blocking)
    { signal_result: "lost" }, // loss, no price (diagnostic only)
    { signal_result: "lost", entry_price_num: 0.4 }, // loss, has price
    { signal_result: "pending" }, // unresolved
    {}, // missing label
  ];

  const result = auditOutcomeResolutionConsistency(rows);

  assert.equal(result.totalRows, 7);
  assert.equal(result.winLabelRows, 3);
  assert.equal(result.lossLabelRows, 2);
  assert.equal(result.unresolvedOrUnknownRows, 2);
  assert.equal(result.winWithValidEntryPriceCount, 1);
  assert.equal(result.winWithRealizedReturnCount, 1);
  assert.equal(result.winWithoutPriceOrReturnCount, 1);
  assert.equal(result.lossWithoutEntryPriceCount, 1);
  assert.equal(result.rowsMissingResultLabelCount, 1);
  assert.equal(result.hasBlockingViolations, true);
});
