// Phase 3E.8E.2A -- post-cutoff eligibility + idempotent observation identity.
//
// Pure boundary module: exclusive post-cutoff filtering by resolved_at, a
// stable observation key, and UTC Monday-start week buckets. No model
// membership, PnL, persistence, fs, network, env, or Supabase. Deterministic
// and timezone-independent (all math in UTC).

import test from "node:test";
import assert from "node:assert/strict";
import {
  POST_CUTOFF_RESOLVED_AT_EXCLUSIVE,
  parseObservationTimestamp,
  isPostCutoffResolvedRow,
  filterPostCutoffResolvedRows,
  buildObservationKey,
  getUtcWeekBucket,
} from "../../lib/modeling/postCutoffObservation";

const CUTOFF = "2026-07-13T06:04:05.701Z";

// ---- Cutoff eligibility ----

test("C1: a timestamp one millisecond after the cutoff is included", () => {
  assert.equal(isPostCutoffResolvedRow({ resolved_at: "2026-07-13T06:04:05.702Z" }), true);
});

test("C2: a timestamp exactly equal to the cutoff is excluded", () => {
  assert.equal(isPostCutoffResolvedRow({ resolved_at: CUTOFF }), false);
});

test("C3: a timestamp one millisecond before the cutoff is excluded", () => {
  assert.equal(isPostCutoffResolvedRow({ resolved_at: "2026-07-13T06:04:05.700Z" }), false);
});

test("C4: created_at after cutoff does not matter when resolved_at is before cutoff", () => {
  assert.equal(
    isPostCutoffResolvedRow({ resolved_at: "2026-07-13T06:04:05.700Z", created_at: "2027-01-01T00:00:00Z" }),
    false,
  );
});

test("C5: created_at before cutoff does not matter when resolved_at is after cutoff", () => {
  assert.equal(
    isPostCutoffResolvedRow({ resolved_at: "2026-07-13T06:04:05.702Z", created_at: "2020-01-01T00:00:00Z" }),
    true,
  );
});

test("C6: an offset timestamp equivalent to an after-cutoff UTC instant is included", () => {
  // 08:04:05.702+02:00 == 06:04:05.702Z, which is after the cutoff.
  assert.equal(isPostCutoffResolvedRow({ resolved_at: "2026-07-13T08:04:05.702+02:00" }), true);
});

test("C7: a missing resolved_at is excluded", () => {
  assert.equal(isPostCutoffResolvedRow({ created_at: "2027-01-01T00:00:00Z" }), false);
});

test("C8: a malformed resolved_at is excluded", () => {
  assert.equal(isPostCutoffResolvedRow({ resolved_at: "not-a-date" }), false);
  assert.equal(isPostCutoffResolvedRow({ resolved_at: 42 }), false);
  assert.equal(isPostCutoffResolvedRow({ resolved_at: "" }), false);
});

test("C9: a malformed explicit cutoff throws a deterministic error", () => {
  assert.throws(() => isPostCutoffResolvedRow({ resolved_at: "2026-07-13T06:04:05.702Z" }, "not-a-date"));
  assert.throws(() => filterPostCutoffResolvedRows([], "garbage"));
});

test("C10: input order is preserved by the filter", () => {
  const rows = [
    { id: "a", resolved_at: "2026-07-13T06:04:05.703Z" },
    { id: "b", resolved_at: "2026-07-13T06:04:05.702Z" },
    { id: "c", resolved_at: "2026-07-13T06:04:05.704Z" },
  ];
  const out = filterPostCutoffResolvedRows(rows);
  assert.deepEqual(out.map((r) => r.id), ["a", "b", "c"]);
});

test("C11: the input array and its rows are not mutated", () => {
  const rows = [{ id: "a", resolved_at: "2026-07-13T06:04:05.702Z" }];
  const snapshot = JSON.parse(JSON.stringify(rows));
  filterPostCutoffResolvedRows(rows);
  assert.deepEqual(rows, snapshot);
});

test("C12: duplicate eligible rows remain duplicated (no dedup at this layer)", () => {
  const r = { condition_id: "0xAbc", token_id: "t1", resolved_at: "2026-07-13T06:04:05.702Z" };
  const out = filterPostCutoffResolvedRows([r, { ...r }]);
  assert.equal(out.length, 2);
});

// ---- Observation identity ----

test("K13: a stable key is built from condition_id, token_id, resolved_at", () => {
  const key = buildObservationKey({ condition_id: "0xabc", token_id: "t1", resolved_at: "2026-07-13T06:04:05.702Z" });
  assert.equal(key, "0xabc::t1::2026-07-13T06:04:05.702Z");
});

test("K14: uppercase and lowercase condition IDs normalize identically", () => {
  const a = buildObservationKey({ condition_id: "0xABC", token_id: "t1", resolved_at: "2026-07-13T06:04:05.702Z" });
  const b = buildObservationKey({ condition_id: "0xabc", token_id: "t1", resolved_at: "2026-07-13T06:04:05.702Z" });
  assert.equal(a, b);
});

test("K15: equivalent timezone timestamps normalize identically", () => {
  const a = buildObservationKey({ condition_id: "0xabc", token_id: "t1", resolved_at: "2026-07-13T08:04:05.702+02:00" });
  const b = buildObservationKey({ condition_id: "0xabc", token_id: "t1", resolved_at: "2026-07-13T06:04:05.702Z" });
  assert.equal(a, b);
});

test("K16: surrounding whitespace around IDs is ignored", () => {
  const a = buildObservationKey({ condition_id: "  0xabc  ", token_id: "  t1 ", resolved_at: "2026-07-13T06:04:05.702Z" });
  assert.equal(a, "0xabc::t1::2026-07-13T06:04:05.702Z");
});

test("K17: a missing condition_id returns null", () => {
  assert.equal(buildObservationKey({ token_id: "t1", resolved_at: "2026-07-13T06:04:05.702Z" }), null);
});

test("K18: a missing token_id returns null", () => {
  assert.equal(buildObservationKey({ condition_id: "0xabc", resolved_at: "2026-07-13T06:04:05.702Z" }), null);
});

test("K19: a malformed resolved timestamp returns null", () => {
  assert.equal(buildObservationKey({ condition_id: "0xabc", token_id: "t1", resolved_at: "not-a-date" }), null);
  assert.equal(buildObservationKey({ condition_id: "0xabc", token_id: "t1" }), null);
});

test("K20: changing any canonical component changes the key", () => {
  const base = buildObservationKey({ condition_id: "0xabc", token_id: "t1", resolved_at: "2026-07-13T06:04:05.702Z" });
  const diffCond = buildObservationKey({ condition_id: "0xdef", token_id: "t1", resolved_at: "2026-07-13T06:04:05.702Z" });
  const diffTok = buildObservationKey({ condition_id: "0xabc", token_id: "t2", resolved_at: "2026-07-13T06:04:05.702Z" });
  const diffTs = buildObservationKey({ condition_id: "0xabc", token_id: "t1", resolved_at: "2026-07-13T06:04:05.703Z" });
  assert.notEqual(base, diffCond);
  assert.notEqual(base, diffTok);
  assert.notEqual(base, diffTs);
});

// ---- UTC week bucket ----

test("W21: a Monday UTC maps to itself", () => {
  // 2026-07-13 is a Monday.
  assert.equal(getUtcWeekBucket("2026-07-13T06:04:05.702Z"), "2026-07-13");
});

test("W22: a Tuesday maps back to Monday", () => {
  assert.equal(getUtcWeekBucket("2026-07-14T00:00:00Z"), "2026-07-13");
});

test("W23: a Sunday maps to the preceding Monday", () => {
  // 2026-07-19 is a Sunday.
  assert.equal(getUtcWeekBucket("2026-07-19T23:59:59Z"), "2026-07-13");
});

test("W24: a year-boundary week is computed correctly", () => {
  // 2027-01-01 is a Friday; its Monday is 2026-12-28.
  assert.equal(getUtcWeekBucket("2027-01-01T12:00:00Z"), "2026-12-28");
});

test("W25: an offset timestamp is normalized to UTC before bucketing", () => {
  // 2026-07-13T01:00:00-06:00 == 2026-07-13T07:00:00Z (Monday).
  assert.equal(getUtcWeekBucket("2026-07-13T01:00:00-06:00"), "2026-07-13");
  // 2026-07-13T00:30:00+02:00 == 2026-07-12T22:30:00Z (Sunday) -> preceding Monday 2026-07-06.
  assert.equal(getUtcWeekBucket("2026-07-13T00:30:00+02:00"), "2026-07-06");
});

test("W26: an invalid timestamp returns null", () => {
  assert.equal(getUtcWeekBucket("not-a-date"), null);
  assert.equal(getUtcWeekBucket(undefined), null);
  assert.equal(getUtcWeekBucket(123), null);
});

test("W27: the bucket does not depend on the local timezone", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const a = getUtcWeekBucket("2026-07-13T06:04:05.702Z");
    process.env.TZ = "Asia/Tokyo";
    const b = getUtcWeekBucket("2026-07-13T06:04:05.702Z");
    assert.equal(a, "2026-07-13");
    assert.equal(b, "2026-07-13");
  } finally {
    process.env.TZ = original;
  }
});

// ---- parse helper + locked constant ----

test("P0: parseObservationTimestamp returns a Date for valid input and null otherwise", () => {
  assert.ok(parseObservationTimestamp("2026-07-13T06:04:05.702Z") instanceof Date);
  assert.equal(parseObservationTimestamp("not-a-date"), null);
  assert.equal(parseObservationTimestamp(42), null);
  assert.equal(parseObservationTimestamp(null), null);
});

test("L28: the exported default cutoff exactly equals the locked value", () => {
  assert.equal(POST_CUTOFF_RESOLVED_AT_EXCLUSIVE, "2026-07-13T06:04:05.701Z");
});
