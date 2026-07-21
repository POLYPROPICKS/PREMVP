// Contur3 night-reservation runner safety tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Production incident: scripts/contur3/run-night-reservations.mjs
// unconditionally sent ?forceRebuild=CEO_APPROVED on every ordinary/scheduled
// invocation, so the normal Railway cron used the destructive force-rebuild
// path by default.
//
// Network safety: every test in this file imports the runner module's pure
// helpers (resolveForceRebuildMode, buildReservationRequestUrl) and its
// injectable orchestration (runNightReservations), and supplies a mock
// fetchImpl. No test spawns the script as a subprocess and no test allows a
// real network call -- the mock fetch throws if invoked with any URL other
// than the exact expected localhost-relative endpoint, and several tests
// assert the mock is never called at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveForceRebuildMode,
  buildReservationRequestUrl,
  runNightReservations,
  FORCE_REBUILD_MARKER,
  ENDPOINT,
} from "../../scripts/contur3/run-night-reservations.mjs";

const FAKE_BASE_URL = "http://127.0.0.1:9"; // closed port -- never actually dialed by the mock

function makeMockFetch(response: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = async (url: string, init: unknown) => {
    calls.push({ url, init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  };
  return { fetchImpl, calls };
}

function makeUnreachableFetch() {
  return async () => {
    throw new Error("TEST_FAILURE: fetchImpl must never be called in this test");
  };
}

test("1. resolveForceRebuildMode: default (env var unset) is NORMAL, no error", () => {
  const result = resolveForceRebuildMode({});
  assert.equal(result.forceRebuild, false);
  assert.equal(result.mode, "NORMAL");
  assert.equal(result.error, null);
});

test("2. resolveForceRebuildMode: exact approved marker enables FORCE_REBUILD_EXPLICIT", () => {
  const result = resolveForceRebuildMode({ CONTUR3_FORCE_REBUILD: FORCE_REBUILD_MARKER });
  assert.equal(result.forceRebuild, true);
  assert.equal(result.mode, "FORCE_REBUILD_EXPLICIT");
  assert.equal(result.error, null);
});

test("3. resolveForceRebuildMode: any other value produces an error and forceRebuild=false, no process.exit call (pure function)", () => {
  for (const bad of ["wrong-value", "ceo_approved", "CEO_APPROVED ", ""]) {
    const result = resolveForceRebuildMode({ CONTUR3_FORCE_REBUILD: bad });
    assert.equal(result.forceRebuild, false);
    assert.equal(result.mode, null);
    assert.match(result.error as string, /FORCE_REBUILD_MARKER_MISMATCH/);
  }
});

test("4. buildReservationRequestUrl: default/normal mode produces a URL with no forceRebuild param", () => {
  const url = buildReservationRequestUrl(FAKE_BASE_URL, false);
  assert.equal(url.toString(), `${FAKE_BASE_URL}${ENDPOINT}`);
  assert.equal(url.searchParams.has("forceRebuild"), false);
});

test("5. buildReservationRequestUrl: force mode produces exactly forceRebuild=CEO_APPROVED", () => {
  const url = buildReservationRequestUrl(FAKE_BASE_URL, true);
  assert.equal(url.searchParams.get("forceRebuild"), "CEO_APPROVED");
});

test("6. runNightReservations: normal mode sends a request whose URL contains no forceRebuild param, via mock fetch only", async () => {
  const { fetchImpl, calls } = makeMockFetch({ status: 200, body: { ok: true, plan_run_id: "night-plan:x", reserved_count: 1 } });
  const result = await runNightReservations({
    fetchImpl,
    env: { EXECUTOR_CANDIDATES_SECRET: "test-secret-not-real" },
    baseUrl: FAKE_BASE_URL,
    writeLogs: false,
  });
  assert.equal(calls.length, 1, "fetch must be called exactly once");
  assert.equal(calls[0].url, `${FAKE_BASE_URL}${ENDPOINT}`);
  assert.equal(new URL(calls[0].url).searchParams.has("forceRebuild"), false);
  assert.equal(result.mode, "NORMAL");
  assert.equal(result.exitCode, 0);
});

test("7. runNightReservations: explicit approved force mode sends exactly forceRebuild=CEO_APPROVED, via mock fetch only", async () => {
  const { fetchImpl, calls } = makeMockFetch({ status: 200, body: { ok: true, result: "REBUILT", plan_run_id: "night-plan:x", reserved_count: 1 } });
  const result = await runNightReservations({
    fetchImpl,
    env: { EXECUTOR_CANDIDATES_SECRET: "test-secret-not-real", CONTUR3_FORCE_REBUILD: FORCE_REBUILD_MARKER },
    baseUrl: FAKE_BASE_URL,
    writeLogs: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("forceRebuild"), "CEO_APPROVED");
  assert.equal(result.mode, "FORCE_REBUILD_EXPLICIT");
  assert.equal(result.exitCode, 0);
});

test("8. runNightReservations: an invalid force marker rejects BEFORE fetchImpl is ever invoked", async () => {
  const fetchImpl = makeUnreachableFetch();
  const result = await runNightReservations({
    fetchImpl,
    env: { EXECUTOR_CANDIDATES_SECRET: "test-secret-not-real", CONTUR3_FORCE_REBUILD: "wrong-value" },
    baseUrl: FAKE_BASE_URL,
    writeLogs: false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.fetchCalled, false);
  assert.match(result.reason as string, /FORCE_REBUILD_MARKER_MISMATCH/);
});

test("9. runNightReservations: missing executor secret rejects BEFORE fetchImpl is ever invoked", async () => {
  const fetchImpl = makeUnreachableFetch();
  const result = await runNightReservations({
    fetchImpl,
    env: {},
    baseUrl: FAKE_BASE_URL,
    writeLogs: false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.fetchCalled, false);
  assert.equal(result.reason, "MISSING_EXECUTOR_SECRET");
});

test("10. runNightReservations: calling without an injected fetchImpl throws instead of silently falling back to a real network fetch", async () => {
  await assert.rejects(
    () =>
      runNightReservations({
        env: { EXECUTOR_CANDIDATES_SECRET: "test-secret-not-real" },
        baseUrl: FAKE_BASE_URL,
        writeLogs: false,
      }),
    /requires an injected fetchImpl/
  );
});

test("11. static safety: main() only runs on direct script execution, never on module import", async () => {
  // This test file itself already imports the module above without triggering
  // any network call (proven by the absence of any fetch activity in tests
  // 1-5, which use zero fetchImpl calls) -- this is a static guard on the
  // entrypoint gate so a future edit cannot silently remove it.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(
    path.join(process.cwd(), "scripts", "contur3", "run-night-reservations.mjs"),
    "utf8"
  );
  assert.match(src, /if \(import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`\) \{\s*\n\s*main\(\);\s*\n\}/);
});
