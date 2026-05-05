// Probe Polymarket Sports Docs
// Phase 3.6A — Docs-based Polymarket sports API probe
// Determines whether production discovery should be markets-first, events-first, or hybrid

import fs from "fs";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

const CONFIG = {
  windowHours: 24,
  fallbackWindowHours: 48,
  fetchVolumeMinUsd: 50000,
  finalEventVolumeMinUsd: 100000,
  targetCards: 5,
  maxMarketsPerFetch: 500,
  probeTagId: "100639", // Optional probe tag
};

// ============================================================================
// SAFE HELPERS
// ============================================================================

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

function lower(value: unknown): string {
  return toText(value).toLowerCase();
}

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

function extractTagsText(value: unknown): string[] {
  const arr = parseJsonArray(value);
  return arr.map(toText).filter(Boolean);
}

function compactMoney(value: number | null): string {
  if (value === null || value === undefined) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

async function safeFetchJson(url: string, label: string): Promise<{ data: unknown | null; error: string | null; status: number }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { data: null, error: `HTTP ${response.status}`, status: response.status };
    }

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      return { data, error: null, status: response.status };
    } catch (parseErr) {
      return { data: text, error: "JSON parse error", status: response.status };
    }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err), status: 0 };
  }
}

// ============================================================================
// TYPES
// ============================================================================

type SportsProbeMarketCandidate = {
  id: string;
  slug: string;
  question: string;
  conditionId?: string;
  active?: boolean;
  closed?: boolean;
  marketType?: string;
  formatType?: string;
  sportsMarketType?: string;
  gameId?: string;
  teamAID?: string;
  teamBID?: string;
  gameStartTime?: string;
  eventStartTime?: string;
  startDate?: string;
  startDateIso?: string;
  endDate?: string;
  endDateIso?: string;
  nestedEventId?: string;
  nestedEventSlug?: string;
  nestedEventTitle?: string;
  nestedEventStartTime?: string;
  nestedEventEndDate?: string;
  outcomes: string[];
  outcomePrices: number[];
  shortOutcomes: string[];
  clobTokenIds: string[];
  volumeNum: number | null;
  volume24hr: number | null;
  volume24hrClob: number | null;
  volumeClob: number | null;
  liquidityNum: number | null;
  liquidityClob: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  oneDayPriceChange: number | null;
  oneHourPriceChange: number | null;
  tagsText: string[];
  raw: Record<string, unknown>;
};

type GameGroup = {
  groupKey: string;
  markets: SportsProbeMarketCandidate[];
  gameId?: string;
  nestedEventId?: string;
  teamAID?: string;
  teamBID?: string;
  resolvedGameTimeIso: string | null;
  gameTimeSource: string;
  gameTimeConfidence: "high" | "medium" | "low" | "none";
  eventVolumeUsd: number;
  highestVolumeMarket: SportsProbeMarketCandidate | null;
  primaryMarket: SportsProbeMarketCandidate | null;
};

type FinalCandidate = {
  rank: number;
  title: string;
  gameId?: string;
  sportsMarketType?: string;
  eventVolumeUsd: number;
  resolvedGameTimeIso: string | null;
  gameTimeSource: string;
  gameTimeConfidence: "high" | "medium" | "low" | "none";
  strategy: string;
  primaryMarketId: string;
  groupMarketsCount: number;
};

// ============================================================================
// PARSING FUNCTIONS
// ============================================================================

function parseMarket(raw: Record<string, unknown>): SportsProbeMarketCandidate {
  // Parse outcomes fields
  const outcomes = extractTagsText(raw.outcomes);
  const outcomePrices = parseJsonArray(raw.outcomePrices).map(toNumber).filter((n): n is number => n !== null);
  const shortOutcomes = extractTagsText(raw.shortOutcomes);
  const clobTokenIds = extractTagsText(raw.clobTokenIds);

  // Extract volume
  const volumeNum = toNumber(raw.volumeNum ?? raw.volume ?? raw.liquidity);
  const volume24hr = toNumber(raw.volume24hr);
  const volume24hrClob = toNumber(raw.volume24hrClob);
  const volumeClob = toNumber(raw.volumeClob);
  const liquidityNum = toNumber(raw.liquidityNum ?? raw.liquidity);
  const liquidityClob = toNumber(raw.liquidityClob);

  // Extract nested event info
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

  return {
    id: toText(raw.id) || "unknown",
    slug: toText(raw.slug),
    question: toText(raw.question),
    conditionId: toText(raw.conditionId),
    active: raw.active === true || lower(raw.active) === "true",
    closed: raw.closed === true || lower(raw.closed) === "true" || lower(raw.closed) === "yes",
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

function canonicalMarketVolume(m: SportsProbeMarketCandidate): { volume: number; source: string } {
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

// ============================================================================
// GAME TIME RESOLUTION
// ============================================================================

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

function resolveGameTime(m: SportsProbeMarketCandidate): {
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

  // Strong game signal check for end dates
  const strongSignal = m.gameId || m.sportsMarketType;

  // Medium: nested event end date (if strong signal exists)
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

  // Low: slug date
  if (m.slug) {
    const slugDate = extractDateFromSlug(m.slug);
    if (slugDate) {
      return { resolvedGameTimeIso: slugDate.toISOString(), gameTimeSource: "slug-date", gameTimeConfidence: "low" };
    }
  }

  return { resolvedGameTimeIso: null, gameTimeSource: "none", gameTimeConfidence: "none" };
}

// ============================================================================
// CLASSIFICATION
// ============================================================================

const FUTURES_KEYWORDS = [
  "champion", "championship", "cup winner", "tournament winner", "league winner", "season winner",
  "who will win", "stanley cup champion", "nba champion", "fifa world cup winner",
  "premier league winner", "laliga winner", "la liga winner", "bundesliga winner", "serie a winner",
  "mvp", "award", "nominee", "2027", "2028", "2029", "election", "crypto", "bitcoin",
  "ethereum", "russia", "ukraine", "nato", "macron", "putin", "biden", "trump",
];

function isFuturesMarket(m: SportsProbeMarketCandidate, allText: string): boolean {
  // Strong game signals override futures keywords
  const strongSignal = m.gameId || m.sportsMarketType || m.gameStartTime || m.eventStartTime;
  if (strongSignal) return false;

  const lowerText = allText.toLowerCase();
  return FUTURES_KEYWORDS.some(kw => lowerText.includes(kw));
}

function getAllMarketText(m: SportsProbeMarketCandidate): string {
  return [m.question, m.slug, m.nestedEventTitle, ...m.tagsText].filter(Boolean).join(" ");
}

function classifyGameSignal(m: SportsProbeMarketCandidate): { level: "strong" | "medium" | "weak"; reasons: string[] } {
  const reasons: string[] = [];

  if (m.gameId) reasons.push("gameId");
  if (m.sportsMarketType) reasons.push("sportsMarketType");
  if (m.gameStartTime) reasons.push("gameStartTime");
  if (m.eventStartTime) reasons.push("eventStartTime");
  if (m.nestedEventStartTime) reasons.push("nestedEventStartTime");
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

// ============================================================================
// GROUPING
// ============================================================================

function createGroupKey(m: SportsProbeMarketCandidate): string {
  if (m.gameId) return `game:${m.gameId}`;
  if (m.nestedEventId) return `event:${m.nestedEventId}`;
  if (m.teamAID && m.teamBID) {
    const date = m.gameStartTime || m.eventStartTime || m.nestedEventStartTime || m.endDateIso;
    const dateKey = date ? date.split("T")[0] : "nodate";
    return `teams:${m.teamAID}:${m.teamBID}:${dateKey}`;
  }

  // Fallback to slug + date
  const slugBase = m.slug.replace(/-\d{4}-\d{2}-\d{2}.*$/, "").replace(/-\d+$/, "");
  const dateStr = m.gameStartTime || m.eventStartTime || m.nestedEventStartTime || m.endDateIso || "";
  const dateKey = dateStr.split("T")[0] || "nodate";
  return `slug:${slugBase}:${dateKey}`;
}

function groupMarketsByGame(markets: SportsProbeMarketCandidate[]): GameGroup[] {
  const groups = new Map<string, SportsProbeMarketCandidate[]>();

  for (const m of markets) {
    const key = createGroupKey(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  return Array.from(groups.entries()).map(([groupKey, markets]) => {
    // Resolve best game time
    let bestTime: { iso: string | null; source: string; confidence: "high" | "medium" | "low" | "none" } = {
      iso: null, source: "none", confidence: "none"
    };

    // Find highest confidence time
    for (const m of markets) {
      const time = resolveGameTime(m);
      const confidenceOrder = { high: 3, medium: 2, low: 1, none: 0 };
      if (confidenceOrder[time.gameTimeConfidence] > confidenceOrder[bestTime.confidence]) {
        bestTime = { iso: time.resolvedGameTimeIso, source: time.gameTimeSource, confidence: time.gameTimeConfidence };
      }
    }

    // Calculate total volume
    let totalVolume = 0;
    let highestVolumeMarket: SportsProbeMarketCandidate | null = null;
    let maxVolume = 0;

    for (const m of markets) {
      const { volume } = canonicalMarketVolume(m);
      totalVolume += volume;
      if (volume > maxVolume) {
        maxVolume = volume;
        highestVolumeMarket = m;
      }
    }

    // Determine primary market (moneyline/match winner preferred, then highest volume)
    let primaryMarket: SportsProbeMarketCandidate | null = highestVolumeMarket;
    for (const m of markets) {
      const q = m.question.toLowerCase();
      if (q.includes("winner") || q.includes("moneyline") || q.includes("match") || q.includes("who will win")) {
        primaryMarket = m;
        break;
      }
    }

    // Extract game info from first market
    const first = markets[0];

    return {
      groupKey,
      markets,
      gameId: first.gameId,
      nestedEventId: first.nestedEventId,
      teamAID: first.teamAID,
      teamBID: first.teamBID,
      resolvedGameTimeIso: bestTime.iso,
      gameTimeSource: bestTime.source,
      gameTimeConfidence: bestTime.confidence,
      eventVolumeUsd: totalVolume,
      highestVolumeMarket,
      primaryMarket,
    };
  });
}

// ============================================================================
// FETCH FUNCTIONS
// ============================================================================

type EndpointResult = {
  name: string;
  url: string;
  status: number;
  error: string | null;
  returnedCount: number;
  sampleQuestions?: string[];
  sampleTitles?: string[];
  firstKeys?: string[];
  extractedTags?: string[];
};

async function fetchSportsMetadata(): Promise<{ sports: unknown[]; extractedTags: string[]; result: EndpointResult }> {
  const url = `${GAMMA_API_BASE}/sports`;
  const { data, error, status } = await safeFetchJson(url, "/sports");

  const sports = Array.isArray(data) ? data : [];
  const extractedTags: string[] = [];

  for (const s of sports) {
    const sport = s as Record<string, unknown>;
    const tagsVal = sport.tags;
    if (typeof tagsVal === "string") {
      extractedTags.push(...tagsVal.split(",").map(t => t.trim()).filter(Boolean));
    } else if (Array.isArray(tagsVal)) {
      extractedTags.push(...tagsVal.map(toText).filter(Boolean));
    }
  }

  const uniqueTags = [...new Set(extractedTags)];

  const result: EndpointResult = {
    name: "/sports",
    url,
    status,
    error,
    returnedCount: sports.length,
    sampleTitles: sports.slice(0, 10).map(s => toText((s as Record<string, unknown>).name || (s as Record<string, unknown>).slug).substring(0, 50)),
    extractedTags: uniqueTags.slice(0, 20),
  };

  return { sports, extractedTags: uniqueTags, result };
}

async function fetchMarketTypes(): Promise<{ types: string[]; result: EndpointResult }> {
  const url = `${GAMMA_API_BASE}/sports/market-types`;
  const { data, error, status } = await safeFetchJson(url, "/sports/market-types");

  const types: string[] = [];
  if (Array.isArray(data)) {
    for (const t of data) {
      const text = toText(typeof t === "string" ? t : (t as Record<string, unknown>).name || (t as Record<string, unknown>).type || (t as Record<string, unknown>).slug);
      if (text) types.push(text);
    }
  }

  const result: EndpointResult = {
    name: "/sports/market-types",
    url,
    status,
    error,
    returnedCount: types.length,
    sampleTitles: types.slice(0, 10),
  };

  return { types, result };
}

async function fetchTeams(): Promise<{ teams: unknown[]; count: number; result: EndpointResult }> {
  const url = `${GAMMA_API_BASE}/teams`;
  const { data, error, status } = await safeFetchJson(url, "/teams");

  const teams = Array.isArray(data) ? data : [];

  const result: EndpointResult = {
    name: "/teams",
    url,
    status,
    error,
    returnedCount: teams.length,
    sampleTitles: teams.slice(0, 5).map(t => toText((t as Record<string, unknown>).name || (t as Record<string, unknown>).abbreviation).substring(0, 30)),
  };

  return { teams, count: teams.length, result };
}

async function fetchMarketsByTag(
  tagId: string,
  mode: "A" | "B" | "C",
  marketType?: string
): Promise<{ markets: SportsProbeMarketCandidate[]; result: EndpointResult }> {
  let url: string;

  if (mode === "A") {
    url = `${GAMMA_API_BASE}/markets?closed=false&tag_id=${tagId}&related_tags=true&include_tag=true&volume_num_min=${CONFIG.fetchVolumeMinUsd}&limit=${CONFIG.maxMarketsPerFetch}`;
  } else if (mode === "B") {
    url = `${GAMMA_API_BASE}/markets?closed=false&tag_id=${tagId}&include_tag=true&volume_num_min=${CONFIG.fetchVolumeMinUsd}&limit=${CONFIG.maxMarketsPerFetch}`;
  } else {
    url = `${GAMMA_API_BASE}/markets?closed=false&tag_id=${tagId}&related_tags=true&include_tag=true&sports_market_types=${encodeURIComponent(marketType || "")}&volume_num_min=${CONFIG.fetchVolumeMinUsd}&limit=${CONFIG.maxMarketsPerFetch}`;
  }

  const { data, error, status } = await safeFetchJson(url, `markets-${mode}-${tagId}`);

  let rawMarkets: Record<string, unknown>[] = [];
  if (Array.isArray(data)) {
    rawMarkets = data;
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) rawMarkets = obj.data as Record<string, unknown>[];
    else if (Array.isArray(obj.markets)) rawMarkets = obj.markets as Record<string, unknown>[];
    else if (Array.isArray(obj.results)) rawMarkets = obj.results as Record<string, unknown>[];
  }

  const markets = rawMarkets.map(parseMarket);

  const result: EndpointResult = {
    name: `markets-${mode}`,
    url,
    status,
    error,
    returnedCount: markets.length,
    sampleQuestions: markets.slice(0, 5).map(m => m.question.substring(0, 60)),
    firstKeys: rawMarkets.length > 0 ? Object.keys(rawMarkets[0]).slice(0, 10) : [],
  };

  return { markets, result };
}

async function fetchEventsByTag(tagId: string): Promise<{ events: unknown[]; result: EndpointResult }> {
  const url = `${GAMMA_API_BASE}/events?active=true&closed=false&tag_id=${tagId}&related_tags=true&volume_min=${CONFIG.fetchVolumeMinUsd}&limit=${CONFIG.maxMarketsPerFetch}`;
  const { data, error, status } = await safeFetchJson(url, `events-${tagId}`);

  const events = Array.isArray(data) ? data : [];

  const result: EndpointResult = {
    name: "events-fallback",
    url,
    status,
    error,
    returnedCount: events.length,
    sampleTitles: events.slice(0, 5).map(e => toText((e as Record<string, unknown>).title || (e as Record<string, unknown>).slug).substring(0, 50)),
  };

  return { events, result };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + CONFIG.windowHours * 60 * 60 * 1000);
  const fallbackWindowEnd = new Date(now.getTime() + CONFIG.fallbackWindowHours * 60 * 60 * 1000);

  console.log("\n" + "=".repeat(80));
  console.log("PROBE POLYMARKET SPORTS DOCS");
  console.log("=".repeat(80));
  console.log("\nCONFIG:", { ...CONFIG, nowIso: now.toISOString(), windowEndIso: windowEnd.toISOString() });

  const endpointResults: EndpointResult[] = [];
  const allMarkets: SportsProbeMarketCandidate[] = [];

  // 1. Fetch /sports
  console.log("\n" + "-".repeat(40));
  console.log("1. FETCH /sports");
  console.log("-".repeat(40));
  const { sports, extractedTags: sportsTagIds, result: sportsResult } = await fetchSportsMetadata();
  endpointResults.push(sportsResult);
  console.log(`SPORTS: count=${sports.length}, tags=${sportsTagIds.slice(0, 10).join(", ")}`);
  if (sportsResult.sampleTitles) {
    console.log("Sample sports:", sportsResult.sampleTitles.slice(0, 5));
  }

  // Add probe tag if not present
  if (!sportsTagIds.includes(CONFIG.probeTagId)) {
    sportsTagIds.push(CONFIG.probeTagId);
  }

  // 2. Fetch /sports/market-types
  console.log("\n" + "-".repeat(40));
  console.log("2. FETCH /sports/market-types");
  console.log("-".repeat(40));
  const { types: marketTypes, result: marketTypesResult } = await fetchMarketTypes();
  endpointResults.push(marketTypesResult);
  console.log(`MARKET_TYPES: count=${marketTypes.length}`);
  console.log("Types:", marketTypes.slice(0, 10));

  // 3. Fetch /teams
  console.log("\n" + "-".repeat(40));
  console.log("3. FETCH /teams");
  console.log("-".repeat(40));
  const { teams, result: teamsResult } = await fetchTeams();
  endpointResults.push(teamsResult);
  console.log(`TEAMS: count=${teams.length}`);

  // 4. Fetch markets by sports tags
  console.log("\n" + "-".repeat(40));
  console.log("4. FETCH MARKETS BY SPORTS TAGS");
  console.log("-".repeat(40));

  let marketRequests = 0;
  let marketRequestSuccess = 0;
  let marketRequestFailed = 0;

  for (const tagId of sportsTagIds.slice(0, 5)) { // Limit to first 5 tags
    // Mode A
    marketRequests++;
    const { markets: marketsA, result: resultA } = await fetchMarketsByTag(tagId, "A");
    if (!resultA.error) marketRequestSuccess++; else marketRequestFailed++;
    endpointResults.push(resultA);
    allMarkets.push(...marketsA);
    console.log(`[${tagId}] Mode A: ${marketsA.length} markets`);

    // Mode B
    marketRequests++;
    const { markets: marketsB, result: resultB } = await fetchMarketsByTag(tagId, "B");
    if (!resultB.error) marketRequestSuccess++; else marketRequestFailed++;
    endpointResults.push(resultB);
    allMarkets.push(...marketsB);
    console.log(`[${tagId}] Mode B: ${marketsB.length} markets`);

    // Mode C for first 3 market types
    for (const mtype of marketTypes.slice(0, 3)) {
      marketRequests++;
      const { markets: marketsC, result: resultC } = await fetchMarketsByTag(tagId, "C", mtype);
      if (!resultC.error) marketRequestSuccess++; else marketRequestFailed++;
      endpointResults.push(resultC);
      allMarkets.push(...marketsC);
      if (marketsC.length > 0) {
        console.log(`[${tagId}] Mode C (${mtype}): ${marketsC.length} markets`);
      }
    }

    // Events fallback
    const { result: eventsResult } = await fetchEventsByTag(tagId);
    endpointResults.push(eventsResult);
    console.log(`[${tagId}] Events fallback: ${eventsResult.returnedCount} events`);
  }

  // Deduplicate markets
  const seenIds = new Set<string>();
  const uniqueMarkets = allMarkets.filter(m => {
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });

  console.log(`\nDEDUPLICATED: ${uniqueMarkets.length} unique markets from ${allMarkets.length} total`);

  // 5. Normalize and classify
  console.log("\n" + "-".repeat(40));
  console.log("5. CLASSIFY AND ANALYZE");
  console.log("-".repeat(40));

  const normalizedMarkets = uniqueMarkets;
  const activeMarkets = normalizedMarkets.filter(m => m.active && !m.closed);
  const closedRejected = normalizedMarkets.filter(m => m.closed);

  // Track field availability
  const withGameId = normalizedMarkets.filter(m => m.gameId).length;
  const withSportsMarketType = normalizedMarkets.filter(m => m.sportsMarketType).length;
  const withTeamIds = normalizedMarkets.filter(m => m.teamAID && m.teamBID).length;
  const withGameStartTime = normalizedMarkets.filter(m => m.gameStartTime).length;
  const withEventStartTime = normalizedMarkets.filter(m => m.eventStartTime).length;
  const withNestedEventStartTime = normalizedMarkets.filter(m => m.nestedEventStartTime).length;

  console.log(`FIELDS: gameId=${withGameId}, sportsMarketType=${withSportsMarketType}, teamIds=${withTeamIds}`);
  console.log(`FIELDS: gameStartTime=${withGameStartTime}, eventStartTime=${withEventStartTime}, nestedEventStartTime=${withNestedEventStartTime}`);

  // Game signal classification
  const strongGameSignalCandidates: SportsProbeMarketCandidate[] = [];
  const mediumGameSignalCandidates: SportsProbeMarketCandidate[] = [];
  const futuresRejected: SportsProbeMarketCandidate[] = [];

  for (const m of activeMarkets) {
    const allText = getAllMarketText(m);
    const signal = classifyGameSignal(m);

    if (isFuturesMarket(m, allText)) {
      futuresRejected.push(m);
    } else if (signal.level === "strong") {
      strongGameSignalCandidates.push(m);
    } else if (signal.level === "medium") {
      mediumGameSignalCandidates.push(m);
    }
  }

  console.log(`CLASSIFICATION: strong=${strongGameSignalCandidates.length}, medium=${mediumGameSignalCandidates.length}, futures=${futuresRejected.length}`);

  // Group markets
  const gameLikeMarkets = [...strongGameSignalCandidates, ...mediumGameSignalCandidates];
  const groupedGames = groupMarketsByGame(gameLikeMarkets);

  console.log(`GROUPING: ${groupedGames.length} game groups from ${gameLikeMarkets.length} markets`);

  // Filter by time
  const within24hGroups = groupedGames.filter(g => {
    if (!g.resolvedGameTimeIso) return false;
    const d = new Date(g.resolvedGameTimeIso);
    const hoursUntil = (d.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursUntil >= 0 && hoursUntil <= CONFIG.windowHours && (g.gameTimeConfidence === "high" || g.gameTimeConfidence === "medium");
  });

  const within48hGroups = groupedGames.filter(g => {
    if (!g.resolvedGameTimeIso) return false;
    const d = new Date(g.resolvedGameTimeIso);
    const hoursUntil = (d.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursUntil >= 0 && hoursUntil <= CONFIG.fallbackWindowHours && (g.gameTimeConfidence === "high" || g.gameTimeConfidence === "medium");
  });

  console.log(`TIME: within24h=${within24hGroups.length}, within48h=${within48hGroups.length}`);

  // Filter by volume
  const volumeEligible24hGroups = within24hGroups.filter(g => g.eventVolumeUsd >= CONFIG.finalEventVolumeMinUsd);
  const volumeEligible48hGroups = within48hGroups.filter(g => g.eventVolumeUsd >= CONFIG.finalEventVolumeMinUsd);

  console.log(`VOLUME: eligible24h=${volumeEligible24hGroups.length}, eligible48h=${volumeEligible48hGroups.length}`);

  // Sort by volume
  volumeEligible24hGroups.sort((a, b) => b.eventVolumeUsd - a.eventVolumeUsd);
  volumeEligible48hGroups.sort((a, b) => b.eventVolumeUsd - a.eventVolumeUsd);

  // Final candidates
  const finalCandidates: FinalCandidate[] = volumeEligible24hGroups.slice(0, CONFIG.targetCards).map((g, idx) => ({
    rank: idx + 1,
    title: g.primaryMarket?.question || g.highestVolumeMarket?.question || "Unknown",
    gameId: g.gameId,
    sportsMarketType: g.primaryMarket?.sportsMarketType,
    eventVolumeUsd: g.eventVolumeUsd,
    resolvedGameTimeIso: g.resolvedGameTimeIso,
    gameTimeSource: g.gameTimeSource,
    gameTimeConfidence: g.gameTimeConfidence,
    strategy: "markets-first",
    primaryMarketId: g.primaryMarket?.id || "unknown",
    groupMarketsCount: g.markets.length,
  }));

  const fallback48hCandidates: FinalCandidate[] = volumeEligible48hGroups
    .filter(g => !finalCandidates.some(fc => fc.primaryMarketId === (g.primaryMarket?.id || "")))
    .slice(0, CONFIG.targetCards)
    .map((g, idx) => ({
      rank: idx + 1,
      title: g.primaryMarket?.question || g.highestVolumeMarket?.question || "Unknown",
      gameId: g.gameId,
      sportsMarketType: g.primaryMarket?.sportsMarketType,
      eventVolumeUsd: g.eventVolumeUsd,
      resolvedGameTimeIso: g.resolvedGameTimeIso,
      gameTimeSource: g.gameTimeSource,
      gameTimeConfidence: g.gameTimeConfidence,
      strategy: "markets-first-48h",
      primaryMarketId: g.primaryMarket?.id || "unknown",
      groupMarketsCount: g.markets.length,
    }));

  // Low confidence candidates
  const lowConfidenceTimeCandidates = groupedGames.filter(g => {
    if (!g.resolvedGameTimeIso) return false;
    const d = new Date(g.resolvedGameTimeIso);
    const hoursUntil = (d.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursUntil >= 0 && hoursUntil <= CONFIG.windowHours && g.gameTimeConfidence === "low" && g.eventVolumeUsd >= CONFIG.finalEventVolumeMinUsd;
  }).sort((a, b) => b.eventVolumeUsd - a.eventVolumeUsd).slice(0, 10);

  // 6. Build report
  console.log("\n" + "-".repeat(40));
  console.log("6. DIAGNOSIS");
  console.log("-".repeat(40));

  let diagnosis: string;
  let recommendedProductionDiscoveryPath: string;

  if (finalCandidates.length >= 4) {
    diagnosis = "READY_FOR_PRODUCTION_DISCOVERY";
    recommendedProductionDiscoveryPath = "markets-first";
  } else if (finalCandidates.length < 4 && fallback48hCandidates.length >= 4) {
    diagnosis = "24H_SUPPLY_LOW_48H_WORKS";
    recommendedProductionDiscoveryPath = "markets-first-with-48h-fallback";
  } else if (uniqueMarkets.length > 0 && strongGameSignalCandidates.length > 0 && finalCandidates.length === 0) {
    diagnosis = "TIME_OR_VOLUME_FILTER_TOO_STRICT";
    recommendedProductionDiscoveryPath = "review-filters";
  } else if (uniqueMarkets.length > 0 && strongGameSignalCandidates.length === 0) {
    diagnosis = "SPORTS_TAG_MARKETS_NOT_GAME_SPECIFIC";
    recommendedProductionDiscoveryPath = "add-game-specific-queries";
  } else if (marketRequestFailed > marketRequestSuccess) {
    diagnosis = "MARKETS_ENDPOINT_OR_QUERY_PARAM_PROBLEM";
    recommendedProductionDiscoveryPath = "review-endpoint-params";
  } else {
    diagnosis = "INSUFFICIENT_SPORTS_DISCOVERY_SUPPLY";
    recommendedProductionDiscoveryPath = "hybrid-with-events-fallback";
  }

  console.log(`DIAGNOSIS: ${diagnosis}`);
  console.log(`RECOMMENDED_PATH: ${recommendedProductionDiscoveryPath}`);

  // Time field source counts
  const timeFieldSourceCounts: Record<string, number> = {};
  const volumeFieldSourceCounts: Record<string, number> = {};

  for (const m of normalizedMarkets) {
    const time = resolveGameTime(m);
    timeFieldSourceCounts[time.gameTimeSource] = (timeFieldSourceCounts[time.gameTimeSource] || 0) + 1;

    const vol = canonicalMarketVolume(m);
    volumeFieldSourceCounts[vol.source] = (volumeFieldSourceCounts[vol.source] || 0) + 1;
  }

  // 7. Summary output
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  const summary = {
    sportsMetadataCount: sports.length,
    sportsTagIds: sportsTagIds.slice(0, 10),
    marketTypesCount: marketTypes.length,
    teamsCount: teams.length,
    rawMarketsFetched: allMarkets.length,
    withGameId,
    withSportsMarketType,
    withTeamIds,
    withGameStartTime,
    withEventStartTime,
    strongGameSignalCandidates: strongGameSignalCandidates.length,
    groupedGames: groupedGames.length,
    within24hGroups: within24hGroups.length,
    volumeEligible24hGroups: volumeEligible24hGroups.length,
    finalCandidates: finalCandidates.length,
    fallback48hCandidates: fallback48hCandidates.length,
    diagnosis,
    recommendedProductionDiscoveryPath,
  };

  Object.entries(summary).forEach(([k, v]) => {
    console.log(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  });

  // Top game-like markets by volume
  const topGameLikeMarketsByVolume = gameLikeMarkets
    .map(m => ({ m, vol: canonicalMarketVolume(m).volume }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 20)
    .map(({ m, vol }) => ({
      question: m.question.substring(0, 60),
      slug: m.slug.substring(0, 40),
      volume: compactMoney(vol),
      gameId: m.gameId || "none",
      sportsMarketType: m.sportsMarketType || "none",
    }));

  console.log("\nTop 20 game-like markets by volume:");
  console.table(topGameLikeMarketsByVolume);

  // Final candidates table
  if (finalCandidates.length > 0) {
    console.log("\nFINAL CANDIDATES (24h):");
    console.table(finalCandidates.map(c => ({
      rank: c.rank,
      title: c.title.substring(0, 50),
      gameId: c.gameId || "none",
      sportsMarketType: c.sportsMarketType || "none",
      volume: compactMoney(c.eventVolumeUsd),
      time: c.resolvedGameTimeIso?.substring(0, 16) || "none",
      confidence: c.gameTimeConfidence,
      strategy: c.strategy,
    })));
  }

  // Fallback candidates
  if (fallback48hCandidates.length > 0) {
    console.log("\nFALLBACK CANDIDATES (48h):");
    console.table(fallback48hCandidates.map(c => ({
      rank: c.rank,
      title: c.title.substring(0, 50),
      volume: compactMoney(c.eventVolumeUsd),
      time: c.resolvedGameTimeIso?.substring(0, 16) || "none",
      confidence: c.gameTimeConfidence,
    })));
  }

  // 8. Write report
  const report = {
    config: { ...CONFIG, nowIso: now.toISOString(), windowEndIso: windowEnd.toISOString(), fallbackWindowEndIso: fallbackWindowEnd.toISOString() },
    sportsMetadataSummary: {
      count: sports.length,
      first10: sportsResult.sampleTitles,
      extractedTagIds: sportsTagIds.slice(0, 20),
    },
    sportsTagIds,
    marketTypesSummary: {
      count: marketTypes.length,
      normalizedTypes: marketTypes.slice(0, 20),
    },
    teamsSummary: {
      count: teams.length,
      sample: teamsResult.sampleTitles,
    },
    endpointResults,
    countsByStage: {
      sportsMetadataCount: sports.length,
      extractedSportsTagIds: sportsTagIds.length,
      marketTypesCount: marketTypes.length,
      teamsCount: teams.length,
      marketRequests,
      marketRequestSuccess,
      marketRequestFailed,
      rawMarketsFetched: allMarkets.length,
      normalizedMarkets: normalizedMarkets.length,
      activeMarkets: activeMarkets.length,
      closedRejected: closedRejected.length,
      withGameId,
      withSportsMarketType,
      withTeamIds,
      withGameStartTime,
      withEventStartTime,
      withNestedEventStartTime,
      strongGameSignalCandidates: strongGameSignalCandidates.length,
      mediumGameSignalCandidates: mediumGameSignalCandidates.length,
      futuresRejected: futuresRejected.length,
      groupedGames: groupedGames.length,
      within24hGroups: within24hGroups.length,
      within48hGroups: within48hGroups.length,
      volumeEligible24hGroups: volumeEligible24hGroups.length,
      finalCandidates: finalCandidates.length,
      fallback48hCandidates: fallback48hCandidates.length,
    },
    timeFieldSourceCounts,
    volumeFieldSourceCounts,
    topGameLikeMarketsByVolume,
    groupedGameSamples: groupedGames.slice(0, 10).map(g => ({
      groupKey: g.groupKey,
      gameId: g.gameId,
      marketsCount: g.markets.length,
      eventVolumeUsd: g.eventVolumeUsd,
      resolvedGameTimeIso: g.resolvedGameTimeIso,
      gameTimeSource: g.gameTimeSource,
      gameTimeConfidence: g.gameTimeConfidence,
      primaryQuestion: g.primaryMarket?.question?.substring(0, 60) || "none",
    })),
    lowConfidenceTimeCandidates: lowConfidenceTimeCandidates.map(g => ({
      groupKey: g.groupKey,
      eventVolumeUsd: g.eventVolumeUsd,
      resolvedGameTimeIso: g.resolvedGameTimeIso,
      gameTimeSource: g.gameTimeSource,
      primaryQuestion: g.primaryMarket?.question?.substring(0, 60) || "none",
    })),
    finalCandidates,
    fallback48hCandidates,
    diagnosis,
    recommendedProductionDiscoveryPath,
  };

  console.log("\n" + "-".repeat(40));
  console.log("Writing probe-polymarket-sports-docs-report.json...");
  fs.writeFileSync("probe-polymarket-sports-docs-report.json", JSON.stringify(report, null, 2));
  console.log("Done.");

  console.log("\n" + "=".repeat(80));
  console.log("END PROBE POLYMARKET SPORTS DOCS");
  console.log("=".repeat(80) + "\n");
}

main().catch(error => {
  console.error("Script failed:", error);
  process.exit(1);
});
