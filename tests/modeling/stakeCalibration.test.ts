import test from "node:test";
import assert from "node:assert/strict";
import { calibratePastOnlyProbability, quantizeConservativeFraction, wilsonLowerBound90 } from "../../lib/modeling/stakeCalibration";

test("Wilson lower bound and Kelly tiers are deterministic", () => {
  assert.ok(wilsonLowerBound90(70, 100) < 0.7);
  assert.equal(quantizeConservativeFraction(0.0089), 0);
  assert.equal(quantizeConservativeFraction(0.009), 0.3);
  assert.equal(quantizeConservativeFraction(0.015), 0.5);
  assert.equal(quantizeConservativeFraction(0.021), 0.7);
  assert.equal(quantizeConservativeFraction(0.03), 1);
});

test("future outcomes never enter calibration and sparse buckets back off", () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ resolvedAtMs: i < 20 ? 50 : 150, win: i % 2 === 0, score: 70, price: 0.5, coverage: 80, marketFamily: "moneyline" }));
  const a = calibratePastOnlyProbability({ decisionAtMs: 100, score: 70, price: 0.5, coverage: 80, marketFamily: "moneyline" }, history);
  const b = calibratePastOnlyProbability({ decisionAtMs: 100, score: 70, price: 0.5, coverage: 80, marketFamily: "moneyline" }, [...history].reverse());
  assert.equal(a.sampleSize, 20);
  assert.equal(a.bucketLevel, "GLOBAL");
  assert.deepEqual(a, b);
});
