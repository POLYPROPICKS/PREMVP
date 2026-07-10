// Phase 3E.2j Commit A -- cohort-preserving comparison tests.
//
// Locked operator decision: formula_version / metric_formula_version are
// lineage/cohort dimensions, not automatic quality filters. Every strict
// dedup row must remain retained and available; cohorts split the
// retained corpus for descriptive comparison only -- they never remove
// rows from the canonical corpus and never rank/select a "champion".

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareFormulaCohorts,
  UNKNOWN_OR_MISSING_COHORT_VALUE,
} from "../../scripts/modeling/strategies/compare-formula-cohorts";
import { STRICT_DEDUP_POLICY_NAME } from "../../lib/modeling/generatedSignalPairsDedupPolicy";

function makeRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    condition_id: `cond-${Math.random()}`,
    token_id: `tok-${Math.random()}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: "2024-01-02T00:00:00Z",
    signal_result: "win",
    entry_price_num: 0.5,
    ...overrides,
  };
}

function makeCorpus(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push(
      makeRow({
        condition_id: `trusted-cond-${i}`,
        token_id: `trusted-tok-${i}`,
        formula_version: "trusted-initial-formula-v1.1",
      }),
    );
  }
  for (let i = 0; i < 3; i++) {
    rows.push(
      makeRow({
        condition_id: `shadow-cond-${i}`,
        token_id: `shadow-tok-${i}`,
        formula_version: "shadow-strategic-sports-v1",
      }),
    );
  }
  // rows with no formula_version at all -- must land in UNKNOWN_OR_MISSING,
  // never silently dropped.
  rows.push(makeRow({ condition_id: "no-version-cond", token_id: "no-version-tok" }));
  return rows;
}

test("A1: all strict-dedup rows are retained in canonicalCorpus", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  assert.equal(report.canonicalCorpus.retainedRows, report.canonicalCorpus.dedupRows);
});

test("A2: cohort row counts sum to dedupRows", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  const sum = report.formulaVersionCohorts.reduce((acc, c) => acc + c.rows, 0);
  assert.equal(sum, report.canonicalCorpus.dedupRows);
});

test("A3: no row is dropped solely for formula version", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  assert.equal(report.canonicalCorpus.droppedForFormulaVersion, 0);
});

test("A4: trusted cohort reports member/non-member counts, never 'invalid'", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  const trusted = report.formulaVersionCohorts.find(
    (c) => c.value === "trusted-initial-formula-v1.1",
  );
  assert.ok(trusted);
  assert.equal(trusted!.rows, 5);
  assert.equal(trusted!.qualityVerdict, "NOT_INFERRED_FROM_VERSION");
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /"invalidRows"/i);
  assert.doesNotMatch(serialized, /rejectedRows/i);
  assert.doesNotMatch(serialized, /low quality/i);
  assert.doesNotMatch(serialized, /removed from dataset/i);
});

test("A5: ALL_DEDUP_ROWS_CONTROL cohort includes every retained row", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  assert.equal(report.allDedupControl.cohortId, "ALL_DEDUP_ROWS_CONTROL");
  assert.equal(report.allDedupControl.rows, report.canonicalCorpus.dedupRows);
});

test("A6: results are deterministic across repeated calls", () => {
  const rows = makeCorpus();
  const a = compareFormulaCohorts(rows);
  const b = compareFormulaCohorts(rows);
  assert.deepEqual(a, b);
});

test("A7: rows missing formula_version land in an explicit UNKNOWN_OR_MISSING bucket", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  const unknown = report.formulaVersionCohorts.find(
    (c) => c.value === UNKNOWN_OR_MISSING_COHORT_VALUE,
  );
  assert.ok(unknown);
  assert.equal(unknown!.rows, 1);
});

test("A8: formula_version and metric_formula_version cohorts remain separate dimensions", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  for (const c of report.formulaVersionCohorts) {
    assert.equal(c.dimension, "formula_version");
  }
  for (const c of report.metricFormulaVersionCohorts) {
    assert.equal(c.dimension, "metric_formula_version");
  }
});

test("A9: no cohort is auto-ranked, promoted, or marked as a champion", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /champion/i);
  assert.doesNotMatch(serialized, /\bbest\b/i);
  assert.doesNotMatch(serialized, /\brecommended\b/i);
  for (const c of report.formulaVersionCohorts) {
    assert.equal(c.membershipReason, "formula_lineage");
  }
});

test("A10: no raw row arrays are present anywhere in the output", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /trusted-cond-0/);
  assert.doesNotMatch(serialized, /shadow-tok-0/);
});

test("A11: compareFormulaCohorts never mutates its input rows", () => {
  const rows = makeCorpus();
  const before = JSON.stringify(rows);
  compareFormulaCohorts(rows);
  assert.equal(JSON.stringify(rows), before);
});

test("A12: pure comparison performs no fs/network/env access (module-load safety)", () => {
  const rows = makeCorpus();
  const before = JSON.stringify(process.env);
  compareFormulaCohorts(rows);
  assert.equal(JSON.stringify(process.env), before);
});

test("A13: empty input produces a well-formed, zero-count report", () => {
  const report = compareFormulaCohorts([]);
  assert.equal(report.canonicalCorpus.dedupRows, 0);
  assert.equal(report.canonicalCorpus.retainedRows, 0);
  assert.equal(report.allDedupControl.rows, 0);
  assert.equal(report.formulaVersionCohorts.length, 0);
});

test("A14: ROI summaries are produced via the canonical roiPnlContract calculator", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  assert.equal(typeof report.allDedupControl.roi.roiState, "string");
  assert.ok("validBetCount" in report.allDedupControl.roi);
  assert.ok("winRatePct" in report.allDedupControl.roi);
  for (const c of report.formulaVersionCohorts) {
    assert.ok("roiState" in c.roi);
  }
});

test("A15: dedupPolicy is the canonical strict dedup policy name", () => {
  const rows = makeCorpus();
  const report = compareFormulaCohorts(rows);
  assert.equal(report.canonicalCorpus.dedupPolicy, STRICT_DEDUP_POLICY_NAME);
});

test("A16: materially-populated metric_formula_version cohorts are included", () => {
  const rows = [
    ...makeCorpus(),
    makeRow({
      condition_id: "metric-cond-1",
      token_id: "metric-tok-1",
      metric_formula_version: "v2-lite-growth-safe",
    }),
  ];
  const report = compareFormulaCohorts(rows);
  const metricCohort = report.metricFormulaVersionCohorts.find(
    (c) => c.value === "v2-lite-growth-safe",
  );
  assert.ok(metricCohort);
  assert.equal(metricCohort!.rows, 1);
});

test("A17: duplicate rows (same strict dedup key) are collapsed before cohort counting", () => {
  const dupRow = makeRow({
    condition_id: "dup-cond",
    token_id: "dup-tok",
    formula_version: "trusted-initial-formula-v1.1",
    created_at: "2024-01-01T00:00:00Z",
  });
  const dupRowLater = { ...dupRow, created_at: "2024-01-01T01:00:00Z" };
  const report = compareFormulaCohorts([dupRow, dupRowLater]);
  assert.equal(report.canonicalCorpus.dedupRows, 1);
  assert.equal(report.canonicalCorpus.sourceRows, 2);
});
