// TELEMETRY_05_T20_HOURLY_DBCLONE_PARITY_V1: the hourly `--telemetry-only` run
// transports the existing T20 SPEC (append-only keyset) and reports parity honestly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HOURLY_EXECUTION_TABLES,
  HOURLY_T20_TABLE,
  SPECS,
  hourlyT20Spec,
  runHourlyT20Transport,
} from "../../scripts/research-clone-daily-sync";
import { runAppendSync, TELEMETRY_PURGE_ORDER, type Watermark } from "../../lib/research-clone/dailySync";

const evidence = (over: Record<string, unknown> = {}) => ({
  SOURCE_MAX_WATERMARK: null, TARGET_BEFORE: null, TARGET_AFTER: null, NEW_ROWS: 0, UPDATED_ROWS: 0,
  DUPLICATE_N: 0, APPEND_PENDING: false, RECONCILIATION_PENDING: false, ...over,
}) as never;

type Row = { id: string; observed_at: string };
const mkRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(4, "0")}`, observed_at: `2026-10-11T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` }));

function harness(source: Row[], pageSize: number, maxPages: number) {
  const spec = hourlyT20Spec();
  const target = new Map<string, Row>();
  let checkpoint: Watermark | null = null;
  const key = (r: Row) => `${r.observed_at}|${r.id}`;
  const sync = () => runAppendSync(spec.fields, maxPages, {
    async sourceMaxWatermark() { const r = source[source.length - 1]; return r ? { observed_at: r.observed_at, id: r.id } : null; },
    async targetMaxWatermark() { const r = [...target.values()].sort((a, b) => key(a).localeCompare(key(b))).pop(); return r ? { observed_at: r.observed_at, id: r.id } : null; },
    async readCheckpoint() { return checkpoint; },
    async fetchSourcePage(after) {
      const rows = source.filter((r) => !after || key(r) > `${after.observed_at}|${after.id}`);
      return rows.slice(0, pageSize);
    },
    async upsertTargetRows(rows) {
      let newRows = 0; let duplicateN = 0;
      for (const r of rows) { if (target.has(r.id)) duplicateN += 1; else newRows += 1; target.set(r.id, r); }
      return { newRows, updatedRows: 0, duplicateN };
    },
    async writeCheckpoint(w) { checkpoint = w; },
  }, spec.bootstrapSince ?? null);
  return { sync, target };
}

test("T20 hourly transport reuses the existing SPEC unchanged", () => {
  const spec = hourlyT20Spec();
  assert.equal(spec, SPECS.find((entry) => entry.table === HOURLY_T20_TABLE));
  assert.deepEqual(spec.fields, ["observed_at", "id"]);
  assert.equal(spec.appendOnly, true);
  assert.equal(spec.optional, true);
});

test("initial bootstrap, repeated zero-change sync and partial resume are idempotent", async () => {
  const source = mkRows(25);
  const h = harness(source, 10, 1); // 1 page / run => partial resume
  const first = await h.sync();
  assert.equal(first.newRows, 10);
  assert.equal(first.pending, true);
  const second = await h.sync();
  assert.equal(second.newRows, 10);
  assert.equal(second.pending, true);
  const third = await h.sync();
  assert.equal(third.newRows, 5);
  assert.equal(third.pending, false);
  assert.equal(h.target.size, 25);
  const zero = await h.sync();
  assert.equal(zero.newRows, 0);
  assert.equal(zero.duplicateN, 0);
  assert.equal(zero.pending, false);
  assert.equal(h.target.size, 25);
});

test("transport status: synced, pending and schema-pending are reported honestly", async () => {
  const synced = await runHourlyT20Transport(async () => evidence({ NEW_ROWS: 3 }));
  assert.equal(synced.STATUS, "SYNCED");
  assert.equal(synced.PARITY_COMPLETE, true);

  const pending = await runHourlyT20Transport(async () => evidence({ APPEND_PENDING: true }));
  assert.equal(pending.STATUS, "APPEND_PENDING");
  assert.equal(pending.PARITY_COMPLETE, false);

  const reconcile = await runHourlyT20Transport(async () => evidence({ RECONCILIATION_PENDING: true }));
  assert.equal(reconcile.PARITY_COMPLETE, false);

  const missing = await runHourlyT20Transport(async () => { throw new Error("RESEARCH_CLONE_SOURCE_READ_x:PGRST205"); });
  assert.equal(missing.STATUS, "SCHEMA_PENDING");
  assert.equal(missing.PARITY_COMPLETE, false);

  await assert.rejects(runHourlyT20Transport(async () => { throw new Error("RESEARCH_CLONE_SOURCE_READ_x:57014"); }), /57014/);
});

test("telemetry-only branch runs T20 transport last, then purges it only clone-confirmed, keeps existing paths", () => {
  const source = readFileSync(new URL("../../scripts/research-clone-daily-sync.ts", import.meta.url), "utf8");
  const branch = source.slice(source.indexOf('process.argv.includes("--telemetry-only")'), source.indexOf("const outboxProbe"));
  const exec = branch.indexOf("hourlyExecutionSpecs()");
  const t20 = branch.indexOf("runHourlyT20Transport(");
  const success = branch.indexOf('MODE: "TELEMETRY_ONLY"');
  const t20Purge = branch.indexOf("purgeTelemetry(target, source, Date.now(), false, false, true)");
  assert.ok(exec >= 0 && exec < t20 && t20 < t20Purge && t20Purge < success);
  assert.ok(branch.includes('t20Transport.STATUS === "SCHEMA_PENDING" ? null'));
  const line = branch.slice(success, branch.indexOf("\n", success));
  assert.ok(line.includes("T20_TRANSPORT: t20Transport") && line.includes("EXECUTION_TABLES: executionTables"));
  assert.ok(branch.includes('t20Transport.STATUS === "APPEND_PENDING"'));
  assert.equal((TELEMETRY_PURGE_ORDER as readonly string[]).includes(HOURLY_T20_TABLE), false);
  assert.deepEqual([...HOURLY_EXECUTION_TABLES], ["event_execution_queue", "executor_order_events", "bet_execution_ledger"]);
  assert.equal((source.match(/\.delete\(\)/g) ?? []).length, 1);
});
