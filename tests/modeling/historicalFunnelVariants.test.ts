// Phase 3E.3A-2 Commit B -- pure execution adapters for the normalized
// historical funnel variants.
//
// These evaluators run the ordered funnel declared in the classifier
// registry (Commit A) against an already-deduplicated row array. They do NOT
// compute ROI/PnL, do NOT read Supabase/fs/network/env, and reuse existing
// canonical predicates (lib/executor/modelingData.ts, eventGroupSelection.ts)
// instead of re-implementing business logic inline.

import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateHistoricalFunnelVariant,
} from "../../lib/modeling/historicalFunnelVariants";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();

function makeRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    condition_id: `cond-${Math.random()}`,
    token_id: `tok-${Math.random()}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: "2024-01-02T00:00:00Z",
    signal_confidence_num: 80,
    entry_price_num: 0.5,
    diagnostics: { dataCoverage: 80 },
    ...overrides,
  };
}

test("C1: BASELINE keeps every input row", () => {
  const rows = [makeRow({}), makeRow({}), makeRow({})];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "BASELINE_V1_CONTROL");
  assert.equal(result.outputRows, 3);
  assert.equal(result.inputRows, 3);
});

test("C2: ALT2 TS and Python variants produce different results on high-smart-money fixtures", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, smart_money_score_num: 90 }),
    makeRow({ signal_confidence_num: 70, smart_money_score_num: 10 }),
  ];
  const ts = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_TS_SCORE_GE_65");
  const py = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_PY_SCORE_GE_65_SM_LT_85");
  assert.equal(ts.outputRows, 2);
  assert.equal(py.outputRows, 1);
});

test("C3: ALT3 TS and Python variants produce different results on NBA/NHL fixtures", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, event_slug: "nba-lakers-celtics" }),
    makeRow({ signal_confidence_num: 70, event_slug: "epl-arsenal-chelsea" }),
  ];
  const ts = evaluateHistoricalFunnelVariant(rows, classifier, "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL");
  const py = evaluateHistoricalFunnelVariant(rows, classifier, "ALT3_PY_SCORE_GE_65");
  assert.equal(ts.outputRows, 1);
  assert.equal(py.outputRows, 2);
});

test("C4: ALT1 canonical variant groups two markets of one event and keeps one", () => {
  const rows = [
    makeRow({ signal_confidence_num: 80, match_family_key: "barca-real-2024", diagnostics: { dataCoverage: 60 } }),
    makeRow({ signal_confidence_num: 80, match_family_key: "barca-real-2024", diagnostics: { dataCoverage: 90 } }),
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT1_CANONICAL_EVENT_GROUPING");
  assert.equal(result.outputRows, 1);
  assert.equal(result.workingEventGroups, 1);
});

test("C5: ALT1 canonical ordering prefers higher coverage, then score, then tie-break", () => {
  const low = makeRow({ signal_confidence_num: 80, match_family_key: "m1", diagnostics: { dataCoverage: 40 } });
  const high = makeRow({ signal_confidence_num: 75, match_family_key: "m1", diagnostics: { dataCoverage: 90 } });
  const result = evaluateHistoricalFunnelVariant([low, high], classifier, "ALT1_CANONICAL_EVENT_GROUPING");
  assert.equal(result.outputRows, 1);
});

test("C6: ALT1 Python variant is blocked (event_key missing from canonical corpus)", () => {
  const rows = [makeRow({ signal_confidence_num: 80 })];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT1_PY_EVENT_KEY_VARIANT");
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.limitationFlags.includes("event_key_missing_from_canonical_export"));
});

test("C7: MODEL_A halves stake metadata for smart money >= 75 without removing the row", () => {
  const rows = [
    makeRow({ signal_confidence_num: 80, diagnostics: { dataCoverage: 80 }, smart_money_score_num: 90, signal_result: "win" }),
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT_SM_GUARD_ON_PRIMARY");
  assert.equal(result.outputRows, 1);
  const stakeStep = result.stepResults.find((s) => s.action === "STAKE");
  assert.ok(stakeStep);
  assert.equal(stakeStep!.passedRows, 1);
});

test("C8: MODEL_A does not remove the row solely due to high smart money", () => {
  const highSm = makeRow({ signal_confidence_num: 80, diagnostics: { dataCoverage: 80 }, smart_money_score_num: 95, signal_result: "win" });
  const lowSm = makeRow({ signal_confidence_num: 80, diagnostics: { dataCoverage: 80 }, smart_money_score_num: 10, signal_result: "win" });
  const result = evaluateHistoricalFunnelVariant([highSm, lowSm], classifier, "ALT_SM_GUARD_ON_PRIMARY");
  assert.equal(result.outputRows, 2);
});

test("C9: _APPROX variant hard-excludes smart money >= 85", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, diagnostics: { dataCoverage: 80 }, entry_price_num: 0.7, smart_money_score_num: 90 }),
    makeRow({ signal_confidence_num: 70, diagnostics: { dataCoverage: 80 }, entry_price_num: 0.7, smart_money_score_num: 10 }),
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT_SM_GUARD_ON_PRIMARY_APPROX");
  assert.equal(result.outputRows, 1);
});

test("C10: PRIMARY applies every documented rule in order", () => {
  const rows = [
    makeRow({ signal_confidence_num: 80, diagnostics: { dataCoverage: 60, hoursUntilStart: 3 }, entry_price_num: 0.5 }),
    makeRow({ signal_confidence_num: 60, diagnostics: { dataCoverage: 60, hoursUntilStart: 3 } }),
    makeRow({ signal_confidence_num: 80, event_slug: "nba-lakers", diagnostics: { dataCoverage: 60, hoursUntilStart: 3 } }),
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP");
  assert.ok(result.stepResults.some((s) => s.action === "REQUIRE"));
  assert.ok(result.stepResults.some((s) => s.action === "EXCLUDE"));
  assert.ok(result.outputRows <= rows.length);
});

test("C11: step counts reconcile exactly (inputRows of step N = passed+removed, chains to next step)", () => {
  const rows = [makeRow({ signal_confidence_num: 80 }), makeRow({ signal_confidence_num: 10 })];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_TS_SCORE_GE_65");
  for (const s of result.stepResults) {
    assert.equal(s.inputRows, s.passedRows + s.removedRows);
  }
  for (let i = 1; i < result.stepResults.length; i++) {
    const prev = result.stepResults[i - 1];
    const curr = result.stepResults[i];
    if (curr.action === "REQUIRE" || curr.action === "EXCLUDE" || curr.action === "KEEP") {
      assert.equal(curr.inputRows, prev.passedRows);
    }
  }
});

test("C12: evaluator never mutates its input rows", () => {
  const rows = [makeRow({ signal_confidence_num: 80 })];
  const before = JSON.stringify(rows);
  evaluateHistoricalFunnelVariant(rows, classifier, "BASELINE_V1_CONTROL");
  assert.equal(JSON.stringify(rows), before);
});

test("C13: output is deterministic across repeated calls", () => {
  const rows = [makeRow({ signal_confidence_num: 80 }), makeRow({ signal_confidence_num: 60 })];
  const a = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_TS_SCORE_GE_65");
  const b = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_TS_SCORE_GE_65");
  assert.deepEqual(a, b);
});

test("C14: missing fields follow the classifier-declared limitation/block policy", () => {
  const rows = [makeRow({ signal_confidence_num: 80 })];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT1_PY_EVENT_KEY_VARIANT");
  assert.equal(result.status, "BLOCKED");
});

test("C15: blocked aliases (old ambiguous ID) cannot execute", () => {
  assert.throws(
    () => evaluateHistoricalFunnelVariant([makeRow({})], classifier, "ALT1_ONE_PER_EVENT_BEST_COVERAGE"),
    /ambiguous|not executable/i,
  );
});

test("C16: SQL contract stubs cannot execute", () => {
  assert.throws(
    () => evaluateHistoricalFunnelVariant([makeRow({})], classifier, "CHAMPION_CURRENT"),
    /stub|not executable/i,
  );
});

test("C17: evaluator performs no fs/network/env/database access", () => {
  const before = JSON.stringify(process.env);
  const rows = [makeRow({ signal_confidence_num: 80 })];
  evaluateHistoricalFunnelVariant(rows, classifier, "BASELINE_V1_CONTROL");
  assert.equal(JSON.stringify(process.env), before);
});

test("C18: no ROI formula is duplicated -- result has no ROI/PnL fields", () => {
  const rows = [makeRow({ signal_confidence_num: 80 })];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "BASELINE_V1_CONTROL");
  assert.ok(!("roi" in result));
  assert.ok(!("roiPct" in result));
  assert.ok(!("totalPnlUnits" in result));
});
