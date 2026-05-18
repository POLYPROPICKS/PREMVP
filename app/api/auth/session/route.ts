import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { signPremiumSession } from "@/lib/auth/premiumSession";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "INVALID_BODY" }, { status: 400 });
  }

  const checkoutSessionId =
    typeof body.checkoutSessionId === "string" &&
    UUID_RE.test(body.checkoutSessionId.trim())
      ? body.checkoutSessionId.trim()
      : null;

  if (!checkoutSessionId) {
    return NextResponse.json(
      { success: false, error: "MISSING_CHECKOUT_SESSION_ID" },
      { status: 400 }
    );
  }

  const { data: row } = await supabaseAdmin
    .from("user_entitlements")
    .select("id, has_premium_access, status, active_plan, access_until, email")
    .eq("checkout_session_id", checkoutSessionId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ success: false, error: "ENTITLEMENT_NOT_FOUND" }, { status: 404 });
  }

  const accessUntilRaw =
    typeof row.access_until === "string" ? row.access_until : null;
  const accessUntilDate = accessUntilRaw ? new Date(accessUntilRaw) : null;
  const isActive =
    row.has_premium_access === true &&
    ["active", "trialing", "completed"].includes(row.status ?? "") &&
    accessUntilDate !== null &&
    !isNaN(accessUntilDate.getTime()) &&
    accessUntilDate > new Date();

  if (!isActive) {
    return NextResponse.json({ success: false, error: "ENTITLEMENT_NOT_ACTIVE" }, { status: 403 });
  }

  let token: string;
  try {
    token = signPremiumSession({
      checkoutSessionId,
      email: typeof row.email === "string" ? row.email : null,
      activePlan: typeof row.active_plan === "string" ? row.active_plan : null,
      accessUntil: accessUntilRaw,
      issuedAt: Date.now(),
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "SESSION_SIGN_FAILED" },
      { status: 500 }
    );
  }

  if (!accessUntilDate) {
    return NextResponse.json({ success: false, error: "MISSING_ACCESS_UNTIL" }, { status: 403 });
  }

  const now = new Date();
  const maxAgeSeconds = Math.floor((accessUntilDate.getTime() - now.getTime()) / 1000);

  if (maxAgeSeconds <= 0) {
    return NextResponse.json({ success: false, error: "ENTITLEMENT_NOT_ACTIVE" }, { status: 403 });
  }

  const isProd = process.env.NODE_ENV === "production";

  const response = NextResponse.json({ success: true });
  response.cookies.set("ppp_session", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
  return response;
}
