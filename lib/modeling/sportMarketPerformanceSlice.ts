// Sport and market-type performance slice engine (Phase 3E.8C).
//
// Analyzes exactly three models -- PRIMARY_V1_AVOID_NBA_NHL_COV_CAP,
// ALT2_TS_SCORE_GE_65 (mandatory), ALT1_CANONICAL_EVENT_GROUPING -- by sport
// and market type on the same canonical dedup corpus. Row selection reuses
// evaluateHistoricalFunnelVariant (never a second predicate engine);
// ROI/PnL/win-loss reuse roiPnlContract; equity/drawdown reuse
// computeFlatUnitEquityMetrics; event identity reuses buildEventGroupKey.
// Sport/market classification is explicit-field-first with a bounded slug
// fallback -- it never guesses from vague title text; unmatched stays
// UNKNOWN. Pure: no fs/env/network/database access, never mutates its input.

import { createHash } from "node:crypto";
import { evaluateHistoricalFunnelVariant } from "./historicalFunnelVariants";
import { computeFlatStakeRoiSummary, computeRowReturnPct } from "./roiPnlContract";
import { computeFlatUnitEquityMetrics } from "./historicalFunnelComparison";
import { buildEventGroupKey } from "./eventGroupSelection";
import { getBundle, type ExecutableFunnelClassifier } from "./executableFunnelClassifier";
import type {
  MetadataEnrichmentSnapshot,
  OfficialEventMetadata,
  OfficialMarketMetadata,
} from "./polymarketMetadataEnrichment";
import { isValidConditionId, isValidPolymarketSlug } from "./polymarketMetadataEnrichment";

type Row = Record<string, unknown>;

export const ANALYZED_MODEL_IDS = [
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT2_TS_SCORE_GE_65",
  "ALT1_CANONICAL_EVENT_GROUPING",
] as const;

// ---- Classification ----

export type ClassificationConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface SportClassification {
  sportKey: string;
  sportLabel: string;
  classificationSource: "explicit_field" | "slug_fallback" | "unknown";
  classificationConfidence: ClassificationConfidence;
}

export interface MarketClassification {
  marketKey: string;
  classificationSource: "slug_pattern" | "slug_default" | "unknown";
  classificationConfidence: ClassificationConfidence;
}

const EXPLICIT_SPORT_FIELDS = ["league", "league_name", "sport", "sport_name", "competition"] as const;

const SPORT_SLUG_PATTERNS: Array<[RegExp, string]> = [
  [/\bnba\b|basketball/i, "basketball"],
  [/\bnhl\b|ice[\s-]?hockey/i, "hockey"],
  [/\bnfl\b|american[\s-]?football/i, "american_football"],
  [/\bmlb\b|baseball/i, "baseball"],
  [/\btennis\b|\batp\b|\bwta\b/i, "tennis"],
  [/\besport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i, "esports"],
  [/soccer|football|epl|premier[\s-]?league|la[\s-]?liga|bundesliga|fifa|world[\s-]?cup|serie[\s-]?a|champions[\s-]?league/i, "soccer_football"],
];

function slugText(row: Row): string {
  const eventSlug = typeof row.event_slug === "string" ? row.event_slug : "";
  const marketSlug = typeof row.market_slug === "string" ? row.market_slug : "";
  return `${eventSlug} ${marketSlug}`.toLowerCase();
}

/**
 * Sport classification. Explicit field first (league/league_name/sport/
 * sport_name/competition) -> HIGH confidence. Falls back to a bounded slug
 * regex match -> MEDIUM confidence. If a slug exists but matches nothing
 * known -> LOW confidence with sportKey OTHER. No slug at all -> UNKNOWN.
 * Never guesses from vague title text beyond these explicit, named patterns.
 */
export function classifySport(row: Row): SportClassification {
  for (const field of EXPLICIT_SPORT_FIELDS) {
    const value = row[field];
    if (typeof value === "string" && value.trim() !== "") {
      return {
        sportKey: value.trim().toLowerCase().replace(/\s+/g, "_"),
        sportLabel: value.trim(),
        classificationSource: "explicit_field",
        classificationConfidence: "HIGH",
      };
    }
  }

  const text = slugText(row);
  if (text.trim() === "") {
    return { sportKey: "UNKNOWN", sportLabel: "Unknown", classificationSource: "unknown", classificationConfidence: "UNKNOWN" };
  }
  for (const [pattern, key] of SPORT_SLUG_PATTERNS) {
    if (pattern.test(text)) {
      return { sportKey: key, sportLabel: key.replace(/_/g, " "), classificationSource: "slug_fallback", classificationConfidence: "MEDIUM" };
    }
  }
  return { sportKey: "OTHER", sportLabel: "Other (unmatched slug)", classificationSource: "slug_fallback", classificationConfidence: "LOW" };
}

const MARKET_SLUG_PATTERNS: Array<[RegExp, string]> = [
  [/over[\s-]?under|totals?|\bo\/u\b/i, "TOTALS"],
  [/spread|handicap|[+-]\d+(\.\d+)?(?!\d)/i, "SPREAD_OR_HANDICAP"],
  [/both[\s-]?teams?[\s-]?to[\s-]?score|\bbtts\b/i, "BOTH_TEAMS_TO_SCORE"],
  [/player[\s-]?prop|player[\s-]?points|player[\s-]?assists|player[\s-]?rebounds/i, "PLAYER_PROP"],
  [/team[\s-]?prop|team[\s-]?total/i, "TEAM_PROP"],
  [/series|tournament[\s-]?winner|tournament(?!.*match)/i, "SERIES_OR_TOURNAMENT"],
  [/outright|futures?|to[\s-]?win[\s-]?the/i, "OUTRIGHT_OR_FUTURE"],
  [/moneyline|match[\s-]?winner|\bwinner\b/i, "MATCH_WINNER_OR_MONEYLINE"],
];

/**
 * Market-type classification from explicit market/slug semantics. Returns
 * MATCH_WINNER_OR_MONEYLINE only when a moneyline/winner pattern matches (or
 * as a bounded default when a market_slug exists but matches no other known
 * pattern -- reported with LOW confidence, never claimed exact). No slug at
 * all -> UNKNOWN. If futures/outrights unexpectedly appear on this corpus,
 * they surface here explicitly as OUTRIGHT_OR_FUTURE, never hidden.
 */
export function classifyMarketType(row: Row): MarketClassification {
  const marketSlug = typeof row.market_slug === "string" ? row.market_slug : "";
  if (marketSlug.trim() === "") {
    return { marketKey: "UNKNOWN", classificationSource: "unknown", classificationConfidence: "UNKNOWN" };
  }
  for (const [pattern, key] of MARKET_SLUG_PATTERNS) {
    if (pattern.test(marketSlug)) {
      const confidence: ClassificationConfidence = key === "MATCH_WINNER_OR_MONEYLINE" && !/moneyline|winner/i.test(marketSlug) ? "MEDIUM" : "HIGH";
      return { marketKey: key, classificationSource: "slug_pattern", classificationConfidence: confidence };
    }
  }
  // Bounded default: a market_slug exists but matches no explicit pattern --
  // most unlabeled sports markets on this platform are match-winner style,
  // but this is a heuristic default, reported at LOW confidence, not exact.
  return { marketKey: "MATCH_WINNER_OR_MONEYLINE", classificationSource: "slug_default", classificationConfidence: "LOW" };
}

// ---- V2 official-metadata-aware classification (Phase 3E.8D) ----
//
// V2 never guesses: it only classifies a row as a sport/competition/market
// type when official Polymarket Gamma API metadata (an event/market's
// sport/category/subcategory/series/tags/marketType field, or membership in
// the official /sports/market-types list) actually supports it. Absent
// official evidence, a row's residualReason is set and its confidence is
// UNKNOWN -- V2 never falls back to inventing a World Cup or a moneyline
// classification from title text alone.

export type ResidualReason =
  | "MISSING_EVENT_IDENTITY"
  | "OFFICIAL_EVENT_NOT_FOUND"
  | "OFFICIAL_MARKET_NOT_FOUND"
  | "NO_SPORT_TAG"
  | "NO_COMPETITION_TAG"
  | "NO_MARKET_TYPE_FIELD"
  | "AMBIGUOUS_MULTI_SPORT_TAGS"
  | "NON_SPORT_EVENT"
  | "UNSUPPORTED_OFFICIAL_MARKET_TYPE"
  | "BOUNDED_FALLBACK_ONLY";

export interface SportClassificationV2 {
  sportFamily: string;
  sport: string | null;
  competition: string | null;
  tournament: string | null;
  tournamentEdition: string | null;
  stage: string | null;
  classificationConfidence: ClassificationConfidence;
  classificationEvidence: string;
  residualReason: ResidualReason | null;
}

function lookupEventMetadata(row: Row, snapshot: MetadataEnrichmentSnapshot): OfficialEventMetadata | null {
  const slug = getStr(row, "event_slug");
  if (slug !== null && snapshot.eventsBySlug[slug]) return snapshot.eventsBySlug[slug];
  return null;
}

function getDiag(row: Row): Record<string, unknown> | undefined {
  const d = row["diagnostics"];
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;
}

/**
 * Resolves a row's normalized (lowercase) condition id from the top-level
 * `condition_id` or `diagnostics.conditionId`, or null when neither is a
 * well-formed condition id.
 */
function normalizedConditionId(row: Row): string | null {
  if (isValidConditionId(row["condition_id"])) return (row["condition_id"] as string).toLowerCase();
  const d = getDiag(row);
  if (d && isValidConditionId(d["conditionId"])) return (d["conditionId"] as string).toLowerCase();
  return null;
}

/**
 * Looks up official market metadata for a row (Phase 3E.8D.3C), priority:
 * 1) valid condition_id / diagnostics.conditionId -> marketsByConditionId
 * (normalized lowercase key); 2) valid diagnostics.marketSlug -> marketsBySlug;
 * 3) valid top-level market_slug -> marketsBySlug. Display-title fields never
 * hit because they fail slug validation. Backward compatible with snapshots
 * lacking marketsByConditionId.
 */
function lookupMarketMetadata(row: Row, snapshot: MetadataEnrichmentSnapshot): OfficialMarketMetadata | null {
  const byConditionId = snapshot.marketsByConditionId;
  const cid = normalizedConditionId(row);
  if (cid && byConditionId && byConditionId[cid]) return byConditionId[cid];

  const d = getDiag(row);
  if (d && isValidPolymarketSlug(d["marketSlug"]) && snapshot.marketsBySlug[d["marketSlug"] as string]) {
    return snapshot.marketsBySlug[d["marketSlug"] as string];
  }

  const slug = getStr(row, "market_slug");
  if (slug !== null && isValidPolymarketSlug(slug) && snapshot.marketsBySlug[slug]) return snapshot.marketsBySlug[slug];
  return null;
}

const KNOWN_SPORT_KEYWORDS: Array<[RegExp, string]> = [
  [/soccer|football(?!.*american)/i, "SOCCER"],
  [/basketball/i, "BASKETBALL"],
  [/\bhockey\b/i, "HOCKEY"],
  [/american[\s-]?football/i, "AMERICAN_FOOTBALL"],
  [/baseball/i, "BASEBALL"],
  [/tennis/i, "TENNIS"],
  [/esport/i, "ESPORTS"],
];

function matchSportKeyword(text: string): string | null {
  for (const [re, key] of KNOWN_SPORT_KEYWORDS) {
    if (re.test(text)) return key;
  }
  return null;
}

// Bounded slug-prefix -> sport map, derived only from prefixes observed in
// the real corpus (val-, dota2-, fifwc-, nhl-, bk*). Lowest-priority sport
// evidence: used only when official tags/category name no sport.
const SLUG_PREFIX_SPORT: Array<[RegExp, string]> = [
  [/^val-/i, "ESPORTS"],
  [/^dota2-/i, "ESPORTS"],
  [/^(lol|csgo|cs2)-/i, "ESPORTS"],
  [/^fifwc-/i, "SOCCER"],
  [/^nhl-/i, "HOCKEY"],
  [/^bk/i, "BASKETBALL"],
];

function matchSlugPrefixSport(slug: string): string | null {
  for (const [re, key] of SLUG_PREFIX_SPORT) {
    if (re.test(slug)) return key;
  }
  return null;
}

/**
 * Sport/competition classification from official MARKET metadata (Phase
 * 3E.8D.3C), used only when no official EVENT metadata is available. Evidence
 * priority: official market tags -> category/subcategory -> sportsMarketType
 * keyword -> bounded slug prefix (LOW). World Cup is assigned only for SOCCER
 * with an official world-cup tag or an fifwc- slug -- never from a title.
 * Returns null when no evidence supports any sport.
 */
function classifySportFromMarket(market: OfficialMarketMetadata): SportClassificationV2 | null {
  const tagTexts = (market.tags ?? []).map((t) => String(t));
  const matchedFromTags = new Set(tagTexts.map(matchSportKeyword).filter((s): s is string => s !== null));
  if (matchedFromTags.size > 1) {
    return {
      sportFamily: "UNKNOWN", sport: null, competition: null, tournament: null, tournamentEdition: null, stage: null,
      classificationConfidence: "UNKNOWN", classificationEvidence: "ambiguous_official_market_tags",
      residualReason: "AMBIGUOUS_MULTI_SPORT_TAGS",
    };
  }

  const slug = typeof market.slug === "string" ? market.slug : "";
  const sportsMarketType = typeof market.sportsMarketType === "string" ? market.sportsMarketType : "";

  let sport: string | null =
    [...matchedFromTags][0] ??
    (market.category ? matchSportKeyword(market.category) : null) ??
    (market.subcategory ? matchSportKeyword(market.subcategory) : null) ??
    (sportsMarketType ? matchSportKeyword(sportsMarketType) : null);
  let evidence = "official_market_tag_or_category";
  let confidence: ClassificationConfidence = "HIGH";

  if (!sport) {
    const prefixSport = matchSlugPrefixSport(slug);
    if (prefixSport) {
      sport = prefixSport;
      evidence = "official_market_slug_prefix";
      confidence = "LOW";
    }
  }

  if (!sport) return null;

  let competition: string | null = null;
  let tournamentEdition: string | null = null;
  const hasWorldCupTag = tagTexts.some((t) => /world-?cup/i.test(t));
  const isFifwcSlug = /^fifwc-/i.test(slug);
  if (sport === "SOCCER" && (hasWorldCupTag || isFifwcSlug)) {
    competition = "FIFA_WORLD_CUP";
    const editionMatch = tagTexts.join(" ").match(/world-?cup-?(\d{4})/i) ?? slug.match(/(\d{4})/);
    tournamentEdition = editionMatch ? editionMatch[1] : isFifwcSlug ? "2026" : null;
  }

  return {
    sportFamily: sport,
    sport,
    competition,
    tournament: competition,
    tournamentEdition,
    stage: null,
    classificationConfidence: confidence,
    classificationEvidence: evidence,
    residualReason: null,
  };
}

const WORLD_CUP_STAGE_PATTERNS: Array<[RegExp, string]> = [
  [/round\s*of\s*32/i, "ROUND_OF_32"],
  [/round\s*of\s*16/i, "ROUND_OF_16"],
  [/quarterfinal/i, "QUARTERFINAL"],
  [/semifinal/i, "SEMIFINAL"],
  [/third[\s-]?place/i, "THIRD_PLACE"],
  [/\bfinal\b/i, "FINAL"],
  [/group\s*stage/i, "GROUP_STAGE"],
];

/**
 * Sport/competition classification, evidence-priority order: official sport
 * tag/metadata field (HIGH) -> official series/competition tag or event
 * template (MEDIUM) -> bounded known slug keyword (LOW, only reached if no
 * official evidence exists at all) -> UNKNOWN with an explicit residualReason.
 * World Cup / any competition is only assigned when official evidence
 * (series, tags, or category/subcategory) names it -- never from a
 * country-vs-country title alone.
 */
export function classifySportV2(row: Row, snapshot: MetadataEnrichmentSnapshot): SportClassificationV2 {
  const event = lookupEventMetadata(row, snapshot);

  if (event) {
    // Ambiguous multi-sport tags: more than one distinct known-sport keyword
    // present in the official tags with no single explicit sport field ->
    // UNKNOWN rather than guessing.
    const tagTexts = (event.tags ?? []).map((t) => String(t));
    const matchedSportsFromTags = new Set(tagTexts.map(matchSportKeyword).filter((s): s is string => s !== null));
    if (!event.sport && matchedSportsFromTags.size > 1) {
      return {
        sportFamily: "UNKNOWN", sport: null, competition: null, tournament: null, tournamentEdition: null, stage: null,
        classificationConfidence: "UNKNOWN", classificationEvidence: "ambiguous_official_tags",
        residualReason: "AMBIGUOUS_MULTI_SPORT_TAGS",
      };
    }

    // Non-sport event: an explicit official category naming a non-sport
    // domain overrides everything else.
    if (event.category && !/sport/i.test(event.category) && !event.sport && matchedSportsFromTags.size === 0) {
      return {
        sportFamily: "NON_SPORT", sport: null, competition: null, tournament: null, tournamentEdition: null, stage: null,
        classificationConfidence: "UNKNOWN", classificationEvidence: `official_category:${event.category}`,
        residualReason: "NON_SPORT_EVENT",
      };
    }

    // HIGH: explicit official sport field, or category/subcategory naming a
    // known sport.
    const explicitSport =
      (event.sport && matchSportKeyword(event.sport)) ??
      (event.subcategory && matchSportKeyword(event.subcategory)) ??
      (event.category && matchSportKeyword(event.category)) ??
      [...matchedSportsFromTags][0] ??
      null;

    // World Cup / competition, only from official series/tags evidence.
    const seriesText = event.series ?? "";
    const isWorldCupSeries = /fifa\s*world\s*cup|world\s*cup/i.test(seriesText);
    const hasWorldCupTag = tagTexts.some((t) => /world-?cup/i.test(t));
    let competition: string | null = null;
    let tournamentEdition: string | null = null;
    if (isWorldCupSeries || hasWorldCupTag) {
      competition = "FIFA_WORLD_CUP";
      const editionMatch = tagTexts.join(" ").match(/world-?cup-?(\d{4})/i) ?? seriesText.match(/(\d{4})/);
      tournamentEdition = editionMatch ? editionMatch[1] : null;
    } else if (seriesText) {
      competition = seriesText.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }

    let stage: string | null = null;
    const stageSource = `${event.title ?? ""} ${(row.event_slug as string) ?? ""}`;
    for (const [re, key] of WORLD_CUP_STAGE_PATTERNS) {
      if (re.test(stageSource)) {
        stage = key;
        break;
      }
    }
    if (competition === "FIFA_WORLD_CUP" && stage === null) stage = "UNSPECIFIED";

    if (explicitSport) {
      return {
        sportFamily: explicitSport,
        sport: explicitSport,
        competition,
        tournament: competition,
        tournamentEdition,
        stage,
        classificationConfidence: event.sport ? "HIGH" : "HIGH",
        classificationEvidence: event.sport ? "official_sport_field" : "official_category_subcategory",
        residualReason: null,
      };
    }

    if (competition) {
      return {
        sportFamily: "SOCCER_INFERRED_FROM_SERIES",
        sport: competition === "FIFA_WORLD_CUP" ? "SOCCER" : null,
        competition,
        tournament: competition,
        tournamentEdition,
        stage,
        classificationConfidence: "MEDIUM",
        classificationEvidence: "official_series",
        residualReason: null,
      };
    }

    return {
      sportFamily: "UNKNOWN", sport: null, competition: null, tournament: null, tournamentEdition: null, stage: null,
      classificationConfidence: "UNKNOWN", classificationEvidence: "official_event_no_sport_evidence",
      residualReason: "NO_SPORT_TAG",
    };
  }

  // No official EVENT metadata -- fall back to official MARKET metadata
  // (Phase 3E.8D.3C), which is what the historical corpus actually resolves
  // (markets by condition id, not events).
  const market = lookupMarketMetadata(row, snapshot);
  if (market) {
    const fromMarket = classifySportFromMarket(market);
    if (fromMarket) return fromMarket;
  }

  // No official event or market metadata at all for this identity.
  return {
    sportFamily: "UNKNOWN", sport: null, competition: null, tournament: null, tournamentEdition: null, stage: null,
    classificationConfidence: "UNKNOWN", classificationEvidence: "no_official_event_metadata",
    residualReason: "NO_COMPETITION_TAG",
  };
}

export interface MarketClassificationV2 {
  officialMarketType: string | null;
  marketFamily: string;
  marketSubtype: string | null;
  participantScope: string | null;
  periodScope: string | null;
  classificationConfidence: ClassificationConfidence;
  residualReason: ResidualReason | null;
}

const OFFICIAL_MARKET_TYPE_FAMILY: Record<string, string> = {
  moneyline: "MONEYLINE",
  three_way_moneyline: "THREE_WAY_MONEYLINE",
  draw_no_bet: "DRAW_NO_BET",
  spread: "SPREAD",
  handicap: "HANDICAP",
  totals: "TOTAL",
  total: "TOTAL",
  team_total: "TEAM_TOTAL",
  both_teams_to_score: "BOTH_TEAMS_TO_SCORE",
  player_prop: "PLAYER_PROP",
  team_prop: "TEAM_PROP",
  correct_score: "CORRECT_SCORE",
  half_full_time: "HALF_FULL_TIME",
  qualification: "QUALIFICATION_OR_ADVANCEMENT",
  tournament_winner: "TOURNAMENT_WINNER",
  series_winner: "SERIES_WINNER",
  award: "AWARD_OR_STAT_LEADER",
};

// Base-token -> locked-family map for Gamma `sportsMarketType` values, keyed
// only from the vocabulary that actually appears in the real corpus. Extends
// OFFICIAL_MARKET_TYPE_FAMILY with the compound sports market bases; never
// collapses an unmapped base to moneyline.
const SPORTS_MARKET_TYPE_BASE_FAMILY: Record<string, string> = {
  moneyline: "MONEYLINE",
  child_moneyline: "MONEYLINE",
  three_way_moneyline: "THREE_WAY_MONEYLINE",
  draw_no_bet: "DRAW_NO_BET",
  esports_match_result: "MONEYLINE",
  round_handicap: "HANDICAP",
  map_handicap: "HANDICAP",
  handicap: "HANDICAP",
  spread: "SPREAD",
  spreads: "SPREAD",
  total: "TOTAL",
  totals: "TOTAL",
  round_over_under: "TOTAL",
  over_under: "TOTAL",
  first_half_totals: "TOTAL",
  total_corners: "TOTAL",
  total_games: "TOTAL",
  team_total: "TEAM_TOTAL",
  team_totals: "TEAM_TOTAL",
  soccer_team_totals: "TEAM_TOTAL",
  both_teams_to_score: "BOTH_TEAMS_TO_SCORE",
  soccer_halftime_result: "HALF_FULL_TIME",
  halftime_result: "HALF_FULL_TIME",
  half_full_time: "HALF_FULL_TIME",
  soccer_second_half_result: "HALF_FULL_TIME",
  soccer_extra_time: "HALF_FULL_TIME",
  soccer_player_goals: "PLAYER_PROP",
  player_goals: "PLAYER_PROP",
  player_prop: "PLAYER_PROP",
  correct_score: "CORRECT_SCORE",
  qualification: "QUALIFICATION_OR_ADVANCEMENT",
  tournament_winner: "TOURNAMENT_WINNER",
  series_winner: "SERIES_WINNER",
  award: "AWARD_OR_STAT_LEADER",
};

/**
 * Normalizes the official `/sports/market-types` registry into a Set of
 * lowercase type identifiers, accepting both the legacy `string[]` shape and
 * the real official wrapper `{ $schema?, marketTypes: [...] }`. Object entries
 * are read from `name` -> `type` -> `slug` (the exact precedence the
 * production `fetchSportsMarketTypes` parser proves). Malformed/unknown shapes
 * yield an empty Set (no throw); an empty Set means "no restriction" at the
 * call site. Does not mutate its input.
 */
export function normalizeValidSportsMarketTypes(value: unknown): Set<string> {
  const out = new Set<string>();
  let entries: unknown[] = [];
  if (Array.isArray(value)) {
    entries = value;
  } else if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).marketTypes)) {
    entries = (value as Record<string, unknown>).marketTypes as unknown[];
  }
  for (const entry of entries) {
    let text: unknown = null;
    if (typeof entry === "string") {
      text = entry;
    } else if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      text = o.name ?? o.type ?? o.slug ?? null;
    }
    if (typeof text === "string") {
      const normalized = text.trim().toLowerCase();
      if (normalized !== "") out.add(normalized);
    }
  }
  return out;
}

/**
 * Splits a Gamma sportsMarketType/marketType token into a base type plus an
 * optional period scope suffix (e.g. `round_handicap_game_2` ->
 * { base: "round_handicap", periodScope: "GAME_2" }). No suffix -> null scope.
 */
function parseSportsMarketType(lower: string): { base: string; periodScope: string | null } {
  const m = lower.match(/^(.*?)_(game|map|set|period|quarter|half)_(\d+)$/);
  if (m) return { base: m[1], periodScope: `${m[2].toUpperCase()}_${m[3]}` };
  return { base: lower, periodScope: null };
}

/**
 * Market-type classification, evidence-priority order: official market type
 * (`marketType`, or `sportsMarketType` when marketType is absent), parsed for
 * a period scope and mapped to a locked family; validated against the
 * official /sports/market-types list when present. Unmapped/invalid official
 * types remain visible as UNSUPPORTED_OFFICIAL_MARKET_TYPE. Never defaults an
 * unresolved market to moneyline -- that heuristic exists only in the V1
 * slug-based classifier, not here.
 */
export function classifyMarketTypeV2(row: Row, snapshot: MetadataEnrichmentSnapshot): MarketClassificationV2 {
  const market = lookupMarketMetadata(row, snapshot);
  const rawType = market ? market.marketType ?? market.sportsMarketType ?? null : null;

  if (market && rawType) {
    const lower = rawType.toLowerCase();
    const { base, periodScope } = parseSportsMarketType(lower);
    const family =
      OFFICIAL_MARKET_TYPE_FAMILY[lower] ?? SPORTS_MARKET_TYPE_BASE_FAMILY[base] ?? OFFICIAL_MARKET_TYPE_FAMILY[base];
    const validTypes = normalizeValidSportsMarketTypes(snapshot.validSportsMarketTypes);
    const isValidOfficialType = validTypes.size === 0 || validTypes.has(lower);

    if (!family || !isValidOfficialType) {
      return {
        officialMarketType: rawType,
        marketFamily: "UNSUPPORTED_OFFICIAL_MARKET_TYPE",
        marketSubtype: null,
        participantScope: null,
        periodScope,
        classificationConfidence: "LOW",
        residualReason: "UNSUPPORTED_OFFICIAL_MARKET_TYPE",
      };
    }

    return {
      officialMarketType: rawType,
      marketFamily: family,
      marketSubtype: null,
      participantScope: lower.includes("player") ? "PLAYER" : lower.includes("team") ? "TEAM" : "MATCH",
      periodScope,
      classificationConfidence: "HIGH",
      residualReason: null,
    };
  }

  return {
    officialMarketType: null,
    marketFamily: "UNKNOWN",
    marketSubtype: null,
    participantScope: null,
    periodScope: null,
    classificationConfidence: "UNKNOWN",
    residualReason: market ? "NO_MARKET_TYPE_FIELD" : "OFFICIAL_MARKET_NOT_FOUND",
  };
}

export interface OtherDecompositionResult {
  previousOtherRows: number;
  reclassifiedRows: number;
  remainingRows: number;
  reclassificationRatePct: number;
  remainingByReason: Record<string, number>;
}

/**
 * Decomposes a previously-OTHER/UNKNOWN row set against a metadata
 * snapshot: how many now resolve to a real sport (reclassified) vs. remain
 * unresolved (with an explicit reason). Pure; never mutates `rows`.
 */
export function decomposeOtherBucket(rows: readonly Row[], snapshot: MetadataEnrichmentSnapshot): OtherDecompositionResult {
  let reclassified = 0;
  const remainingByReason: Record<string, number> = {};
  for (const row of rows) {
    const c = classifySportV2(row, snapshot);
    if (c.residualReason === null) {
      reclassified += 1;
    } else {
      remainingByReason[c.residualReason] = (remainingByReason[c.residualReason] ?? 0) + 1;
    }
  }
  const remaining = rows.length - reclassified;
  return {
    previousOtherRows: rows.length,
    reclassifiedRows: reclassified,
    remainingRows: remaining,
    reclassificationRatePct: rows.length > 0 ? (reclassified / rows.length) * 100 : 0,
    remainingByReason,
  };
}

// ---- Segment metrics ----

export type SampleStatus = "ROBUST_SAMPLE" | "MODERATE_SAMPLE" | "LOW_SAMPLE";

function sampleStatusOf(signals: number): SampleStatus {
  if (signals >= 100) return "ROBUST_SAMPLE";
  if (signals >= 30) return "MODERATE_SAMPLE";
  return "LOW_SAMPLE";
}

export interface SegmentMetrics {
  signals: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  pnlUnits: number | null;
  roiPct: number | null;
  maxDrawdownUnits: number;
  uniqueConditionTokenPairs: number;
  uniqueMarkets: number;
  uniqueEventGroups: number;
  eventsWithMultipleSignals: number;
  maxSignalsPerEvent: number;
  averageSignalsPerEvent: number;
}

function getStr(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function computeSegmentMetrics(rows: readonly Row[]): SegmentMetrics {
  const roi = computeFlatStakeRoiSummary([...rows], { strict: false, stakeUnits: 1 });
  const equity = computeFlatUnitEquityMetrics(rows);

  const pairs = new Set<string>();
  const markets = new Set<string>();
  const eventCounts = new Map<string, number>();
  for (const row of rows) {
    const cond = getStr(row, "condition_id");
    const tok = getStr(row, "token_id") ?? getStr(row, "selected_token_id");
    if (cond !== null && tok !== null) pairs.add(`${cond}::${tok}`);
    if (cond !== null) markets.add(cond);
    const key = buildEventGroupKey(row).key;
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }
  const counts = Array.from(eventCounts.values());

  return {
    signals: rows.length,
    wins: roi.winCount,
    losses: roi.lossCount,
    winRatePct: roi.winRatePct,
    pnlUnits: roi.totalPnlUnits,
    roiPct: roi.roiPct,
    maxDrawdownUnits: equity.maximumDrawdownUnits,
    uniqueConditionTokenPairs: pairs.size,
    uniqueMarkets: markets.size,
    uniqueEventGroups: eventCounts.size,
    eventsWithMultipleSignals: counts.filter((c) => c > 1).length,
    maxSignalsPerEvent: counts.length > 0 ? Math.max(...counts) : 0,
    averageSignalsPerEvent: eventCounts.size > 0 ? rows.length / eventCounts.size : 0,
  };
}

export interface SegmentBucket {
  label: string;
  classificationConfidence: ClassificationConfidence;
  metrics: SegmentMetrics;
  sampleStatus: SampleStatus;
}

function bucketByLabel(
  rows: readonly Row[],
  labelOf: (row: Row) => { label: string; confidence: ClassificationConfidence },
): SegmentBucket[] {
  const groups = new Map<string, { rows: Row[]; confidence: ClassificationConfidence }>();
  for (const row of rows) {
    const { label, confidence } = labelOf(row);
    const bucket = groups.get(label) ?? { rows: [], confidence };
    bucket.rows.push(row);
    groups.set(label, bucket);
  }
  return Array.from(groups.entries())
    .map(([label, { rows: bucketRows, confidence }]) => ({
      label,
      classificationConfidence: confidence,
      metrics: computeSegmentMetrics(bucketRows),
      sampleStatus: sampleStatusOf(bucketRows.length),
    }))
    .sort((a, b) => b.metrics.signals - a.metrics.signals || a.label.localeCompare(b.label));
}

// ---- Leaderboards ----

export interface LeaderEntry {
  label: string;
  signals: number;
  roiPct: number | null;
  pnlUnits: number | null;
}

const ROI_LEADERBOARD_MIN_SAMPLE = 30;

function topByRoi(buckets: SegmentBucket[], n: number): LeaderEntry[] {
  return [...buckets]
    .filter((b) => b.metrics.signals >= ROI_LEADERBOARD_MIN_SAMPLE && b.metrics.roiPct !== null)
    .sort((a, b) => (b.metrics.roiPct ?? 0) - (a.metrics.roiPct ?? 0))
    .slice(0, n)
    .map((b) => ({ label: b.label, signals: b.metrics.signals, roiPct: b.metrics.roiPct, pnlUnits: b.metrics.pnlUnits }));
}

function topByPnl(buckets: SegmentBucket[], n: number): LeaderEntry[] {
  return [...buckets]
    .filter((b) => b.metrics.pnlUnits !== null)
    .sort((a, b) => (b.metrics.pnlUnits ?? 0) - (a.metrics.pnlUnits ?? 0))
    .slice(0, n)
    .map((b) => ({ label: b.label, signals: b.metrics.signals, roiPct: b.metrics.roiPct, pnlUnits: b.metrics.pnlUnits }));
}

function worstByPnl(buckets: SegmentBucket[], n: number): LeaderEntry[] {
  return [...buckets]
    .filter((b) => b.metrics.pnlUnits !== null)
    .sort((a, b) => (a.metrics.pnlUnits ?? 0) - (b.metrics.pnlUnits ?? 0))
    .slice(0, n)
    .map((b) => ({ label: b.label, signals: b.metrics.signals, roiPct: b.metrics.roiPct, pnlUnits: b.metrics.pnlUnits }));
}

// ---- Event concentration ----

export interface ConcentratedGroup {
  eventGroupKeyHash: string;
  signals: number;
  pnlUnits: number | null;
  roiPct: number | null;
}

export interface EventConcentration {
  totalSignals: number;
  uniqueEventGroups: number;
  averageSignalsPerEvent: number;
  eventsWithMultipleSignals: number;
  shareOfSignalsFromMultiSignalEvents: number;
  maxSignalsPerEvent: number;
  topConcentratedGroups: ConcentratedGroup[];
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function computeEventConcentration(rows: readonly Row[]): EventConcentration {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = buildEventGroupKey(row).key;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const entries = Array.from(groups.entries());
  const counts = entries.map(([, g]) => g.length);
  const multiSignalRows = entries.filter(([, g]) => g.length > 1).reduce((s, [, g]) => s + g.length, 0);

  const top = [...entries]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([key, g]) => {
      const roi = computeFlatStakeRoiSummary(g, { strict: false, stakeUnits: 1 });
      return { eventGroupKeyHash: hashKey(key), signals: g.length, pnlUnits: roi.totalPnlUnits, roiPct: roi.roiPct };
    });

  return {
    totalSignals: rows.length,
    uniqueEventGroups: groups.size,
    averageSignalsPerEvent: groups.size > 0 ? rows.length / groups.size : 0,
    eventsWithMultipleSignals: counts.filter((c) => c > 1).length,
    shareOfSignalsFromMultiSignalEvents: rows.length > 0 ? (multiSignalRows / rows.length) * 100 : 0,
    maxSignalsPerEvent: counts.length > 0 ? Math.max(...counts) : 0,
    topConcentratedGroups: top,
  };
}

// ---- Top-level model slice ----

export interface ModelSlice {
  variantId: string;
  outputRows: number;
  overallPnlUnits: number | null;
  overallRoiPct: number | null;
  sportBreakdown: SegmentBucket[];
  marketTypeBreakdown: SegmentBucket[];
  leaders: {
    topSportsByRoi: LeaderEntry[];
    topSportsByPnl: LeaderEntry[];
    topMarketsByRoi: LeaderEntry[];
    topMarketsByPnl: LeaderEntry[];
    worstSportsByPnl: LeaderEntry[];
    worstMarketsByPnl: LeaderEntry[];
  };
  eventConcentration: EventConcentration;
  // Retained ONLY for same-process test verification against
  // computeFlatStakeRoiSummary; never serialized into a written report.
  selectedRowsForVerificationOnly?: Row[];
}

export interface CrossModelRow {
  label: string;
  PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: { signals: number; pnlUnits: number | null; roiPct: number | null } | null;
  ALT2_TS_SCORE_GE_65: { signals: number; pnlUnits: number | null; roiPct: number | null } | null;
  ALT1_CANONICAL_EVENT_GROUPING: { signals: number; pnlUnits: number | null; roiPct: number | null } | null;
}

export interface ClassificationCoverage {
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  UNKNOWN: number;
}

export interface SportMarketPerformanceSlice {
  schemaVersion: 1;
  corpusRowCount: number;
  models: ModelSlice[];
  crossModelSportMatrix: CrossModelRow[];
  crossModelMarketMatrix: CrossModelRow[];
  classificationCoverage: { sport: ClassificationCoverage; marketType: ClassificationCoverage };
  metadataSnapshotInfo?: { corpusHash: string; snapshotHash: string; status: string };
}

function computeCorpusHash(rows: readonly Row[]): string {
  const ordered = [...rows].sort((a, b) => {
    const ak = `${getStr(a, "condition_id") ?? ""}::${getStr(a, "token_id") ?? ""}`;
    const bk = `${getStr(b, "condition_id") ?? ""}::${getStr(b, "token_id") ?? ""}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function coverageOf(rows: readonly Row[], classify: (r: Row) => { classificationConfidence: ClassificationConfidence }): ClassificationCoverage {
  const total = rows.length;
  const counts: ClassificationCoverage = { HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const row of rows) counts[classify(row).classificationConfidence] += 1;
  if (total === 0) return counts;
  return {
    HIGH: (counts.HIGH / total) * 100,
    MEDIUM: (counts.MEDIUM / total) * 100,
    LOW: (counts.LOW / total) * 100,
    UNKNOWN: (counts.UNKNOWN / total) * 100,
  };
}

function buildCrossModelMatrix(
  models: ModelSlice[],
  pickBreakdown: (m: ModelSlice) => SegmentBucket[],
): CrossModelRow[] {
  const labels = new Set<string>();
  for (const m of models) for (const b of pickBreakdown(m)) labels.add(b.label);

  return Array.from(labels)
    .sort()
    .map((label) => {
      const cell = (variantId: string): CrossModelRow[keyof CrossModelRow] extends never ? never : { signals: number; pnlUnits: number | null; roiPct: number | null } | null => {
        const m = models.find((x) => x.variantId === variantId);
        const b = m ? pickBreakdown(m).find((x) => x.label === label) : undefined;
        return b ? { signals: b.metrics.signals, pnlUnits: b.metrics.pnlUnits, roiPct: b.metrics.roiPct } : null;
      };
      return {
        label,
        PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: cell("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"),
        ALT2_TS_SCORE_GE_65: cell("ALT2_TS_SCORE_GE_65"),
        ALT1_CANONICAL_EVENT_GROUPING: cell("ALT1_CANONICAL_EVENT_GROUPING"),
      };
    });
}

export interface BuildOptions {
  rows: readonly Row[];
  classifier: ExecutableFunnelClassifier;
  candidateIds: readonly string[];
  expectedCorpusSha256?: string;
  // Phase 3E.8D: when supplied, sport classification uses the V2
  // official-metadata-aware classifier (classifySportV2); market-type
  // classification still uses the V1 slug-based classifier for the
  // marketTypeBreakdown table (V2 market-type figures are exposed
  // separately via classifyMarketTypeV2 for callers that want them). Row
  // selection, ROI/PnL, and event concentration are entirely unaffected by
  // this option -- metadata enrichment never changes model output.
  metadataSnapshot?: MetadataEnrichmentSnapshot;
}

/**
 * Builds the sport/market performance slice for the three analyzed models.
 * Row selection is delegated entirely to evaluateHistoricalFunnelVariant
 * (against the classifier's own declared funnel) -- no predicate is
 * reimplemented here. Pure: no fs/env/network access. Throws if
 * expectedCorpusSha256 is supplied and does not match.
 */
export function buildSportMarketPerformanceSlice(options: BuildOptions): SportMarketPerformanceSlice {
  const { rows, classifier, candidateIds, expectedCorpusSha256, metadataSnapshot } = options;

  const corpusSha256 = computeCorpusHash(rows);
  if (expectedCorpusSha256 && corpusSha256 !== expectedCorpusSha256) {
    throw new Error(`sport/market performance slice: corpus hash mismatch (expected ${expectedCorpusSha256}, computed ${corpusSha256})`);
  }

  const models: ModelSlice[] = candidateIds.map((variantId) => {
    if (!getBundle(classifier, variantId)) {
      throw new Error(`sport/market performance slice: unknown bundle ${variantId}`);
    }
    const evalResult = evaluateHistoricalFunnelVariant(rows, classifier, variantId);
    const selected = evalResult.selectedRows;
    const roi = computeFlatStakeRoiSummary([...selected], { strict: false, stakeUnits: 1 });

    const sportBreakdown = bucketByLabel(selected, (row) => {
      if (metadataSnapshot) {
        const c = classifySportV2(row, metadataSnapshot);
        return { label: c.sportFamily, confidence: c.classificationConfidence };
      }
      const c = classifySport(row);
      return { label: c.sportKey, confidence: c.classificationConfidence };
    });
    const marketTypeBreakdown = bucketByLabel(selected, (row) => {
      if (metadataSnapshot) {
        const c = classifyMarketTypeV2(row, metadataSnapshot);
        return { label: c.marketFamily, confidence: c.classificationConfidence };
      }
      const c = classifyMarketType(row);
      return { label: c.marketKey, confidence: c.classificationConfidence };
    });

    return {
      variantId,
      outputRows: selected.length,
      overallPnlUnits: roi.totalPnlUnits,
      overallRoiPct: roi.roiPct,
      sportBreakdown,
      marketTypeBreakdown,
      leaders: {
        topSportsByRoi: topByRoi(sportBreakdown, 3),
        topSportsByPnl: topByPnl(sportBreakdown, 3),
        topMarketsByRoi: topByRoi(marketTypeBreakdown, 3),
        topMarketsByPnl: topByPnl(marketTypeBreakdown, 3),
        worstSportsByPnl: worstByPnl(sportBreakdown, 3),
        worstMarketsByPnl: worstByPnl(marketTypeBreakdown, 3),
      },
      eventConcentration: computeEventConcentration(selected),
      selectedRowsForVerificationOnly: selected,
    };
  });

  return {
    schemaVersion: 1,
    corpusRowCount: rows.length,
    models,
    crossModelSportMatrix: buildCrossModelMatrix(models, (m) => m.sportBreakdown),
    crossModelMarketMatrix: buildCrossModelMatrix(models, (m) => m.marketTypeBreakdown),
    classificationCoverage: {
      sport: coverageOf(rows, classifySport),
      marketType: coverageOf(rows, classifyMarketType),
    },
    ...(metadataSnapshot
      ? {
          metadataSnapshotInfo: {
            corpusHash: metadataSnapshot.corpusHash,
            snapshotHash: metadataSnapshot.snapshotHash,
            status: metadataSnapshot.status,
          },
        }
      : {}),
  };
}
