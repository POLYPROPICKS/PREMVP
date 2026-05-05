// Normalize Polymarket market data
// Phase 3.6B — Markets-first sports discovery normalization

import type { SportsMarketCandidate } from "./types";

// Safe text extraction
function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  if (typeof value === "boolean") return value.toString();
  if (Array.isArray(value)) {
    return value.map(v => toText(v)).join(" ");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const fields = ["label", "slug", "name", "title", "category", "id", "question", "text"];
    for (const f of fields) {
      if (obj[f] !== undefined) return toText(obj[f]);
    }
    return Object.values(obj).map(v => toText(v)).join(" ");
  }
  return String(value);
}

// Safe array parsing
function parseJsonArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch {
      return value.split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

// Safe number parsing
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,]/g, "");
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

// Extract tags as text array
function extractTagsText(value: unknown): string[] {
  const arr = parseJsonArray(value);
  return arr.map(toText).filter(Boolean);
}

// Normalize raw market row to SportsMarketCandidate
export function normalizeSportsMarket(raw: Record<string, unknown>): SportsMarketCandidate {
  // Parse outcomes fields
  const outcomes = extractTagsText(raw.outcomes);
  const outcomePrices = parseJsonArray(raw.outcomePrices)
    .map(toNumber)
    .filter((n): n is number => n !== null);
  const shortOutcomes = extractTagsText(raw.shortOutcomes);
  const clobTokenIds = extractTagsText(raw.clobTokenIds);

  // Extract volume fields
  const volumeNum = toNumber(raw.volumeNum ?? raw.volume ?? raw.liquidity);
  const volume24hr = toNumber(raw.volume24hr);
  const volume24hrClob = toNumber(raw.volume24hrClob);
  const volumeClob = toNumber(raw.volumeClob);
  const liquidityNum = toNumber(raw.liquidityNum ?? raw.liquidity);
  const liquidityClob = toNumber(raw.liquidityClob);

  // Extract nested event info from events array
  let nestedEventId: string | undefined;
  let nestedEventSlug: string | undefined;
  let nestedEventTitle: string | undefined;
  let nestedEventStartTime: string | undefined;
  let nestedEventEndDate: string | undefined;

  const events = parseJsonArray(raw.events);
  if (events.length > 0) {
    const evt = events[0] as Record<string, unknown>;
    nestedEventId = toText(evt.id);
    nestedEventSlug = toText(evt.slug);
    nestedEventTitle = toText(evt.title ?? evt.eventTitle);
    nestedEventStartTime = toText(evt.startTime ?? evt.startDate ?? evt.eventStartTime);
    nestedEventEndDate = toText(evt.endDate ?? evt.endTime);
  }

  // Parse boolean fields
  const active = raw.active === true || toText(raw.active).toLowerCase() === "true";
  const closed = raw.closed === true || toText(raw.closed).toLowerCase() === "true" || toText(raw.closed).toLowerCase() === "yes";

  return {
    id: toText(raw.id) || "unknown",
    slug: toText(raw.slug),
    question: toText(raw.question),
    conditionId: toText(raw.conditionId),
    active,
    closed,
    marketType: toText(raw.marketType ?? raw.type),
    formatType: toText(raw.formatType),
    sportsMarketType: toText(raw.sportsMarketType),
    gameId: toText(raw.gameId),
    teamAID: toText(raw.teamAID ?? raw.teamAId),
    teamBID: toText(raw.teamBID ?? raw.teamBId),
    gameStartTime: toText(raw.gameStartTime),
    eventStartTime: toText(raw.eventStartTime),
    startDate: toText(raw.startDate),
    startDateIso: toText(raw.startDateIso),
    endDate: toText(raw.endDate),
    endDateIso: toText(raw.endDateIso),
    nestedEventId,
    nestedEventSlug,
    nestedEventTitle,
    nestedEventStartTime,
    nestedEventEndDate,
    outcomes,
    outcomePrices,
    shortOutcomes,
    clobTokenIds,
    volumeNum,
    volume24hr,
    volume24hrClob,
    volumeClob,
    liquidityNum,
    liquidityClob,
    bestBid: toNumber(raw.bestBid),
    bestAsk: toNumber(raw.bestAsk),
    oneDayPriceChange: toNumber(raw.oneDayPriceChange),
    oneHourPriceChange: toNumber(raw.oneHourPriceChange),
    tagsText: extractTagsText(raw.tags),
    raw,
  };
}

// Get canonical volume for a market (choose one field, don't sum multiple)
export function canonicalMarketVolume(m: SportsMarketCandidate): { volume: number; source: string } {
  const sources = [
    { val: m.volumeNum, name: "volumeNum" },
    { val: m.volumeClob, name: "volumeClob" },
    { val: m.volume24hrClob, name: "volume24hrClob" },
    { val: m.volume24hr, name: "volume24hr" },
    { val: m.liquidityNum, name: "liquidityNum" },
    { val: m.liquidityClob, name: "liquidityClob" },
  ];

  for (const src of sources) {
    if (src.val !== null && src.val > 0) {
      return { volume: src.val, source: src.name };
    }
  }
  return { volume: 0, source: "none" };
}

// Extract date from slug as fallback
function extractDateFromSlug(slug: string): Date | null {
  const match = slug.match(/(\d{4})[-_/]?(\d{2})[-_/]?(\d{2})/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);

  if (year < 2025 || year > 2030 || month < 0 || month > 11 || day < 1 || day > 31) {
    return null;
  }

  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

// Resolve game time from market with confidence level
export function resolveGameTime(m: SportsMarketCandidate): {
  resolvedGameTimeIso: string | null;
  gameTimeSource: string;
  gameTimeConfidence: "high" | "medium" | "low" | "none";
} {
  // High confidence: direct game time fields
  if (m.gameStartTime) {
    const d = new Date(m.gameStartTime);
    if (!isNaN(d.getTime())) {
      return { resolvedGameTimeIso: d.toISOString(), gameTimeSource: "gameStartTime", gameTimeConfidence: "high" };
    }
  }

  if (m.eventStartTime) {
    const d = new Date(m.eventStartTime);
    if (!isNaN(d.getTime())) {
      return { resolvedGameTimeIso: d.toISOString(), gameTimeSource: "eventStartTime", gameTimeConfidence: "high" };
    }
  }

  if (m.nestedEventStartTime) {
    const d = new Date(m.nestedEventStartTime);
    if (!isNaN(d.getTime())) {
      return { resolvedGameTimeIso: d.toISOString(), gameTimeSource: "nestedEventStartTime", gameTimeConfidence: "high" };
    }
  }

  // Check for strong game signal for medium confidence sources
  const strongSignal = m.gameId || m.sportsMarketType;

  // Medium: nested event end date with strong signal
  if (strongSignal && m.nestedEventEndDate) {
    const d = new Date(m.nestedEventEndDate);
    if (!isNaN(d.getTime())) {
      return { resolvedGameTimeIso: d.toISOString(), gameTimeSource: "nestedEventEndDate", gameTimeConfidence: "medium" };
    }
  }

  // Medium: end date with strong signal
  if (strongSignal && m.endDateIso) {
    const d = new Date(m.endDateIso);
    if (!isNaN(d.getTime())) {
      return { resolvedGameTimeIso: d.toISOString(), gameTimeSource: "endDateIso", gameTimeConfidence: "medium" };
    }
  }
  if (strongSignal && m.endDate) {
    const d = new Date(m.endDate);
    if (!isNaN(d.getTime())) {
      return { resolvedGameTimeIso: d.toISOString(), gameTimeSource: "endDate", gameTimeConfidence: "medium" };
    }
  }

  // Low: slug date extraction
  if (m.slug) {
    const slugDate = extractDateFromSlug(m.slug);
    if (slugDate) {
      return { resolvedGameTimeIso: slugDate.toISOString(), gameTimeSource: "slug-date", gameTimeConfidence: "low" };
    }
  }

  return { resolvedGameTimeIso: null, gameTimeSource: "none", gameTimeConfidence: "none" };
}

// Classification
const FUTURES_KEYWORDS = [
  "champion", "championship", "cup winner", "tournament winner", "league winner", "season winner",
  "who will win", "stanley cup champion", "nba champion", "fifa world cup winner",
  "premier league winner", "laliga winner", "la liga winner", "bundesliga winner", "serie a winner",
  "mvp", "award", "nominee", "2027", "2028", "2029", "election", "president", "crypto", "bitcoin",
  "ethereum", "russia", "ukraine", "nato", "macron", "putin", "biden", "trump",
];

function getAllMarketText(m: SportsMarketCandidate): string {
  return [m.question, m.slug, m.nestedEventTitle, ...m.tagsText].filter(Boolean).join(" ").toLowerCase();
}

export function isFuturesMarket(m: SportsMarketCandidate): boolean {
  // Strong game signals override futures keywords
  const strongSignal = m.gameId || (m.sportsMarketType && m.gameStartTime);
  if (strongSignal) return false;

  const allText = getAllMarketText(m);
  return FUTURES_KEYWORDS.some(kw => allText.includes(kw));
}

export function classifyGameSignal(m: SportsMarketCandidate): { level: "strong" | "medium" | "weak"; reasons: string[] } {
  const reasons: string[] = [];

  if (m.sportsMarketType) reasons.push("sportsMarketType");
  if (m.gameStartTime) reasons.push("gameStartTime");
  if (m.eventStartTime) reasons.push("eventStartTime");
  if (m.nestedEventStartTime) reasons.push("nestedEventStartTime");
  if (m.gameId) reasons.push("gameId");
  if (m.teamAID && m.teamBID) reasons.push("teamAID+teamBID");

  if (reasons.length >= 2) return { level: "strong", reasons };
  if (reasons.length === 1) return { level: "medium", reasons };

  // Check for team vs team pattern
  const allText = getAllMarketText(m);
  const teamVsTeamPattern = /\b\w+\s+(vs\.?|@|versus)\s+\w+/i;
  if (teamVsTeamPattern.test(allText)) {
    return { level: "medium", reasons: ["team-vs-team-pattern"] };
  }

  return { level: "weak", reasons: [] };
}
