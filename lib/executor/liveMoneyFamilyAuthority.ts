// LIVE_MONEY_FAMILY_AUTHORITY_V1 -- the ONE canonical answer to "may this market family carry NEW real money?".
//
// Observational capture, telemetry and off-policy research stay free to see every B-universe family
// (see ObservationalMarketFamily / isBSupportFamilyEligible). This authority only decides which families may
// obtain LIVE economic authority: economic selection, executable Queue admission, executor handoff and
// MAKER_FALLBACK_1 exposure.
//
// Founder decision 2026-10-15: only canonical MONEYLINE may receive NEW live authority.
export const FOUNDER_MONEYLINE_ONLY_LIVE = "FOUNDER_MONEYLINE_ONLY_LIVE_2026_10_15" as const;
export const LIVE_MONEY_FAMILIES: ReadonlySet<string> = new Set(["MONEYLINE"]);

const norm = (family: string | null | undefined): string => (typeof family === "string" ? family.trim().toUpperCase() : "");

/** Strict (fail closed): unknown, null or empty family => not live. Used where a canonical family is mandatory. */
export function isLiveMoneyFamilyEligible(family: string | null | undefined): boolean {
  return LIVE_MONEY_FAMILIES.has(norm(family));
}

/**
 * Queue-row edges (admission, executor handoff, fallback): fail closed for every family outside
 * the live set, including missing/unknown families on manual or legacy rows.
 */
export function isObservationOnlyMoneyFamily(family: string | null | undefined): boolean {
  return !isLiveMoneyFamilyEligible(family);
}

export const LIVE_MONEY_FAMILY_NOT_AUTHORIZED = FOUNDER_MONEYLINE_ONLY_LIVE;

/** Thrown at the executable Queue money boundary when an observation-only family row is attempted. */
export class LiveMoneyFamilyNotAuthorizedError extends Error {
  readonly code = LIVE_MONEY_FAMILY_NOT_AUTHORIZED;
  constructor(surface: string, family: string | null | undefined) {
    super(`${LIVE_MONEY_FAMILY_NOT_AUTHORIZED}: ${surface} family=${family ?? "null"}`);
    this.name = "LiveMoneyFamilyNotAuthorizedError";
  }
}

// FOUNDER_TOTALS_OVER_LIVE_OFF_2026_10_10 -- Founder decision: NO NEW real-money bet on TOTALS Over (any line).
// Side-level live authority, evaluated alongside the family authority above. Research / shadow / telemetry stay
// free to see TOTALS Over; only NEW live economic selection, Queue admission, executor handoff and fallback
// exposure are refused. Already-executed positions, settlement and callbacks are untouched.
export const FOUNDER_TOTALS_OVER_LIVE_OFF = "FOUNDER_TOTALS_OVER_LIVE_OFF_2026_10_10" as const;

/** TOTALS family + an Over side (e.g. "Over", "Over 2.5", "OVER"), regardless of line. TOTAL_CORNERS is a different family. */
export function isFounderLiveOffTotalsOver(family: string | null | undefined, side: string | null | undefined): boolean {
  return norm(family) === "TOTALS" && /^over(?![a-z])/i.test(typeof side === "string" ? side.trim() : "");
}

/** Thrown at the executable Queue money boundary when a TOTALS Over row is attempted. */
export class FounderTotalsOverLiveOffError extends Error {
  readonly code = FOUNDER_TOTALS_OVER_LIVE_OFF;
  constructor(surface: string) {
    super(`${FOUNDER_TOTALS_OVER_LIVE_OFF}: ${surface}`);
    this.name = "FounderTotalsOverLiveOffError";
  }
}
