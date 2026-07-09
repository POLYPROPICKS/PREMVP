import test from "node:test";
import assert from "node:assert/strict";
import { auditReturnFormulaConsistency } from "../../lib/modeling/datasetAudit/returnFormulaConsistency";

test("audits return/pnl formula consistency against canonical win/loss formula", () => {
  const rows = [
    { signal_result: "won", entry_price_num: 0.5, realized_return_pct: 100 },
    { signal_result: "lost", entry_price_num: 0.4, realized_return_pct: -100 },
    { signal_result: "won", entry_price_num: 0.5, realized_return_pct: 42 },
    { signal_result: "won", entry_price_num: 0.5 },
    { signal_result: "won", entry_price_num: 0, realized_return_pct: 100 },
    { signal_result: "lost", entry_price_num: 0.4, realized_return_pct: 25 },
    { signal_result: "won", entry_price_num: 0.4, realized_return_pct: -30 },
    { signal_result: null, entry_price_num: 0.4, realized_return_pct: null },
  ];

  const summary = auditReturnFormulaConsistency(rows);

  assert.deepEqual(summary, {
    totalRows: 8,
    resolvedRows: 7,
    validReconciledCount: 2,
    recomputeMismatchCount: 1,
    missingRealizedReturnCount: 1,
    invalidEntryPriceCount: 1,
    signReturnConflictCount: 2,
    unresolvedExcludedCount: 1,
    hasBlockingViolations: true,
  });
});
