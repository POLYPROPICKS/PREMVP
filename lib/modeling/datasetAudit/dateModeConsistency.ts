// DQA-R3: pure, DB-independent audit of date-mode consistency across a
// dataset of signal rows. Compares created_at vs resolved_at window
// membership for a caller-supplied [windowStartMs, windowEndMs) range.
// No Date.now() is used internally -- the window boundaries are inputs.

export type DateModeAuditRow = {
  created_at?: unknown;
  resolved_at?: unknown;
};

export type DateModeConsistencySummary = {
  totalRows: number;
  createdInWindowCount: number;
  resolvedInWindowCount: number;
  bothInWindowCount: number;
  windowMembershipDivergesCount: number;
  missingCreatedAtCount: number;
  missingResolvedAtCount: number;
  invalidCreatedAtCount: number;
  invalidResolvedAtCount: number;
  hasBlockingViolations: boolean;
};

function isMissing(value: unknown): boolean {
  return value === null || value === undefined;
}

function parseMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function auditDateModeConsistency(
  rows: DateModeAuditRow[],
  windowStartMs: number,
  windowEndMs: number,
): DateModeConsistencySummary {
  let createdInWindowCount = 0;
  let resolvedInWindowCount = 0;
  let bothInWindowCount = 0;
  let windowMembershipDivergesCount = 0;
  let missingCreatedAtCount = 0;
  let missingResolvedAtCount = 0;
  let invalidCreatedAtCount = 0;
  let invalidResolvedAtCount = 0;

  for (const row of rows) {
    const createdMissing = isMissing(row.created_at);
    const resolvedMissing = isMissing(row.resolved_at);

    if (createdMissing) missingCreatedAtCount++;
    if (resolvedMissing) missingResolvedAtCount++;

    const createdMs = createdMissing ? null : parseMs(row.created_at);
    const resolvedMs = resolvedMissing ? null : parseMs(row.resolved_at);

    if (!createdMissing && createdMs === null) invalidCreatedAtCount++;
    if (!resolvedMissing && resolvedMs === null) invalidResolvedAtCount++;

    const createdInWindow =
      createdMs !== null && createdMs >= windowStartMs && createdMs < windowEndMs;
    const resolvedInWindow =
      resolvedMs !== null && resolvedMs >= windowStartMs && resolvedMs < windowEndMs;

    if (createdInWindow) createdInWindowCount++;
    if (resolvedInWindow) resolvedInWindowCount++;
    if (createdInWindow && resolvedInWindow) bothInWindowCount++;

    // created_at is the anchor field: if it is missing entirely, membership
    // divergence cannot be meaningfully assessed, so the row is excluded
    // from this count (it is still captured via missingCreatedAtCount).
    if (!createdMissing && createdInWindow !== resolvedInWindow) {
      windowMembershipDivergesCount++;
    }
  }

  const hasBlockingViolations =
    windowMembershipDivergesCount > 0 ||
    invalidCreatedAtCount > 0 ||
    invalidResolvedAtCount > 0 ||
    missingCreatedAtCount > 0 ||
    missingResolvedAtCount > 0;

  return {
    totalRows: rows.length,
    createdInWindowCount,
    resolvedInWindowCount,
    bothInWindowCount,
    windowMembershipDivergesCount,
    missingCreatedAtCount,
    missingResolvedAtCount,
    invalidCreatedAtCount,
    invalidResolvedAtCount,
    hasBlockingViolations,
  };
}
