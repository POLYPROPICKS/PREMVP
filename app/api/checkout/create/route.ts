import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getEnabledPlanById } from "@/lib/payments/planCatalog";
import { createWhopCheckoutConfiguration } from "@/lib/payments/whopCheckout";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreateCheckoutBody = {
  internalPlanId?: unknown;
  leadIntentId?: unknown;
  source?: unknown;
  email?: unknown;
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
  const missingEnv: string[] = [];
  if (!process.env.WHOP_API_KEY) missingEnv.push("WHOP_API_KEY");
  if (!process.env.WHOP_COMPANY_ID) missingEnv.push("WHOP_COMPANY_ID");
  if (!process.env.WHOP_PRODUCT_ID) missingEnv.push("WHOP_PRODUCT_ID");
  if (!process.env.NEXT_PUBLIC_APP_URL) missingEnv.push("NEXT_PUBLIC_APP_URL");
  if (missingEnv.length > 0) {
    return NextResponse.json(
      { success: false, error: "MISSING_ENV", missing: missingEnv },
      { status: 500 }
    );
  }

  const companyId = process.env.WHOP_COMPANY_ID!;
  const productId = process.env.WHOP_PRODUCT_ID!;
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
  const internalPlanId =
    typeof body.internalPlanId === "string" ? body.internalPlanId : "";
  const plan = getEnabledPlanById(internalPlanId);
  if (!plan) {
    return NextResponse.json(
      { success: false, error: "INVALID_PLAN" },
      { status: 400 }
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
      metadata: { internalPlanId: plan.internalPlanId, leadIntentId, source },
      // checkoutSessionId added to metadata after insert (id not yet known at this point)
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

  const checkoutMetadata = {
    internalPlanId: plan.internalPlanId,
    leadIntentId,
    checkoutSessionId,
    source,
  };

  // --- call Whop provider ---
  let providerResult: Awaited<ReturnType<typeof createWhopCheckoutConfiguration>>;
  try {
    providerResult = await createWhopCheckoutConfiguration({
      companyId,
      productId,
      internalPlanId: plan.internalPlanId,
      displayName: plan.displayName,
      priceUsd: plan.priceUsd,
      source,
      leadIntentId,
      checkoutSessionId,
      appUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("Whop checkout config failed:", msg);
    await supabaseAdmin
      .from("checkout_sessions")
      .update({ status: "failed", metadata: { ...checkoutMetadata, error: msg } })
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

  return NextResponse.json(
    {
      checkoutUrl: providerResult.purchaseUrl,
      checkoutSessionId,
      provider: "whop",
    },
    { status: 200 }
  );
}
