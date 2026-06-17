// scripts/send-night-portfolio-plan.ts
//
// PolyProPicks Night Portfolio Plan email.
// Sends the 18:00–07:00 Europe/Minsk night plan to the founder before the live
// window opens (~17:00 Minsk), and an optional second low-supply alert (~17:45).
//
// Usage:
//   npm run night:plan                         # print plan to stdout (no email)
//   npm run night:plan:email                   # send full plan email
//   tsx scripts/send-night-portfolio-plan.ts --email=alexgrushin@gmail.com
//   tsx scripts/send-night-portfolio-plan.ts --email=... --alert-only --plan-time=17:45
//
// Read-only. No DB writes. No order placement.
// Reuses the same Resend transport (RESEND_API_KEY / EMAIL_FROM) as daily-ops-report.ts.

import { loadEnvConfig } from "@next/env";
import path from "path";
import { writeWorkbookXlsx } from "./report-xlsx";

// ── Args ────────────────────────────────────────────────────────────────────

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

const EMAIL_RECIPIENT = argValue("--email=") ?? process.env.NIGHT_PLAN_EMAIL_TO ?? "alexgrushin@gmail.com";
const ALERT_ONLY = process.argv.includes("--alert-only");
const PLAN_TIME = argValue("--plan-time=") ?? "17:00";

// ── Email helpers (mirrors daily-ops-report.ts transport) ─────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function markdownTable(headers: string[], rows: Array<(string | number | null)[]>): string {
  const render = (v: string | number | null) => String(v ?? "").replace(/\n/g, " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(render).join(" | ")} |`),
  ].join("\n");
}

function buildReadableNightPlanText(plan: import("../lib/executor/nightPortfolioPlanner").NightPortfolioPlan, planTimeLabel: string): string {
  const summaryHeaders = [
    "Plan status",
    "Starting bankroll",
    "Target range",
    "Tier1 slots",
    "Tier2 fallback slots",
    "Planned LIVE slots",
    "Paper-only slots",
    "Unsafe rejected",
    "Slot shortage",
  ];
  const summaryRows = [[
    plan.plan_status,
    `$${plan.starting_bankroll_usd}`,
    `${plan.target_min_bets}–${plan.target_max_bets}`,
    plan.tier1_event_slots,
    plan.tier2_fallback_slots,
    plan.planned_live_slots,
    plan.paper_only_slots,
    plan.unsafe_rejected_count,
    plan.slot_shortage_count,
  ]];

  const plannedEventHeaders = ["#", "Tier", "Event / Market", "Stake", "Timing", "Reason"];
  const plannedEventRows = plan.planned_slots.slice(0, 10).map((slot, idx) => [
    idx + 1,
    slot.tier,
    `${slot.event_title}${slot.event_slug ? ` (${slot.event_slug})` : ""}`,
    `$${slot.planned_stake_usd.toFixed(2)}`,
    `${slot.timing_bucket}${slot.preferred_entry_iso ? ` | ${slot.preferred_entry_iso}` : ""}`,
    slot.stake_reason,
  ]);
  const rejectedHeaders = ["Reason", "Count"];
  const rejectedRows = Object.entries(plan.top_rejected_reasons).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const lines: string[] = [];
  lines.push(`PolyProPicks Night Portfolio Plan (${planTimeLabel} Minsk)`);
  lines.push(`Window: ${plan.window_start_iso} -> ${plan.window_end_iso} (Europe/Minsk)`);
  lines.push(`Planned at: ${plan.planned_at_iso}`);
  lines.push("");
  lines.push("CONTROL MODEL: Ireland AUTO-STARTS at 18:00 Minsk. This email is informational +");
  lines.push("emergency-override only - NO approval required. Manually STOP Ireland only if you");
  lines.push("dislike the plan below.");
  lines.push("");
  lines.push(markdownTable(summaryHeaders, summaryRows));
  lines.push("");
  if (plan.second_alert_required) {
    lines.push("WARNING: safe supply low. Second alert will be sent at 17:45 Minsk unless plan improves.");
    lines.push("Recommended override: STOP_IRELAND_IF_UNCOMFORTABLE.");
    lines.push("");
  }
  lines.push("Top planned events:");
  lines.push(markdownTable(plannedEventHeaders, plannedEventRows.length ? plannedEventRows : [["NO_PLANNED_EVENTS", "", "", "", "", ""]]));
  if (plan.planned_slots.length > plannedEventRows.length) {
    lines.push("");
    lines.push(`... plus ${plan.planned_slots.length - plannedEventRows.length} more planned slots in the attached workbook.`);
  }
  lines.push("");
  lines.push("Rejected reasons:");
  lines.push(markdownTable(rejectedHeaders, rejectedRows.length ? rejectedRows : [["NO_REJECTED_REASONS", 0]]));
  lines.push("");
  lines.push(`Second alert required (17:45 Minsk): ${plan.second_alert_required ? "YES" : "no"}`);
  return lines.join("\n");
}

async function buildNightPlanWorkbook(
  outputPath: string,
  plan: import("../lib/executor/nightPortfolioPlanner").NightPortfolioPlan,
  planTimeLabel: string,
): Promise<void> {
  const summaryRows = [
    { "Plan status": plan.plan_status, "Starting bankroll": `$${plan.starting_bankroll_usd}`, "Target range": `${plan.target_min_bets}–${plan.target_max_bets}`, "Tier1 slots": plan.tier1_event_slots, "Tier2 fallback slots": plan.tier2_fallback_slots, "Planned LIVE slots": plan.planned_live_slots, "Paper-only slots": plan.paper_only_slots, "Unsafe rejected": plan.unsafe_rejected_count, "Slot shortage": plan.slot_shortage_count, "Planned at": plan.planned_at_iso, "Plan time": planTimeLabel },
  ];
  const plannedEventRows = plan.planned_slots.map((slot, idx) => ({
    "#": idx + 1,
    Tier: slot.tier,
    "Event / Market": `${slot.event_title}${slot.event_slug ? ` (${slot.event_slug})` : ""}`,
    Stake: `$${slot.planned_stake_usd.toFixed(2)}`,
    Timing: `${slot.timing_bucket}${slot.preferred_entry_iso ? ` | ${slot.preferred_entry_iso}` : ""}`,
    Reason: slot.stake_reason,
  }));
  const rejectedRows = Object.entries(plan.top_rejected_reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ Reason: reason, Count: count }));

  await writeWorkbookXlsx(outputPath, [
    {
      name: "00_Plan Summary",
      headers: ["Plan status", "Starting bankroll", "Target range", "Tier1 slots", "Tier2 fallback slots", "Planned LIVE slots", "Paper-only slots", "Unsafe rejected", "Slot shortage", "Planned at", "Plan time"],
      rows: summaryRows,
    },
    {
      name: "01_Planned Events",
      headers: ["#", "Tier", "Event / Market", "Stake", "Timing", "Reason"],
      rows: plannedEventRows,
    },
    {
      name: "02_Rejected Reasons",
      headers: ["Reason", "Count"],
      rows: rejectedRows,
    },
  ]);
}

async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{ filename: string; content: string }>;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey) throw new Error("RESEND_API_KEY missing — set in Railway env");
  if (!from) throw new Error("EMAIL_FROM missing — set in Railway env");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      attachments: opts.attachments,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  loadEnvConfig(process.cwd());

  // Dynamic import after env load (planner pulls in supabaseAdmin transitively).
  const { buildFireModelCandidates } = await import("../lib/executor/buildFireModelCandidates");
  const { buildNightPortfolioPlan, nightPlanEmailSubject } = await import(
    "../lib/executor/nightPortfolioPlanner"
  );

  const { candidates: universe } = await buildFireModelCandidates(200, "all", true);
  const plan = buildNightPortfolioPlan(universe, { nowMs: Date.now() });
  const text = buildReadableNightPlanText(plan, PLAN_TIME);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const workbookPath = path.resolve(
    process.cwd(),
    "modeling",
    "night_plan_email",
    stamp,
    `polypropicks_night_plan_${stamp}.xlsx`,
  );
  await buildNightPlanWorkbook(workbookPath, plan, PLAN_TIME);

  // --alert-only: only send if a second alert is genuinely required.
  if (ALERT_ONLY && !plan.second_alert_required) {
    console.log("[night-plan] --alert-only: supply healthy, no second alert sent.");
    console.log(text);
    return;
  }

  const subject = nightPlanEmailSubject(plan);

  if (!EMAIL_RECIPIENT) {
    console.log(`Subject: ${subject}\n`);
    console.log(text);
    console.log("\n[night-plan] No --email= provided; printed to stdout only.");
    return;
  }

  await sendEmail({
    to: EMAIL_RECIPIENT,
    subject,
    text,
    html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(text)}</pre>`,
    attachments: [
      {
        filename: path.basename(workbookPath),
        content: (await (await import("fs/promises")).readFile(workbookPath)).toString("base64"),
      },
    ],
  });
  console.log(`[night-plan] Email sent to ${EMAIL_RECIPIENT} — subject: ${subject}`);
}

main().catch((e) => {
  console.error("[night-plan] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
