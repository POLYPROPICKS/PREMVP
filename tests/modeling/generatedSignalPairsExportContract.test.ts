import test from "node:test";
import assert from "node:assert/strict";
import {
  validateGeneratedSignalPairsExportRows,
  getFormulaVersionForExportRow,
  hasScoreField,
  hasCoverageField,
  hasEventGroupCandidate,
  detectOutcomeQuirkRisk,
  getStrictDedupKeyForExportRow,
  type ExportRow,
} from "../../lib/modeling/generatedSignalPairsExportContract";

test("accepts rows with formula_version", () => {
  const row: ExportRow = { formula_version: "trusted-initial-formula-v1.1" };
  assert.equal(getFormulaVersionForExportRow(row), "trusted-initial-formula-v1.1");
});

test("accepts rows with metric_formula_version", () => {
  const row: ExportRow = { metric_formula_version: "realized-flat-stake-v1" };
  assert.equal(getFormulaVersionForExportRow(row), "realized-flat-stake-v1");
});

test("accepts rows with diagnostics.formulaVersion (object and JSON-string)", () => {
  const objectRow: ExportRow = { diagnostics: { formulaVersion: "shadow-strategic-sports-v1" } };
  assert.equal(getFormulaVersionForExportRow(objectRow), "shadow-strategic-sports-v1");

  const stringRow: ExportRow = { diagnostics: JSON.stringify({ formula_version: "v2-lite-growth-safe" }) };
  assert.equal(getFormulaVersionForExportRow(stringRow), "v2-lite-growth-safe");

  const malformedRow: ExportRow = { diagnostics: "not valid json {{{" };
  assert.equal(getFormulaVersionForExportRow(malformedRow), null);
});

test("counts rows missing formula version", () => {
  const rows: ExportRow[] = [
    { formula_version: "trusted-initial-formula-v1.1" },
    { id: "no-version" },
  ];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);

  assert.equal(diagnostics.rowsWithFormulaVersion, 1);
  assert.equal(diagnostics.rowsMissingFormulaVersion, 1);
});

test("counts rows with score available via score or signal_score", () => {
  assert.equal(hasScoreField({ score: 72 }), true);
  assert.equal(hasScoreField({ signal_score: 50 }), true);
  assert.equal(hasScoreField({ signalScore: 50 }), true);
  assert.equal(hasScoreField({ pre_event_score_num: 50 }), true);
  assert.equal(hasScoreField({}), false);

  const rows: ExportRow[] = [{ score: 90 }, { signal_score: 50 }, {}];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);
  assert.equal(diagnostics.rowsWithScore, 2);
});

test("counts rows with coverage available via coverage or coverage_score", () => {
  assert.equal(hasCoverageField({ coverage: 80 }), true);
  assert.equal(hasCoverageField({ coverage_score: 60 }), true);
  assert.equal(hasCoverageField({ coverageScore: 60 }), true);
  assert.equal(hasCoverageField({}), false);

  const rows: ExportRow[] = [{ coverage: 80 }, { coverage_score: 60 }, {}];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);
  assert.equal(diagnostics.rowsWithCoverage, 2);
});

test("counts rows with event grouping candidate fields", () => {
  assert.equal(hasEventGroupCandidate({ match_family_key: "x" }), true);
  assert.equal(hasEventGroupCandidate({ canonical_event_key: "x" }), true);
  assert.equal(hasEventGroupCandidate({ event_slug: "x" }), true);
  assert.equal(hasEventGroupCandidate({ market_slug: "x" }), true);
  assert.equal(hasEventGroupCandidate({ condition_id: "x" }), true);
  assert.equal(hasEventGroupCandidate({}), false);

  const rows: ExportRow[] = [{ match_family_key: "x" }, { condition_id: "y" }, {}];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);
  assert.equal(diagnostics.rowsWithEventGroupCandidate, 2);
});

test("detects outcome quirk risk: win row missing entry_price_num and realized_return_pct", () => {
  const row: ExportRow = { signal_result: "won" };
  assert.equal(detectOutcomeQuirkRisk(row), true);

  const winVariants = ["win", "won", "hit", "correct", "yes"];
  for (const label of winVariants) {
    assert.equal(
      detectOutcomeQuirkRisk({ signal_result: label }),
      true,
      `expected outcome quirk risk for win label "${label}"`,
    );
  }
});

test("win row with a valid entry_price_num or realized_return_pct is not at risk", () => {
  assert.equal(detectOutcomeQuirkRisk({ signal_result: "won", entry_price_num: 0.5 }), false);
  assert.equal(detectOutcomeQuirkRisk({ signal_result: "won", realized_return_pct: 100 }), false);
});

test("does not treat loss rows without entry_price_num as outcome quirk risk", () => {
  const lossVariants = ["loss", "lost", "miss", "incorrect", "no"];
  for (const label of lossVariants) {
    assert.equal(
      detectOutcomeQuirkRisk({ signal_result: label }),
      false,
      `did not expect outcome quirk risk for loss label "${label}"`,
    );
  }
});

test("validateGeneratedSignalPairsExportRows counts outcomeQuirkRiskRows across a mixed fixture", () => {
  const rows: ExportRow[] = [
    { signal_result: "won" }, // at risk
    { signal_result: "won", entry_price_num: 0.5 }, // not at risk
    { signal_result: "lost" }, // not at risk (loss doesn't need price)
    { result: "hit" }, // at risk (alias field, win label)
    { outcome_status: "won", realized_return_pct: 50 }, // not at risk
  ];

  const diagnostics = validateGeneratedSignalPairsExportRows(rows);
  assert.equal(diagnostics.outcomeQuirkRiskRows, 2);
});

test("diagnostics returns only structural fields, no ROI/PnL/profit keys", () => {
  const rows: ExportRow[] = [{ formula_version: "trusted-initial-formula-v1.1" }];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);

  const serialized = JSON.stringify(diagnostics).toLowerCase();
  assert.ok(!serialized.includes("\"roi\""));
  assert.ok(!serialized.includes("\"pnl\""));
  assert.ok(!serialized.includes("profit"));

  assert.equal(typeof diagnostics.totalRows, "number");
  assert.equal(typeof diagnostics.rowsWithFormulaVersion, "number");
  assert.equal(typeof diagnostics.rowsMissingFormulaVersion, "number");
  assert.equal(typeof diagnostics.rowsWithScore, "number");
  assert.equal(typeof diagnostics.rowsWithCoverage, "number");
  assert.equal(typeof diagnostics.rowsWithEventGroupCandidate, "number");
  assert.equal(typeof diagnostics.outcomeQuirkRiskRows, "number");
  assert.ok(Array.isArray(diagnostics.notes));
});

test("does not mutate input rows", () => {
  const rows: ExportRow[] = [
    { id: "a", formula_version: "trusted-initial-formula-v1.1", signal_result: "won" },
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));

  validateGeneratedSignalPairsExportRows(rows);

  assert.deepEqual(rows, snapshot);
});

test("totalRows matches input row count", () => {
  const rows: ExportRow[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);
  assert.equal(diagnostics.totalRows, 3);
});

test("detects duplicate strict dedup keys by condition_id + token_id", () => {
  const rows: ExportRow[] = [
    { id: "A", condition_id: "c1", token_id: "t1" },
    { id: "B", condition_id: "c1", token_id: "t1" },
    { id: "C", condition_id: "c2", token_id: "t1" },
  ];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);

  assert.equal(diagnostics.duplicateStrictKeyRows, 1);
  assert.equal(diagnostics.uniqueStrictDedupKeys, 2);
});

test("counts additional duplicate rows past the first occurrence", () => {
  const rows: ExportRow[] = [
    { id: "A", condition_id: "c1", token_id: "t1" },
    { id: "B", condition_id: "c1", token_id: "t1" },
    { id: "C", condition_id: "c1", token_id: "t1" },
  ];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);

  assert.equal(diagnostics.duplicateStrictKeyRows, 2);
  assert.equal(diagnostics.uniqueStrictDedupKeys, 1);
});

test("counts rows missing strict dedup key as rowsMissingStrictDedupKey", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1" },
    { id: "b", condition_id: "c1" }, // missing token
    { id: "c", token_id: "t1" }, // missing condition
    { id: "d" }, // missing both
  ];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);

  assert.equal(diagnostics.rowsMissingStrictDedupKey, 3);
});

test("does not count rows with same condition_id but different token_id as duplicate", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1" },
    { id: "b", condition_id: "c1", token_id: "t2" },
  ];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);

  assert.equal(diagnostics.duplicateStrictKeyRows, 0);
  assert.equal(diagnostics.uniqueStrictDedupKeys, 2);
});

test("supports camelCase aliases conditionId/tokenId for strict dedup key", () => {
  const row: ExportRow = { conditionId: "c1", tokenId: "t1" };
  assert.equal(getStrictDedupKeyForExportRow(row), "c1::t1");

  const rows: ExportRow[] = [
    { id: "a", conditionId: "c1", tokenId: "t1" },
    { id: "b", condition_id: "c1", token_id: "t1" },
  ];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);
  assert.equal(diagnostics.duplicateStrictKeyRows, 1);
});

test("getStrictDedupKeyForExportRow returns null when condition or token is missing/blank", () => {
  assert.equal(getStrictDedupKeyForExportRow({ condition_id: "c1" }), null);
  assert.equal(getStrictDedupKeyForExportRow({ token_id: "t1" }), null);
  assert.equal(getStrictDedupKeyForExportRow({ condition_id: "  ", token_id: "t1" }), null);
  assert.equal(getStrictDedupKeyForExportRow({}), null);
});

test("hasDuplicateStrictKeyRisk is true when duplicateStrictKeyRows > 0", () => {
  const duplicateRows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1" },
    { id: "b", condition_id: "c1", token_id: "t1" },
  ];
  assert.equal(validateGeneratedSignalPairsExportRows(duplicateRows).hasDuplicateStrictKeyRisk, true);

  const cleanRows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1" },
    { id: "b", condition_id: "c2", token_id: "t1" },
  ];
  assert.equal(validateGeneratedSignalPairsExportRows(cleanRows).hasDuplicateStrictKeyRisk, false);
});

test("duplicate diagnostics fields contain no ROI/PnL/profit keys", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1" },
    { id: "b", condition_id: "c1", token_id: "t1" },
  ];
  const diagnostics = validateGeneratedSignalPairsExportRows(rows);

  const serialized = JSON.stringify(diagnostics).toLowerCase();
  assert.ok(!serialized.includes("\"roi\""));
  assert.ok(!serialized.includes("\"pnl\""));
  assert.ok(!serialized.includes("profit"));
});

test("duplicate detection does not mutate input rows", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1" },
    { id: "b", condition_id: "c1", token_id: "t1" },
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));

  validateGeneratedSignalPairsExportRows(rows);

  assert.deepEqual(rows, snapshot);
});
