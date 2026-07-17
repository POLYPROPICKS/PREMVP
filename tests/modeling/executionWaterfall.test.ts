import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildExecutionWaterfall } from "../../lib/modeling/executionWaterfall";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const frozen = "C:/WORK/KalshiProPulse/modeling-snapshots/2026-07-15_b2f5dfb5963e/generated_signal_pairs_export.json";

function waterfallFixture(id: string, overrides: Record<string, unknown> = {}) {
  const conditionId = `0xcondition-${id}`;
  const tokenId = `token-${id}`;
  const start = "2026-06-20T12:00:00.000Z";
  return {
    id,
    condition_id: conditionId,
    token_id: tokenId,
    created_at: "2026-06-20T10:30:00.000Z",
    resolved_at: "2026-06-21T12:00:00.000Z",
    formula_version: "trusted-initial-formula-v1.1",
    metric_formula_version: "v2-lite-growth-safe",
    score: 80,
    pre_event_score_num: 80,
    signal_result: "won",
    entry_price_num: 0.5,
    realized_return_pct: 100,
    event_slug: "Knicks vs. Cavaliers",
    market_slug: `fixture-market-${id}`,
    diagnostics: {
      conditionId,
      formulaUsed: "trusted-initial-formula-v1.1",
      currentPrice: 0.5,
      dataCoverage: 80,
      gameStartIso: start,
      selectedTokenId: tokenId,
    },
    ...overrides,
  };
}

test("frozen execution waterfall reconciles independent latest-base and T90 sets", () => {
  const rows = JSON.parse(readFileSync(frozen, "utf8"));
  const result = buildExecutionWaterfall(rows, loadExecutableFunnelClassifier());
  assert.equal(result.rawSnapshots, 49_400);
  assert.equal(result.baseModelRows, 549);
  assert.equal(result.t90QualifiedRows, 362);
  assert.equal(result.cohortReconciliation.retainedCount, 341);
  assert.equal(result.cohortReconciliation.baseOnlyExitCount, 208);
  assert.equal(result.cohortReconciliation.t90OnlyEntrantCount, 21);
  assert.equal(result.cohortReconciliation.unionCount, 570);
  assert.equal(549, 341 + 208);
  assert.equal(362, 341 + 21);
  assert.equal(570, 341 + 208 + 21);
  assert.equal(result.derivedSportingMatchGroups, 271);
  assert.equal(result.controlExecuted, 177);
  assert.equal(result.controlRejected, 94);
  assert.equal(Object.values(result.exitReasons).reduce((a, b) => a + b.count, 0), 208);
  assert.equal(Object.values(result.entrantReasons).reduce((a, b) => a + b.count, 0), 21);
  assert.equal(result.derivedSportingMatchGroups + result.marketsRankedOutInsideMatches + result.rowsRejectedNoMatchIdentity, 362);
  assert.equal(result.terminalIdentityCount, 570);
  assert.equal(result.reconciliationOverlapCount, 0);
});

test("input permutation does not change reconciliation", () => {
  const rows = JSON.parse(readFileSync(frozen, "utf8"));
  const classifier = loadExecutableFunnelClassifier();
  const a = buildExecutionWaterfall(rows, classifier);
  const b = buildExecutionWaterfall([...rows].reverse(), classifier);
  assert.deepEqual(a.cohortReconciliation, b.cohortReconciliation);
  assert.deepEqual(a.exitReasons, b.exitReasons);
  assert.deepEqual(a.entrantReasons, b.entrantReasons);
});

test("duplicate market attribution is explicitly non-independent", () => {
  const rows = JSON.parse(readFileSync(frozen, "utf8"));
  const result = buildExecutionWaterfall(rows, loadExecutableFunnelClassifier());
  assert.equal(result.duplicateMarketCounterfactual.label, "NON-INDEPENDENT COUNTERFACTUAL");
  assert.equal(result.duplicateMarketCounterfactual.includedInCanonicalTotal, false);
});

test("all frozen finalist model filters reproduce exact T90 and one-match cohorts", () => {
  const rows = JSON.parse(readFileSync(frozen, "utf8"));
  const classifier = loadExecutableFunnelClassifier();
  const expected = {
    B2_PRICE_FLOOR_030_TIMING_WITHIN_120M: [549, 362, 271, 53],
    B2_TIMING_WITHIN_120M: [570, 377, 276, 59],
    B2_PRICE_FLOOR_030: [822, 594, 318, 129],
    ALT2_TS_SCORE_GE_65: [1110, 889, 334, 400],
  } as const;
  for (const [model, counts] of Object.entries(expected)) {
    const result = buildExecutionWaterfall(rows, classifier, model as keyof typeof expected);
    assert.deepEqual([result.baseModelRows, result.t90QualifiedRows, result.executionCandidates.length, result.rowsRejectedNoMatchIdentity], counts, model);
  }
});

test("T90 exact boundary is eligible and a snapshot one millisecond after it cannot displace it", () => {
  const exact = waterfallFixture("t90-exact");
  const justAfter = waterfallFixture("t90-just-after", {
    condition_id: exact.condition_id,
    token_id: exact.token_id,
    created_at: "2026-06-20T10:30:00.001Z",
    diagnostics: { ...exact.diagnostics, selectedTokenId: exact.token_id },
  });
  const result = buildExecutionWaterfall([exact, justAfter], loadExecutableFunnelClassifier());

  assert.equal(result.t90QualifiedRows, 1);
  assert.deepEqual(result.selectedWinners.map((winner) => winner.observationId), ["t90-exact"]);
});

test("physical-event ranking resolves an otherwise exact tie with the canonical observation-id tie-breaker", () => {
  const laterId = waterfallFixture("tie-z");
  const earlierId = waterfallFixture("tie-a");
  const result = buildExecutionWaterfall([laterId, earlierId], loadExecutableFunnelClassifier());

  assert.equal(result.derivedSportingMatchGroups, 1);
  assert.equal(result.selectedWinners.length, 1);
  assert.deepEqual(result.selectedWinners.map((winner) => winner.observationId), ["tie-a"]);
});

test("one physical event retains one deterministic winner when a higher-priority ranking field reverses", () => {
  const lowerScore = waterfallFixture("reverse-a", { score: 80, pre_event_score_num: 80 });
  const higherScore = waterfallFixture("reverse-z", { score: 81, pre_event_score_num: 81 });
  const classifier = loadExecutableFunnelClassifier();
  const forward = buildExecutionWaterfall([lowerScore, higherScore], classifier);
  const reversed = buildExecutionWaterfall([higherScore, lowerScore], classifier);

  assert.equal(forward.selectedWinners.length, 1);
  assert.deepEqual(forward.selectedWinners.map((winner) => winner.observationId), ["reverse-z"]);
  assert.deepEqual(reversed.selectedWinners, forward.selectedWinners);
});
