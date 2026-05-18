const WHOP_CHECKOUT_CONFIGS_URL =
  "https://api.whop.com/api/v1/checkout_configurations";

export type WhopCheckoutParams = {
  companyId: string;
  productId: string;
  internalPlanId: string;
  displayName: string;
  priceUsd: number;
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
    productId,
    internalPlanId,
    priceUsd,
    source,
    leadIntentId,
    checkoutSessionId,
  } = params;

  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) {
    throw new Error("MISSING_ENV: WHOP_API_KEY not set");
  }

  const body = {
    company_id: companyId,
    product_id: productId,
    plan: {
      initial_price: priceUsd,
      plan_type: "one_time",
    },
    metadata: {
      internalPlanId,
      leadIntentId,
      checkoutSessionId,
      source,
    },
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
    throw new Error(
      `PROVIDER_CHECKOUT_FAILED: Whop returned ${response.status}`
    );
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
