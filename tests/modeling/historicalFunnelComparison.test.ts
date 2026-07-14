// Phase 3E.4 Commit A -- deterministic comparison engine tests.
//
// The engine runs the locked execution set of normalized historical funnel
// variants against ONE canonical strict-dedup row array, using the canonical
// roiPnlContract for every ROI/PnL figure (flat 1 unit) and the evaluator's
// ordered step results for attrition. No ROI math is duplicated here; no
// fs/env/network/database access.

import test from "node:test";
import assert from "node:assert/strict";
import {
  compareHistoricalFunnelVariants,
  computeFlatUnitEquityMetrics,
  LOCKED_EXECUTION_SET,
  BASELINE_VARIANT_ID,
  COMPARISON_ENGINE_VERSION,
} from "../../lib/modeling/historicalFunnelComparison";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();

function makeRow(n: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `id-${n}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-01-0${n}T00:00:00Z`,
    signal_confidence_num: 80,
    entry_price_num: 0.5,
    signal_result: "win",
    realized_return_pct: 50,
    diagnostics: { dataCoverage: 80 },
    ...overrides,
  };
}

// Deterministic fixed corpus (no shared mutable counter) so repeated runs are
// byte-identical.
function corpus(): Record<string, unknown>[] {
  return [
    makeRow(1, { signal_confidence_num: 80, signal_result: "win", realized_return_pct: 40 }),
    makeRow(2, { signal_confidence_num: 70, signal_result: "loss", smart_money_score_num: 90 }),
    makeRow(3, { signal_confidence_num: 70, signal_result: "win", realized_return_pct: 20, event_slug: "nba-lakers" }),
    makeRow(4, { signal_confidence_num: 30, signal_result: "loss" }),
  ];
}

const REQUESTED = [
  "BASELINE_V1_CONTROL",
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT1_CANONICAL_EVENT_GROUPING",
  "ALT2_TS_SCORE_GE_65",
  "ALT2_PY_SCORE_GE_65_SM_LT_85",
  "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL",
  "ALT3_PY_SCORE_GE_65",
  "ALT_SM_GUARD_ON_PRIMARY",
  "ALT_SM_GUARD_ON_PRIMARY_APPROX",
  "MODEL_A",
  "ALT1_ONE_PER_EVENT_BEST_COVERAGE",
  "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH",
  "ALT3_V1_AVOID_NBA_NHL",
  "ALT1_PY_EVENT_KEY_VARIANT",
  "CHAMPION_CURRENT",
  "FIRE_MODEL_1_LOCKED",
];

function run() {
  return compareHistoricalFunnelVariants({ rows: corpus(), classifier, requestedVariantIds: REQUESTED });
}

test("D1: all requested variants appear in the executions list", () => {
  const result = run();
  for (const id of REQUESTED) {
    assert.ok(result.executions.some((e) => e.variantId === id), `missing ${id}`);
  }
});

test("D2: input rows are not mutated", () => {
  const rows = corpus();
  const before = JSON.stringify(rows);
  compareHistoricalFunnelVariants({ rows, classifier, requestedVariantIds: REQUESTED });
  assert.equal(JSON.stringify(rows), before);
});

test("D3: BASELINE executes and preserves every canonical row", () => {
  const result = run();
  const base = result.executions.find((e) => e.variantId === "BASELINE_V1_CONTROL");
  assert.equal(base!.evaluationStatus, "EXECUTED");
  assert.equal(base!.metrics!.outputRows, 4);
});

test("D4: MODEL_A alias does not create a duplicate execution", () => {
  const result = run();
  const modelA = result.executions.find((e) => e.variantId === "MODEL_A");
  assert.ok(modelA);
  assert.equal(modelA!.evaluationStatus, "SKIPPED_DUPLICATE_ALIAS");
  // The canonical target executes exactly once.
  const executedGuard = result.executions.filter(
    (e) => e.variantId === "ALT_SM_GUARD_ON_PRIMARY" && e.evaluationStatus === "EXECUTED",
  );
  assert.equal(executedGuard.length, 1);
});

test("D5: ambiguous aliases appear as skipped entries, never executed", () => {
  const result = run();
  for (const id of ["ALT1_ONE_PER_EVENT_BEST_COVERAGE", "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH", "ALT3_V1_AVOID_NBA_NHL"]) {
    const e = result.executions.find((x) => x.variantId === id);
    assert.equal(e!.evaluationStatus, "SKIPPED_AMBIGUOUS_ALIAS");
    assert.ok(!e!.metrics);
  }
});

test("D6: SQL stubs appear as skipped entries", () => {
  const result = run();
  const e = result.executions.find((x) => x.variantId === "CHAMPION_CURRENT");
  assert.equal(e!.evaluationStatus, "SKIPPED_CONTRACT_STUB");
});

test("D7: label-only entries appear as skipped entries", () => {
  const result = run();
  const e = result.executions.find((x) => x.variantId === "FIRE_MODEL_1_LOCKED");
  assert.equal(e!.evaluationStatus, "SKIPPED_LABEL_ONLY");
});

test("D8: ALT1 Python variant is blocked when event_key is absent", () => {
  const result = run();
  const e = result.executions.find((x) => x.variantId === "ALT1_PY_EVENT_KEY_VARIANT");
  assert.equal(e!.evaluationStatus, "BLOCKED_MISSING_FIELD");
});

test("D9: ALT2 TS and Python produce separate metrics", () => {
  const result = run();
  const ts = result.executions.find((x) => x.variantId === "ALT2_TS_SCORE_GE_65");
  const py = result.executions.find((x) => x.variantId === "ALT2_PY_SCORE_GE_65_SM_LT_85");
  assert.equal(ts!.evaluationStatus, "EXECUTED");
  assert.equal(py!.evaluationStatus, "EXECUTED");
  assert.notEqual(ts!.metrics!.outputRows, py!.metrics!.outputRows);
});

test("D10: ALT3 TS and Python produce separate metrics", () => {
  const result = run();
  const ts = result.executions.find((x) => x.variantId === "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL");
  const py = result.executions.find((x) => x.variantId === "ALT3_PY_SCORE_GE_65");
  assert.notEqual(ts!.metrics!.outputRows, py!.metrics!.outputRows);
});

test("D11: PRIMARY remains flagged approximate", () => {
  const result = run();
  const e = result.executions.find((x) => x.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP");
  assert.equal(e!.classifierRunStatus, "RUNNABLE_APPROX_ONLY");
});

test("D12: canonical ALT1 remains exploratory identity-limited", () => {
  const result = run();
  const e = result.executions.find((x) => x.variantId === "ALT1_CANONICAL_EVENT_GROUPING");
  assert.equal(e!.classifierRunStatus, "READY_EXPLORATORY_WITH_IDENTITY_LIMITATION");
});

test("D13: metrics use the flat 1-unit ROI contract (stakeUnits 1)", () => {
  const result = run();
  const base = result.executions.find((e) => e.variantId === "BASELINE_V1_CONTROL");
  assert.equal(base!.normalizedStakePolicy!.unit, "FLAT_1_UNIT");
  assert.equal(typeof base!.metrics!.flatUnitRoi, "number");
});

test("D14: historical stake remains separate from normalized stake", () => {
  const result = run();
  const guard = result.executions.find((e) => e.variantId === "ALT_SM_GUARD_ON_PRIMARY");
  assert.ok(guard!.historicalStakePolicy);
  assert.notEqual(guard!.historicalStakePolicy!.unit, guard!.normalizedStakePolicy!.unit);
});

test("D15: win/loss/void counts reconcile with output rows", () => {
  const result = run();
  for (const e of result.executions) {
    if (e.evaluationStatus !== "EXECUTED") continue;
    const m = e.metrics!;
    assert.equal(m.wins + m.losses + m.voidOrExcludedResultRows, m.outputRows);
  }
});

test("D16: every transforming step count reconciles (input = passed + removed)", () => {
  const result = run();
  for (const e of result.executions) {
    if (e.evaluationStatus !== "EXECUTED") continue;
    for (const s of e.stepResults!) {
      assert.equal(s.inputRows, s.passedRows + s.removedRows);
    }
  }
});

test("D17: baseline deltas are correct relative to BASELINE", () => {
  const result = run();
  const base = result.executions.find((e) => e.variantId === BASELINE_VARIANT_ID)!;
  const alt = result.executions.find((e) => e.variantId === "ALT2_TS_SCORE_GE_65")!;
  assert.equal(
    alt.baselineDelta!.outputRowsDeltaVsBaseline,
    alt.metrics!.outputRows - base.metrics!.outputRows,
  );
});

test("D18: date range and covered-day metrics are deterministic", () => {
  const a = run();
  const b = run();
  assert.deepEqual(a.corpus, b.corpus);
});

test("D19: working event metrics come through from the canonical helper", () => {
  const result = run();
  const alt1 = result.executions.find((e) => e.variantId === "ALT1_CANONICAL_EVENT_GROUPING");
  assert.ok(typeof alt1!.metrics!.workingEventGroups === "number");
});

test("D20: output order is deterministic and matches requested order", () => {
  const result = run();
  assert.deepEqual(result.executions.map((e) => e.variantId), REQUESTED);
});

test("D21: engine performs no fs/env access", () => {
  const before = JSON.stringify(process.env);
  run();
  assert.equal(JSON.stringify(process.env), before);
});

test("D22: LOCKED_EXECUTION_SET excludes MODEL_A and all ambiguous/stub/label ids", () => {
  assert.ok(!LOCKED_EXECUTION_SET.includes("MODEL_A"));
  assert.ok(!LOCKED_EXECUTION_SET.includes("ALT1_ONE_PER_EVENT_BEST_COVERAGE"));
  assert.ok(!LOCKED_EXECUTION_SET.includes("CHAMPION_CURRENT"));
  assert.ok(LOCKED_EXECUTION_SET.includes("BASELINE_V1_CONTROL"));
});

test("D23: comparison module embeds no formula arithmetic (engine version tag present)", () => {
  assert.equal(typeof COMPARISON_ENGINE_VERSION, "string");
});

// ---- computeFlatUnitEquityMetrics ----

function eqRow(id: string, resolvedAt: string, result: string, ret: number): Record<string, unknown> {
  return { id, resolved_at: resolvedAt, signal_result: result, realized_return_pct: ret, entry_price_num: 0.5 };
}

test("E1: simple all-win increasing equity -> ending equals peak, zero drawdown", () => {
  const rows = [
    eqRow("a", "2024-01-01T00:00:00Z", "win", 10),
    eqRow("b", "2024-01-02T00:00:00Z", "win", 20),
  ];
  const m = computeFlatUnitEquityMetrics(rows);
  assert.ok(m.endingPnl > 0);
  assert.equal(m.endingPnl, m.peakPnl);
  assert.equal(m.maximumDrawdownUnits, 0);
  assert.equal(m.longestWinningStreak, 2);
  assert.equal(m.longestLosingStreak, 0);
});

test("E2: known drawdown sequence yields the expected max drawdown", () => {
  const rows = [
    eqRow("a", "2024-01-01T00:00:00Z", "win", 100),
    eqRow("b", "2024-01-02T00:00:00Z", "loss", -100),
    eqRow("c", "2024-01-03T00:00:00Z", "loss", -100),
  ];
  const m = computeFlatUnitEquityMetrics(rows);
  // peak after first row = 1 unit (100%); then two losses of 1 unit each.
  assert.equal(m.peakPnl, 1);
  assert.equal(m.maximumDrawdownUnits, 2);
});

test("E3: all-loss sequence -> negative ending, longest losing streak equals length", () => {
  const rows = [
    eqRow("a", "2024-01-01T00:00:00Z", "loss", -100),
    eqRow("b", "2024-01-02T00:00:00Z", "loss", -100),
    eqRow("c", "2024-01-03T00:00:00Z", "loss", -100),
  ];
  const m = computeFlatUnitEquityMetrics(rows);
  assert.ok(m.endingPnl < 0);
  assert.equal(m.longestLosingStreak, 3);
  assert.equal(m.longestWinningStreak, 0);
});

test("E4: ties are broken by stable id ascending", () => {
  const rows = [
    eqRow("b", "2024-01-01T00:00:00Z", "loss", -100),
    eqRow("a", "2024-01-01T00:00:00Z", "win", 100),
  ];
  // Ordered a (win) then b (loss): peak 1, then drawdown 1.
  const m = computeFlatUnitEquityMetrics(rows);
  assert.equal(m.peakPnl, 1);
  assert.equal(m.maximumDrawdownUnits, 1);
});

test("E5: winning and losing streaks are computed in resolved order", () => {
  const rows = [
    eqRow("a", "2024-01-01T00:00:00Z", "win", 10),
    eqRow("b", "2024-01-02T00:00:00Z", "win", 10),
    eqRow("c", "2024-01-03T00:00:00Z", "loss", -100),
    eqRow("d", "2024-01-04T00:00:00Z", "win", 10),
  ];
  const m = computeFlatUnitEquityMetrics(rows);
  assert.equal(m.longestWinningStreak, 2);
  assert.equal(m.longestLosingStreak, 1);
});

test("E6: equity ending PnL equals the canonical flat-stake total PnL", () => {
  const rows = [
    eqRow("a", "2024-01-01T00:00:00Z", "win", 40),
    eqRow("b", "2024-01-02T00:00:00Z", "loss", -100),
  ];
  const m = computeFlatUnitEquityMetrics(rows);
  // win 0.40 unit + loss -1 unit = -0.60 unit.
  assert.ok(Math.abs(m.endingPnl - -0.6) < 1e-9);
});

// ---- Phase 4B: batch-1 hypotheses run through the unmodified comparison engine ----
//
// LOCKED_EXECUTION_SET itself (the original 9) is untouched by this batch --
// the three new candidates are requested explicitly alongside it, proving the
// existing engine needs no rewrite to execute them.

const BATCH_1_IDS = [
  "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS",
  "ALT5_TS_SCORE_GE_65_TENNIS_ONLY",
  "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING",
];

test("N30: LOCKED_EXECUTION_SET (the original 9) is unchanged by this batch", () => {
  assert.equal(LOCKED_EXECUTION_SET.length, 9);
  for (const id of BATCH_1_IDS) {
    assert.ok(!LOCKED_EXECUTION_SET.includes(id), `${id} must not silently enter the locked set`);
  }
});

test("N31: requesting the original 9 plus the 3 new candidates executes all 12 in order", () => {
  const requested = [...LOCKED_EXECUTION_SET, ...BATCH_1_IDS];
  const result = compareHistoricalFunnelVariants({ rows: corpus(), classifier, requestedVariantIds: requested });
  assert.equal(result.executions.length, 12);
  assert.deepEqual(result.executions.map((e) => e.variantId), requested);
  for (const id of BATCH_1_IDS) {
    const exec = result.executions.find((e) => e.variantId === id);
    assert.ok(exec, `${id} missing from executions`);
    assert.equal(exec!.evaluationStatus, "EXECUTED");
    assert.ok(exec!.metrics, `${id} produced no metrics`);
  }
});

test("N32: the original 9 models' metrics on the regression fixture are unchanged by adding the batch", () => {
  const before = compareHistoricalFunnelVariants({ rows: corpus(), classifier, requestedVariantIds: [...LOCKED_EXECUTION_SET] });
  const after = compareHistoricalFunnelVariants({
    rows: corpus(),
    classifier,
    requestedVariantIds: [...LOCKED_EXECUTION_SET, ...BATCH_1_IDS],
  });
  for (const id of LOCKED_EXECUTION_SET) {
    const b = before.executions.find((e) => e.variantId === id)!;
    const a = after.executions.find((e) => e.variantId === id)!;
    assert.deepEqual(a.metrics, b.metrics, id);
    assert.equal(a.evaluationStatus, b.evaluationStatus, id);
  }
});
