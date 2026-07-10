// Pure, side-effect-free read-only strategy comparison layer (Phase 3D.2H).
//
// Runs evaluateStrategyDeclaration() from ./strategyEvaluator across a set
// of caller-supplied strategy declarations against caller-supplied,
// already-loaded in-memory rows. This module does NOT:
//   - read the filesystem
//   - read process.env
//   - read the database
//   - compute ROI/PnL/stake math
//   - log anything (no console)
//   - mutate input rows or declarations
//
// Refused/blocked declarations (non-READY_TO_NORMALIZE status, or a
// one-event declaration missing a comparator) are caught and reported as a
// per-strategy `error` string -- they are never executed, and a refusal for
// one strategy never aborts the comparison of the others.

import {
  evaluateStrategyDeclaration,
  type DeclarationStatus,
  type EvaluatorRow,
  type StrategyDeclaration,
} from "./strategyEvaluator";

export interface StrategyComparisonSummary {
  strategyId: string;
  status: DeclarationStatus;
  requiredForComparison: boolean;
  inputRows: number;
  selectedRows: number;
  rejectedByFilter: Record<string, number>;
  error: string | null;
}

export interface StrategyComparisonResult {
  totalInputRows: number;
  selectedStrategyCount: number;
  strategies: StrategyComparisonSummary[];
}

export interface StrategyComparisonOptions<T extends EvaluatorRow> {
  /** When true (default), only declarations with requiredForComparison === true are run. */
  requiredOnly?: boolean;
  /** If provided, only declarations whose strategyId is in this list are run (overrides requiredOnly). */
  strategyIds?: string[];
  /** Caller-supplied ranking comparator, forwarded to declarations that need one-event selection. */
  compareRows?: (a: T, b: T) => number;
}

/**
 * Returns only the declarations explicitly flagged requiredForComparison.
 */
export function getRequiredForComparisonDeclarations(
  declarations: readonly StrategyDeclaration[],
): StrategyDeclaration[] {
  return declarations.filter((declaration) => declaration.requiredForComparison === true);
}

function selectDeclarations(
  declarations: readonly StrategyDeclaration[],
  options: StrategyComparisonOptions<EvaluatorRow> | undefined,
): StrategyDeclaration[] {
  if (options?.strategyIds && options.strategyIds.length > 0) {
    const wanted = new Set(options.strategyIds);
    return declarations.filter((declaration) => wanted.has(declaration.strategyId));
  }
  const requiredOnly = options?.requiredOnly ?? true;
  if (requiredOnly) {
    return getRequiredForComparisonDeclarations(declarations);
  }
  return [...declarations];
}

export interface StrategyComparisonWithSelectedRowsResult<T extends EvaluatorRow> {
  result: StrategyComparisonResult;
  /**
   * Selected row objects per strategyId, for internal callers that need the
   * actual rows (e.g. the CLI's gated ROI computation). This is deliberately
   * kept out of the public StrategyComparisonResult so the default JSON
   * output never carries raw row payloads. Only strategies that evaluated
   * without error have an entry here.
   */
  selectedRowsByStrategyId: Record<string, T[]>;
}

/**
 * Core comparison: runs every selected strategy declaration against `rows`
 * and returns both the per-strategy summary and the selected row objects
 * per strategyId. A declaration that refuses to run (non-READY status, or
 * one-event selection missing a comparator) is reported with a safe error
 * message (strategyId + status only, never row data) instead of throwing.
 *
 * The selected rows are for internal use only (see field docs) -- callers
 * that just want the JSON-safe summary should use runStrategyComparison.
 */
export function runStrategyComparisonWithSelectedRows<T extends EvaluatorRow>(
  rows: readonly T[],
  declarations: readonly StrategyDeclaration[],
  options?: StrategyComparisonOptions<T>,
): StrategyComparisonWithSelectedRowsResult<T> {
  const selected = selectDeclarations(declarations, options as StrategyComparisonOptions<EvaluatorRow> | undefined);
  const selectedRowsByStrategyId: Record<string, T[]> = {};

  const strategies: StrategyComparisonSummary[] = selected.map((declaration) => {
    const requiredForComparison = declaration.requiredForComparison === true;
    try {
      const evaluation = evaluateStrategyDeclaration(rows, declaration, {
        compareRows: options?.compareRows,
      });
      selectedRowsByStrategyId[declaration.strategyId] = evaluation.selectedRows;
      return {
        strategyId: declaration.strategyId,
        status: declaration.status,
        requiredForComparison,
        inputRows: evaluation.diagnostics.totalInputRows,
        selectedRows: evaluation.diagnostics.selectedRows,
        rejectedByFilter: evaluation.diagnostics.rejectedByFilter,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown evaluation error";
      return {
        strategyId: declaration.strategyId,
        status: declaration.status,
        requiredForComparison,
        inputRows: rows.length,
        selectedRows: 0,
        rejectedByFilter: {},
        error: message,
      };
    }
  });

  return {
    result: {
      totalInputRows: rows.length,
      selectedStrategyCount: strategies.length,
      strategies,
    },
    selectedRowsByStrategyId,
  };
}

/**
 * Runs every selected strategy declaration against `rows` and returns a
 * per-strategy comparison summary. By default only declarations flagged
 * requiredForComparison === true are run (currently
 * FORMULA_TRUSTED_INITIAL_V1_1_ALL). A declaration that refuses to run
 * (non-READY status, or one-event selection missing a comparator) is
 * reported with a safe error message (strategyId + status only, never row
 * data) instead of throwing out of this function.
 *
 * This is the public, JSON-safe entrypoint: it returns only counts, never
 * row payloads.
 */
export function runStrategyComparison<T extends EvaluatorRow>(
  rows: readonly T[],
  declarations: readonly StrategyDeclaration[],
  options?: StrategyComparisonOptions<T>,
): StrategyComparisonResult {
  return runStrategyComparisonWithSelectedRows(rows, declarations, options).result;
}
