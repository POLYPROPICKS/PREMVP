import test from "node:test";
import assert from "node:assert/strict";
import { auditDateModeConsistency } from "../../lib/modeling/datasetAudit/dateModeConsistency";

test("audits created_at vs resolved_at window membership consistency", () => {
  const start = Date.parse("2026-07-01T00:00:00.000Z");
  const end = Date.parse("2026-07-08T00:00:00.000Z");
  const inWin = "2026-07-03T00:00:00.000Z";
  const beforeWin = "2026-06-30T00:00:00.000Z";
  const afterWin = "2026-07-09T00:00:00.000Z";

  const rows = [
    { created_at: inWin, resolved_at: inWin },
    { created_at: inWin, resolved_at: afterWin },
    { created_at: beforeWin, resolved_at: inWin },
    { created_at: inWin, resolved_at: null },
    { resolved_at: inWin },
    { created_at: "not-a-date", resolved_at: inWin },
    { created_at: inWin, resolved_at: "bad" },
    { created_at: null, resolved_at: null },
  ];

  const summary = auditDateModeConsistency(rows, start, end);

  assert.deepEqual(summary, {
    totalRows: 8,
    createdInWindowCount: 4,
    resolvedInWindowCount: 4,
    bothInWindowCount: 1,
    windowMembershipDivergesCount: 5,
    missingCreatedAtCount: 2,
    missingResolvedAtCount: 2,
    invalidCreatedAtCount: 1,
    invalidResolvedAtCount: 1,
    hasBlockingViolations: true,
  });
});
