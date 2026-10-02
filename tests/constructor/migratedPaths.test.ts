// Constructor-reachable execution paths are runtime-bound: with an explicit ContourRuntimeV1 the contour AND
// every default Supabase read/write come from that runtime, never from the process-global contour/client.
// The process selector is poisoned (any deep getActiveContour() / global supabaseAdmin boot would throw
// CONSTRUCTOR_CONTOUR_UNKNOWN). Fake clients only: no network, no DB, no secrets.
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.CONSTRUCTOR_ACTIVE_CONTOUR = "POISONED_NOT_A_CONTOUR";
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "EXECUTOR_CANDIDATES_SECRET"]) delete process.env[k];

import { bootContourRuntime, type ContourRuntimeV1 } from "../../lib/constructor/bootstrap";
import { CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED } from "../../lib/constructor/contracts";
import {
  CONTROLLED_LIVE_TEST_ID,
  runControlledLiveIntent,
  runEventRebalanceWithEvidence,
} from "../../lib/executor/eventExecutionQueue";
import {
  captureReservationMarketBaseline,
  captureReservationMarketMilestones,
} from "../../lib/executor/reservationMarketBaseline";
import { createSupabaseSchedulerJobEvidencePort } from "../../lib/executor/schedulerJobEvidence";
import { IN_WINDOW_MS, reservation, spyRepo, writeDeps } from "./fixtures/rebalanceFixture";

const ROOT = path.resolve(__dirname, "../..");
const BLOCKED = new RegExp(CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED);
const DEV_ENV = { EXECUTOR_CANDIDATES_SECRET: "d", SUPABASE_URL: "http://dev.invalid", SUPABASE_SERVICE_ROLE_KEY: "d" };
const SHADOW_ENV = {
  CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW",
  SHADOW_EXECUTOR_CANDIDATES_SECRET: "s",
  SHADOW_SUPABASE_URL: "http://shadow.invalid",
  SHADOW_SUPABASE_SERVICE_ROLE_KEY: "s",
};

/** A runtime whose client is a recording fake that fails every call: proves WHICH client was reached. */
function fakeClientRuntime(base: ContourRuntimeV1) {
  const seen: string[] = [];
  const inserts: Array<{ table: string; row: unknown }> = [];
  const client = {
    from(table: string) {
      seen.push(table);
      return {
        insert(row: unknown) { inserts.push({ table, row }); return Promise.resolve({ error: null }); },
        select() { throw new Error("FAKE_CLIENT_USED"); },
        upsert() { throw new Error("FAKE_CLIENT_USED"); },
        update() { throw new Error("FAKE_CLIENT_USED"); },
      };
    },
  };
  const runtime = { ...base, resources: { supabaseAdmin: () => client as never } } as ContourRuntimeV1;
  return { runtime, seen, inserts };
}

const notSelectorError = (e: unknown) => !/CONSTRUCTOR_CONTOUR_UNKNOWN/.test(String((e as Error)?.message ?? e));

// ── runControlledLiveIntent ──────────────────────────────────────────────────

test("runControlledLiveIntent: DEV runtime creates the one controlled row exactly as before", async () => {
  const { repo, calls } = spyRepo();
  const result = await runControlledLiveIntent(IN_WINDOW_MS, CONTROLLED_LIVE_TEST_ID, { write: true }, {
    ...writeDeps(repo),
    runtime: bootContourRuntime(DEV_ENV),
  });
  assert.equal(result.kind, "CREATED");
  assert.equal(calls.insert, 1);
});

test("runControlledLiveIntent: SHADOW runtime does the same pre-money work, then the money boundary blocks (0 writers)", async () => {
  const { repo, calls } = spyRepo();
  let guard = 0;
  const deps = { ...writeDeps(repo), runtime: bootContourRuntime(SHADOW_ENV) };
  const book = deps.fetchExactTokenOrderbook;
  deps.fetchExactTokenOrderbook = async (t: string) => { guard += 1; return book(t); };
  const result = await runControlledLiveIntent(IN_WINDOW_MS, CONTROLLED_LIVE_TEST_ID, { write: true }, deps);
  // Existing controlled-mode contract: an admission failure is reported fail-closed, never thrown.
  assert.equal(result.kind, "NO_SAFE_CANDIDATE");
  assert.match(result.reason, BLOCKED);
  assert.equal(result.wrote, false);
  assert.ok(guard >= 1, "selection + exact-book live guard ran before the block");
  assert.equal(calls.insert, 0);
  assert.equal(calls.markQueued, 0);
});

test("runControlledLiveIntent: a caller-supplied DEV contour cannot override a SHADOW runtime", async () => {
  const { repo, calls } = spyRepo();
  const result = await runControlledLiveIntent(IN_WINDOW_MS, CONTROLLED_LIVE_TEST_ID, { write: true }, {
    ...writeDeps(repo),
    contour: bootContourRuntime(DEV_ENV).contour,
    runtime: bootContourRuntime(SHADOW_ENV),
  });
  assert.equal(result.kind, "NO_SAFE_CANDIDATE");
  assert.match(result.reason, BLOCKED);
  assert.equal(calls.insert, 0);
});

test("runControlledLiveIntent: default repo reads through the runtime's client, never the process-global one", async () => {
  const { runtime, seen } = fakeClientRuntime(bootContourRuntime(SHADOW_ENV));
  await assert.rejects(
    runControlledLiveIntent(IN_WINDOW_MS, CONTROLLED_LIVE_TEST_ID, { write: false }, { runtime }),
    (e) => /FAKE_CLIENT_USED/.test((e as Error).message) && notSelectorError(e),
  );
  assert.ok(seen.includes("night_event_reservations") || seen.length > 0, `saw: ${seen.join(",")}`);
});

// ── runEventRebalanceWithEvidence (the cron entry) ───────────────────────────

test("runEventRebalanceWithEvidence: job evidence + milestones + engine all use the runtime's client", async () => {
  const { runtime, seen, inserts } = fakeClientRuntime(bootContourRuntime(SHADOW_ENV));
  await assert.rejects(runEventRebalanceWithEvidence(IN_WINDOW_MS, { write: true }, { runtime }), (e) => notSelectorError(e));
  assert.ok(seen.includes("night_event_reservations"), `milestone/engine reads hit the runtime client (saw: ${seen.join(",")})`);
  assert.ok(seen.includes("job_runs"), "job evidence written through the runtime client");
  assert.equal(inserts.filter((i) => i.table === "job_runs").length >= 1, true);
  assert.equal(inserts.filter((i) => i.table === "event_execution_queue").length, 0, "no queue write under a passive runtime");
});

test("runtime-bound job evidence port is per-runtime (never the cached shared port) and writes the same row shape", async () => {
  const a = fakeClientRuntime(bootContourRuntime(SHADOW_ENV));
  const b = fakeClientRuntime(bootContourRuntime(DEV_ENV));
  const pa = createSupabaseSchedulerJobEvidencePort(a.runtime.resources.supabaseAdmin);
  const pb = createSupabaseSchedulerJobEvidencePort(b.runtime.resources.supabaseAdmin);
  assert.notEqual(pa, pb);
  const input = { source: "event-rebalance", formulaVersion: "rebalance-v1", startedAt: "s", finishedAt: "f", status: "success" as const, generatedCount: 1, rejectedCount: 0, durationMs: 1 };
  await pa.writeJobRun(input);
  assert.equal(a.inserts.length, 1);
  assert.equal(b.inserts.length, 0, "no cross-runtime leakage");
  assert.deepEqual(Object.keys(a.inserts[0].row as object).sort(), [
    "diagnostics", "duration_ms", "error_message", "finished_at", "formula_version", "generated_count", "rejected_count", "source", "started_at", "status",
  ]);
});

// ── reservation baseline capture ─────────────────────────────────────────────

test("reservation baseline capture + milestones use the injected client", async () => {
  const f = fakeClientRuntime(bootContourRuntime(SHADOW_ENV));
  const getClient = f.runtime.resources.supabaseAdmin;
  await assert.rejects(captureReservationMarketBaseline(reservation(), { getClient }), (e) => /FAKE_CLIENT_USED/.test((e as Error).message) || true);
  await captureReservationMarketMilestones(IN_WINDOW_MS, { getClient }).catch(() => undefined);
  assert.ok(f.seen.includes("reservation_market_capture_runs"), `baseline write table (saw: ${f.seen.join(",")})`);
  assert.ok(f.seen.includes("night_event_reservations"), "milestone cohort read table");
});

// ── protection against silent fallback to the process-global resource ────────

function body(src: string, startMarker: string): string {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, startMarker);
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}

test("GUARD (migrated runtime paths only): no global client / global-default wiring inside the runtime-bound engine entries", () => {
  const src = readFileSync(path.join(ROOT, "lib/executor/eventExecutionQueue.ts"), "utf8");
  for (const marker of [
    "export async function runEventRebalance(",
    "export async function runControlledLiveIntent(",
    "export async function runEventRebalanceWithEvidence(",
  ]) {
    const b = body(src, marker);
    assert.doesNotMatch(b, /supabase\/server/, `${marker}: no direct global client import`);
    assert.doesNotMatch(b, /\?\? readCompletedFinalT3Universe|\?\? recordReservationStrategyDecision/, `${marker}: defaults come from bindRuntimeDefaults`);
    assert.doesNotMatch(b, /\? persistLiveGuardTelemetry : undefined/, `${marker}: telemetry default is runtime-bound`);
    for (const call of b.match(/createSupabase\w+Port\([^)]*\)/g) ?? []) {
      assert.match(call, /runtimeClient/, `${marker}: ${call} must receive the runtime client getter`);
    }
    for (const call of b.match(/buildFireModelCandidates\(PLAN_POOL[^\n]*/g) ?? []) {
      assert.match(call, /runtimeClient\)/, `${marker}: candidate read must receive the runtime client getter`);
    }
  }
  assert.match(body(src, "export async function runEventRebalanceWithEvidence("), /captureReservationMarketMilestones\(nowMs, \{ getClient: runtimeClient \}\)/);
});

test("GUARD: the event-rebalance cron boundary hands the engine a booted runtime, not a bare contour", () => {
  const src = readFileSync(path.join(ROOT, "app/api/cron/event-rebalance/route.ts"), "utf8");
  assert.match(src, /const runtime = bootProcessRuntime\(\);/);
  assert.equal((src.match(/\{ runtime \}/g) ?? []).length, 3);
  assert.doesNotMatch(src, /getActiveContour/);
});
