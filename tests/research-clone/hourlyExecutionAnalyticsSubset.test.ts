// DBCLONE_HOURLY_EXECUTION_ANALYTICS_SYNC_V1: the hourly `--telemetry-only` run
// must also refresh exactly the live execution facts, reusing the existing
// SPECS entries and syncTable path -- never the full nightly table set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HOURLY_EXECUTION_TABLES, hourlyExecutionSpecs } from "../../scripts/research-clone-daily-sync";

test("hourly execution subset is exactly queue, order events, ledger", () => {
  assert.deepEqual([...HOURLY_EXECUTION_TABLES], ["event_execution_queue", "executor_order_events", "bet_execution_ledger"]);
  assert.deepEqual(hourlyExecutionSpecs().map((spec) => spec.table), [...HOURLY_EXECUTION_TABLES]);
});

test("hourly execution subset excludes the full-nightly signal tables", () => {
  const tables = hourlyExecutionSpecs().map((spec) => spec.table) as string[];
  assert.ok(!tables.includes("generated_signal_pairs"));
  assert.ok(!tables.includes("generated_signal_research_snapshots"));
  assert.ok(!tables.includes("night_event_reservations"));
});

test("hourly ledger spec keeps mutable shape, finite bootstrap and 30-day reconciliation", () => {
  const ledger = hourlyExecutionSpecs().find((spec) => spec.table === "bet_execution_ledger");
  assert.ok(ledger);
  assert.equal(ledger.appendOnly, false);
  assert.ok(ledger.bootstrapSince && !Number.isNaN(Date.parse(ledger.bootstrapSince)));
  assert.equal(typeof ledger.reconciliationStart, "function");
});

test("--telemetry-only branch invokes the execution subset after telemetry sync and purge", () => {
  const source = readFileSync(new URL("../../scripts/research-clone-daily-sync.ts", import.meta.url), "utf8");
  const branch = source.slice(source.indexOf('process.argv.includes("--telemetry-only")'));
  const telemetry = branch.indexOf("TELEMETRY_PURGE_ORDER.slice().reverse()");
  const purge = branch.indexOf("purgeTelemetry(target, source");
  const execution = branch.indexOf("hourlyExecutionSpecs()");
  const success = branch.indexOf('MODE: "TELEMETRY_ONLY"');
  assert.ok(telemetry >= 0 && telemetry < purge && purge < execution && execution < success);
  const successLine = branch.slice(success, branch.indexOf("\n", success));
  assert.ok(successLine.includes("EXECUTION_TABLES: executionTables"));
});
