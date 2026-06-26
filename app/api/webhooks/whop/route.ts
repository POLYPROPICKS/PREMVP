import { NextResponse } from "next/server";
import crypto from "crypto";
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

// Whop webhook secrets are issued with a `ws_` prefix, but standardwebhooks
// (used inside @whop/sdk) only strips `whsec_` and otherwise base64-decodes the
// raw string — a `ws_…` value contains `_`, which is not in the base64 alphabet,
// producing "Base64Coder: incorrect characters for decoding". Strip the `ws_`
// prefix so the remaining base64 secret decodes correctly. Verification stays on.
function normalizeWhopWebhookSecret(secret: string): {
  value: string;
  prefix: string;
  stripped: boolean;
} {
  const trimmed = secret.trim();
  if (trimmed.startsWith("ws_")) {
    return { value: trimmed.slice(3), prefix: "ws", stripped: true };
  }
  if (trimmed.startsWith("whsec_")) {
    return { value: trimmed, prefix: "whsec", stripped: false };
  }
  return { value: trimmed, prefix: "none", stripped: false };
}

// Strict fallback verifier for Whop's current `ws_…` webhook secrets.
// These are NOT standardwebhooks `whsec_` base64 keys: Whop signs with the raw
// secret string (ws_ prefix included) as the UTF-8 HMAC-SHA256 key, base64 of the
// digest, over `${id}.${timestamp}.${rawBody}` — identical envelope to the Standard
// Webhooks spec but a non-base64 key. This rejects unsigned/tampered/stale payloads
// exactly like the SDK; it does NOT weaken verification.
function verifyWsRawSignature(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
  toleranceSeconds = 300
): { ok: boolean; reason: string } {
  const webhookId = headers["webhook-id"];
  const webhookTimestamp = headers["webhook-timestamp"];
  const webhookSignature = headers["webhook-signature"];
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: "missing_headers" };
  }

  const ts = parseInt(webhookTimestamp, 10);
  if (Number.isNaN(ts)) return { ok: false, reason: "bad_timestamp" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const signedPayload = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("base64");
  const expectedBuf = Buffer.from(expected);

  // Header is space-separated "v1,<base64sig>" entries. Accept only v1.
  for (const entry of webhookSignature.split(" ")) {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) continue;
    const sigBuf = Buffer.from(sig);
    if (
      sigBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return { ok: true, reason: "match" };
    }
  }
  return { ok: false, reason: "no_matching_signature" };
}

// Maps internal ignore reasons to the stable diagnostic taxonomy used in logs.
function rejectionCategory(reason: string): string {
  if (reason.includes("company")) return "invalid_company";
  if (reason.includes("product")) return "invalid_product";
  if (reason.startsWith("status_not_access_valid")) return "unsupported_status";
  if (reason === "missing_checkoutSessionId")
    return "missing_checkout_session_id";
  if (reason.startsWith("missing_")) return "missing_metadata";
  if (reason === "plan_not_enabled") return "invalid_product";
  return "rejected_other";
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
    const normalizedSecret = normalizeWhopWebhookSecret(
      process.env.WHOP_WEBHOOK_SECRET!
    );
    // Sanitized — prefix + flag only, never the secret value.
    console.log(
      `whop_webhook_secret_normalized prefix=${normalizedSecret.prefix} stripped=${normalizedSecret.stripped}`
    );
    const client = new Whop({
      apiKey: process.env.WHOP_API_KEY,
      webhookKey: normalizedSecret.value,
    });
    const unwrapped = client.webhooks.unwrap(rawBody, { headers: headerMap });
    if (!isRecord(unwrapped)) throw new Error("non-object payload");
    event = unwrapped as Record<string, unknown>;
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    const errMsg = err instanceof Error ? err.message : "unknown";
    const eventId = headerMap["webhook-id"] ?? "none";
    // Sanitized diagnostic only — never log raw body, header values, secret, or email.
    console.error(
      `whop_webhook_sdk_unwrap_failed name=${errName} msg=${errMsg} id=${eventId}`
    );

    // Strict fallback for Whop's `ws_…` webhook secrets, which the SDK's
    // standardwebhooks verifier cannot consume (it base64-decodes the key).
    // Verify with the raw secret as the HMAC key. Only runs for ws_ secrets;
    // a failed match still rejects with 401 — verification is NOT weakened.
    const rawSecret = (process.env.WHOP_WEBHOOK_SECRET ?? "").trim();
    if (rawSecret.startsWith("ws_")) {
      const result = verifyWsRawSignature(rawBody, headerMap, rawSecret);
      if (!result.ok) {
        console.warn(
          `whop_webhook_ws_raw_verify_failed reason=${result.reason} id=${eventId}`
        );
        return jsonError("INVALID_WEBHOOK_SIGNATURE", 401);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return jsonError("INVALID_WEBHOOK_PAYLOAD", 400);
      }
      if (!isRecord(parsed)) {
        return jsonError("INVALID_WEBHOOK_PAYLOAD", 400);
      }
      console.log(`whop_webhook_ws_raw_verify_success id=${eventId}`);
      event = parsed;
    } else {
      // Non-ws secret: classify SDK verification failures as 401 and reserve
      // 400 for genuinely malformed (non-JSON) bodies.
      const isVerification =
        errName === "WebhookVerificationError" ||
        errMsg.toLowerCase().includes("verification") ||
        errMsg.toLowerCase().includes("signature") ||
        errMsg.toLowerCase().includes("timestamp") ||
        errMsg.toLowerCase().includes("required headers") ||
        errMsg.toLowerCase().includes("webhook");
      if (isVerification) {
        return jsonError("INVALID_WEBHOOK_SIGNATURE", 401);
      }
      return jsonError("INVALID_WEBHOOK_PAYLOAD", 400);
    }
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

  // ── Deactivation events ──
  const isDeactivation =
    eventType === "membership.deactivated" ||
    eventType === "membership_deactivated";

  if (isDeactivation) {
    const deactMeta = getMetadata(eventData);
    const deactMembershipId = eventDataId;
    const deactSessionId = (() => {
      const v = deactMeta?.["checkoutSessionId"];
      return isUuidLike(v) ? v : null;
    })();

    const renewalEnd = getString(eventData, "renewal_period_end");
    const now = new Date();
    const renewalEndDate = renewalEnd ? new Date(renewalEnd) : null;
    const renewalEndValid = renewalEndDate && !isNaN(renewalEndDate.getTime());
    const accessStillActive = renewalEndValid && renewalEndDate! > now;

    const deactUpdate = accessStillActive
      ? {
          has_premium_access: true,
          status: "active",
          access_until: renewalEndDate!.toISOString(),
          last_event_id: providerEventId,
          updated_at: now.toISOString(),
        }
      : {
          has_premium_access: false,
          status: "inactive",
          access_until: renewalEndValid
            ? renewalEndDate!.toISOString()
            : now.toISOString(),
          last_event_id: providerEventId,
          updated_at: now.toISOString(),
        };

    let deactExistingId: string | null = null;
    if (deactMembershipId) {
      const { data: byM } = await supabaseAdmin
        .from("user_entitlements")
        .select("id")
        .eq("provider", "whop")
        .eq("provider_membership_id", deactMembershipId)
        .maybeSingle();
      if (byM) deactExistingId = byM.id;
    }
    if (!deactExistingId && deactSessionId) {
      const { data: byS } = await supabaseAdmin
        .from("user_entitlements")
        .select("id")
        .eq("checkout_session_id", deactSessionId)
        .maybeSingle();
      if (byS) deactExistingId = byS.id;
    }

    if (deactExistingId) {
      await supabaseAdmin
        .from("user_entitlements")
        .update(deactUpdate)
        .eq("id", deactExistingId);
    }

    await supabaseAdmin
      .from("payment_events")
      .update({
        processing_status: deactExistingId ? "processed" : "logged",
        processed_at: now.toISOString(),
        provider_membership_id: deactMembershipId,
        checkout_session_id: deactSessionId,
      })
      .eq("provider", "whop")
      .eq("provider_event_id", providerEventId);

    return NextResponse.json({
      received: true,
      processed: !!deactExistingId,
      eventType,
      accessStillActive,
    });
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
    // Sanitized diagnostic — reason + ids only, never email or payload.
    console.warn(
      `whop_webhook_rejected category=${rejectionCategory(
        ignoreReason
      )} reason=${ignoreReason} id=${providerEventId} plan=${
        internalPlanId ?? "none"
      } product=${incomingProductId ?? "none"}`
    );
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

  let entitlementError: string | null = null;
  if (existingId) {
    const { error: updErr } = await supabaseAdmin
      .from("user_entitlements")
      .update(entitlementRow)
      .eq("id", existingId);
    if (updErr) entitlementError = updErr.message;
  } else {
    const { error: insErr } = await supabaseAdmin
      .from("user_entitlements")
      .insert(entitlementRow);
    if (insErr) entitlementError = insErr.message;
  }

  if (entitlementError) {
    // Sanitized — Whop event/membership ids only, no email or payload.
    console.error(
      `whop_webhook_entitlement_upsert_failed id=${providerEventId} membership=${membershipId} msg=${entitlementError}`
    );
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
      processing_status: entitlementError ? "error" : "processed",
      processed_at: new Date().toISOString(),
      error: entitlementError ?? null,
      checkout_session_id: isUuidLike(metaCheckoutSessionId)
        ? metaCheckoutSessionId
        : null,
      provider_membership_id: membershipId,
      provider_checkout_config_id: checkoutConfigId,
    })
    .eq("provider", "whop")
    .eq("provider_event_id", providerEventId);

  // Return 200 in both cases: the event was received and recorded idempotently.
  // On entitlement failure we report processed:false (already logged above) so
  // a duplicate redelivery does not re-grant access, and the row is flagged
  // "error" for reconciliation rather than triggering an infinite retry loop.
  return NextResponse.json({
    received: true,
    processed: !entitlementError,
    eventType: "membership.activated",
  });
}
