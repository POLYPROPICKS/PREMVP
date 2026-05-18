export type InternalPlanId =
  | "premium_7day_weekly"
  | "premium_monthly"
  | "premium_24h"; // disabled; kept for type compatibility only

export type PaymentMode = "recurring" | "one_time";

export type PlanCatalogEntry = {
  internalPlanId: InternalPlanId;
  displayName: string;
  priceUsd: number;
  renewalPriceUsd: number;
  durationHours: number;
  billingPeriodDays: number;
  enabled: boolean;
  paymentMode: PaymentMode;
  whopProductEnvKey: string;
  note?: string;
  marketingCopy: {
    tagline: string;
    description: string;
    disclaimer: string;
  };
};

const SAFE_COPY = {
  tagline: "Premium Sports Market Intelligence",
  description:
    "Data-backed market insights using pricing movement, probability shifts, and verified market-volume stats.",
  disclaimer: "No guarantee of results.",
};

export const planCatalog: Record<InternalPlanId, PlanCatalogEntry> = {
  premium_7day_weekly: {
    internalPlanId: "premium_7day_weekly",
    displayName: "PolyProPicks 7-Day Premium",
    priceUsd: 15,
    renewalPriceUsd: 15,
    durationHours: 168,
    billingPeriodDays: 7,
    enabled: true,
    paymentMode: "recurring",
    whopProductEnvKey: "WHOP_PRODUCT_ID_7DAY",
    marketingCopy: SAFE_COPY,
  },
  premium_monthly: {
    internalPlanId: "premium_monthly",
    displayName: "PolyProPicks Monthly Pro",
    priceUsd: 49,
    renewalPriceUsd: 49,
    durationHours: 720,
    billingPeriodDays: 30,
    enabled: true,
    paymentMode: "recurring",
    whopProductEnvKey: "WHOP_PRODUCT_ID_MONTHLY",
    marketingCopy: SAFE_COPY,
  },
  premium_24h: {
    internalPlanId: "premium_24h",
    displayName: "24-Hour Premium Access",
    priceUsd: 4.99,
    renewalPriceUsd: 0,
    durationHours: 24,
    billingPeriodDays: 1,
    enabled: false,
    paymentMode: "one_time",
    whopProductEnvKey: "WHOP_PRODUCT_ID",
    note: "Disabled in production. Legacy one-time plan.",
    marketingCopy: SAFE_COPY,
  },
};

export const DEFAULT_INTERNAL_PLAN_ID: InternalPlanId = "premium_7day_weekly";

export function getPlanById(internalPlanId: string): PlanCatalogEntry | null {
  // Temporary backward compatibility alias
  const canonical =
    internalPlanId === "premium_7day" ? "premium_7day_weekly" : internalPlanId;
  return planCatalog[canonical as InternalPlanId] ?? null;
}

export function getEnabledPlanById(
  internalPlanId: string
): PlanCatalogEntry | null {
  const plan = getPlanById(internalPlanId);
  return plan?.enabled ? plan : null;
}

export function getWhopProductIdForPlan(
  plan: PlanCatalogEntry
): string | null {
  const val = process.env[plan.whopProductEnvKey];
  return typeof val === "string" && val.length > 0 ? val : null;
}
