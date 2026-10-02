// Constructor V1 repeatability proofs (Prompt 2): a second, synthetic, in-memory instance composes
// from the same shared engine/manifest model with different binding names and inherits NOTHING from
// CURRENT DEV_LIVE. No network, no DB, no real secrets.
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  REQUIRED_ENV_BINDINGS,
  composeContour,
  type ContourDeclarationV1,
} from "../../lib/constructor/contracts";
import {
  DEV_LIVE_COMPONENT_MANIFEST,
  DEV_LIVE_INSTANCE,
  DEV_LIVE_PROFILE,
} from "../../lib/constructor/devLive";
import { getActiveContour } from "../../lib/constructor/registry";
import { createSupabaseAdminClient } from "../../lib/supabase/adminClientFactory";
import {
  parseReservationTimes,
  parseReservationTimesMinsk,
  resolveReservationAnchor,
} from "../../lib/executor/nightWindow";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Dummy values only; they exist solely to prove which env NAME a binding reads.
const DEV_ENV = {
  RESERVATION_TIMES_MINSK: "10:00,17:00",
  EXECUTOR_CANDIDATES_SECRET: "dev-secret-placeholder",
  SUPABASE_URL: "http://dev.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "dev-key-placeholder",
};

/** Synthetic second instance: same profile policy + manifest model, every binding name different. */
function syntheticDeclaration(): ContourDeclarationV1 {
  const d = clone({
    profile: DEV_LIVE_PROFILE,
    instance: DEV_LIVE_INSTANCE,
    manifest: DEV_LIVE_COMPONENT_MANIFEST,
  }) as { -readonly [K in keyof ContourDeclarationV1]: { -readonly [P in keyof ContourDeclarationV1[K]]: ContourDeclarationV1[K][P] } };
  d.profile.contourId = "SYNTHETIC_TEST_CONTOUR";
  d.manifest.contourId = "SYNTHETIC_TEST_CONTOUR";
  d.manifest.manifestId = "synthetic-test-manifest";
  d.instance.profileRef = { contourId: "SYNTHETIC_TEST_CONTOUR" };
  d.instance.manifestRef = { manifestId: "synthetic-test-manifest", version: d.manifest.version };
  d.instance.instanceId = "SYNTHETIC_TEST_INSTANCE";
  d.instance.envBindings = {
    reservationTimesMinsk: "SYNTH_RESERVATION_TIMES",
    executorCandidatesSecret: "SYNTH_EXECUTOR_SECRET",
    supabaseUrl: "SYNTH_SUPABASE_URL",
    supabaseServiceRoleKey: "SYNTH_SUPABASE_SERVICE_KEY",
  };
  return d as ContourDeclarationV1;
}

// ── Phase 1: schedule binding ────────────────────────────────────────────────

test("parseReservationTimes is pure: undefined means 'not provided' -> 17:00, regardless of ambient env", () => {
  const before = process.env.RESERVATION_TIMES_MINSK;
  process.env.RESERVATION_TIMES_MINSK = "03:00";
  try {
    assert.deepEqual(parseReservationTimes(undefined), [{ hour: 17, minute: 0, hhmm: "1700" }]);
    // legacy ambient wrapper (non-Constructor callers) keeps its old behaviour
    assert.deepEqual(parseReservationTimesMinsk(undefined), [{ hour: 3, minute: 0, hhmm: "0300" }]);
  } finally {
    if (before === undefined) delete process.env.RESERVATION_TIMES_MINSK;
    else process.env.RESERVATION_TIMES_MINSK = before;
  }
});

test("explicit schedule values parse identically through the pure and legacy entries; invalid stays invalid", () => {
  assert.deepEqual(parseReservationTimes("10:00,17:00"), parseReservationTimesMinsk("10:00,17:00"));
  assert.deepEqual(parseReservationTimes("17:00,10:00").map((t) => t.hhmm), ["1000", "1700"]);
  assert.throws(() => parseReservationTimes(""), /RESERVATION_TIMES_MINSK_INVALID/);
  assert.throws(() => parseReservationTimes("10:00,10:00"), /RESERVATION_TIMES_MINSK_INVALID/);
  assert.throws(() => parseReservationTimes("25:00"), /RESERVATION_TIMES_MINSK_INVALID/);
});

test("CURRENT DEV schedule behaviour is identical through the instance binding", () => {
  const dev = getActiveContour();
  assert.deepEqual(parseReservationTimes(dev.resolveEnv("reservationTimesMinsk", DEV_ENV)), parseReservationTimesMinsk(DEV_ENV.RESERVATION_TIMES_MINSK));
  assert.deepEqual(parseReservationTimes(dev.resolveEnv("reservationTimesMinsk", {})), [{ hour: 17, minute: 0, hhmm: "1700" }]);
});

test("a second instance cannot consume RESERVATION_TIMES_MINSK", () => {
  const second = composeContour(syntheticDeclaration());
  const times = parseReservationTimes(second.resolveEnv("reservationTimesMinsk", DEV_ENV));
  assert.deepEqual(times, [{ hour: 17, minute: 0, hhmm: "1700" }], "DEV's 10:00,17:00 must not leak in");
  const own = parseReservationTimes(second.resolveEnv("reservationTimesMinsk", { SYNTH_RESERVATION_TIMES: "09:30" }));
  assert.deepEqual(own.map((t) => t.hhmm), ["0930"]);
});

test("explicit anchor wins over a conflicting ambient schedule through the real planning entry points", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { RESERVATION_TIMES_MINSK: "03:00", SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test-placeholder" });
  try {
    const { buildContractAReservationPlan, buildReservationPlan } = await import("../../lib/executor/nightEventReservations");
    const nowMs = Date.parse("2026-10-02T12:00:00Z");
    const anchor = resolveReservationAnchor(nowMs, parseReservationTimes("09:30"));
    const stubs = { fetchSourceRows: async () => [], produceDecisions: async () => [] };

    const direct = await buildContractAReservationPlan(nowMs, { anchor, ...stubs });
    assert.equal(direct.plan_run_id, "night-plan:2026-10-02:0930-minsk");

    const viaEntry = await buildReservationPlan(nowMs, { selectorMode: "CONTRACT_A_PLANNING_V1", anchor, ...stubs });
    assert.equal(viaEntry.plan_run_id, "night-plan:2026-10-02:0930-minsk", "buildReservationPlan must forward the explicit anchor");

    const ambient = await buildReservationPlan(nowMs, { selectorMode: "CONTRACT_A_PLANNING_V1", ...stubs });
    assert.equal(ambient.plan_run_id, "night-plan:2026-10-02:0300-minsk", "legacy no-anchor callers keep ambient behaviour");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("anchor is threaded through every cron-reachable reservation entry (source guard)", () => {
  const src = stripComments(read("lib/executor/nightEventReservations.ts"));
  assert.ok(/executeForceRebuild[\s\S]*?buildPlanRunId\(nowMs, deps\.anchor\)/.test(src));
  assert.ok(/ensureAndLoadReservations[\s\S]*?buildPlanRunId\(nowMs, opts\.anchor\)/.test(src));
  assert.ok(/resolveNightWindow\(nowMs, anchor\)/.test(src), "loadPlanStatus read-time window");
  const route = stripComments(read("app/api/cron/night-event-reservations/route.ts"));
  assert.ok(!/parseReservationTimesMinsk/.test(route), "cron route must use the pure parser");
  assert.equal((route.match(/anchor: currentAnchor/g) ?? []).length, 3);
  assert.equal((route.match(/loadPlanStatus\([^)]*, currentAnchor\)/g) ?? []).length, 3);
});

// ── Phase 4: auth / EXECUTOR_CANDIDATES_SECRET binding ───────────────────────

const AUTH_ROUTES = [
  "app/api/cron/night-event-reservations/route.ts",
  "app/api/cron/night-plan-email/route.ts",
  "app/api/cron/event-rebalance/route.ts",
  "app/api/executor/queue/route.ts",
  "app/api/executor/queue/mark/route.ts",
  "app/api/executor/candidates/route.ts",
  "app/api/executor/night-plan/route.ts",
  "app/api/executor/order-events/route.ts",
];

test("all 8 server routes resolve the shared secret through the instance binding, fail-closed form unchanged", () => {
  for (const rel of AUTH_ROUTES) {
    const src = stripComments(read(rel));
    assert.ok(!/process\.env\.EXECUTOR_CANDIDATES_SECRET/.test(src), `${rel} still reads the ambient secret`);
    assert.ok(src.includes('getActiveContour().resolveEnv("executorCandidatesSecret")'), `${rel} must use the binding`);
    assert.ok(/!expectedSecret \|\| secret !== expectedSecret/.test(src), `${rel} lost the fail-closed comparison`);
  }
});

test("DEV auth binding keeps the current env name; missing secret stays falsy (-> existing 401 path)", () => {
  const dev = getActiveContour();
  assert.equal(DEV_LIVE_INSTANCE.envBindings.executorCandidatesSecret, "EXECUTOR_CANDIDATES_SECRET");
  assert.equal(dev.resolveEnv("executorCandidatesSecret", DEV_ENV), DEV_ENV.EXECUTOR_CANDIDATES_SECRET);
  assert.ok(!dev.resolveEnv("executorCandidatesSecret", {}), "absent secret must be falsy so routes reject");
  assert.ok(!dev.resolveEnv("executorCandidatesSecret", { EXECUTOR_CANDIDATES_SECRET: "" }), "empty secret must be falsy");
});

test("a second instance's secret binding is independent of CURRENT DEV's", () => {
  const second = composeContour(syntheticDeclaration());
  assert.ok(!second.resolveEnv("executorCandidatesSecret", DEV_ENV), "DEV secret must not authenticate the second instance");
  assert.equal(second.resolveEnv("executorCandidatesSecret", { SYNTH_EXECUTOR_SECRET: "x" }), "x");
});

// ── Phase 3: Supabase resource binding ───────────────────────────────────────

test("supabase client factory resolves url/key through the instance, with today's exact error text for DEV", () => {
  const dev = getActiveContour();
  assert.throws(() => createSupabaseAdminClient(dev, {}), /^Error: Missing required environment variable: SUPABASE_URL$/);
  assert.throws(
    () => createSupabaseAdminClient(dev, { SUPABASE_URL: "http://dev.invalid" }),
    /^Error: Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY$/,
  );
  const client = createSupabaseAdminClient(dev, DEV_ENV);
  assert.equal(typeof client.from, "function");
});

test("a second instance's supabase binding cannot silently reuse CURRENT DEV's", () => {
  const second = composeContour(syntheticDeclaration());
  assert.throws(() => createSupabaseAdminClient(second, DEV_ENV), /Missing required environment variable: SYNTH_SUPABASE_URL/);
  const client = createSupabaseAdminClient(second, {
    SYNTH_SUPABASE_URL: "http://synthetic.invalid",
    SYNTH_SUPABASE_SERVICE_KEY: "synthetic-placeholder",
  });
  assert.equal(typeof client.from, "function");
});

test("process-wide supabaseAdmin is the ACTIVE contour's client built by the factory (no direct env reads)", () => {
  const src = stripComments(read("lib/supabase/server.ts"));
  assert.ok(!/process\.env/.test(src));
  assert.ok(src.includes("bootProcessRuntime().resources.supabaseAdmin()"));
  const factory = stripComments(read("lib/supabase/adminClientFactory.ts"));
  assert.ok(factory.includes('requireEnv("supabaseUrl"') && factory.includes('requireEnv("supabaseServiceRoleKey"'));
});

// ── Phase 2: event-rebalance composition ─────────────────────────────────────

test("event-rebalance cron consumes the contour for auth and passes its booted runtime into the shared engine", () => {
  const src = stripComments(read("app/api/cron/event-rebalance/route.ts"));
  assert.equal((src.match(/\{ runtime: bootProcessRuntime\(\) \}/g) ?? []).length, 3, "both WithEvidence calls and the controlled-intent call");
  const q = stripComments(read("lib/executor/eventExecutionQueue.ts"));
  assert.ok(/contour: deps\.contour,/.test(q) && /runtime: deps\.runtime,/.test(q), "WithEvidence must forward contour and runtime to runEventRebalance");
});

// ── Phase 7: second-instance reproducibility ─────────────────────────────────

test("synthetic second instance composes with entirely different identity and bindings", () => {
  const dev = getActiveContour();
  const second = composeContour(syntheticDeclaration());
  assert.notEqual(second.identity, dev.identity);
  assert.notEqual(second.instance.instanceId, dev.instance.instanceId);
  assert.notEqual(second.profile.contourId, dev.profile.contourId);
  for (const key of REQUIRED_ENV_BINDINGS) {
    assert.notEqual(second.instance.envBindings[key], dev.instance.envBindings[key], `${key} must differ`);
  }
  // shared-engine policy and component resolution are identical and deterministic
  assert.deepEqual(second.profile.selectors, dev.profile.selectors);
  for (const c of DEV_LIVE_COMPONENT_MANIFEST.components) {
    assert.deepEqual(second.component(c.id), dev.component(c.id));
  }
});

test("no DEV leakage: with ONLY DEV env names present, every second-instance binding is unresolved", () => {
  const second = composeContour(syntheticDeclaration());
  for (const key of REQUIRED_ENV_BINDINGS) {
    assert.equal(second.resolveEnv(key, DEV_ENV), undefined, `${key} leaked a DEV value`);
    assert.throws(() => second.requireEnv(key, DEV_ENV), /Missing required environment variable: SYNTH_/);
  }
  // and the reverse: DEV never reads the synthetic names
  const dev = getActiveContour();
  const synthOnly = { SYNTH_RESERVATION_TIMES: "09:30", SYNTH_EXECUTOR_SECRET: "x", SYNTH_SUPABASE_URL: "x", SYNTH_SUPABASE_SERVICE_KEY: "x" };
  for (const key of REQUIRED_ENV_BINDINGS) assert.equal(dev.resolveEnv(key, synthOnly), undefined);
});

test("CURRENT DEV declaration is unchanged and immutable after composing a second instance", () => {
  const before = getActiveContour().manifestDigest;
  composeContour(syntheticDeclaration());
  assert.equal(getActiveContour().manifestDigest, before);
  assert.equal(getActiveContour().instance.instanceId, "DEV_LIVE_PRIMARY");
  assert.ok(Object.isFrozen(getActiveContour().instance.envBindings));
});

// ── Phase 8: bounded ambient-reference guard on the migrated active paths ────

test("migrated active paths contain no direct reads of the bound env names", () => {
  const files = [...AUTH_ROUTES, "lib/supabase/server.ts", "lib/supabase/adminClientFactory.ts"];
  for (const rel of files) {
    const src = stripComments(read(rel));
    for (const name of ["RESERVATION_TIMES_MINSK", "EXECUTOR_CANDIDATES_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      assert.ok(!new RegExp(`process\\.env(\\.|\\[["'])${name}`).test(src), `${rel} reads ${name} ambiently`);
    }
  }
  // the only remaining ambient schedule read is the documented legacy wrapper
  const win = stripComments(read("lib/executor/nightWindow.ts"));
  assert.equal((win.match(/process\.env\.RESERVATION_TIMES_MINSK/g) ?? []).length, 1);
});
