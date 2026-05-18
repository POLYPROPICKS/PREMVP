const WHOP_CHECKOUT_CONFIGS_URL =
  "https://api.whop.com/api/v1/checkout_configurations";

export type WhopCheckoutParams = {
  companyId: string;
  productId: string;
  internalPlanId: string;
  displayName: string;
  priceUsd: number;
  renewalPriceUsd: number;
  billingPeriodDays: number;
  paymentMode: "recurring" | "one_time";
  source: string;
  leadIntentId: string;
  checkoutSessionId: string;
  appUrl: string;
};

export type WhopCheckoutResult = {
  providerCheckoutConfigId: string;
  providerPlanId: string | null;
  providerProductId: string | null;
  purchaseUrl: string;
  raw: Record<string, unknown>;
};

export async function createWhopCheckoutConfiguration(
  params: WhopCheckoutParams
): Promise<WhopCheckoutResult> {
  const {
    companyId,
    internalPlanId,
    priceUsd,
    renewalPriceUsd,
    billingPeriodDays,
    paymentMode,
    source,
    leadIntentId,
    checkoutSessionId,
    appUrl,
  } = params;

  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) {
    throw new Error("MISSING_ENV: WHOP_API_KEY not set");
  }

  const planType = paymentMode === "recurring" ? "renewal" : "one_time";

  const body = {
    plan: {
      company_id: companyId,
      product_id: params.productId,
      currency: "usd",
      plan_type: planType,
      release_method: "buy_now",
      initial_price: priceUsd,
      renewal_price: renewalPriceUsd,
      billing_period: billingPeriodDays,
      visibility: "visible",
      adaptive_pricing_enabled: true,
    },
    metadata: {
      internalPlanId,
      leadIntentId,
      checkoutSessionId,
      source,
    },
    mode: "payment",
    redirect_url: `${appUrl}/checkout/complete`,
    source_url: appUrl,
  };

  const response = await fetch(WHOP_CHECKOUT_CONFIGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    let parsedBody: unknown = rawText;
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      // keep as text
    }
    const err = new Error(
      `PROVIDER_CHECKOUT_FAILED: Whop returned ${response.status}`
    ) as Error & {
      providerStatus: number;
      providerStatusText: string;
      providerResponseBody: unknown;
    };
    err.providerStatus = response.status;
    err.providerStatusText = response.statusText ?? "";
    err.providerResponseBody = parsedBody;
    throw err;
  }

  const json = (await response.json()) as Record<string, unknown>;

  const purchaseUrl =
    typeof json["purchase_url"] === "string" ? json["purchase_url"] : null;

  if (!purchaseUrl) {
    throw new Error("PROVIDER_CHECKOUT_FAILED: missing purchase_url in response");
  }

  const plan = json["plan"] as Record<string, unknown> | undefined;
  const product = json["product"] as Record<string, unknown> | undefined;

  return {
    providerCheckoutConfigId: typeof json["id"] === "string" ? json["id"] : "",
    providerPlanId: typeof plan?.["id"] === "string" ? plan["id"] : null,
    providerProductId:
      typeof product?.["id"] === "string" ? product["id"] : null,
    purchaseUrl,
    raw: json,
  };
}
