import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { signPremiumSession } from "@/lib/auth/premiumSession";

export const runtime = "nodejs";

const ACCESS_VALID_STATUSES = new Set(["active", "trialing", "completed"]);

export async function GET(request: NextRequest) {
  const origin = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  const invalidUrl = `${origin}/premium?restore=invalid`;

  const rawToken = request.nextUrl.searchParams.get("token");

  if (!rawToken || rawToken.length < 10) {
    return NextResponse.redirect(invalidUrl);
  }

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const now = new Date();

  // Lookup token — must be unconsumed and unexpired
  const { data: tokenRow } = await supabaseAdmin
    .from("premium_magic_tokens")
    .select("id, checkout_session_id, email, expires_at")
    .eq("token_hash", tokenHash)
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString())
    .maybeSingle();

  if (!tokenRow) {
    return NextResponse.redirect(invalidUrl);
  }

  // Atomically consume token — guard prevents replay
  const { data: consumed } = await supabaseAdmin
    .from("premium_magic_tokens")
    .update({ consumed_at: now.toISOString() })
    .eq("id", tokenRow.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();

  if (!consumed) {
    // Race condition: another request consumed it first
    return NextResponse.redirect(invalidUrl);
  }

  // Revalidate entitlement — never issue session from token alone
  const { data: entRow } = await supabaseAdmin
    .from("user_entitlements")
    .select("has_premium_access, status, active_plan, access_until, email")
    .eq("checkout_session_id", tokenRow.checkout_session_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!entRow) return NextResponse.redirect(invalidUrl);

  const accessUntilDate = entRow.access_until ? new Date(entRow.access_until as string) : null;
  const isActive =
    entRow.has_premium_access === true &&
    ACCESS_VALID_STATUSES.has((entRow.status as string) ?? "") &&
    accessUntilDate !== null &&
    !isNaN(accessUntilDate.getTime()) &&
    accessUntilDate > now;

  if (!isActive || !accessUntilDate) return NextResponse.redirect(invalidUrl);

  const maxAgeSeconds = Math.floor((accessUntilDate.getTime() - now.getTime()) / 1000);
  if (maxAgeSeconds <= 0) return NextResponse.redirect(invalidUrl);

  let sessionToken: string;
  try {
    sessionToken = signPremiumSession({
      checkoutSessionId: tokenRow.checkout_session_id as string,
      email:
        typeof entRow.email === "string"
          ? entRow.email
          : (tokenRow.email as string),
      activePlan: typeof entRow.active_plan === "string" ? (entRow.active_plan as string) : null,
      accessUntil: entRow.access_until as string,
      issuedAt: Date.now(),
    });
  } catch (err) {
    console.error("[magic-link/verify] signPremiumSession failed:", err);
    return NextResponse.redirect(invalidUrl);
  }

  const isProd = process.env.NODE_ENV === "production";
  const response = NextResponse.redirect(`${origin}/premium?restored=1`);
  response.cookies.set("ppp_session", sessionToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
  return response;
}
