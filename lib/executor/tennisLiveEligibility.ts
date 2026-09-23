// lib/executor/tennisLiveEligibility.ts
//
// R0-TENNIS — the shared live-money TENNIS eligibility gate.
//
// TENNIS is money-eligible only when every one of the following holds:
//   1. the market's structured type (the provider's own market_type field) is
//      exactly "moneyline" -- the real full-match WINNER market. A structured
//      type of "tennis_completed_match" is a DIFFERENT proposition ("will the
//      match complete normally", a Yes/No market) and is always rejected, even
//      though its display text often contains the words "Completed Match".
//      There is NO text fallback: when structured moneyline authority is
//      absent, the gate fails closed and rejects the candidate outright --
//      it never falls back to guessing eligibility from display text.
//   2. a visible event identity exists (an event title, or failing that an
//      event slug) -- a candidate with no human-readable identity can never
//      become money-eligible, structured type notwithstanding.
//   3. the event identity + market text do not name a lower-tier ITF level
//      (M15/M25/W15/W35/W50), a Juniors draw, or an explicit Qualifying
//      draw -- those are excluded outright even from an otherwise-valid
//      moneyline market.
//
// Pure text/field checks only -- no DB, no network, no clock. Applied
// upstream of Reservation (see resolveUpstreamMarketPolicy in
// buildFireModelCandidates.ts) so every live model inherits the same rule.

const TENNIS_STRUCTURED_MONEYLINE = "moneyline";
const TENNIS_STRUCTURED_COMPLETED_MATCH = "tennis_completed_match";

// ITF lower-tier levels (M15/M25/W15/W35/W50), Juniors and explicit
// Qualifying draws are excluded even when the market itself is an otherwise
// eligible moneyline.
const TENNIS_EXCLUDED_LEVEL_RE = /\b(?:m15|m25|w15|w35|w50)\b|\bjuniors?\b|\bqualifying\b/i;

export type TennisMoneyEligibilityReasonCode =
  | "TENNIS_MARKET_TYPE_NOT_MONEYLINE"
  | "TENNIS_COMPLETED_MATCH_MARKET_REJECTED"
  | "TENNIS_NO_EVENT_IDENTITY"
  | "TENNIS_EXCLUDED_TOURNAMENT_LEVEL"
  | "TENNIS_MONEY_ELIGIBLE";

export interface TennisMoneyEligibilityInput {
  /** The provider's own structured market_type field, when present. */
  structuredMarketType?: string | null;
  /** The market's display text -- used only for the tournament-level exclusion check. */
  marketText?: string | null;
  /** Visible event identity: event title, or failing that, an event slug. */
  eventIdentityText?: string | null;
}

export interface TennisMoneyEligibilityDecision {
  eligible: boolean;
  reasonCode: TennisMoneyEligibilityReasonCode;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

function normalizedStructuredType(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase();
}

/**
 * The shared TENNIS live-money gate. Applied before Reservation so every live
 * model (Contract A Planning, PORTFOLIO_BROAD, ...) inherits the same rule.
 */
export function resolveTennisMoneyEligibility(
  input: TennisMoneyEligibilityInput,
): TennisMoneyEligibilityDecision {
  const structuredType = normalizedStructuredType(trimmedOrNull(input.structuredMarketType));
  const marketText = trimmedOrNull(input.marketText);
  const eventIdentityText = trimmedOrNull(input.eventIdentityText);

  if (structuredType === TENNIS_STRUCTURED_COMPLETED_MATCH) {
    return { eligible: false, reasonCode: "TENNIS_COMPLETED_MATCH_MARKET_REJECTED" };
  }
  if (structuredType !== TENNIS_STRUCTURED_MONEYLINE) {
    return { eligible: false, reasonCode: "TENNIS_MARKET_TYPE_NOT_MONEYLINE" };
  }
  if (eventIdentityText === null) {
    return { eligible: false, reasonCode: "TENNIS_NO_EVENT_IDENTITY" };
  }
  const combinedText = `${eventIdentityText} ${marketText ?? ""}`;
  if (TENNIS_EXCLUDED_LEVEL_RE.test(combinedText)) {
    return { eligible: false, reasonCode: "TENNIS_EXCLUDED_TOURNAMENT_LEVEL" };
  }
  return { eligible: true, reasonCode: "TENNIS_MONEY_ELIGIBLE" };
}
