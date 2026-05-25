import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const REF_CODE_RE = /^[A-Za-z0-9_-]+$/;

function isValidEmail(e: unknown): e is string {
  return typeof e === "string" && e.includes("@") && e.includes(".") && e.length <= 254;
}

function sanitizeRefCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().slice(0, 64);
  return REF_CODE_RE.test(t) ? t : null;
}

function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "hidden";
  const atIdx = email.indexOf("@");
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  if (local.length < 2) return "h***@" + domain;
  return local.slice(0, 2) + "***@" + domain;
}

type StatusBody = { email?: unknown; refCode?: unknown };

export async function POST(request: Request) {
  let body: StatusBody;
  try { body = await request.json(); }
  catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }

  const refCode = sanitizeRefCode(body.refCode);
  const emailRaw = isValidEmail(body.email) ? (body.email as string).trim().toLowerCase() : null;

  if (!refCode && !emailRaw) {
    return NextResponse.json({ ok: false, error: "MISSING_IDENTIFIER" }, { status: 400 });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ ok: false, error: "SERVER_CONFIG_ERROR" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Lookup active referral link
  let linkQuery = supabase
    .from("referral_links")
    .select("id, ref_code, email, click_count, created_at")
    .eq("status", "active");

  if (refCode) {
    linkQuery = linkQuery.eq("ref_code", refCode);
  } else {
    linkQuery = linkQuery.eq("email", emailRaw as string);
  }

  const { data: link } = await linkQuery
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!link) {
    return NextResponse.json({ ok: true, hasReferralLink: false, dashboard: null });
  }

  const foundRefCode = link.ref_code as string;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const referralLink = `${appUrl}/r/${foundRefCode}`;

  // Fetch referred leads
  const { data: leads } = await supabase
    .from("lead_intents")
    .select("email, source, created_at")
    .eq("referred_by_code", foundRefCode)
    .order("created_at", { ascending: false })
    .limit(20);

  const recentReferrals = (leads ?? []).map((row) => ({
    createdAt: row.created_at as string,
    emailMasked: maskEmail(row.email as string | null),
    source: (row.source as string | null) ?? null,
    status: "Pending",
  }));

  return NextResponse.json({
    ok: true,
    hasReferralLink: true,
    refCode: foundRefCode,
    referralLink,
    dashboard: {
      clickCount: (link.click_count as number) ?? 0,
      referredLeadCount: recentReferrals.length,
      pendingReferralCount: recentReferrals.length,
      verifiedPaidReferralCount: 0,
      premiumCreditUsd: 0,
      maxPremiumCreditUsd: 30,
      partnerUnlocked: false,
      recentReferrals,
      rewardStatus: "pending_paid_verification",
      disclaimer:
        "Premium Credit verifies after paid subscription confirmation. Premium Credit only. Not cash.",
    },
  });
}
