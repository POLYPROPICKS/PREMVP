// Pure execution adapters for the normalized historical funnel variants
// (Phase 3E.3A-2 Commit B).
//
// Runs the ordered funnel declared in each executable classifier bundle
// (Commit A) against an already strict-deduplicated row array. Math-only:
// no ROI/PnL computation (that stays in lib/modeling/roiPnlContract.ts), no
// fs/env/network/database access, no mutation of the input rows.
//
// Predicate reuse: event grouping reuses lib/modeling/eventGroupSelection.ts
// directly (it is a pure module with no side effects). The NBA/NHL regex,
// bad-coverage/price bucket, and MODEL_A stake formula are the exact
// constants from lib/executor/modelingData.ts -- that file cannot be
// imported directly here because it eagerly constructs a Supabase client at
// module load (lib/supabase/server.ts throws when SUPABASE_URL is unset),
// so the same literal predicates are re-hosted here as side-effect-free
// functions rather than reimplemented differently.

import {
  loadExecutableFunnelClassifier,
  getBundle,
  resolveAlias,
  type ExecutableFunnelClassifier,
  type FunnelStep,
} from "./executableFunnelClassifier";
import { buildEventGroupKey, groupRowsByEventGroup } from "./eventGroupSelection";

type Row = Record<string, unknown>;

// ---- Re-hosted canonical predicates (exact constants from lib/executor/modelingData.ts) ----

const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;
const ESPORTS_RE = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;
// Re-hosted verbatim from lib/modeling/sportMarketPerformanceSlice.ts's
// SPORT_PATTERNS tennis entry (Phase 4B batch-1) -- same re-hosting
// precedent as NBA_NHL_RE/ESPORTS_RE above: no new heuristic, the identical
// pattern already used by the canonical sport decomposition.
const TENNIS_RE = /\btennis\b|\batp\b|\bwta\b/i;

function mref(row: Row): string {
  const marketSlug = typeof row.market_slug === "string" ? row.market_slug : "";
  const eventSlug = typeof row.event_slug === "string" ? row.event_slug : "";
  return `${marketSlug} ${eventSlug}`.toLowerCase();
}

function isNbaOrNhl(row: Row): boolean {
  return NBA_NHL_RE.test(mref(row));
}

function isEsports(row: Row): boolean {
  return ESPORTS_RE.test(mref(row));
}

function isTennis(row: Row): boolean {
  return TENNIS_RE.test(mref(row));
}

// The exact permitted metric_formula_version values, re-hosted verbatim from
// lib/executor/modelingData.ts ALLOWED_VERSIONS (that module cannot be
// imported here -- it eagerly builds a Supabase client at load). These are
// concrete permitted values, never a bundle name.
export const ALLOWED_METRIC_FORMULA_VERSIONS: readonly string[] = [
  "v2-lite-growth-safe",
  "shadow-firemodel1_1_research_v0",
];

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function diagnosticsOf(row: Row): Record<string, unknown> | null {
  const diagnostics = row.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    return diagnostics as Record<string, unknown>;
  }
  return null;
}

/**
 * Export-to-evaluator score adapter. Reads the first FINITE numeric value in
 * the semantic priority order signal_confidence_num -> score -> signal_score
 * -> pre_event_score_num (the export normalizer emits `score`/`signal_score`/
 * `pre_event_score_num` but drops `signal_confidence_num`). Returns null for a
 * missing OR invalid field (numeric strings are rejected, not coerced), so a
 * calling REQUIRE can distinguish a real 0 from an absent score and fail
 * closed rather than treating missing as 0.
 */
export function getScoreValue(row: Row): number | null {
  return (
    finiteNumber(row.signal_confidence_num) ??
    finiteNumber(row.score) ??
    finiteNumber(row.signal_score) ??
    finiteNumber(row.pre_event_score_num)
  );
}

/**
 * Coverage adapter. Reads ONLY diagnostics.dataCoverage (the top-level
 * `coverage`/`coverage_score` aliases are dead -- no physical column backs
 * them). Requires a finite number in the expected 0-100 unit; anything else
 * (missing, string, out of range) is null so a REQUIRE fails closed rather
 * than silently reading 0.
 */
export function getCoverageValue(row: Row): number | null {
  const diagnostics = diagnosticsOf(row);
  if (!diagnostics) return null;
  const value = finiteNumber(diagnostics.dataCoverage);
  if (value === null || value < 0 || value > 100) return null;
  return value;
}

function getEntryPrice(row: Row): number | null {
  return finiteNumber(row.entry_price_num);
}

/**
 * Smart-money adapter. Reads the exact exported top-level location
 * smart_money_score_num. When absent, returns null; the historical predicates
 * (Python `smart_money is None or smart_money < 85`, and the MODEL_A stake
 * guard) already define the missing case explicitly (fail-open), so this is
 * never a silent conversion -- callers keep their documented missing handling.
 */
export function getSmartMoneyValue(row: Row): number | null {
  return finiteNumber(row.smart_money_score_num);
}

/**
 * Timing adapter. Derives hours-until-start from the exported historical
 * timestamps diagnostics.gameStartIso and created_at: (gameStartIso -
 * created_at) / 3_600_000. Never uses wall-clock time. Returns null if either
 * timestamp is absent or unparseable.
 */
export function getHoursUntilStartValue(row: Row): number | null {
  const diagnostics = diagnosticsOf(row);
  const startIso = diagnostics && typeof diagnostics.gameStartIso === "string" ? diagnostics.gameStartIso : null;
  const createdAt = typeof row.created_at === "string" ? row.created_at : null;
  if (startIso === null || createdAt === null) return null;
  const startMs = Date.parse(startIso);
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(startMs) || Number.isNaN(createdMs)) return null;
  return (startMs - createdMs) / 3_600_000;
}

/**
 * Formula-version eligibility. True only when metric_formula_version is one of
 * the exact permitted values; a missing/unknown version is false (fail-closed
 * removal), matching modelingData.ts isAllowed.
 */
export function isAllowedFormulaVersion(row: Row): boolean {
  const version = row.metric_formula_version;
  return typeof version === "string" && ALLOWED_METRIC_FORMULA_VERSIONS.includes(version);
}

// Numeric-with-zero-fallback views used only by the diagnostic stake formula
// and the bad-bucket predicate, where a missing value behaves as it did in the
// original modelingData helpers (getScore/getCov default to 0). Gating REQUIRE
// steps use the nullable getScoreValue/getCoverageValue instead.
function getScoreOrZero(row: Row): number {
  return getScoreValue(row) ?? 0;
}

function getCoverageOrZero(row: Row): number {
  return getCoverageValue(row) ?? 0;
}

/** Bad coverage/price bucket: exact bounds from modelingData.ts isBadBucket. */
function isBadBucket(row: Row): boolean {
  const cov = getCoverageValue(row);
  const ep = getEntryPrice(row);
  return ep !== null && cov !== null && cov >= 50 && cov <= 74 && ep >= 0.44 && ep <= 0.58;
}

/** MODEL_A stake formula: exact constants from modelingData.ts getStake_primary. */
function stakePrimary(row: Row): number {
  const sc = getScoreOrZero(row);
  const cov = getCoverageOrZero(row);
  const sm = getSmartMoneyValue(row);
  const esports = isEsports(row);
  let base = 0;
  if (sc >= 72 && cov >= 75) base = 10;
  else if (sc >= 72 && cov >= 50) base = 7;
  else if (sc >= 60 && cov >= 50) base = 7;
  else if (sc >= 50 && cov >= 25) base = 3;
  let stake = sm !== null && sm >= 75 ? Math.floor(base / 2) : base;
  if (esports) stake = Math.min(stake, 5);
  return Math.min(stake, 10);
}

function getEventKey(row: Row): string | null {
  const value = row.event_key;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const conditionId = row.condition_id;
  if (typeof conditionId === "string" && conditionId.trim() !== "") return conditionId.trim();
  return null;
}

// ---- Evaluator ----

export interface FunnelStepResult {
  step: number;
  action: FunnelStep["action"];
  inputRows: number;
  passedRows: number;
  removedRows: number;
}

export interface HistoricalFunnelVariantResult {
  variantId: string;
  inputRows: number;
  outputRows: number;
  stepResults: FunnelStepResult[];
  workingEventGroups?: number;
  status: "COMPLETED" | "BLOCKED";
  limitationFlags: string[];
  // The final selected row objects (original references from the input). A
  // downstream consumer (the comparison engine) uses these to compute
  // ROI/PnL/equity via the canonical roiPnlContract -- so it never has to
  // re-implement the funnel selection logic. Never a mutated copy.
  selectedRows: Row[];
}

function applyRequire(rows: Row[], field: string | null, rule: Record<string, unknown> | null): Row[] {
  // Formula-version eligibility REQUIRE (field: null, predicate isAllowed(r)).
  if (field === null && rule && rule.predicate === "isAllowed(r)") {
    return rows.filter((r) => isAllowedFormulaVersion(r));
  }
  if (field === "signal_confidence_num" && rule?.operator === ">=") {
    // Missing/invalid score fails closed (removed), never read as 0.
    return rows.filter((r) => {
      const s = getScoreValue(r);
      return s !== null && s >= (rule.value as number);
    });
  }
  // Phase 4B ALT5: single-dimension inclusion filter, reuses isTennis (same
  // re-hosted-predicate pattern as isNbaOrNhl/isEsports below).
  if (field === "sport_tennis") {
    return rows.filter((r) => isTennis(r));
  }
  if (field === "data_coverage_num" && rule?.operator === ">=") {
    // Missing/invalid coverage fails closed (removed), never read as 0.
    return rows.filter((r) => {
      const c = getCoverageValue(r);
      return c !== null && c >= (rule.value as number);
    });
  }
  if (field === "smart_money_score_num" && rule && typeof rule.rule === "string") {
    return rows.filter((r) => {
      const sm = getSmartMoneyValue(r);
      return sm === null || sm < 85;
    });
  }
  return rows;
}

function applyExclude(rows: Row[], field: string | null): Row[] {
  if (field === "league") {
    return rows.filter((r) => !isNbaOrNhl(r));
  }
  // Phase 4B ALT4: single-dimension exclusion, reuses isEsports (existing
  // predicate, no new heuristic).
  if (field === "sport_esports") {
    return rows.filter((r) => !isEsports(r));
  }
  if (field === "data_coverage_num+entry_price_num") {
    return rows.filter((r) => !isBadBucket(r));
  }
  if (field === "hours_until_start_num") {
    return rows.filter((r) => {
      const hrs = getHoursUntilStartValue(r);
      return hrs === null || !(hrs >= 6 && hrs < 24);
    });
  }
  if (field === "signal_result") {
    return rows.filter((r) => r.signal_result !== "VOID");
  }
  if (field === "smart_money_score_num") {
    // Hard exclusion (as opposed to the soft stake-halving guard applied at
    // the STAKE step): smart money missing is treated as passing.
    return rows.filter((r) => {
      const sm = getSmartMoneyValue(r);
      return sm === null || sm < 85;
    });
  }
  return rows;
}

/**
 * Runs a normalized historical funnel variant declared in the classifier
 * registry against `rows` (already strict-deduplicated). Pure: no fs/env/
 * network/database access, no mutation of `rows`, no ROI/PnL math.
 */
export function evaluateHistoricalFunnelVariant(
  rows: readonly Row[],
  classifier: ExecutableFunnelClassifier,
  variantId: string,
): HistoricalFunnelVariantResult {
  const bundle = getBundle(classifier, variantId);
  if (!bundle) {
    throw new Error(`historical funnel variant: unknown bundle id ${variantId}`);
  }
  if (bundle.runStatus === "AMBIGUOUS_ALIAS_NOT_EXECUTABLE") {
    const targets = resolveAlias(classifier, variantId);
    throw new Error(
      `historical funnel variant: ${variantId} is an ambiguous alias, not executable directly (resolves to: ${targets.join(", ")})`,
    );
  }
  if (bundle.sourceEvidence.some((e) => e.sourceClass === "SQL_CONTRACT_STUB")) {
    throw new Error(`historical funnel variant: ${variantId} is a SQL contract stub, not executable`);
  }

  let current: Row[] = [...rows];
  const stepResults: FunnelStepResult[] = [];
  const limitationFlags: string[] = [];
  let workingEventGroups: number | undefined;
  let blocked = false;
  // ORDER steps are declared highest-priority-first (e.g. coverage, then
  // score, then tie-break). A stable multi-key sort must apply the LOWEST
  // priority key first and the HIGHEST priority key last, so pending ORDER
  // steps are buffered and flushed in reverse just before the KEEP step
  // that depends on them.
  let pendingOrderFields: string[] = [];

  function flushOrder(): void {
    for (const field of pendingOrderFields) {
      if (field === "signal_confidence_num") {
        current = [...current].sort((a, b) => getScoreOrZero(b) - getScoreOrZero(a));
      } else if (field === "data_coverage_num") {
        current = [...current].sort((a, b) => getCoverageOrZero(b) - getCoverageOrZero(a));
      }
    }
    pendingOrderFields = [];
  }

  for (const step of bundle.orderedFunnel) {
    const before = current.length;

    if (step.currentDatasetAvailability === "MISSING") {
      blocked = true;
      if (step.field === "event_key" || (step.exactRule && JSON.stringify(step.exactRule).includes("event_key"))) {
        limitationFlags.push("event_key_missing_from_canonical_export");
      } else {
        limitationFlags.push(`missing_field:${step.field ?? "unknown"}`);
      }
      stepResults.push({ step: step.step, action: step.action, inputRows: before, passedRows: 0, removedRows: before });
      current = [];
      continue;
    }

    if (step.action === "REQUIRE") {
      current = applyRequire(current, step.field, step.exactRule);
    } else if (step.action === "EXCLUDE") {
      current = applyExclude(current, step.field);
    } else if (step.action === "GROUP") {
      const groups = groupRowsByEventGroup(current);
      workingEventGroups = groups.size;
      // Grouping itself does not drop rows; ORDER/KEEP narrow per group below.
    } else if (step.action === "ORDER") {
      // Buffer priority-ordered fields; applied in reverse (least-priority
      // first) so the highest-priority field ends up the stable primary key.
      if (step.field === "data_coverage_num" || step.field === "signal_confidence_num") {
        pendingOrderFields.unshift(step.field);
      }
    } else if (step.action === "KEEP") {
      flushOrder();
      // Phase 4B ALT6: identical keep-first-per-canonical-group behavior as
      // ALT1_CANONICAL_EVENT_GROUPING -- same helper, same tie-break, no new
      // event key or ranking rule.
      if (bundle.bundleId === "ALT1_CANONICAL_EVENT_GROUPING" || bundle.bundleId === "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING") {
        const groups = groupRowsByEventGroup(current);
        current = Array.from(groups.values()).map((group) => group[0]);
        workingEventGroups = groups.size;
      }
      // BASELINE / other KEEP-all steps: no-op, current already narrowed by
      // prior REQUIRE/EXCLUDE steps.
    } else if (step.action === "STAKE") {
      // Soft guard (ALT_SM_GUARD_ON_PRIMARY / MODEL_A): the stake formula
      // stakePrimary() would halve the stake at smart money >= 75, but it
      // never removes a row from selection -- so `current` is unchanged here.
      // Historical/normalized stake amounts are declarative (see the
      // registry's historicalStakePolicy/normalizedEvaluationStakePolicy);
      // this adapter never computes ROI/PnL from them.
      void stakePrimary;
    }
    // INPUT / OUTPUT steps are structural bookends; INPUT already seeded
    // `current`, OUTPUT reports the final `current` length below.

    const after = current.length;
    stepResults.push({
      step: step.step,
      action: step.action,
      inputRows: before,
      passedRows: after,
      removedRows: before - after,
    });
  }

  return {
    variantId,
    inputRows: rows.length,
    outputRows: current.length,
    stepResults,
    ...(workingEventGroups !== undefined ? { workingEventGroups } : {}),
    status: blocked ? "BLOCKED" : "COMPLETED",
    limitationFlags,
    selectedRows: current,
  };
}

export { loadExecutableFunnelClassifier };
