// Phase 3D.2R -- Data Integrity Notebook/report tests.
//
// Fixtures stand in for the two canonical local exports
// (generated_signal_pairs_corpus_audit.json,
// generated_signal_pairs_formula_cohort_comparison.json) since neither
// exists in this sandbox. Shapes mirror the real generators
// (audit-generated-signal-pairs-corpus.ts, compare-formula-cohorts.ts)
// exactly so the report builder is exercised against the real contract.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDataIntegrityReportModel,
  DataIntegrityContractError,
  parseCanonicalReportJson,
  renderDataIntegrityHtml,
  validateDataIntegrityContract,
  type DataIntegrityInputs,
} from "../../lib/modeling/dataIntegrityReport";
import type { FlatStakeRoiSummary } from "../../lib/modeling/roiPnlContract";

function makeRoi(overrides: Partial<FlatStakeRoiSummary> = {}): FlatStakeRoiSummary {
  return {
    roiState: "READY",
    inputRows: 10,
    validBetCount: 10,
    winCount: 6,
    lossCount: 4,
    rowsExcludedUnresolved: 0,
    rowsInvalidMissingReturn: 0,
    rowsInvalidEntryPrice: 0,
    rowsInvalidResultLabel: 0,
    rowsUsedRealizedReturnPct: 0,
    rowsDerivedFromEntryPrice: 10,
    stakeUnits: 1,
    totalStakeUnits: 10,
    totalPnlUnits: 0.5,
    roiPct: 5,
    averageReturnPct: 0.5,
    winRatePct: 60,
    lossRatePct: 40,
    ...overrides,
  } as FlatStakeRoiSummary;
}

function makeCorpusAudit(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sourceRows: 42088,
    dedupPolicy: "STRICT_CONDITION_TOKEN",
    dedupRows: 1657,
    droppedDuplicateRows: 40431,
    rawCoverage: { minResolvedAt: "2024-01-01T00:00:00Z", maxResolvedAt: "2024-02-15T00:00:00Z", calendarDaysInclusive: 46, rowsWithInvalidOrMissingResolvedAt: 0 },
    dedupCoverage: { minResolvedAt: "2024-01-01T00:00:00Z", maxResolvedAt: "2024-02-15T00:00:00Z", calendarDaysInclusive: 46, rowsWithInvalidOrMissingResolvedAt: 0 },
    trustedFormula: {
      formulaVersion: "trusted-initial-formula-v1.1",
      selectedRows: 1252,
      rejectedRows: 405,
      minResolvedAt: "2024-01-01T00:00:00Z",
      maxResolvedAt: "2024-02-15T00:00:00Z",
      calendarDaysInclusive: 46,
      rowsWithInvalidOrMissingResolvedAt: 0,
    },
    formulaVersionBreakdown: [],
    metricFormulaVersionBreakdown: [
      { formulaVersion: "v2-lite-growth-safe", rows: 1252, pctOfDedupRows: 75.6, minResolvedAt: null, maxResolvedAt: null },
    ],
    cardinality: {
      uniqueStrictMarketOutcomeSignals: 1657,
      uniqueMarkets: 1489,
      uniqueSportingEvents: 1048,
      rowsMissingMarketIdentity: 0,
      rowsMissingEventIdentity: 0,
    },
    signalsPerSportingEvent: { eventCount: 1048, min: 1, median: 1, p75: 2, p90: 3, max: 21, eventsWithMoreThanOneSignal: 288 },
    eventGrouping: { priority: ["event_slug"], fallbackUsage: {} },
    eventIdentityEvidence: {
      rowsByConfidenceClass: { STRONG: 0, MEDIUM: 1657, WEAK: 0, MISSING: 0, CONFLICT: 0 },
      rowsBySourceField: { event_slug: 1657 },
      rowsBySourceLocation: { top_level: 1657 },
      conflictRows: 0,
      identityReadyRows: 1657,
      workingEventCount: 1048,
      strongIdentityEventCount: 0,
      mediumOrBetterEventCount: 1048,
      weakFallbackEventCount: 0,
      oneEventComparatorReady: false,
      status: "NEEDS_FOUNDER_POLICY",
      blockingReasons: ["no_project_defined_readiness_threshold"],
    },
    ...overrides,
  };
}

function makeFormulaCohort(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    canonicalCorpus: {
      dedupPolicy: "STRICT_CONDITION_TOKEN",
      sourceRows: 42088,
      dedupRows: 1657,
      retainedRows: 1657,
      droppedForFormulaVersion: 0,
    },
    allDedupControl: { cohortId: "ALL_DEDUP_ROWS_CONTROL", rows: 1657, roi: makeRoi({ inputRows: 1657, validBetCount: 1657 }) },
    formulaVersionCohorts: [
      {
        cohortId: "formula_version:trusted-initial-formula-v1.1",
        dimension: "formula_version",
        value: "trusted-initial-formula-v1.1",
        membershipReason: "formula_lineage",
        qualityVerdict: "NOT_INFERRED_FROM_VERSION",
        rows: 1252,
        roi: makeRoi({ inputRows: 1252, validBetCount: 1252 }),
      },
      {
        cohortId: "formula_version:shadow-strategic-sports-v1",
        dimension: "formula_version",
        value: "shadow-strategic-sports-v1",
        membershipReason: "formula_lineage",
        qualityVerdict: "NOT_INFERRED_FROM_VERSION",
        rows: 300,
        roi: makeRoi({ inputRows: 300, validBetCount: 300, roiPct: -3.2, totalPnlUnits: -9.6 }),
      },
      {
        cohortId: "formula_version:shadow-firemodel1_1_research_v0",
        dimension: "formula_version",
        value: "shadow-firemodel1_1_research_v0",
        membershipReason: "formula_lineage",
        qualityVerdict: "NOT_INFERRED_FROM_VERSION",
        rows: 105,
        roi: makeRoi({ inputRows: 105, validBetCount: 105 }),
      },
    ],
    metricFormulaVersionCohorts: [
      {
        cohortId: "metric_formula_version:v2-lite-growth-safe",
        dimension: "metric_formula_version",
        value: "v2-lite-growth-safe",
        membershipReason: "formula_lineage",
        qualityVerdict: "NOT_INFERRED_FROM_VERSION",
        rows: 1252,
        roi: makeRoi({ inputRows: 1252, validBetCount: 1252 }),
      },
      {
        cohortId: "metric_formula_version:UNKNOWN_OR_MISSING",
        dimension: "metric_formula_version",
        value: "UNKNOWN_OR_MISSING",
        membershipReason: "formula_lineage",
        qualityVerdict: "NOT_INFERRED_FROM_VERSION",
        rows: 405,
        roi: makeRoi({ inputRows: 405, validBetCount: 405 }),
      },
    ],
    ...overrides,
  };
}

function makeInputs(overrides: {
  corpusAudit?: Record<string, unknown>;
  formulaCohort?: Record<string, unknown>;
} = {}): DataIntegrityInputs {
  return {
    corpusAuditPath: "modeling/local_exports/generated_signal_pairs_corpus_audit.json",
    corpusAudit: makeCorpusAudit(overrides.corpusAudit) as any,
    formulaCohortPath: "modeling/local_exports/generated_signal_pairs_formula_cohort_comparison.json",
    formulaCohort: makeFormulaCohort(overrides.formulaCohort) as any,
  };
}

// ---- Loader contract ----

test("1. loader rejects a missing/invalid corpus audit input with JSON parse error context", () => {
  assert.throws(
    () => parseCanonicalReportJson("not json", "modeling/local_exports/generated_signal_pairs_corpus_audit.json"),
    (error: unknown) => {
      assert.ok(error instanceof DataIntegrityContractError);
      assert.equal(error.inputArtifactPath, "modeling/local_exports/generated_signal_pairs_corpus_audit.json");
      assert.equal(error.contractField, "json");
      return true;
    },
  );
});

test("2. loader rejects a missing/invalid cohort report input with JSON parse error context", () => {
  assert.throws(
    () => parseCanonicalReportJson("[]", "modeling/local_exports/generated_signal_pairs_formula_cohort_comparison.json"),
    (error: unknown) => {
      assert.ok(error instanceof DataIntegrityContractError);
      assert.equal(error.contractField, "root");
      return true;
    },
  );
});

test("3. schemaVersion mismatch fails explicitly with expected vs actual", () => {
  assert.throws(
    () =>
      parseCanonicalReportJson(
        JSON.stringify({ schemaVersion: 2 }),
        "modeling/local_exports/generated_signal_pairs_corpus_audit.json",
      ),
    (error: unknown) => {
      assert.ok(error instanceof DataIntegrityContractError);
      assert.equal(error.contractField, "schemaVersion");
      assert.equal(error.expected, 1);
      assert.equal(error.actual, 2);
      return true;
    },
  );
});

test("19. invalid JSON fails with useful context (input path present)", () => {
  assert.throws(() => parseCanonicalReportJson("{", "some/path.json"), (error: unknown) => {
    assert.ok(error instanceof DataIntegrityContractError);
    assert.equal(error.inputArtifactPath, "some/path.json");
    assert.equal(error.phase, "3D.2R");
    return true;
  });
});

// ---- Contract validation ----

test("4. canonical retained rows must equal dedup rows", () => {
  const violations = validateDataIntegrityContract(makeInputs());
  assert.deepEqual(violations, []);
});

test("4b. retainedRows !== dedupRows is reported as a violation", () => {
  const inputs = makeInputs({ formulaCohort: { canonicalCorpus: { ...makeFormulaCohort().canonicalCorpus, retainedRows: 1600 } } });
  const violations = validateDataIntegrityContract(inputs);
  assert.ok(violations.some((v) => v.contractField === "canonicalCorpus.retainedRows"));
});

test("5. droppedForFormulaVersion must be zero", () => {
  const inputs = makeInputs({ formulaCohort: { canonicalCorpus: { ...makeFormulaCohort().canonicalCorpus, droppedForFormulaVersion: 3 } } });
  const violations = validateDataIntegrityContract(inputs);
  assert.ok(violations.some((v) => v.contractField === "canonicalCorpus.droppedForFormulaVersion"));
});

test("6. cohort row counts must sum to dedup rows", () => {
  const fc = makeFormulaCohort();
  (fc.formulaVersionCohorts as any[])[0].rows = 1; // break the sum
  const inputs = makeInputs({ formulaCohort: fc });
  const violations = validateDataIntegrityContract(inputs);
  assert.ok(violations.some((v) => v.contractField === "formulaVersionCohorts[].rows(sum)"));
});

test("7. all-dedup control rows equal dedup rows", () => {
  const fc = makeFormulaCohort();
  (fc.allDedupControl as any).rows = 1;
  const inputs = makeInputs({ formulaCohort: fc });
  const violations = validateDataIntegrityContract(inputs);
  assert.ok(violations.some((v) => v.contractField === "allDedupControl.rows"));
});

test("20. report generator contract validation surfaces every violation (non-zero-exit-worthy)", () => {
  const fc = makeFormulaCohort();
  (fc.canonicalCorpus as any).droppedForFormulaVersion = 1;
  (fc.allDedupControl as any).rows = 1;
  const violations = validateDataIntegrityContract(makeInputs({ formulaCohort: fc }));
  assert.ok(violations.length >= 2);
});

// ---- Report model ----

test("8. formula and metric-formula dimensions remain separate in the model", () => {
  const model = buildDataIntegrityReportModel(makeInputs());
  assert.equal(model.formulaVersionCohorts[0].dimension, "formula_version");
  assert.equal(model.metricFormulaVersionCohorts[0].dimension, "metric_formula_version");
  const formulaValues = model.formulaVersionCohorts.map((c) => c.value);
  const metricValues = model.metricFormulaVersionCohorts.map((c) => c.value);
  assert.notDeepEqual(formulaValues, metricValues);
});

test("9. negative ROI values display accurately in rendered HTML", () => {
  const model = buildDataIntegrityReportModel(makeInputs());
  const html = renderDataIntegrityHtml(model);
  assert.ok(html.includes("-3.2"));
  assert.ok(html.includes("-9.6"));
});

test("10. no automatic ranking/champion-selection text appears anywhere in the model or HTML", () => {
  // "Champion/model promotion" is the required BLOCKED readiness gate label
  // itself -- not a ranking claim -- so it is excluded from this check.
  const model = buildDataIntegrityReportModel(makeInputs());
  const html = renderDataIntegrityHtml(model);
  const forbidden = /best cohort|winner cohort|top[- ]performing|declares? a champion|champion cohort/i;
  assert.equal(forbidden.test(JSON.stringify(model)), false);
  assert.equal(forbidden.test(html), false);
  for (const cohort of [...model.formulaVersionCohorts, ...model.metricFormulaVersionCohorts]) {
    assert.equal(cohort.qualityVerdict, "NOT_INFERRED_FROM_VERSION");
  }
});

test("11. STRONG=0 is displayed explicitly", () => {
  const model = buildDataIntegrityReportModel(makeInputs());
  assert.equal(model.eventIdentityEvidence.rowsByConfidenceClass.STRONG, 0);
  const html = renderDataIntegrityHtml(model);
  assert.match(html, /STRONG<\/td><td>0/);
});

test("12. event_slug-only identity warning is displayed", () => {
  const model = buildDataIntegrityReportModel(makeInputs());
  const html = renderDataIntegrityHtml(model);
  assert.ok(html.includes("not production-grade event identity proof"));
});

test("13. exploratory readiness differs from production readiness", () => {
  const model = buildDataIntegrityReportModel(makeInputs());
  const exploratory = model.readinessGates.find((g) => g.gate === "Event identity for exploratory analysis");
  const production = model.readinessGates.find((g) => g.gate === "Event identity for production promotion");
  assert.equal(exploratory?.verdict, "PASS_WITH_LIMITATION");
  assert.equal(production?.verdict, "BLOCKED");
  assert.notEqual(exploratory?.verdict, production?.verdict);
});

test("14. generated output is deterministic for identical input", () => {
  const inputs = makeInputs();
  const modelA = buildDataIntegrityReportModel(inputs);
  const modelB = buildDataIntegrityReportModel(inputs);
  assert.equal(renderDataIntegrityHtml(modelA), renderDataIntegrityHtml(modelB));
});

test("15. no raw row arrays or secret-shaped values are embedded in the model", () => {
  const model = buildDataIntegrityReportModel(makeInputs());
  const serialized = JSON.stringify(model);
  assert.equal(/SUPABASE_(URL|SERVICE_ROLE_KEY)/i.test(serialized), false);
  assert.equal(/condition_id|token_id/i.test(serialized), false);
});

test("17. report builder never recomputes ROI -- it only forwards the cohort roi objects", () => {
  const inputs = makeInputs();
  const model = buildDataIntegrityReportModel(inputs);
  assert.equal(model.allDedupControl.roi, inputs.formulaCohort.allDedupControl.roi);
});

test("proof: all 1,657 retained rows survive into the executive summary", () => {
  const model = buildDataIntegrityReportModel(makeInputs());
  assert.equal(model.executiveSummary.retainedRows, 1657);
  assert.equal(model.executiveSummary.dedupRows, 1657);
  assert.equal(model.executiveSummary.droppedForFormulaVersion, 0);
});

test("proof: dataset funnel never shows a trusted-only subset as the final dataset size", () => {
  const model = buildDataIntegrityReportModel(makeInputs());
  const finalStage = model.datasetFunnel[model.datasetFunnel.length - 1];
  assert.notEqual(finalStage.rows, 1252);
  const retainedStage = model.datasetFunnel.find((f) => f.stage === "retained canonical rows");
  assert.equal(retainedStage?.rows, 1657);
});
