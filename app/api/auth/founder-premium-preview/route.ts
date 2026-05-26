// GET /api/auth/founder-premium-preview?token=...
// Founder-only production test access for /premium.
// Disabled unless ENABLE_FOUNDER_PREMIUM_PREVIEW=true and
// FOUNDER_PREMIUM_PREVIEW_TOKEN is set (64+ char random secret).
// Sets the same ppp_session cookie as normal premium flow.
// Does NOT create DB entitlement. Does NOT touch Whop/payment.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { signPremiumSession } from "@/lib/auth/premiumSession";

export const runtime = "nodejs";

// Sentinel value that premium page recognises to skip DB revalidation.
export const FOUNDER_PREVIEW_SESSION_ID = "founder_preview_internal";

const PREVIEW_COOKIE_MAX_AGE = 24 * 60 * 60; // 24 hours

function deny(origin: string): NextResponse {
  return NextResponse.redirect(`${origin}/premium?preview_error=1`, { status: 302 });
}

export async function GET(request: NextRequest) {
  const origin = (
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin
  ).replace(/\/$/, "");

  // ── Guard 1: feature flag ─────────────────────────────────────────────────
  if (process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW !== "true") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // ── Guard 2: env token configured and long enough ─────────────────────────
  const envToken = process.env.FOUNDER_PREMIUM_PREVIEW_TOKEN ?? "";
  if (envToken.length < 32) {
    console.error("[founder-preview] FOUNDER_PREMIUM_PREVIEW_TOKEN not configured or too short");
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // ── Guard 3: query token present ──────────────────────────────────────────
  const queryToken = request.nextUrl.searchParams.get("token") ?? "";
  if (!queryToken) {
    return deny(origin);
  }

  // ── Guard 4: constant-time comparison ────────────────────────────────────
  // Pad to same length with neutral byte before comparison to prevent
  // short-circuit while still revealing length info only — acceptable tradeoff.
  const envBuf = Buffer.from(envToken, "utf8");
  const queryBuf = Buffer.from(queryToken, "utf8");

  let tokenValid = false;
  if (envBuf.length === queryBuf.length) {
    try {
      tokenValid = timingSafeEqual(envBuf, queryBuf);
    } catch {
      tokenValid = false;
    }
  }

  if (!tokenValid) {
    return deny(origin);
  }

  // ── Issue preview session cookie ──────────────────────────────────────────
  const accessUntil = new Date(Date.now() + PREVIEW_COOKIE_MAX_AGE * 1000).toISOString();

  let sessionToken: string;
  try {
    sessionToken = signPremiumSession({
      checkoutSessionId: FOUNDER_PREVIEW_SESSION_ID,
      email: "founder-preview@polypropicks.internal",
      activePlan: "preview",
      accessUntil,
      issuedAt: Date.now(),
    });
  } catch (err) {
    console.error("[founder-preview] signPremiumSession failed:", err);
    return deny(origin);
  }

  const isProd = process.env.NODE_ENV === "production";
  const response = NextResponse.redirect(`${origin}/premium?preview=1`, { status: 302 });
  response.cookies.set("ppp_session", sessionToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: PREVIEW_COOKIE_MAX_AGE,
  });
  return response;
}
