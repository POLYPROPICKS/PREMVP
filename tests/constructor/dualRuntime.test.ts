// Two booted Constructor runtimes (DEV_LIVE + PROD_SHADOW) coexist in ONE process and drive the SAME
// shared engine; the only difference is the runtime they were handed. No network, no DB, no secrets.
// The process selector is deliberately poisoned: if shared code re-selected a contour deep inside
// business logic (instead of using the runtime it was given), it would throw CONSTRUCTOR_CONTOUR_UNKNOWN.
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CONSTRUCTOR_ACTIVE_CONTOUR = "POISONED_NOT_A_CONTOUR";
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "EXECUTOR_CANDIDATES_SECRET"]) delete process.env[k];

import { bootContourRuntime } from "../../lib/constructor/bootstrap";
import { CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED } from "../../lib/constructor/contracts";
import { createSupabaseRebalanceRepoPort, runEventRebalance } from "../../lib/executor/eventExecutionQueue";
import { IN_WINDOW_MS, spyRepo, writeDeps } from "./fixtures/rebalanceFixture";

const DEV_ENV = {
  EXECUTOR_CANDIDATES_SECRET: "dev-secret",
  SUPABASE_URL: "http://dev.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "dev-key",
};
const SHADOW_ENV = {
  CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW",
  SHADOW_EXECUTOR_CANDIDATES_SECRET: "shadow-secret",
  SHADOW_SUPABASE_URL: "http://shadow.invalid",
  SHADOW_SUPABASE_SERVICE_ROLE_KEY: "shadow-key",
};
const BLOCKED = new RegExp(CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED);

test("poisoned process selector proves the premise: process-level selection is unusable here", async () => {
  const { getActiveContour } = await import("../../lib/constructor/registry");
  assert.throws(() => getActiveContour(), /CONSTRUCTOR_CONTOUR_UNKNOWN/);
});

test("DEV and SHADOW runtimes coexist: distinct identity, bindings, capability; manifest identity deterministic", () => {
  const dev = bootContourRuntime(DEV_ENV);
  const shadow = bootContourRuntime(SHADOW_ENV);
  assert.notEqual(dev.contour.instance.instanceId, shadow.contour.instance.instanceId);
  assert.equal(dev.contract.moneyMovement, "enabled");
  assert.equal(shadow.contract.moneyMovement, "disabled");
  const names = (r: typeof dev) => Object.values(r.contract.bindings).map((b) => b.envVar);
  assert.equal(names(dev).filter((n) => names(shadow).includes(n)).length, 0, "no shared binding name");
  assert.equal(dev.contour.manifestDigest, bootContourRuntime(DEV_ENV).contour.manifestDigest);
  assert.notEqual(dev.contour.manifestDigest, shadow.contour.manifestDigest, "distinct manifest identity");
  assert.ok(Object.isFrozen(dev) && Object.isFrozen(dev.resources));
  assert.ok(!/dev-key|shadow-key|dev-secret|shadow-secret/.test(JSON.stringify([dev.contract, shadow.contract])), "secret-safe");
});

test("resources are contour-bound and per-runtime: each client uses its own URL, memoized, never the other's", () => {
  const dev = bootContourRuntime(DEV_ENV);
  const shadow = bootContourRuntime(SHADOW_ENV);
  const devClient = dev.resources.supabaseAdmin();
  const shadowClient = shadow.resources.supabaseAdmin();
  assert.notEqual(devClient, shadowClient);
  assert.equal(dev.resources.supabaseAdmin(), devClient, "memoized per runtime");
  const url = (c: unknown) => (c as { supabaseUrl: string }).supabaseUrl;
  assert.equal(url(devClient), "http://dev.invalid");
  assert.equal(url(shadowClient), "http://shadow.invalid");
  // Resources read the env captured at boot, not ambient process.env (which holds neither).
  assert.equal(process.env.SUPABASE_URL, undefined);
});

test("resources are lazy: booting never reads or requires a binding value", () => {
  const dev = bootContourRuntime({});
  assert.throws(() => dev.resources.supabaseAdmin(), /Missing required environment variable: SUPABASE_URL/);
});

test("shared repo port takes the runtime's client and never reaches for the process-global supabaseAdmin", async () => {
  const seen: string[] = [];
  const stub = { from(table: string) { seen.push(table); throw new Error("STUB_CLIENT_USED"); } };
  const port = createSupabaseRebalanceRepoPort(() => stub as never);
  await assert.rejects(port.loadActiveReservations(), /STUB_CLIENT_USED/);
  assert.deepEqual(seen, ["night_event_reservations"]);
});

test("SAME shared engine, DEV runtime: valid intent is admitted (queued) exactly as before", async () => {
  const dev = bootContourRuntime(DEV_ENV);
  const { repo, calls, queue } = spyRepo();
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { ...writeDeps(repo), runtime: dev });
  assert.equal(result.queued_count, 1);
  assert.equal(calls.insert, 1);
  assert.equal(queue[0].condition_id, "b-spread");
});

test("SAME shared engine, SHADOW runtime: identical selection and live guard, then BLOCKED at the money boundary", async () => {
  const shadow = bootContourRuntime(SHADOW_ENV);
  const { repo, calls } = spyRepo();
  let guardReached = 0;
  const deps = { ...writeDeps(repo), runtime: shadow };
  const book = deps.fetchExactTokenOrderbook;
  deps.fetchExactTokenOrderbook = async (t: string) => { guardReached += 1; return book(t); };
  await assert.rejects(runEventRebalance(IN_WINDOW_MS, { write: true }, deps), BLOCKED);
  assert.equal(guardReached, 1, "non-money work ran: selection, T-10 decisions, exact-book guard");
  assert.equal(calls.insert, 0, "downstream writer invocation = 0");
  assert.equal(calls.markQueued, 0);
});

test("SHADOW dry-run through the shared engine: meaningful computation, zero writes, no throw", async () => {
  const shadow = bootContourRuntime(SHADOW_ENV);
  const { repo, calls } = spyRepo();
  const result = await runEventRebalance(IN_WINDOW_MS, { write: false }, {
    ...writeDeps(repo),
    runtime: shadow,
    fetchCandidates: async () => ({ candidates: [] }),
    fetchContractAFinalCandidates: async () => ({ candidates: [] }),
  });
  assert.equal(result.wrote, false);
  assert.equal(result.due_count, 1);
  assert.equal(calls.insert, 0);
});

test("DEFAULT candidate fetch of the shared engine reads through the runtime's client, not the process-global one", async () => {
  const shadow = bootContourRuntime(SHADOW_ENV);
  const seen: string[] = [];
  const stub = { from(table: string) { seen.push(table); throw new Error("STUB_CLIENT_USED"); } };
  const stubbed = { ...shadow, resources: { supabaseAdmin: () => stub as never } };
  const { repo, calls } = spyRepo();
  // No fetchCandidates override: the real buildFireModelCandidates planning read runs. If it reached the
  // global supabaseAdmin it would boot the (poisoned) process selector and throw CONSTRUCTOR_CONTOUR_UNKNOWN.
  const deps = { ...writeDeps(repo), runtime: stubbed };
  await assert.rejects(runEventRebalance(IN_WINDOW_MS, { write: false }, deps), /STUB_CLIENT_USED/);
  assert.ok(seen.length > 0, "planning universe was read via the injected runtime client");
  assert.equal(calls.insert, 0);
});

test("runs are independent: shadow block does not poison DEV, and DEV success does not unblock shadow", async () => {
  const dev = bootContourRuntime(DEV_ENV);
  const shadow = bootContourRuntime(SHADOW_ENV);
  const s1 = spyRepo();
  await assert.rejects(runEventRebalance(IN_WINDOW_MS, { write: true }, { ...writeDeps(s1.repo), runtime: shadow }), BLOCKED);
  const d = spyRepo();
  assert.equal((await runEventRebalance(IN_WINDOW_MS, { write: true }, { ...writeDeps(d.repo), runtime: dev })).queued_count, 1);
  const s2 = spyRepo();
  await assert.rejects(runEventRebalance(IN_WINDOW_MS, { write: true }, { ...writeDeps(s2.repo), runtime: shadow }), BLOCKED);
  assert.equal(s1.calls.insert + s2.calls.insert, 0);
});

test("final-T3 read port and decision store are bound to the injected client (no process-global reach)", async () => {
  const { createFinalT3ReadPort, createReservationStrategyDecisionStore } = await import("../../lib/executor/reservationMarketBaseline");
  const seen: string[] = [];
  const stub = { from(table: string) { seen.push(table); throw new Error("STUB_CLIENT_USED"); } };
  const get = () => stub as never;
  await assert.rejects(createFinalT3ReadPort(get).readRuns("r"), /STUB_CLIENT_USED/);
  await assert.rejects(createFinalT3ReadPort(get).readObservations("c", "a"), /STUB_CLIENT_USED/);
  await assert.rejects(createReservationStrategyDecisionStore(get).readObservations("c", "a", 1), /STUB_CLIENT_USED/);
  await assert.rejects(createReservationStrategyDecisionStore(get).upsertDecisions([]), /STUB_CLIENT_USED/);
  assert.deepEqual(seen, [
    "reservation_market_capture_runs",
    "reservation_market_observations",
    "reservation_market_observations",
    "reservation_strategy_observations",
  ]);
});

test("DEFAULT T3 universe read of the shared engine goes through the runtime's client", async () => {
  const shadow = bootContourRuntime(SHADOW_ENV);
  const seen: string[] = [];
  const stub = { from(table: string) { seen.push(table); throw new Error("STUB_CLIENT_USED"); } };
  const stubbed = { ...shadow, resources: { supabaseAdmin: () => stub as never } };
  const { repo, calls } = spyRepo();
  const deps = { ...writeDeps(repo), runtime: stubbed } as Record<string, unknown>;
  delete deps.readFinalT3Universe; // use the engine default reader
  deps.fetchCandidates = async () => ({ candidates: [] });
  deps.fetchContractAFinalCandidates = async () => ({ candidates: [] });
  await runEventRebalance(IN_WINDOW_MS, { write: true }, deps as never).catch(() => undefined);
  assert.ok(seen.includes("reservation_market_capture_runs"), `T3 read hit the runtime client (saw: ${seen.join(",")})`);
  assert.equal(calls.insert, 0);
});

test("a caller-supplied DEV contour cannot override a SHADOW runtime: the runtime's contour wins and money stays blocked", async () => {
  const shadow = bootContourRuntime(SHADOW_ENV);
  const dev = bootContourRuntime(DEV_ENV);
  const { repo, calls } = spyRepo();
  await assert.rejects(
    runEventRebalance(IN_WINDOW_MS, { write: true }, { ...writeDeps(repo), contour: dev.contour, runtime: shadow }),
    BLOCKED,
  );
  assert.equal(calls.insert, 0);
});
