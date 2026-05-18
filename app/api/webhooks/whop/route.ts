import { NextResponse } from "next/server";
import Whop from "@whop/sdk";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getPlanById, getWhopProductIdForPlan } from "@/lib/payments/planCatalog";

export const runtime = "nodejs";

// ── Defensive helpers ──────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function getMetadata(
  data: Record<string, unknown>
): Record<string, unknown> | null {
  const meta = data["metadata"];
  return isRecord(meta) ? meta : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidLike(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function jsonError(code: string, status: number) {
  return NextResponse.json({ success: false, error: code }, { status });
}

function selectedHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const keep = ["webhook-id", "webhook-timestamp", "content-type"];
  return Object.fromEntries(
    keep.flatMap((k) => (headers[k] ? [[k, headers[k]]] : []))
  );
}

function addHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(request: Request) {
  // Read raw body FIRST — must precede any JSON parse
  const rawBody = await request.text();

  // Collect all headers into plain object
  const headerMap: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headerMap[key] = value;
  });

  // ── Env guard ──
  const missingEnv: string[] = [];
  if (!process.env.WHOP_API_KEY) missingEnv.push("WHOP_API_KEY");
  if (!process.env.WHOP_WEBHOOK_SECRET) missingEnv.push("WHOP_WEBHOOK_SECRET");
  if (!process.env.WHOP_COMPANY_ID) missingEnv.push("WHOP_COMPANY_ID");
  if (missingEnv.length > 0) {
    return NextResponse.json(
      { success: false, error: "MISSING_ENV", missing: missingEnv },
      { status: 500 }
    );
  }

  const companyId = process.env.WHOP_COMPANY_ID!;

  // ── Required webhook headers ──
  if (
    !headerMap["webhook-id"] ||
    !headerMap["webhook-signature"] ||
    !headerMap["webhook-timestamp"]
  ) {
    return jsonError("MISSING_WEBHOOK_HEADERS", 400);
  }

  const providerEventId = headerMap["webhook-id"];

  // ── SDK verification ──
  let event: Record<string, unknown>;
  try {
    const client = new Whop({
      apiKey: process.env.WHOP_API_KEY,
      webhookKey: process.env.WHOP_WEBHOOK_SECRET,
    });
    const unwrapped = client.webhooks.unwrap(rawBody, { headers: headerMap });
    if (!isRecord(unwrapped)) throw new Error("non-object payload");
    event = unwrapped as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (
      msg.toLowerCase().includes("verification") ||
      msg.toLowerCase().includes("signature") ||
      msg.toLowerCase().includes("webhook")
    ) {
      return jsonError("INVALID_WEBHOOK_SIGNATURE", 401);
    }
    return jsonError("INVALID_WEBHOOK_PAYLOAD", 400);
  }

  const eventType = getString(event, "type") ?? "unknown";
  const eventData = isRecord(event["data"]) ? event["data"] : {};
  const eventDataId = getString(eventData, "id");
  const checkoutConfigId = getString(eventData, "checkout_configuration_id");

  const checkoutSessionIdRaw = (() => {
    const meta = getMetadata(eventData);
    const v = meta?.["checkoutSessionId"];
    return isUuidLike(v) ? v : null;
  })();

  // ── Idempotent payment_events insert ──
  const { error: insertError } = await supabaseAdmin
    .from("payment_events")
    .insert({
      provider: "whop",
      provider_event_id: providerEventId,
      event_type: eventType,
      provider_object_id: eventDataId,
      provider_checkout_config_id: checkoutConfigId,
      provider_membership_id:
        eventType.startsWith("membership.") ? eventDataId : null,
      checkout_session_id: checkoutSessionIdRaw,
      processing_status: "received",
      raw_payload: event,
      headers: selectedHeaders(headerMap),
    });

  if (insertError) {
    // Unique constraint violation = duplicate event
    if (
      insertError.code === "23505" ||
      insertError.message?.includes("uq_payment_events_provider_event")
    ) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("payment_events insert failed:", insertError.message);
    return jsonError("PAYMENT_EVENT_INSERT_FAILED", 500);
  }

  // ── Non-membership events: log and return ──
  if (eventType !== "membership.activated") {
    await supabaseAdmin
      .from("payment_events")
      .update({ processing_status: "logged", processed_at: new Date().toISOString() })
      .eq("provider", "whop")
      .eq("provider_event_id", providerEventId);
    return NextResponse.json({ received: true, processed: false, eventType });
  }

  // ── membership.activated: strict validation ──
  const meta = getMetadata(eventData);
  const eventCompanyId = getString(event, "company_id");
  const dataCompany = isRecord(eventData["company"]) ? eventData["company"] : null;
  const dataProduct = isRecord(eventData["product"]) ? eventData["product"] : null;
  const dataPlan = isRecord(eventData["plan"]) ? eventData["plan"] : null;
  const dataUser = isRecord(eventData["user"]) ? eventData["user"] : null;
  const dataMember = isRecord(eventData["member"]) ? eventData["member"] : null;

  const internalPlanId = meta ? getString(meta, "internalPlanId") : null;
  const leadIntentId = meta ? getString(meta, "leadIntentId") : null;
  const metaCheckoutSessionId = meta ? getString(meta, "checkoutSessionId") : null;
  const membershipStatus = typeof eventData["status"] === "string" ? eventData["status"] : "";
  const accessValidStatuses = new Set(["completed", "active", "trialing"]);

  const plan = internalPlanId ? getPlanById(internalPlanId) : null;

  // Resolve expected product id from plan's env key (per-plan validation)
  const expectedProductId = plan ? getWhopProductIdForPlan(plan) : null;
  const incomingProductId = dataProduct
    ? getString(dataProduct as Record<string, unknown>, "id")
    : null;

  let ignoreReason: string | null = null;
  if (eventCompanyId !== companyId) ignoreReason = "company_id_mismatch";
  else if (
    dataCompany &&
    getString(dataCompany as Record<string, unknown>, "id") !== companyId
  )
    ignoreReason = "data_company_id_mismatch";
  else if (
    incomingProductId &&
    expectedProductId &&
    incomingProductId !== expectedProductId
  )
    ignoreReason = "product_id_mismatch";
  else if (!accessValidStatuses.has(membershipStatus)) ignoreReason = `status_not_access_valid:${membershipStatus}`;
  else if (!internalPlanId) ignoreReason = "missing_internalPlanId";
  else if (!metaCheckoutSessionId) ignoreReason = "missing_checkoutSessionId";
  else if (!leadIntentId) ignoreReason = "missing_leadIntentId";
  else if (!plan || !plan.enabled) ignoreReason = "plan_not_enabled";

  if (ignoreReason) {
    await supabaseAdmin
      .from("payment_events")
      .update({
        processing_status: "ignored",
        processed_at: new Date().toISOString(),
        error: ignoreReason,
      })
      .eq("provider", "whop")
      .eq("provider_event_id", providerEventId);
    return NextResponse.json({ received: true, processed: false, reason: ignoreReason });
  }

  // ── Entitlement grant ──
  const membershipId = eventDataId!;
  const providerUserId = dataUser ? getString(dataUser as Record<string, unknown>, "id") : null;
  const providerMemberId = dataMember ? getString(dataMember as Record<string, unknown>, "id") : null;

  // access_until: prefer Whop renewal_period_end, fallback to plan.durationHours
  const renewalPeriodEnd = getString(eventData, "renewal_period_end");
  const accessUntil = (() => {
    if (renewalPeriodEnd) {
      const parsed = new Date(renewalPeriodEnd);
      if (!isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return addHours(plan!.durationHours);
  })();
  const providerPlanId = dataPlan ? getString(dataPlan as Record<string, unknown>, "id") : null;
  const providerProductId = dataProduct ? getString(dataProduct as Record<string, unknown>, "id") : null;
  const email = dataUser ? getString(dataUser as Record<string, unknown>, "email") : null;
  const userIdentifier =
    email ?? providerUserId ?? providerMemberId ?? membershipId;

  const entitlementRow = {
    user_identifier: userIdentifier,
    email,
    lead_intent_id: isUuidLike(leadIntentId) ? leadIntentId : null,
    provider: "whop",
    provider_user_id: providerUserId,
    provider_member_id: providerMemberId,
    provider_membership_id: membershipId,
    provider_plan_id: providerPlanId,
    provider_product_id: providerProductId,
    checkout_session_id: isUuidLike(metaCheckoutSessionId) ? metaCheckoutSessionId : null,
    active_plan: internalPlanId!,
    has_premium_access: true,
    access_until: accessUntil,
    status: "active",
    last_event_id: providerEventId,
    raw_source: eventData,
    updated_at: new Date().toISOString(),
  };

  // Find existing entitlement — by membership id first, then by checkout_session_id
  let existingId: string | null = null;
  const { data: byMembership } = await supabaseAdmin
    .from("user_entitlements")
    .select("id")
    .eq("provider", "whop")
    .eq("provider_membership_id", membershipId)
    .maybeSingle();

  if (byMembership) {
    existingId = byMembership.id;
  } else if (isUuidLike(metaCheckoutSessionId)) {
    const { data: bySession } = await supabaseAdmin
      .from("user_entitlements")
      .select("id")
      .eq("checkout_session_id", metaCheckoutSessionId)
      .maybeSingle();
    if (bySession) existingId = bySession.id;
  }

  if (existingId) {
    await supabaseAdmin
      .from("user_entitlements")
      .update(entitlementRow)
      .eq("id", existingId);
  } else {
    await supabaseAdmin.from("user_entitlements").insert(entitlementRow);
  }

  // ── Update checkout_sessions ──
  if (isUuidLike(metaCheckoutSessionId)) {
    await supabaseAdmin
      .from("checkout_sessions")
      .update({
        status: "completed",
        provider_checkout_config_id: checkoutConfigId,
        provider_plan_id: providerPlanId,
        provider_product_id: providerProductId,
        ...(email ? { email } : {}),
      })
      .eq("id", metaCheckoutSessionId);
  }

  // ── Finalize payment_events ──
  await supabaseAdmin
    .from("payment_events")
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
      checkout_session_id: isUuidLike(metaCheckoutSessionId)
        ? metaCheckoutSessionId
        : null,
      provider_membership_id: membershipId,
      provider_checkout_config_id: checkoutConfigId,
    })
    .eq("provider", "whop")
    .eq("provider_event_id", providerEventId);

  return NextResponse.json({
    received: true,
    processed: true,
    eventType: "membership.activated",
  });
}
