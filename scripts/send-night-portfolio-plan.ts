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

// ── Args ────────────────────────────────────────────────────────────────────

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

const EMAIL_RECIPIENT = argValue("--email=");
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

async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
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
  const { buildNightPortfolioPlan, nightPlanEmailSubject, nightPlanEmailText } = await import(
    "../lib/executor/nightPortfolioPlanner"
  );

  const { candidates: universe } = await buildFireModelCandidates(200, "all", true);
  const plan = buildNightPortfolioPlan(universe, { nowMs: Date.now() });

  const text = nightPlanEmailText(plan, PLAN_TIME);

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
    html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(
      text
    )}</pre>`,
  });
  console.log(`[night-plan] Email sent to ${EMAIL_RECIPIENT} — subject: ${subject}`);
}

main().catch((e) => {
  console.error("[night-plan] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
