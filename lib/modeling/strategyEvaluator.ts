// Pure, side-effect-free strategy declaration evaluator (Phase 3D.2E).
//
// Evaluates a line-verified strategy declaration (see
// scripts/modeling/strategies/strategy_declarations.schema.json and
// scripts/modeling/strategies/declarations/*.json) against an
// already-loaded, in-memory set of rows. This module does NOT:
//   - read the database (no Supabase import)
//   - read the filesystem
//   - read process.env
//   - compute ROI/PnL/stake math
//   - invent a default score/coverage ranking comparator
//   - mutate input rows or the declaration object
//
// One-event/one-match/one-fixture selection is delegated entirely to the
// existing pure helper in ./eventGroupSelection -- this module does not
// reimplement dedup-key logic.

import { selectFirstPerEventGroup, type EventGroupRow } from "./eventGroupSelection";

export type DeclarationStatus =
  | "READY_TO_NORMALIZE"
  | "BLOCKED_SOURCE_CONFLICT"
  | "MISSING_SCRIPT"
  | "CONTRACT_STUB"
  | "DOC_ONLY"
  | "UNKNOWN";

export type SelectionUnit =
  | "all rows"
  | "one per event"
  | "one per match"
  | "one per fixture"
  | "unknown";

export interface PriceBucket {
  coverageMin: number;
  coverageMax: number;
  priceMin: number;
  priceMax: number;
}

export interface StrategyFilters {
  scoreThreshold?: number | null;
  coverageThreshold?: number | null;
  avoidLeagues?: string[] | null;
  coverageCap?: { excludedBucket: PriceBucket } | null;
  timingWindow?: { excludedHoursUntilStart: { min: number; max: number } } | null;
  priceBucketExclusions?: PriceBucket[] | null;
  [key: string]: unknown;
}

export interface StrategyDeclaration {
  strategyId: string;
  status: DeclarationStatus;
  selectionUnit: SelectionUnit;
  canonicalDedupKey: string | null;
  filters: StrategyFilters;
  [key: string]: unknown;
}

export type EvaluatorRow = EventGroupRow;

export interface EvaluationDiagnostics {
  totalInputRows: number;
  passedFilterRows: number;
  selectedRows: number;
  rejectedByFilter: Record<string, number>;
  missingTimingField: number;
}

export interface EvaluationResult<T extends EvaluatorRow> {
  selectedRows: T[];
  diagnostics: EvaluationDiagnostics;
}

const ONE_EVENT_SELECTION_UNITS: readonly SelectionUnit[] = [
  "one per event",
  "one per match",
  "one per fixture",
];

const READY_STATUS: DeclarationStatus = "READY_TO_NORMALIZE";

/**
 * Throws unless the declaration's status is READY_TO_NORMALIZE. The error
 * message includes only strategyId and status -- never row data.
 */
export function assertReadyDeclaration(declaration: StrategyDeclaration): void {
  if (declaration.status !== READY_STATUS) {
    throw new Error(
      `Strategy ${declaration.strategyId} is not READY_TO_NORMALIZE (status: ${declaration.status})`,
    );
  }
}

function getNumericField(row: EvaluatorRow, aliases: readonly string[]): number | null {
  for (const key of aliases) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function getStringField(row: EvaluatorRow, aliases: readonly string[]): string | null {
  for (const key of aliases) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

const SCORE_FIELD_ALIASES = ["score", "signal_score"] as const;
const COVERAGE_FIELD_ALIASES = ["coverage", "coverage_score"] as const;
const PRICE_FIELD_ALIASES = ["entryPrice", "entry_price", "entry_price_num"] as const;
const LEAGUE_FIELD_ALIASES = ["league", "sport", "sport_key", "event_league"] as const;
const HOURS_UNTIL_START_FIELD_ALIASES = ["hoursUntilStart", "hours_until_start"] as const;

function insideBucket(coverage: number, price: number, bucket: PriceBucket): boolean {
  return (
    coverage >= bucket.coverageMin &&
    coverage <= bucket.coverageMax &&
    price >= bucket.priceMin &&
    price <= bucket.priceMax
  );
}

type FilterCheckResult = "pass" | "reject" | "missing-timing-field";

function checkScoreThreshold(row: EvaluatorRow, threshold: number): FilterCheckResult {
  const score = getNumericField(row, SCORE_FIELD_ALIASES);
  if (score === null) return "reject";
  return score >= threshold ? "pass" : "reject";
}

function checkCoverageThreshold(row: EvaluatorRow, threshold: number): FilterCheckResult {
  const coverage = getNumericField(row, COVERAGE_FIELD_ALIASES);
  if (coverage === null) return "reject";
  return coverage >= threshold ? "pass" : "reject";
}

function checkAvoidLeagues(row: EvaluatorRow, avoidLeagues: readonly string[]): FilterCheckResult {
  const league = getStringField(row, LEAGUE_FIELD_ALIASES);
  if (league === null) return "pass";
  const normalizedAvoid = avoidLeagues.map((l) => l.toLowerCase());
  return normalizedAvoid.includes(league.toLowerCase()) ? "reject" : "pass";
}

function checkCoverageCap(row: EvaluatorRow, bucket: PriceBucket): FilterCheckResult {
  const coverage = getNumericField(row, COVERAGE_FIELD_ALIASES);
  const price = getNumericField(row, PRICE_FIELD_ALIASES);
  if (coverage === null || price === null) return "pass";
  return insideBucket(coverage, price, bucket) ? "reject" : "pass";
}

function checkPriceBucketExclusions(row: EvaluatorRow, buckets: readonly PriceBucket[]): FilterCheckResult {
  const coverage = getNumericField(row, COVERAGE_FIELD_ALIASES);
  const price = getNumericField(row, PRICE_FIELD_ALIASES);
  if (coverage === null || price === null) return "pass";
  return buckets.some((bucket) => insideBucket(coverage, price, bucket)) ? "reject" : "pass";
}

function checkTimingWindow(
  row: EvaluatorRow,
  window: { min: number; max: number },
): FilterCheckResult {
  const hours = getNumericField(row, HOURS_UNTIL_START_FIELD_ALIASES);
  if (hours === null) return "missing-timing-field";
  return hours >= window.min && hours < window.max ? "reject" : "pass";
}

/**
 * Checks a single row against every populated filter in `filters`. Returns
 * true only if the row passes all active filters. Pure, no mutation.
 */
export function isRowSelectedByFilters(row: EvaluatorRow, filters: StrategyFilters): boolean {
  if (typeof filters.scoreThreshold === "number") {
    if (checkScoreThreshold(row, filters.scoreThreshold) !== "pass") return false;
  }
  if (typeof filters.coverageThreshold === "number") {
    if (checkCoverageThreshold(row, filters.coverageThreshold) !== "pass") return false;
  }
  if (Array.isArray(filters.avoidLeagues) && filters.avoidLeagues.length > 0) {
    if (checkAvoidLeagues(row, filters.avoidLeagues) !== "pass") return false;
  }
  if (filters.coverageCap && filters.coverageCap.excludedBucket) {
    if (checkCoverageCap(row, filters.coverageCap.excludedBucket) !== "pass") return false;
  }
  if (Array.isArray(filters.priceBucketExclusions) && filters.priceBucketExclusions.length > 0) {
    if (checkPriceBucketExclusions(row, filters.priceBucketExclusions) !== "pass") return false;
  }
  if (filters.timingWindow && filters.timingWindow.excludedHoursUntilStart) {
    const timingResult = checkTimingWindow(row, filters.timingWindow.excludedHoursUntilStart);
    if (timingResult === "reject") return false;
  }
  return true;
}

/**
 * Applies every populated filter in `filters` to all rows. Returns the
 * rows that pass every filter, plus a per-filter rejection count and a
 * separate missingTimingField count (rows lacking hoursUntilStart are not
 * silently rejected by the timing filter). Input rows are never mutated.
 */
export function applyStrategyFilters<T extends EvaluatorRow>(
  rows: readonly T[],
  filters: StrategyFilters,
): { passed: T[]; rejectedByFilter: Record<string, number>; missingTimingField: number } {
  const rejectedByFilter: Record<string, number> = {};
  let missingTimingField = 0;
  const passed: T[] = [];

  const hasScoreThreshold = typeof filters.scoreThreshold === "number";
  const hasCoverageThreshold = typeof filters.coverageThreshold === "number";
  const hasAvoidLeagues = Array.isArray(filters.avoidLeagues) && filters.avoidLeagues.length > 0;
  const hasCoverageCap = Boolean(filters.coverageCap && filters.coverageCap.excludedBucket);
  const hasPriceBucketExclusions =
    Array.isArray(filters.priceBucketExclusions) && filters.priceBucketExclusions.length > 0;
  const hasTimingWindow = Boolean(filters.timingWindow && filters.timingWindow.excludedHoursUntilStart);

  for (const row of rows) {
    let rowPasses = true;

    if (hasScoreThreshold) {
      const outcome = checkScoreThreshold(row, filters.scoreThreshold as number);
      if (outcome !== "pass") {
        rejectedByFilter.scoreThreshold = (rejectedByFilter.scoreThreshold ?? 0) + 1;
        rowPasses = false;
      }
    }

    if (hasCoverageThreshold) {
      const outcome = checkCoverageThreshold(row, filters.coverageThreshold as number);
      if (outcome !== "pass") {
        rejectedByFilter.coverageThreshold = (rejectedByFilter.coverageThreshold ?? 0) + 1;
        rowPasses = false;
      }
    }

    if (hasAvoidLeagues) {
      const outcome = checkAvoidLeagues(row, filters.avoidLeagues as string[]);
      if (outcome !== "pass") {
        rejectedByFilter.avoidLeagues = (rejectedByFilter.avoidLeagues ?? 0) + 1;
        rowPasses = false;
      }
    }

    if (hasCoverageCap) {
      const outcome = checkCoverageCap(row, (filters.coverageCap as { excludedBucket: PriceBucket }).excludedBucket);
      if (outcome !== "pass") {
        rejectedByFilter.coverageCap = (rejectedByFilter.coverageCap ?? 0) + 1;
        rowPasses = false;
      }
    }

    if (hasPriceBucketExclusions) {
      const outcome = checkPriceBucketExclusions(row, filters.priceBucketExclusions as PriceBucket[]);
      if (outcome !== "pass") {
        rejectedByFilter.priceBucketExclusions = (rejectedByFilter.priceBucketExclusions ?? 0) + 1;
        rowPasses = false;
      }
    }

    if (hasTimingWindow) {
      const outcome = checkTimingWindow(
        row,
        (filters.timingWindow as { excludedHoursUntilStart: { min: number; max: number } })
          .excludedHoursUntilStart,
      );
      if (outcome === "reject") {
        rejectedByFilter.timingWindow = (rejectedByFilter.timingWindow ?? 0) + 1;
        rowPasses = false;
      } else if (outcome === "missing-timing-field") {
        missingTimingField += 1;
      }
    }

    if (rowPasses) passed.push(row);
  }

  return { passed, rejectedByFilter, missingTimingField };
}

/**
 * If the declaration's selectionUnit requires one-event/one-match/one-fixture
 * selection, delegates to selectFirstPerEventGroup with the caller-supplied
 * comparator. Throws if such selection is required but no comparator was
 * given -- this module never invents a default ranking. If selectionUnit
 * does not require grouping, returns the rows unchanged.
 */
export function selectOnePerEventIfRequired<T extends EvaluatorRow>(
  rows: readonly T[],
  declaration: StrategyDeclaration,
  compareRows?: (a: T, b: T) => number,
): T[] {
  if (!ONE_EVENT_SELECTION_UNITS.includes(declaration.selectionUnit)) {
    return [...rows];
  }
  if (!compareRows) {
    throw new Error(
      `Strategy ${declaration.strategyId} requires selectionUnit "${declaration.selectionUnit}" but no compareRows comparator was provided`,
    );
  }
  return selectFirstPerEventGroup(rows, compareRows);
}

/**
 * Main entrypoint: validates the declaration is READY_TO_NORMALIZE, applies
 * its line-verified filters, then applies one-event selection if required.
 * Pure, no I/O, no ROI/PnL computation, no mutation of rows or declaration.
 */
export function evaluateStrategyDeclaration<T extends EvaluatorRow>(
  rows: readonly T[],
  declaration: StrategyDeclaration,
  options?: { compareRows?: (a: T, b: T) => number },
): EvaluationResult<T> {
  assertReadyDeclaration(declaration);

  const { passed, rejectedByFilter, missingTimingField } = applyStrategyFilters(rows, declaration.filters);
  const selected = selectOnePerEventIfRequired(passed, declaration, options?.compareRows);

  return {
    selectedRows: selected,
    diagnostics: {
      totalInputRows: rows.length,
      passedFilterRows: passed.length,
      selectedRows: selected.length,
      rejectedByFilter,
      missingTimingField,
    },
  };
}
