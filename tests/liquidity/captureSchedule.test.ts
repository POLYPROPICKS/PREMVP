import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLiquidityCapturePlan,
  formatInTimezone,
  getLiquidityCaptureCadence,
  isLiquidityCaptureDue,
  resolveEventEndMs,
  SOCCER_DEFAULT_DURATION_MIN,
} from "../../lib/liquidity/captureSchedule";

// RSA vs CAN, FIFWC, 28 June 2026 22:00 Minsk == 19:00 UTC.
const START = "2026-06-28T19:00:00.000Z";

test("before T-12h: not in window, no cadence, not due", () => {
  const now = "2026-06-28T06:30:00.000Z"; // 12.5h before
  const c = getLiquidityCaptureCadence(now, START, { sport: "soccer" });
  assert.equal(c.phase, "not_started_window");
  assert.equal(c.cadenceMinutes, null);
  assert.equal(c.inWindow, false);
  assert.equal(isLiquidityCaptureDue(null, now, START, { sport: "soccer" }), false);
});

test("T-12h boundary opens the 120-minute pre-window", () => {
  const now = "2026-06-28T07:00:00.000Z"; // exactly T-12h == 10:00 Minsk
  const c = getLiquidityCaptureCadence(now, START, { sport: "soccer" });
  assert.equal(c.phase, "pre12_to_pre2");
  assert.equal(c.cadenceMinutes, 120);
  assert.equal(c.inWindow, true);
});

test("T-2h boundary switches to the 10-minute final window", () => {
  const justBefore = "2026-06-28T16:59:00.000Z";
  assert.equal(getLiquidityCaptureCadence(justBefore, START).phase, "pre12_to_pre2");
  const atT2 = "2026-06-28T17:00:00.000Z"; // T-2h == 20:00 Minsk
  const c = getLiquidityCaptureCadence(atT2, START);
  assert.equal(c.phase, "final2h");
  assert.equal(c.cadenceMinutes, 10);
});

test("in-play window uses 10-minute cadence until end", () => {
  const duringStart = "2026-06-28T19:00:00.000Z"; // kickoff
  const mid = "2026-06-28T20:00:00.000Z";
  assert.equal(getLiquidityCaptureCadence(duringStart, START).phase, "in_play");
  assert.equal(getLiquidityCaptureCadence(mid, START).cadenceMinutes, 10);
});

test("event end (start + 130 min soccer default) closes capture", () => {
  const endMs = resolveEventEndMs(START, null, "soccer");
  assert.equal(endMs, Date.parse(START) + SOCCER_DEFAULT_DURATION_MIN * 60000);
  const afterEnd = "2026-06-28T21:30:00.000Z"; // 21:10Z end + 20m
  const c = getLiquidityCaptureCadence(afterEnd, START, { sport: "soccer" });
  assert.equal(c.phase, "closed");
  assert.equal(c.cadenceMinutes, null);
  assert.equal(isLiquidityCaptureDue(null, afterEnd, START, { sport: "soccer" }), false);
});

test("explicit end time overrides the soccer default", () => {
  const explicitEnd = "2026-06-28T22:00:00.000Z";
  const stillIn = "2026-06-28T21:30:00.000Z"; // past default end, before explicit end
  const c = getLiquidityCaptureCadence(stillIn, START, { eventEnd: explicitEnd });
  assert.equal(c.phase, "in_play");
});

test("last capture prevents a duplicate run until cadence elapses", () => {
  // pre-window cadence 120 min.
  const now = "2026-06-28T10:00:00.000Z"; // T-9h, pre12 phase
  const recent = "2026-06-28T09:30:00.000Z"; // 30 min ago < 120
  assert.equal(isLiquidityCaptureDue(recent, now, START, { sport: "soccer" }), false);
  const old = "2026-06-28T07:30:00.000Z"; // 150 min ago >= 120
  assert.equal(isLiquidityCaptureDue(old, now, START, { sport: "soccer" }), true);
  // final window cadence 10 min.
  const finalNow = "2026-06-28T18:00:00.000Z";
  assert.equal(isLiquidityCaptureDue("2026-06-28T17:55:00.000Z", finalNow, START), false); // 5<10
  assert.equal(isLiquidityCaptureDue("2026-06-28T17:48:00.000Z", finalNow, START), true); // 12>=10
});

test("no last capture in an active window is immediately due", () => {
  const now = "2026-06-28T12:00:00.000Z";
  assert.equal(isLiquidityCaptureDue(null, now, START, { sport: "soccer" }), true);
});

test("Minsk display is +3h and does not affect UTC scheduling", () => {
  assert.equal(formatInTimezone(Date.parse(START)), "2026-06-28 22:00"); // 19:00Z -> 22:00 Minsk
  assert.equal(formatInTimezone(Date.parse("2026-06-28T07:00:00.000Z")), "2026-06-28 10:00");
  assert.equal(formatInTimezone(Date.parse("2026-06-28T17:00:00.000Z")), "2026-06-28 20:00");
  // Scheduling is identical regardless of display tz: cadence is computed in UTC.
  const c = getLiquidityCaptureCadence("2026-06-28T17:00:00.000Z", START);
  assert.equal(c.phase, "final2h");
});

test("RSA-CAN plan: windows at the expected UTC/Minsk times", () => {
  // At T-12h the event is in window (pre12) and due (no prior capture).
  const plan = buildLiquidityCapturePlan(
    [
      {
        key: "fifwc-rsa-can-2026-06-28",
        eventSlug: "fifwc-rsa-can-2026-06-28",
        eventTitle: "South Africa vs Canada",
        gameStartIso: START,
        sport: "soccer",
        tokenCount: 6,
        lastCaptureAt: null,
      },
    ],
    "2026-06-28T07:00:00.000Z",
    { days: 7 },
  );
  assert.equal(plan.totalEvents, 1);
  assert.equal(plan.dueEvents, 1);
  const e = plan.entries[0];
  assert.equal(e.phase, "pre12_to_pre2");
  assert.equal(e.cadenceMinutes, 120);
  assert.equal(e.eventStartUtc, START);
  assert.equal(e.eventStartMinsk, "2026-06-28 22:00");
  assert.equal(e.due, true);
});

test("buildLiquidityCapturePlan excludes events beyond the horizon", () => {
  const farStart = "2026-07-20T19:00:00.000Z"; // > 7 days out
  const plan = buildLiquidityCapturePlan(
    [{ key: "far", gameStartIso: farStart, sport: "soccer" }],
    "2026-06-28T07:00:00.000Z",
    { days: 7 },
  );
  assert.equal(plan.totalEvents, 0);
});
