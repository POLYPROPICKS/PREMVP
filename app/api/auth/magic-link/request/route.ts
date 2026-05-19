import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCESS_VALID_STATUSES = new Set(["active", "trialing", "completed"]);

function getOrigin(request: NextRequest): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const origin = getOrigin(request);

  // Parse email
  let rawEmail: string | null = null;
  if (isJson) {
    try {
      const body = await request.json();
      rawEmail = typeof body.email === "string" ? body.email : null;
    } catch {
      return NextResponse.json({ success: false, error: "INVALID_BODY" }, { status: 400 });
    }
  } else {
    try {
      const form = await request.formData();
      const v = form.get("email");
      rawEmail = typeof v === "string" ? v : null;
    } catch {
      return NextResponse.redirect(`${origin}/premium?restore=invalid`);
    }
  }

  const email =
    typeof rawEmail === "string" && EMAIL_RE.test(rawEmail.trim())
      ? rawEmail.trim().toLowerCase()
      : null;

  // Generic success for invalid email — avoid enumeration
  if (!email) {
    if (isJson) return NextResponse.json({ success: true });
    return NextResponse.redirect(`${origin}/premium?restore=requested`);
  }

  // Require email provider before any DB work
  const resendKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.EMAIL_FROM;
  if (!resendKey || !emailFrom) {
    if (isJson)
      return NextResponse.json(
        { success: false, error: "EMAIL_PROVIDER_NOT_CONFIGURED" },
        { status: 500 },
      );
    return NextResponse.redirect(`${origin}/premium?restore=provider-missing`);
  }

  const now = new Date();

  // Look up active entitlement by email
  const { data: row } = await supabaseAdmin
    .from("user_entitlements")
    .select("checkout_session_id, has_premium_access, status, access_until")
    .eq("email", email)
    .eq("has_premium_access", true)
    .order("access_until", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Generic success if no entitlement — avoid enumeration
  if (!row) {
    if (isJson) return NextResponse.json({ success: true });
    return NextResponse.redirect(`${origin}/premium?restore=requested`);
  }

  const accessUntilDate = row.access_until ? new Date(row.access_until as string) : null;
  const isActive =
    ACCESS_VALID_STATUSES.has((row.status as string) ?? "") &&
    accessUntilDate !== null &&
    !isNaN(accessUntilDate.getTime()) &&
    accessUntilDate > now;

  // Generic success if expired/inactive — avoid enumeration
  if (!isActive || !row.checkout_session_id) {
    if (isJson) return NextResponse.json({ success: true });
    return NextResponse.redirect(`${origin}/premium?restore=requested`);
  }

  // Generate one-time token — only hash stored in DB
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

  const { error: insertError } = await supabaseAdmin
    .from("premium_magic_tokens")
    .insert({
      token_hash: tokenHash,
      checkout_session_id: row.checkout_session_id,
      email,
      expires_at: expiresAt.toISOString(),
    });

  if (insertError) {
    console.error("[magic-link/request] token insert failed:", insertError.message);
    if (isJson)
      return NextResponse.json({ success: false, error: "TOKEN_STORE_FAILED" }, { status: 500 });
    return NextResponse.redirect(`${origin}/premium?restore=invalid`);
  }

  const link = `${origin}/api/auth/magic-link/verify?token=${encodeURIComponent(rawToken)}`;

  const emailHtml = `
<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 16px;color:#d8e8f4;font-size:20px">PolyProPicks Premium Access</h2>
  <p style="color:#a0bed7;margin:0 0 20px">Click the button below to securely access your premium feed.</p>
  <a href="${link}" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#1a6ec4,#0f4a8a);color:#e8f2fc;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px">Access Premium Feed</a>
  <p style="color:#6a8fa8;font-size:12px;margin:20px 0 0">This link expires in 15 minutes and can only be used once.</p>
  <p style="color:#4a6a82;font-size:11px;margin:8px 0 0">If you didn't request this, ignore this email.</p>
</div>
`;
  const emailText = `Access your PolyProPicks Premium feed:\n\n${link}\n\nThis link expires in 15 minutes and can only be used once.`;

  try {
    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [email],
        subject: "Your PolyProPicks secure access link",
        html: emailHtml,
        text: emailText,
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text().catch(() => "");
      console.error("[magic-link/request] Resend error:", sendRes.status, errText.slice(0, 200));
    }
  } catch (err) {
    // Email send failure not surfaced — avoid enumeration
    console.error("[magic-link/request] fetch to Resend failed:", err);
  }

  if (isJson) return NextResponse.json({ success: true });
  return NextResponse.redirect(`${origin}/premium?restore=requested`);
}
