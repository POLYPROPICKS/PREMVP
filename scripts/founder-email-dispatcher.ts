import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

type Mode = "auto" | "morning" | "night-plan" | "alert" | "all";

// ---------------------------------------------------------------------------
// Founder-visibility architecture (2026-06-25)
//
// MODE A (producer/materializer) runs heavy bounded jobs ahead of delivery and
// writes reports/morning/latest_founder_status_snapshot.json (see
// scripts/build-founder-status-snapshot.ts / `npm run ops:precompute-founder-status`).
//
// MODE B (this dispatcher / email delivery) MUST NOT silently die when a heavy
// morning-model DB/RPC call times out. It now:
//   1. treats known resolver/model DB-timeout failures as WARN, not fatal;
//   2. on morning-model timeout, builds a DEGRADED report from the lightweight
//      Contur3 status probe + latest snapshot and still delivers it;
//   3. supports --use-latest-snapshot to skip heavy jobs entirely and deliver
//      the precomputed snapshot (the architecture target for the cron path).
//
// Fatal remains: missing recipient/provider in real send, malformed report,
// non-timeout code exceptions, and "missing snapshot AND lightweight probe
// also failed".
// ---------------------------------------------------------------------------

// Substrings that identify a heavy-job DB/RPC timeout (not a logic bug).
// Matched case-insensitively against captured child output.
const TIMEOUT_SIGNATURES = [
  "DB_STRICT_CORPUS_RPC_MISSING",
  "canceling statement due to statement timeout",
  "statement timeout",
  "DB select failed",
  "LIVE_PRIORITY_LEDGER_SUPABASE_QUERY_FAILED",
];

const SNAPSHOT_JSON = path.join(
  process.cwd(),
  "reports",
  "morning",
  "latest_founder_status_snapshot.json",
);

// Freshness thresholds (hours) per founder spec.
const FRESH_OK_HOURS = 2;
const FRESH_WARN_HOURS = 6;

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function hasArg(flag: string): boolean {
  return process.argv.includes(flag);
}

type RunResult = { status: number; output: string };

// Capture combined stdout+stderr (so we can classify timeout vs real failure)
// while still echoing everything to the cron log.
function runCaptured(label: string, command: string, args: string[]): RunResult {
  console.log(`[founder-email] Starting ${label}: ${[command, ...args].join(" ")}`);
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

// Legacy strict runner: throws on any nonzero exit. Used for night-plan/alert
// flows where there is no heavy strict-corpus RPC to degrade around.
function runCommand(label: string, command: string, args: string[]): void {
  const res = runCaptured(label, command, args);
  if (res.status !== 0) {
    throw new Error(`[founder-email] ${label} failed with exit code ${res.status}`);
  }
}

function isTimeoutFailure(output: string): boolean {
  const o = output.toLowerCase();
  return TIMEOUT_SIGNATURES.some((s) => o.includes(s.toLowerCase()));
}

type SnapshotRead = {
  snapshot: Record<string, unknown>;
  ageMs: number;
  ageHours: number;
  freshness: "OK" | "WARN" | "DEGRADED_STALE";
};

function readSnapshot(): SnapshotRead | null {
  try {
    if (!fs.existsSync(SNAPSHOT_JSON)) return null;
    const raw = fs.readFileSync(SNAPSHOT_JSON, "utf8");
    const snapshot = JSON.parse(raw) as Record<string, unknown>;
    const generatedAt = typeof snapshot.generated_at_iso === "string"
      ? Date.parse(snapshot.generated_at_iso)
      : NaN;
    const ageMs = Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
    const ageHours = ageMs / 3_600_000;
    const freshness: SnapshotRead["freshness"] =
      ageHours <= FRESH_OK_HOURS ? "OK" : ageHours <= FRESH_WARN_HOURS ? "WARN" : "DEGRADED_STALE";
    return { snapshot, ageMs, ageHours, freshness };
  } catch (e) {
    console.warn(`[founder-email] snapshot read failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

function renderSnapshotReport(read: SnapshotRead): string {
  const s = read.snapshot;
  const ageStr = Number.isFinite(read.ageHours) ? `${read.ageHours.toFixed(1)}h` : "unknown";
  const lines = [
    `PolyProPicks — Founder Status (snapshot delivery)`,
    `snapshot_freshness:   ${read.freshness} (age ${ageStr})`,
    `snapshot_generated:   ${String(s.generated_at_iso ?? "unknown")}`,
    `stage_verdict:        ${String(s.stage_verdict ?? "unknown")}`,
    ``,
    typeof s.report_md === "string" && s.report_md.trim()
      ? s.report_md
      : `(no embedded report_md; raw snapshot)\n${JSON.stringify(s, null, 2)}`,
  ];
  if (read.freshness === "DEGRADED_STALE") {
    lines.unshift(`DEGRADED_STALE: snapshot older than ${FRESH_WARN_HOURS}h — counts may be outdated.`);
  } else if (read.freshness === "WARN") {
    lines.unshift(`WARN_SNAPSHOT_AGE: snapshot ${FRESH_OK_HOURS}-${FRESH_WARN_HOURS}h old — still usable.`);
  }
  return lines.join("\n");
}

function buildDegradedReport(opts: {
  reason: string;
  warnings: string[];
  probeOutput: string;
  snapshot: SnapshotRead | null;
}): string {
  const lines: string[] = [];
  lines.push(`MORNING_MODEL_TIMEOUT_DEGRADED_REPORT`);
  lines.push(`PolyProPicks — Founder Status (DEGRADED)`);
  lines.push(`reason:               ${opts.reason}`);
  lines.push(`generated_at_iso:     ${new Date().toISOString()}`);
  if (opts.warnings.length) {
    lines.push(`resolver_warnings:    ${opts.warnings.join("; ")}`);
  }
  if (opts.snapshot) {
    lines.push(`latest_snapshot:      ${opts.snapshot.freshness} (age ${opts.snapshot.ageHours.toFixed(1)}h, ${String(opts.snapshot.snapshot.generated_at_iso ?? "unknown")})`);
    lines.push(`snapshot_stage:       ${String(opts.snapshot.snapshot.stage_verdict ?? "unknown")}`);
  } else {
    lines.push(`latest_snapshot:      DEGRADED_NO_SNAPSHOT`);
  }
  lines.push(``);
  lines.push(`--- live Contur3 status probe (contur3:blue-status) ---`);
  // Keep only the human-readable tail of the probe output.
  const probeTail = opts.probeOutput
    .split("\n")
    .filter((l) => /VERDICT|candidate_count|queue|next_due|root_cause|next_operator|errors|BLUE_MODEL/i.test(l))
    .slice(-20)
    .join("\n");
  lines.push(probeTail || opts.probeOutput.slice(-1500));
  lines.push(``);
  lines.push(`NOTE: heavy morning-model strict-corpus report could not run (DB timeout).`);
  lines.push(`This is a degraded but non-silent founder visibility report.`);
  return lines.join("\n");
}

// Real founder email via existing Resend infrastructure (same env vars as
// scripts/morning-model-report.ts). Throws on missing provider config or send
// failure — those remain fatal so a real-send cron does not falsely report ok.
async function sendFounderEmail(recipient: string, subject: string, text: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const missing: string[] = [];
  if (!apiKey) missing.push("RESEND_API_KEY");
  if (!from) missing.push("EMAIL_FROM");
  if (!recipient) missing.push("recipient");
  if (missing.length) {
    throw new Error(`[founder-email] real send failed: missing ${missing.join(", ")}`);
  }
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject,
      text,
      html: `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(text)}</pre>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[founder-email] Resend API ${res.status}: ${body.slice(0, 200)}`);
  }
  console.log(`[founder-email] degraded/snapshot email sent to ${recipient}`);
}

// MODE B fast path: deliver the precomputed snapshot, no heavy jobs.
async function runSnapshotEmail(
  recipient: string,
  opts: { dryRun: boolean; minskDate: string },
): Promise<void> {
  const snap = readSnapshot();
  if (snap) {
    const report = renderSnapshotReport(snap);
    if (opts.dryRun) {
      console.log(report);
      console.log("OPS_EMAIL_DRY_RUN_EXIT=0 (snapshot)");
      return;
    }
    await sendFounderEmail(
      recipient,
      `PolyProPicks founder status ${opts.minskDate} [${snap.freshness}]`,
      report,
    );
    return;
  }

  // DEGRADED_NO_SNAPSHOT: try the lightweight live probe.
  console.warn("DEGRADED_NO_SNAPSHOT: no precomputed snapshot — running lightweight probe.");
  const probe = runCaptured("blue-status-probe", "npm", ["run", "contur3:blue-status"]);
  const probeHasData = /candidate_count|VERDICT/i.test(probe.output);
  if (!probeHasData) {
    // Missing snapshot AND lightweight probe failed → fatal.
    throw new Error("[founder-email] DEGRADED_NO_SNAPSHOT and lightweight probe produced no data");
  }
  const report = buildDegradedReport({
    reason: "no precomputed snapshot available",
    warnings: [],
    probeOutput: probe.output,
    snapshot: null,
  });
  if (opts.dryRun) {
    console.log(report);
    console.log("OPS_EMAIL_DRY_RUN_EXIT=0 (degraded-no-snapshot)");
    return;
  }
  await sendFounderEmail(recipient, `[DEGRADED] PolyProPicks founder status ${opts.minskDate}`, report);
}

// MODE B heavy path, now degrade-safe.
async function runTrustedMorning(
  recipient: string,
  opts: { dryRun: boolean; minskDate: string },
): Promise<void> {
  const warnings: string[] = [];

  // Resolver steps: a DB statement timeout here must NOT block founder email.
  for (const [label, script] of [
    ["resolver-live-priority", "resolve:signals:live-priority"],
    ["resolver-cron", "resolve:signals:cron"],
    ["resolver-verify", "verify:resolver-pipeline"],
  ] as const) {
    const r = runCaptured(label, "npm", ["run", script]);
    if (r.status !== 0) {
      if (isTimeoutFailure(r.output)) {
        warnings.push(`${label}:DB_TIMEOUT_WARN`);
        console.warn(`[founder-email] ${label} hit DB timeout — treated as WARN, continuing.`);
        continue;
      }
      throw new Error(`[founder-email] ${label} failed (non-timeout) exit=${r.status}`);
    }
  }

  // Heavy strict-corpus morning model.
  const mm = runCaptured("morning-model", "npm", [
    "run",
    "morning:model-report",
    "--",
    opts.dryRun ? "--dry-run" : "--send-test",
    `--email=${recipient}`,
  ]);

  if (mm.status === 0) {
    console.log("MORNING_MODEL_OK");
    if (warnings.length) console.log(`MORNING_MODEL_OK_WITH_WARNINGS: ${warnings.join("; ")}`);
    return;
  }

  if (!isTimeoutFailure(mm.output)) {
    // Genuine logic/code error stays fatal.
    throw new Error(`[founder-email] morning-model failed (non-timeout) exit=${mm.status}`);
  }

  // DEGRADED: heavy model timed out — never go silent.
  console.warn("[founder-email] morning-model DB/RPC timeout — building degraded report.");
  const probe = runCaptured("blue-status-probe", "npm", ["run", "contur3:blue-status"]);
  const report = buildDegradedReport({
    reason: "morning-model strict-corpus DB/RPC timeout",
    warnings,
    probeOutput: probe.output,
    snapshot: readSnapshot(),
  });

  if (opts.dryRun) {
    console.log(report);
    console.log("OPS_EMAIL_DRY_RUN_EXIT=0 (degraded)");
    return;
  }
  await sendFounderEmail(
    recipient,
    `[DEGRADED] PolyProPicks founder status ${opts.minskDate}`,
    report,
  );
}

function minskNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Minsk",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return { date, minutes };
}

function inWindow(minutes: number, start: number, end: number): boolean {
  return minutes >= start && minutes <= end;
}

async function main() {
  loadEnvConfig(process.cwd());

  // Default must be morning-safe for Railway cron jobs. Night plan and alert
  // flows require explicit modes so a 09:00 report cannot be masked by a
  // 17:00/17:45 battle email.
  const modeArg = (argValue("--mode=") ?? "morning") as Mode;
  const allowed: Mode[] = ["auto", "morning", "night-plan", "alert", "all"];
  if (!allowed.includes(modeArg)) {
    throw new Error(`[founder-email] Invalid --mode=${modeArg}`);
  }

  const recipient = argValue("--email=") ?? process.env.FOUNDER_EMAIL_TO ?? process.env.MORNING_MODEL_EMAIL_TO ?? process.env.NIGHT_PLAN_EMAIL_TO ?? "alexgrushin@gmail.com";
  const dryRun = hasArg("--dry-run");
  // Architecture target for the cron path: deliver the precomputed snapshot
  // instead of running heavy jobs synchronously.
  const useSnapshot = hasArg("--use-latest-snapshot");
  const { date: minskDate, minutes: minskMinutes } = minskNow();
  const summary = { mode: modeArg, minskDate, minskMinutes, recipient, dryRun, useSnapshot };
  console.log(JSON.stringify(summary, null, 2));

  if (modeArg === "auto") {
    if (inWindow(minskMinutes, 8 * 60 + 55, 9 * 60 + 10)) {
      if (useSnapshot) await runSnapshotEmail(recipient, { dryRun, minskDate });
      else await runTrustedMorning(recipient, { dryRun, minskDate });
      return;
    }
    if (inWindow(minskMinutes, 16 * 60 + 55, 17 * 60 + 10)) {
      runCommand("night-plan", "npm", ["run", "night:plan:email", "--", `--email=${recipient}`]);
      return;
    }
    if (inWindow(minskMinutes, 17 * 60 + 40, 17 * 60 + 55)) {
      runCommand("alert", "npm", ["run", "night:plan:email", "--", "--alert-only", `--email=${recipient}`]);
      return;
    }
    console.log("NO_EMAIL_DUE");
    return;
  }

  if (modeArg === "morning") {
    if (useSnapshot) await runSnapshotEmail(recipient, { dryRun, minskDate });
    else await runTrustedMorning(recipient, { dryRun, minskDate });
    return;
  }
  if (modeArg === "night-plan") {
    runCommand("night-plan", "npm", ["run", "night:plan:email", "--", `--email=${recipient}`]);
    return;
  }
  if (modeArg === "alert") {
    runCommand("alert", "npm", ["run", "night:plan:email", "--", "--alert-only", `--email=${recipient}`]);
    return;
  }

  if (useSnapshot) await runSnapshotEmail(recipient, { dryRun, minskDate });
  else await runTrustedMorning(recipient, { dryRun, minskDate });
  runCommand("night-plan", "npm", ["run", "night:plan:email", "--", `--email=${recipient}`]);
  runCommand("alert", "npm", ["run", "night:plan:email", "--", "--alert-only", `--email=${recipient}`]);
}

main().catch((e) => {
  console.error("[founder-email] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
