export const FIREMODEL1_1_SUPPORTED_SPORT_FAMILIES = [
  "soccer",
  "tennis",
  "baseball",
  "esports",
  "basketball",
  "cricket",
  "hockey",
  "mma",
] as const;

export type SupportedScoreSportFamily = typeof FIREMODEL1_1_SUPPORTED_SPORT_FAMILIES[number];
export type ProviderSportFamily = SupportedScoreSportFamily | "table-tennis" | string;
export type SportScoreOwnership = "SUPPORTED_BY_SCORE_MODEL" | "INTENTIONALLY_UNSCORED";

const SUPPORTED = new Set<string>(FIREMODEL1_1_SUPPORTED_SPORT_FAMILIES);
const EXACT_FAMILY_ALIASES: Readonly<Record<string, ProviderSportFamily>> = {
  football: "soccer",
  mlb: "baseball",
  nba: "basketball",
  wnba: "basketball",
  nhl: "hockey",
  ufc: "mma",
  cs2: "esports",
  dota: "esports",
  lol: "esports",
  val: "esports",
  valorant: "esports",
  "table tennis": "table-tennis",
};

function exactStructuredTagValues(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const values: string[] = [];
  for (const tag of tags) {
    if (!tag || typeof tag !== "object") continue;
    const record = tag as Record<string, unknown>;
    for (const value of [record.slug, record.label]) {
      if (typeof value === "string" && value.trim()) values.push(value.trim().toLowerCase());
    }
  }
  return values;
}

export function normalizeProviderSportFamily(value: unknown): ProviderSportFamily | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const exact = value.trim().toLowerCase();
  return EXACT_FAMILY_ALIASES[exact] ?? exact;
}

/** Structured tags are authoritative; the provider league code is an exact fallback only. */
export function resolveStructuredSportFamily(
  providerTags: unknown,
  providerSportCode: unknown,
): ProviderSportFamily | null {
  for (const value of exactStructuredTagValues(providerTags)) {
    const family = normalizeProviderSportFamily(value);
    if (family && (SUPPORTED.has(family) || family === "table-tennis")) return family;
  }
  const fallback = normalizeProviderSportFamily(providerSportCode);
  return fallback && (SUPPORTED.has(fallback) || fallback === "table-tennis") ? fallback : null;
}

export function scoreOwnershipForSportFamily(family: unknown): SportScoreOwnership {
  const normalized = normalizeProviderSportFamily(family);
  return normalized !== null && SUPPORTED.has(normalized)
    ? "SUPPORTED_BY_SCORE_MODEL"
    : "INTENTIONALLY_UNSCORED";
}

export const MODEL_SCOPE_BY_STRUCTURED_SPORT_FAMILY = Object.freeze({
  soccer: "SOCCER",
  tennis: "TENNIS",
  baseball: "MLB",
  esports: "ESPORT",
  basketball: "BASKETBALL",
  cricket: "CRICKET",
  hockey: "HOCKEY",
  mma: "MMA",
} as const);

export function hasStructuredScoredSportAuthority(diagnostics: unknown): boolean {
  if (!diagnostics || typeof diagnostics !== "object") return false;
  const record = diagnostics as Record<string, unknown>;
  const context = record.providerEventContext;
  if (!context || typeof context !== "object") return false;
  const providerContext = context as Record<string, unknown>;
  const nonEmpty = (value: unknown) => typeof value === "string" && value.trim() !== "";
  const providerEventId = nonEmpty(record.providerEventId) ? record.providerEventId as string : null;
  const providerMarketId = nonEmpty(record.providerMarketId) ? record.providerMarketId as string : null;
  const providerSportCode = nonEmpty(record.providerSportCode) ? record.providerSportCode as string : null;
  const providerSportFamily = nonEmpty(record.providerSportFamily) ? record.providerSportFamily as string : null;
  return providerSportFamily !== null &&
    scoreOwnershipForSportFamily(record.providerSportFamily) === "SUPPORTED_BY_SCORE_MODEL" &&
    providerEventId !== null &&
    providerMarketId !== null &&
    providerContext.eventId === providerEventId &&
    nonEmpty(providerContext.eventStartIso) &&
    Number.isFinite(Date.parse(providerContext.eventStartIso as string)) &&
    providerContext.providerMarketId === providerMarketId &&
    providerContext.sportFamily === providerSportFamily &&
    (providerContext.league ?? null) === providerSportCode;
}
