import { NextRequest, NextResponse } from "next/server";
import {
  ensureAndLoadReservations,
  nightReservationEmail,
} from "@/lib/executor/nightEventReservations";

// Autonomous Night Plan email cron (Contur3: rendered from FROZEN reservations).
//   GET /api/cron/night-plan-email?mode=plan   → 17:00 Minsk, freezes plan if needed, sends.
//   GET /api/cron/night-plan-email?mode=alert  → 17:45 Minsk, sends only if no events reserved.
//
// Auth: same x-executor-secret pattern as /api/executor/* (no new scheme, no
// manual-approval token). This is informational/override-only — it NEVER gates
// Ireland's autostart and never enters a "waiting for founder" state.
//
// The email reads night_event_reservations (frozen events), NOT stateless planned slots.

export const dynamic = "force-dynamic";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendEmail(opts: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from,
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

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode") === "alert" ? "alert" : "plan";

  // Fail loudly on missing email env (no silent skip).
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const to = process.env.NIGHT_PLAN_EMAIL_TO ?? "alexgrushin@gmail.com";
  const missing: string[] = [];
  if (!apiKey) missing.push("RESEND_API_KEY");
  if (!from) missing.push("EMAIL_FROM");
  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        mode,
        sent: false,
        reason: `EMAIL_ENV_MISSING: ${missing.join(", ")}`,
        founder_action_required: false,
        founder_action_mode: "override_only",
        email_is_approval_gate: false,
        ireland_autostart_expected: true,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    // mode=plan freezes the reservation plan if it does not exist yet; mode=alert never creates.
    const { planRunId, reservations, created } = await ensureAndLoadReservations(Date.now(), {
      allowCreate: mode === "plan",
    });
    const { subject, text } = nightReservationEmail(planRunId, reservations);
    const shortage = reservations.length === 0;

    // mode=alert only sends when there is a genuine shortage (no events reserved).
    let sent = false;
    let reason: string;
    if (mode === "alert" && !shortage) {
      reason = "ALERT_MODE_NO_SHORTAGE_NO_EMAIL_SENT";
    } else {
      await sendEmail({ apiKey: apiKey!, from: from!, to: to!, subject, text });
      sent = true;
      reason = mode === "alert" ? "SHORTAGE_ALERT_SENT" : "NIGHT_PLAN_SENT";
    }

    return NextResponse.json(
      {
        ok: true,
        mode,
        sent,
        reason,
        plan_run_id: planRunId,
        reserved_count: reservations.length,
        plan_created_this_run: created,
        shortage,
        founder_action_required: false,
        founder_action_mode: "override_only",
        email_is_approval_gate: false,
        ireland_autostart_expected: true,
        source: "night_event_reservations",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[cron/night-plan-email] Error:", msg);
    return NextResponse.json(
      {
        ok: false,
        mode,
        sent: false,
        reason: msg,
        founder_action_required: false,
        ireland_autostart_expected: true,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
