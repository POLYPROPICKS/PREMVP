// scripts/send-night-portfolio-plan.ts
//
// PolyProPicks Night Portfolio Plan email — Contur3 (frozen reservations).
//
// The email is rendered from night_event_reservations (frozen event plan), NOT from
// stateless planned slots. Event-level only; per-event market selection happens later
// at T-60/T-30 rebalance and is exposed to Ireland via /api/executor/queue.
//
// Usage:
//   npm run night:plan                              # dry-run: print reservation email (no send, no write)
//   npm run night:plan:email -- --send --create     # freeze plan if missing, then send
//   tsx scripts/send-night-portfolio-plan.ts --send --email=alexgrushin@gmail.com
//
// Read-only by default. No order placement. Reuses RESEND_API_KEY / EMAIL_FROM transport.

import { loadEnvConfig } from "@next/env";

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey) throw new Error("RESEND_API_KEY missing — set in Railway env");
  if (!from) throw new Error("EMAIL_FROM missing — set in Railway env");

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(
        opts.text
      )}</pre>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function main() {
  loadEnvConfig(process.cwd());

  const doSend = process.argv.includes("--send");
  const allowCreate = process.argv.includes("--create");
  const recipient = argValue("--email=") ?? process.env.NIGHT_PLAN_EMAIL_TO ?? "alexgrushin@gmail.com";

  const { ensureAndLoadReservations, nightReservationEmail } = await import(
    "../lib/executor/nightEventReservations"
  );

  const { planRunId, reservations, created } = await ensureAndLoadReservations(Date.now(), {
    allowCreate,
  });
  const { subject, text } = nightReservationEmail(planRunId, reservations);

  console.log(`Subject: ${subject}`);
  console.log(`plan_run_id: ${planRunId}  reserved=${reservations.length}  created=${created}`);
  console.log("");
  console.log(text);

  if (!doSend) {
    console.log("\n[night-plan] dry-run (no email sent). Pass --send to deliver.");
    if (!allowCreate && reservations.length === 0) {
      console.log("[night-plan] no frozen plan found. Pass --create to freeze it first.");
    }
    return;
  }

  await sendEmail({ to: recipient, subject, text });
  console.log(`\n[night-plan] Email sent to ${recipient}`);
}

main().catch((e) => {
  console.error("[night-plan] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
