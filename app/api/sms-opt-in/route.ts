// POST /api/sms-opt-in
// Secure server-side SMS consent capture for PolyProPicks alerts opt-in.
// Inserts one append-only record into public.sms_consent_events via service-role.
// No public anon insert policy needed or added.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const DISCLOSURE_VERSION = "sms-alerts-v1-2026-06-01";
const CONSENT_SOURCE = "alerts_web_form";
const DISCLOSURE_TEXT =
  "I agree to receive recurring automated informational and promotional text messages from PolyProPicks. Consent is not a condition of purchase. Message frequency may vary, up to 2 messages per week. Message and data rates may apply. Reply STOP to unsubscribe. Reply HELP for help.";

/**
 * Normalize a user-supplied phone string to E.164 format.
 * Returns null for any input that cannot be safely resolved to a US E.164 number.
 * Does NOT silently convert arbitrary non-US local numbers.
 */
function normalizePhone(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim();

  // Already exact E.164: leading + followed by 8–15 digits only.
  if (/^\+[0-9]{8,15}$/.test(trimmed)) return trimmed;

  // Strip common US formatting characters: spaces, parentheses, hyphens, dots, plus signs.
  const digits = trimmed.replace(/[\s().+\-]/g, "");

  // Reject anything that is not purely numeric after stripping.
  if (!/^[0-9]+$/.test(digits)) return null;

  // 10-digit US number → +1XXXXXXXXXX
  if (digits.length === 10) return `+1${digits}`;

  // 11-digit number beginning with 1 → +1XXXXXXXXXX
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;

  // Any other length is not a supported US number.
  return null;
}

export async function POST(request: Request) {
  // Content-Type guard: JSON only.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json(
      { ok: false, error: "Unsupported Media Type" },
      { status: 415 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  // Honeypot: non-empty companyWebsite → silent success without insert.
  const companyWebsite =
    typeof body.companyWebsite === "string" ? body.companyWebsite.trim() : "";
  if (companyWebsite.length > 0) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // Explicit consent required.
  if (body.consent !== true) {
    return NextResponse.json(
      { ok: false, error: "Consent is required" },
      { status: 400 }
    );
  }

  // Phone normalization: invalid format → reject.
  const phone_e164 = normalizePhone(body.phone);
  if (!phone_e164) {
    return NextResponse.json(
      { ok: false, error: "Invalid phone number" },
      { status: 400 }
    );
  }

  // Environment variables.
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("[sms-opt-in] Missing Supabase environment variables");
    return NextResponse.json(
      { ok: false, error: "Server configuration error" },
      { status: 500 }
    );
  }

  // Request metadata — captured for consent audit; phone number is NOT logged.
  const rawForwardedFor = request.headers.get("x-forwarded-for") ?? null;
  const ip_address =
    (rawForwardedFor?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      null)
      ?.slice(0, 255) ?? null;
  const user_agent =
    (request.headers.get("user-agent") ?? null)?.slice(0, 1000) ?? null;
  const referrer =
    (request.headers.get("referer") ?? null)?.slice(0, 2000) ?? null;

  // Service-role client — same pattern as app/api/leads/route.ts.
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { error } = await supabase.from("sms_consent_events").insert({
    phone_e164,
    event_type: "opt_in",
    consent_source: CONSENT_SOURCE,
    disclosure_version: DISCLOSURE_VERSION,
    disclosure_text: DISCLOSURE_TEXT,
    ip_address,
    user_agent,
    referrer,
  });

  if (error) {
    console.error("[sms-opt-in] Insert failed");
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
