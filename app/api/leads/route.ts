import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type LeadRequestBody = {
  email?: unknown;
  signalId?: unknown;
  eventTitle?: unknown;
  position?: unknown;
  winProbability?: unknown;
  price?: unknown;
  source?: unknown;
  intentType?: unknown;
  planId?: unknown;
  planName?: unknown;
  planPrice?: unknown;
  planSource?: unknown;
  reservedAt?: unknown;
  referredByCode?: unknown;
  referralCode?: unknown;
};

function isValidEmail(email: unknown): email is string {
  return (
    typeof email === "string" &&
    email.includes("@") &&
    email.includes(".") &&
    email.length <= 254
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function POST(request: Request) {
  let body: LeadRequestBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!isValidEmail(email)) {
    return NextResponse.json(
      { success: false, error: "Invalid email" },
      { status: 400 }
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Missing Supabase environment variables");

    return NextResponse.json(
      { success: false, error: "Server configuration error" },
      { status: 500 }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase
    .from("lead_intents")
    .insert({
      email,
      signal_id: optionalString(body.signalId),
      event_title: optionalString(body.eventTitle),
      position: optionalString(body.position),
      win_probability: optionalNumber(body.winProbability),
      price: optionalString(body.price),
      source: optionalString(body.source) || "cta_modal",
      intent_type: optionalString(body.intentType),
      plan_id: optionalString(body.planId),
      plan_name: optionalString(body.planName),
      plan_price: optionalString(body.planPrice),
      plan_source: optionalString(body.planSource),
      reserved_at: optionalString(body.reservedAt),
      user_agent: request.headers.get("user-agent"),
      referred_by_code: (() => {
        const REF_RE = /^[A-Za-z0-9_-]+$/;
        // Body field takes priority; fall back to referral cookie if absent/invalid
        const fromBody = body.referredByCode ?? body.referralCode;
        if (typeof fromBody === "string") {
          const t = fromBody.trim().slice(0, 64);
          if (REF_RE.test(t)) return t;
        }
        const cookieHeader = request.headers.get("cookie") ?? "";
        const match = cookieHeader.match(/(?:^|;\s*)ppp_referral_code=([^;]+)/);
        if (match) {
          const t = decodeURIComponent(match[1]).trim().slice(0, 64);
          if (REF_RE.test(t)) return t;
        }
        return null;
      })(),
    })
    .select("id")
    .single();

  if (error) {
    console.error("Supabase lead insert failed:", error);

    return NextResponse.json(
      { success: false, error: "Lead insert failed" },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      success: true,
      message: "Lead captured successfully",
      leadId: data.id,
    },
    { status: 200 }
  );
}