import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateRefCode } from "@/lib/referral/generateRefCode";

function isValidEmail(email: unknown): email is string {
  return (
    typeof email === "string" &&
    email.includes("@") &&
    email.includes(".") &&
    email.length <= 254
  );
}

type CreateReferralBody = {
  email?: unknown;
  source?: unknown;
  leadIntentId?: unknown;
};

export async function POST(request: Request) {
  let body: CreateReferralBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }

  if (!isValidEmail(body.email)) {
    return NextResponse.json({ ok: false, error: "INVALID_EMAIL" }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();

  const leadIntentId =
    typeof body.leadIntentId === "string" && body.leadIntentId.trim().length > 0
      ? body.leadIntentId.trim()
      : null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ ok: false, error: "SERVER_CONFIG_ERROR" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

  // Return existing active link if already created for this email
  const { data: existing } = await supabase
    .from("referral_links")
    .select("ref_code")
    .eq("email", email)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.ref_code) {
    const refCode = existing.ref_code as string;
    return NextResponse.json({
      ok: true,
      refCode,
      referralLink: `${appUrl}/r/${refCode}`,
      status: "existing",
    });
  }

  // Insert new referral link — retry up to 3 times on collision
  let refCode: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = generateRefCode();
    const { error } = await supabase.from("referral_links").insert({
      ref_code: candidate,
      email,
      lead_intent_id: leadIntentId,
      status: "active",
    });
    if (!error) {
      refCode = candidate;
      break;
    }
    // Unique constraint violation — try again
    if (!error.message.includes("unique") && !error.message.includes("duplicate")) {
      console.error("[referrals/create] insert error:", error.message);
      return NextResponse.json({ ok: false, error: "INSERT_FAILED" }, { status: 500 });
    }
  }

  if (!refCode) {
    return NextResponse.json({ ok: false, error: "CODE_COLLISION" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    refCode,
    referralLink: `${appUrl}/r/${refCode}`,
    status: "created",
  });
}
