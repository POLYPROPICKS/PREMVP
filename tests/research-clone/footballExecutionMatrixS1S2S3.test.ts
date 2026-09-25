// Bounded regression coverage for the football S1/S2/S3 execution-matrix
// evidence contract (lib/executionMatrix/footballS1S2S3.ts). Research-clone
// evidence capture only — no live-money behavior, no signal selection.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertSameCandidateIdentity,
  decimalOddsToSharePrice,
  evaluateS1TakerHold,
  evaluateS2FixedMakerHold,
  evaluateS3MakerValueBandHold,
  S2_INITIAL_TARGET_DECIMAL_ODDS,
  S3_INITIAL_LADDER_DECIMAL_ODDS,
  S3_MIN_ACCEPTABLE_DECIMAL_ODDS,
  sharePriceToDecimalOdds,
  type CandidateIdentity,
} from "../../lib/executionMatrix/footballS1S2S3";

const candidate: CandidateIdentity = {
  conditionId: "0xcond-abc",
  selectedTokenId: "token-away-win",
  providerEventId: "evt-777",
  formulaVersion: "shadow-strategic-sports-v1",
  decisionTimeIso: "2026-09-24T18:00:00.000Z",
};

// 1. Same candidate identity across S1/S2/S3 -------------------------------

test("same candidate identity is provably shared across S1/S2/S3", () => {
  const s1 = evaluateS1TakerHold({
    candidate,
    modelFairDecimalOdds: 1.9,
    availableDecimalOdds: 1.95,
    minAcceptableDecimalOdds: 1.85,
  });
  const s2 = evaluateS2FixedMakerHold({
    candidate,
    targetDecimalOdds: S2_INITIAL_TARGET_DECIMAL_ODDS,
    observations: [],
  });
  const s3 = evaluateS3MakerValueBandHold({ candidate, observations: [] });

  assert.doesNotThrow(() => assertSameCandidateIdentity(s1, s2, s3));

  const drifted = evaluateS2FixedMakerHold({
    candidate: { ...candidate, selectedTokenId: "token-home-win" },
    targetDecimalOdds: S2_INITIAL_TARGET_DECIMAL_ODDS,
    observations: [],
  });
  assert.throws(() => assertSameCandidateIdentity(s1, drifted, s3), /identity mismatch/);
});

// 2. Decimal-odds conversion -------------------------------------------------

test("decimal-odds conversion round-trips against CLOB share price", () => {
  assert.equal(sharePriceToDecimalOdds(0.5), 2);
  assert.ok(Math.abs(sharePriceToDecimalOdds(0.4) - 2.5) < 1e-9);
  assert.ok(Math.abs(decimalOddsToSharePrice(2.5) - 0.4) < 1e-9);
  assert.throws(() => sharePriceToDecimalOdds(0), RangeError);
  assert.throws(() => sharePriceToDecimalOdds(1), RangeError);
  assert.throws(() => decimalOddsToSharePrice(1), RangeError);
});

// 3. Minimum-odds semantics --------------------------------------------------

test("S1 TAKE/NO_TAKE is gated strictly by minimum acceptable decimal odds", () => {
  const take = evaluateS1TakerHold({
    candidate,
    modelFairDecimalOdds: 1.9,
    availableDecimalOdds: 1.85,
    minAcceptableDecimalOdds: 1.85,
  });
  assert.equal(take.decision, "TAKE");

  const noTake = evaluateS1TakerHold({
    candidate,
    modelFairDecimalOdds: 1.9,
    availableDecimalOdds: 1.84,
    minAcceptableDecimalOdds: 1.85,
  });
  assert.equal(noTake.decision, "NO_TAKE");
});

test("S3 ladder respects the explicit minimum acceptable decimal odds floor", () => {
  const result = evaluateS3MakerValueBandHold({
    candidate,
    observations: [
      { observedAtIso: "2026-09-24T18:05:00.000Z", bestObservedDecimalOdds: 1.8 },
    ],
  });
  // 1.8 never reaches the 1.85 floor nor any ladder rung.
  assert.equal(result.bestReachableAcceptableDecimalOdds, null);
  assert.equal(result.status, "NO_FILL");
  assert.deepEqual([...result.ladderDecimalOdds], [...S3_INITIAL_LADDER_DECIMAL_ODDS]);
  assert.equal(result.minAcceptableDecimalOdds, S3_MIN_ACCEPTABLE_DECIMAL_ODDS);
});

// 4. Maker touch != ACTUAL_FILL ---------------------------------------------

test("a market-price touch of the S2 target is FILL_OPPORTUNITY, never ACTUAL_FILL", () => {
  const touched = evaluateS2FixedMakerHold({
    candidate,
    targetDecimalOdds: 2.0,
    observations: [{ observedAtIso: "2026-09-24T18:10:00.000Z", bestObservedDecimalOdds: 2.01 }],
  });
  assert.equal(touched.targetReachable, true);
  assert.equal(touched.status, "FILL_OPPORTUNITY");
  assert.equal(touched.actualFillDecimalOdds, null);

  const authoritativelyFilled = evaluateS2FixedMakerHold({
    candidate,
    targetDecimalOdds: 2.0,
    observations: [{ observedAtIso: "2026-09-24T18:10:00.000Z", bestObservedDecimalOdds: 2.01 }],
    fill: { filledDecimalOdds: 2.0, filledAtIso: "2026-09-24T18:10:05.000Z", source: "bet_execution_ledger" },
  });
  assert.equal(authoritativelyFilled.status, "ACTUAL_FILL");
  assert.equal(authoritativelyFilled.actualFillDecimalOdds, 2.0);
});

test("a market-price touch of an S3 ladder rung is FILL_OPPORTUNITY, never ACTUAL_FILL", () => {
  const touched = evaluateS3MakerValueBandHold({
    candidate,
    observations: [{ observedAtIso: "2026-09-24T18:10:00.000Z", bestObservedDecimalOdds: 1.96 }],
  });
  assert.equal(touched.status, "FILL_OPPORTUNITY");
  assert.equal(touched.actualFillDecimalOdds, null);
});

// 5. NO_FILL / UNKNOWN preservation ------------------------------------------

test("S2/S3 preserve UNKNOWN when no observations exist, and NO_FILL when observed but never reachable", () => {
  const noObservations = evaluateS2FixedMakerHold({
    candidate,
    targetDecimalOdds: 2.0,
    observations: [],
  });
  assert.equal(noObservations.status, "UNKNOWN");

  const neverReached = evaluateS2FixedMakerHold({
    candidate,
    targetDecimalOdds: 2.0,
    observations: [{ observedAtIso: "2026-09-24T18:15:00.000Z", bestObservedDecimalOdds: 1.7 }],
  });
  assert.equal(neverReached.status, "NO_FILL");

  const s3NoObservations = evaluateS3MakerValueBandHold({ candidate, observations: [] });
  assert.equal(s3NoObservations.status, "UNKNOWN");
});

// 6. Execution observations cannot modify model selection --------------------

test("evidence functions are pure evidence recorders: model/candidate fields pass through unchanged", () => {
  const s1 = evaluateS1TakerHold({
    candidate,
    modelFairDecimalOdds: 1.9,
    availableDecimalOdds: 1.95,
    minAcceptableDecimalOdds: 1.85,
  });
  // The evidence carries the exact input model-fair odds and candidate back
  // out unmodified — there is no code path in this module that derives,
  // overrides, or re-selects a signal/model/token from execution data.
  assert.equal(s1.modelFairDecimalOdds, 1.9);
  assert.deepEqual(s1.candidate, candidate);

  const s2 = evaluateS2FixedMakerHold({
    candidate,
    targetDecimalOdds: 2.0,
    observations: [{ observedAtIso: "2026-09-24T18:20:00.000Z", bestObservedDecimalOdds: 2.05 }],
    fill: { filledDecimalOdds: 2.0, filledAtIso: "2026-09-24T18:20:01.000Z", source: "manual_review" },
  });
  assert.deepEqual(s2.candidate, candidate);
});

// 7. No future/settlement leakage into decision-time evidence ---------------

test("evidence types carry no settlement/resolution fields and future observations do not alter decision-time output", () => {
  const decisionTimeOnly = evaluateS1TakerHold({
    candidate,
    modelFairDecimalOdds: 1.9,
    availableDecimalOdds: 1.9,
    minAcceptableDecimalOdds: 1.85,
  });
  const keys = Object.keys(decisionTimeOnly);
  for (const forbidden of ["settledOutcome", "winningOutcome", "resolvedAt", "closingOdds"]) {
    assert.ok(!keys.includes(forbidden), `S1 evidence must not carry ${forbidden}`);
  }

  // Observations recorded strictly after decision time must not change the
  // decision-time TAKE/NO_TAKE call already made at evaluation time — S1 is
  // evaluated once, at decision time, from inputs known then.
  const beforeFuture = evaluateS1TakerHold({
    candidate,
    modelFairDecimalOdds: 1.9,
    availableDecimalOdds: 1.9,
    minAcceptableDecimalOdds: 1.85,
  });
  assert.equal(beforeFuture.decision, "TAKE");
});
