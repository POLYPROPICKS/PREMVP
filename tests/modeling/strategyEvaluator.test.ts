import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReadyDeclaration,
  isRowSelectedByFilters,
  applyStrategyFilters,
  selectOnePerEventIfRequired,
  evaluateStrategyDeclaration,
  type StrategyDeclaration,
  type EvaluatorRow,
} from "../../lib/modeling/strategyEvaluator";

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

test("1. baseline/no-op declaration selects all rows", () => {
  const rows: EvaluatorRow[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const result = evaluateStrategyDeclaration(rows, baselineDeclaration());

  assert.equal(result.selectedRows.length, 3);
  assert.deepEqual(
    result.selectedRows.map((r) => r.id),
    ["a", "b", "c"],
  );
  assert.equal(result.diagnostics.totalInputRows, 3);
  assert.equal(result.diagnostics.passedFilterRows, 3);
  assert.equal(result.diagnostics.selectedRows, 3);
});

test("2. score threshold filters rows", () => {
  const rows: EvaluatorRow[] = [{ id: "a", score: 50 }, { id: "b", score: 72 }, { id: "c", score: 90 }];
  const declaration = baselineDeclaration({ filters: { scoreThreshold: 72 } });

  const result = evaluateStrategyDeclaration(rows, declaration);

  assert.deepEqual(
    result.selectedRows.map((r) => r.id),
    ["b", "c"],
  );
  assert.equal(result.diagnostics.rejectedByFilter.scoreThreshold, 1);
});

test("3. avoid NBA/NHL filters rows case-insensitively", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", league: "nba" },
    { id: "b", league: "NHL" },
    { id: "c", league: "EPL" },
  ];
  const declaration = baselineDeclaration({ filters: { avoidLeagues: ["NBA", "NHL"] } });

  const result = evaluateStrategyDeclaration(rows, declaration);

  assert.deepEqual(
    result.selectedRows.map((r) => r.id),
    ["c"],
  );
  assert.equal(result.diagnostics.rejectedByFilter.avoidLeagues, 2);
});

test("4. price bucket exclusion filters rows inside coverage+price bucket", () => {
  const rows: EvaluatorRow[] = [
    { id: "inside", coverage: 60, entryPrice: 0.5 },
    { id: "outside-coverage", coverage: 90, entryPrice: 0.5 },
    { id: "outside-price", coverage: 60, entryPrice: 0.9 },
    { id: "missing-price", coverage: 60 },
  ];
  const declaration = baselineDeclaration({
    filters: {
      coverageCap: {
        excludedBucket: { coverageMin: 50, coverageMax: 74, priceMin: 0.44, priceMax: 0.58 },
      },
    },
  });

  const result = evaluateStrategyDeclaration(rows, declaration);

  assert.deepEqual(
    result.selectedRows.map((r) => r.id),
    ["outside-coverage", "outside-price", "missing-price"],
  );
  assert.equal(result.diagnostics.rejectedByFilter.coverageCap, 1);
});

test("5. timing guard excludes rows inside excluded window and does not reject missing timing field", () => {
  const rows: EvaluatorRow[] = [
    { id: "inside-window", hoursUntilStart: 10 },
    { id: "outside-window", hoursUntilStart: 30 },
    { id: "missing-field" },
  ];
  const declaration = baselineDeclaration({
    filters: { timingWindow: { excludedHoursUntilStart: { min: 6, max: 24 } } },
  });

  const result = evaluateStrategyDeclaration(rows, declaration);

  assert.deepEqual(
    result.selectedRows.map((r) => r.id),
    ["outside-window", "missing-field"],
  );
  assert.equal(result.diagnostics.rejectedByFilter.timingWindow, 1);
  assert.equal(result.diagnostics.missingTimingField, 1);
});

test("6. one-event selection uses caller comparator and selects one row per group", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", match_family_key: "event-1", score: 10 },
    { id: "b", match_family_key: "event-1", score: 90 },
    { id: "c", match_family_key: "event-2", score: 50 },
  ];
  const declaration = baselineDeclaration({
    selectionUnit: "one per event",
    canonicalDedupKey: "event_group_key",
  });

  let callCount = 0;
  const compareRows = (a: EvaluatorRow, b: EvaluatorRow) => {
    callCount += 1;
    return (Number(b.score) || 0) - (Number(a.score) || 0);
  };

  const result = evaluateStrategyDeclaration(rows, declaration, { compareRows });

  assert.equal(result.selectedRows.length, 2);
  assert.ok(result.selectedRows.some((r) => r.id === "b"));
  assert.ok(!result.selectedRows.some((r) => r.id === "a"));
  assert.ok(result.selectedRows.some((r) => r.id === "c"));
  assert.ok(callCount > 0, "expected the caller-supplied comparator to actually be invoked");
});

test("7. one-event selection without comparator throws", () => {
  const rows: EvaluatorRow[] = [{ id: "a", match_family_key: "event-1" }];
  const declaration = baselineDeclaration({ selectionUnit: "one per event" });

  assert.throws(() => evaluateStrategyDeclaration(rows, declaration));
  assert.throws(() => selectOnePerEventIfRequired(rows, declaration));
});

test("8. blocked declaration throws before filtering", () => {
  const declaration = baselineDeclaration({ status: "BLOCKED_SOURCE_CONFLICT" });

  assert.throws(
    () => assertReadyDeclaration(declaration),
    /BASELINE_V1_CONTROL.*BLOCKED_SOURCE_CONFLICT/,
  );
  assert.throws(() => evaluateStrategyDeclaration([{ id: "a" }], declaration));
});

test("9. contract stub throws", () => {
  const declaration = baselineDeclaration({ status: "CONTRACT_STUB" });

  assert.throws(() => assertReadyDeclaration(declaration), /CONTRACT_STUB/);
});

test("10. missing script throws", () => {
  const declaration = baselineDeclaration({ status: "MISSING_SCRIPT" });

  assert.throws(() => assertReadyDeclaration(declaration), /MISSING_SCRIPT/);
});

test("11. evaluator does not mutate input rows or declaration", () => {
  const rows: EvaluatorRow[] = [{ id: "a", score: 90 }, { id: "b", score: 10 }];
  const rowsSnapshot = JSON.parse(JSON.stringify(rows));
  const declaration = baselineDeclaration({ filters: { scoreThreshold: 72 } });
  const declarationSnapshot = JSON.parse(JSON.stringify(declaration));

  evaluateStrategyDeclaration(rows, declaration);

  assert.deepEqual(rows, rowsSnapshot);
  assert.deepEqual(declaration, declarationSnapshot);
});

test("12. SCORE_GE_72_FAMILY-like declaration uses only top-level filters and does not invent variant timing logic", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", score: 90, hoursUntilStart: 10 }, // would be excluded by AVOID_6_24H variant, but that's not in filters
    { id: "b", score: 40, hoursUntilStart: 30 },
  ];
  const declaration = baselineDeclaration({
    strategyId: "SCORE_GE_72_FAMILY",
    filters: { scoreThreshold: 72, coverageThreshold: null, timingWindow: null },
  });

  const result = evaluateStrategyDeclaration(rows, declaration);

  assert.deepEqual(
    result.selectedRows.map((r) => r.id),
    ["a"],
  );
  assert.equal(result.diagnostics.rejectedByFilter.timingWindow ?? 0, 0);
});

test("13. diagnostics include totalInputRows, passedFilterRows, selectedRows, rejectedByFilter", () => {
  const rows: EvaluatorRow[] = [{ id: "a", score: 90 }, { id: "b", score: 10 }];
  const declaration = baselineDeclaration({ filters: { scoreThreshold: 72 } });

  const result = evaluateStrategyDeclaration(rows, declaration);

  assert.equal(result.diagnostics.totalInputRows, 2);
  assert.equal(result.diagnostics.passedFilterRows, 1);
  assert.equal(result.diagnostics.selectedRows, 1);
  assert.ok(typeof result.diagnostics.rejectedByFilter === "object");
});

test("isRowSelectedByFilters and applyStrategyFilters are directly usable pure building blocks", () => {
  const row: EvaluatorRow = { id: "a", score: 90 };
  assert.equal(isRowSelectedByFilters(row, { scoreThreshold: 72 }), true);
  assert.equal(isRowSelectedByFilters(row, { scoreThreshold: 95 }), false);

  const { passed, rejectedByFilter } = applyStrategyFilters(
    [{ id: "a", score: 90 }, { id: "b", score: 10 }],
    { scoreThreshold: 72 },
  );
  assert.equal(passed.length, 1);
  assert.equal(rejectedByFilter.scoreThreshold, 1);
});

const TRUSTED_FORMULA = "trusted-initial-formula-v1.1";

function trustedFormulaDeclaration(): StrategyDeclaration {
  return baselineDeclaration({
    strategyId: "FORMULA_TRUSTED_INITIAL_V1_1_ALL",
    selectionUnit: "all rows",
    filters: { formulaVersionEquals: TRUSTED_FORMULA },
  });
}

test("14. formulaVersionEquals selects rows via formula_version field", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", formula_version: TRUSTED_FORMULA },
    { id: "b", formula_version: "some-other-formula" },
  ];
  const result = evaluateStrategyDeclaration(rows, trustedFormulaDeclaration());

  assert.deepEqual(result.selectedRows.map((r) => r.id), ["a"]);
  assert.equal(result.diagnostics.rejectedByFilter.formulaVersionEquals, 1);
});

test("15. formulaVersionEquals selects rows via metric_formula_version field", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", metric_formula_version: TRUSTED_FORMULA },
    { id: "b", metric_formula_version: "other" },
  ];
  const result = evaluateStrategyDeclaration(rows, trustedFormulaDeclaration());

  assert.deepEqual(result.selectedRows.map((r) => r.id), ["a"]);
});

test("16. formulaVersionEquals selects rows via formulaVersion field", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", formulaVersion: TRUSTED_FORMULA },
    { id: "b", formulaVersion: "other" },
  ];
  const result = evaluateStrategyDeclaration(rows, trustedFormulaDeclaration());

  assert.deepEqual(result.selectedRows.map((r) => r.id), ["a"]);
});

test("17. formulaVersionEquals selects rows via diagnostics.formulaVersion (object and JSON-string)", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", diagnostics: { formulaVersion: TRUSTED_FORMULA } },
    { id: "b", diagnostics: { formulaVersion: "other" } },
    { id: "c", diagnostics: JSON.stringify({ formula_version: TRUSTED_FORMULA }) },
    { id: "d", diagnostics: "not valid json {{{" },
  ];
  const result = evaluateStrategyDeclaration(rows, trustedFormulaDeclaration());

  assert.deepEqual(result.selectedRows.map((r) => r.id), ["a", "c"]);
});

test("18. formulaVersionEquals rejects non-matching formula versions", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", formula_version: "v2-lite-growth-safe" },
    { id: "b", metric_formula_version: "shadow-strategic-sports-v1" },
    { id: "c" },
  ];
  const result = evaluateStrategyDeclaration(rows, trustedFormulaDeclaration());

  assert.equal(result.selectedRows.length, 0);
  assert.equal(result.diagnostics.rejectedByFilter.formulaVersionEquals, 3);
});

test("19. formulaVersionEquals is an exact string match, not a substring match", () => {
  const rows: EvaluatorRow[] = [
    { id: "exact", formula_version: TRUSTED_FORMULA },
    { id: "prefix", formula_version: "trusted-initial-formula-v1.10" },
    { id: "suffix", formula_version: "x-trusted-initial-formula-v1.1" },
  ];
  const result = evaluateStrategyDeclaration(rows, trustedFormulaDeclaration());

  assert.deepEqual(result.selectedRows.map((r) => r.id), ["exact"]);
});

test("20. formulaVersionEquals does not mutate input rows", () => {
  const rows: EvaluatorRow[] = [
    { id: "a", diagnostics: { formulaVersion: TRUSTED_FORMULA } },
    { id: "b", formula_version: "other" },
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));

  evaluateStrategyDeclaration(rows, trustedFormulaDeclaration());

  assert.deepEqual(rows, snapshot);
});
