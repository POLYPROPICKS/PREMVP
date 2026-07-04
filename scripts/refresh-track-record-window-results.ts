// Track-record window read-model refresh runner.
//
// Default: dry-run (no RPC call, no DB access). Pass --write to invoke the
// `refresh_track_record_window_results` RPC (see
// supabase/migrations/20260704_track_record_window_refresh_rpc.sql) via the
// server-side Supabase admin client.
//
// Usage:
//   npm run refresh:track-record            # dry-run
//   npm run refresh:track-record:write       # write mode (requires founder approval)
//
// Never logs/reports secret values (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// or any other env/token/key) — only whether they are present.

import fs from "node:fs";
import path from "node:path";

export const RPC_NAME = "refresh_track_record_window_results";

export const REPORT_DIR = path.join(process.cwd(), "reports", "track-record-refresh");

export const RPC_MIGRATION_PATH = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260704_track_record_window_refresh_rpc.sql",
);

export const INTENDED_TABLES = [
  "track_record_shown_signal_history",
  "track_record_window_results",
  "track_record_window_summary",
] as const;

export interface ParsedArgs {
  write: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  return { write: argv.includes("--write") };
}

export function buildReportPath(startedAt: Date = new Date()): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return path.join(REPORT_DIR, `refresh-${stamp}.json`);
}

/** Documents the full daily chain — resolver priority pass first, then this
 *  refresh runner in write mode. Read by the runbook and by tests as the
 *  single source of truth for command order. */
export function buildCommandChain(): string[] {
  return [
    "npm run resolve:signals:live-priority",
    "npm run resolve:signals -- --write --priority-track-record-display",
    "npm run refresh:track-record:write",
  ];
}

// Matches KEY=value / KEY: value pairs for common secret-shaped env names, so
// any incidental inclusion in a log/report string gets redacted rather than
// leaked verbatim.
const SENSITIVE_TEXT_PATTERN =
  /\b([A-Z0-9_]*(?:SUPABASE|SERVICE_ROLE|DATABASE_URL|API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*\S+/gi;

export function redactSensitiveText(input: string): string {
  return input.replace(SENSITIVE_TEXT_PATTERN, (_match, key: string) => `${key}=[REDACTED]`);
}

export function checkRpcMigrationDefinesFunction(): { found: boolean; sourcePath: string } {
  const sourcePath = RPC_MIGRATION_PATH;
  if (!fs.existsSync(sourcePath)) return { found: false, sourcePath };
  const text = fs.readFileSync(sourcePath, "utf8");
  const found = new RegExp(`FUNCTION\\s+public\\.${RPC_NAME}`, "i").test(text);
  return { found, sourcePath };
}

export interface RefreshReport {
  startedAt: string;
  finishedAt: string;
  mode: "dry-run" | "write";
  rpcName: string;
  reportPath: string;
  commandChain: string[];
  intendedTables: readonly string[];
  status: "dry-run-ok" | "ok" | "error";
  error?: string;
}

export function buildDryRunReport(startedAt: Date, finishedAt: Date, reportPath: string): RefreshReport {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    mode: "dry-run",
    rpcName: RPC_NAME,
    reportPath,
    commandChain: buildCommandChain(),
    intendedTables: INTENDED_TABLES,
    status: "dry-run-ok",
  };
}

/** Minimal shape of the Supabase client this runner needs — lets tests pass
 *  a mock without depending on the real supabase-js client. */
export interface RpcCapableClient {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function runRefreshWithClient(
  client: RpcCapableClient,
  startedAt: Date,
  reportPath: string,
): Promise<RefreshReport> {
  try {
    const { error } = await client.rpc(RPC_NAME);
    const finishedAt = new Date();
    if (error) {
      return {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        mode: "write",
        rpcName: RPC_NAME,
        reportPath,
        commandChain: buildCommandChain(),
        intendedTables: INTENDED_TABLES,
        status: "error",
        error: redactSensitiveText(error.message),
      };
    }
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      mode: "write",
      rpcName: RPC_NAME,
      reportPath,
      commandChain: buildCommandChain(),
      intendedTables: INTENDED_TABLES,
      status: "ok",
    };
  } catch (err) {
    const finishedAt = new Date();
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      mode: "write",
      rpcName: RPC_NAME,
      reportPath,
      commandChain: buildCommandChain(),
      intendedTables: INTENDED_TABLES,
      status: "error",
      error: redactSensitiveText(err instanceof Error ? err.message : String(err)),
    };
  }
}

function writeReport(report: RefreshReport): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const { write } = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const reportPath = buildReportPath(startedAt);

  if (!write) {
    const report = buildDryRunReport(startedAt, new Date(), reportPath);
    writeReport(report);
    console.log(`[refresh-track-record] dry-run complete, report at ${report.reportPath}`);
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const report: RefreshReport = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      mode: "write",
      rpcName: RPC_NAME,
      reportPath,
      commandChain: buildCommandChain(),
      intendedTables: INTENDED_TABLES,
      status: "error",
      error: "Missing required environment variable(s) for write mode (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).",
    };
    writeReport(report);
    console.error(`[refresh-track-record] write mode aborted — missing env, report at ${report.reportPath}`);
    process.exitCode = 1;
    return;
  }

  const { supabaseAdmin } = await import("../lib/supabase/server");
  const report = await runRefreshWithClient(supabaseAdmin, startedAt, reportPath);
  writeReport(report);
  if (report.status === "error") {
    console.error(`[refresh-track-record] write mode failed, report at ${report.reportPath}`);
    process.exitCode = 1;
  } else {
    console.log(`[refresh-track-record] write mode complete, report at ${report.reportPath}`);
  }
}

// Guard so `tests/signals/*` can import the pure helpers above without
// triggering the CLI entrypoint (main() may read live env vars / hit Supabase).
if (require.main === module) {
  main().catch((err) => {
    console.error("[refresh-track-record] Fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
