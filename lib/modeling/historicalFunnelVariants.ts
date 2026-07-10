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

function getScore(row: Row): number {
  const value = row.signal_confidence_num;
  return typeof value === "number" ? value : 0;
}

function getCoverage(row: Row): number {
  const diagnostics = row.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    const value = (diagnostics as Record<string, unknown>).dataCoverage;
    if (typeof value === "number") return value;
  }
  return 0;
}

function getEntryPrice(row: Row): number | null {
  const value = row.entry_price_num;
  return typeof value === "number" ? value : null;
}

function getSmartMoney(row: Row): number | null {
  const value = row.smart_money_score_num;
  return typeof value === "number" ? value : null;
}

function getHoursUntilStart(row: Row): number | null {
  const diagnostics = row.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    const value = (diagnostics as Record<string, unknown>).hoursUntilStart;
    if (typeof value === "number") return value;
  }
  return null;
}

/** Bad coverage/price bucket: exact bounds from modelingData.ts isBadBucket. */
function isBadBucket(row: Row): boolean {
  const cov = getCoverage(row);
  const ep = getEntryPrice(row);
  return ep !== null && cov >= 50 && cov <= 74 && ep >= 0.44 && ep <= 0.58;
}

/** MODEL_A stake formula: exact constants from modelingData.ts getStake_primary. */
function stakePrimary(row: Row): number {
  const sc = getScore(row);
  const cov = getCoverage(row);
  const sm = getSmartMoney(row);
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
  if (field === "signal_confidence_num" && rule?.operator === ">=") {
    return rows.filter((r) => getScore(r) >= (rule.value as number));
  }
  if (field === "data_coverage_num" && rule?.operator === ">=") {
    return rows.filter((r) => getCoverage(r) >= (rule.value as number));
  }
  if (field === "smart_money_score_num" && rule && typeof rule.rule === "string") {
    return rows.filter((r) => {
      const sm = getSmartMoney(r);
      return sm === null || sm < 85;
    });
  }
  return rows;
}

function applyExclude(rows: Row[], field: string | null): Row[] {
  if (field === "league") {
    return rows.filter((r) => !isNbaOrNhl(r));
  }
  if (field === "data_coverage_num+entry_price_num") {
    return rows.filter((r) => !isBadBucket(r));
  }
  if (field === "hours_until_start_num") {
    return rows.filter((r) => {
      const hrs = getHoursUntilStart(r);
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
      const sm = getSmartMoney(r);
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
        current = [...current].sort((a, b) => getScore(b) - getScore(a));
      } else if (field === "data_coverage_num") {
        current = [...current].sort((a, b) => getCoverage(b) - getCoverage(a));
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
      if (bundle.bundleId === "ALT1_CANONICAL_EVENT_GROUPING") {
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
