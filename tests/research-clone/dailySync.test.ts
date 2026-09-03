import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKeysetFilter,
  compareWatermarks,
  resolveInitialWatermark,
  runAppendSync,
  runReconcileSweep,
  toMinskDailyRailwayCron,
  type SyncRow,
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
  assert.equal(second.pending, false);
});

const FIELDS = ["created_at", "id"] as const;
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

/** Ordered (created_at, id) rows; each is also a valid Watermark for these fields. */
function seq(count: number): SyncRow[] {
  return Array.from({ length: count }, (_, index) => ({
    created_at: `2026-09-${String(2 + Math.floor(index / 5)).padStart(2, "0")}T00:00:0${index % 5}.000Z`,
    id: `10000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
  }));
}

const gt = (a: SyncRow, b: Watermark | null) => compareWatermarks(a as Watermark, b, FIELDS) > 0;

test("append page-budget exhaustion is a resumable pending flag, not a throw", async () => {
  const all = seq(30);
  const latest = all[all.length - 1] as Watermark;
  let checkpoint: Watermark | null = null;
  const port = {
    async sourceMaxWatermark() { return latest; },
    async targetMaxWatermark() { return checkpoint; },
    async readCheckpoint() { return checkpoint; },
    async fetchSourcePage(after: Watermark | null) {
      return all.filter((row) => !after || gt(row, after)).slice(0, 5);
    },
    async upsertTargetRows(rows: SyncRow[]) { return { newRows: rows.length, updatedRows: 0, duplicateN: 0 }; },
    async writeCheckpoint(next: Watermark) { checkpoint = next; },
  };

  const first = await runAppendSync(FIELDS, 2, port);
  assert.equal(first.pending, true);
  assert.equal(first.pages, 2);
  assert.deepEqual(checkpoint, all[9]); // 2 pages * 5 rows, checkpoint persisted

  // A later run resumes from the durable checkpoint and finishes.
  let guard = 0;
  let result = first;
  while (result.pending && guard < 20) { result = await runAppendSync(FIELDS, 2, port); guard += 1; }
  assert.equal(result.pending, false);
  assert.deepEqual(checkpoint, latest);
});

test("reconcile sweep resumes from a durable cursor and never rescans from a stale window", async () => {
  const window: Watermark = { created_at: "2026-09-02T00:00:00.000Z", id: ZERO_ID };
  const rows = seq(30);
  const fetched: string[] = [];
  let cursor: Watermark | null = null;
  const makePort = () => ({
    async readCursor() { return cursor; },
    async fetchSourcePage(after: Watermark) {
      fetched.push(after.id);
      return rows.filter((row) => gt(row, after)).slice(0, 5);
    },
    async applyRows(page: SyncRow[]) { return { updatedRows: page.length }; },
    async writeCursor(next: Watermark) { cursor = next; },
  });

  // Fresh sweep: starts at the window start, spends its 2-page budget, stays pending,
  // and leaves a durable cursor.
  const first = await runReconcileSweep(FIELDS, window, 5, 2, makePort());
  assert.equal(first.pending, true);
  assert.equal(fetched[0], ZERO_ID);
  assert.deepEqual(cursor, rows[9]);

  // Next run: resumes from the cursor (not the window start) and completes.
  fetched.length = 0;
  const second = await runReconcileSweep(FIELDS, window, 5, 10, makePort());
  assert.equal(second.pending, false);
  assert.equal(fetched[0], rows[9].id);

  // A cursor left behind by a now-rolled-past window is ignored (monotonic forward).
  cursor = { created_at: "2026-08-01T00:00:00.000Z", id: ZERO_ID };
  fetched.length = 0;
  await runReconcileSweep(FIELDS, window, 5, 1, makePort());
  assert.equal(fetched[0], ZERO_ID);
});

test("reconcile sweep ends cleanly (not pending) when the recent window is fully drained", async () => {
  const window: Watermark = { created_at: "2026-09-02T00:00:00.000Z", id: ZERO_ID };
  const rows = seq(3);
  const port = {
    async readCursor() { return null; },
    async fetchSourcePage(after: Watermark) {
      return rows.filter((row) => gt(row, after)).slice(0, 5);
    },
    async applyRows(page: SyncRow[]) { return { updatedRows: page.length }; },
    async writeCursor() {},
  };
  const sweep = await runReconcileSweep(FIELDS, window, 5, 4, port);
  assert.equal(sweep.pending, false);
  assert.equal(sweep.updatedRows, 3);
});
