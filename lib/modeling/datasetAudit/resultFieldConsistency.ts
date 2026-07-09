export type SignalResultAuditRow = {
  signal_result?: unknown;
};

export type SignalResultConsistencySummary = {
  totalRows: number;
  validCanonicalCount: number;
  nullUnresolvedCount: number;
  casingViolationCount: number;
  unsupportedValueCount: number;
  missingFieldCount: number;
  hasBlockingViolations: boolean;
};

const CASING_SYNONYMS: Record<string, "won" | "lost"> = {
  win: "won",
  WIN: "won",
  Win: "won",
  Won: "won",
  WON: "won",
  loss: "lost",
  LOSS: "lost",
  Loss: "lost",
  Lost: "lost",
  LOST: "lost",
};

export function auditResultFieldConsistency(
  rows: SignalResultAuditRow[]
): SignalResultConsistencySummary {
  let validCanonicalCount = 0;
  let nullUnresolvedCount = 0;
  let casingViolationCount = 0;
  let unsupportedValueCount = 0;
  let missingFieldCount = 0;

  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(row, "signal_result")) {
      missingFieldCount += 1;
      continue;
    }

    const value = row.signal_result;

    if (value === null) {
      nullUnresolvedCount += 1;
      continue;
    }

    if (value === "won" || value === "lost") {
      validCanonicalCount += 1;
      continue;
    }

    if (typeof value === "string" && CASING_SYNONYMS[value]) {
      casingViolationCount += 1;
      continue;
    }

    unsupportedValueCount += 1;
  }

  return {
    totalRows: rows.length,
    validCanonicalCount,
    nullUnresolvedCount,
    casingViolationCount,
    unsupportedValueCount,
    missingFieldCount,
    hasBlockingViolations:
      casingViolationCount > 0 || unsupportedValueCount > 0 || missingFieldCount > 0,
  };
}
