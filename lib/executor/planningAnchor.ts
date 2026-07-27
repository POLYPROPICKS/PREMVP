import type { MarketAnchorDecision, MarketAnchorInput } from "../contur3/taxonomy";

/**
 * R0J — the PLANNING-stage anchor decision.
 *
 * Production night-plan:2026-07-27 reserved nothing: 30 physical events were
 * executable-anchor eligible and 0 were full-match-anchor eligible. After
 * de-duplicating the report's three-group HTTP preview against the complete
 * evidence, 30 unique rejected groups remained -- 24 eSports (correctly rejected
 * by PARTIAL_EVENT_SCOPE / ESPORTS_NON_POLICY) and 6 baseball, every one of them:
 *
 *   sport=baseball  event_scope=full_match  evidence_source=structured
 *   market_class=unknown  reason_code=UNKNOWN_MARKET_CLASS
 *
 * with provider_market_question equal to the bare matchup title, e.g.
 * "Atlanta Braves vs. New York Mets".
 *
 * That is an EVENT-LEVEL representation of a physical game, not a malformed
 * market. The planning stage was requiring it to name an executable market class
 * (moneyline / spread / total) hours before the T-90 authoritative decision that
 * assigns one exists -- the same category error that R0F fixed for identity.
 *
 * The two stages have two different questions:
 *
 *   17:00 planning      "is this a real full-match physical event worth a slot?"
 *   T-70..T-3 rebalance "which exact allowed market, condition, token and side?"
 *
 * This module answers ONLY the first. It never mutates the canonical
 * MarketAnchorDecision, never makes UNKNOWN_MARKET_CLASS globally allowed, and
 * cannot reach the execution queue: a STRUCTURED_FULLMATCH_EVENT anchor carries
 * no condition_id, token_id or side, so the final fail-closed gate still has to
 * resolve and validate an exact allowed market before anything is queued.
 */

export type PlanningAnchorKind = "EXECUTABLE_MARKET" | "STRUCTURED_FULLMATCH_EVENT" | "REJECTED";

export interface PlanningAnchorDecision {
  allowed_for_planning: boolean;
  anchor_kind: PlanningAnchorKind;
  reason_code: string;
}

/**
 * Sports that may use the event-level planning anchor. eSports is excluded
 * outright: its full-match policy is the canonical BO-series exception in
 * fullMatchAnchorDecision, and every eSports surface in the production corpus is
 * already rejected for a DIFFERENT reason (PARTIAL_EVENT_SCOPE /
 * ESPORTS_NON_POLICY), so it can never reach the market_class==="unknown" branch.
 * "unknown" is excluded because an unclassified sport is not a supported one.
 */
const PLANNING_EVENT_LEVEL_EXCLUDED_SPORTS = new Set(["esport", "esports", "unknown", ""]);

/**
 * A bare two-competitor matchup and NOTHING else: "A vs B" / "A vs. B", anchored
 * end to end. The anchoring is the safety property. A market that merely mentions
 * two competitors carries additional wording and therefore fails:
 *
 *   "Atlanta Braves vs. New York Mets"                    -> event-level  ✓
 *   "Dota 2: YBN Team vs VooDooSh Team (BO3)"             -> prefix+suffix ✗
 *   "Valorant: ORA Temper vs SaD GC - Map 1 Winner"       -> prefix+suffix ✗
 *   "Map Handicap: AUR.YB (-1.5) vs Young TigeRES (+1.5)" -> prefix        ✗
 *   "Will anything at all happen in fixture 0?"           -> no matchup    ✗
 */
const EVENT_LEVEL_MATCHUP_RE = /^([^:@()\[\]]+?)\s+(?:vs\.?|v\.?)\s+([^:@()\[\]]+?)$/i;

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Loose comparison key: case/punctuation-insensitive. */
function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True when the text is a bare matchup between two identified competitors and
 * carries no market wording of any kind.
 */
export function isEventLevelMatchupText(value: unknown): boolean {
  const text = trimmedOrNull(value);
  if (text === null) return false;
  // A market-wording separator disqualifies immediately: every real market in the
  // production corpus uses ":" or " - " to attach its market phrase.
  if (text.includes(":") || /\s[-–—]\s/.test(text)) return false;
  const match = text.match(EVENT_LEVEL_MATCHUP_RE);
  if (!match) return false;
  const [, left, right] = match;
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  // Both competitors must be real, distinct and non-trivial.
  if (a.length < 2 || b.length < 2) return false;
  if (a === b) return false;
  return true;
}

function isSupportedNonEsportSport(sport: unknown): boolean {
  const value = trimmedOrNull(sport);
  if (value === null) return false;
  return !PLANNING_EVENT_LEVEL_EXCLUDED_SPORTS.has(value.toLowerCase());
}

/**
 * The planning-stage verdict for one candidate.
 *
 * Every input is a decision the planner has ALREADY made -- the existing
 * fullMatchAnchorDecision verdict, the canonical MarketAnchorDecision and the
 * MarketAnchorInput it was read from. Nothing is re-classified here, and this
 * module deliberately imports no planner code, so there is no import cycle.
 *
 * An already-allowed executable market is admitted unchanged (EXECUTABLE_MARKET)
 * -- that path is byte-identical to the previous behaviour. The event-level path
 * is additive and narrow, and every other case stays fail-closed.
 */
export function resolvePlanningAnchorDecision(input: {
  /** Verdict of the existing planning anchor (fullMatchAnchorDecision). */
  existingAnchorAllowed: boolean;
  /** The canonical taxonomy decision, unmodified. */
  canonical: MarketAnchorDecision;
  /** The surfaces that decision was read from. */
  anchorInput: MarketAnchorInput;
  /** candidate.inferred_sport */
  sport: string | null;
}): PlanningAnchorDecision {
  const { canonical, anchorInput } = input;

  // 1. Whatever the existing planning anchor already allows, keep allowing --
  //    identically, including the canonical eSports BO-series exception.
  if (input.existingAnchorAllowed) {
    return {
      allowed_for_planning: true,
      anchor_kind: "EXECUTABLE_MARKET",
      reason_code: "EXECUTABLE_MARKET",
    };
  }

  // 2. The event-level branch is entered ONLY from the exact production
  //    signature. Any other rejection reason (ACTIVITY_LABEL,
  //    FORBIDDEN_MARKET_CLASS, ESPORTS_NON_POLICY, PARTIAL_EVENT_SCOPE) is
  //    untouched and stays rejected -- this is what keeps the whole eSports and
  //    partial-market corpus out.
  if (canonical.reason_code !== "UNKNOWN_MARKET_CLASS") {
    return { allowed_for_planning: false, anchor_kind: "REJECTED", reason_code: canonical.reason_code ?? "REJECTED" };
  }
  if (canonical.market_class !== "unknown") {
    return { allowed_for_planning: false, anchor_kind: "REJECTED", reason_code: "UNKNOWN_MARKET_CLASS" };
  }
  if (canonical.event_scope !== "full_match") {
    return { allowed_for_planning: false, anchor_kind: "REJECTED", reason_code: "PARTIAL_EVENT_SCOPE" };
  }
  // Only the provider's OWN question may authorise an event-level anchor. A
  // derived title or a slug is not strong enough evidence to reserve a slot.
  if (canonical.evidence_source !== "structured") {
    return { allowed_for_planning: false, anchor_kind: "REJECTED", reason_code: "PLANNING_EVENT_LEVEL_NOT_STRUCTURED" };
  }
  if (!isSupportedNonEsportSport(input.sport)) {
    return { allowed_for_planning: false, anchor_kind: "REJECTED", reason_code: "PLANNING_EVENT_LEVEL_UNSUPPORTED_SPORT" };
  }

  const question = trimmedOrNull(anchorInput.providerMarketQuestion);
  if (question === null || !isEventLevelMatchupText(question)) {
    return { allowed_for_planning: false, anchor_kind: "REJECTED", reason_code: "PLANNING_EVENT_LEVEL_NOT_MATCHUP" };
  }
  // The question must describe the SAME physical matchup as the event title,
  // so a market question can never be mistaken for its own event.
  const eventTitle = trimmedOrNull(anchorInput.eventTitle);
  if (eventTitle !== null && normalizeForCompare(eventTitle) !== normalizeForCompare(question)) {
    return { allowed_for_planning: false, anchor_kind: "REJECTED", reason_code: "PLANNING_EVENT_LEVEL_TITLE_MISMATCH" };
  }

  return {
    allowed_for_planning: true,
    anchor_kind: "STRUCTURED_FULLMATCH_EVENT",
    reason_code: "PLANNING_EVENT_LEVEL_FULLMATCH",
  };
}
