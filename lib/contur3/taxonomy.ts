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
