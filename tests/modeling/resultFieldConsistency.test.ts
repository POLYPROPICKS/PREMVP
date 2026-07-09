import test from "node:test";
import assert from "node:assert/strict";
import { auditResultFieldConsistency } from "../../lib/modeling/datasetAudit/resultFieldConsistency";

test("auditResultFieldConsistency classifies casing/domain violations against canonical won/lost domain", () => {
  const rows = [
    { signal_result: "won" },
    { signal_result: "lost" },
    { signal_result: null },
    { signal_result: "WIN" },
    { signal_result: "LOSS" },
    { signal_result: "push" },
    { signal_result: "" },
    {},
  ];

  const summary = auditResultFieldConsistency(rows);

  assert.deepEqual(summary, {
    totalRows: 8,
    validCanonicalCount: 2,
    nullUnresolvedCount: 1,
    casingViolationCount: 2,
    unsupportedValueCount: 2,
    missingFieldCount: 1,
    hasBlockingViolations: true,
  });
});
