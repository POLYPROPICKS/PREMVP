// DQA-R4: pure, DB-independent audit of outcome-resolution consistency
// across a dataset of signal rows. This audits (does NOT fix) the known
// outcome() resolution quirk in lib/modeling/onePerMatchBacktest.ts: a
// win-labelled row with neither a valid entry price nor a valid realized
// return silently resolves to `won: null` (unresolved) under that
// function's current logic, rather than keeping its known "won" result.
// This module only detects and counts that risk -- it never patches
// onePerMatchBacktest.ts or computes any ROI/PnL.

export type OutcomeResolutionAuditRow = {
  signal_result?: unknown;
  result?: unknown;
  outcome_status?: unknown;
  entry_price_num?: unknown;
  entryPrice?: unknown;
  entry_price?: unknown;
  realized_return_pct?: unknown;
  realizedReturnPct?: unknown;
};

export type OutcomeResolutionAuditSummary = {
  totalRows: number;
  winLabelRows: number;
  lossLabelRows: number;
  unresolvedOrUnknownRows: number;
  winWithValidEntryPriceCount: number;
  winWithRealizedReturnCount: number;
  winWithoutPriceOrReturnCount: number;
  lossWithoutEntryPriceCount: number;
  rowsMissingResultLabelCount: number;
  hasBlockingViolations: boolean;
};

type Label = "win" | "loss" | "unresolved";

const WIN_LABELS = new Set(["win", "won", "hit", "correct", "yes"]);
const LOSS_LABELS = new Set(["loss", "lost", "miss", "incorrect", "no"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function classifyLabel(row: OutcomeResolutionAuditRow): { label: Label; hasResultField: boolean } {
  const raw = str(row.signal_result) || str(row.result) || str(row.outcome_status);
  if (!raw) return { label: "unresolved", hasResultField: false };
  const lower = raw.toLowerCase();
  if (WIN_LABELS.has(lower)) return { label: "win", hasResultField: true };
  if (LOSS_LABELS.has(lower)) return { label: "loss", hasResultField: true };
  return { label: "unresolved", hasResultField: true };
}

function isValidEntryPrice(row: OutcomeResolutionAuditRow): boolean {
  for (const value of [row.entry_price_num, row.entryPrice, row.entry_price]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return true;
  }
  return false;
}

function hasValidRealizedReturn(row: OutcomeResolutionAuditRow): boolean {
  for (const value of [row.realized_return_pct, row.realizedReturnPct]) {
    if (typeof value === "number" && Number.isFinite(value)) return true;
  }
  return false;
}

export function auditOutcomeResolutionConsistency(
  rows: OutcomeResolutionAuditRow[],
): OutcomeResolutionAuditSummary {
  let winLabelRows = 0;
  let lossLabelRows = 0;
  let unresolvedOrUnknownRows = 0;
  let winWithValidEntryPriceCount = 0;
  let winWithRealizedReturnCount = 0;
  let winWithoutPriceOrReturnCount = 0;
  let lossWithoutEntryPriceCount = 0;
  let rowsMissingResultLabelCount = 0;

  for (const row of rows) {
    const { label, hasResultField } = classifyLabel(row);
    if (!hasResultField) rowsMissingResultLabelCount++;

    if (label === "win") {
      winLabelRows++;
      const validPrice = isValidEntryPrice(row);
      const validReturn = hasValidRealizedReturn(row);
      if (validPrice) winWithValidEntryPriceCount++;
      if (validReturn) winWithRealizedReturnCount++;
      if (!validPrice && !validReturn) winWithoutPriceOrReturnCount++;
    } else if (label === "loss") {
      lossLabelRows++;
      if (!isValidEntryPrice(row)) lossWithoutEntryPriceCount++;
    } else {
      unresolvedOrUnknownRows++;
    }
  }

  return {
    totalRows: rows.length,
    winLabelRows,
    lossLabelRows,
    unresolvedOrUnknownRows,
    winWithValidEntryPriceCount,
    winWithRealizedReturnCount,
    winWithoutPriceOrReturnCount,
    lossWithoutEntryPriceCount,
    rowsMissingResultLabelCount,
    hasBlockingViolations: winWithoutPriceOrReturnCount > 0,
  };
}
