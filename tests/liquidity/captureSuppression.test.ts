import test from "node:test";
import assert from "node:assert/strict";
import {
  type RecentSnapshotLike,
  planCaptureSuppression,
  shouldSuppressLiquidityCaptureForToken,
} from "../../lib/liquidity/captureSuppression";

const NOW = Date.parse("2026-06-29T06:00:00.000Z");

function snap(
  overrides: Partial<RecentSnapshotLike> & { ago_hours: number },
): RecentSnapshotLike {
  const { ago_hours, ...rest } = overrides;
  return {
    token_id: "t1",
    captured_at: new Date(NOW - ago_hours * 3600 * 1000).toISOString(),
    snapshot_status: "failed",
    failure_reason: "http_404",
    ...rest,
  };
}

test("3 recent http_404 with no later success => suppress", () => {
  const rows = [snap({ ago_hours: 3 }), snap({ ago_hours: 2 }), snap({ ago_hours: 1 })];
  assert.equal(shouldSuppressLiquidityCaptureForToken(rows, { now: NOW }), true);
});

test("2 recent http_404 => do not suppress (below threshold)", () => {
  const rows = [snap({ ago_hours: 2 }), snap({ ago_hours: 1 })];
  assert.equal(shouldSuppressLiquidityCaptureForToken(rows, { now: NOW }), false);
});

test("3 http_404 outside the 24h window => do not suppress", () => {
  const rows = [snap({ ago_hours: 50 }), snap({ ago_hours: 40 }), snap({ ago_hours: 30 })];
  assert.equal(shouldSuppressLiquidityCaptureForToken(rows, { now: NOW }), false);
});

test("3 http_404 then a later ok snapshot => do not suppress", () => {
  const rows = [
    snap({ ago_hours: 5 }),
    snap({ ago_hours: 4 }),
    snap({ ago_hours: 3 }),
    snap({ ago_hours: 1, snapshot_status: "ok", failure_reason: null }),
  ];
  assert.equal(shouldSuppressLiquidityCaptureForToken(rows, { now: NOW }), false);
});

test("3 http_404 then a later partial snapshot => do not suppress", () => {
  const rows = [
    snap({ ago_hours: 5 }),
    snap({ ago_hours: 4 }),
    snap({ ago_hours: 3 }),
    snap({ ago_hours: 2, snapshot_status: "partial", failure_reason: "empty_book" }),
  ];
  assert.equal(shouldSuppressLiquidityCaptureForToken(rows, { now: NOW }), false);
});

test("ok BEFORE the 404 streak does not rescue the token => suppress", () => {
  const rows = [
    snap({ ago_hours: 6, snapshot_status: "ok", failure_reason: null }),
    snap({ ago_hours: 3 }),
    snap({ ago_hours: 2 }),
    snap({ ago_hours: 1 }),
  ];
  assert.equal(shouldSuppressLiquidityCaptureForToken(rows, { now: NOW }), true);
});

test("timeout / network failures do not trigger 404 suppression", () => {
  const rows = [
    snap({ ago_hours: 3, failure_reason: "timeout" }),
    snap({ ago_hours: 2, failure_reason: "fetch_failed" }),
    snap({ ago_hours: 1, failure_reason: "timeout" }),
  ];
  assert.equal(shouldSuppressLiquidityCaptureForToken(rows, { now: NOW }), false);
});

test("empty token history => do not suppress", () => {
  assert.equal(shouldSuppressLiquidityCaptureForToken([], { now: NOW }), false);
});

test("threshold and window are configurable", () => {
  const rows = [snap({ ago_hours: 2 }), snap({ ago_hours: 1 })];
  // Lower threshold to 2 => now suppresses.
  assert.equal(
    shouldSuppressLiquidityCaptureForToken(rows, { now: NOW, thresholdCount: 2 }),
    true,
  );
  // Shrink window to 90min => the 2h-old row drops out, only 1 remains.
  assert.equal(
    shouldSuppressLiquidityCaptureForToken(rows, {
      now: NOW,
      thresholdCount: 2,
      windowMs: 90 * 60 * 1000,
    }),
    false,
  );
});

test("planCaptureSuppression returns suppressed token set + counts", () => {
  const rowsByToken = new Map<string, RecentSnapshotLike[]>([
    [
      "bad",
      [
        snap({ token_id: "bad", ago_hours: 3 }),
        snap({ token_id: "bad", ago_hours: 2 }),
        snap({ token_id: "bad", ago_hours: 1 }),
      ],
    ],
    [
      "good",
      [
        snap({ token_id: "good", ago_hours: 3 }),
        snap({ token_id: "good", ago_hours: 1, snapshot_status: "ok", failure_reason: null }),
      ],
    ],
    ["fresh", [snap({ token_id: "fresh", ago_hours: 1 })]],
  ]);

  const plan = planCaptureSuppression(["bad", "good", "fresh", "never_seen"], rowsByToken, {
    now: NOW,
  });
  assert.equal(plan.suppressedTokens.has("bad"), true);
  assert.equal(plan.suppressedTokens.has("good"), false);
  assert.equal(plan.suppressedTokens.has("fresh"), false);
  assert.equal(plan.suppressedTokens.has("never_seen"), false);
  assert.equal(plan.repeatedHttp404, 1);
  assert.equal(plan.tokensSkipped, 1);
  assert.deepEqual(plan.keptTokens, ["good", "fresh", "never_seen"]);
});
