// Pure ROI/PnL math contract for local modeling rows (Phase 3E.1).
//
// This module defines math only. It does NOT decide whether a
// strategy/source/export is valid for ROI use -- export completeness,
// strict dedup, DQA-R4, and strategy selection gates are enforced
// elsewhere (later integration, Phase 3E.2) and are intentionally not
// referenced here.
//
// This module does NOT:
//   - read fs/env/DB/network
//   - use the system clock, a random source, or any other non-deterministic
//     input
//   - log raw row payloads (no console output of any kind)
//   - import the legacy mixed backtest module's outcome-normalization
//     helpers -- those contain a documented quirk (a win-labelled row
//     without a valid price or return silently becomes unresolved) that
//     must not leak into a figure presented as clean
//   - mutate any input row
//   - make any guaranteed-profit or marketing claim

export const ROI_STATE_READY = "READY" as const;
export const ROI_STATE_NO_VALID_BETS = "NO_VALID_BETS" as const;
export const ROI_STATE_BLOCKED_BY_INVALID_ROWS = "BLOCKED_BY_INVALID_ROWS" as const;

export type RoiState =
  | typeof ROI_STATE_READY
  | typeof ROI_STATE_NO_VALID_BETS
  | typeof ROI_STATE_BLOCKED_BY_INVALID_ROWS;

const WIN_LABELS = new Set(["win", "won", "hit", "correct", "yes"]);
const LOSS_LABELS = new Set(["loss", "lost", "miss", "incorrect", "no"]);

const UNRESOLVED_LABELS = new Set(["", "pending", "unresolved", "unknown", "open", "null", "undefined"]);

export type OutcomeLabel = "win" | "loss" | "unresolved" | "invalid";

export interface ClassifiedOutcome {
  label: OutcomeLabel;
  rawResult: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readResultLabel(row: unknown): string {
  if (!isPlainObject(row)) return "";
  const candidates = [row.signal_result, row.result, row.outcome_status];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim().toLowerCase();
    }
  }
  return "";
}

/**
 * Classifies a row's resolved outcome from its result-label fields
 * (signal_result / result / outcome_status), using the same win/loss
 * alias set already established in
 * lib/modeling/datasetAudit/outcomeResolutionConsistency.ts. Missing or
 * explicitly "pending"/"unknown"-style labels are "unresolved" (excluded
 * from ROI, not a loss). Any non-empty label that is neither a known win
 * nor loss alias nor a known unresolved marker is "invalid" (counted, not
 * silently coerced).
 */
export function classifyResolvedOutcome(row: unknown): ClassifiedOutcome {
  const rawResult = readResultLabel(row);

  if (WIN_LABELS.has(rawResult)) return { label: "win", rawResult };
  if (LOSS_LABELS.has(rawResult)) return { label: "loss", rawResult };
  if (UNRESOLVED_LABELS.has(rawResult)) return { label: "unresolved", rawResult };

  return { label: "invalid", rawResult };
}

function isValidEntryPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type ReturnPctSource = "realized_return_pct" | "derived_from_entry_price" | "loss_default";

export interface RowReturnResult {
  label: OutcomeLabel;
  returnPct: number | null;
  source: ReturnPctSource | null;
  invalidReason: "invalid_result_label" | "missing_return_and_entry_price" | null;
}

/**
 * Computes the return percentage for a single row, given its resolved
 * outcome classification. Precedence:
 *   1. realized_return_pct, if finite -- canonical.
 *   2. for a win row with no realized_return_pct but a valid entry price
 *      (finite, 0 < price <= 1), the binary payout return
 *      (1 / entry_price_num - 1) * 100.
 *   3. for a loss row with no realized_return_pct, -100.
 *   4. otherwise (win row missing both realized return and a valid entry
 *      price), the row is invalid for ROI -- returnPct is null with an
 *      explicit invalidReason. Nothing is silently coerced to a number.
 */
export function computeRowReturnPct(row: unknown): RowReturnResult {
  const classified = classifyResolvedOutcome(row);

  if (classified.label === "unresolved") {
    return { label: "unresolved", returnPct: null, source: null, invalidReason: null };
  }

  if (classified.label === "invalid") {
    return { label: "invalid", returnPct: null, source: null, invalidReason: "invalid_result_label" };
  }

  const rowRecord = isPlainObject(row) ? row : {};
  const realizedReturnPct = readFiniteNumber(rowRecord.realized_return_pct);

  if (realizedReturnPct !== null) {
    return { label: classified.label, returnPct: realizedReturnPct, source: "realized_return_pct", invalidReason: null };
  }

  if (classified.label === "win") {
    const entryPriceNum = rowRecord.entry_price_num;
    if (isValidEntryPrice(entryPriceNum)) {
      const pct = (1 / entryPriceNum - 1) * 100;
      return { label: "win", returnPct: pct, source: "derived_from_entry_price", invalidReason: null };
    }
    return { label: "win", returnPct: null, source: null, invalidReason: "missing_return_and_entry_price" };
  }

  // classified.label === "loss" with no realized_return_pct.
  return { label: "loss", returnPct: -100, source: "loss_default", invalidReason: null };
}

export interface ComputeFlatStakeRoiSummaryOptions {
  /** Flat stake per valid resolved bet, in abstract units. Default 1. */
  stakeUnits?: number;
  /**
   * Strict mode (default true): if any resolved row is invalid (invalid
   * result label, or a win row missing both realized return and a valid
   * entry price), the aggregate ROI is blocked (roiState =
   * BLOCKED_BY_INVALID_ROWS, roiPct/totalPnlUnits = null) even though the
   * per-row/audit counters are still reported.
   *
   * Non-strict mode excludes invalid rows from the aggregate math but
   * still reports how many were excluded via the audit counters -- it
   * never silently drops them from the summary.
   */
  strict?: boolean;
}

export interface FlatStakeRoiSummary {
  roiState: RoiState;
  inputRows: number;
  validBetCount: number;
  winCount: number;
  lossCount: number;
  rowsExcludedUnresolved: number;
  rowsInvalidMissingReturn: number;
  rowsInvalidEntryPrice: number;
  rowsInvalidResultLabel: number;
  rowsUsedRealizedReturnPct: number;
  rowsDerivedFromEntryPrice: number;
  stakeUnits: number;
  totalStakeUnits: number;
  totalPnlUnits: number | null;
  roiPct: number | null;
  averageReturnPct: number | null;
  winRatePct: number | null;
  lossRatePct: number | null;
}

/**
 * Computes a flat-stake ROI/PnL summary over `rows`. Pure math only -- does
 * not decide whether the input dataset is complete, deduplicated, or
 * otherwise fit for a real ROI claim (that gating happens outside this
 * module). Never mutates `rows`.
 */
export function computeFlatStakeRoiSummary(
  rows: unknown[],
  options: ComputeFlatStakeRoiSummaryOptions = {},
): FlatStakeRoiSummary {
  const stakeUnits = readFiniteNumber(options.stakeUnits) ?? 1;
  const strict = options.strict ?? true;

  let rowsExcludedUnresolved = 0;
  let rowsInvalidMissingReturn = 0;
  let rowsInvalidResultLabel = 0;
  let rowsUsedRealizedReturnPct = 0;
  let rowsDerivedFromEntryPrice = 0;
  let winCount = 0;
  let lossCount = 0;

  const validReturnPcts: number[] = [];

  for (const row of rows) {
    const computed = computeRowReturnPct(row);

    if (computed.label === "unresolved") {
      rowsExcludedUnresolved += 1;
      continue;
    }

    if (computed.label === "invalid") {
      rowsInvalidResultLabel += 1;
      continue;
    }

    if (computed.returnPct === null) {
      // win row missing both realized return and a valid entry price.
      rowsInvalidMissingReturn += 1;
      continue;
    }

    if (computed.source === "realized_return_pct") rowsUsedRealizedReturnPct += 1;
    if (computed.source === "derived_from_entry_price") rowsDerivedFromEntryPrice += 1;
    if (computed.label === "win") winCount += 1;
    if (computed.label === "loss") lossCount += 1;

    validReturnPcts.push(computed.returnPct);
  }

  // Counted separately for API completeness per the required audit
  // counters; this contract does not currently produce a
  // "valid label but structurally invalid entry price value present
  // alongside a usable realized_return_pct" case distinct from
  // rowsInvalidMissingReturn, so it stays 0 here by construction.
  const rowsInvalidEntryPrice = 0;

  const invalidRowCount = rowsInvalidResultLabel + rowsInvalidMissingReturn;
  const hasInvalidRows = invalidRowCount > 0;

  if (strict && hasInvalidRows) {
    return {
      roiState: ROI_STATE_BLOCKED_BY_INVALID_ROWS,
      inputRows: rows.length,
      validBetCount: validReturnPcts.length,
      winCount,
      lossCount,
      rowsExcludedUnresolved,
      rowsInvalidMissingReturn,
      rowsInvalidEntryPrice,
      rowsInvalidResultLabel,
      rowsUsedRealizedReturnPct,
      rowsDerivedFromEntryPrice,
      stakeUnits,
      totalStakeUnits: 0,
      totalPnlUnits: null,
      roiPct: null,
      averageReturnPct: null,
      winRatePct: null,
      lossRatePct: null,
    };
  }

  const validBetCount = validReturnPcts.length;

  if (validBetCount === 0) {
    return {
      roiState: ROI_STATE_NO_VALID_BETS,
      inputRows: rows.length,
      validBetCount: 0,
      winCount,
      lossCount,
      rowsExcludedUnresolved,
      rowsInvalidMissingReturn,
      rowsInvalidEntryPrice,
      rowsInvalidResultLabel,
      rowsUsedRealizedReturnPct,
      rowsDerivedFromEntryPrice,
      stakeUnits,
      totalStakeUnits: 0,
      totalPnlUnits: null,
      roiPct: null,
      averageReturnPct: null,
      winRatePct: null,
      lossRatePct: null,
    };
  }

  const totalStakeUnits = stakeUnits * validBetCount;
  const totalPnlUnits = validReturnPcts.reduce((sum, pct) => sum + (pct / 100) * stakeUnits, 0);
  const roiPct = (totalPnlUnits / totalStakeUnits) * 100;
  const averageReturnPct = validReturnPcts.reduce((sum, pct) => sum + pct, 0) / validBetCount;
  const winRatePct = (winCount / validBetCount) * 100;
  const lossRatePct = (lossCount / validBetCount) * 100;

  return {
    roiState: ROI_STATE_READY,
    inputRows: rows.length,
    validBetCount,
    winCount,
    lossCount,
    rowsExcludedUnresolved,
    rowsInvalidMissingReturn,
    rowsInvalidEntryPrice,
    rowsInvalidResultLabel,
    rowsUsedRealizedReturnPct,
    rowsDerivedFromEntryPrice,
    stakeUnits,
    totalStakeUnits,
    totalPnlUnits,
    roiPct,
    averageReturnPct,
    winRatePct,
    lossRatePct,
  };
}
