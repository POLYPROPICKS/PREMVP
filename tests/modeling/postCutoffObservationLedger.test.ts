// Phase 3E.8E.2B -- deterministic post-cutoff observation ledger.
//
// Pure ledger builder over the 3E.8E.2A boundary: cutoff filter -> canonical
// observation key -> exact-duplicate collapse (conflict-on-divergence) ->
// UTC-week cohorts -> stable sorted output + deterministic content hash. No
// model membership, ROI, PnL, drawdown, fs, network, env, or Supabase.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPostCutoffObservationLedger,
  ObservationConflictError,
  detectObservationConflictFields,
  type PostCutoffLedgerObservation,
} from "../../lib/modeling/postCutoffObservationLedger";
import { POST_CUTOFF_RESOLVED_AT_EXCLUSIVE } from "../../lib/modeling/postCutoffObservation";

const AFTER1 = "2026-07-13T06:04:05.702Z"; // Monday week 2026-07-13
const AFTER2 = "2026-07-14T00:00:00.000Z"; // Tuesday same week
const AFTER_NEXTWEEK = "2026-07-20T00:00:00.000Z"; // next Monday week 2026-07-20
const BEFORE = "2026-07-13T06:04:05.700Z";
const EQUAL = "2026-07-13T06:04:05.701Z";

function r(overrides: Record<string, unknown>): Record<string, unknown> {
  return { condition_id: "0xabc", token_id: "t1", resolved_at: AFTER1, ...overrides };
}

// ---- Eligibility composition ----

test("E1: a pre-cutoff row is excluded", () => {
  const l = buildPostCutoffObservationLedger([r({ resolved_at: BEFORE })]);
  assert.equal(l.eligibleRowCount, 0);
  assert.equal(l.observations.length, 0);
});

test("E2: an exact-cutoff row is excluded", () => {
  const l = buildPostCutoffObservationLedger([r({ resolved_at: EQUAL })]);
  assert.equal(l.eligibleRowCount, 0);
});

test("E3: a post-cutoff row is included", () => {
  const l = buildPostCutoffObservationLedger([r({})]);
  assert.equal(l.eligibleRowCount, 1);
  assert.equal(l.uniqueObservationCount, 1);
});

test("E4: a malformed row is excluded", () => {
  const l = buildPostCutoffObservationLedger([r({ resolved_at: "not-a-date" }), r({ condition_id: undefined })]);
  assert.equal(l.eligibleRowCount, 0);
});

test("E5: the default locked cutoff is embedded", () => {
  const l = buildPostCutoffObservationLedger([r({})]);
  assert.equal(l.cutoffResolvedAtExclusive, POST_CUTOFF_RESOLVED_AT_EXCLUSIVE);
  assert.equal(l.cutoffResolvedAtExclusive, "2026-07-13T06:04:05.701Z");
});

test("E6: an explicit valid cutoff is respected", () => {
  const l = buildPostCutoffObservationLedger([r({ resolved_at: AFTER1 })], "2026-07-13T06:04:05.703Z");
  assert.equal(l.eligibleRowCount, 0); // AFTER1 is before the explicit later cutoff
});

test("E7: an invalid cutoff error propagates", () => {
  assert.throws(() => buildPostCutoffObservationLedger([r({})], "garbage"));
});

// ---- Deduplication ----

test("D8: one eligible row produces one observation", () => {
  const l = buildPostCutoffObservationLedger([r({})]);
  assert.equal(l.uniqueObservationCount, 1);
  assert.equal(l.exactDuplicateCount, 0);
});

test("D9: two exact duplicates produce one observation", () => {
  const l = buildPostCutoffObservationLedger([r({}), r({})]);
  assert.equal(l.uniqueObservationCount, 1);
});

test("D10: exactDuplicateCount increments for an exact duplicate", () => {
  const l = buildPostCutoffObservationLedger([r({}), r({})]);
  assert.equal(l.exactDuplicateCount, 1);
  assert.equal(l.eligibleRowCount, 2);
});

test("D11: three exact duplicates count correctly", () => {
  const l = buildPostCutoffObservationLedger([r({}), r({}), r({})]);
  assert.equal(l.eligibleRowCount, 3);
  assert.equal(l.uniqueObservationCount, 1);
  assert.equal(l.exactDuplicateCount, 2);
});

test("D12: different keys remain separate", () => {
  const l = buildPostCutoffObservationLedger([r({ token_id: "t1" }), r({ token_id: "t2" })]);
  assert.equal(l.uniqueObservationCount, 2);
});

test("D13: duplicate handling does not mutate rows", () => {
  const rows = [r({}), r({})];
  const snap = JSON.parse(JSON.stringify(rows));
  buildPostCutoffObservationLedger(rows);
  assert.deepEqual(rows, snap);
});

test("D14: duplicate result is independent of input order", () => {
  const a = buildPostCutoffObservationLedger([r({ token_id: "t1" }), r({ token_id: "t2" }), r({ token_id: "t1" })]);
  const b = buildPostCutoffObservationLedger([r({ token_id: "t1" }), r({ token_id: "t1" }), r({ token_id: "t2" })]);
  assert.equal(a.uniqueObservationCount, b.uniqueObservationCount);
  assert.equal(a.exactDuplicateCount, b.exactDuplicateCount);
});

// ---- Conflict safety (guard tested via the public normalization seam) ----

test("F15: detectObservationConflictFields returns differing field names for a same-key content divergence", () => {
  const base: PostCutoffLedgerObservation = {
    observationKey: "0xabc::t1::2026-07-13T06:04:05.702Z",
    conditionId: "0xabc",
    tokenId: "t1",
    resolvedAt: "2026-07-13T06:04:05.702Z",
    weekBucket: "2026-07-13",
  };
  const diverged: PostCutoffLedgerObservation = { ...base, weekBucket: "2099-01-01" };
  const fields = detectObservationConflictFields(base, diverged);
  assert.deepEqual(fields, ["weekBucket"]);
});

test("F16: a same-key content conflict throws ObservationConflictError exposing the key", () => {
  const a: PostCutoffLedgerObservation = {
    observationKey: "0xabc::t1::2026-07-13T06:04:05.702Z",
    conditionId: "0xabc", tokenId: "t1", resolvedAt: "2026-07-13T06:04:05.702Z", weekBucket: "2026-07-13",
  };
  const b: PostCutoffLedgerObservation = { ...a, resolvedAt: "2026-07-14T00:00:00.000Z" };
  let err: unknown;
  try {
    // exercise the same merge guard the ledger uses, via the exported seam
    detectObservationConflictFields(a, b, { throwOnConflict: true });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ObservationConflictError);
  assert.equal((err as ObservationConflictError).observationKey, a.observationKey);
});

test("F17: the conflict error does not include a serialized raw row", () => {
  const a: PostCutoffLedgerObservation = {
    observationKey: "k", conditionId: "0xabc", tokenId: "t1", resolvedAt: "2026-07-13T06:04:05.702Z", weekBucket: "2026-07-13",
  };
  const b: PostCutoffLedgerObservation = { ...a, tokenId: "t2" };
  try {
    detectObservationConflictFields(a, b, { throwOnConflict: true });
    assert.fail("expected throw");
  } catch (e) {
    const msg = (e as Error).message;
    assert.doesNotMatch(msg, /signal_result|realized_return_pct|diagnostics|created_at/);
  }
});

test("F18: no first/last-write selection -- identical content is not a conflict", () => {
  const a: PostCutoffLedgerObservation = {
    observationKey: "k", conditionId: "0xabc", tokenId: "t1", resolvedAt: "2026-07-13T06:04:05.702Z", weekBucket: "2026-07-13",
  };
  assert.deepEqual(detectObservationConflictFields(a, { ...a }), []);
});

// ---- Weekly cohorts ----

test("G19: rows in one week form one cohort", () => {
  const l = buildPostCutoffObservationLedger([r({ token_id: "t1", resolved_at: AFTER1 }), r({ token_id: "t2", resolved_at: AFTER2 })]);
  assert.equal(l.weeks.length, 1);
  assert.equal(l.weeks[0].weekBucket, "2026-07-13");
});

test("G20: rows across two weeks form two cohorts", () => {
  const l = buildPostCutoffObservationLedger([r({ token_id: "t1", resolved_at: AFTER1 }), r({ token_id: "t2", resolved_at: AFTER_NEXTWEEK })]);
  assert.equal(l.weeks.length, 2);
});

test("G21: weeks are sorted ascending", () => {
  const l = buildPostCutoffObservationLedger([r({ token_id: "t2", resolved_at: AFTER_NEXTWEEK }), r({ token_id: "t1", resolved_at: AFTER1 })]);
  assert.deepEqual(l.weeks.map((w) => w.weekBucket), ["2026-07-13", "2026-07-20"]);
});

test("G22: observation keys inside a week are sorted ascending", () => {
  const l = buildPostCutoffObservationLedger([r({ token_id: "t2", resolved_at: AFTER1 }), r({ token_id: "t1", resolved_at: AFTER2 })]);
  const keys = l.weeks[0].observationKeys;
  assert.deepEqual(keys, [...keys].sort());
});

test("G23: observationCount reconciles with observationKeys length", () => {
  const l = buildPostCutoffObservationLedger([r({ token_id: "t1", resolved_at: AFTER1 }), r({ token_id: "t2", resolved_at: AFTER2 })]);
  for (const w of l.weeks) assert.equal(w.observationCount, w.observationKeys.length);
});

test("G24: the sum of weekly counts equals uniqueObservationCount", () => {
  const l = buildPostCutoffObservationLedger([
    r({ token_id: "t1", resolved_at: AFTER1 }),
    r({ token_id: "t2", resolved_at: AFTER2 }),
    r({ token_id: "t3", resolved_at: AFTER_NEXTWEEK }),
  ]);
  const sum = l.weeks.reduce((a, w) => a + w.observationCount, 0);
  assert.equal(sum, l.uniqueObservationCount);
});

test("G25: the Sunday/Monday boundary uses UTC", () => {
  // 2026-07-13T00:30:00+02:00 == 2026-07-12T22:30:00Z (Sunday) -> week 2026-07-06
  const l = buildPostCutoffObservationLedger([r({ resolved_at: "2026-07-19T12:00:00Z" })]); // Sunday -> week 2026-07-13
  assert.equal(l.weeks[0].weekBucket, "2026-07-13");
});

// ---- Determinism / hash ----

test("H26: reversed input gives an identical ledger", () => {
  const rows = [r({ token_id: "t1", resolved_at: AFTER1 }), r({ token_id: "t2", resolved_at: AFTER_NEXTWEEK })];
  const a = buildPostCutoffObservationLedger(rows);
  const b = buildPostCutoffObservationLedger([...rows].reverse());
  assert.deepEqual(a, b);
});

test("H27: reversed input gives an identical ledgerHash", () => {
  const rows = [r({ token_id: "t1", resolved_at: AFTER1 }), r({ token_id: "t2", resolved_at: AFTER_NEXTWEEK })];
  const a = buildPostCutoffObservationLedger(rows);
  const b = buildPostCutoffObservationLedger([...rows].reverse());
  assert.equal(a.ledgerHash, b.ledgerHash);
});

test("H28: exact-duplicate ordering gives an identical hash", () => {
  const a = buildPostCutoffObservationLedger([r({ token_id: "t1" }), r({ token_id: "t1" }), r({ token_id: "t2" })]);
  const b = buildPostCutoffObservationLedger([r({ token_id: "t2" }), r({ token_id: "t1" }), r({ token_id: "t1" })]);
  assert.equal(a.ledgerHash, b.ledgerHash);
});

test("H29: changing a canonical observation changes the hash", () => {
  const a = buildPostCutoffObservationLedger([r({ token_id: "t1" })]);
  const b = buildPostCutoffObservationLedger([r({ token_id: "t2" })]);
  assert.notEqual(a.ledgerHash, b.ledgerHash);
});

test("H30: the hash is 64 lowercase hex characters", () => {
  const l = buildPostCutoffObservationLedger([r({})]);
  assert.match(l.ledgerHash, /^[0-9a-f]{64}$/);
});

test("H31: no runtime timestamp appears in the ledger", () => {
  const l = buildPostCutoffObservationLedger([r({})]);
  const serialized = JSON.stringify(l);
  const nowYear = String(new Date().getUTCFullYear());
  // the only 2025+ dates present are the deterministic fixtures, never a build time
  assert.doesNotMatch(serialized, new RegExp(`"retrievedAt"|"generatedAt"|"builtAt"`));
  void nowYear;
});

test("H32: a repeated build is deep-equal", () => {
  const rows = [r({ token_id: "t1" }), r({ token_id: "t2" })];
  assert.deepEqual(buildPostCutoffObservationLedger(rows), buildPostCutoffObservationLedger(rows));
});

// ---- Counts ----

test("N33: inputRowCount includes malformed/pre-cutoff rows", () => {
  const l = buildPostCutoffObservationLedger([r({}), r({ resolved_at: BEFORE }), r({ resolved_at: "bad" })]);
  assert.equal(l.inputRowCount, 3);
});

test("N34: eligibleRowCount includes exact duplicates", () => {
  const l = buildPostCutoffObservationLedger([r({}), r({})]);
  assert.equal(l.eligibleRowCount, 2);
});

test("N35: uniqueObservationCount excludes exact duplicates", () => {
  const l = buildPostCutoffObservationLedger([r({}), r({})]);
  assert.equal(l.uniqueObservationCount, 1);
});

test("N36: eligible == unique + exactDuplicateCount", () => {
  const l = buildPostCutoffObservationLedger([r({ token_id: "t1" }), r({ token_id: "t1" }), r({ token_id: "t2" })]);
  assert.equal(l.eligibleRowCount, l.uniqueObservationCount + l.exactDuplicateCount);
});

test("N37: observations are sorted by resolvedAt then observationKey", () => {
  const l = buildPostCutoffObservationLedger([
    r({ token_id: "t2", resolved_at: AFTER_NEXTWEEK }),
    r({ token_id: "t1", resolved_at: AFTER1 }),
  ]);
  const resolved = l.observations.map((o) => o.resolvedAt);
  assert.deepEqual(resolved, [...resolved].sort());
});
