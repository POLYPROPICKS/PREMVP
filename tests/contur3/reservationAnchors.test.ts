import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlanRunId,
  parseReservationTimesMinsk,
  resolveDueReservationAnchor,
  resolveNightWindow,
  resolveReservationAnchor,
} from "../../lib/executor/nightWindow";

const at = (iso: string) => Date.parse(iso);

test("absent configuration preserves the 17:00 Minsk anchor and deterministic retry identity", () => {
  const now = at("2026-09-03T14:00:00.000Z");
  const anchor = resolveReservationAnchor(now, parseReservationTimesMinsk(undefined));
  assert.equal(buildPlanRunId(now, anchor), "night-plan:2026-09-03:1700-minsk");
  assert.equal(buildPlanRunId(now, anchor), buildPlanRunId(now, anchor));
});

test("configured anchors normalize, coexist, and partition horizons", () => {
  const times = parseReservationTimesMinsk("17:00,10:00");
  assert.deepEqual(times.map((x) => x.hhmm), ["1000", "1700"]);
  const ten = resolveReservationAnchor(at("2026-09-03T07:00:00.000Z"), times);
  const seventeen = resolveReservationAnchor(at("2026-09-03T14:00:00.000Z"), times);
  assert.equal(buildPlanRunId(ten.anchorMs, ten), "night-plan:2026-09-03:1000-minsk");
  assert.equal(buildPlanRunId(seventeen.anchorMs, seventeen), "night-plan:2026-09-03:1700-minsk");
  assert.notEqual(buildPlanRunId(ten.anchorMs, ten), buildPlanRunId(seventeen.anchorMs, seventeen));
  assert.equal(resolveNightWindow(ten.anchorMs, ten).horizonEndIso, "2026-09-03T14:00:00.000Z");
  assert.equal(resolveNightWindow(seventeen.anchorMs, seventeen).horizonEndIso, "2026-09-04T07:00:00.000Z");
});

test("midnight rollover and bounded missed-minute admission are deterministic", () => {
  const times = parseReservationTimesMinsk("00:05,17:00");
  const anchor = resolveReservationAnchor(at("2026-09-03T21:05:00.000Z"), times); // 00:05 Minsk Sep 4
  assert.equal(buildPlanRunId(anchor.anchorMs, anchor), "night-plan:2026-09-04:0005-minsk");
  assert.equal(resolveDueReservationAnchor(at("2026-09-03T07:04:59.000Z"), parseReservationTimesMinsk("10:00,17:00"))?.hhmm, "1000");
  assert.equal(resolveDueReservationAnchor(at("2026-09-03T07:05:01.000Z"), parseReservationTimesMinsk("10:00,17:00")), null);
});

test("invalid or duplicate configured anchors fail closed", () => {
  assert.throws(() => parseReservationTimesMinsk("10:00,10:00"), /RESERVATION_TIMES_MINSK_INVALID/);
  assert.throws(() => parseReservationTimesMinsk("25:00"), /RESERVATION_TIMES_MINSK_INVALID/);
  assert.throws(() => parseReservationTimesMinsk(""), /RESERVATION_TIMES_MINSK_INVALID/);
});
