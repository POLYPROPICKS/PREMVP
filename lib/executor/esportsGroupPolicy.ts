// lib/executor/esportsGroupPolicy.ts
//
// GROUP-level esports full-match policy. PURE: no DB, no env, no clock, no I/O,
// no mutation of any source row. It re-classifies nothing — every input is a
// canonical MarketAnchorDecision the planner has ALREADY made.
//
// Why a group-level seam exists at all
// ------------------------------------
// The canonical taxonomy answers two questions per MARKET (what class, what
// scope). It cannot answer the founder's question, which is about the PHYSICAL
// EVENT: "does this occurrence offer only whole-match betting, or does it also
// offer true sub-event lines?" That is a property of the whole candidate set,
// so it can only be decided where the group is assembled.
//
// The founder policy, from night-plan:2026-07-30:1700-minsk:
//
//   ALLOW  — every market in the group settles over the whole match/series
//            (groups 7, 9, 18: clean Counter-Strike / LoL BO1 occurrences)
//   REJECT — the group also carries a true sub-event market: Map N, Game N,
//            round handicap, map total rounds, kills, first blood, Baron/Roshan
//            (groups 5, 6, 13)
//
// Fail-closed by construction: ONE impure candidate rejects the ENTIRE group.
// The clean whole-match sibling is deliberately NOT harvested out of a mixed
// group — a mixed occurrence is exactly where a per-map line can be mistaken
// for the series result, which is the risk this policy exists to prevent.
//
// Scope of authority: this module decides ONE seam — full-match anchor
// eligibility for esports groups. It never touches timing, identity, tier,
// liquidity, slot allocation or persistence, and it returns NOT_ESPORTS_GROUP
// for every non-esports sport so those paths are bit-for-bit unchanged.

import type { MarketAnchorDecision } from "../contur3/taxonomy";

export type EsportsGroupPolicyVerdict =
  /** Not an esports group — the caller must not change its existing behaviour. */
  | "NOT_ESPORTS_GROUP"
  /** Every candidate settles over the whole match/series. */
  | "ALLOW_CLEAN_ESPORTS_FULL_MATCH"
  /** At least one candidate is a true sub-event: the whole group is rejected. */
  | "REJECT_GROUP_MIXED_SCOPE"
  /** Pure, but nothing in it qualifies as a whole-match esports anchor. */
  | "REJECT_NO_ESPORTS_FULL_MATCH_CANDIDATE";

export interface EsportsGroupPolicyDecision {
  verdict: EsportsGroupPolicyVerdict;
  esports_group: boolean;
  /** Candidates that qualify as a whole-match esports anchor. */
  full_match_candidate_count: number;
  /** Candidates that prove the group is NOT purely whole-match. */
  impure_candidate_count: number;
  /**
   * Canonical reason codes of the impure candidates, deduplicated and sorted.
   * Safe diagnostic context only — never a title, slug, credential or env value.
   */
  impure_reason_codes: string[];
}

export interface EsportsGroupPolicyCandidate {
  /** The canonical taxonomy decision, unmodified. */
  canonical: MarketAnchorDecision;
}

export interface EsportsGroupPolicyInput {
  /** candidate.inferred_sport for the group. */
  sport: string | null;
  candidates: EsportsGroupPolicyCandidate[];
}

/**
 * Sports this policy governs. Matched on the planner's own `inferred_sport`
 * value — never on a team name, tournament name or title substring.
 */
const ESPORTS_SPORTS = new Set(["esport", "esports"]);

export function isEsportsSport(sport: string | null | undefined): boolean {
  if (typeof sport !== "string") return false;
  return ESPORTS_SPORTS.has(sport.trim().toLowerCase());
}

/**
 * A candidate proves the group is NOT purely whole-match.
 *
 * Two independent kinds of evidence, both already decided by the canonical
 * taxonomy:
 *   - a narrowed event scope (map/round/game N, halves, props, kills), which is
 *     what Map 1 Total Rounds and Game 1 Winner produce;
 *   - a forbidden market class (props, exact score, goalscorer, corners),
 *     which is a prop line regardless of the scope it was read at.
 *
 * Fail-closed: anything that is not positively whole-match counts as impure.
 */
function isImpureCandidate(canonical: MarketAnchorDecision): boolean {
  if (canonical.event_scope !== "full_match") return true;
  if (canonical.market_class.startsWith("forbidden_")) return true;
  return false;
}

/**
 * A candidate that can anchor a clean esports occurrence: it settles over the
 * whole match/series AND names a real market.
 *
 * `esports_non_policy` is admitted here — and ONLY here, behind the group
 * purity check — because it is the class the canonical taxonomy assigns to
 * every esports market by virtue of the sport, not because the market is a
 * sub-event. `unknown` is deliberately NOT admitted: an unclassified market is
 * not proof of a whole-match line, so it neither qualifies nor poisons.
 */
export function isCleanEsportsFullMatchCandidate(canonical: MarketAnchorDecision): boolean {
  if (isImpureCandidate(canonical)) return false;
  if (canonical.allowed) return true;
  return canonical.market_class === "esports_non_policy";
}

/**
 * The group verdict. Deterministic and order-independent: it is a fold over the
 * candidate set, so the same set always yields the same decision.
 */
export function resolveEsportsGroupPolicy(
  input: EsportsGroupPolicyInput
): EsportsGroupPolicyDecision {
  if (!isEsportsSport(input.sport)) {
    return {
      verdict: "NOT_ESPORTS_GROUP",
      esports_group: false,
      full_match_candidate_count: 0,
      impure_candidate_count: 0,
      impure_reason_codes: [],
    };
  }

  const impure = input.candidates.filter(({ canonical }) => isImpureCandidate(canonical));
  const fullMatch = input.candidates.filter(({ canonical }) =>
    isCleanEsportsFullMatchCandidate(canonical)
  );

  const impureReasonCodes = [
    ...new Set(
      impure.map(({ canonical }) => canonical.reason_code ?? "UNSPECIFIED")
    ),
  ].sort();

  const base = {
    esports_group: true,
    full_match_candidate_count: fullMatch.length,
    impure_candidate_count: impure.length,
    impure_reason_codes: impureReasonCodes,
  };

  // Fail-closed first: one true sub-event rejects the whole physical group,
  // even when a clean whole-match sibling is present.
  if (impure.length > 0) return { verdict: "REJECT_GROUP_MIXED_SCOPE", ...base };
  if (fullMatch.length === 0) {
    return { verdict: "REJECT_NO_ESPORTS_FULL_MATCH_CANDIDATE", ...base };
  }
  return { verdict: "ALLOW_CLEAN_ESPORTS_FULL_MATCH", ...base };
}
