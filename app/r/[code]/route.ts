import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const REF_CODE_RE = /^[A-Za-z0-9_-]+$/;
const COOKIE_NAME = "ppp_referral_code";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sanitizeCode(raw: string): string | null {
  const trimmed = raw.trim().slice(0, 64);
  return REF_CODE_RE.test(trimmed) ? trimmed : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code: rawCode } = await params;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

  const code = sanitizeCode(rawCode ?? "");
  if (!code) {
    return NextResponse.redirect(`${appUrl}/?ref_invalid=1`, { status: 302 });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    // Fail open: redirect to home without attribution rather than error page
    return NextResponse.redirect(`${appUrl}/`, { status: 302 });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Look up active referral link
  const { data: link } = await supabase
    .from("referral_links")
    .select("id, ref_code, click_count")
    .eq("ref_code", code)
    .eq("status", "active")
    .maybeSingle();

  if (!link) {
    return NextResponse.redirect(`${appUrl}/?ref_invalid=1`, { status: 302 });
  }

  // Increment click_count (MVP: acceptable single-row update, minor race is ok)
  await supabase
    .from("referral_links")
    .update({ click_count: (link.click_count as number) + 1 })
    .eq("id", link.id as string);

  // Build redirect with referral cookie
  const isProduction = process.env.NODE_ENV === "production";
  const response = NextResponse.redirect(`${appUrl}/?ref=${code}`, { status: 302 });

  response.cookies.set(COOKIE_NAME, code, {
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    sameSite: "lax",
    httpOnly: false,
    secure: isProduction,
  });

  return response;
}
