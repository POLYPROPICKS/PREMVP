import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKeysetFilter,
  compareWatermarks,
  resolveInitialWatermark,
  runAppendSync,
  toMinskDailyRailwayCron,
  type Watermark,
} from "../../lib/research-clone/dailySync";

const older: Watermark = { created_at: "2026-09-01T00:00:00.000Z", id: "00000000-0000-0000-0000-000000000001" };
const newer: Watermark = { created_at: "2026-09-01T00:00:00.000Z", id: "00000000-0000-0000-0000-000000000002" };

test("uses tuple ordering for generated_signal_pairs checkpoints", () => {
  assert.equal(compareWatermarks(older, newer, ["created_at", "id"]), -1);
  assert.equal(compareWatermarks(newer, older, ["created_at", "id"]), 1);
  assert.equal(compareWatermarks(newer, newer, ["created_at", "id"]), 0);
});

test("builds a keyset-only continuation filter", () => {
  assert.equal(
    buildKeysetFilter(older, ["created_at", "id"]),
    "created_at.gt.2026-09-01T00:00:00.000Z,and(created_at.eq.2026-09-01T00:00:00.000Z,id.gt.00000000-0000-0000-0000-000000000001)",
  );
});

test("starts from the furthest durable clone checkpoint without resetting it", () => {
  assert.deepEqual(resolveInitialWatermark(older, newer, ["created_at", "id"]), newer);
  assert.deepEqual(resolveInitialWatermark(newer, older, ["created_at", "id"]), newer);
  assert.deepEqual(resolveInitialWatermark(null, older, ["created_at", "id"]), older);
});

test("maps 05:00 Europe/Minsk to Railway's UTC cron", () => {
  assert.equal(toMinskDailyRailwayCron(), "0 2 * * *");
});

test("bounded initial catch-up persists a checkpoint and an immediate rerun is idempotent", async () => {
  const rows = [
    { ...older, id: "00000000-0000-0000-0000-000000000003" },
    { ...newer, id: "00000000-0000-0000-0000-000000000004" },
  ];
  const latest = { ...newer, id: "00000000-0000-0000-0000-000000000004" };
  let target = [older];
  let checkpoint: Watermark | null = null;
  const port = {
    async sourceMaxWatermark() { return latest; },
    async targetMaxWatermark() { return target[target.length - 1] ?? null; },
    async readCheckpoint() { return checkpoint; },
    async fetchSourcePage(after: Watermark | null) {
      return rows.filter((row) => !after || compareWatermarks(row, after, ["created_at", "id"]) > 0).slice(0, 1);
    },
    async upsertTargetRows(page: typeof rows) {
      const newRows = page.filter((row) => !target.some((existing) => existing.id === row.id));
      target = [...target, ...newRows].sort((a, b) => compareWatermarks(a, b, ["created_at", "id"]));
      return { newRows: newRows.length, updatedRows: 0, duplicateN: 0 };
    },
    async writeCheckpoint(next: Watermark) { checkpoint = next; },
  };

  const first = await runAppendSync(["created_at", "id"], 10, port);
  assert.equal(first.newRows, 2);
  assert.equal(first.duplicateN, 0);
  assert.deepEqual(checkpoint, latest);

  const second = await runAppendSync(["created_at", "id"], 10, port);
  assert.equal(second.newRows, 0);
  assert.equal(second.updatedRows, 0);
  assert.equal(second.duplicateN, 0);
});
