// RESERVATION_MIX_GUARD_V1 — staged Reservation fill semantics.
//   node --import tsx --test tests/contur3/liveReservationMixGuard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_RESERVATION_MIX_GUARD_V1,
  selectLiveReservationMix,
} from "../../lib/executor/liveReservationAllocationPolicy";

function pool(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
}

test(">=20 football reserves exactly 20, then at most 7 tennis, then other", () => {
  const result = selectLiveReservationMix(pool("fb", 24), pool("tn", 20), pool("ot", 20));
  assert.equal(result.footballCount, 20);
  assert.equal(result.tennisCount, 7);
  assert.equal(result.otherCount, 3);
  assert.equal(result.finalN, 30);
  assert.deepEqual(result.selected.slice(0, 20), pool("fb", 20));
});

test("football shortage makes tennis the unrestricted first fallback", () => {
  const result = selectLiveReservationMix(pool("fb", 5), pool("tn", 30), pool("ot", 10));
  assert.equal(result.footballCount, 5);
  assert.equal(result.tennisCount, 25);
  assert.equal(result.otherCount, 0);
  assert.equal(result.finalN, 30);
  assert.ok(result.tennisCount > LIVE_RESERVATION_MIX_GUARD_V1.tennisMaxWhenFootballSufficient);
  assert.deepEqual(result.selected.slice(0, 5), pool("fb", 5));
});

test("zero football does not collapse the portfolio", () => {
  const result = selectLiveReservationMix([], pool("tn", 20), pool("ot", 20));
  assert.equal(result.footballCount, 0);
  assert.equal(result.tennisCount, 20);
  assert.equal(result.otherCount, 10);
  assert.equal(result.finalN, 30);
});

test("an undersupplied portfolio uses every available qualified candidate without ratio shrink", () => {
  const result = selectLiveReservationMix(pool("fb", 3), pool("tn", 6), pool("ot", 4));
  assert.equal(result.finalN, 13);
  assert.equal(result.footballCount, 3);
  assert.equal(result.tennisCount, 6);
  assert.equal(result.otherCount, 4);
});
