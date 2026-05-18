export type InternalPlanId =
  | "premium_24h"
  | "premium_7day"
  | "premium_monthly";

export type PaymentMode = "one_time" | "recurring_monthly";

export type PlanCatalogEntry = {
  internalPlanId: InternalPlanId;
  displayName: string;
  priceUsd: number;
  durationHours: number;
  enabled: boolean;
  paymentMode: PaymentMode;
  note?: string;
  marketingCopy: {
    tagline: string;
    description: string;
    disclaimer: string;
  };
};

export const planCatalog: Record<InternalPlanId, PlanCatalogEntry> = {
  premium_24h: {
    internalPlanId: "premium_24h",
    displayName: "24-Hour Premium Access",
    priceUsd: 4.99,
    durationHours: 24,
    enabled: true,
    paymentMode: "one_time",
    marketingCopy: {
      tagline: "Premium Sports Market Intelligence",
      description:
        "24-hour access to data-backed market insights: pricing movement, probability shifts, and verified market-volume stats.",
      disclaimer: "No guarantee of results.",
    },
  },
  premium_7day: {
    internalPlanId: "premium_7day",
    displayName: "7-Day Premium Access",
    priceUsd: 15,
    durationHours: 168,
    enabled: true,
    paymentMode: "one_time",
    marketingCopy: {
      tagline: "Premium Sports Market Intelligence",
      description:
        "7-day access to data-backed market insights: pricing movement, probability shifts, and verified market-volume stats.",
      disclaimer: "No guarantee of results.",
    },
  },
  premium_monthly: {
    internalPlanId: "premium_monthly",
    displayName: "Monthly Premium Access",
    priceUsd: 49,
    durationHours: 720,
    enabled: false,
    paymentMode: "recurring_monthly",
    note: "Recurring handling is not enabled in v0.1.",
    marketingCopy: {
      tagline: "Premium Sports Market Intelligence",
      description:
        "Monthly access to data-backed market insights: pricing movement, probability shifts, and verified market-volume stats.",
      disclaimer: "No guarantee of results.",
    },
  },
};

export const DEFAULT_INTERNAL_PLAN_ID: InternalPlanId = "premium_7day";

export function getPlanById(internalPlanId: string): PlanCatalogEntry | null {
  return planCatalog[internalPlanId as InternalPlanId] ?? null;
}

export function getEnabledPlanById(
  internalPlanId: string
): PlanCatalogEntry | null {
  const plan = getPlanById(internalPlanId);
  return plan?.enabled ? plan : null;
}
