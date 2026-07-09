// DQA-R2: pure, DB-independent audit of return/PnL formula consistency
// across a dataset of signal rows. Recomputes the canonical win/loss return
// formula and compares it against realized_return_pct.

export type ReturnFormulaAuditRow = {
  signal_result?: unknown;
  entry_price_num?: unknown;
  realized_return_pct?: unknown;
};

export type ReturnFormulaConsistencySummary = {
  totalRows: number;
  resolvedRows: number;
  validReconciledCount: number;
  recomputeMismatchCount: number;
  missingRealizedReturnCount: number;
  invalidEntryPriceCount: number;
  signReturnConflictCount: number;
  unresolvedExcludedCount: number;
  hasBlockingViolations: boolean;
};

type Label = "win" | "loss" | "unresolved";

const WIN_LABELS = new Set(["won", "win", "hit", "resolved_win", "success"]);
const LOSS_LABELS = new Set(["lost", "loss", "miss", "resolved_loss", "failed"]);

const TOLERANCE_PCT = 0.5;

function classifyLabel(raw: unknown): Label {
  if (typeof raw !== "string") return "unresolved";
  const lower = raw.toLowerCase();
  if (WIN_LABELS.has(lower)) return "win";
  if (LOSS_LABELS.has(lower)) return "loss";
  return "unresolved";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidEntryPrice(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0 && value < 1;
}

export function auditReturnFormulaConsistency(
  rows: ReturnFormulaAuditRow[],
): ReturnFormulaConsistencySummary {
  let resolvedRows = 0;
  let validReconciledCount = 0;
  let recomputeMismatchCount = 0;
  let missingRealizedReturnCount = 0;
  let invalidEntryPriceCount = 0;
  let signReturnConflictCount = 0;
  let unresolvedExcludedCount = 0;

  for (const row of rows) {
    const label = classifyLabel(row.signal_result);

    if (label === "unresolved") {
      unresolvedExcludedCount++;
      continue;
    }

    resolvedRows++;

    if (!isFiniteNumber(row.realized_return_pct)) {
      missingRealizedReturnCount++;
      continue;
    }
    const actual = row.realized_return_pct;

    if (!isValidEntryPrice(row.entry_price_num)) {
      invalidEntryPriceCount++;
      continue;
    }
    const price = row.entry_price_num;

    const expected = label === "win" ? ((1 - price) / price) * 100 : -100;
    const expectedSign = expected >= 0 ? 1 : -1;
    const actualSign = actual > 0 ? 1 : actual < 0 ? -1 : 0;

    if (actualSign !== 0 && actualSign !== expectedSign) {
      signReturnConflictCount++;
      continue;
    }

    if (Math.abs(actual - expected) > TOLERANCE_PCT) {
      recomputeMismatchCount++;
    } else {
      validReconciledCount++;
    }
  }

  return {
    totalRows: rows.length,
    resolvedRows,
    validReconciledCount,
    recomputeMismatchCount,
    missingRealizedReturnCount,
    invalidEntryPriceCount,
    signReturnConflictCount,
    unresolvedExcludedCount,
    hasBlockingViolations:
      recomputeMismatchCount > 0 || invalidEntryPriceCount > 0 || signReturnConflictCount > 0,
  };
}
