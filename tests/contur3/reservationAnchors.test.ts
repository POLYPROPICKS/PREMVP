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

test("configured anchors normalize, coexist, and partition horizons (legacy 10:00 remapped to effective 11:00)", () => {
  // MORNING_11H_CODE_WORKAROUND_V1: the legacy "10:00" config value is
  // remapped to its effective 11:00 anchor. "17:00" is untouched.
  const times = parseReservationTimesMinsk("17:00,10:00");
  assert.deepEqual(times.map((x) => x.hhmm), ["1100", "1700"]);
  const eleven = resolveReservationAnchor(at("2026-09-03T08:00:00.000Z"), times);
  const seventeen = resolveReservationAnchor(at("2026-09-03T14:00:00.000Z"), times);
  assert.equal(buildPlanRunId(eleven.anchorMs, eleven), "night-plan:2026-09-03:1100-minsk");
  assert.equal(buildPlanRunId(seventeen.anchorMs, seventeen), "night-plan:2026-09-03:1700-minsk");
  assert.notEqual(buildPlanRunId(eleven.anchorMs, eleven), buildPlanRunId(seventeen.anchorMs, seventeen));
  assert.equal(resolveNightWindow(eleven.anchorMs, eleven).horizonEndIso, "2026-09-03T14:00:00.000Z");
  assert.equal(resolveNightWindow(seventeen.anchorMs, seventeen).horizonEndIso, "2026-09-04T08:00:00.000Z");
});

test("midnight rollover and bounded missed-minute admission are deterministic", () => {
  const times = parseReservationTimesMinsk("00:05,17:00");
  const anchor = resolveReservationAnchor(at("2026-09-03T21:05:00.000Z"), times); // 00:05 Minsk Sep 4
  assert.equal(buildPlanRunId(anchor.anchorMs, anchor), "night-plan:2026-09-04:0005-minsk");
  // Legacy "10:00" config -> effective 11:00 Minsk (08:00 UTC) due-window check.
  assert.equal(resolveDueReservationAnchor(at("2026-09-03T08:04:59.000Z"), parseReservationTimesMinsk("10:00,17:00"))?.hhmm, "1100");
  assert.equal(resolveDueReservationAnchor(at("2026-09-03T08:05:01.000Z"), parseReservationTimesMinsk("10:00,17:00")), null);
});

test("MORNING_11H_CODE_WORKAROUND_V1: legacy 10:00 config produces effective 11:00, no duplicate, 17:00 untouched, and a distinct plan_run_id from any prior 10:00-labeled run", () => {
  const times = parseReservationTimesMinsk("10:00,17:00");
  assert.deepEqual(times.map((x) => `${x.hour}:${String(x.minute).padStart(2, "0")}`), ["11:00", "17:00"]);
  assert.equal(times.length, 2, "no duplicate anchor: exactly two effective anchors, not three");
  assert.ok(!times.some((t) => t.hhmm === "1000"), "the legacy 10:00 anchor is fully disabled, not left active alongside 11:00");

  // A run already completed today under the OLD literal "1000-minsk" plan_run_id
  // (from before this workaround existed) does not collide with or block a
  // distinct 11:00 run: they are different plan_run_id values entirely.
  const priorLegacyPlanRunId = "night-plan:2026-09-12:1000-minsk";
  const eleven = resolveReservationAnchor(at("2026-09-12T08:00:00.000Z"), times);
  const newPlanRunId = buildPlanRunId(eleven.anchorMs, eleven);
  assert.equal(newPlanRunId, "night-plan:2026-09-12:1100-minsk");
  assert.notEqual(newPlanRunId, priorLegacyPlanRunId, "today's already-completed legacy 10:00 run cannot block or collapse into the distinct 11:00 run");
});

test("MORNING_11H_CODE_WORKAROUND_V1: unrelated anchor configurations are unaffected unless the exact legacy 10:00 case is present", () => {
  // A config that never contained 10:00 at all is untouched.
  assert.deepEqual(parseReservationTimesMinsk("09:30,17:00").map((t) => t.hhmm), ["0930", "1700"]);
  // A config that already has both 10:00 and 11:00 dedupes onto one 11:00 slot
  // rather than producing a spurious duplicate-anchor state.
  assert.deepEqual(parseReservationTimesMinsk("10:00,11:00,17:00").map((t) => t.hhmm), ["1100", "1700"]);
});

test("MORNING_11H_CODE_WORKAROUND_V1: lead-time / T-minus constants are untouched by the anchor compatibility shim", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../../lib/executor/nightWindow");
  assert.equal(mod.REBALANCE_MINUTES_BEFORE_START, 70, "not modified by this shim (imported from reservationRebalanceContract.mjs, untouched)");
  assert.equal(mod.PREFERRED_ENTRY_MINUTES_BEFORE, 45);
  assert.equal(mod.MAX_RESERVATION_HORIZON_HOURS, 24);
});

test("invalid or duplicate configured anchors fail closed", () => {
  assert.throws(() => parseReservationTimesMinsk("10:00,10:00"), /RESERVATION_TIMES_MINSK_INVALID/);
  assert.throws(() => parseReservationTimesMinsk("25:00"), /RESERVATION_TIMES_MINSK_INVALID/);
  assert.throws(() => parseReservationTimesMinsk(""), /RESERVATION_TIMES_MINSK_INVALID/);
});
