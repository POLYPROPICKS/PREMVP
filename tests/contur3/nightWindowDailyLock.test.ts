// LOCK_AND_RELEASE_TWO_DAILY_RESERVATION_WINDOWS_V1
//
// Regression-proves the production two-anchor Reservation schedule
// (RESERVATION_TIMES_MINSK=10:00,17:00) partitions ownership exactly as:
//   10:00 Minsk -> [10:00, 17:00)
//   17:00 Minsk -> [17:00, 10:00 next day)
// with no event belonging to both cycles and no Reservation ever extending
// past the next configured anchor. lib/executor/nightWindow.ts already
// implements this correctly ([configured anchor, next configured anchor),
// bounded by MAX_RESERVATION_HORIZON_HOURS) -- this file only adds coverage,
// it does not change runtime behavior.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_RESERVATION_HORIZON_HOURS,
  buildPlanRunId,
  isWithinHorizon,
  parseReservationTimesMinsk,
  resolveNightWindow,
  resolveReservationAnchor,
  type NightWindow,
} from "../../lib/executor/nightWindow";

const at = (iso: string) => Date.parse(iso);
const TIMES = parseReservationTimesMinsk("10:00,17:00");

// 2026-09-03 10:00 Minsk == 07:00 UTC (UTC+3); 17:00 Minsk == 14:00 UTC.
const tenAnchorNow = at("2026-09-03T07:00:00.000Z");
const seventeenAnchorNow = at("2026-09-03T14:00:00.000Z");

test("1: the 10:00 Minsk anchor starts at 10:00 same day and ends at 17:00 same day", () => {
  const anchor = resolveReservationAnchor(tenAnchorNow, TIMES);
  const win = resolveNightWindow(tenAnchorNow, anchor);
  assert.equal(anchor.hhmm, "1000");
  assert.equal(win.startIso, "2026-09-03T07:00:00.000Z", "10:00 Minsk == 07:00 UTC");
  assert.equal(win.endIso, "2026-09-03T14:00:00.000Z", "17:00 Minsk == 14:00 UTC");
  assert.equal(win.horizonEndIso, win.endIso);
});

test("2: the 17:00 Minsk anchor starts at 17:00 same day and ends at 10:00 next day", () => {
  const anchor = resolveReservationAnchor(seventeenAnchorNow, TIMES);
  const win = resolveNightWindow(seventeenAnchorNow, anchor);
  assert.equal(anchor.hhmm, "1700");
  assert.equal(win.startIso, "2026-09-03T14:00:00.000Z", "17:00 Minsk == 14:00 UTC");
  assert.equal(win.endIso, "2026-09-04T07:00:00.000Z", "10:00 Minsk next day == 07:00 UTC next day");
  assert.equal(win.horizonEndIso, win.endIso);
});

test("3: the 10:00 plan window is right-exclusive at 17:00 Minsk -- 16:59:59.999 included, 17:00:00.000 excluded", () => {
  const anchor = resolveReservationAnchor(tenAnchorNow, TIMES);
  const win: NightWindow = resolveNightWindow(tenAnchorNow, anchor);
  const included = at("2026-09-03T13:59:59.999Z"); // 16:59:59.999 Minsk
  const excluded = at("2026-09-03T14:00:00.000Z"); // 17:00:00.000 Minsk
  assert.equal(isWithinHorizon(included, win, tenAnchorNow), true);
  assert.equal(isWithinHorizon(excluded, win, tenAnchorNow), false);
});

test("4: the 17:00 plan window is right-exclusive at 10:00 Minsk next day -- 09:59:59.999 included, 10:00:00.000 excluded", () => {
  const anchor = resolveReservationAnchor(seventeenAnchorNow, TIMES);
  const win: NightWindow = resolveNightWindow(seventeenAnchorNow, anchor);
  const included = at("2026-09-04T06:59:59.999Z"); // 09:59:59.999 Minsk next day
  const excluded = at("2026-09-04T07:00:00.000Z"); // 10:00:00.000 Minsk next day
  assert.equal(isWithinHorizon(included, win, seventeenAnchorNow), true);
  assert.equal(isWithinHorizon(excluded, win, seventeenAnchorNow), false);
});

test("5: buildPlanRunId stays distinct per anchor -- 1000-minsk vs 1700-minsk", () => {
  const tenAnchor = resolveReservationAnchor(tenAnchorNow, TIMES);
  const seventeenAnchor = resolveReservationAnchor(seventeenAnchorNow, TIMES);
  const tenId = buildPlanRunId(tenAnchorNow, tenAnchor);
  const seventeenId = buildPlanRunId(seventeenAnchorNow, seventeenAnchor);
  assert.match(tenId, /1000-minsk$/);
  assert.match(seventeenId, /1700-minsk$/);
  assert.notEqual(tenId, seventeenId);
});

test("6: MAX_RESERVATION_HORIZON_HOURS never extends a plan beyond the next configured anchor -- the next anchor wins, not anchor + horizon hours", () => {
  const tenAnchor = resolveReservationAnchor(tenAnchorNow, TIMES);
  const tenWin = resolveNightWindow(tenAnchorNow, tenAnchor);
  assert.equal(tenWin.horizonEndMs, at("2026-09-03T14:00:00.000Z"), "must be the 17:00 anchor (7h later), never 10:00 + 24h");
  assert.ok(tenWin.horizonEndMs < tenAnchor.anchorMs + MAX_RESERVATION_HORIZON_HOURS * 3_600_000);

  const seventeenAnchor = resolveReservationAnchor(seventeenAnchorNow, TIMES);
  const seventeenWin = resolveNightWindow(seventeenAnchorNow, seventeenAnchor);
  assert.equal(seventeenWin.horizonEndMs, at("2026-09-04T07:00:00.000Z"), "must be the next day's 10:00 anchor (17h later), never 17:00 + 24h");
  assert.ok(seventeenWin.horizonEndMs < seventeenAnchor.anchorMs + MAX_RESERVATION_HORIZON_HOURS * 3_600_000);

  // A single daily anchor is the boundary case: the gap to the next
  // occurrence (24h) exactly equals MAX_RESERVATION_HORIZON_HOURS. The cap
  // must land exactly on the next anchor, never past it.
  const singleAnchorTimes = parseReservationTimesMinsk("10:00");
  const singleAnchor = resolveReservationAnchor(tenAnchorNow, singleAnchorTimes);
  const singleWin = resolveNightWindow(tenAnchorNow, singleAnchor);
  assert.equal(singleWin.horizonEndMs, singleAnchor.anchorMs + 24 * 3_600_000);
  assert.equal(singleWin.horizonEndIso, "2026-09-04T07:00:00.000Z", "next day's 10:00 Minsk anchor, not a moment later");
});

test("NO_OVERLAP: the 10:00 and 17:00 windows on the same plan date partition the day with no shared instant", () => {
  const tenAnchor = resolveReservationAnchor(tenAnchorNow, TIMES);
  const tenWin = resolveNightWindow(tenAnchorNow, tenAnchor);
  const seventeenAnchor = resolveReservationAnchor(seventeenAnchorNow, TIMES);
  const seventeenWin = resolveNightWindow(seventeenAnchorNow, seventeenAnchor);

  assert.equal(tenWin.endMs, seventeenWin.startMs, "the 10:00 window's exclusive end is exactly the 17:00 window's start");

  // The instant that closes the 10:00 cycle immediately opens the 17:00
  // cycle -- it can never be claimed by both. Evaluated as of a moment
  // strictly before the boundary itself (isWithinHorizon requires the
  // candidate start to be strictly in the future of "now").
  const boundary = tenWin.endMs;
  const beforeBoundary = tenAnchorNow;
  assert.equal(isWithinHorizon(boundary, tenWin, beforeBoundary), false, "excluded from the 10:00 cycle");
  assert.equal(isWithinHorizon(boundary, seventeenWin, beforeBoundary), true, "included in the 17:00 cycle");
});
