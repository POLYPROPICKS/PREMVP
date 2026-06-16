import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "crypto";

const POLICY_VERSION = "battle-sm-guard-v1-20260615";
const LIVE_POLICY_VERSION = "live-risk-guard-v1";

export type StrategicScope = "WC" | "SOCCER" | "MLB" | "ESPORT" | "OTHER" | "UNKNOWN";
export type IdentityQuality = "STRONG" | "MEDIUM" | "WEAK" | "INVALID";
export type SportClassificationConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

// Timing buckets used for diagnostics and live policy auditing.
// TODO(timing-audit): once resolved data is available, run per-sport win_rate/net_pnl
// query grouped by timing_bucket to decide data-driven cutoffs per sport/market_family.
// Current rule: WC/soccer hard-gated to ≤1h (T_0_30M + T_30_60M only).
// Non-football: no hard gate yet — monitor timing_bucket distribution in CEO view first.
export type TimingBucket =
  | "T_0_30M"
  | "T_30_60M"
  | "T_1_2H"
  | "T_2_6H"
  | "T_6H_PLUS"
  | "STARTED_OR_MISSING";

// Raw diagnostics collected during buildFireModelCandidates when planningMode=true.
// Passed through to the night-plan route for operator visibility.
export interface RawPlanningDiagnostics {
  total_db_rows: number;
  source_counts_by_formula_version: Record<string, number>;
  activity_label_rows: number;
  rows_missing_game_start: number;
  rows_using_expires_at: number;
  rows_using_created_at_fallback: number;
  rows_missing_event_slug: number;
  rows_missing_selected_token: number;
  rows_missing_selected_outcome: number;
  wc_like_rows: number;
  soccer_like_rows: number;
  sport_classification_confidence_counts: Record<string, number>;
  match_family_quality_counts: Record<string, number>;
  rejected_before_planning_by_reason: Record<string, number>;
  sample_source_rows: Array<Record<string, unknown>>;
  // Per-version drop-reason breakdown — reveals why shadow-strategic-sports-v1 rows are dropped.
  dropped_by_formula_version_and_reason: Record<string, Record<string, number>>;
  // Which versions were queried vs. which had zero DB rows returned.
  versions_queried: string[];
  versions_with_zero_db_rows: string[];
}

export interface FireModelCandidate {
  signal_id: string;
  strategy: string;
  rank: number;
  market_slug: string;
  // Stable match-family key used for cross-market dedupe (spread + total + corners = same event).
  // Priority: fifwc-* event_slug → team_pair extraction → other event_slug → condition_id (WEAK).
  match_family_key: string;
  match_family_key_source: "event_slug" | "team_pair" | "condition_id_weak";
  // true when match_family_key is backed only by condition_id (market-level, not event-level).
  match_family_key_is_weak: boolean;
  event_slug: string | null;
  condition_id: string;
  token_id: string;
  side: string;
  selected_outcome: string | null;
  inferred_sport: string;
  market_family: string;
  strategic_scope: StrategicScope;
  timing_bucket: TimingBucket;
  // CanonicalMarketIdentity v0 fields.
  identity_quality: IdentityQuality;
  identity_warning_codes: string[];
  canonical_event_key: string | null;
  canonical_market_key: string | null;
  activity_label_detected: boolean;
  sport_classification_confidence: SportClassificationConfidence;
  // Live eligibility layer (live-risk-guard-v1).
  live_eligible: boolean;
  live_rejection_reason: string | null;
  live_policy_version: string;
  paper_eligible: boolean;
  max_entry_price: number;
  stake_usd: number;
  max_order_usd: number;
  max_spread: number;
  one_order_only: boolean;
  executor_mode_allowed: string;
  first_live_test_allowed: boolean;
  stale_after: string;
  no_trade_after: string | null;
  idempotency_key: string;
  model_rule_id: string;
  created_at: string;
  source: string;
  diagnostics: {
    executor_action: string;
    paper_only: boolean;
    real_trade: boolean;
    score: number;
    coverage: number;
    smart_money: number | null;
    entry_price: number;
    game_start_iso: string;
    hours_to_start_now: number;
    fire_model_alias: string;
    version: string;
  };
}

// Execution endpoint uses the strict version set only.
const ALLOWED_VERSIONS = ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"];
// Planning endpoint includes shadow-strategic-sports-v1 for the full planning universe.
const PLANNING_ALLOWED_VERSIONS = [
  "shadow-strategic-sports-v1",
  "v2-lite-growth-safe",
  "shadow-firemodel1_1_research_v0",
];

const TIER_ORDER: Record<string, number> = {
  TIER1_CORE_STRICT_72_COV50: 1,
  TIER2_SAFE_EXPAND_60_COV50: 2,
  TIER3_MICRO_EXPAND_50_COV25: 3,
};

const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;
const ESPORTS_RE = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;
const TENNIS_RE = /\bset\s+[12]\b|\btennis\b/i;
// \bfifwc\b catches Polymarket FIFA World Cup event slugs (e.g. fifwc-fra-sen-2026-06-16).
const WC_EXPLICIT_RE = /\bfifwc\b|world[\s-]?cup|wc2026|\bfifa\b/i;
// WC 2026 participating countries for title-fallback classification.
const WC_COUNTRY_RE =
  /\b(france|senegal|iraq|norway|argentina|algeria|austria|jordan|saudi[\s-]arabia|uruguay|iran|new[\s-]zealand|spain|cape[\s-]verde|belgium|egypt|portugal|england|croatia|ghana|panama|colombia|uzbekistan|dr[\s-]congo|germany|ecuador|netherlands|sweden|japan|tunisia|mexico|south[\s-]korea|canada|qatar|brazil|morocco|scotland|haiti|\busa\b|australia|turkey|paraguay)\b/i;
// Football market phrase patterns (O/U, corners, halftime, etc.).
const FOOTBALL_PHRASE_RE =
  /\bo\/u\b|over[\s/]under|total\s+corners|\bcorners\b|\bspread\b|match\s+winner|\bhalftime\b|leading\s+at\s+halftime|2nd\s+half|total\s+goals|both\s+teams\s+to\s+score|correct\s+score/i;
const SOCCER_RE =
  /soccer|\bfootball\b|premier[\s-]league|serie[\s-]a|bundesliga|la[\s-]liga|\bmls\b|champions[\s-]league|europa[\s-]league|ligue|eredivisie|match[\s-]result|clean[\s-]sheet|btts|both[\s-]teams/i;
const MLB_RE =
  /\bmlb\b|\bbaseball\b|royals|yankees|red[\s-]sox|dodgers|\bcubs\b|\bmets\b|cardinals|\bbraves\b|astros|phillies|padres|mariners|brewers|pirates|\breds\b|orioles|nationals|athletics|\btigers\b|\btwins\b|white[\s-]sox|\brangers\b|\bangels\b|guardians|\brays\b|rockies|diamondbacks|marlins|blue[\s-]jays/i;
// Activity label patterns that must never be used as sport classifier or event key input.
const ACTIVITY_LABEL_RE = /matched\s+activity|market\s+activity|live\s+market\s+activity/i;
const PURE_VOLUME_RE = /^\s*\$[\d,.]+\s*[KkMmBb]?\s*$/;
// Single-team spread title without an opponent: "spread: norway (-1.5)", "spread: argentina (+0.5)".
// These MUST NOT become independent STRONG/MEDIUM event families — mark WEAK pending resolution.
const SINGLE_TEAM_SPREAD_RE = /^spread:\s*([\w][\w\s'-]*?)\s*\([+-]?\d+\.?\d*\)\s*$/i;

// Returns true for strings like "$25K matched activity", "Live market activity",
// or bare volume labels like "$25K". These are UI activity labels, not market titles.
export function isActivityLabelText(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const t = value.trim();
  return ACTIVITY_LABEL_RE.test(t) || PURE_VOLUME_RE.test(t);
}

// Build the canonical identity text for a row, quarantining activity-label market_slugs.
// Priority: event_slug → diagnostics.marketTitle/eventTitle/question/title → market_slug
// (market_slug used only when it is not an activity label).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildIdentityText(row: any): { text: string; activityLabelDetected: boolean } {
  const diag: Record<string, unknown> = row.diagnostics ?? {};
  const activityLabelDetected = isActivityLabelText(row.market_slug);
  const sources: unknown[] = [
    row.event_slug,
    diag.marketTitle,
    diag.eventTitle,
    diag.question,
    diag.title,
    activityLabelDetected ? null : row.market_slug,
  ];
  for (const v of sources) {
    if (typeof v === "string" && v.trim() && !isActivityLabelText(v)) {
      return { text: v.trim().toLowerCase(), activityLabelDetected };
    }
  }
  return { text: "", activityLabelDetected };
}

// Classify sport scope from identity text.
// Priority: negative guards → explicit WC tokens → MLB → soccer leagues →
//   WC country-pair + football phrase fallback.
function deriveSportScope(identityText: string): {
  scope: StrategicScope;
  confidence: SportClassificationConfidence;
} {
  if (ESPORTS_RE.test(identityText)) return { scope: "ESPORT", confidence: "HIGH" };
  if (NBA_NHL_RE.test(identityText)) return { scope: "UNKNOWN", confidence: "HIGH" };
  if (TENNIS_RE.test(identityText)) return { scope: "UNKNOWN", confidence: "HIGH" };
  if (WC_EXPLICIT_RE.test(identityText)) return { scope: "WC", confidence: "HIGH" };
  if (MLB_RE.test(identityText)) return { scope: "MLB", confidence: "HIGH" };
  if (SOCCER_RE.test(identityText)) return { scope: "SOCCER", confidence: "HIGH" };
  // Football/WC title fallback: recognized country pair + football market phrase.
  const hasCountry = WC_COUNTRY_RE.test(identityText);
  const hasFootballPhrase = FOOTBALL_PHRASE_RE.test(identityText);
  if (hasCountry && hasFootballPhrase) return { scope: "WC", confidence: "MEDIUM" };
  if (hasCountry && /halftime/i.test(identityText)) return { scope: "SOCCER", confidence: "MEDIUM" };
  return { scope: "UNKNOWN", confidence: "NONE" };
}

// Derive the stable match_family_key and identity quality for a row.
// Priority: fifwc-* event_slug → team-pair extraction from identity text →
//   other event_slug → condition_id (WEAK).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveMatchFamilyKey(row: any, identityText: string): {
  key: string;
  source: "event_slug" | "team_pair" | "condition_id_weak";
  quality: IdentityQuality;
  canonicalEventKey: string | null;
} {
  const rawEventSlug =
    typeof row.event_slug === "string" && row.event_slug.trim()
      ? row.event_slug.trim().toLowerCase()
      : null;

  // Priority 1: fifwc-* slug is the strongest canonical event identity.
  if (rawEventSlug && /^fifwc-/.test(rawEventSlug)) {
    return { key: rawEventSlug, source: "event_slug", quality: "STRONG", canonicalEventKey: rawEventSlug };
  }

  // Priority 2: team pair extracted from identity text.
  // Matches "France vs. Senegal: O/U 2.5" → pair:france-vs-senegal:<date>
  const pairMatch = identityText.match(
    /\b([\w\s'-]+?)\s+vs\.?\s+([\w\s'-]+?)(?:\s*[:|,]|$)/i
  );
  if (pairMatch) {
    const team1 = pairMatch[1].trim().toLowerCase().replace(/\s+/g, "-");
    const team2 = pairMatch[2].trim().toLowerCase().replace(/\s+/g, "-");
    const diag: Record<string, unknown> = row.diagnostics ?? {};
    const gameStartIso =
      typeof diag.gameStartIso === "string" ? diag.gameStartIso : null;
    const dateStr = gameStartIso ? gameStartIso.slice(0, 10) : "nodate";
    const key = `pair:${team1}-vs-${team2}:${dateStr}`;
    const quality: IdentityQuality = dateStr !== "nodate" ? "STRONG" : "MEDIUM";
    return { key, source: "team_pair", quality, canonicalEventKey: key };
  }

  // Priority 2b: single-team spread title (no opponent) → provisional WEAK key.
  // Resolved to parent pair group in post-processing if a matching pair:*:date key exists.
  // Identity stays WEAK whether resolved or not — never live-eligible as standalone.
  if (!identityText.match(/\bvs\.?\b/i) && SINGLE_TEAM_SPREAD_RE.test(identityText)) {
    const sm = SINGLE_TEAM_SPREAD_RE.exec(identityText)!;
    const team = sm[1].trim().toLowerCase().replace(/\s+/g, "-");
    const diag: Record<string, unknown> = row.diagnostics ?? {};
    const gameStartIso = typeof diag.gameStartIso === "string" ? diag.gameStartIso : null;
    const dateStr = gameStartIso ? gameStartIso.slice(0, 10) : "nodate";
    return {
      key: `WEAK_SINGLE_TEAM_SPREAD:${team}:${dateStr}`,
      source: "condition_id_weak",
      quality: "WEAK",
      canonicalEventKey: null,
    };
  }

  // Priority 3: any other event slug (non-fifwc).
  if (rawEventSlug) {
    return { key: rawEventSlug, source: "event_slug", quality: "MEDIUM", canonicalEventKey: rawEventSlug };
  }

  // Fallback: condition_id — market-level only, not event-level (WEAK).
  const weakKey = `WEAK_MARKET_LEVEL_KEY:${row.condition_id}`;
  return { key: weakKey, source: "condition_id_weak", quality: "WEAK", canonicalEventKey: null };
}

function inferSportAndFamily(scope: StrategicScope): { sport: string; family: string } {
  switch (scope) {
    case "WC":     return { sport: "soccer",   family: "world_cup" };
    case "SOCCER": return { sport: "soccer",   family: "soccer"    };
    case "MLB":    return { sport: "baseball", family: "mlb"       };
    case "ESPORT": return { sport: "esport",   family: "esport"    };
    default:       return { sport: "unknown",  family: "other"     };
  }
}

function computeTier(score: number, coverage: number): string | null {
  if (score >= 72 && coverage >= 50) return "TIER1_CORE_STRICT_72_COV50";
  if (score >= 60 && coverage >= 50) return "TIER2_SAFE_EXPAND_60_COV50";
  if (score >= 50 && coverage >= 25) return "TIER3_MICRO_EXPAND_50_COV25";
  return null;
}

function computeBaseStake(score: number, coverage: number): number {
  if (score >= 72 && coverage >= 75) return 10;
  if (score >= 72 && coverage >= 50) return 7;
  if (score >= 60 && coverage >= 50) return 7;
  if (score >= 50 && coverage >= 25) return 3;
  return 0;
}

function computeStake(base: number, smartMoney: number | null, esports: boolean): number {
  let stake = smartMoney != null && smartMoney >= 75 ? Math.floor(base / 2) : base;
  if (esports) stake = Math.min(stake, 5);
  return Math.min(stake, 10);
}

function computeExecutorAction(score: number, coverage: number, hoursToStart: number, tier: string): string {
  if (hoursToStart < 0) return "SKIP_STARTED";
  if (hoursToStart <= 2 && (tier === "TIER1_CORE_STRICT_72_COV50" || tier === "TIER2_SAFE_EXPAND_60_COV50")) {
    return "BET_OR_PAPER_GO";
  }
  if (score >= 75 && coverage >= 75 && hoursToStart <= 6) return "QUEUE_TOP_TIER_ONLY";
  if (hoursToStart > 6) return "QUEUE_LATER";
  return "QUEUE_WAIT_T_MINUS_60";
}

function makeIdempotencyKey(signalId: string, tokenId: string): string {
  return createHash("sha256")
    .update(`${signalId}__${tokenId}__${POLICY_VERSION}`)
    .digest("hex")
    .slice(0, 32);
}

function computeTimingBucket(hoursToStart: number): TimingBucket {
  if (hoursToStart < 0) return "STARTED_OR_MISSING";
  if (hoursToStart <= 0.5) return "T_0_30M";
  if (hoursToStart <= 1.0) return "T_30_60M";
  if (hoursToStart <= 2.0) return "T_1_2H";
  if (hoursToStart <= 6.0) return "T_2_6H";
  return "T_6H_PLUS";
}

/**
 * Centralised live eligibility decision. Called after hard-rejects (UNKNOWN,
 * football-too-early, football-No-side) have already been applied via `continue`.
 *
 * Returns soft-reject codes for candidates that are paper-safe but NOT live-safe:
 *   TIER3_LIVE_BLOCKED              — score/coverage too weak for live capital.
 *   WEAK_IDENTITY_LIVE_BLOCKED      — identity quality WEAK or INVALID.
 *   WEAK_MATCH_FAMILY_KEY_LIVE_BLOCKED — event key is market-level only.
 *   QUEUE_LATER_NOT_LIVE_ELIGIBLE   — game >6h away.
 */
function computeLiveEligibility(
  tier: string,
  matchFamilyKeySource: "event_slug" | "team_pair" | "condition_id_weak",
  matchFamilyKey: string,
  hoursToStart: number,
  identityQuality: IdentityQuality
): { liveEligible: boolean; liveRejectionReason: string | null } {
  if (tier === "TIER3_MICRO_EXPAND_50_COV25") {
    return { liveEligible: false, liveRejectionReason: "TIER3_LIVE_BLOCKED" };
  }
  if (identityQuality === "WEAK" || identityQuality === "INVALID") {
    return { liveEligible: false, liveRejectionReason: "WEAK_IDENTITY_LIVE_BLOCKED" };
  }
  const isWeakKey =
    matchFamilyKeySource === "condition_id_weak" ||
    matchFamilyKey.startsWith("WEAK_MARKET_LEVEL_KEY:");
  if (isWeakKey) {
    return { liveEligible: false, liveRejectionReason: "WEAK_MATCH_FAMILY_KEY_LIVE_BLOCKED" };
  }
  if (hoursToStart > 6.0) {
    return { liveEligible: false, liveRejectionReason: "QUEUE_LATER_NOT_LIVE_ELIGIBLE" };
  }
  return { liveEligible: true, liveRejectionReason: null };
}

// planningMode is OFF by default. When true (night-plan universe only):
//   1) includes shadow-strategic-sports-v1 in the version filter.
//   2) relaxes the soccer/WC ≤1h live timing gate so future matches appear as
//      future planning slots.
// Every other guard (UNKNOWN, No-side, weak key, TIER3, started, bad-bucket)
// is unchanged, and the live /candidates route NEVER sets this flag.
export async function buildFireModelCandidates(
  limit: number,
  scope = "all",
  planningMode = false
): Promise<{ candidates: FireModelCandidate[]; rawDiagnostics: RawPlanningDiagnostics | null }> {
  const versions = planningMode ? PLANNING_ALLOWED_VERSIONS : ALLOWED_VERSIONS;

  const { data, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select(
      "id, condition_id, selected_outcome, selected_token_id, entry_price_num, " +
      "signal_confidence_num, smart_money_score_num, diagnostics, " +
      "market_slug, event_slug, metric_formula_version, created_at, expires_at"
    )
    .in("metric_formula_version", versions)
    .is("signal_result", null)
    .gt("expires_at", new Date().toISOString())
    .not("selected_token_id", "is", null)
    .not("condition_id", "is", null)
    .not("entry_price_num", "is", null)
    .gte("signal_confidence_num", 50)
    .order("created_at", { ascending: false })
    .limit(planningMode ? 300 : 150);

  if (error) throw new Error(`DB query failed: ${error.message}`);

  const now = Date.now();
  const candidates: Array<Omit<FireModelCandidate, "rank">> = [];

  const rawDiag: RawPlanningDiagnostics | null = planningMode
    ? {
        total_db_rows: (data ?? []).length,
        source_counts_by_formula_version: {},
        activity_label_rows: 0,
        rows_missing_game_start: 0,
        rows_using_expires_at: 0,
        rows_using_created_at_fallback: 0,
        rows_missing_event_slug: 0,
        rows_missing_selected_token: 0,
        rows_missing_selected_outcome: 0,
        wc_like_rows: 0,
        soccer_like_rows: 0,
        sport_classification_confidence_counts: {},
        match_family_quality_counts: {},
        rejected_before_planning_by_reason: {},
        sample_source_rows: [],
        dropped_by_formula_version_and_reason: {},
        versions_queried: [...versions],
        versions_with_zero_db_rows: [],
      }
    : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (data ?? []) as any[]) {
    if (rawDiag) {
      const ver = (row.metric_formula_version as string) ?? "unknown";
      rawDiag.source_counts_by_formula_version[ver] =
        (rawDiag.source_counts_by_formula_version[ver] ?? 0) + 1;
      if (!row.selected_token_id) rawDiag.rows_missing_selected_token += 1;
      if (!row.selected_outcome)  rawDiag.rows_missing_selected_outcome += 1;
      if (!row.event_slug)        rawDiag.rows_missing_event_slug += 1;
    }

    const diag: Record<string, unknown> = row.diagnostics ?? {};
    const coverage = typeof diag.dataCoverage === "number" ? diag.dataCoverage : null;
    const gameStartIso =
      typeof diag.gameStartIso === "string" && diag.gameStartIso !== "null"
        ? diag.gameStartIso
        : null;
    const score = typeof row.signal_confidence_num === "number" ? row.signal_confidence_num : null;
    const entryPrice = typeof row.entry_price_num === "number" ? row.entry_price_num : null;

    const rejectReason = (r: string) => {
      if (rawDiag) {
        rawDiag.rejected_before_planning_by_reason[r] =
          (rawDiag.rejected_before_planning_by_reason[r] ?? 0) + 1;
        const ver = (row.metric_formula_version as string) ?? "unknown";
        if (!rawDiag.dropped_by_formula_version_and_reason[ver]) {
          rawDiag.dropped_by_formula_version_and_reason[ver] = {};
        }
        rawDiag.dropped_by_formula_version_and_reason[ver][r] =
          (rawDiag.dropped_by_formula_version_and_reason[ver][r] ?? 0) + 1;
      }
    };

    if (coverage == null || coverage < 25) { rejectReason("LOW_COVERAGE"); continue; }
    if (score == null || score < 50)       { rejectReason("LOW_SCORE"); continue; }
    if (entryPrice == null)                { rejectReason("MISSING_ENTRY_PRICE"); continue; }
    if (!gameStartIso) {
      if (rawDiag) rawDiag.rows_missing_game_start += 1;
      rejectReason("MISSING_GAME_START");
      continue;
    }

    const gameStartMs = new Date(gameStartIso).getTime();
    if (isNaN(gameStartMs) || gameStartMs <= now) {
      rejectReason("GAME_STARTED_OR_INVALID");
      continue;
    }

    const hoursToStart = Math.round(((gameStartMs - now) / 3_600_000) * 100) / 100;

    // Build identity text, quarantining activity-label market_slugs.
    const { text: identityText, activityLabelDetected } = buildIdentityText(row);
    if (rawDiag && activityLabelDetected) rawDiag.activity_label_rows += 1;

    // Bad bucket: coverage 50–74 AND entry_price 0.44–0.58
    if (coverage >= 50 && coverage <= 74 && entryPrice >= 0.44 && entryPrice <= 0.58) {
      rejectReason("BAD_BUCKET_COV_PRICE");
      continue;
    }

    const { scope: strategicScope, confidence: scopeConfidence } = deriveSportScope(identityText);

    if (rawDiag) {
      rawDiag.sport_classification_confidence_counts[scopeConfidence] =
        (rawDiag.sport_classification_confidence_counts[scopeConfidence] ?? 0) + 1;
      if (strategicScope === "WC")                                  rawDiag.wc_like_rows += 1;
      if (strategicScope === "WC" || strategicScope === "SOCCER")   rawDiag.soccer_like_rows += 1;
    }

    // Guard F: UNKNOWN is never live-eligible. Classifier must positively identify scope.
    if (strategicScope === "UNKNOWN") { rejectReason("UNKNOWN_SCOPE"); continue; }

    const isSoccerFamily = strategicScope === "WC" || strategicScope === "SOCCER";

    // Guard E: Football/WC candidates must be within 1 hour of kickoff for live eligibility.
    // planningMode keeps future soccer matches in the universe as future planning slots only.
    if (!planningMode && isSoccerFamily && hoursToStart > 1.0) {
      rejectReason("FOOTBALL_TOO_EARLY_LIVE");
      continue;
    }

    // scope filter — default "all" passes everything
    if (scope !== "all") {
      const want = scope.toUpperCase();
      if (want === "WC"     && strategicScope !== "WC")                                    { rejectReason("SCOPE_FILTER"); continue; }
      if (want === "SOCCER" && strategicScope !== "WC" && strategicScope !== "SOCCER")     { rejectReason("SCOPE_FILTER"); continue; }
      if (want === "MLB"    && strategicScope !== "MLB")                                   { rejectReason("SCOPE_FILTER"); continue; }
      if (want === "ESPORT" && strategicScope !== "ESPORT")                                { rejectReason("SCOPE_FILTER"); continue; }
    }

    const tier = computeTier(score, coverage);
    if (!tier) { rejectReason("TIER_BELOW_THRESHOLD"); continue; }

    const isEsport = ESPORTS_RE.test(identityText);
    const smartMoney = typeof row.smart_money_score_num === "number" ? row.smart_money_score_num : null;
    const baseStake = computeBaseStake(score, coverage);
    const stakeUsd = computeStake(baseStake, smartMoney, isEsport);
    if (stakeUsd <= 0) { rejectReason("ZERO_STAKE"); continue; }

    const maxEntryPrice = Math.min(Math.round((entryPrice + 0.04) * 1000) / 1000, 0.99);
    const executorAction = computeExecutorAction(score, coverage, hoursToStart, tier);

    const { sport, family } = inferSportAndFamily(strategicScope);
    const staleAfter = typeof row.expires_at === "string" ? row.expires_at : gameStartIso;
    const selectedOutcome = typeof row.selected_outcome === "string" ? row.selected_outcome : null;
    const side = selectedOutcome ?? "Yes";

    // Guard G: "No" side on football/WC match-winner markets has undefined semantics.
    if (isSoccerFamily && side.toLowerCase() === "no") {
      rejectReason("FOOTBALL_NO_SIDE");
      continue;
    }

    // Derive match_family_key with identity quality.
    const {
      key: matchFamilyKey,
      source: matchFamilyKeySource,
      quality: identityQuality,
      canonicalEventKey,
    } = deriveMatchFamilyKey(row, identityText);
    const matchFamilyKeyIsWeak = matchFamilyKeySource === "condition_id_weak";

    if (rawDiag) {
      rawDiag.match_family_quality_counts[identityQuality] =
        (rawDiag.match_family_quality_counts[identityQuality] ?? 0) + 1;
      if (rawDiag.sample_source_rows.length < 10) {
        rawDiag.sample_source_rows.push({
          identity_text: identityText,
          activity_label_detected: activityLabelDetected,
          event_slug: row.event_slug,
          strategic_scope: strategicScope,
          scope_confidence: scopeConfidence,
          match_family_key: matchFamilyKey,
          identity_quality: identityQuality,
          metric_formula_version: row.metric_formula_version,
        });
      }
    }

    const warningCodes: string[] = [];
    if (activityLabelDetected)          warningCodes.push("ACTIVITY_LABEL_IN_MARKET_SLUG");
    if (!row.event_slug)                warningCodes.push("MISSING_EVENT_SLUG");
    if (matchFamilyKeyIsWeak)           warningCodes.push("WEAK_MATCH_FAMILY_KEY");
    if (scopeConfidence === "MEDIUM")   warningCodes.push("SCOPE_CLASSIFIED_BY_FALLBACK");

    const timingBucket = computeTimingBucket(hoursToStart);
    let { liveEligible, liveRejectionReason } = computeLiveEligibility(
      tier,
      matchFamilyKeySource,
      matchFamilyKey,
      hoursToStart,
      identityQuality
    );

    // Pilot scope allowlist: PILOT_ALLOWED_SCOPES=MLB,ESPORT,ESPORTS
    // When set, live eligibility is restricted to the listed strategic scopes only.
    const pilotScopesRaw = process.env.PILOT_ALLOWED_SCOPES ?? "";
    if (liveEligible && pilotScopesRaw.trim()) {
      const pilotAllowed = new Set(
        pilotScopesRaw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
      );
      // Normalise ESPORTS → ESPORT so callers can use either spelling.
      const scopeKey = strategicScope === "ESPORT" ? "ESPORT" : strategicScope;
      const inAllowlist = pilotAllowed.has(scopeKey) || pilotAllowed.has("ESPORTS") && scopeKey === "ESPORT";
      if (!inAllowlist) {
        liveEligible = false;
        liveRejectionReason = "PILOT_SCOPE_NOT_ALLOWED";
      }
    }

    const rawEventSlugForCandidate =
      typeof row.event_slug === "string" && row.event_slug.trim()
        ? row.event_slug.trim().toLowerCase()
        : null;

    candidates.push({
      signal_id: row.id,
      strategy: tier,
      market_slug: row.market_slug || row.event_slug || row.condition_id,
      match_family_key: matchFamilyKey,
      match_family_key_source: matchFamilyKeySource,
      match_family_key_is_weak: matchFamilyKeyIsWeak,
      event_slug: rawEventSlugForCandidate,
      condition_id: row.condition_id,
      token_id: row.selected_token_id,
      side,
      selected_outcome: selectedOutcome,
      inferred_sport: sport,
      market_family: family,
      strategic_scope: strategicScope,
      timing_bucket: timingBucket,
      identity_quality: identityQuality,
      identity_warning_codes: warningCodes,
      canonical_event_key: canonicalEventKey,
      canonical_market_key: (row.condition_id as string) ?? null,
      activity_label_detected: activityLabelDetected,
      sport_classification_confidence: scopeConfidence,
      live_eligible: liveEligible,
      live_rejection_reason: liveRejectionReason,
      live_policy_version: LIVE_POLICY_VERSION,
      paper_eligible: true,
      max_entry_price: maxEntryPrice,
      stake_usd: stakeUsd,
      max_order_usd: 5,
      max_spread: 0.03,
      one_order_only: true,
      executor_mode_allowed: "dry_run_only",
      first_live_test_allowed: true,
      stale_after: staleAfter,
      no_trade_after: gameStartIso,
      idempotency_key: makeIdempotencyKey(row.id, row.selected_token_id),
      model_rule_id: POLICY_VERSION,
      created_at: row.created_at,
      source: "FireModel1_private_executor_2026_06_15",
      diagnostics: {
        executor_action: executorAction,
        paper_only: !liveEligible,
        real_trade: false,
        score,
        coverage,
        smart_money: smartMoney,
        entry_price: entryPrice,
        game_start_iso: gameStartIso,
        hours_to_start_now: hoursToStart,
        fire_model_alias: "FireModel1",
        version: row.metric_formula_version,
      },
    });
  }

  // Populate versions_with_zero_db_rows now that source_counts is complete.
  if (rawDiag) {
    rawDiag.versions_with_zero_db_rows = versions.filter(
      v => !rawDiag!.source_counts_by_formula_version[v]
    );
  }

  candidates.sort((a, b) => {
    const tierDiff = (TIER_ORDER[a.strategy] ?? 9) - (TIER_ORDER[b.strategy] ?? 9);
    if (tierDiff !== 0) return tierDiff;
    const scoreDiff = b.diagnostics.score - a.diagnostics.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.diagnostics.hours_to_start_now - b.diagnostics.hours_to_start_now;
  });

  // Post-processing: resolve WEAK_SINGLE_TEAM_SPREAD keys into their parent pair groups.
  // Example: "WEAK_SINGLE_TEAM_SPREAD:norway:2026-06-16" → "pair:iraq-vs-norway:2026-06-16"
  // Merges the spread into the same event group so it does not create a duplicate planned slot.
  // Identity stays WEAK (live-blocked) whether resolved or not.
  if (candidates.some(c => c.match_family_key.startsWith("WEAK_SINGLE_TEAM_SPREAD:"))) {
    const pairKeyByTeamDate = new Map<string, string>();
    for (const c of candidates) {
      const pm = c.match_family_key.match(/^pair:([\w-]+)-vs-([\w-]+):(\d{4}-\d{2}-\d{2})$/);
      if (pm) {
        pairKeyByTeamDate.set(`${pm[1]}:${pm[3]}`, c.match_family_key);
        pairKeyByTeamDate.set(`${pm[2]}:${pm[3]}`, c.match_family_key);
      }
    }
    for (const c of candidates) {
      const sm = c.match_family_key.match(/^WEAK_SINGLE_TEAM_SPREAD:([\w-]+):(\d{4}-\d{2}-\d{2})$/);
      if (!sm) continue;
      const resolved = pairKeyByTeamDate.get(`${sm[1]}:${sm[2]}`);
      if (resolved) {
        c.match_family_key = resolved;
        c.identity_warning_codes = [
          ...c.identity_warning_codes.filter(w => w !== "TEAM_PAIR_INCOMPLETE"),
          "TEAM_PAIR_RESOLVED_FROM_CONTEXT",
        ];
      }
      // Unresolved spreads keep WEAK_SINGLE_TEAM_SPREAD: key; WEAK quality blocks live.
    }
  }

  return {
    candidates: candidates.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 })),
    rawDiagnostics: rawDiag,
  };
}
