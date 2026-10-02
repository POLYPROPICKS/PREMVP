// The night-event-reservations path (planner -> reservation write -> baseline capture -> job evidence ->
// rejection evidence -> status/load) is runtime-bound: with an explicit ContourRuntimeV1 every Supabase
// touch goes through THAT runtime's client. The process selector is poisoned (any getActiveContour() or
// global supabaseAdmin boot would throw CONSTRUCTOR_CONTOUR_UNKNOWN). Functional in-memory fake databases,
// one per runtime: no network, no real DB, no secrets.
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.CONSTRUCTOR_ACTIVE_CONTOUR = "POISONED_NOT_A_CONTOUR";
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "EXECUTOR_CANDIDATES_SECRET"]) delete process.env[k];

import { bootContourRuntime, type ContourRuntimeV1 } from "../../lib/constructor/bootstrap";
import {
  executeForceRebuild,
  loadPlanStatus,
  loadReservations,
  runReservationCronWithEvidence,
} from "../../lib/executor/nightEventReservations";
import { ANCHOR_NOW_MS, baseCandidate } from "./fixtures/reservationFixture";

const ROOT = path.resolve(__dirname, "../..");
const DEV_ENV = { EXECUTOR_CANDIDATES_SECRET: "d", SUPABASE_URL: "http://dev.invalid", SUPABASE_SERVICE_ROLE_KEY: "d" };
const SHADOW_ENV = {
  CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW",
  SHADOW_EXECUTOR_CANDIDATES_SECRET: "s",
  SHADOW_SUPABASE_URL: "http://shadow.invalid",
  SHADOW_SUPABASE_SERVICE_ROLE_KEY: "s",
};

type Row = Record<string, unknown>;
type LogEntry = { op: string; table: string };

/** Minimal functional in-memory Supabase-shaped client that records every operation. */
function fakeDb() {
  const log: LogEntry[] = [];
  const tables: Record<string, Row[]> = {};
  let nextId = 1;
  const rowsOf = (t: string) => (tables[t] ??= []);
  const client = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let op = "select";
      const run = (single: boolean) => {
        log.push({ op, table });
        if (op === "delete") {
          tables[table] = rowsOf(table).filter((r) => !filters.every(([k, v]) => r[k] === v));
          return { data: [], error: null };
        }
        const data = rowsOf(table).filter((r) => filters.every(([k, v]) => r[k] === v));
        return { data: single ? (data[0] ?? null) : data, error: null };
      };
      const q: Record<string, unknown> = {
        select() { return q; },
        eq(k: string, v: unknown) { filters.push([k, v]); return q; },
        order() { return q; },
        limit() { return q; },
        in() { return q; },
        gt() { return q; },
        delete() { op = "delete"; return q; },
        maybeSingle() { return Promise.resolve(run(true)); },
        insert(input: Row | Row[]) {
          log.push({ op: "insert", table });
          for (const r of Array.isArray(input) ? input : [input]) rowsOf(table).push({ id: `id-${nextId++}`, ...r });
          return Promise.resolve({ error: null });
        },
        upsert(input: Row | Row[]) {
          log.push({ op: "upsert", table });
          for (const r of Array.isArray(input) ? input : [input]) rowsOf(table).push({ id: `id-${nextId++}`, ...r });
          return Promise.resolve({ error: null });
        },
        then(resolve: (v: unknown) => unknown) { return Promise.resolve(run(false)).then(resolve); },
      };
      return q;
    },
  };
  return { log, tables, client };
}

function runtimeOver(base: ContourRuntimeV1) {
  const db = fakeDb();
  const runtime = { ...base, resources: { supabaseAdmin: () => db.client as never } } as ContourRuntimeV1;
  return { runtime, db };
}

const touched = (db: ReturnType<typeof fakeDb>) => db.log.map((l) => `${l.op}:${l.table}`);

function cronDeps(runtime: ContourRuntimeV1) {
  return {
    runtime,
    fetchCandidates: async () => ({
      candidates: [baseCandidate({
        diagnostics: { ...baseCandidate().diagnostics, selector_id: "CONTRACT_A_PLANNING_V1", contract_a_stage: "PLANNING" },
      })],
    }),
  };
}

test("DEV runtime: planner writes the reservation and captures the baseline through the DEV client only", async () => {
  const dev = runtimeOver(bootContourRuntime(DEV_ENV));
  const shadow = runtimeOver(bootContourRuntime(SHADOW_ENV));
  const { plan, persisted } = await runReservationCronWithEvidence(ANCHOR_NOW_MS, {}, cronDeps(dev.runtime));
  assert.equal(plan.reservations.length, 1);
  assert.equal(persisted.written_count, 1);
  const t = touched(dev.db);
  assert.ok(t.includes("insert:night_event_reservations"), t.join(","));
  assert.ok(t.includes("upsert:reservation_market_capture_runs"), "baseline capture followed the SAME client as the reservation write");
  assert.ok(t.indexOf("insert:night_event_reservations") < t.indexOf("upsert:reservation_market_capture_runs"), "baseline after write");
  assert.ok(t.includes("insert:job_runs"), "job evidence through the same runtime client");
  assert.equal(shadow.db.log.length, 0, "the other runtime's client is untouched");
  assert.equal(t.filter((x) => x.endsWith(":event_execution_queue")).length, 0, "planner never touches the execution queue");
});

test("SHADOW runtime: same planning work runs against the SHADOW client only (no DEV client, no queue, no money path)", async () => {
  const dev = runtimeOver(bootContourRuntime(DEV_ENV));
  const shadow = runtimeOver(bootContourRuntime(SHADOW_ENV));
  const { plan, persisted } = await runReservationCronWithEvidence(ANCHOR_NOW_MS, {}, cronDeps(shadow.runtime));
  assert.equal(plan.reservations.length, 1);
  assert.equal(persisted.written_count, 1);
  const t = touched(shadow.db);
  assert.ok(t.includes("insert:night_event_reservations"));
  assert.ok(t.includes("upsert:reservation_market_capture_runs"));
  assert.ok(t.includes("insert:job_runs"));
  assert.equal(dev.db.log.length, 0);
  assert.equal(t.filter((x) => x.endsWith(":event_execution_queue")).length, 0);
});

test("same process, both runtimes: each planner run touches only its own client; DEV result row is identical to SHADOW's planning output", async () => {
  const dev = runtimeOver(bootContourRuntime(DEV_ENV));
  const shadow = runtimeOver(bootContourRuntime(SHADOW_ENV));
  const a = await runReservationCronWithEvidence(ANCHOR_NOW_MS, {}, cronDeps(dev.runtime));
  const devAfterA = dev.db.log.length;
  const b = await runReservationCronWithEvidence(ANCHOR_NOW_MS, {}, cronDeps(shadow.runtime));
  assert.equal(dev.db.log.length, devAfterA, "SHADOW run added nothing to the DEV client");
  assert.ok(shadow.db.log.length > 0);
  const strip = (r: Row) => { const { id: _id, ...rest } = r; return rest; };
  assert.deepEqual(strip(dev.db.tables.night_event_reservations[0]), strip(shadow.db.tables.night_event_reservations[0]), "same business decisions / row shape");
  assert.equal(a.persisted.plan_run_id, b.persisted.plan_run_id);
});

test("loadReservations / loadPlanStatus / executeForceRebuild read through the supplied runtime client", async () => {
  const shadow = runtimeOver(bootContourRuntime(SHADOW_ENV));
  const dev = runtimeOver(bootContourRuntime(DEV_ENV));
  await loadReservations("night-plan:x", shadow.runtime.resources.supabaseAdmin);
  await loadPlanStatus("night-plan:x", ANCHOR_NOW_MS, undefined, shadow.runtime.resources.supabaseAdmin);
  assert.deepEqual([...new Set(touched(shadow.db))], ["select:night_event_reservations"]);
  assert.equal(dev.db.log.length, 0);
  await executeForceRebuild(ANCHOR_NOW_MS, { runtime: shadow.runtime, fetchCandidates: async () => ({ candidates: [] }) }).catch(() => undefined);
  assert.equal(dev.db.log.length, 0, "force-rebuild never reached another client");
  assert.ok(touched(shadow.db).length > 1, "force-rebuild used the runtime client");
});

test("default candidate/source reads of the planner use the runtime client, not the process-global one", async () => {
  const shadow = runtimeOver(bootContourRuntime(SHADOW_ENV));
  // No fetchCandidates / fetchSourceRows override: the real planning read runs against the fake db.
  await runReservationCronWithEvidence(ANCHOR_NOW_MS, { selectorMode: "CONTRACT_A_PLANNING_V1" }, { runtime: shadow.runtime }).catch(
    (e) => assert.doesNotMatch(String((e as Error).message), /CONSTRUCTOR_CONTOUR_UNKNOWN/),
  );
  // Whatever the fake db could (not) serve, the only client ever reached is the runtime's: the run left its
  // job evidence there and the poisoned process selector was never consulted (asserted in the catch above).
  assert.ok(touched(shadow.db).length > 0, "runtime client was used");
});

// ── narrow protection for the migrated reservation path only ─────────────────

function body(src: string, startMarker: string): string {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, startMarker);
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}

test("GUARD (migrated reservation path only): runtime-bound entries never reach the process-global client or contour", () => {
  const src = readFileSync(path.join(ROOT, "lib/executor/nightEventReservations.ts"), "latin1");
  for (const marker of [
    "export async function runReservationCronWithEvidence(",
    "export async function executeForceRebuild(",
    "export async function ensureAndLoadReservations(",
    "export async function buildContractAReservationPlan(",
  ]) {
    const b = body(src, marker);
    assert.doesNotMatch(b, /supabase\/server/, `${marker}: no direct global client import`);
    assert.doesNotMatch(b, /getActiveContour|process\.env/, `${marker}: no ambient contour/env below the bootstrap boundary`);
    for (const call of b.match(/createSupabase\w+Port\([^)]*\)/g) ?? []) {
      assert.match(call, /runtimeClient/, `${marker}: ${call} must receive the runtime client getter`);
    }
  }
  // The only global-client import left in the file is the labelled legacy default getter.
  const imports = src.match(/import\("@\/lib\/supabase\/server"\)/g) ?? [];
  assert.equal(imports.length, 1, "single legacy default getter (defaultProcessReservationClient)");
  assert.match(src, /captureReservationMarketBaseline\(saved, \{ getClient: runtimeClient \}\)/);
});

test("GUARD: the reservation cron boundaries select once via bootProcessRuntime and hand the runtime down", () => {
  for (const rel of ["app/api/cron/night-event-reservations/route.ts", "app/api/cron/night-plan-email/route.ts"]) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, /bootProcessRuntime\(\)/, rel);
    assert.doesNotMatch(src, /getActiveContour/, `${rel}: no process-global contour lookup`);
    assert.match(src, /runtime/, rel);
  }
  const route = readFileSync(path.join(ROOT, "app/api/cron/night-event-reservations/route.ts"), "utf8");
  assert.match(route, /runReservationCronWithEvidence\([\s\S]*?\{ runtime \}\)/);
  assert.match(route, /executeForceRebuild\(nowMs, \{ selectorMode, anchor: currentAnchor, runtime \}\)/);
  assert.equal((route.match(/runtime\.resources\.supabaseAdmin/g) ?? []).length >= 5, true);
});
