// Contur3 — CANONICAL market taxonomy (single source of truth).
//
// Recovery contract: docs/ai-context/CONTUR3_RECOVERY_INVARIANTS.md §5.
// Pure functions only: no env, no DB, no network, no side effects.
//
// Rules:
//  - forbidden wins over allowed ("halftime total" is forbidden);
//  - unknown is fail-closed (never live-allowed);
//  - esports is an explicit non-policy class (fail-closed for live);
//  - classification runs on tokenized text so word-boundary patterns work
//    (legacy copies stripped all separators first, which killed \bdraw\b/\bou\b
//    and made /under/ match inside team names like "Sunderland").
//
// Legacy copies this module supersedes (kept runtime-compatible until each is
// migrated with an explicit founder decision — see CONTUR3_NEXT_PATCH_DESIGN_BRIEF §9/§11):
//  - scripts/contur3/lib/contur3LiveFunnelMonitor.mjs classifyMarket (parity-locked by
//    tests/contur3/taxonomy.corpus.test.ts);
//  - lib/executor/eventExecutionQueue.ts HALFTIME_MARKET_RE (halftime-only);
//  - app/api/executor/night-plan/route.ts HALFTIME_MARKET_RE (halftime-only);
//  - PR7 classifyFullmatchMarket (superseded by this module).

export type MarketClass =
  | "allowed_fullmatch_moneyline"
  | "allowed_fullmatch_spread"
  | "allowed_fullmatch_total"
  | "forbidden_halftime"
  | "forbidden_corners"
  | "forbidden_exact_score"
  | "forbidden_goalscorer"
  | "forbidden_props"
  | "forbidden_futures"
  | "esports_non_policy"
  | "unknown";

// Diacritic-insensitive tokenizer: lowercase, strip combining marks, split on
// every non-alphanumeric run. "Côte d’Ivoire" -> ["cote","d","ivoire"].
function tokensOf(input: unknown): string[] {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Canonical normalized form: diacritic-free lowercase tokens joined by single spaces. */
export function normalizeMarketText(input: unknown): string {
  return tokensOf(input).join(" ");
}

// Two matching surfaces:
//  - `joined` ("half time result") — word boundaries are real; use for
//    short/ambiguous words that must match whole tokens only.
//  - `squashed` ("halftimeresult") — separator-insensitive; use for compound
//    market phrases that appear both spaced and fused.
const FORBIDDEN_HALFTIME_SQ = /halftime|firsthalf|1sthalf|secondhalf|2ndhalf/;
const FORBIDDEN_CORNERS_SQ = /corner/;
const FORBIDDEN_EXACTSCORE_SQ = /exactscore|correctscore/;
const FORBIDDEN_GOALSCORER_SQ = /goalscorer|anytimescorer|firstscorer|lastscorer|scorer/;
const FORBIDDEN_PROPS_SQ = /playerprop|bookings|bothteamstoscore/;
const FORBIDDEN_PROPS_TOKEN = /\bbtts\b|\bcards?\b|\bprops?\b/;
const FORBIDDEN_FUTURES_SQ = /outright|towinoutright|winnergroup/;
const FORBIDDEN_FUTURES_TOKEN = /\bfutures?\b/;
const ESPORTS_SQ = /esports|csgo|dota|leagueoflegends|valorant|counterstrike/;
const ESPORTS_TOKEN = /\bcs2\b/;
const ALLOWED_MONEYLINE_SQ = /moneyline|matchwinner|towin|matchresult|winner|drawnobet|1x2/;
const ALLOWED_MONEYLINE_TOKEN = /\bdraw\b/;
const ALLOWED_SPREAD_SQ = /spread|handicap/;
const ALLOWED_TOTAL_SQ = /totalgoals|overunder/;
const ALLOWED_TOTAL_TOKEN = /\bou\b|\btotals?\b|\bover\b|\bunder\b/;

/**
 * Classify raw market/identity text into the canonical market class.
 * Forbidden classes win over allowed; unrecognized text is "unknown" (fail-closed).
 */
export function classifyMarketText(input: unknown): MarketClass {
  const tokens = tokensOf(input);
  const joined = tokens.join(" ");
  const squashed = tokens.join("");

  if (FORBIDDEN_HALFTIME_SQ.test(squashed)) return "forbidden_halftime";
  if (FORBIDDEN_CORNERS_SQ.test(squashed)) return "forbidden_corners";
  if (FORBIDDEN_EXACTSCORE_SQ.test(squashed)) return "forbidden_exact_score";
  if (FORBIDDEN_GOALSCORER_SQ.test(squashed)) return "forbidden_goalscorer";
  if (FORBIDDEN_PROPS_SQ.test(squashed) || FORBIDDEN_PROPS_TOKEN.test(joined)) return "forbidden_props";
  if (FORBIDDEN_FUTURES_SQ.test(squashed) || FORBIDDEN_FUTURES_TOKEN.test(joined)) return "forbidden_futures";
  if (ESPORTS_SQ.test(squashed) || ESPORTS_TOKEN.test(joined)) return "esports_non_policy";
  if (ALLOWED_MONEYLINE_SQ.test(squashed) || ALLOWED_MONEYLINE_TOKEN.test(joined)) return "allowed_fullmatch_moneyline";
  if (ALLOWED_SPREAD_SQ.test(squashed)) return "allowed_fullmatch_spread";
  if (ALLOWED_TOTAL_SQ.test(squashed) || ALLOWED_TOTAL_TOKEN.test(joined)) return "allowed_fullmatch_total";
  return "unknown";
}

export function isForbiddenMarketClass(cls: MarketClass): boolean {
  return cls.startsWith("forbidden_");
}

// ---------------------------------------------------------------------------
// EVENT SCOPE — the second, independent axis (R0G).
//
// Market class answers "what kind of bet is this?" (winner / spread / total).
// Event scope answers "over what portion of the event does it settle?".
// The two must never be conflated: a FULL-MATCH spread is allowed, a FIRST-HALF
// spread is not, and both carry market_class = allowed_fullmatch_spread.
//
// Conflating them is what caused night-plan:2026-07-27 to classify all 25
// physical events as ANCHOR_FULLMATCH_SUBMARKET_REJECTED -- the planner's own
// regex list treated the word "handicap" (and "over/under", "player", "rounds")
// as proof of a partial-event submarket.
// ---------------------------------------------------------------------------

export type EventScope =
  | "full_match"
  | "first_half"
  | "second_half"
  | "map_or_round"
  | "prop_or_other";

const SCOPE_FIRST_HALF_SQ = /firsthalf|1sthalf|halftime|halftimeresult|htresult/;
const SCOPE_SECOND_HALF_SQ = /secondhalf|2ndhalf/;
// Partial-event segments: map/set/period/quarter/inning N, and rounds/maps/kills.
// "game N" is deliberately NOT here -- it is handled separately below, because
// it is the only segment word that is also a whole-event identifier.
const SCOPE_MAP_OR_ROUND_TOKEN =
  /\b(?:map|set|period|quarter|inning|frame)\s*\d+\b|\bmaps?\b|\brounds?\b|\bkills?\b/;
// "game 2" means a per-game line in a series (esports) but ALSO identifies the
// second fixture of an MLB doubleheader -- a genuine full match. It is therefore
// admitted as partial-scope evidence ONLY from a market-title surface, never
// from an event slug / match-family key, where "…-game-2-…" is the standard
// doubleheader identifier. A slug can still prove partial scope through the
// qualified form below ("game handicap", "game total").
const SCOPE_GAME_NUMBER_TOKEN = /\bgames?\s*\d+\b/;
// A segment word directly qualifying a market class ("game handicap", "map
// total", "set winner") is a per-segment line even without an explicit number.
// Fail-closed: "Game Handicap: KC (-1.5) vs Team Vitality (+1.5)" is a per-game
// handicap inside a series, not the series result.
const SCOPE_SEGMENT_QUALIFIED_TOKEN =
  /\b(?:map|game|set|period|quarter|inning|frame)s?\s+(?:handicap|spread|total|totals|line|lines|winner|moneyline|result)\b/;
const SCOPE_PROP_TOKEN = /\bprops?\b|\bplayer\b|\bbookings?\b|\bcards?\b|\bcorners?\b/;

/**
 * Classify the portion of the event a market settles over. Pure text analysis
 * on the canonical tokenizer -- never a substring scan of raw slugs.
 *
 * Order matters: an explicit half marker wins over a segment marker, which wins
 * over a prop marker. Anything with no partial marker at all is a full match --
 * scope is only ever NARROWED by positive evidence, never guessed.
 */
export function classifyEventScope(input: unknown): EventScope {
  return classifyScopeOnSurface(input, "title");
}

/**
 * Scope evidence available from an IDENTIFIER surface (event slug, market slug,
 * match-family key). Identical to the title rules except that a bare "game N"
 * does not prove partial scope: in a slug it is overwhelmingly the doubleheader
 * fixture number ("mlb-nyy-bos-game-2-2026-07-27"), which is a full match.
 * A slug still proves partial scope via halves, other numbered segments, rounds,
 * props, or the qualified form ("game handicap").
 */
export function classifyEventScopeFromIdentifier(input: unknown): EventScope {
  return classifyScopeOnSurface(input, "identifier");
}

function classifyScopeOnSurface(input: unknown, surface: "title" | "identifier"): EventScope {
  const tokens = tokensOf(input);
  const joined = tokens.join(" ");
  const squashed = tokens.join("");

  if (SCOPE_FIRST_HALF_SQ.test(squashed)) return "first_half";
  if (SCOPE_SECOND_HALF_SQ.test(squashed)) return "second_half";
  if (
    SCOPE_MAP_OR_ROUND_TOKEN.test(joined) ||
    SCOPE_SEGMENT_QUALIFIED_TOKEN.test(joined) ||
    (surface === "title" && SCOPE_GAME_NUMBER_TOKEN.test(joined))
  ) {
    return "map_or_round";
  }
  if (SCOPE_PROP_TOKEN.test(joined)) return "prop_or_other";
  return "full_match";
}

export function isFullMatchEventScope(scope: EventScope): boolean {
  return scope === "full_match";
}

/** Activity/volume labels ("$52K matched activity") are never a market at all. */
const ACTIVITY_LABEL_RE = /^\s*\$\s*[\d.,]+\s*[kmb]?\s+matched/i;

export function isActivityLabelMarketText(input: unknown): boolean {
  return ACTIVITY_LABEL_RE.test(String(input ?? "").trim());
}

export type MarketAnchorReasonCode =
  | "ACTIVITY_LABEL"
  | "FORBIDDEN_MARKET_CLASS"
  | "PARTIAL_EVENT_SCOPE"
  | "ESPORTS_NON_POLICY"
  | "UNKNOWN_MARKET_CLASS";

export interface MarketAnchorDecision {
  market_class: MarketClass;
  event_scope: EventScope;
  allowed: boolean;
  reason_code: MarketAnchorReasonCode | null;
  /**
   * Which surface the decision was read from:
   *   structured    -- the provider's own question/title field
   *   normalized    -- a normalized event/market title we derived
   *   text_fallback -- only a slug/key was available
   */
  evidence_source: "structured" | "normalized" | "text_fallback";
}

export interface MarketAnchorInput {
  /** The provider's own market question -- the strongest available evidence. */
  providerMarketQuestion?: string | null;
  /** A normalized market/event title. */
  marketTitle?: string | null;
  eventTitle?: string | null;
  /** Display slugs -- last resort only. */
  marketSlug?: string | null;
  eventSlug?: string | null;
  matchFamilyKey?: string | null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * THE canonical market-anchor decision. Planning, the final rebalance and the
 * tests all consume this one function so a market can never be allowed at one
 * stage and rejected at another.
 *
 * Fail-closed by construction: an unrecognized market class is never allowed,
 * a forbidden class is never rescued by scope, and a partial event scope is
 * never rescued by an allowed class.
 */
export function resolveMarketAnchorDecision(input: MarketAnchorInput): MarketAnchorDecision {
  const structured = firstNonEmpty(input.providerMarketQuestion);
  const normalized = firstNonEmpty(input.marketTitle, input.eventTitle);
  const fallback = firstNonEmpty(input.marketSlug, input.eventSlug, input.matchFamilyKey);

  const evidence_source: MarketAnchorDecision["evidence_source"] =
    structured !== null ? "structured" : normalized !== null ? "normalized" : "text_fallback";
  const primary = structured ?? normalized ?? fallback ?? "";

  // Scope is read across every available surface -- a partial marker anywhere is
  // enough to block -- but each surface is read with its own rules: title
  // surfaces carry deliberate market wording, identifier surfaces also carry
  // fixture numbering that must not be mistaken for a segment line.
  const titleSurfaces = [structured, normalized].filter((v): v is string => v !== null);
  const identifierSurfaces = [input.marketSlug, input.eventSlug, input.matchFamilyKey]
    .map((v) => firstNonEmpty(v))
    .filter((v): v is string => v !== null);
  const scopeSurfaces = [...titleSurfaces, ...identifierSurfaces];
  const event_scope =
    [
      ...titleSurfaces.map(classifyEventScope),
      ...identifierSurfaces.map(classifyEventScopeFromIdentifier),
    ].find((s) => s !== "full_match") ?? "full_match";

  const market_class = classifyMarketText(primary);

  const reject = (reason_code: MarketAnchorReasonCode): MarketAnchorDecision => ({
    market_class,
    event_scope,
    allowed: false,
    reason_code,
    evidence_source,
  });

  if (scopeSurfaces.some(isActivityLabelMarketText)) return reject("ACTIVITY_LABEL");
  if (isForbiddenMarketClass(market_class)) return reject("FORBIDDEN_MARKET_CLASS");
  if (market_class === "esports_non_policy") return reject("ESPORTS_NON_POLICY");
  if (!isFullMatchEventScope(event_scope)) return reject("PARTIAL_EVENT_SCOPE");
  if (!isAllowedFullMatchMarketClass(market_class)) return reject("UNKNOWN_MARKET_CLASS");

  return { market_class, event_scope, allowed: true, reason_code: null, evidence_source };
}

export function isAllowedFullMatchMarketClass(cls: MarketClass): boolean {
  return (
    cls === "allowed_fullmatch_moneyline" ||
    cls === "allowed_fullmatch_spread" ||
    cls === "allowed_fullmatch_total"
  );
}

/** Fail-closed live gate: true ONLY for allowed full-match classes. */
export function isLiveAllowedFullMatch(input: unknown): boolean {
  return isAllowedFullMatchMarketClass(classifyMarketText(input));
}
