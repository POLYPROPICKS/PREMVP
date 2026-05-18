import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CheckBody = {
  email?: unknown;
  checkoutSessionId?: unknown;
};

export async function POST(request: Request) {
  let body: CheckBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "INVALID_BODY" },
      { status: 400 }
    );
  }

  const email =
    typeof body.email === "string" && body.email.trim().length > 0
      ? body.email.trim().toLowerCase()
      : null;

  const checkoutSessionId =
    typeof body.checkoutSessionId === "string" &&
    UUID_RE.test(body.checkoutSessionId.trim())
      ? body.checkoutSessionId.trim()
      : null;

  if (!email && !checkoutSessionId) {
    return NextResponse.json(
      { success: false, error: "MISSING_IDENTIFIER" },
      { status: 400 }
    );
  }

  try {
    let row: Record<string, unknown> | null = null;

    if (checkoutSessionId) {
      const { data } = await supabaseAdmin
        .from("user_entitlements")
        .select(
          "id, has_premium_access, status, active_plan, access_until, updated_at"
        )
        .eq("checkout_session_id", checkoutSessionId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      row = data as Record<string, unknown> | null;
    }

    if (!row && email) {
      const { data } = await supabaseAdmin
        .from("user_entitlements")
        .select(
          "id, has_premium_access, status, active_plan, access_until, updated_at"
        )
        .eq("email", email)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      row = data as Record<string, unknown> | null;
    }

    if (!row) {
      return NextResponse.json({
        success: true,
        hasPremiumAccess: false,
        status: "not_found",
        activePlan: null,
        accessUntil: null,
      });
    }

    const rowId = typeof row["id"] === "string" ? row["id"] : null;
    const hasPremiumDb = row["has_premium_access"] === true;
    const statusDb =
      typeof row["status"] === "string" ? row["status"] : "inactive";
    const activePlan =
      typeof row["active_plan"] === "string" ? row["active_plan"] : null;
    const accessUntilRaw =
      typeof row["access_until"] === "string" ? row["access_until"] : null;

    const now = new Date();
    const accessUntilDate = accessUntilRaw ? new Date(accessUntilRaw) : null;
    const notExpired =
      accessUntilDate !== null &&
      !isNaN(accessUntilDate.getTime()) &&
      accessUntilDate > now;

    const hasPremiumAccess = hasPremiumDb && statusDb === "active" && notExpired;

    if (!hasPremiumAccess && hasPremiumDb && rowId) {
      // Expired in DB but not yet updated — mark expired safely
      await supabaseAdmin
        .from("user_entitlements")
        .update({
          has_premium_access: false,
          status: "expired",
          updated_at: now.toISOString(),
        })
        .eq("id", rowId)
        .eq("has_premium_access", true); // guard: only flip if still marked active
    }

    const responseStatus: string = hasPremiumAccess
      ? "active"
      : notExpired === false && accessUntilDate !== null
      ? "expired"
      : statusDb === "inactive" || statusDb === "expired"
      ? statusDb
      : "inactive";

    return NextResponse.json({
      success: true,
      hasPremiumAccess,
      status: responseStatus,
      activePlan: hasPremiumAccess ? activePlan : null,
      accessUntil: hasPremiumAccess ? accessUntilRaw : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("entitlement check failed:", msg);
    return NextResponse.json(
      { success: false, error: "CHECK_FAILED" },
      { status: 500 }
    );
  }
}
