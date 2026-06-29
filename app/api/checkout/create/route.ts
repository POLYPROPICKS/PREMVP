import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  getEnabledPlanById,
  getWhopProductIdForPlan,
} from "@/lib/payments/planCatalog";
import { createWhopCheckoutConfiguration } from "@/lib/payments/whopCheckout";
import { captureServerEvent } from "@/lib/analytics/serverCapture";
import { PPP_EVENTS } from "@/lib/analytics/events";
import { resolveDistinctId } from "@/lib/analytics/identity";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreateCheckoutBody = {
  internalPlanId?: unknown;
  leadIntentId?: unknown;
  source?: unknown;
  email?: unknown;
  analyticsDistinctId?: unknown;
};

export async function POST(request: Request) {
  // --- env guards ---
  if (process.env.CHECKOUT_ENABLED !== "true") {
    return NextResponse.json(
      { success: false, error: "CHECKOUT_DISABLED" },
      { status: 503 }
    );
  }
  if (process.env.PAYMENT_PROVIDER !== "whop") {
    return NextResponse.json(
      { success: false, error: "INVALID_PROVIDER" },
      { status: 400 }
    );
  }
  const missingBase: string[] = [];
  if (!process.env.WHOP_API_KEY) missingBase.push("WHOP_API_KEY");
  if (!process.env.WHOP_COMPANY_ID) missingBase.push("WHOP_COMPANY_ID");
  if (!process.env.NEXT_PUBLIC_APP_URL) missingBase.push("NEXT_PUBLIC_APP_URL");
  if (missingBase.length > 0) {
    return NextResponse.json(
      { success: false, error: "MISSING_ENV", missing: missingBase },
      { status: 500 }
    );
  }

  const companyId = process.env.WHOP_COMPANY_ID!;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  // --- body parse ---
  let body: CreateCheckoutBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "INVALID_PLAN" },
      { status: 400 }
    );
  }

  // --- input validation ---
  // Backward compatibility: map legacy "premium_7day" to canonical
  const rawPlanId =
    typeof body.internalPlanId === "string" ? body.internalPlanId : "";
  const internalPlanId =
    rawPlanId === "premium_7day" ? "premium_7day_weekly" : rawPlanId;

  const plan = getEnabledPlanById(internalPlanId);
  if (!plan) {
    return NextResponse.json(
      { success: false, error: "INVALID_PLAN" },
      { status: 400 }
    );
  }

  // Per-plan product env check
  const productId = getWhopProductIdForPlan(plan);
  if (!productId) {
    return NextResponse.json(
      {
        success: false,
        error: "MISSING_ENV",
        missing: [plan.whopProductEnvKey],
      },
      { status: 500 }
    );
  }

  const leadIntentId =
    typeof body.leadIntentId === "string" ? body.leadIntentId.trim() : "";
  if (!UUID_RE.test(leadIntentId)) {
    return NextResponse.json(
      { success: false, error: "INVALID_LEAD_INTENT" },
      { status: 400 }
    );
  }

  const source =
    typeof body.source === "string" && body.source.trim().length > 0
      ? body.source.trim()
      : "pass_offer_modal";

  const email =
    typeof body.email === "string" && body.email.trim().length > 0
      ? body.email.trim()
      : null;

  // Browser PostHog distinct id for identity stitching (body field or header).
  // Safe non-PII string; null when absent. Persisted in checkout_sessions
  // metadata so the Whop webhook can attribute payment events to the same person.
  const analyticsDistinctId = resolveDistinctId({
    body: body as Record<string, unknown>,
    headers: request.headers,
  });

  // --- insert checkout_sessions BEFORE provider call ---
  const { data: sessionRow, error: sessionInsertError } = await supabaseAdmin
    .from("checkout_sessions")
    .insert({
      internal_plan_id: plan.internalPlanId,
      lead_intent_id: leadIntentId,
      source,
      provider: "whop",
      provider_product_id: productId,
      status: "created",
      email,
      metadata: {
        internalPlanId: plan.internalPlanId,
        leadIntentId,
        source,
        ...(analyticsDistinctId ? { analyticsDistinctId } : {}),
      },
    })
    .select("id")
    .single();

  if (sessionInsertError || !sessionRow) {
    console.error("checkout_sessions insert failed:", sessionInsertError);
    return NextResponse.json(
      { success: false, error: "CHECKOUT_SESSION_CREATE_FAILED" },
      { status: 500 }
    );
  }

  const checkoutSessionId: string = sessionRow.id;

  // Analytics: checkout initiated (server-side, fail-open). This is intent, not
  // payment — `purchase`/activation is emitted only by the confirmed webhook.
  // Use the browser distinct id when provided so this lands on the same person
  // as the client events; fall back to leadIntentId otherwise.
  await captureServerEvent(PPP_EVENTS.CHECKOUT_START, {
    distinctId: analyticsDistinctId ?? leadIntentId,
    properties: {
      plan: plan.internalPlanId,
      internal_plan_id: plan.internalPlanId,
      source,
      source_surface: source,
      checkout_provider: "whop",
      identity_stitched: Boolean(analyticsDistinctId),
    },
  });

  const checkoutMetadata = {
    internalPlanId: plan.internalPlanId,
    leadIntentId,
    checkoutSessionId,
    source,
    ...(analyticsDistinctId ? { analyticsDistinctId } : {}),
  };

  // --- call Whop provider ---
  let providerResult: Awaited<
    ReturnType<typeof createWhopCheckoutConfiguration>
  >;
  try {
    providerResult = await createWhopCheckoutConfiguration({
      companyId,
      productId,
      internalPlanId: plan.internalPlanId,
      displayName: plan.displayName,
      priceUsd: plan.priceUsd,
      renewalPriceUsd: plan.renewalPriceUsd,
      billingPeriodDays: plan.billingPeriodDays,
      paymentMode: plan.paymentMode,
      source,
      leadIntentId,
      checkoutSessionId,
      appUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    const providerStatus =
      typeof (err as Record<string, unknown>)["providerStatus"] === "number"
        ? (err as Record<string, unknown>)["providerStatus"]
        : null;
    const providerStatusText =
      typeof (err as Record<string, unknown>)["providerStatusText"] === "string"
        ? (err as Record<string, unknown>)["providerStatusText"]
        : null;
    const providerResponseBody =
      (err as Record<string, unknown>)["providerResponseBody"] ?? null;
    console.error("Whop checkout config failed:", msg, "status:", providerStatus);
    await supabaseAdmin
      .from("checkout_sessions")
      .update({
        status: "failed",
        metadata: {
          ...checkoutMetadata,
          error: msg,
          providerStatus,
          providerStatusText,
          providerResponseBody,
        },
      })
      .eq("id", checkoutSessionId);
    return NextResponse.json(
      { success: false, error: "PROVIDER_CHECKOUT_FAILED" },
      { status: 502 }
    );
  }

  // --- update checkout_sessions with provider result ---
  const { error: updateError } = await supabaseAdmin
    .from("checkout_sessions")
    .update({
      provider_checkout_config_id: providerResult.providerCheckoutConfigId,
      provider_plan_id: providerResult.providerPlanId,
      provider_product_id: providerResult.providerProductId ?? productId,
      provider_purchase_url: providerResult.purchaseUrl,
      status: "pending",
      metadata: checkoutMetadata,
    })
    .eq("id", checkoutSessionId);

  if (updateError) {
    console.error("checkout_sessions update failed:", updateError);
    return NextResponse.json(
      { success: false, error: "CHECKOUT_SESSION_UPDATE_FAILED" },
      { status: 500 }
    );
  }

  // Analytics: redirecting the buyer to the Whop-hosted checkout (fail-open).
  await captureServerEvent(PPP_EVENTS.WHOP_CHECKOUT_REDIRECT, {
    distinctId: analyticsDistinctId ?? leadIntentId,
    properties: {
      plan: plan.internalPlanId,
      internal_plan_id: plan.internalPlanId,
      checkoutSessionId,
      source,
      source_surface: source,
      checkout_provider: "whop",
      identity_stitched: Boolean(analyticsDistinctId),
    },
  });

  return NextResponse.json(
    {
      checkoutUrl: providerResult.purchaseUrl,
      checkoutSessionId,
      provider: "whop",
    },
    { status: 200 }
  );
}
