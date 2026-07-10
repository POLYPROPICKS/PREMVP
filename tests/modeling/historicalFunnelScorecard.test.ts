// Phase 3E.6 Commit C -- founder scorecard tests.
//
// The scorecard renders a deterministic, founder-readable report from an
// already-computed comparison + manifest + classifier. It does NOT recompute
// model predicates; it validates that comparison and manifest reference the
// same corpus, then presents the executive table, funnel attrition, baseline
// deltas, formula-vs-policy separation, historical-vs-normalized stake, the
// excluded/blocked variants, and a bounded founder review packet. No
// Champion/winner/promote/significance claims; no raw rows or secrets.

import test from "node:test";
import assert from "node:assert/strict";
import {
  renderHistoricalFunnelScorecard,
} from "../../lib/modeling/historicalFunnelScorecard";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { compareHistoricalFunnelVariants, LOCKED_EXECUTION_SET } from "../../lib/modeling/historicalFunnelComparison";
import { buildEvaluationRunManifest, type ManifestInputs } from "../../lib/modeling/evaluationRunManifest";

const classifier = loadExecutableFunnelClassifier();

const REQUESTED = [
  ...LOCKED_EXECUTION_SET,
  "MODEL_A",
  "ALT1_PY_EVENT_KEY_VARIANT",
  "ALT1_ONE_PER_EVENT_BEST_COVERAGE",
  "CHAMPION_CURRENT",
  "FIRE_MODEL_1_LOCKED",
];

function rows(): Record<string, unknown>[] {
  return [
    { id: "1", condition_id: "c1", token_id: "t1", resolved_at: "2026-05-01T00:00:00Z", signal_confidence_num: 80, signal_result: "win", realized_return_pct: 40, entry_price_num: 0.5, diagnostics: { dataCoverage: 80 } },
    { id: "2", condition_id: "c2", token_id: "t2", resolved_at: "2026-05-02T00:00:00Z", signal_confidence_num: 70, signal_result: "loss", smart_money_score_num: 90, entry_price_num: 0.5, diagnostics: { dataCoverage: 80 } },
    { id: "3", condition_id: "c3", token_id: "t3", resolved_at: "2026-05-03T00:00:00Z", signal_confidence_num: 70, signal_result: "win", realized_return_pct: 20, event_slug: "nba-lakers", entry_price_num: 0.5, diagnostics: { dataCoverage: 80 } },
  ];
}

const comparison = compareHistoricalFunnelVariants({ rows: rows(), classifier, requestedVariantIds: REQUESTED });
const inputSha = "a".repeat(64);
const classifierSha = "b".repeat(64);
const comparisonWithHash = { ...comparison, inputSha256: inputSha, classifierSha256: classifierSha };

function manifest() {
  const inputs: ManifestInputs = {
    gitCommit: "abc1234", gitBranch: "test-branch",
    inputArtifactPath: "modeling/local_exports/generated_signal_pairs_export.json",
    inputSha256: inputSha, inputRowCount: 3,
    inputFirstResolvedAt: comparison.corpus.firstResolvedAt, inputLastResolvedAt: comparison.corpus.lastResolvedAt,
    dedupPolicy: "strict_latest_created_before_resolved",
    classifierPath: "modeling/model_registry/executable_funnel_classifier.json",
    classifierSha256: classifierSha, classifierSchemaVersion: 1,
    comparisonEngineVersion: comparison.comparisonEngineVersion,
    requestedVariantIds: REQUESTED, executedVariantIds: [],
    skippedVariantsAndReasons: [], normalizedStakePolicy: { unit: "FLAT_1_UNIT", plainLanguage: "1 unit" },
    roiContractSource: "lib/modeling/roiPnlContract.ts", eventIdentityPolicy: "MEDIUM exploratory only",
    knownLimitations: ["ALT1 exploratory"], commands: ["cmd"], createdAt: "2026-07-10T00:00:00Z",
  };
  return buildEvaluationRunManifest(inputs);
}

const html = renderHistoricalFunnelScorecard({ comparison: comparisonWithHash, manifest: manifest(), classifier });

test("S1: comparison and manifest input hashes must agree (else throws)", () => {
  const badManifest = { ...manifest(), inputSha256: "z".repeat(64) };
  assert.throws(() => renderHistoricalFunnelScorecard({ comparison: comparisonWithHash, manifest: badManifest, classifier }), /hash|mismatch/i);
});

test("S2: an invalid comparison/manifest pair is rejected", () => {
  assert.throws(() => renderHistoricalFunnelScorecard({ comparison: { ...comparisonWithHash, inputSha256: "x".repeat(64) }, manifest: manifest(), classifier }), /hash|mismatch/i);
});

test("S3: all requested variants appear in the report", () => {
  for (const id of REQUESTED) {
    assert.ok(html.includes(id), `missing ${id}`);
  }
});

test("S4: MODEL_A alias is not duplicated as a second result row", () => {
  // MODEL_A appears (as a skipped duplicate), but not with executed metrics.
  const modelA = comparison.executions.find((e) => e.variantId === "MODEL_A");
  assert.equal(modelA!.evaluationStatus, "SKIPPED_DUPLICATE_ALIAS");
  assert.ok(html.includes("SKIPPED_DUPLICATE_ALIAS"));
});

test("S5: table contains exact normalized metrics for BASELINE", () => {
  const base = comparison.executions.find((e) => e.variantId === "BASELINE_V1_CONTROL")!;
  assert.ok(html.includes(String(base.metrics!.outputRows)));
});

test("S6: blocked variants remain visible", () => {
  assert.ok(html.includes("ALT1_PY_EVENT_KEY_VARIANT"));
  assert.ok(/BLOCKED_MISSING_FIELD/.test(html));
});

test("S7: ambiguous aliases are not treated as results", () => {
  assert.ok(/SKIPPED_AMBIGUOUS_ALIAS/.test(html));
});

test("S8: PRIMARY approximation limitation is shown", () => {
  assert.ok(/RUNNABLE_APPROX_ONLY|приблизит|approxim/i.test(html));
});

test("S9: ALT1 canonical identity limitation is shown", () => {
  assert.ok(/exploratory|исследователь|MEDIUM/i.test(html));
});

test("S10: historical and normalized stake are separated", () => {
  assert.ok(/FLAT_1_UNIT|1 единиц/i.test(html));
  assert.ok(/FLAT_10_USD|\$10|TIERED/i.test(html));
});

test("S11: formula and external policy are separated (v2-lite explanation present)", () => {
  assert.ok(/v2-lite-growth-safe/i.test(html));
  assert.ok(/smart money|smart_money/i.test(html));
});

test("S12: baseline deltas render", () => {
  assert.ok(/vs baseline|vs BASELINE|baselineDelta|против базовой|дельта/i.test(html));
});

test("S13: funnel step attrition renders with input/passed/removed", () => {
  assert.ok(/Passed|Removed|Прош|Удал/i.test(html));
});

test("S14: no Champion / winner / promote claim appears", () => {
  assert.doesNotMatch(html, /\bchampion\b|\bwinner\b|\bpromote\b|\bбест\b/i);
});

test("S15: no statistical significance claim appears", () => {
  assert.doesNotMatch(html, /statistically significant|p-value|significance|статистическ[а-я]* значим/i);
});

test("S16: no raw corpus rows are embedded", () => {
  assert.doesNotMatch(html, /realized_return_pct|"signal_result"/);
});

test("S17: no secrets/env values are embedded", () => {
  assert.doesNotMatch(html, /SUPABASE_URL|SERVICE_ROLE|apikey|bearer|eyJ[A-Za-z0-9]/i);
});

test("S18: report is deterministic for stable inputs", () => {
  const again = renderHistoricalFunnelScorecard({ comparison: comparisonWithHash, manifest: manifest(), classifier });
  assert.equal(html, again);
});

test("S19: report can be generated without DB/network (env unchanged)", () => {
  const before = JSON.stringify(process.env);
  renderHistoricalFunnelScorecard({ comparison: comparisonWithHash, manifest: manifest(), classifier });
  assert.equal(JSON.stringify(process.env), before);
});

test("S20: founder review packet uses NOT_REVIEWED disposition, never PROMOTE/CHAMPION/WINNER", () => {
  assert.ok(html.includes("NOT_REVIEWED"));
  assert.doesNotMatch(html, /disposition[^<]*(PROMOTE|CHAMPION|WINNER)/i);
});
