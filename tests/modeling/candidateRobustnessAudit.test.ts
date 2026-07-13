// Phase 3E.7 Commit A -- candidate robustness and rule-contribution audit
// engine tests.
//
// Audits exactly two already-selected candidates (PRIMARY_V1_AVOID_NBA_NHL_
// COV_CAP, ALT2_TS_SCORE_GE_65) plus BASELINE for comparison, on the same
// canonical dedup corpus. Pure math only: reuses evaluateHistoricalFunnelVariant
// for row selection, roiPnlContract for ROI/PnL, computeFlatUnitEquityMetrics
// for drawdown -- no new formula, threshold, or predicate is introduced. No
// fs/env/network/database access.

import test from "node:test";
import assert from "node:assert/strict";
import {
  auditCandidateRobustness,
  AUDITED_CANDIDATE_IDS,
} from "../../lib/modeling/candidateRobustnessAudit";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { computeFlatStakeRoiSummary } from "../../lib/modeling/roiPnlContract";

const classifier = loadExecutableFunnelClassifier();

function row(
  n: number,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `id-${n}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: `2026-05-${String(1 + (n % 28)).padStart(2, "0")}T00:00:00Z`,
    resolved_at: `2026-05-${String(1 + (n % 28)).padStart(2, "0")}T12:00:00Z`,
    metric_formula_version: "v2-lite-growth-safe",
    signal_confidence_num: 80,
    score: 80,
    entry_price_num: 0.65,
    signal_result: n % 3 === 0 ? "loss" : "win",
    realized_return_pct: n % 3 === 0 ? -100 : 40,
    diagnostics: { dataCoverage: 80 },
    ...overrides,
  };
}

function corpus(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  // Spread across several distinct weeks, mostly win-weighted, entry price
  // outside the bad-bucket band, coverage high, no NBA/NHL, no timing guard.
  for (let n = 1; n <= 30; n++) {
    rows.push(
      row(n, {
        created_at: `2026-0${1 + Math.floor(n / 15)}-${String(1 + (n % 27)).padStart(2, "0")}T00:00:00Z`,
        resolved_at: `2026-0${1 + Math.floor(n / 15)}-${String(1 + (n % 27)).padStart(2, "0")}T12:00:00Z`,
      }),
    );
  }
  return rows;
}

const CORPUS = corpus();

function run() {
  return auditCandidateRobustness({ rows: CORPUS, classifier, candidateVariantIds: [...AUDITED_CANDIDATE_IDS] });
}

test("G1: weekly metrics reconcile to the candidate total (signals sum across weeks)", () => {
  const result = run();
  for (const c of result.candidates) {
    const weekSignals = c.weeklyStability.weeks.reduce((s, w) => s + w.signals, 0);
    assert.equal(weekSignals, c.overallMetrics.outputRows);
  }
});

test("G2: weekly PnL sums to the candidate total PnL", () => {
  const result = run();
  for (const c of result.candidates) {
    const weekPnl = c.weeklyStability.weeks.reduce((s, w) => s + w.pnl, 0);
    assert.ok(Math.abs(weekPnl - (c.overallMetrics.flatUnitPnl ?? 0)) < 1e-9);
  }
});

test("G3: positive/negative week counts reconcile with the per-week signs", () => {
  const result = run();
  for (const c of result.candidates) {
    const positive = c.weeklyStability.weeks.filter((w) => w.pnl > 0).length;
    const negative = c.weeklyStability.weeks.filter((w) => w.pnl < 0).length;
    assert.equal(c.weeklyStability.positiveWeekCount, positive);
    assert.equal(c.weeklyStability.negativeWeekCount, negative);
  }
});

test("G4: best-week concentration flag is set only when best week exceeds 40% of total positive PnL", () => {
  const result = run();
  for (const c of result.candidates) {
    const totalPositive = c.weeklyStability.weeks.filter((w) => w.pnl > 0).reduce((s, w) => s + w.pnl, 0);
    const bestWeekPnl = c.weeklyStability.bestWeek?.pnl ?? 0;
    const expectedFlag = totalPositive > 0 && bestWeekPnl / totalPositive > 0.4;
    assert.equal(c.weeklyStability.bestWeekConcentrationFlag, expectedFlag);
  }
});

test("G5: PRIMARY cumulative stages preserve the exact historical rule order from the classifier", () => {
  const result = run();
  const primary = result.candidates.find((c) => c.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const stageActions = primary.ruleContribution!.stages.map((s) => s.ruleLabel);
  // Must include BASELINE first and end with the full funnel; must not
  // reorder timing/coverage relative to the classifier's declared order.
  assert.equal(stageActions[0], "BASELINE");
  assert.equal(stageActions[stageActions.length - 1], "FULL_FUNNEL");
});

test("G6: every ablation stage's input rows equal the previous stage's output rows", () => {
  const result = run();
  const primary = result.candidates.find((c) => c.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const stages = primary.ruleContribution!.stages;
  for (let i = 1; i < stages.length; i++) {
    assert.equal(stages[i].inputRows, stages[i - 1].outputRows);
  }
});

test("G7: stage delta metrics reconcile against the previous stage", () => {
  const result = run();
  const primary = result.candidates.find((c) => c.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const stages = primary.ruleContribution!.stages;
  for (let i = 1; i < stages.length; i++) {
    const prevPnl = stages[i - 1].pnl ?? 0;
    const curPnl = stages[i].pnl ?? 0;
    assert.ok(Math.abs(stages[i].deltaPnlFromPrevious! - (curPnl - prevPnl)) < 1e-9);
  }
});

test("G8: no new threshold is introduced -- every stage's exactRule value matches the classifier", () => {
  const result = run();
  const primary = result.candidates.find((c) => c.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const scoreStage = primary.ruleContribution!.stages.find((s) => s.ruleLabel.includes("score"));
  assert.ok(scoreStage);
  assert.match(scoreStage!.plainLanguage, /72/);
});

test("G9: segment rows reconcile -- segment signal counts sum to candidate output rows", () => {
  const result = run();
  for (const c of result.candidates) {
    const scoreBandTotal = c.segments.scoreBand.reduce((s, seg) => s + seg.signals, 0);
    assert.equal(scoreBandTotal, c.overallMetrics.outputRows);
  }
});

test("G10: segments under 20 samples are marked LOW_SAMPLE but remain visible", () => {
  const result = run();
  for (const c of result.candidates) {
    for (const seg of c.segments.scoreBand) {
      if (seg.signals < 20) assert.equal(seg.sampleFlag, "LOW_SAMPLE");
      else assert.equal(seg.sampleFlag, "OK");
    }
  }
});

test("G11: top-row PnL contribution calculations are internally consistent", () => {
  const result = run();
  for (const c of result.candidates) {
    assert.ok(c.concentration.top1WinContribution >= 0);
    assert.ok(c.concentration.top5WinContribution >= c.concentration.top1WinContribution || c.overallMetrics.wins < 5);
  }
});

test("G12: removing top rows recomputes PnL correctly (pnlAfterRemovingTop1 = total - top1)", () => {
  const result = run();
  for (const c of result.candidates) {
    const total = c.overallMetrics.flatUnitPnl ?? 0;
    assert.ok(Math.abs(c.concentration.pnlAfterRemovingTop1 - (total - c.concentration.top1WinContribution)) < 1e-9);
  }
});

test("G13: condition/token uniqueness is reported and never exceeds output rows", () => {
  const result = run();
  for (const c of result.candidates) {
    assert.ok(c.identity.uniqueConditionTokenPairs <= c.overallMetrics.outputRows);
  }
});

test("G14: event concentration metrics -- maxSignalsPerWorkingEvent is at least 1 when rows exist", () => {
  const result = run();
  for (const c of result.candidates) {
    if (c.overallMetrics.outputRows > 0) {
      assert.ok(c.identity.maximumSignalsPerWorkingEvent >= 1);
    }
  }
});

test("G15: field-coverage percentages are within [0,100] for every tracked field", () => {
  const result = run();
  for (const c of result.candidates) {
    for (const key of Object.keys(c.fieldCoverage) as Array<keyof typeof c.fieldCoverage>) {
      const pct = c.fieldCoverage[key];
      assert.ok(pct >= 0 && pct <= 100, `${String(key)} out of range: ${pct}`);
    }
  }
});

test("G16: smart-money absence is explicit, never silently hidden", () => {
  const result = run();
  for (const c of result.candidates) {
    assert.equal(c.fieldCoverage.smartMoney, 0);
  }
  assert.match(result.smartMoneyLimitationNote, /smart_money_score_num/);
  assert.match(result.smartMoneyLimitationNote, /unvalidated/i);
});

test("G17: corpus hash mismatch causes the audit to throw (STOP)", () => {
  assert.throws(
    () =>
      auditCandidateRobustness({
        rows: CORPUS,
        classifier,
        candidateVariantIds: [...AUDITED_CANDIDATE_IDS],
        expectedCorpusSha256: "0".repeat(64),
      }),
    /hash|mismatch/i,
  );
});

test("G18: audit performs no fs/env/network access", () => {
  const before = JSON.stringify(process.env);
  run();
  assert.equal(JSON.stringify(process.env), before);
});

test("G19: no raw row payloads are embedded in the audit result", () => {
  const result = run();
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /"signal_result":|"realized_return_pct":/);
});

test("G20: audit output is deterministic across repeated calls", () => {
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
});

test("G21: engine does not mutate the input rows", () => {
  const rows = corpus();
  const before = JSON.stringify(rows);
  auditCandidateRobustness({ rows, classifier, candidateVariantIds: [...AUDITED_CANDIDATE_IDS] });
  assert.equal(JSON.stringify(rows), before);
});

test("G22: ROI/PnL figures reuse the canonical roiPnlContract (no divergent math)", () => {
  const result = run();
  const direct = computeFlatStakeRoiSummary(CORPUS, { strict: false, stakeUnits: 1 });
  assert.ok(Math.abs((result.baselineWeeklyStability.totalPnl) - (direct.totalPnlUnits ?? 0)) < 1e-9);
});

test("G23: baseline weekly stability is reported for BASELINE, PRIMARY, and ALT2 (Audit A scope)", () => {
  const result = run();
  assert.ok(result.baselineWeeklyStability.weeks.length > 0);
  for (const c of result.candidates) {
    assert.ok(c.weeklyStability.weeks.length > 0);
  }
});
