// RESERVATION_MIX_GUARD_V1 — cap 30, football (SOCCER/WC) > 65% share,
// TENNIS < 25% share, priority football -> eligible tennis -> other
// qualified sports, shrinking N rather than violating either ratio.
//   node --import tsx --test tests/contur3/liveReservationMixGuard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_RESERVATION_MIX_GUARD_V1,
  selectLiveReservationMix,
  applyLiveReservationMixGuard,
  type LiveReservationAllocationCandidate,
} from "../../lib/executor/liveReservationAllocationPolicy";

function pool(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
}

test("MIX-1: at N=30 with limited football supply, football >= 20 and tennis <= 7", () => {
  // 22 football (more than the N=30 floor of 20, but not enough to saturate
  // the cap alone) plus abundant tennis and other: football fills first,
  // tennis fills up to its share ceiling, other takes the remainder.
  const result = selectLiveReservationMix(pool("fb", 22), pool("tn", 40), pool("ot", 40));
  assert.equal(result.finalN, 30);
  assert.ok(result.footballCount >= 20, `expected football >= 20, got ${result.footballCount}`);
  assert.ok(result.tennisCount <= 7, `expected tennis <= 7, got ${result.tennisCount}`);
  assert.equal(result.footballCount, 22);
  assert.equal(result.tennisCount, 7);
  assert.equal(result.otherCount, 1);
  assert.equal(result.selected.length, 30);
});

test("MIX-1b: abundant football alone may saturate the cap -- football has no upper-bound ratio", () => {
  const result = selectLiveReservationMix(pool("fb", 40), pool("tn", 40), pool("ot", 40));
  assert.equal(result.finalN, 30);
  assert.equal(result.footballCount, 30);
  assert.equal(result.tennisCount, 0);
  assert.ok(result.footballCount >= 20 && result.tennisCount <= 7);
});

test("MIX-2: football share is always strictly greater than 65% of the final N", () => {
  const result = selectLiveReservationMix(pool("fb", 40), pool("tn", 40), pool("ot", 40));
  assert.ok(result.footballCount / result.finalN > LIVE_RESERVATION_MIX_GUARD_V1.footballMinShareExclusive);
});

test("MIX-3: tennis share is always strictly less than 25% of the final N", () => {
  const result = selectLiveReservationMix(pool("fb", 40), pool("tn", 40), pool("ot", 40));
  assert.ok(result.tennisCount / result.finalN < LIVE_RESERVATION_MIX_GUARD_V1.tennisMaxShareExclusive);
});

test("MIX-4: priority order is football, then eligible tennis, then other, up to cap 30", () => {
  // Only 5 football available: football-limited scenario, no other candidates.
  const result = selectLiveReservationMix(pool("fb", 5), pool("tn", 40), []);
  // football=5 requires N such that 5 > 0.65*N -> N < 7.69 -> N<=7.
  // At N=7: minFootball = floor(4.55)+1 = 5 -> football=5 satisfies it exactly.
  assert.equal(result.footballCount, 5);
  assert.ok(result.footballCount / result.finalN > 0.65);
  assert.ok(result.finalN <= 7);
});

test("MIX-5: with zero football candidates, no reservation can be made (football floor unmet)", () => {
  const result = selectLiveReservationMix([], pool("tn", 40), pool("ot", 40));
  assert.equal(result.finalN, 0);
  assert.equal(result.selected.length, 0);
});

test("MIX-6: N shrinks below cap rather than violating a ratio when supply is thin", () => {
  // Only 3 football, no tennis, no other -- cap is limited by football's own floor.
  const result = selectLiveReservationMix(pool("fb", 3), [], []);
  assert.equal(result.footballCount, 3);
  assert.equal(result.finalN, 3);
  assert.ok(3 / 3 > 0.65);
});

test("MIX-7: applyLiveReservationMixGuard partitions by strategic_scope and preserves rank order", () => {
  function candidate(id: string, scope: string): LiveReservationAllocationCandidate {
    return {
      decision: {
        physical_event_id: id,
        strategic_scope: scope,
        planning_score: 0,
        event_start_iso: "2026-01-01T00:00:00.000Z",
        decision_version: "v1",
        source_lineage: {},
      } as unknown as LiveReservationAllocationCandidate["decision"],
      providerMarketVolume: null,
    };
  }

  const ranked: LiveReservationAllocationCandidate[] = [
    ...Array.from({ length: 40 }, (_, i) => candidate(`fb-${i}`, i % 2 === 0 ? "SOCCER" : "WC")),
    ...Array.from({ length: 40 }, (_, i) => candidate(`tn-${i}`, "TENNIS")),
    ...Array.from({ length: 40 }, (_, i) => candidate(`ot-${i}`, "MLB")),
  ];

  const selected = applyLiveReservationMixGuard(ranked, {
    cap: 30,
    footballMinShareExclusive: 0.65,
    tennisMaxShareExclusive: 0.25,
  });

  assert.equal(selected.length, 30);
  const footballCount = selected.filter((c) => c.decision.strategic_scope === "SOCCER" || c.decision.strategic_scope === "WC").length;
  const tennisCount = selected.filter((c) => c.decision.strategic_scope === "TENNIS").length;
  assert.ok(footballCount >= 20, `expected football >= 20, got ${footballCount}`);
  assert.ok(tennisCount <= 7, `expected tennis <= 7, got ${tennisCount}`);

  // Order preserved relative to the original ranked array.
  const originalIndexOf = (id: string) => ranked.findIndex((c) => c.decision.physical_event_id === id);
  for (let i = 1; i < selected.length; i++) {
    assert.ok(
      originalIndexOf(selected[i - 1].decision.physical_event_id) <
        originalIndexOf(selected[i].decision.physical_event_id),
      "mix guard must preserve original rank order of surviving candidates",
    );
  }
});
