// Contur3 canonical market-taxonomy corpus.
// Single source of truth for classifier behavior: every case states the
// EXPECTED canonical class. Forbidden wins over allowed; unknown is fail-closed.
// Cases marked monitorDivergence document known legacy bugs in the monitor's
// regex copy (boundary-after-strip `\bdraw\b`/`\bou\b`, `under` substring
// overmatch) that the canonical module intentionally fixes.

export interface TaxonomyCorpusCase {
  text: string;
  expected:
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
  // Present when the legacy monitor classifyMarket(norm(text)) is known to
  // return a DIFFERENT class than canonical. Value = the legacy class.
  monitorDivergence?: string;
  note?: string;
}

export const TAXONOMY_CORPUS: TaxonomyCorpusCase[] = [
  // ── Allowed full-match moneyline ──────────────────────────────────────
  { text: "Japan vs Sweden — Match Winner", expected: "allowed_fullmatch_moneyline" },
  { text: "Ecuador to win vs Germany", expected: "allowed_fullmatch_moneyline" },
  { text: "Turkiye vs USA moneyline", expected: "allowed_fullmatch_moneyline" },
  { text: "1X2: Paraguay vs Australia", expected: "allowed_fullmatch_moneyline" },
  { text: "Match result: Curaçao vs Côte d’Ivoire", expected: "allowed_fullmatch_moneyline", note: "diacritics-stable" },
  { text: "Germany winner", expected: "allowed_fullmatch_moneyline" },
  { text: "Draw no bet — Paraguay", expected: "allowed_fullmatch_moneyline" },
  {
    text: "Will Tunisia vs Netherlands end in a draw?",
    expected: "allowed_fullmatch_moneyline",
    monitorDivergence: "unknown",
    note: "legacy \\bdraw\\b dead even at string end: no word boundary inside the squashed string",
  },
  {
    text: "Match draw or Japan win",
    expected: "allowed_fullmatch_moneyline",
    monitorDivergence: "unknown",
    note: "mid-string draw: legacy \\bdraw\\b is dead after strip-normalization",
  },
  // ── Allowed full-match spread ─────────────────────────────────────────
  { text: "Japan -1.5 spread", expected: "allowed_fullmatch_spread" },
  { text: "Asian handicap: Sweden +0.5", expected: "allowed_fullmatch_spread" },
  { text: "Handicap Ecuador -1", expected: "allowed_fullmatch_spread" },
  // ── Allowed full-match total ──────────────────────────────────────────
  { text: "Total goals over 2.5", expected: "allowed_fullmatch_total" },
  { text: "Over/Under 3.5 — Japan vs Sweden", expected: "allowed_fullmatch_total" },
  { text: "Japan vs Sweden totals", expected: "allowed_fullmatch_total" },
  { text: "Under 2.5 goals", expected: "allowed_fullmatch_total" },
  { text: "Match total OU 2.5", expected: "allowed_fullmatch_total" },
  { text: "Over 1.5 goals Tunisia", expected: "allowed_fullmatch_total" },
  // ── Substring-overmatch regressions ───────────────────────────────────
  { text: "Sunderland vs Arsenal — Match Winner", expected: "allowed_fullmatch_moneyline" },
  {
    text: "Sunderland vs Arsenal",
    expected: "unknown",
    monitorDivergence: "allowed_fullmatch_total",
    note: "legacy /under/ substring matched inside team name Sunderland",
  },
  // ── Forbidden: halftime / first half ──────────────────────────────────
  { text: "Halftime result: Japan vs Sweden", expected: "forbidden_halftime" },
  { text: "First half winner", expected: "forbidden_halftime", note: "forbidden wins over winner" },
  { text: "1st half total goals", expected: "forbidden_halftime", note: "forbidden wins over total" },
  { text: "Second half corners", expected: "forbidden_halftime", note: "halftime checked before corners" },
  { text: "Half-time draw", expected: "forbidden_halftime" },
  { text: "Halftime total", expected: "forbidden_halftime", note: "REQUIRED first invariant test" },
  { text: "Leading at halftime", expected: "forbidden_halftime" },
  // ── Forbidden: corners ────────────────────────────────────────────────
  { text: "Total corners over 8.5", expected: "forbidden_corners", note: "corners beats total" },
  { text: "Corner count Japan", expected: "forbidden_corners" },
  { text: "Corners handicap", expected: "forbidden_corners", note: "corners beats spread" },
  // ── Forbidden: exact score ────────────────────────────────────────────
  { text: "Exact score 2-1", expected: "forbidden_exact_score" },
  { text: "Correct score: Germany 2-0", expected: "forbidden_exact_score" },
  // ── Forbidden: goalscorer ─────────────────────────────────────────────
  { text: "Anytime goalscorer: Musiala", expected: "forbidden_goalscorer" },
  { text: "First scorer", expected: "forbidden_goalscorer" },
  { text: "Last goal scorer", expected: "forbidden_goalscorer" },
  // ── Forbidden: props ──────────────────────────────────────────────────
  { text: "Player props: shots on target", expected: "forbidden_props" },
  { text: "Both teams to score", expected: "forbidden_props" },
  { text: "BTTS yes", expected: "forbidden_props" },
  { text: "Total cards over 4.5", expected: "forbidden_props", note: "cards beats total" },
  { text: "Bookings points", expected: "forbidden_props" },
  // ── Forbidden: futures / outrights ────────────────────────────────────
  { text: "To win outright: Germany", expected: "forbidden_futures", note: "futures beats to-win moneyline" },
  { text: "Winner group A", expected: "forbidden_futures", note: "winnergroup beats winner" },
  { text: "World Cup futures", expected: "forbidden_futures" },
  // ── Esports: explicit non-policy class (fail-closed for live) ─────────
  { text: "CS2 major winner", expected: "esports_non_policy" },
  { text: "Dota 2 match", expected: "esports_non_policy" },
  { text: "esports special", expected: "esports_non_policy" },
  // ── Unknown: fail-closed ──────────────────────────────────────────────
  { text: "Weather in Doha", expected: "unknown" },
  { text: "$25K matched activity", expected: "unknown" },
  { text: "", expected: "unknown" },
];
