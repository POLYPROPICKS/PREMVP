import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  selectOnePerEvent, fitLogistic, buildDesign, metrics, foldBounds, runAblation, identityHash, EstimatorNumericalFailure,
  type LabeledRow,
} from "../../scripts/modeling/step4c-momentum-ablation";

const mk = (i: number, over: Partial<LabeledRow> = {}): LabeledRow => ({
  event_id: String(1000 + i), condition_id: `0xc${i}`, selected_token_id: `t${i}`,
  selected_price_num: 0.3 + ((i * 7) % 10) / 20, market_type: i % 3 === 0 ? "moneyline" : i % 3 === 1 ? "totals" : "spreads",
  score: 60 + (i % 11), coverage: 40 + (i % 13), snapshot_at: "2026-09-01T00:00:00Z",
  game_start_iso: new Date(Date.UTC(2026, 8, 2, 0, 0, 0) + i * 3600_000).toISOString(),
  price1hAgo: 0.4 + (i % 5) / 50, price6hAgo: 0.4 + (i % 7) / 50, delta1hPp: (i % 5) - 2, delta6hPp: (i % 7) - 3,
  lead_time_hours: 24 + i, y: ((i * 5) % 7) % 2 === 0 ? 1 : 0, ...over,
});

test("identity hash selection is outcome-blind, deterministic, order independent", () => {
  const rows = [
    { event_id: "1", condition_id: "a", selected_token_id: "x" },
    { event_id: "1", condition_id: "a", selected_token_id: "y" },
    { event_id: "1", condition_id: "b", selected_token_id: "z" },
    { event_id: "2", condition_id: "c", selected_token_id: "q" },
  ];
  const a = selectOnePerEvent(rows), b = selectOnePerEvent([...rows].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  const hs = rows.slice(0, 3).map((r) => [identityHash(r.condition_id, r.selected_token_id), r] as const).sort((p, q) => (p[0] < q[0] ? -1 : 1));
  assert.equal(a[0].selected_token_id, hs[0][1].selected_token_id);
  assert.equal(identityHash("a", "x"), createHash("sha256").update("a::x").digest("hex"));
});

test("fold bounds follow floor(0.4/0.6/0.8 N)", () => {
  const f = foldBounds(100);
  assert.deepEqual(f.map((x) => [x.train[1], x.test[0], x.test[1]]), [[40, 40, 60], [60, 60, 80], [80, 80, 100]]);
  assert.deepEqual(foldBounds(83).map((x) => x.test), [[33, 49], [49, 66], [66, 83]]);
});

test("logistic fit is deterministic and recovers separable direction with L2 shrink", () => {
  const X = [[1, -2], [1, -1], [1, -0.5], [1, 0.5], [1, 1], [1, 2]];
  const y = [0, 0, 1, 0, 1, 1];
  const a = fitLogistic(X, y), b = fitLogistic(X, y);
  assert.deepEqual(a, b);
  assert.ok(a.beta[1] > 0);
  // L2 gradient at optimum: X'(p-y) + lambda*beta = 0 for slope, X'(p-y)=0 for intercept
  const p = X.map((r) => 1 / (1 + Math.exp(-(r[0] * a.beta[0] + r[1] * a.beta[1]))));
  const gi = p.reduce((s, pi, i) => s + (pi - y[i]), 0);
  const gs = p.reduce((s, pi, i) => s + (pi - y[i]) * X[i][1], 0) + a.beta[1];
  assert.ok(Math.abs(gi) < 1e-6 && Math.abs(gs) < 1e-6);
});

test("non-finite / singular design fails closed", () => {
  assert.throws(() => fitLogistic([[1, NaN], [1, 1]], [0, 1]), EstimatorNumericalFailure);
});

test("normalization and one-hot use training fold only; unknown category is all-zero", () => {
  const train = [mk(0, { market_type: "b", selected_price_num: 0.2 }), mk(1, { market_type: "a", selected_price_num: 0.4 }), mk(2, { market_type: "c", selected_price_num: 0.6 })];
  const test_ = [mk(3, { market_type: "zzz", selected_price_num: 0.4 })];
  const d = buildDesign("M0", train, test_);
  assert.deepEqual(d.vocab, ["a", "b", "c"]);
  assert.equal(d.Xtrain[0].length, 1 + 1 + 2); // intercept, price, b, c (a baseline)
  assert.ok(Math.abs(d.Xtest[0][1]) < 1e-12); // (0.4 - mean 0.4)/std
  assert.deepEqual(d.Xtest[0].slice(2), [0, 0]);
  const zeroStd = buildDesign("M0", [mk(0, { selected_price_num: 0.5 }), mk(1, { selected_price_num: 0.5 })], [mk(2)]);
  assert.equal(zeroStd.Xtrain[0][1], 0);
  assert.equal(zeroStd.Xtest[0][1], 0);
});

test("metrics", () => {
  const m = metrics([0.9, 0.2], [1, 0]);
  assert.ok(Math.abs(m.BRIER - (0.01 + 0.04) / 2) < 1e-12);
  assert.equal(m.ACCURACY, 1);
  assert.ok(Math.abs(m.LOG_LOSS - (-Math.log(0.9) - Math.log(0.8)) / 2) < 1e-12);
});

test("runAblation is deterministic, chronological, disjoint and applies the predeclared verdict", () => {
  const rows = Array.from({ length: 90 }, (_, i) => mk(i));
  const r1 = runAblation(rows), r2 = runAblation([...rows].reverse());
  assert.deepEqual(r1, r2);
  assert.equal(r1.perFold.length, 3);
  assert.deepEqual(r1.perFold.map((f: any) => f.TEST_N), [18, 18, 18]);
  const pos = r1.aggregate.M2.LOG_LOSS < r1.aggregate.M1.LOG_LOSS && r1.aggregate.M2.BRIER < r1.aggregate.M1.BRIER && r1.M2_BETTER_LOGLOSS_FOLD_N >= 2;
  assert.equal(r1.RESULT, pos ? "MOMENTUM_DIAGNOSTIC_POSITIVE" : "NO_MOMENTUM_LIFT_PROVEN");
});

test("fold with <15 test observations is refused", () => {
  assert.throws(() => runAblation(Array.from({ length: 60 }, (_, i) => mk(i))), /TEST_N_BELOW/);
});
