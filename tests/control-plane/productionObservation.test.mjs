// production-observation.mjs — unit coverage for the read-only recovery/resume state
// machine registered as premvp.command.production_observation.v1.
//
// Only globalThis.fetch is replaced; every function under test runs unmodified.
// Run with: node --test tests/control-plane/productionObservation.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  probeDatabase,
  probeAppReadSurface,
  measureProducerOutput,
  runObservation,
  STAGES,
  stageIndex,
} from "../../scripts/control-plane/production-observation.mjs";

const realFetch = globalThis.fetch;

function jsonResponse(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── STAGES ordering ─────────────────────────────────────────────────────────

test("stage ordering places database_waiting before measurement stages and observation_complete last", () => {
  assert.equal(STAGES[0], "deployment_identity_proven");
  assert.ok(stageIndex("database_waiting") < stageIndex("producer_persistence_measured"));
  assert.equal(STAGES[STAGES.length - 1], "observation_complete");
  assert.equal(stageIndex("not_a_real_stage"), -1);
});

// ── probeDatabase ────────────────────────────────────────────────────────────

test("probeDatabase: healthy 2xx response is classified available", async () => {
  globalThis.fetch = async () => jsonResponse(200, { ok: true });
  const r = await probeDatabase("https://x.example", "key");
  assert.equal(r.available, true);
  assert.equal(r.reason, null);
});

test("probeDatabase: PGRST002/503 is classified as recoverable, not a boundary", async () => {
  globalThis.fetch = async () =>
    jsonResponse(503, { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." });
  const r = await probeDatabase("https://x.example", "key");
  assert.equal(r.available, false);
  assert.match(r.reason, /PGRST002_OR_503/);
  assert.equal(r.authBoundary, undefined, "a 503/PGRST002 must never be flagged as an auth boundary");
});

test("probeDatabase: a network-level failure is classified as unavailable, not thrown", async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch failed: ECONNRESET");
  };
  const r = await probeDatabase("https://x.example", "key");
  assert.equal(r.available, false);
  assert.match(r.reason, /NETWORK_UNREACHABLE/);
});

test("probeDatabase: 401/403 is a real auth boundary, distinct from infrastructure WAIT", async () => {
  globalThis.fetch = async () => jsonResponse(401, { message: "no" });
  const r = await probeDatabase("https://x.example", "key");
  assert.equal(r.available, false);
  assert.equal(r.authBoundary, true);
});

// ── probeAppReadSurface ────────────────────────────────────────────────────

test("probeAppReadSurface: a real signal pair id is healthy evidence", async () => {
  globalThis.fetch = async () => jsonResponse(200, { pairs: [{ id: "live-pair-123" }] });
  const r = await probeAppReadSurface("https://app.example");
  assert.equal(r.healthy, true);
});

test("probeAppReadSurface: static-fallback-* payload is degraded, not healthy, despite HTTP 200", async () => {
  globalThis.fetch = async () => jsonResponse(200, { pairs: [{ id: "static-fallback-0" }] });
  const r = await probeAppReadSurface("https://app.example");
  assert.equal(r.healthy, false);
  assert.equal(r.degraded, true);
  assert.equal(r.reason, "STATIC_FALLBACK_DEGRADED");
});

test("probeAppReadSurface: a non-200 app response is unhealthy with the status reported", async () => {
  globalThis.fetch = async () => jsonResponse(500, null);
  const r = await probeAppReadSurface("https://app.example");
  assert.equal(r.healthy, false);
  assert.match(r.reason, /HTTP 500/);
});

// ── measureProducerOutput ────────────────────────────────────────────────────

function rowsResponse(rows) {
  return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
}

test("measureProducerOutput: distinguishes identity-complete rows from rows missing provider context", async () => {
  const rows = [
    {
      diagnostics: {
        providerEventId: "evt-1",
        providerEventContext: { v: "v1", provider: "polymarket", eventId: "evt-1", eventStartIso: "2030-01-01T00:00:00.000Z" },
      },
      score: null,
    },
    {
      diagnostics: { providerEventId: "evt-1" }, // second outcome row, same event, no context
      score: 0.6,
    },
    {
      diagnostics: { providerEventId: "evt-2" }, // pre-fix style row: no providerEventContext at all
      score: null,
    },
  ];
  globalThis.fetch = async () => rowsResponse(rows);
  const m = await measureProducerOutput("https://x.example", "key", "generated_signal_pairs", "shadow-strategic-sports-v1");
  assert.equal(m.ok, true);
  assert.equal(m.rowsPersisted, 3);
  assert.equal(m.signalPairPresentEvents, 2, "evt-1 and evt-2 are two distinct events across 3 rows");
  assert.equal(m.identityCompleteEvents, 1, "only evt-1 carries a valid structured context on at least one row");
  assert.equal(m.contractAInputEvents, 1);
  assert.equal(m.rowsMissingProviderEventContext, 2, "the second evt-1 row and the evt-2 row both lack a valid context");
  assert.equal(m.scoreReadyRows, 1);
  assert.equal(m.naturalRunObserved, true, "presence of any valid providerEventContext proves the fixed writer ran");
});

test("measureProducerOutput: zero identity-complete rows reports naturalRunObserved false, not an error", async () => {
  const rows = [{ diagnostics: { providerEventId: "evt-1" }, score: null }];
  globalThis.fetch = async () => rowsResponse(rows);
  const m = await measureProducerOutput("https://x.example", "key", "generated_signal_pairs", "shadow-strategic-sports-v1");
  assert.equal(m.ok, true);
  assert.equal(m.naturalRunObserved, false);
  assert.equal(m.identityCompleteEvents, 0);
});

test("measureProducerOutput: a non-2xx read is reported as a failed measurement, not fabricated zeros", async () => {
  globalThis.fetch = async () => jsonResponse(503, { code: "PGRST002" });
  const m = await measureProducerOutput("https://x.example", "key", "generated_signal_pairs", "shadow-strategic-sports-v1");
  assert.equal(m.ok, false);
  assert.match(m.reason, /MEASUREMENT_READ_FAILED/);
});

// ── checkpoint idempotency (integration-shaped, exercises the real CLI entrypoint) ────

function withTempRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-checkpoint-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root", "--no-gpg-sign"], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["remote", "add", "origin", dir], { cwd: dir });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", sha], { cwd: dir });
  try {
    return fn(dir, sha);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("checkpoint file records database_waiting on a live outage and is resumable on the next invocation", () => {
  withTempRepo((dir, sha) => {
    const observationId = "unit-test-observation";
    const checkpointFile = path.join(dir, "reports", "observation", `${observationId}.json`);
    const env = { ...process.env };
    delete env.NEXT_PUBLIC_APP_URL;
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;

    const input = JSON.stringify({
      observation_id: observationId,
      repository_root: dir,
      expected_ancestor_sha: sha,
    });
    const out = execFileSync(
      "node",
      [path.join(process.cwd(), "scripts/control-plane/production-observation.mjs"), input],
      { cwd: dir, env, encoding: "utf8" },
    );
    const result = JSON.parse(out);
    assert.equal(result.verdict, "WAIT_INFRASTRUCTURE_RECOVERY", "no DB credentials => treated as unavailable, not blocked");
    assert.equal(result.founder_action, "none");
    assert.equal(result.resume_stage, "database_waiting");

    assert.ok(fs.existsSync(checkpointFile), "checkpoint file must be written");
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
    assert.equal(checkpoint.stage, "database_waiting");
    assert.equal(checkpoint.evidence.ancestor_proven, true, "deployment stage was already completed and is preserved");
    assert.equal(checkpoint.evidence.expected_ancestor_sha, sha);

    const raw = fs.readFileSync(checkpointFile, "utf8");
    assert.doesNotMatch(raw, /SUPABASE_SERVICE_ROLE_KEY/i);
    assert.doesNotMatch(raw, /Bearer /i);

    // Second invocation: deployment ancestry must not be re-derived from scratch — the
    // checkpoint already proves it for this exact expected_ancestor_sha.
    const out2 = execFileSync(
      "node",
      [path.join(process.cwd(), "scripts/control-plane/production-observation.mjs"), input],
      { cwd: dir, env, encoding: "utf8" },
    );
    const result2 = JSON.parse(out2);
    assert.equal(result2.verdict, "WAIT_INFRASTRUCTURE_RECOVERY");
    assert.equal(result2.deployment.expected_ancestor_sha, sha);
  });
});

test("gating fix: a healthy raw DB surface proceeds to measurement even when the app landing-cards route is degraded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-gating-fix-"));
  const savedEnv = { ...process.env };
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root", "--no-gpg-sign"], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" },
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    execFileSync("git", ["remote", "add", "origin", dir], { cwd: dir });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", sha], { cwd: dir });

    process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
    process.env.SUPABASE_URL = "https://db.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-not-a-secret";

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "app.example") {
        // App: always answers with a static-fallback payload (HTTP 200, degraded content).
        return jsonResponse(200, { pairs: [{ id: "static-fallback-0" }] });
      }
      if (url.pathname === "/rest/v1/") {
        return jsonResponse(200, { ok: true });
      }
      // Producer output table: one identity-complete row, healthy DB.
      return jsonResponse(200, [
        {
          diagnostics: {
            providerEventId: "evt-1",
            providerEventContext: {
              v: "v1",
              provider: "polymarket",
              eventId: "evt-1",
              eventStartIso: "2030-01-01T00:00:00.000Z",
            },
          },
          score: null,
        },
      ]);
    };

    const { result, exitCode } = await runObservation({
      observation_id: "unit-test-gating-fix",
      repository_root: dir,
      expected_ancestor_sha: sha,
    });

    assert.equal(exitCode, 0);
    assert.equal(
      result.verdict,
      "PRODUCER_PRODUCTION_EFFECT_PROVEN",
      "a healthy raw DB surface must not be blocked by a degraded corroborative app probe",
    );
    assert.equal(result.app_surface_status, "APP_SURFACE_DEGRADED");
    assert.equal(result.database_read_status, "DATABASE_READ_AVAILABLE");
    assert.equal(result.natural_run_observed, true);
    assert.equal(result.production_persistence_read.identity_complete_events, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = savedEnv;
  }
});

test("checkpoint blocks (does not WAIT) when the expected ancestor is genuinely not in production", () => {
  withTempRepo((dir, sha) => {
    const observationId = "unit-test-bad-ancestor";
    const input = JSON.stringify({
      observation_id: observationId,
      repository_root: dir,
      expected_ancestor_sha: "0000000000000000000000000000000000dead",
    });
    let threw = false;
    try {
      execFileSync(
        "node",
        [path.join(process.cwd(), "scripts/control-plane/production-observation.mjs"), input],
        { cwd: dir, env: process.env, encoding: "utf8" },
      );
    } catch (e) {
      threw = true;
      const out = JSON.parse(e.stdout.toString());
      assert.equal(out.verdict, "PROMPT_GATE_BLOCKED");
      assert.equal(out.reason, "EXPECTED_ANCESTOR_NOT_IN_PRODUCTION");
    }
    assert.equal(threw, true, "a genuinely missing ancestor must exit non-zero, unlike an infra WAIT");
  });
});
