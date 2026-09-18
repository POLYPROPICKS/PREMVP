import { test } from "node:test";
import assert from "node:assert/strict";

import {
  boundPrimaryScorerPopulation,
  PRIMARY_SCORER_PROVEN_CAPACITY,
  PRIMARY_LOOP_DEFAULT_BUDGET_MS,
  PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON,
} from "../../lib/feed/buildLandingCards";

// MISSION: REMOVE_ARTIFICIAL_PRE_SCORER_CAP
//
// The fixed 254 physical-event membership ceiling is retired. The primary loop
// is bounded by the wall-clock guard PRIMARY_LOOP_DEFAULT_BUDGET_MS; unevaluated
// tail candidates are attributed as
// PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET. No eligibility, model,
// sport, market, timing, or fan-out gate is widened here.
//
// Run: node --import tsx --test tests/feed/primaryScorerPopulationCap.test.ts

const sample = (i: number) => ({ gameId: `g-${String(i).padStart(4, "0")}`, order: i });

test("default capacity is unbounded: the full eligible population reaches the primary loop", () => {
  const primary24h = Array.from({ length: 400 }, (_, i) => sample(i));
  const fallback48h = Array.from({ length: 200 }, (_, i) => sample(1000 + i));

  const bounded = boundPrimaryScorerPopulation(primary24h, fallback48h);

  assert.equal(bounded.length, 600, "default returns every concatenated candidate");
});

test("explicit capacity still slices deterministically when supplied", () => {
  const primary24h = Array.from({ length: 200 }, (_, i) => sample(i));
  const fallback48h = Array.from({ length: 200 }, (_, i) => sample(1000 + i));

  const bounded = boundPrimaryScorerPopulation(primary24h, fallback48h, PRIMARY_SCORER_PROVEN_CAPACITY);

  assert.equal(bounded.length, PRIMARY_SCORER_PROVEN_CAPACITY);
  assert.equal(PRIMARY_SCORER_PROVEN_CAPACITY, 254);
});

test("deterministic ordering preserved: 24h block first, then 48h fallback, input order intact", () => {
  const primary24h = Array.from({ length: 60 }, (_, i) => sample(i));
  const fallback48h = Array.from({ length: 60 }, (_, i) => sample(500 + i));

  const bounded = boundPrimaryScorerPopulation(primary24h, fallback48h);
  const expected = [...primary24h, ...fallback48h];

  assert.deepEqual(bounded.map((s) => s.gameId), expected.map((s) => s.gameId));
  assert.deepEqual(bounded.slice(0, 60), primary24h, "24h block precedes 48h fallback");
});

test("population at/below default capacity is returned unchanged", () => {
  const primary24h = Array.from({ length: 20 }, (_, i) => sample(i));
  const fallback48h = Array.from({ length: 10 }, (_, i) => sample(200 + i));

  const bounded = boundPrimaryScorerPopulation(primary24h, fallback48h);

  assert.equal(bounded.length, 30);
  assert.deepEqual(bounded, [...primary24h, ...fallback48h], "concatenation only");
});

test("wall-clock guard and budget-exhaustion terminal reason remain present", () => {
  assert.equal(typeof PRIMARY_LOOP_DEFAULT_BUDGET_MS, "number");
  assert.ok(PRIMARY_LOOP_DEFAULT_BUDGET_MS > 0, "primary loop has a finite wall-clock budget");
  assert.equal(
    PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON,
    "PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET",
  );
});
