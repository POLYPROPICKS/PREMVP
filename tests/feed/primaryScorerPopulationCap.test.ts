import { test } from "node:test";
import assert from "node:assert/strict";

import {
  boundPrimaryScorerPopulation,
  PRIMARY_SCORER_PROVEN_CAPACITY,
} from "../../lib/feed/buildLandingCards";

// MISSION: REMOVE_ARTIFICIAL_PRE_SCORER_CAP
//
// Proven defect on origin/main 002805749bdb: 587 liquidity-eligible physical
// events -> 45 primary-scorer inputs. The 542-event loss was caused solely by the
// positional caps `targetCards: limit * 2` and
// `[...finalCandidates, ...fallback48hCandidates].slice(0, limit * 3)` with the
// live `limit = 15`. These tests pin the population-construction boundary that
// replaces those caps.
//
// Run: node --import tsx --test tests/feed/primaryScorerPopulationCap.test.ts

const sample = (i: number) => ({ gameId: `g-${String(i).padStart(4, "0")}`, order: i });

test("A. a >45 population is NOT truncated to 45 by the retired limit*3 cap", () => {
  const primary24h = Array.from({ length: 90 }, (_, i) => sample(i));
  const fallback48h = Array.from({ length: 30 }, (_, i) => sample(100 + i));

  const bounded = boundPrimaryScorerPopulation(primary24h, fallback48h);

  // limit=15 -> retired cap was limit*3 = 45.
  assert.ok(bounded.length > 45, `expected >45 scorer inputs, got ${bounded.length}`);
  assert.equal(bounded.length, 120, "whole population reaches the scorer when it fits under proven capacity");
});

test("F. processing stays bounded by the proven scorer capacity — never unbounded", () => {
  const primary24h = Array.from({ length: 400 }, (_, i) => sample(i));
  const fallback48h = Array.from({ length: 400 }, (_, i) => sample(1000 + i));

  const bounded = boundPrimaryScorerPopulation(primary24h, fallback48h);

  assert.equal(bounded.length, PRIMARY_SCORER_PROVEN_CAPACITY);
  assert.equal(PRIMARY_SCORER_PROVEN_CAPACITY, 254, "capacity is the runtime-proven ~254 events, not a fresh arbitrary constant");
});

test("B. deterministic ordering preserved: 24h block first, then 48h fallback, input order intact", () => {
  const primary24h = Array.from({ length: 60 }, (_, i) => sample(i));
  const fallback48h = Array.from({ length: 60 }, (_, i) => sample(500 + i));

  const bounded = boundPrimaryScorerPopulation(primary24h, fallback48h);
  const expected = [...primary24h, ...fallback48h].slice(0, PRIMARY_SCORER_PROVEN_CAPACITY);

  assert.deepEqual(bounded.map((s) => s.gameId), expected.map((s) => s.gameId));
  assert.deepEqual(bounded.slice(0, 60), primary24h, "every 24h sample keeps its exact position ahead of any fallback sample");
});

test("E. population at/below the bound is returned unchanged — no event added, no gate bypassed", () => {
  const primary24h = Array.from({ length: 20 }, (_, i) => sample(i));
  const fallback48h = Array.from({ length: 10 }, (_, i) => sample(200 + i));

  const bounded = boundPrimaryScorerPopulation(primary24h, fallback48h);

  assert.equal(bounded.length, 30);
  assert.deepEqual(bounded, [...primary24h, ...fallback48h], "concatenation only — the helper never fabricates or reorders events");
});

test("boundary is exactly at the proven capacity (off-by-one witness)", () => {
  const at = Array.from({ length: PRIMARY_SCORER_PROVEN_CAPACITY }, (_, i) => sample(i));
  const over = Array.from({ length: PRIMARY_SCORER_PROVEN_CAPACITY + 1 }, (_, i) => sample(i));

  assert.equal(boundPrimaryScorerPopulation(at, []).length, PRIMARY_SCORER_PROVEN_CAPACITY);
  assert.equal(boundPrimaryScorerPopulation(over, []).length, PRIMARY_SCORER_PROVEN_CAPACITY);
});
