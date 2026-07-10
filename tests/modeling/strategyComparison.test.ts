import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  getRequiredForComparisonDeclarations,
  runStrategyComparison,
} from "../../lib/modeling/strategyComparison";
import type { StrategyDeclaration, EvaluatorRow } from "../../lib/modeling/strategyEvaluator";

const ROOT = path.resolve(__dirname, "../..");

function readDeclaration(fileName: string): StrategyDeclaration {
  const raw = readFileSync(
    path.join(ROOT, "scripts/modeling/strategies/declarations", fileName),
    "utf8",
  );
  return JSON.parse(raw) as StrategyDeclaration;
}

function baselineDeclaration(overrides: Partial<StrategyDeclaration> = {}): StrategyDeclaration {
  return {
    strategyId: "BASELINE_V1_CONTROL",
    status: "READY_TO_NORMALIZE",
    selectionUnit: "all rows",
    canonicalDedupKey: null,
    filters: {},
    ...overrides,
  };
}

test("getRequiredForComparisonDeclarations selects only requiredForComparison=true declarations", () => {
  const declarations: StrategyDeclaration[] = [
    baselineDeclaration({ strategyId: "A" }),
    baselineDeclaration({ strategyId: "B", requiredForComparison: true }),
    baselineDeclaration({ strategyId: "C", requiredForComparison: false }),
  ];

  const required = getRequiredForComparisonDeclarations(declarations);

  assert.deepEqual(
    required.map((d) => d.strategyId),
    ["B"],
  );
});

test("required comparison includes FORMULA_TRUSTED_INITIAL_V1_1_ALL by default", () => {
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const rows: EvaluatorRow[] = [
    { id: "a", formula_version: "trusted-initial-formula-v1.1" },
    { id: "b", formula_version: "some-other-formula" },
  ];

  const result = runStrategyComparison(rows, [trustedFormula]);

  assert.ok(
    result.strategies.some((s) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL"),
    "expected FORMULA_TRUSTED_INITIAL_V1_1_ALL to be included in the default (requiredOnly) comparison",
  );
});

test("comparison result includes per-strategy summary fields", () => {
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const rows: EvaluatorRow[] = [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }];

  const result = runStrategyComparison(rows, [trustedFormula]);
  const summary = result.strategies[0];

  assert.equal(typeof summary.strategyId, "string");
  assert.equal(typeof summary.inputRows, "number");
  assert.equal(typeof summary.selectedRows, "number");
  assert.equal(typeof summary.rejectedByFilter, "object");
  assert.ok("error" in summary);
  assert.equal(result.totalInputRows, 1);
  assert.equal(result.selectedStrategyCount, 1);
});

test("baseline (no-op) declaration selects all rows when explicitly requested", () => {
  const baseline = baselineDeclaration();
  const rows: EvaluatorRow[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

  const result = runStrategyComparison(rows, [baseline], { strategyIds: ["BASELINE_V1_CONTROL"] });

  assert.equal(result.strategies[0].selectedRows, 3);
  assert.equal(result.strategies[0].error, null);
});

test("trusted formula strategy selects only rows with matching formula version", () => {
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const rows: EvaluatorRow[] = [
    { id: "a", formula_version: "trusted-initial-formula-v1.1" },
    { id: "b", formula_version: "v2-lite-growth-safe" },
    { id: "c", metric_formula_version: "trusted-initial-formula-v1.1" },
  ];

  const result = runStrategyComparison(rows, [trustedFormula]);

  const summary = result.strategies.find((s) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL");
  assert.ok(summary);
  assert.equal(summary?.selectedRows, 2);
  assert.equal(summary?.rejectedByFilter.formulaVersionEquals, 1);
});

test("blocked/non-ready declarations are refused, not executed, and do not throw", () => {
  const blocked = baselineDeclaration({
    strategyId: "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH",
    status: "BLOCKED_SOURCE_CONFLICT",
    requiredForComparison: true,
  });
  const rows: EvaluatorRow[] = [{ id: "a" }];

  const result = runStrategyComparison(rows, [blocked]);

  const summary = result.strategies[0];
  assert.equal(summary.selectedRows, 0);
  assert.match(summary.error ?? "", /BLOCKED_SOURCE_CONFLICT/);
  assert.match(summary.error ?? "", /ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH/);
});

test("one-event declaration without a comparator is refused, not run with an invented ranking", () => {
  const oneEvent = baselineDeclaration({
    strategyId: "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
    selectionUnit: "one per event",
    requiredForComparison: true,
  });
  const rows: EvaluatorRow[] = [{ id: "a", match_family_key: "event-1" }];

  const result = runStrategyComparison(rows, [oneEvent]);

  assert.ok(result.strategies[0].error);
});

test("runStrategyComparison does not mutate input rows or declarations", () => {
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const declarationSnapshot = JSON.parse(JSON.stringify(trustedFormula));
  const rows: EvaluatorRow[] = [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }];
  const rowsSnapshot = JSON.parse(JSON.stringify(rows));

  runStrategyComparison(rows, [trustedFormula]);

  assert.deepEqual(rows, rowsSnapshot);
  assert.deepEqual(trustedFormula, declarationSnapshot);
});

test("comparison output contains no ROI/PnL fields", () => {
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const rows: EvaluatorRow[] = [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }];

  const result = runStrategyComparison(rows, [trustedFormula]);
  const serialized = JSON.stringify(result).toLowerCase();

  assert.ok(!serialized.includes("\"roi\""));
  assert.ok(!serialized.includes("\"pnl\""));
  assert.ok(!serialized.includes("profit"));
});

test("empty declaration selection returns empty strategies array with diagnostics", () => {
  const rows: EvaluatorRow[] = [{ id: "a" }];
  const result = runStrategyComparison(rows, []);

  assert.deepEqual(result.strategies, []);
  assert.equal(result.selectedStrategyCount, 0);
  assert.equal(result.totalInputRows, 1);
});

// ---- Phase 3E.2: selected-row access helper (internal CLI ROI use) ----

test("runStrategyComparisonWithSelectedRows exposes selected row objects matching selectedRows count", () => {
  const { runStrategyComparisonWithSelectedRows } = require("../../lib/modeling/strategyComparison");
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const rows: EvaluatorRow[] = [
    { id: "a", formula_version: "trusted-initial-formula-v1.1" },
    { id: "b", formula_version: "v2-lite-growth-safe" },
    { id: "c", metric_formula_version: "trusted-initial-formula-v1.1" },
  ];

  const { result, selectedRowsByStrategyId } = runStrategyComparisonWithSelectedRows(rows, [trustedFormula]);

  const summary = result.strategies.find(
    (s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL",
  );
  assert.ok(summary);
  assert.equal(summary.selectedRows, 2);
  const selected = selectedRowsByStrategyId["FORMULA_TRUSTED_INITIAL_V1_1_ALL"];
  assert.ok(Array.isArray(selected));
  assert.equal(selected.length, 2);
});

test("runStrategyComparisonWithSelectedRows keeps rejectedByFilter counts unchanged", () => {
  const { runStrategyComparisonWithSelectedRows } = require("../../lib/modeling/strategyComparison");
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const rows: EvaluatorRow[] = [
    { id: "a", formula_version: "trusted-initial-formula-v1.1" },
    { id: "b", formula_version: "v2-lite-growth-safe" },
  ];

  const { result } = runStrategyComparisonWithSelectedRows(rows, [trustedFormula]);
  const summary = result.strategies.find(
    (s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL",
  );
  assert.equal(summary.rejectedByFilter.formulaVersionEquals, 1);
});

test("runStrategyComparison public result shape is unchanged (no selected row arrays)", () => {
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const rows: EvaluatorRow[] = [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }];

  const result = runStrategyComparison(rows, [trustedFormula]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /selectedRowsByStrategyId/);
  // per-strategy summary carries only a numeric selectedRows count, not an array
  assert.equal(typeof result.strategies[0].selectedRows, "number");
});

test("runStrategyComparisonWithSelectedRows does not mutate input rows", () => {
  const { runStrategyComparisonWithSelectedRows } = require("../../lib/modeling/strategyComparison");
  const trustedFormula = readDeclaration("trusted_initial_formula_v1_1_all.json");
  const rows: EvaluatorRow[] = [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }];
  const snapshot = JSON.stringify(rows);
  runStrategyComparisonWithSelectedRows(rows, [trustedFormula]);
  assert.equal(JSON.stringify(rows), snapshot);
});
