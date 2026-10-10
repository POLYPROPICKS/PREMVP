// LIVE_MONEY_FAMILY_AUTHORITY_V1 -- the ONE canonical answer to "may this market family carry NEW real money?".
//
// Observational capture, telemetry and off-policy research stay free to see every B-universe family
// (see ObservationalMarketFamily / isBSupportFamilyEligible). This authority only decides which families may
// obtain LIVE economic authority: economic selection, executable Queue admission, executor handoff and
// MAKER_FALLBACK_1 exposure.
//
// SPREADS is deliberately absent from the live set (Founder decision: SPREADS = OFF for real money).
export const LIVE_MONEY_FAMILIES: ReadonlySet<string> = new Set(["MONEYLINE", "TOTALS", "TOTAL_CORNERS"]);

/** Every canonical family the B universe can classify; anything here that is not live is observation-only. */
const B_UNIVERSE_FAMILIES: ReadonlySet<string> = new Set(["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);

const norm = (family: string | null | undefined): string => (typeof family === "string" ? family.trim().toUpperCase() : "");

/** Strict (fail closed): unknown, null or empty family => not live. Used where a canonical family is mandatory. */
export function isLiveMoneyFamilyEligible(family: string | null | undefined): boolean {
  return LIVE_MONEY_FAMILIES.has(norm(family));
}

/**
 * Queue-row edges (admission, executor handoff, fallback): true only for a canonical B-universe family that is
 * NOT live (SPREADS). Rows that carry no canonical family (manual / legacy writers) are outside this decision.
 */
export function isObservationOnlyMoneyFamily(family: string | null | undefined): boolean {
  const f = norm(family);
  return B_UNIVERSE_FAMILIES.has(f) && !LIVE_MONEY_FAMILIES.has(f);
}

export const LIVE_MONEY_FAMILY_NOT_AUTHORIZED = "LIVE_MONEY_FAMILY_NOT_AUTHORIZED" as const;

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
