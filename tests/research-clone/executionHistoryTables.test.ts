// Coverage for extending the existing research-clone daily sync
// (scripts/research-clone-daily-sync.ts) with live execution-history tables:
// event_execution_queue, executor_order_events, bet_execution_ledger.
// Proves the new SPECS entries carry the mission-specified watermark/reconcile
// shape and reuse the existing runAppendSync/checkpoint/reconcile machinery —
// no second sync engine, no new table dependency.

import { test } from "node:test";
import assert from "node:assert/strict";

import { SPECS, type TableSpec } from "../../scripts/research-clone-daily-sync";

function specFor(table: string): TableSpec {
  const spec = SPECS.find((s) => s.table === table);
  assert.ok(spec, `expected a SPECS entry for ${table}`);
  return spec as TableSpec;
}

test("event_execution_queue: queued_at,id watermark, mutable with a reconcile window", () => {
  const spec = specFor("event_execution_queue");
  assert.deepEqual(spec.fields, ["queued_at", "id"]);
  assert.equal(spec.appendOnly, false);
  assert.equal(typeof spec.reconciliationStart, "function");
});

test("executor_order_events: created_at,id watermark, append-only with no reconcile window", () => {
  const spec = specFor("executor_order_events");
  assert.deepEqual(spec.fields, ["created_at", "id"]);
  assert.equal(spec.appendOnly, true);
  assert.equal(spec.reconciliationStart, undefined);
});

test("bet_execution_ledger: created_at,id watermark, mutable, reconciles the last 30 days", () => {
  const spec = specFor("bet_execution_ledger");
  assert.deepEqual(spec.fields, ["created_at", "id"]);
  assert.equal(spec.appendOnly, false);
  assert.ok(spec.reconciliationStart);

  const now = new Date("2026-09-22T00:00:00.000Z");
  // A sync that has fallen far behind (targetBefore older than the 30-day
  // window) must not skip the gap: the window starts from targetBefore, not
  // a tighter recent cutoff that would leave older rows unreconciled.
  const targetBeforeOld = { created_at: "2026-01-01T00:00:00.000Z", id: "x" };
  assert.equal(spec.reconciliationStart!(targetBeforeOld, now), "2026-01-01T00:00:00.000Z");

  // A sync that is caught up (targetBefore newer than the 30-day window) is
  // capped at now - 30 days, per the mission's "at least recent 30 days" bound.
  const targetBeforeRecent = { created_at: "2026-09-20T00:00:00.000Z", id: "x" };
  assert.equal(spec.reconciliationStart!(targetBeforeRecent, now), "2026-08-23T00:00:00.000Z");
});

test("none of the three new tables are declared optional (all proven to exist in the clone already)", () => {
  for (const table of ["event_execution_queue", "executor_order_events", "bet_execution_ledger"]) {
    assert.equal(specFor(table).optional, undefined);
  }
});

test("no second sync engine: the new tables run through the same SPECS array as the proven tables", () => {
  const tableNames = SPECS.map((s) => s.table);
  assert.ok(tableNames.includes("night_event_reservations"));
  assert.ok(tableNames.includes("event_execution_queue"));
  assert.ok(tableNames.includes("executor_order_events"));
  assert.ok(tableNames.includes("bet_execution_ledger"));
});
