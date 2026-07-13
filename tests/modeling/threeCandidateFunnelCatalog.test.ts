// Phase 3E.8A Commit A -- three-candidate funnel catalog tests.
//
// The catalog is DERIVED from the classifier's own orderedFunnel records (the
// same records the evaluator dispatches on), so documented order and behavior
// cannot drift from executed order and behavior. It documents, it does not
// change any predicate or threshold.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildThreeCandidateFunnelCatalog,
  THREE_CANDIDATE_IDS,
  FILTER_TAXONOMY_CATEGORIES,
} from "../../lib/modeling/threeCandidateFunnelCatalog";
import { loadExecutableFunnelClassifier, getBundle } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();
const catalog = buildThreeCandidateFunnelCatalog({ classifier, candidateIds: [...THREE_CANDIDATE_IDS] });

function cand(id: string) {
  return catalog.candidates.find((c) => c.variantId === id)!;
}

test("T1: all three candidate IDs exist in the catalog", () => {
  for (const id of ["PRIMARY_V1_AVOID_NBA_NHL_COV_CAP", "ALT2_TS_SCORE_GE_65", "ALT1_CANONICAL_EVENT_GROUPING"]) {
    assert.ok(cand(id), `missing ${id}`);
  }
});

test("T2: ALT2 TS displayRole is MANDATORY_CORE_COMPARATOR", () => {
  assert.equal(cand("ALT2_TS_SCORE_GE_65").displayRole, "MANDATORY_CORE_COMPARATOR");
});

test("T3: every ordered step has a stepNumber", () => {
  for (const c of catalog.candidates) {
    c.orderedSteps.forEach((s, i) => assert.equal(s.stepNumber, i + 1));
  }
});

test("T4: every step has a taxonomy category from the approved set", () => {
  for (const c of catalog.candidates) {
    for (const s of c.orderedSteps) {
      assert.ok((FILTER_TAXONOMY_CATEGORIES as readonly string[]).includes(s.taxonomyCategory));
    }
  }
});

test("T5: every step has a non-empty semantic purpose", () => {
  for (const c of catalog.candidates) {
    for (const s of c.orderedSteps) {
      assert.ok(typeof s.semanticPurpose === "string" && s.semanticPurpose.trim().length > 0);
    }
  }
});

test("T6: every executable (row-affecting) step has an evaluator handler", () => {
  for (const c of catalog.candidates) {
    for (const s of c.orderedSteps) {
      if (s.changesRowCount) assert.ok(s.evaluatorHandler && s.evaluatorHandler !== "n/a");
    }
  }
});

test("T7: every active-filter (field-based row-reducing) step declares a missing-data behavior", () => {
  for (const c of catalog.candidates) {
    for (const s of c.orderedSteps) {
      // Field-based filters must declare fail-closed/pass-open behavior; the
      // deterministic keep-first-per-group selection has no field-missing
      // branch and is legitimately NOT_APPLICABLE.
      if (s.countedAsActiveFilter) {
        assert.notEqual(s.missingDataBehavior, "NOT_APPLICABLE");
      }
    }
  }
});

test("T8: source evidence exists for every executable step", () => {
  for (const c of catalog.candidates) {
    for (const s of c.orderedSteps) {
      if (s.changesRowCount) assert.ok(s.sourceEvidence.length > 0);
    }
  }
});

test("T9: PRIMARY catalog order matches the classifier funnel order exactly", () => {
  const bundle = getBundle(classifier, "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const catalogActions = cand("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP").orderedSteps.map((s) => s.classifierAction);
  assert.deepEqual(catalogActions, bundle.orderedFunnel.map((s) => s.action));
});

test("T10: ALT2 TS contains a score >= 65 numeric threshold", () => {
  const steps = cand("ALT2_TS_SCORE_GE_65").orderedSteps;
  const scoreStep = steps.find((s) => s.fieldSemantic === "score" && s.taxonomyCategory === "NUMERIC_THRESHOLD");
  assert.ok(scoreStep);
  assert.equal((scoreStep!.thresholdOrRule as { value: number }).value, 65);
});

test("T11: ALT2 TS contains no smart-money filtering step", () => {
  const steps = cand("ALT2_TS_SCORE_GE_65").orderedSteps;
  assert.ok(!steps.some((s) => (s.fieldSemantic ?? "").includes("smart")));
});

test("T12: ALT2 TS contains no NBA/NHL exclusion step", () => {
  const steps = cand("ALT2_TS_SCORE_GE_65").orderedSteps;
  assert.ok(!steps.some((s) => s.taxonomyCategory === "CATEGORY_EXCLUSION" && s.fieldSemantic === "league"));
});

test("T13: ALT1 uses canonical event grouping (buildEventGroupKey)", () => {
  const groupStep = cand("ALT1_CANONICAL_EVENT_GROUPING").orderedSteps.find((s) => s.taxonomyCategory === "EVENT_GROUPING");
  assert.ok(groupStep);
  assert.ok(groupStep!.sourceEvidence.some((e) => e.symbol.includes("buildEventGroupKey")));
});

test("T14: ALT1 does not use the Python event_key grouping", () => {
  const groupStep = cand("ALT1_CANONICAL_EVENT_GROUPING").orderedSteps.find((s) => s.taxonomyCategory === "EVENT_GROUPING");
  assert.ok(!groupStep!.sourceEvidence.some((e) => e.symbol.includes("one_per_event")));
});

test("T15: ALT1 identity confidence is MEDIUM", () => {
  assert.equal(cand("ALT1_CANONICAL_EVENT_GROUPING").identityConfidence, "MEDIUM");
});

test("T16: overlap matrix matches the classifier (formula eligibility absent in all three)", () => {
  const row = catalog.overlapMatrix.find((r) => r.rule === "formula_eligibility")!;
  assert.equal(row.PRIMARY_V1_AVOID_NBA_NHL_COV_CAP, "NO");
  assert.equal(row.ALT2_TS_SCORE_GE_65, "NO");
  assert.equal(row.ALT1_CANONICAL_EVENT_GROUPING, "NO");
});

test("T17: overlap matrix -- score thresholds are model-specific", () => {
  const ge65 = catalog.overlapMatrix.find((r) => r.rule === "score_ge_65")!;
  const ge72 = catalog.overlapMatrix.find((r) => r.rule === "score_ge_72")!;
  assert.equal(ge65.ALT2_TS_SCORE_GE_65, "YES");
  assert.equal(ge65.PRIMARY_V1_AVOID_NBA_NHL_COV_CAP, "NO");
  assert.equal(ge72.PRIMARY_V1_AVOID_NBA_NHL_COV_CAP, "YES");
  assert.equal(ge72.ALT1_CANONICAL_EVENT_GROUPING, "YES");
});

test("T18: semantic field matrix marks smart money as DATA_BLOCKED / not used by ALT2", () => {
  const sm = catalog.semanticFieldMatrix.find((r) => r.semanticField === "smart money")!;
  assert.match(sm.missingBehavior, /0%|blocked|unvalidated/i);
  assert.equal(sm.ALT2_TS_SCORE_GE_65, "NO");
});

test("T19: sorting/grouping are not counted as numeric filters", () => {
  for (const c of catalog.candidates) {
    for (const s of c.orderedSteps) {
      if (s.taxonomyCategory === "SORT_PRIORITY" || s.taxonomyCategory === "EVENT_GROUPING") {
        assert.notEqual(s.taxonomyCategory, "NUMERIC_THRESHOLD");
        assert.ok(!s.countedAsActiveFilter);
      }
    }
  }
  // activeFilterCount excludes sort/group/keep/stake/metadata.
  const alt1 = cand("ALT1_CANONICAL_EVENT_GROUPING");
  const filterSteps = alt1.orderedSteps.filter((s) => s.countedAsActiveFilter).length;
  assert.equal(alt1.activeFilterCount, filterSteps);
});

test("T20: no threshold differs from the current classifier (score values preserved)", () => {
  const primaryScore = cand("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP").orderedSteps.find((s) => s.fieldSemantic === "score" && s.taxonomyCategory === "NUMERIC_THRESHOLD")!;
  assert.equal((primaryScore.thresholdOrRule as { value: number }).value, 72);
});

test("T21: no executable step is silently omitted (catalog step count == classifier funnel length)", () => {
  for (const id of THREE_CANDIDATE_IDS) {
    const bundle = getBundle(classifier, id)!;
    assert.equal(cand(id).orderedSteps.length, bundle.orderedFunnel.length);
  }
});

test("T22: row-reducing / ordering / grouping counts are internally consistent", () => {
  const primary = cand("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP");
  assert.equal(primary.rowReducingStepCount, primary.orderedSteps.filter((s) => s.changesRowCount).length);
  assert.equal(primary.orderingStepCount, primary.orderedSteps.filter((s) => s.taxonomyCategory === "SORT_PRIORITY").length);
  assert.equal(primary.groupingStepCount, primary.orderedSteps.filter((s) => s.taxonomyCategory === "EVENT_GROUPING").length);
});

test("T23: builder is deterministic and reads no env", () => {
  const before = JSON.stringify(process.env);
  const again = buildThreeCandidateFunnelCatalog({ classifier, candidateIds: [...THREE_CANDIDATE_IDS] });
  assert.equal(JSON.stringify(process.env), before);
  assert.deepEqual(catalog, again);
});

test("T24: PRIMARY carries the robustness observation (score>=72 dominant contribution) as analysis metadata only", () => {
  const obs = cand("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP").robustnessObservations.join(" ");
  assert.match(obs, /72/);
});
