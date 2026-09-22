import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareChronologically,
  evaluateEvent,
  sortChronologically,
  type ResearchEngineInputEvent,
} from "../../../lib/modeling/research-engine";

/**
 * Regression for the true-candidate-total-order fix: two candidate rows tied
 * on decisionTimestamp/eventStart/physicalEventKey/entryPrice/sportFamily/ref
 * (=conditionId) but with opposite selectedTokenId and opposite outcomes must
 * no longer compare equal, and selection must be identical regardless of
 * input order.
 */
const SHARED = {
  decisionTimestamp: "2026-08-10T12:00:00.000Z",
  eventStart: "2026-08-10T18:00:00.000Z",
  physicalEventKey: "evt-tied-1",
  entryPrice: 0.51,
  sportFamily: "soccer",
  ref: "condition-shared", // same conditionId — the previous total-order chain's final key
} as const;

const rowA: ResearchEngineInputEvent = {
  ...SHARED,
  outcome: "WIN",
  candidateRef: "token-a",
};

const rowB: ResearchEngineInputEvent = {
  ...SHARED,
  outcome: "LOSS",
  candidateRef: "token-b",
};

test("compareChronologically no longer ties on opposite selectedTokenId candidates", () => {
  const a = evaluateEvent(rowA);
  const b = evaluateEvent(rowB);
  assert.notEqual(compareChronologically(a, b), 0);
  assert.notEqual(compareChronologically(b, a), 0);
});

test("candidate ordering is stable regardless of input order", () => {
  const forward = sortChronologically([rowA, rowB].map(evaluateEvent));
  const reversed = sortChronologically([rowB, rowA].map(evaluateEvent));
  assert.equal(forward[0].candidateRef, reversed[0].candidateRef);
  assert.equal(forward[1].candidateRef, reversed[1].candidateRef);
});

test("selected side (winner of the tie) is identical under forward/reversed input", () => {
  const forwardWinner = sortChronologically([rowA, rowB].map(evaluateEvent))[0];
  const reversedWinner = sortChronologically([rowB, rowA].map(evaluateEvent))[0];
  assert.equal(forwardWinner.candidateRef, reversedWinner.candidateRef);
  assert.equal(forwardWinner.outcome, reversedWinner.outcome);
});
