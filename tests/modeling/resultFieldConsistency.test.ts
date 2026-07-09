import test from "node:test";
import assert from "node:assert/strict";
import { auditResultFieldConsistency } from "../../lib/modeling/datasetAudit/resultFieldConsistency";

test("audits result field consistency across labels, casing, and inference", () => {
  const rows = [
    { signal_result: "won", selected_outcome: "A", winning_outcome: "A" },
    { signal_result: "lost", selected_outcome: "A", winning_outcome: "B" },
    { signal_result: "won", selected_outcome: "A", winning_outcome: "B" },
    { signal_result: "LOSS", selected_outcome: "A", winning_outcome: "B" },
    { signal_result: null, selected_outcome: "A", winning_outcome: null },
  ];

  const summary = auditResultFieldConsistency(rows);

  assert.deepEqual(summary, {
    totalRows: 5,
    resolvedSignalResultCount: 4,
    unresolvedSignalResultCount: 1,
    inferredOutcomeCount: 4,
    consistentResolvedCount: 3,
    resultOutcomeConflictCount: 1,
    legacyUppercaseResultCount: 1,
    hasBlockingViolations: true,
  });
});
