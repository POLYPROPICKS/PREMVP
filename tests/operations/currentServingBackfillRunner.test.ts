import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { classifyBackfillTransportError, runCurrentServingBackfill, type ServingBackfillCheckpoint, type ServingBackfillPort, type ServingBackfillReceipt } from "../../lib/operations/currentServingBackfillRunner";

const checkpoint = (n: number): ServingBackfillCheckpoint => ({ lastSourceCreatedAt: n ? `2026-08-08T00:00:${n.toString().padStart(2, "0")}Z` : null, lastSourceGeneratedSignalPairId: n ? `id-${n}` : null });

test("sequential runner confirms terminal zero after a short batch and persists a bounded receipt", async () => {
  const calls: number[] = []; let cursor = 0; let receipt: ServingBackfillReceipt | null = null;
  const port: ServingBackfillPort = { async backfill(size) { calls.push(size); const n = [25, 7, 0][calls.length - 1]; cursor += n; return n; }, async readCheckpoint() { return checkpoint(cursor); }, async close() {} };
  const result = await runCurrentServingBackfill({ newPort: async () => port, store: { load: () => receipt, save: (next) => { receipt = next; } }, sleep: async () => {}, now: () => 1000 });
  assert.deepEqual(calls, [25, 25, 25]); assert.equal(result.terminalZeroConfirmed, true); assert.equal(result.rowsProcessed, 32); assert.equal(result.batches, 3); assert.equal(result.terminal, true);
});

test("an ambiguous transport result reconnects and resumes from the changed durable cursor without replay", async () => {
  let ports = 0; let cursor = 0; const calls: string[] = []; let receipt: ServingBackfillReceipt | null = null;
  const newPort = async (): Promise<ServingBackfillPort> => { const id = ++ports; return { async backfill() { calls.push(`call-${id}`); if (id === 1) { cursor = 25; throw new Error("ETIMEDOUT"); } return 0; }, async readCheckpoint() { calls.push(`read-${id}`); return checkpoint(cursor); }, async close() { calls.push(`close-${id}`); } }; };
  const result = await runCurrentServingBackfill({ newPort, store: { load: () => receipt, save: (next) => { receipt = next; } }, sleep: async () => {}, now: () => 1000 });
  assert.equal(result.transportRecoveries, 1); assert.equal(calls.filter((x) => x === "call-1").length, 1); assert.equal(calls.filter((x) => x === "call-2").length, 2, "zero requires the terminal confirmation");
});

test("only throttles and ambiguous transport failures are retried", () => {
  assert.equal(classifyBackfillTransportError(new Error("HTTP 429")), "THROTTLE");
  assert.equal(classifyBackfillTransportError(new Error("connection reset")), "AMBIGUOUS");
  assert.equal(classifyBackfillTransportError(new Error("(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 15000ms in Session mode")), "POOL_EXHAUSTED");
  assert.equal(classifyBackfillTransportError(new Error("SQLSTATE 57014")), "POSTGRES");
});

test("pool exhaustion discards the port, backs off, recovers its checkpoint, and never replays the failed batch", async () => {
  let portNumber = 0; let cursor = 0; const calls: string[] = []; const events: string[] = []; let receipt: ServingBackfillReceipt | null = null;
  const newPort = async (): Promise<ServingBackfillPort> => {
    const id = ++portNumber;
    return {
      async backfill() { calls.push(`backfill-${id}`); if (id === 1) throw new Error("ECHECKOUTTIMEOUT"); return 0; },
      async readCheckpoint() { calls.push(`checkpoint-${id}`); return checkpoint(cursor); },
      async close() { calls.push(`close-${id}`); },
    };
  };
  const result = await runCurrentServingBackfill({ newPort, store: { load: () => receipt, save: (next) => { receipt = next; } }, sleep: async () => {}, now: () => 1000, random: () => 0, onEvent: (event) => events.push(event) });
  assert.equal(result.transportPaused, false); assert.equal(result.transportRecoveries, 1);
  assert.equal(calls.filter((call) => call === "backfill-1").length, 1);
  assert.deepEqual(events, ["POOL_EXHAUSTED", "RECOVERY_BACKOFF", "CHECKPOINT_RECOVERED", "BACKFILL_RESUMED"]);
  assert.ok(calls.indexOf("close-1") < calls.indexOf("checkpoint-2"));
});

test("extended pool exhaustion persists a resumable transport pause", async () => {
  const receipts: ServingBackfillReceipt[] = []; const events: string[] = [];
  const newPort = async (): Promise<ServingBackfillPort> => ({
    async backfill() { return 0; },
    async readCheckpoint() { throw new Error("ECHECKOUTTIMEOUT"); },
    async close() {},
  });
  const result = await runCurrentServingBackfill({ newPort, store: { load: () => null, save: (next) => { receipts.push(next); } }, sleep: async () => {}, now: () => 1000, random: () => 0, maxTransportRecoveries: 2, onEvent: (event) => events.push(event) });
  assert.equal(result.transportPaused, true); assert.equal(result.terminalZeroConfirmed, false);
  assert.equal(receipts.at(-1)?.transportPaused, true); assert.equal(result.transportRecoveries, 3);
  assert.equal(events.filter((event) => event === "POOL_EXHAUSTED").length, 3);
});

test("production adapter has a bounded cancellable query watchdog and visible heartbeat", () => {
  const runner = fs.readFileSync(path.resolve(process.cwd(), "scripts/current-serving-backfill-runner.ts"), "utf8");
  assert.match(runner, /const QUERY_TIMEOUT_MS = 45_000/);
  assert.match(runner, /const HEARTBEAT_MS = 15_000/);
  assert.match(runner, /runner_event: "RUNNER_STARTED"/);
  assert.match(runner, /runner_event: "QUERY_HEARTBEAT"/);
  assert.match(runner, /query\.cancel\(\)/);
  assert.match(runner, /RUNNER_QUERY_TIMEOUT:.*QUERY_TIMEOUT_MS/);
});
