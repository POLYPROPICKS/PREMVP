// LIQUIDITY_MODEL — pure sport/market-family normalization and gating.
//
// P0 gating order (enforced by callers):
//   1. normalize sport (UNKNOWN reported separately, never silently mixed)
//   2. normalize market family
//   3. market-family gate (supported families only)
//   4. hard market-level volume gate (>= LIQUIDITY_MIN_MARKET_VOLUME_USD)
// Only after all gates pass may an orderbook be fetched/stored.

import type {
  GateStatusDb,
  MarketFamily,
  MarketFamilyGateStatus,
  NormalizedSport,
  VolumeGateStatus,
  VolumeScope,
  WatchlistCandidate,
} from "./types";

export const DEFAULT_MIN_MARKET_VOLUME_USD = 10000;

const SPORT_ALIASES: Record<string, NormalizedSport> = {
  soccer: "soccer",
  football: "soccer", // association football
  futbol: "soccer",
  fussball: "soccer",
  epl: "soccer",
  laliga: "soccer",
  "la liga": "soccer",
  ucl: "soccer",
  mls: "soccer",
  basketball: "basketball",
  nba: "basketball",
  wnba: "basketball",
  ncaab: "basketball",
  euroleague: "basketball",
  baseball: "baseball",
  mlb: "baseball",
  npb: "baseball",
  kbo: "baseball",
  tennis: "tennis",
  atp: "tennis",
  wta: "tennis",
  hockey: "hockey",
  "ice hockey": "hockey",
  nhl: "hockey",
  khl: "hockey",
  americanfootball: "american_football",
  american_football: "american_football",
  "american football": "american_football",
  nfl: "american_football",
  ncaaf: "american_football",
  cfb: "american_football",
  mma: "mma",
  ufc: "mma",
  bellator: "mma",
  boxing: "boxing",
  cricket: "cricket",
  ipl: "cricket",
  bbl: "cricket",
  rugby: "rugby",
  "rugby union": "rugby",
  "rugby league": "rugby",
  nrl: "rugby",
  golf: "golf",
  pga: "golf",
  racing: "racing",
  f1: "racing",
  "formula 1": "racing",
  formula1: "racing",
  nascar: "racing",
  motogp: "racing",
  horse_racing: "racing",
  "horse racing": "racing",
  esports: "esports",
  esport: "esports",
  csgo: "esports",
  cs2: "esports",
  dota: "esports",
  dota2: "esports",
  lol: "esports",
  valorant: "esports",
};

const KNOWN_SPORTS: ReadonlySet<NormalizedSport> = new Set<NormalizedSport>([
  "soccer",
  "basketball",
  "baseball",
  "tennis",
  "hockey",
  "american_football",
  "mma",
  "boxing",
  "cricket",
  "rugby",
  "golf",
  "racing",
  "esports",
]);

/** Normalize a raw sport/league string to a first-class NormalizedSport. */
export function normalizeSport(raw: unknown): NormalizedSport {
  if (raw === null || raw === undefined) return "UNKNOWN";
  const key = String(raw).trim().toLowerCase();
  if (!key) return "UNKNOWN";
  if (SPORT_ALIASES[key]) return SPORT_ALIASES[key];
  // Direct match against canonical sport ids (e.g. "american_football").
  if (KNOWN_SPORTS.has(key as NormalizedSport)) return key as NormalizedSport;
  // Loose token containment for noisy league strings.
  for (const [alias, sport] of Object.entries(SPORT_ALIASES)) {
    if (alias.length >= 3 && key.includes(alias)) return sport;
  }
  return "UNKNOWN";
}

const MONEYLINE_ALIASES = new Set([
  "moneyline",
  "money_line",
  "ml",
  "match_winner",
  "full_match_winner",
  "game_winner",
  "winner",
  "h2h",
  "1x2", // 3-way still resolves to a winner family for P0
  "to_win",
  "result",
]);

const SPREAD_ALIASES = new Set([
  "spread",
  "spreads",
  "point_spread",
  "pointspread",
  "handicap",
  "asian_handicap",
  "run_line",
  "runline",
  "puck_line",
  "puckline",
]);

const TOTAL_ALIASES = new Set([
  "total",
  "totals",
  "over_under",
  "over/under",
  "ou",
  "match_total",
  "game_total",
  "team_total",
]);

const OUTRIGHT_FUTURE_TOKENS = [
  "outright",
  "futures",
  "future",
  "tournament_winner",
  "tournament winner",
  "championship_winner",
  "championship winner",
  "season_winner",
  "season winner",
  "to_win_tournament",
  "to win the",
  "champion",
  "mvp",
];

const PROP_TOKENS = [
  "player_prop",
  "player prop",
  "team_prop",
  "team prop",
  "prop",
  "anytime_scorer",
  "anytime scorer",
  "to_score",
  "to score",
  "assists",
  "rebounds",
  "strikeouts",
  "passing_yards",
  "rushing_yards",
];

const EXACT_SCORE_TOKENS = ["exact_score", "exact score", "correct_score", "correct score"];

const NOVELTY_POLITICS_TOKENS = [
  "novelty",
  "politics",
  "political",
  "election",
  "award",
  "oscars",
  "weather",
];

function normalizeKey(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim().toLowerCase().replace(/\s+/g, "_");
}

/** True when the market is an outright/futures/long-horizon winner market. */
export function detectOutrightOrFuture(raw: unknown): boolean {
  const k = normalizeKey(raw);
  if (!k) return false;
  const spaced = k.replace(/_/g, " ");
  return OUTRIGHT_FUTURE_TOKENS.some((t) => k.includes(normalizeKey(t)) || spaced.includes(t));
}

/** True when the market is a player/team prop. */
export function detectPropMarket(raw: unknown): boolean {
  const k = normalizeKey(raw);
  if (!k) return false;
  const spaced = k.replace(/_/g, " ");
  return PROP_TOKENS.some((t) => k.includes(normalizeKey(t)) || spaced.includes(t));
}

/**
 * Normalize a raw market family/type string to a supported MarketFamily.
 * Excluded categories (outright/futures/prop/exact_score/etc.) return UNKNOWN —
 * use computeMarketFamilyGate for the gate decision with reasons.
 */
export function normalizeMarketFamily(raw: unknown): MarketFamily {
  const k = normalizeKey(raw);
  if (!k) return "UNKNOWN";
  // Exclusions take priority so "match_winner_outright" never maps to moneyline.
  if (detectOutrightOrFuture(raw) || detectPropMarket(raw)) return "UNKNOWN";
  if (MONEYLINE_ALIASES.has(k)) return "moneyline";
  if (SPREAD_ALIASES.has(k)) return "spread";
  if (TOTAL_ALIASES.has(k)) return "total";
  // Loose containment fallbacks.
  if ([...SPREAD_ALIASES].some((a) => k.includes(a))) return "spread";
  if ([...TOTAL_ALIASES].some((a) => k.includes(a))) return "total";
  if ([...MONEYLINE_ALIASES].some((a) => a.length >= 4 && k.includes(a))) return "moneyline";
  return "UNKNOWN";
}

/**
 * Market-family gate. Returns SUPPORTED only for moneyline/spread/total that
 * are not outright/futures/prop/exact-score/novelty/politics.
 */
export function computeMarketFamilyGate(rawMarketFamily: unknown): {
  family: MarketFamily;
  status: MarketFamilyGateStatus;
} {
  const k = normalizeKey(rawMarketFamily);
  if (NOVELTY_POLITICS_TOKENS.some((t) => k.includes(normalizeKey(t)))) {
    return { family: "UNKNOWN", status: "EXCLUDED_NOVELTY_POLITICS" };
  }
  if (EXACT_SCORE_TOKENS.some((t) => k.includes(normalizeKey(t)))) {
    return { family: "UNKNOWN", status: "EXCLUDED_EXACT_SCORE" };
  }
  if (detectOutrightOrFuture(rawMarketFamily)) {
    return { family: "UNKNOWN", status: "EXCLUDED_OUTRIGHT_FUTURE" };
  }
  if (detectPropMarket(rawMarketFamily)) {
    return { family: "UNKNOWN", status: "EXCLUDED_PROP" };
  }
  const family = normalizeMarketFamily(rawMarketFamily);
  if (family === "UNKNOWN") {
    return { family: "UNKNOWN", status: "EXCLUDED_UNKNOWN_FAMILY" };
  }
  return { family, status: "SUPPORTED" };
}

export interface VolumeGateInput {
  volumeUsd: number | null | undefined;
  volumeScope?: VolumeScope | null;
  /** Optional age of the volume figure in minutes; > maxAgeMinutes => stale. */
  volumeAgeMinutes?: number | null;
}

export interface VolumeGateResult {
  status: VolumeGateStatus;
  passed: boolean;
  effectiveVolumeUsd: number | null;
  scope: VolumeScope | null;
}

/**
 * Hard market-level volume gate. Unknown/missing/stale volume does NOT pass.
 * Event-level volume passes only when explicitly scoped as
 * 'event_level_not_market_level' and above threshold (PASS_EVENT_LEVEL).
 */
export function computeMarketVolumeGate(
  input: VolumeGateInput,
  minVolumeUsd: number = DEFAULT_MIN_MARKET_VOLUME_USD,
  maxAgeMinutes: number = 24 * 60,
): VolumeGateResult {
  const { volumeUsd, volumeScope, volumeAgeMinutes } = input;
  const scope = volumeScope ?? "market_level";

  if (volumeUsd === null || volumeUsd === undefined || !Number.isFinite(volumeUsd)) {
    return { status: "FAIL_MISSING_VOLUME", passed: false, effectiveVolumeUsd: null, scope };
  }
  if (volumeUsd < 0) {
    return { status: "FAIL_UNKNOWN", passed: false, effectiveVolumeUsd: volumeUsd, scope };
  }
  if (
    volumeAgeMinutes !== null &&
    volumeAgeMinutes !== undefined &&
    Number.isFinite(volumeAgeMinutes) &&
    volumeAgeMinutes > maxAgeMinutes
  ) {
    return { status: "FAIL_STALE_VOLUME", passed: false, effectiveVolumeUsd: volumeUsd, scope };
  }
  if (volumeUsd < minVolumeUsd) {
    return { status: "FAIL_BELOW_THRESHOLD", passed: false, effectiveVolumeUsd: volumeUsd, scope };
  }
  if (scope === "event_level_not_market_level") {
    return { status: "PASS_EVENT_LEVEL", passed: true, effectiveVolumeUsd: volumeUsd, scope };
  }
  return { status: "PASS", passed: true, effectiveVolumeUsd: volumeUsd, scope };
}

/** Convenience boolean for a volume gate status. */
export function isVolumeGatePassed(status: VolumeGateStatus): boolean {
  return status === "PASS" || status === "PASS_EVENT_LEVEL";
}

/** Map the internal family gate enum to the DB-facing gate status string. */
export function marketFamilyGateToDb(status: MarketFamilyGateStatus): GateStatusDb {
  return status === "SUPPORTED" ? "passed" : "rejected";
}

/** Map the internal volume gate enum to the DB-facing gate status string. */
export function volumeGateToDb(status: VolumeGateStatus): GateStatusDb {
  return isVolumeGatePassed(status) ? "passed" : "rejected";
}

/** Map a failed volume gate status to a stable diagnostic reason code. */
export function classifyVolumeGateFailure(status: VolumeGateStatus): string {
  switch (status) {
    case "FAIL_BELOW_THRESHOLD":
      return "volume_below_threshold";
    case "FAIL_MISSING_VOLUME":
      return "volume_missing";
    case "FAIL_STALE_VOLUME":
      return "volume_stale";
    case "FAIL_UNKNOWN":
      return "volume_unknown";
    case "PASS":
    case "PASS_EVENT_LEVEL":
      return "volume_pass";
    default:
      return "volume_unknown";
  }
}

/** Sort candidates within a sport by descending priority (volume-weighted). */
export function rankCandidatesWithinSport(
  candidates: WatchlistCandidate[],
): WatchlistCandidate[] {
  return [...candidates].sort(compareCandidatePriority);
}

/** Same ranking but intended for use within a sport+family bucket. */
export function rankCandidatesWithinSportFamily(
  candidates: WatchlistCandidate[],
): WatchlistCandidate[] {
  return [...candidates].sort(compareCandidatePriority);
}

function compareCandidatePriority(a: WatchlistCandidate, b: WatchlistCandidate): number {
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
  const av = a.volumeUsd ?? -1;
  const bv = b.volumeUsd ?? -1;
  if (bv !== av) return bv - av;
  return a.tokenId.localeCompare(b.tokenId);
}

export interface PerSportCapConfig {
  /** Default per-sport cap. */
  sportTokenLimit: number;
  /** Per-sport cap for UNKNOWN sport (typically small or 0). */
  unknownSportLimit: number;
  /** Optional per-sport overrides. */
  overrides?: Partial<Record<NormalizedSport, number>>;
}

/**
 * Enforce per-sport token caps. Candidates are ranked within each sport and
 * truncated to the cap. UNKNOWN uses its own (small) limit and is never mixed
 * into known-sport buckets.
 */
export function enforcePerSportCaps(
  candidates: WatchlistCandidate[],
  config: PerSportCapConfig,
): { kept: WatchlistCandidate[]; droppedByCap: WatchlistCandidate[] } {
  const bySport = new Map<NormalizedSport, WatchlistCandidate[]>();
  for (const c of candidates) {
    const arr = bySport.get(c.normalizedSport) ?? [];
    arr.push(c);
    bySport.set(c.normalizedSport, arr);
  }
  const kept: WatchlistCandidate[] = [];
  const droppedByCap: WatchlistCandidate[] = [];
  for (const [sport, arr] of bySport) {
    const limit =
      config.overrides?.[sport] ??
      (sport === "UNKNOWN" ? config.unknownSportLimit : config.sportTokenLimit);
    const ranked = rankCandidatesWithinSport(arr);
    kept.push(...ranked.slice(0, Math.max(0, limit)));
    droppedByCap.push(...ranked.slice(Math.max(0, limit)));
  }
  return { kept, droppedByCap };
}

export interface PerSportFamilyCapConfig {
  /** Default per-(sport,family) cap. */
  sportFamilyTokenLimit: number;
  /** Per-(sport,family) cap for UNKNOWN family (typically 0). */
  unknownFamilyLimit: number;
  /** Optional per-family overrides. */
  overrides?: Partial<Record<MarketFamily, number>>;
}

/** Enforce per-(sport, family) token caps with ranking within each bucket. */
export function enforcePerSportFamilyCaps(
  candidates: WatchlistCandidate[],
  config: PerSportFamilyCapConfig,
): { kept: WatchlistCandidate[]; droppedByCap: WatchlistCandidate[] } {
  const byKey = new Map<string, WatchlistCandidate[]>();
  for (const c of candidates) {
    const key = `${c.normalizedSport}::${c.normalizedMarketFamily}`;
    const arr = byKey.get(key) ?? [];
    arr.push(c);
    byKey.set(key, arr);
  }
  const kept: WatchlistCandidate[] = [];
  const droppedByCap: WatchlistCandidate[] = [];
  for (const [key, arr] of byKey) {
    const family = key.split("::")[1] as MarketFamily;
    const limit =
      config.overrides?.[family] ??
      (family === "UNKNOWN" ? config.unknownFamilyLimit : config.sportFamilyTokenLimit);
    const ranked = rankCandidatesWithinSportFamily(arr);
    kept.push(...ranked.slice(0, Math.max(0, limit)));
    droppedByCap.push(...ranked.slice(Math.max(0, limit)));
  }
  return { kept, droppedByCap };
}
