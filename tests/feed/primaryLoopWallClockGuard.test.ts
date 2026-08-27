import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createPrimaryLoopBudgetGuard,
  PRIMARY_LOOP_DEFAULT_BUDGET_MS,
  PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON,
  PRIMARY_SCORER_PROVEN_CAPACITY,
  RESEARCH_SCORER_DEFAULT_BUDGET_MS,
} from "../../lib/feed/buildLandingCards";

// MISSION: ADD_PRIMARY_SCORER_WALL_CLOCK_GUARD
//
// Removing the artificial limit*3 (=45) positional cap let the sequential primary
// candidate loop process up to PRIMARY_SCORER_PROVEN_CAPACITY (254 advisory)
// events. 254 is a finite count, not a time bound: if per-event enrichment
// latency regresses, 254 sequential iterations can consume unbounded producer
// runtime. These tests pin the wall-clock guard that replaces "254 events" with
// "254 events OR the elapsed budget, whichever comes first" — a runtime-safety
// boundary only, never an event-selection/ranking policy.
//
// Run: node --import tsx --test tests/feed/primaryLoopWallClockGuard.test.ts

/** Deterministic fake clock. advance(ms) simulates wall time passing. */
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

test("PRIMARY_LOOP_TIME_BUDGET_VALUE reuses the producer's existing scoring-budget magnitude", () => {
  assert.equal(PRIMARY_LOOP_DEFAULT_BUDGET_MS, RESEARCH_SCORER_DEFAULT_BUDGET_MS);
  assert.equal(PRIMARY_LOOP_DEFAULT_BUDGET_MS, 6 * 60_000);
});

test("B. guard is not exhausted before the budget elapses and becomes exhausted at the boundary", () => {
  const clock = fakeClock();
  const guard = createPrimaryLoopBudgetGuard({
    startedAtMs: clock.now(),
    budgetMs: 60_000,
    now: clock.now,
  });

  assert.equal(guard.isExhausted(), false);
  clock.advance(59_999);
  assert.equal(guard.isExhausted(), false, "one ms before budget: still open");
  clock.advance(1);
  assert.equal(guard.isExhausted(), true, "exactly at budget: exhausted");
  clock.advance(10_000);
  assert.equal(guard.isExhausted(), true, "past budget: stays exhausted");
});

test("budget is clamped to the same [1s, 30min] window as researchScorerBudgetMs", () => {
  const clock = fakeClock();
  const tooSmall = createPrimaryLoopBudgetGuard({ startedAtMs: clock.now(), budgetMs: 10, now: clock.now });
  const tooLarge = createPrimaryLoopBudgetGuard({ startedAtMs: clock.now(), budgetMs: 999 * 60_000, now: clock.now });
  assert.equal(tooSmall.budgetMs, 1_000);
  assert.equal(tooLarge.budgetMs, 30 * 60_000);
});

// ── Deterministic simulation of the primary candidate loop wiring ────────────
// Mirrors the guard placement in buildLandingCards: the budget is consulted
// BEFORE opening new candidate work; an event already started is never
// interrupted; every candidate that enters the loop is attributed exactly once
// (conservation: sum(terminalReasonCounts) === candidatesEntered).
function simulatePrimaryLoop(opts: {
  candidateCount: number;
  perCandidateLatencyMs: number;
  budgetMs?: number;
}) {
  const clock = fakeClock();
  const candidates = Array.from({ length: opts.candidateCount }, (_, i) => ({
    gameId: `g-${String(i).padStart(4, "0")}`,
    order: i,
  }));

  const guard = createPrimaryLoopBudgetGuard({
    startedAtMs: clock.now(),
    budgetMs: opts.budgetMs,
    now: clock.now,
  });

  const terminalReasonCounts: Record<string, number> = {};
  const record = (code: string) => {
    terminalReasonCounts[code] = (terminalReasonCounts[code] ?? 0) + 1;
  };

  let candidatesEntered = 0;
  let budgetExhausted = false;
  const evaluatedOrder: string[] = [];
  const notEvaluatedOrder: string[] = [];

  for (const candidate of candidates) {
    if (!budgetExhausted && guard.isExhausted()) budgetExhausted = true;
    if (budgetExhausted) {
      candidatesEntered++;
      record(PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON);
      notEvaluatedOrder.push(candidate.gameId);
      continue;
    }
    candidatesEntered++;
    // "opening candidate work" — the expensive per-event enrichment
    clock.advance(opts.perCandidateLatencyMs);
    record("PRIMARY_QUALIFIED");
    evaluatedOrder.push(candidate.gameId);
  }

  return {
    candidatesEntered,
    terminalReasonCounts,
    evaluatedOrder,
    notEvaluatedOrder,
    budgetExhausted,
    elapsedMs: guard.elapsedMs(),
    budgetMs: guard.budgetMs,
  };
}

test("A. >45 eligible candidates are still admitted when the loop stays inside budget", () => {
  const r = simulatePrimaryLoop({
    candidateCount: PRIMARY_SCORER_PROVEN_CAPACITY,
    perCandidateLatencyMs: 240, // ~61s for 254, the proven production rate
  });

  assert.ok(r.evaluatedOrder.length > 45, `expected >45 evaluated, got ${r.evaluatedOrder.length}`);
  assert.equal(r.evaluatedOrder.length, 254, "whole advisory population evaluated when it fits the budget");
  assert.equal(r.budgetExhausted, false);
  assert.equal(r.terminalReasonCounts[PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON], undefined);
});

test("D. normal non-exhausted behavior is unchanged — no budget terminal reason recorded", () => {
  const r = simulatePrimaryLoop({ candidateCount: 30, perCandidateLatencyMs: 100 });
  assert.equal(r.candidatesEntered, 30);
  assert.equal(r.terminalReasonCounts["PRIMARY_QUALIFIED"], 30);
  assert.equal(r.budgetExhausted, false);
  assert.deepEqual(Object.keys(r.terminalReasonCounts), ["PRIMARY_QUALIFIED"]);
});

test("B+G. once the wall-clock budget is spent the loop opens no further candidate work", () => {
  const r = simulatePrimaryLoop({
    candidateCount: PRIMARY_SCORER_PROVEN_CAPACITY,
    perCandidateLatencyMs: 5_000, // pathological: 5s/event -> 254 events would be ~21min
    budgetMs: 60_000,
  });

  // 60s budget / 5s per event => 12 events opened, then the guard trips.
  assert.equal(r.evaluatedOrder.length, 12);
  assert.equal(r.budgetExhausted, true);
  assert.ok(
    r.evaluatedOrder.length < PRIMARY_SCORER_PROVEN_CAPACITY,
    "254 can no longer cause unbounded-in-time sequential processing",
  );
  // elapsed wall time is bounded by budget + at most one in-flight candidate
  assert.ok(r.elapsedMs <= r.budgetMs + 5_000);
});

test("C. budget-exhausted candidates get an explicit NOT_EVALUATED classification, not a failure code", () => {
  const r = simulatePrimaryLoop({
    candidateCount: PRIMARY_SCORER_PROVEN_CAPACITY,
    perCandidateLatencyMs: 5_000,
    budgetMs: 60_000,
  });

  const notEvaluated = r.terminalReasonCounts[PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON];
  assert.equal(notEvaluated, 254 - 12);

  // distinct from every enrichment / score / product failure code
  assert.equal(PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON, "PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET");
  assert.doesNotMatch(PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON, /ENRICHMENT_NULL|NOT_SCORED|REJECTED/);

  // conservation: every candidate that entered the loop is attributed exactly once
  const totalAttributed = Object.values(r.terminalReasonCounts).reduce((a, b) => a + b, 0);
  assert.equal(totalAttributed, r.candidatesEntered);
  assert.equal(r.candidatesEntered, PRIMARY_SCORER_PROVEN_CAPACITY);
});

test("E. candidate ordering stays deterministic — evaluated events are a contiguous input-order prefix", () => {
  const r = simulatePrimaryLoop({
    candidateCount: 100,
    perCandidateLatencyMs: 5_000,
    budgetMs: 60_000,
  });

  const expectedEvaluated = Array.from({ length: 12 }, (_, i) => `g-${String(i).padStart(4, "0")}`);
  const expectedNotEvaluated = Array.from({ length: 88 }, (_, i) => `g-${String(i + 12).padStart(4, "0")}`);
  assert.deepEqual(r.evaluatedOrder, expectedEvaluated);
  assert.deepEqual(r.notEvaluatedOrder, expectedNotEvaluated);
});
