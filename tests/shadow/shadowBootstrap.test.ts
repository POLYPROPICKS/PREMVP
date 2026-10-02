// Repo-owned shadow DB bootstrap. Plan tests are pure. The DB test needs a DISPOSABLE local Postgres:
//   SHADOW_TEST_ADMIN_URL=postgresql://postgres@localhost:54329/postgres?host=/tmp  npm run test:shadow
// (it CREATEs and DROPs its own scratch database; it is skipped, loudly, when the variable is absent).
// Never point it at a real project.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { buildPlan } from "../../scripts/shadow/shadow-bootstrap.mjs";
import { buildGeneratedSignalPairRows } from "../../lib/feed/cacheGeneratedSignals";
import { runShadowJob, SHADOW_JOBS } from "../../scripts/shadow/shadow-cycle.mjs";

const ROOT = path.resolve(__dirname, "../..");

test("plan: baseline first, every non-excluded migration present, current-main migrations included", () => {
  const plan = buildPlan().map((f: { name: string }) => f.name);
  assert.equal(plan[0], "shadow/000_prehistory_baseline.sql");
  assert.ok(plan.includes("migrations/20261002090000_reservation_capture_run_discovery_audit_v1.sql"));
  const excl = Object.keys(JSON.parse(readFileSync(path.join(ROOT, "supabase/shadow/exclusions.json"), "utf8")).exclusions);
  const all = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
  assert.equal(plan.length, 1 + all.length - excl.length);
  assert.deepEqual([...plan.slice(1)], [...plan.slice(1)].sort());
});

test("plan: no secrets, no operational rows (schema-only SQL)", () => {
  for (const f of buildPlan() as { path: string; name: string }[]) {
    if (!f.name.startsWith("shadow/")) continue;
    assert.doesNotMatch(readFileSync(f.path, "utf8"), /\bINSERT\s+INTO\b|\bCOPY\b/i, f.name);
  }
});

test("inventory: producer row builder columns are all declared in the baseline inventory", () => {
  const inv = JSON.parse(readFileSync(path.join(ROOT, "supabase/shadow/required-schema.json"), "utf8"));
  const row = buildGeneratedSignalPairRows({
    pairs: [{ premiumSignal: { metrics: [] } as never, marketSource: { headline: "h" } as never, diagnostics: {} as never }],
    source: "s", formulaVersion: "v", expiresAt: new Date().toISOString(),
  })[0];
  const missing = Object.keys(row).filter((k) => !inv.columns.generated_signal_pairs.includes(k));
  assert.deepEqual(missing, []);
});

test("shadow cycle runner: only SHADOW_* names, refuses DEV ambient, hits only the shadow base URL", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(`${url}|${init.headers["x-executor-secret"]}`);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const env: Record<string, string | undefined> = { SHADOW_BASE_URL: "https://shadow.invalid", SHADOW_EXECUTOR_CANDIDATES_SECRET: "sh" };
  assert.deepEqual(await runShadowJob("reservations", { env: env, fetchImpl }), { exitCode: 0, status: 200 });
  assert.deepEqual(calls, [`https://shadow.invalid${SHADOW_JOBS.reservations}|sh`]);
  const refused = await runShadowJob("rebalance", { env: { ...env, EXECUTOR_CANDIDATES_SECRET: "dev" }, fetchImpl });
  assert.match(String(refused.reason), /AMBIENT_FOREIGN_BINDING_PRESENT/);
  assert.equal(calls.length, 1);
});

const ADMIN = process.env.SHADOW_TEST_ADMIN_URL;
test("EMPTY DB -> bootstrap -> verify -> second apply is a no-op -> shadow signal reaches serving",
  { skip: ADMIN ? false : "SHADOW_TEST_ADMIN_URL not set (needs a disposable local Postgres)" },
  () => {
    const db = `shadow_bootstrap_${process.pid}`;
    const admin = ADMIN as string;
    const url = admin.replace(/\/postgres(\?|$)/, `/${db}$1`);
    const run = (u: string, args: string[]) => spawnSync("psql", [u, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
    const node = (args: string[]) => spawnSync("node", ["scripts/shadow/shadow-bootstrap.mjs", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SHADOW_DATABASE_URL: url } });
    assert.equal(run(admin, ["-c", `CREATE DATABASE ${db}`]).status, 0);
    try {
      // A non-empty, ledger-less target (e.g. a DEV-like database) must be refused before any DDL.
      assert.equal(run(url, ["-c", "CREATE TABLE public.preexisting_marker (x int)"]).status, 0);
      const refused = node(["--apply"]);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /not an empty shadow database/);
      assert.equal(run(url, ["-c", "DROP TABLE public.preexisting_marker"]).status, 0);
      const first = node(["--apply", "--verify"]);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /"applied":\d+,"skipped":0/);
      const second = node(["--apply", "--verify"]);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /"applied":0,"skipped":\d+/);

      // Contract parity: the verifier must CATCH drift in the reconstructed pre-history tables.
      assert.equal(run(url, ["-c", "ALTER TABLE job_runs ADD COLUMN created_at timestamptz", "-c", "ALTER TABLE contract_a_rejection_evidence ALTER COLUMN stage SET NOT NULL", "-c", "ALTER TABLE contract_a_rejection_evidence ALTER COLUMN source_created_at TYPE timestamptz USING NULL"]).status, 0);
      const drift = node(["--verify"]);
      assert.notEqual(drift.status, 0);
      assert.match(drift.stderr, /SHADOW_SCHEMA_DRIFT.*stage:notNull.*source_created_at:type.*job_runs\.created_at:must not exist/);
      assert.equal(run(url, ["-c", "ALTER TABLE job_runs DROP COLUMN created_at", "-c", "ALTER TABLE contract_a_rejection_evidence ALTER COLUMN stage DROP NOT NULL", "-c", "ALTER TABLE contract_a_rejection_evidence ALTER COLUMN source_created_at TYPE text"]).status, 0);
      assert.equal(node(["--verify"]).status, 0);

      // Own shadow signal -> GSP -> serving projection (real SQL), starting from zero rows.
      const rows = run(url, ["-c", "SELECT count(*) FROM generated_signal_pairs"]).stdout.trim();
      assert.equal(rows, "0");
      const ins = run(url, ["-c", `INSERT INTO generated_signal_pairs (metric_formula_version, condition_id, selected_token_id, selected_outcome, premium_signal, market_source)
        VALUES ('shadow-strategic-sports-v1','c1','t1','Yes','{}'::jsonb,'{}'::jsonb) RETURNING id`]);
      assert.equal(ins.status, 0, ins.stderr);
      const id = ins.stdout.trim().split("\n")[0];
      const refresh = run(url, ["-c", `SELECT refresh_current_signal_pair_serving(ARRAY['${id}']::uuid[])`]);
      assert.equal(refresh.status, 0, refresh.stderr);
      assert.equal(run(url, ["-c", "SELECT count(*) FROM current_signal_pair_serving WHERE condition_id='c1'"]).stdout.trim(), "1");
    } finally {
      run(admin, ["-c", `DROP DATABASE IF EXISTS ${db}`]);
    }
  });
