import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// MODE A — producer / materializer (`npm run ops:precompute-founder-status`)
//
// Runs the bounded, timeout-safe lightweight Contur3 status probe AHEAD of
// founder email delivery and writes a snapshot the dispatcher can deliver in
// MODE B without re-running any heavy strict-corpus DB/RPC work.
//
// Outputs:
//   reports/morning/latest_founder_status_snapshot.json
//   reports/morning/latest_founder_status_snapshot.md
//
// Exit 0 if a snapshot was produced (even degraded). Exit nonzero only if no
// snapshot could be written at all.
//
// This script does NOT send email and does NOT run the heavy morning model.
// ---------------------------------------------------------------------------

const REPORT_DIR = path.join(process.cwd(), "reports", "morning");
const SNAPSHOT_JSON = path.join(REPORT_DIR, "latest_founder_status_snapshot.json");
const SNAPSHOT_MD = path.join(REPORT_DIR, "latest_founder_status_snapshot.md");
const BLUE_LOG_DIR = path.join(process.cwd(), "modeling", "fire_runs", "contur3-blue-model");

function runCaptured(label: string, command: string, args: string[]): { status: number; output: string } {
  console.log(`[founder-snapshot] ${label}: ${[command, ...args].join(" ")}`);
  const res = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (output.trim()) process.stdout.write(output.endsWith("\n") ? output : output + "\n");
  return { status: res.status ?? 1, output };
}

// Pick the newest *_blue_model_status.json the probe just wrote.
function latestBlueStatusReport(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(BLUE_LOG_DIR)) return null;
    const files = fs
      .readdirSync(BLUE_LOG_DIR)
      .filter((f) => f.endsWith("_blue_model_status.json"))
      .map((f) => path.join(BLUE_LOG_DIR, f))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(files[0].p, "utf8")) as Record<string, unknown>;
  } catch (e) {
    console.warn(`[founder-snapshot] could not read blue-status report: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// Best-effort: timestamp of the most recent fire model run directory, so we can
// report model KPI freshness without running the heavy fire report.
function latestFireRunTimestamp(): string | null {
  try {
    const dir = path.join(process.cwd(), "modeling", "fire_runs");
    if (!fs.existsSync(dir)) return null;
    const entries = fs
      .readdirSync(dir)
      .map((f) => path.join(dir, f))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!entries.length) return null;
    return new Date(entries[0].mtime).toISOString();
  } catch {
    return null;
  }
}

function num(obj: unknown, ...keys: string[]): number | null {
  if (obj && typeof obj === "object") {
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === "number") return v;
    }
  }
  return null;
}

async function main() {
  loadEnvConfig(process.cwd());
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  // Lightweight, bounded, timeout-safe live probe. Non-fatal: BLUE_MODEL_NO_GO
  // exits 1 but still yields data we want to capture.
  const probe = runCaptured("blue-status", "npm", ["run", "contur3:blue-status"]);
  const blue = latestBlueStatusReport();
  const fireTs = latestFireRunTimestamp();

  const blueVerdict = (blue && typeof blue.verdict === "string" ? blue.verdict : null) ?? "UNKNOWN";
  const queue = (blue?.queue as Record<string, unknown> | undefined) ?? {};
  const rebalance = (blue?.rebalance_dry_run as Record<string, unknown> | undefined) ?? {};

  const candidateCount = num(queue, "candidate_count");
  const queueSource = (queue.source as string | null) ?? null;
  const nextDueIso = (blue?.next_due_iso as string | null) ?? null;
  const futureReservations = num(rebalance, "future_valid_reservations_count");
  const expiredCount = num(rebalance, "expired_count");

  const probeProducedData = blue !== null || /candidate_count|VERDICT/i.test(probe.output);

  // Stage verdict for the founder, derived only from the lightweight probe.
  const stageVerdict = !probeProducedData
    ? "UNKNOWN_PROBE_FAILED"
    : blueVerdict === "BLUE_MODEL_GO_READY"
      ? "ORDER_QUEUE_READY"
      : (candidateCount ?? 0) > 0
        ? "QUEUE_PRESENT"
        : (futureReservations ?? 0) > 0 || nextDueIso
          ? "RESERVATIONS_PRESENT_NO_QUEUE"
          : "NOT_READY_NO_RESERVATIONS";

  const modelKpiStatus = fireTs ? `STALE_OR_UNKNOWN (latest fire artifact ${fireTs})` : "MODEL_KPI_SOURCE_MISSING";

  const generatedAtIso = new Date().toISOString();

  const reportMdLines = [
    `# PolyProPicks — Founder Status Snapshot`,
    ``,
    `- generated_at: ${generatedAtIso}`,
    `- stage_verdict: **${stageVerdict}**`,
    `- blue_model_verdict: ${blueVerdict}`,
    ``,
    `## Contur3 readiness (live probe)`,
    `| item | value |`,
    `| --- | --- |`,
    `| queue source | ${queueSource ?? "null"} |`,
    `| candidate_count | ${candidateCount ?? "unknown"} |`,
    `| next_due_iso | ${nextDueIso ?? "none"} |`,
    `| future_valid_reservations | ${futureReservations ?? "unknown"} |`,
    `| expired_reservations | ${expiredCount ?? "unknown"} |`,
    ``,
    `## Model / KPI freshness`,
    `- ${modelKpiStatus}`,
    ``,
    `## Notes`,
    `- Snapshot built by MODE A producer (bounded lightweight probe only).`,
    `- Heavy morning-model strict-corpus report intentionally NOT run here.`,
    probeProducedData ? `- live probe: OK` : `- live probe: DEGRADED (no data — check EXECUTOR_CANDIDATES_SECRET / API)`,
  ];
  const reportMd = reportMdLines.join("\n");

  const snapshot = {
    generated_at_iso: generatedAtIso,
    producer: "build-founder-status-snapshot",
    stage_verdict: stageVerdict,
    blue_model_verdict: blueVerdict,
    contur3: {
      queue_source: queueSource,
      candidate_count: candidateCount,
      next_due_iso: nextDueIso,
      future_valid_reservations_count: futureReservations,
      expired_count: expiredCount,
    },
    model_kpi_status: modelKpiStatus,
    latest_fire_run_iso: fireTs,
    resolver: {
      // Resolver freshness is owned by the resolver job's job_runs / verify
      // step; recorded here as last-known-unknown to avoid heavy DB scans.
      status: "LAST_KNOWN_UNKNOWN_FROM_LIGHTWEIGHT_SNAPSHOT",
    },
    probe_ok: probeProducedData,
    source_commands: ["npm run contur3:blue-status"],
    report_md: reportMd,
  };

  fs.writeFileSync(SNAPSHOT_JSON, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(SNAPSHOT_MD, reportMd + "\n");

  console.log("");
  console.log(`FOUNDER_STATUS_SNAPSHOT_WRITTEN`);
  console.log(`json: ${SNAPSHOT_JSON}`);
  console.log(`md:   ${SNAPSHOT_MD}`);
  console.log(`stage_verdict: ${stageVerdict}`);
  console.log(`probe_ok: ${probeProducedData}`);

  // Exit 0 as long as a snapshot was produced (even degraded). The dispatcher
  // applies freshness rules at delivery time.
  process.exitCode = 0;
}

main().catch((e) => {
  console.error("[founder-snapshot] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
