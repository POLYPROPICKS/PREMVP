// Pure, side-effect-free local export contract for generated_signal_pairs
// rows (Phase 3D.2I).
//
// This module validates the SHAPE of a local JSON row export -- it does
// NOT read the database, does NOT read process.env, does NOT compute
// ROI/PnL/stake math, and does NOT fix or normalize any row. It only
// surfaces structural diagnostics: which strategy-relevant fields are
// present, and whether the known outcome() resolution quirk in
// lib/modeling/onePerMatchBacktest.ts (a "won" row silently losing its
// result when neither entry_price_num nor realized_return_pct is present)
// is a risk for the given export. The quirk itself is not fixed here.

export type ExportRow = Record<string, unknown>;

export interface GeneratedSignalPairsExportDiagnostics {
  totalRows: number;
  rowsWithFormulaVersion: number;
  rowsMissingFormulaVersion: number;
  rowsWithScore: number;
  rowsWithCoverage: number;
  rowsWithEventGroupCandidate: number;
  outcomeQuirkRiskRows: number;
  uniqueStrictDedupKeys: number;
  duplicateStrictKeyRows: number;
  rowsMissingStrictDedupKey: number;
  hasDuplicateStrictKeyRisk: boolean;
  notes: string[];
}

function getString(row: ExportRow, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function hasAnyField(row: ExportRow, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const value = row[key];
    return value !== undefined && value !== null && value !== "";
  });
}

function isValidNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number(value));
  }
  return false;
}

const FORMULA_VERSION_TOP_FIELDS = [
  "formula_version",
  "metric_formula_version",
  "formulaVersion",
  "metricFormulaVersion",
] as const;

const FORMULA_VERSION_DIAGNOSTICS_KEYS = [
  "formulaVersion",
  "formula_version",
  "metricFormulaVersion",
] as const;

const SCORE_FIELDS = ["score", "signal_score", "signalScore", "pre_event_score_num"] as const;

const COVERAGE_FIELDS = ["coverage", "coverage_score", "coverageScore"] as const;

const EVENT_GROUP_CANDIDATE_FIELDS = [
  "match_family_key",
  "matchFamilyKey",
  "canonical_event_key",
  "canonicalEventKey",
  "parent_event_key",
  "parentEventKey",
  "event_slug",
  "eventSlug",
  "event_title",
  "eventTitle",
  "market_slug",
  "marketSlug",
  "condition_id",
  "conditionId",
] as const;

const OUTCOME_RESULT_FIELDS = ["signal_result", "result", "outcome_status"] as const;

const WIN_LABELS = new Set(["win", "won", "hit", "correct", "yes"]);

const ENTRY_PRICE_FIELDS = ["entry_price_num", "entryPrice", "entry_price"] as const;

const REALIZED_RETURN_FIELDS = ["realized_return_pct", "realizedReturnPct"] as const;

const CONDITION_ID_FIELDS = ["condition_id", "conditionId"] as const;

const TOKEN_ID_FIELDS = ["token_id", "tokenId"] as const;

function getIdentityField(row: ExportRow, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const trimmed = String(value).trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/**
 * Computes the strict dedup key (condition_id + token_id) used by
 * lib/modeling/onePerMatchBacktest.ts's strictKey() to collapse duplicate
 * rows for the same signal. Returns null if either identity field is
 * missing or blank after String(...).trim(). The returned key is an
 * internal format only (never exposes the raw row payload).
 */
export function getStrictDedupKeyForExportRow(row: ExportRow): string | null {
  const condition = getIdentityField(row, CONDITION_ID_FIELDS);
  const token = getIdentityField(row, TOKEN_ID_FIELDS);
  if (condition === null || token === null) return null;
  return `${condition}::${token}`;
}

/**
 * Resolves a row's formula-version string from any supported field,
 * mirroring the alias set supported by
 * lib/modeling/strategyEvaluator.ts's formulaVersionEquals filter. Reads
 * only known top-level aliases and known keys off a `diagnostics` object.
 * If `diagnostics` is a string, it is parsed with a guarded JSON.parse; a
 * parse failure is ignored silently (no logging, no payload exposure).
 */
export function getFormulaVersionForExportRow(row: ExportRow): string | null {
  const topLevel = getString(row, FORMULA_VERSION_TOP_FIELDS);
  if (topLevel !== null) return topLevel;

  const diagnostics = row.diagnostics;
  let diagnosticsObj: Record<string, unknown> | null = null;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    diagnosticsObj = diagnostics as Record<string, unknown>;
  } else if (typeof diagnostics === "string" && diagnostics.trim() !== "") {
    try {
      const parsed = JSON.parse(diagnostics);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        diagnosticsObj = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed diagnostics string: ignore, do not log the payload.
      diagnosticsObj = null;
    }
  }

  if (diagnosticsObj) {
    for (const key of FORMULA_VERSION_DIAGNOSTICS_KEYS) {
      const value = diagnosticsObj[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }

  return null;
}

/** True if any supported score field is present on the row. */
export function hasScoreField(row: ExportRow): boolean {
  return hasAnyField(row, SCORE_FIELDS);
}

/** True if any supported coverage field is present on the row. */
export function hasCoverageField(row: ExportRow): boolean {
  return hasAnyField(row, COVERAGE_FIELDS);
}

/** True if any field usable as an event-group dedup key candidate is present. */
export function hasEventGroupCandidate(row: ExportRow): boolean {
  return hasAnyField(row, EVENT_GROUP_CANDIDATE_FIELDS);
}

/**
 * Detects (does not fix) the outcome() resolution quirk risk documented in
 * Phase 3D.2D: a row whose signal_result/result/outcome_status is a win
 * label (win/won/hit/correct/yes) but that has neither a valid
 * entry_price_num/entryPrice/entry_price nor a valid
 * realized_return_pct/realizedReturnPct is at risk of silently losing its
 * "won" resolution in lib/modeling/onePerMatchBacktest.ts's outcome().
 * Loss-labeled rows are never at risk (the quirk only affects the win path).
 */
export function detectOutcomeQuirkRisk(row: ExportRow): boolean {
  const result = getString(row, OUTCOME_RESULT_FIELDS);
  if (result === null) return false;
  if (!WIN_LABELS.has(result.toLowerCase())) return false;

  const hasValidEntryPrice = ENTRY_PRICE_FIELDS.some((key) => isValidNumber(row[key]));
  if (hasValidEntryPrice) return false;

  const hasValidRealizedReturn = REALIZED_RETURN_FIELDS.some((key) => isValidNumber(row[key]));
  if (hasValidRealizedReturn) return false;

  return true;
}

/**
 * Validates the structural shape of a local generated_signal_pairs export
 * (an array of already-loaded row objects) and returns diagnostics only --
 * no ROI/PnL, no fixes, no mutation of the input rows.
 */
export function validateGeneratedSignalPairsExportRows(
  rows: readonly ExportRow[],
): GeneratedSignalPairsExportDiagnostics {
  let rowsWithFormulaVersion = 0;
  let rowsWithScore = 0;
  let rowsWithCoverage = 0;
  let rowsWithEventGroupCandidate = 0;
  let outcomeQuirkRiskRows = 0;
  let rowsMissingStrictDedupKey = 0;

  const strictKeySeenCount = new Map<string, number>();

  for (const row of rows) {
    if (getFormulaVersionForExportRow(row) !== null) rowsWithFormulaVersion += 1;
    if (hasScoreField(row)) rowsWithScore += 1;
    if (hasCoverageField(row)) rowsWithCoverage += 1;
    if (hasEventGroupCandidate(row)) rowsWithEventGroupCandidate += 1;
    if (detectOutcomeQuirkRisk(row)) outcomeQuirkRiskRows += 1;

    const strictKey = getStrictDedupKeyForExportRow(row);
    if (strictKey === null) {
      rowsMissingStrictDedupKey += 1;
    } else {
      strictKeySeenCount.set(strictKey, (strictKeySeenCount.get(strictKey) ?? 0) + 1);
    }
  }

  let duplicateStrictKeyRows = 0;
  for (const count of strictKeySeenCount.values()) {
    if (count > 1) duplicateStrictKeyRows += count - 1;
  }
  const uniqueStrictDedupKeys = strictKeySeenCount.size;

  const notes: string[] = [];
  if (outcomeQuirkRiskRows > 0) {
    notes.push(
      `${outcomeQuirkRiskRows} row(s) have a win-labeled result with neither a valid entry price nor a valid realized return -- these would resolve as "unresolved" (won: null) under lib/modeling/onePerMatchBacktest.ts's current outcome() logic. This is detected, not fixed, here; see the DQA-R4 outcome quirk task before any ROI/PnL work.`,
    );
  }
  if (rowsWithFormulaVersion < rows.length) {
    notes.push(
      `${rows.length - rowsWithFormulaVersion} row(s) have no recognizable formula-version field; formula-version filtering (e.g. FORMULA_TRUSTED_INITIAL_V1_1_ALL) will reject them.`,
    );
  }
  if (duplicateStrictKeyRows > 0) {
    notes.push(
      `${duplicateStrictKeyRows} row(s) share a strict dedup key (condition_id + token_id) with an earlier row in this export -- rows are NOT deduplicated here. Duplicates must be resolved before any ROI/PnL comparison to avoid inflated selection/ROI counts.`,
    );
  }
  if (rowsMissingStrictDedupKey > 0) {
    notes.push(
      `${rowsMissingStrictDedupKey} row(s) are missing condition_id and/or token_id and cannot be checked for strict-key duplication.`,
    );
  }

  return {
    totalRows: rows.length,
    rowsWithFormulaVersion,
    rowsMissingFormulaVersion: rows.length - rowsWithFormulaVersion,
    rowsWithScore,
    rowsWithCoverage,
    rowsWithEventGroupCandidate,
    outcomeQuirkRiskRows,
    uniqueStrictDedupKeys,
    duplicateStrictKeyRows,
    rowsMissingStrictDedupKey,
    hasDuplicateStrictKeyRisk: duplicateStrictKeyRows > 0,
    notes,
  };
}
