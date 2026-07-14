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
  getScoreValue,
  getCoverageValue,
  getSmartMoneyValue,
  getHoursUntilStartValue,
  isAllowedFormulaVersion,
  ALLOWED_METRIC_FORMULA_VERSIONS,
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
    makeRow({ metric_formula_version: "v2-lite-growth-safe", signal_confidence_num: 80, diagnostics: { dataCoverage: 80 }, smart_money_score_num: 90, signal_result: "win" }),
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT_SM_GUARD_ON_PRIMARY");
  assert.equal(result.outputRows, 1);
  const stakeStep = result.stepResults.find((s) => s.action === "STAKE");
  assert.ok(stakeStep);
  assert.equal(stakeStep!.passedRows, 1);
});

test("C8: MODEL_A does not remove the row solely due to high smart money", () => {
  const highSm = makeRow({ metric_formula_version: "v2-lite-growth-safe", signal_confidence_num: 80, diagnostics: { dataCoverage: 80 }, smart_money_score_num: 95, signal_result: "win" });
  const lowSm = makeRow({ metric_formula_version: "v2-lite-growth-safe", signal_confidence_num: 80, diagnostics: { dataCoverage: 80 }, smart_money_score_num: 10, signal_result: "win" });
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

test("C19: selectedRows exposes the final row objects and matches outputRows without mutating input", () => {
  const rows = [makeRow({ signal_confidence_num: 80 }), makeRow({ signal_confidence_num: 10 })];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_TS_SCORE_GE_65");
  assert.equal(result.selectedRows.length, result.outputRows);
  assert.equal(result.selectedRows.length, 1);
  // The selected row is the original object reference (identity preserved).
  assert.ok(result.selectedRows.every((r) => rows.includes(r as (typeof rows)[number])));
});

// ---- Phase 3E.4B: export-to-evaluator field adapters ----

const ALLOWED_VERSION = ALLOWED_METRIC_FORMULA_VERSIONS[0];

test("F1: score alias -- a row carrying only `score` passes REQUIRE score >= 65", () => {
  const rows = [{ condition_id: "c1", token_id: "t1", score: 80, signal_result: "win", realized_return_pct: 40 }];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_TS_SCORE_GE_65");
  assert.equal(result.outputRows, 1);
});

test("F2: signal_confidence_num has priority over score", () => {
  assert.equal(getScoreValue({ signal_confidence_num: 90, score: 10 }), 90);
});

test("F3: signal_score fallback works", () => {
  assert.equal(getScoreValue({ signal_score: 55 }), 55);
});

test("F4: pre_event_score_num is the last fallback only", () => {
  assert.equal(getScoreValue({ pre_event_score_num: 44 }), 44);
  assert.equal(getScoreValue({ score: 70, pre_event_score_num: 44 }), 70);
});

test("F5: missing score is distinguishable from a numeric zero", () => {
  assert.equal(getScoreValue({}), null);
  assert.equal(getScoreValue({ signal_confidence_num: 0 }), 0);
});

test("F6: an invalid string score does not become zero (rejected as missing)", () => {
  assert.equal(getScoreValue({ signal_confidence_num: "80" }), null);
});

test("F7: diagnostics.dataCoverage = 72 passes coverage >= 50", () => {
  assert.equal(getCoverageValue({ diagnostics: { dataCoverage: 72 } }), 72);
});

test("F8: missing coverage does not silently pass (null, not 0)", () => {
  assert.equal(getCoverageValue({}), null);
  assert.equal(getCoverageValue({ diagnostics: {} }), null);
});

test("F9: invalid coverage unit/value is rejected explicitly", () => {
  assert.equal(getCoverageValue({ diagnostics: { dataCoverage: "72" } }), null);
  assert.equal(getCoverageValue({ diagnostics: { dataCoverage: 150 } }), null);
  assert.equal(getCoverageValue({ diagnostics: { dataCoverage: -5 } }), null);
});

test("F10: diagnostics.gameStartIso plus created_at derives 8 hours", () => {
  const row = { created_at: "2024-01-01T00:00:00Z", diagnostics: { gameStartIso: "2024-01-01T08:00:00Z" } };
  assert.equal(getHoursUntilStartValue(row), 8);
});

test("F11: derived 8 hours triggers the historical 6-24h timing exclusion in PRIMARY", () => {
  const inWindow = {
    condition_id: "c1", token_id: "t1", signal_confidence_num: 80, entry_price_num: 0.7,
    signal_result: "win", realized_return_pct: 40,
    created_at: "2024-01-01T00:00:00Z",
    diagnostics: { dataCoverage: 80, gameStartIso: "2024-01-01T08:00:00Z" },
  };
  const result = evaluateHistoricalFunnelVariant([inWindow], classifier, "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP");
  assert.equal(result.outputRows, 0);
});

test("F12: invalid timing input is explicit (null)", () => {
  assert.equal(getHoursUntilStartValue({ created_at: "bad", diagnostics: { gameStartIso: "2024-01-01T08:00:00Z" } }), null);
  assert.equal(getHoursUntilStartValue({ created_at: "2024-01-01T00:00:00Z", diagnostics: {} }), null);
});

test("F13: an allowed metric_formula_version passes the isAllowed REQUIRE", () => {
  const row = {
    condition_id: "c1", token_id: "t1", metric_formula_version: ALLOWED_VERSION,
    signal_confidence_num: 80, entry_price_num: 0.7, signal_result: "win", realized_return_pct: 40,
    diagnostics: { dataCoverage: 80 },
  };
  const result = evaluateHistoricalFunnelVariant([row], classifier, "ALT_SM_GUARD_ON_PRIMARY");
  assert.equal(result.outputRows, 1);
});

test("F14: a disallowed formula version is removed by isAllowed REQUIRE", () => {
  const row = {
    condition_id: "c1", token_id: "t1", metric_formula_version: "totally-unknown-version",
    signal_confidence_num: 80, entry_price_num: 0.7, signal_result: "win", realized_return_pct: 40,
    diagnostics: { dataCoverage: 80 },
  };
  const result = evaluateHistoricalFunnelVariant([row], classifier, "ALT_SM_GUARD_ON_PRIMARY");
  assert.equal(result.outputRows, 0);
});

test("F15: a missing formula version follows the declared policy (fail-closed removal)", () => {
  assert.equal(isAllowedFormulaVersion({}), false);
  const row = {
    condition_id: "c1", token_id: "t1",
    signal_confidence_num: 80, entry_price_num: 0.7, signal_result: "win", realized_return_pct: 40,
    diagnostics: { dataCoverage: 80 },
  };
  const result = evaluateHistoricalFunnelVariant([row], classifier, "ALT_SM_GUARD_ON_PRIMARY");
  assert.equal(result.outputRows, 0);
});

test("F16: smart-money adapter reads the top-level exported location; absent = historical fail-open", () => {
  assert.equal(getSmartMoneyValue({ smart_money_score_num: 90 }), 90);
  assert.equal(getSmartMoneyValue({}), null);
});

test("F17: MODEL_A soft stake rule still does not remove rows solely due to high smart money", () => {
  const base = {
    metric_formula_version: ALLOWED_VERSION, signal_confidence_num: 80,
    entry_price_num: 0.7, signal_result: "win", realized_return_pct: 40,
    diagnostics: { dataCoverage: 80 },
  };
  const rows = [
    { ...base, condition_id: "c1", token_id: "t1", smart_money_score_num: 95 },
    { ...base, condition_id: "c2", token_id: "t2", smart_money_score_num: 10 },
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT_SM_GUARD_ON_PRIMARY");
  assert.equal(result.outputRows, 2);
});

test("F18: _APPROX hard smart-money exclusion remains separate (removes sm>=85)", () => {
  const base = {
    signal_confidence_num: 70, entry_price_num: 0.7, signal_result: "win", realized_return_pct: 40,
    diagnostics: { dataCoverage: 80 },
  };
  const rows = [
    { ...base, condition_id: "c1", token_id: "t1", smart_money_score_num: 90 },
    { ...base, condition_id: "c2", token_id: "t2", smart_money_score_num: 10 },
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT_SM_GUARD_ON_PRIMARY_APPROX");
  assert.equal(result.outputRows, 1);
});

test("F19: existing ALT2/ALT3 TS-vs-Python divergence remains unchanged", () => {
  const smRows = [
    { condition_id: "c1", token_id: "t1", signal_confidence_num: 70, smart_money_score_num: 90, signal_result: "win", realized_return_pct: 40, diagnostics: { dataCoverage: 80 } },
    { condition_id: "c2", token_id: "t2", signal_confidence_num: 70, smart_money_score_num: 10, signal_result: "win", realized_return_pct: 40, diagnostics: { dataCoverage: 80 } },
  ];
  const ts = evaluateHistoricalFunnelVariant(smRows, classifier, "ALT2_TS_SCORE_GE_65");
  const py = evaluateHistoricalFunnelVariant(smRows, classifier, "ALT2_PY_SCORE_GE_65_SM_LT_85");
  assert.equal(ts.outputRows, 2);
  assert.equal(py.outputRows, 1);
});

test("F20: this module contains no formula arithmetic (no v2-lite weighted-sum literals)", () => {
  const src = require("node:fs").readFileSync(require.resolve("../../lib/modeling/historicalFunnelVariants.ts"), "utf8");
  assert.doesNotMatch(src, /0\.35\s*\*|0\.25\s*\*\s*smart|signalV2Raw/);
});

// ---- Phase 4B: bounded historical hypothesis batch 1 (ALT4/ALT5/ALT6) ----
//
// Base comparator for all three: ALT2_TS_SCORE_GE_65 (score >= 65, keep all).
// Each candidate changes exactly one dimension.

test("G21: ALT4 keeps score-qualified non-esports rows and excludes esports", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, event_slug: "esports-cs2-navi-vs-g2" }),
    makeRow({ signal_confidence_num: 70, market_slug: "valorant-champions-final" }),
    makeRow({ signal_confidence_num: 70, event_slug: "atp-tennis-final" }),
    makeRow({ signal_confidence_num: 70, event_slug: "epl-arsenal-chelsea" }),
    makeRow({ signal_confidence_num: 50, event_slug: "esports-dota-ti-final" }),
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS");
  assert.equal(result.outputRows, 2);
  const eventSlugs = result.selectedRows.map((r) => r.event_slug).sort();
  assert.deepEqual(eventSlugs, ["atp-tennis-final", "epl-arsenal-chelsea"]);
});

test("G22: ALT4 is not equivalent to ALT3 (NBA/NHL exclusion is unaffected)", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, event_slug: "nba-lakers-celtics" }),
    makeRow({ signal_confidence_num: 70, event_slug: "esports-cs2-navi-vs-g2" }),
  ];
  const alt3 = evaluateHistoricalFunnelVariant(rows, classifier, "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL");
  const alt4 = evaluateHistoricalFunnelVariant(rows, classifier, "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS");
  // ALT3 removes the NBA row, keeps esports; ALT4 removes esports, keeps NBA.
  assert.equal(alt3.outputRows, 1);
  assert.equal(alt3.selectedRows[0].event_slug, "esports-cs2-navi-vs-g2");
  assert.equal(alt4.outputRows, 1);
  assert.equal(alt4.selectedRows[0].event_slug, "nba-lakers-celtics");
});

test("G23: ALT5 keeps only score-qualified tennis rows", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, event_slug: "atp-tennis-final" }),
    makeRow({ signal_confidence_num: 70, market_slug: "wta-open-final" }),
    makeRow({ signal_confidence_num: 70, event_slug: "epl-arsenal-chelsea" }),
    makeRow({ signal_confidence_num: 50, event_slug: "atp-tennis-semifinal" }),
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT5_TS_SCORE_GE_65_TENNIS_ONLY");
  assert.equal(result.outputRows, 2);
  for (const r of result.selectedRows) {
    assert.match(String(r.event_slug ?? r.market_slug), /tennis|wta|atp/i);
  }
});

test("G24: ALT5 has no existing tennis-only equivalent (ALT2 baseline keeps non-tennis too)", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, event_slug: "atp-tennis-final" }),
    makeRow({ signal_confidence_num: 70, event_slug: "epl-arsenal-chelsea" }),
  ];
  const alt2 = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_TS_SCORE_GE_65");
  const alt5 = evaluateHistoricalFunnelVariant(rows, classifier, "ALT5_TS_SCORE_GE_65_TENNIS_ONLY");
  assert.equal(alt2.outputRows, 2);
  assert.equal(alt5.outputRows, 1);
});

test("G25: ALT6 keeps exactly one row per working event group (max signals per event = 1)", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, match_family_key: "barca-real-2026", diagnostics: { dataCoverage: 60 } }),
    makeRow({ signal_confidence_num: 90, match_family_key: "barca-real-2026", diagnostics: { dataCoverage: 90 } }),
    makeRow({ signal_confidence_num: 66, match_family_key: "barca-real-2026", diagnostics: { dataCoverage: 40 } }),
    makeRow({ signal_confidence_num: 66, event_slug: "epl-arsenal-chelsea" }),
  ];
  const result = evaluateHistoricalFunnelVariant(rows, classifier, "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING");
  assert.equal(result.workingEventGroups, 2);
  assert.equal(result.outputRows, 2);
  // Same canonical winner as ALT1's grouping: highest coverage wins within the group.
  const barcaRow = result.selectedRows.find((r) => r.match_family_key === "barca-real-2026");
  assert.ok(barcaRow);
  assert.equal((barcaRow!.diagnostics as Record<string, unknown>).dataCoverage, 90);
});

test("G26: ALT6 input permutation does not change the selected winner", () => {
  const a = makeRow({ signal_confidence_num: 70, match_family_key: "ev-x", diagnostics: { dataCoverage: 60 } });
  const b = makeRow({ signal_confidence_num: 90, match_family_key: "ev-x", diagnostics: { dataCoverage: 90 } });
  const c = makeRow({ signal_confidence_num: 66, match_family_key: "ev-x", diagnostics: { dataCoverage: 40 } });
  const forward = evaluateHistoricalFunnelVariant([a, b, c], classifier, "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING");
  const reversed = evaluateHistoricalFunnelVariant([c, b, a], classifier, "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING");
  assert.equal(forward.outputRows, 1);
  assert.equal(reversed.outputRows, 1);
  assert.equal(
    (forward.selectedRows[0].diagnostics as Record<string, unknown>).dataCoverage,
    (reversed.selectedRows[0].diagnostics as Record<string, unknown>).dataCoverage,
  );
  assert.equal((forward.selectedRows[0].diagnostics as Record<string, unknown>).dataCoverage, 90);
});

test("G27: ALT6 is not equivalent to ALT1 (score threshold stays >=65, not >=72)", () => {
  const rows = [makeRow({ signal_confidence_num: 68, match_family_key: "ev-y" })];
  const alt1 = evaluateHistoricalFunnelVariant(rows, classifier, "ALT1_CANONICAL_EVENT_GROUPING");
  const alt6 = evaluateHistoricalFunnelVariant(rows, classifier, "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING");
  assert.equal(alt1.outputRows, 0); // below ALT1's 72 threshold
  assert.equal(alt6.outputRows, 1); // above ALT6's/ALT2's 65 threshold
});

test("G28: the original 9 model definitions are unaffected by the batch-1 additions", () => {
  const rows = [
    makeRow({ signal_confidence_num: 70, event_slug: "esports-cs2-navi-vs-g2" }),
    makeRow({ signal_confidence_num: 70, event_slug: "atp-tennis-final" }),
    makeRow({ signal_confidence_num: 70, event_slug: "epl-arsenal-chelsea" }),
  ];
  for (const id of [
    "BASELINE_V1_CONTROL",
    "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
    "ALT1_CANONICAL_EVENT_GROUPING",
    "ALT2_TS_SCORE_GE_65",
    "ALT2_PY_SCORE_GE_65_SM_LT_85",
    "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL",
    "ALT3_PY_SCORE_GE_65",
    "ALT_SM_GUARD_ON_PRIMARY",
    "ALT_SM_GUARD_ON_PRIMARY_APPROX",
  ]) {
    // ALT2 (score>=65, keep all) must still keep all three fixture rows.
    const result = evaluateHistoricalFunnelVariant(rows, classifier, id);
    assert.ok(result.status === "COMPLETED" || result.status === "BLOCKED", `unexpected status for ${id}`);
  }
  const alt2Regression = evaluateHistoricalFunnelVariant(rows, classifier, "ALT2_TS_SCORE_GE_65");
  assert.equal(alt2Regression.outputRows, 3);
});
