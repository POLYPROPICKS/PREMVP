import test from "node:test";
import assert from "node:assert/strict";
import { classifyPhaseBucket, computeMinutesToStart } from "../../lib/liquidity/timeBuckets";

test("computeMinutesToStart returns positive minutes for future start", () => {
  const captured = "2026-06-26T12:00:00.000Z";
  const start = "2026-06-26T13:00:00.000Z";
  assert.equal(computeMinutesToStart(captured, start), 60);
});

test("computeMinutesToStart returns negative minutes for live/post", () => {
  const captured = "2026-06-26T13:30:00.000Z";
  const start = "2026-06-26T13:00:00.000Z";
  assert.equal(computeMinutesToStart(captured, start), -30);
});

test("computeMinutesToStart returns null for unparseable input", () => {
  assert.equal(computeMinutesToStart(null, "2026-06-26T13:00:00Z"), null);
  assert.equal(computeMinutesToStart("nonsense", "2026-06-26T13:00:00Z"), null);
  assert.equal(computeMinutesToStart("2026-06-26T13:00:00Z", undefined), null);
});

test("classifyPhaseBucket boundaries (pre-game)", () => {
  assert.equal(classifyPhaseBucket(800), "T_12H_PLUS");
  assert.equal(classifyPhaseBucket(720), "T_12H"); // 720 is not > 720
  assert.equal(classifyPhaseBucket(500), "T_12H");
  assert.equal(classifyPhaseBucket(200), "T_6H");
  assert.equal(classifyPhaseBucket(121), "T_3H");
  assert.equal(classifyPhaseBucket(90), "T_2H");
  assert.equal(classifyPhaseBucket(45), "T_1H");
  assert.equal(classifyPhaseBucket(20), "T_30M");
  assert.equal(classifyPhaseBucket(12), "T_15M");
  assert.equal(classifyPhaseBucket(7), "T_10M");
  assert.equal(classifyPhaseBucket(3), "T_5M");
});

test("classifyPhaseBucket boundaries (live/post)", () => {
  assert.equal(classifyPhaseBucket(0), "LIVE_0_5M");
  assert.equal(classifyPhaseBucket(-3), "LIVE_0_5M");
  assert.equal(classifyPhaseBucket(-10), "LIVE_5_15M");
  assert.equal(classifyPhaseBucket(-60), "LIVE_15M_PLUS");
  assert.equal(classifyPhaseBucket(-300), "POST_OR_STALE");
});

test("classifyPhaseBucket handles unknown start", () => {
  assert.equal(classifyPhaseBucket(null), "UNKNOWN_START");
  assert.equal(classifyPhaseBucket(Number.NaN), "UNKNOWN_START");
});
