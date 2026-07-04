import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parseArgs,
  buildReportPath,
  buildCommandChain,
  redactSensitiveText,
  buildDryRunReport,
  runRefreshWithClient,
  checkRpcMigrationDefinesFunction,
  RPC_NAME,
  REPORT_DIR,
  type RpcCapableClient,
} from "../../scripts/refresh-track-record-window-results";

// ── dry-run is the default; RPC is never invoked without --write ────────────

test("parseArgs: defaults to dry-run (write=false) with no flags", () => {
  assert.equal(parseArgs([]).write, false);
});

test("parseArgs: --write flag enables write mode", () => {
  assert.equal(parseArgs(["--write"]).write, true);
});

test("buildDryRunReport: mode is dry-run and never references a live RPC call", () => {
  const startedAt = new Date("2026-07-04T06:00:00.000Z");
  const finishedAt = new Date("2026-07-04T06:00:01.000Z");
  const reportPath = buildReportPath(startedAt);
  const report = buildDryRunReport(startedAt, finishedAt, reportPath);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.status, "dry-run-ok");
  assert.equal(report.rpcName, RPC_NAME);
});

test("runRefreshWithClient: calls RPC only when explicitly invoked with a client (write path)", async () => {
  let rpcCalls = 0;
  const client: RpcCapableClient = {
    rpc: async (fn: string) => {
      rpcCalls += 1;
      assert.equal(fn, RPC_NAME);
      return { data: { status: "ok" }, error: null };
    },
  };
  const startedAt = new Date("2026-07-04T06:00:00.000Z");
  const reportPath = buildReportPath(startedAt);
  const report = await runRefreshWithClient(client, startedAt, reportPath);
  assert.equal(rpcCalls, 1);
  assert.equal(report.mode, "write");
  assert.equal(report.status, "ok");
  assert.equal(report.rpcName, RPC_NAME);
});

test("runRefreshWithClient: RPC error is captured and redacted, never thrown raw", async () => {
  const client: RpcCapableClient = {
    rpc: async () => ({ data: null, error: { message: "SUPABASE_SERVICE_ROLE_KEY=abc123 rejected" } }),
  };
  const startedAt = new Date();
  const reportPath = buildReportPath(startedAt);
  const report = await runRefreshWithClient(client, startedAt, reportPath);
  assert.equal(report.status, "error");
  assert.ok(report.error);
  assert.ok(!report.error!.includes("abc123"));
  assert.ok(report.error!.includes("[REDACTED]"));
});

// ── report path ───────────────────────────────────────────────────────────

test("buildReportPath: lives under reports/track-record-refresh/", () => {
  const reportPath = buildReportPath(new Date("2026-07-04T06:00:00.000Z"));
  assert.ok(reportPath.startsWith(REPORT_DIR));
  assert.ok(REPORT_DIR.endsWith(path.join("reports", "track-record-refresh")));
});

// ── secret redaction ──────────────────────────────────────────────────────

test("redactSensitiveText: removes SUPABASE_URL/SERVICE_ROLE_KEY-shaped values", () => {
  const input = "SUPABASE_URL=https://example.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJ.secret.value";
  const redacted = redactSensitiveText(input);
  assert.ok(!redacted.includes("https://example.supabase.co"));
  assert.ok(!redacted.includes("eyJ.secret.value"));
  assert.ok(redacted.includes("SUPABASE_URL=[REDACTED]"));
  assert.ok(redacted.includes("SUPABASE_SERVICE_ROLE_KEY=[REDACTED]"));
});

test("redactSensitiveText: leaves non-secret text untouched", () => {
  const input = "refresh completed for window_days 7 and 14";
  assert.equal(redactSensitiveText(input), input);
});

// ── RPC migration references the wrapped refresh SQL ─────────────────────

test("RPC migration file exists and defines the refresh_track_record_window_results function", () => {
  const result = checkRpcMigrationDefinesFunction();
  assert.ok(result.found, `expected ${result.sourcePath} to define public.${RPC_NAME}`);
});

// ── package.json wiring ───────────────────────────────────────────────────

test("package.json declares refresh:track-record, refresh:track-record:write, track-record:daily:write", () => {
  const pkgPath = path.join(__dirname, "../../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.ok(pkg.scripts["refresh:track-record"]);
  assert.ok(pkg.scripts["refresh:track-record:write"]);
  assert.ok(pkg.scripts["track-record:daily:write"]);
});

test("buildCommandChain: resolver priority pass runs before the write refresh", () => {
  const chain = buildCommandChain();
  const resolverIdx = chain.findIndex((c) => c.includes("--priority-track-record-display"));
  const refreshIdx = chain.findIndex((c) => c.includes("refresh:track-record:write"));
  assert.ok(resolverIdx >= 0 && refreshIdx >= 0);
  assert.ok(resolverIdx < refreshIdx);
});

// ── runbook documents the full chain ─────────────────────────────────────

test("runbook documents the full data-flow chain from display signals to WhyTrustSection", () => {
  const runbookPath = path.join(__dirname, "../../docs/operations/TRACK_RECORD_REFRESH_RUNBOOK.md");
  const runbook = fs.readFileSync(runbookPath, "utf8");
  assert.ok(runbook.includes("track_record_display_signals"));
  assert.ok(runbook.includes("--priority-track-record-display"));
  assert.ok(runbook.includes("refresh_track_record_window_results"));
  assert.ok(runbook.includes("track_record_window_results"));
  assert.ok(runbook.includes("track_record_window_summary"));
  assert.ok(runbook.includes("/api/signals/resolved"));
  assert.ok(runbook.includes("WhyTrustSection"));
});
