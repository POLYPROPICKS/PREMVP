// TrustedInitialformulaLanding1.1 — Landing card builder
// Generates synchronized premiumSignal + marketSource pairs from Polymarket data
// NOTE: This is a display-grade deterministic signal generator, NOT real predictive ML.

import {
  FORMULA_VERSION,
  type LandingCardsResponse,
  type LandingCardPair,
  type LandingCardDiagnostics,
  type PremiumSignal,
  type MarketSource,
  type MarketSourceEvidenceCard,
  type TrustMetric,
  type PolymarketRawEvent,
  type PolymarketRawMarket,
  type PolymarketRawOutcome,
  type PolymarketPricePoint,
  type PolymarketTrade,
  type PolymarketHolder,
  type ResearchEligibleSignalSnapshot,
  type ResearchFunnelCounters,
  type ResearchNestedMarket,
} from "./types";

import {
  fetchPolymarketActiveEvents,
  fetchPolymarketSportsMetadataSafe,
  fetchPolymarketEventsByTagSafe,
  fetchPriceHistorySafe,
  fetchSpreadSafe,
  fetchOrderBookSafe,
  fetchTradesSafe,
  fetchHoldersSafe,
  fetchOpenInterestSafe,
} from "./polymarketClient";

import { discoverSportsMarkets } from "./discoverSportsMarkets";
import type { SportsDiscoverySample } from "./types";

import {
  safeNumber,
  safeString,
  compactMoney,
  formatTimeAgo,
  formatDeltaPp,
  formatEndTime,
  formatGameTime,
  slugify,
  clamp,
  roundNumber,
  computePotentialProfitPercent,
  computeDeltaPp,
  computeBandedSignalScore,
  getConfidenceLabel,
} from "./scorePolymarket";

// ── Odds-calibrated display calibration ───────────────────────────────────────
// Maps European selectedOdds to max display confidence, label and default action.
// Raw formula score is preserved in formulaAudit; only displayed value is capped.
type OddsBandCalibration = {
  min: number;
  max: number;
  label: string;
  action: "ENTER" | "SMALL" | "WATCH";
};

function getOddsBandCalibration(selectedOdds: number): OddsBandCalibration {
  // min = target lower guidance for audit only — NOT used in clamp to lift weak scores
  if (selectedOdds <= 1.44) return { min: 80, max: 90, label: "Strong Favorite",      action: "ENTER" };
  if (selectedOdds <= 1.70) return { min: 77, max: 86, label: "Favorite Edge",         action: "ENTER" };
  if (selectedOdds <= 2.20) return { min: 72, max: 82, label: "Core Signal",           action: "ENTER" };
  if (selectedOdds <= 2.70) return { min: 68, max: 74, label: "Value Lean",            action: "ENTER" };
  if (selectedOdds <= 3.50) return { min: 63, max: 68, label: "Underdog Value",        action: "SMALL" };
  if (selectedOdds <= 5.00) return { min: 58, max: 60, label: "Longshot Value",        action: "SMALL" };
  return                           { min: 52, max: 55, label: "High-Upside Longshot",  action: "WATCH" };
}

function sampleToCandidateMarket(sample: SportsDiscoverySample): CandidateMarket | null {
  const primary = sample.primaryMarketRaw;
  if (!primary || !primary.conditionId) return null;

  const market: PolymarketRawMarket = {
    id: primary.conditionId,
    conditionId: primary.conditionId,
    question: primary.question,
    slug: sample.slug,
    active: true,
    closed: false,
    outcomes: primary.outcomes as unknown as PolymarketRawOutcome[] | string,
    outcomePrices: primary.outcomePrices as unknown as Record<string, number> | string,
    clobTokenIds: primary.clobTokenIds as unknown as string[] | string,
    volume24hr: primary.volume24hr ?? undefined,
    oneDayPriceChange: primary.oneDayPriceChange ?? undefined,
  };

  const event: PolymarketRawEvent = {
    id: sample.gameId || sample.slug,
    title: sample.title,
    slug: sample.slug,
    active: true,
    closed: false,
    endDate: sample.resolvedGameTimeIso || undefined,
    markets: [market],
    category: "sports",
    volume24hr: sample.eventVolumeUsd,
  };

  (market as unknown as Record<string, unknown>)._parentMeta = {
    title: sample.title,
    slug: sample.slug,
    category: sample.leagueName || "Sports",
    endDate: sample.resolvedGameTimeIso || undefined,
    startDate: sample.resolvedGameTimeIso || undefined,
    polymarketEventSlug: sample.polymarketEventSlug || undefined,
    sportsMarketType: sample.primaryMarketRaw?.sportsMarketType ?? undefined,
    gameTimeConfidence: sample.gameTimeConfidence ?? undefined,
  };

  return {
    event,
    market,
    rejectionReasons: [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
    sportsMatchedKeyword: "sports-discovery",
  };
}

interface CandidateMarket {
  event: PolymarketRawEvent;
  market: PolymarketRawMarket;
  rejectionReasons: string[];
  warnings: string[];
  isSportsRelated: boolean;
  isEnded: boolean;
  sportsMatchedKeyword?: string;
  sportsBlockedKeyword?: string;
}

interface ParentEventMeta {
  title: string;
  slug: string;
  category?: string;
  endDate?: string;
  startDate?: string;
  polymarketEventSlug?: string;
}

interface EnrichedMarket {
  event: PolymarketRawEvent;
  market: PolymarketRawMarket;
  parentMeta: ParentEventMeta;
  selectedOutcome: { name: string; tokenId: string | null; price: number };
  priceHistory: PolymarketPricePoint[] | null;
  spread: { min: number; max: number } | null;
  orderBook: { bids: Array<[string, string]>; asks: Array<[string, string]> } | null;
  trades: PolymarketTrade[] | null;
  holders: PolymarketHolder[] | null;
  openInterest: number | null;
  gammaPriceChange: number | null; // oneDayPriceChange, oneWeekPriceChange, etc.
  diagnostics: LandingCardDiagnostics;
  warnings: string[];
}

/**
 * Safely parse JSON string or return as-is if already array
 */
function safeParseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed as T[];
      }
    } catch {
      // JSON parse failed
    }
  }
  return [];
}

/**
 * Safely parse numeric string to number
 */
function safeParseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return isNaN(value) ? null : value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "null" || trimmed === "undefined") return null;
    const parsed = parseFloat(trimmed);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Sports keywords ALLOWLIST - market must contain at least one
 */
const SPORTS_ALLOWLIST = [
  "football", "soccer", "nba", "nfl", "mlb", "nhl", "ufc", "tennis",
  "world cup", "champions league", "la liga", "premier league",
  "baseball", "basketball", "hockey", "boxing", "mma",
  "formula 1", "f1", "nascar", "golf", "cricket", "rugby", "racing",
  "esports", "epl", "laliga", "bundesliga", "serie a", "copa",
  "olympics", "wnba", "ncaa", "march madness", "playoffs",
  "super bowl", "world series", "stanley cup", "pga", "lpga",
  "masters", "kentucky derby", "wimbledon", "us open",
  "french open", "australian open", "atp", "wta", "grand slam",
];

/**
 * Non-sports BLOCKLIST - if market contains any, it CANNOT be sports
 * Blocklist wins over allowlist
 */
const NON_SPORTS_BLOCKLIST = [
  "politics", "election", "president", "senate", "congress",
  "trump", "biden", "macron", "putin", "zelensky",
  "nato", "russia", "ukraine", "war", "military", "invasion",
  "gaza", "israel", "iran", "hamas", "palestine", "conflict",
  "bitcoin", "crypto", "btc", "eth", "ethereum", "solana",
  "ipo", "fed", "rates", "recession", "inflation", "tariff",
  "microstrategy", "kraken", "coinbase", "binance",
  "company", "stock", "shares", "equity", "nasdaq", "nyse",
  "acquisition", "merger", "lawsuit", "regulation",
];

/**
 * Helper to safely get lowercase string
 */
function safeLower(val: unknown): string {
  if (typeof val === "string" && val) return val.toLowerCase();
  return "";
}

/**
 * Check if market is likely a sports future or outright.
 * Keep this conservative: reject obvious long-term championship/outright,
 * league winner, placement, relegation, and promotion markets, but do not reject
 * normal game markets like "Team A to win vs Team B".
 */
function isLikelySportsFutureOrOutright(event: PolymarketRawEvent, market: PolymarketRawMarket): boolean {
  const normalizedText = getCandidateSearchText(event, market)
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedText) return false;

  const explicitFuturePhrases = [
    "stanley cup",
    "super bowl",
    "nba finals",
    "world cup winner",
    "world series winner",
    "championship winner",
    "league winner",
    "season winner",
    "tournament winner",
    "conference winner",
    "division winner",
    "playoff winner",
    "playoffs winner",
    "regular season winner",
    "overall winner",
    "top goalscorer",
    "top goal scorer",
    "top scorer",
    "golden boot",
    "most goals",
    "most assists",
  ];

  if (explicitFuturePhrases.some(phrase => normalizedText.includes(phrase))) {
    return true;
  }

  // Futures/props that are not a concrete upcoming game. These were leaking into the feed.
  if (/\b(top\s+goalscorer|top\s+goal\s+scorer|top\s+scorer|golden\s+boot|most\s+goals|most\s+assists)\b/.test(normalizedText)) {
    return true;
  }

  const competitionTerms = [
    "epl",
    "english premier league",
    "premier league",
    "french ligue 1",
    "ligue 1",
    "ligue",
    "la liga",
    "liga",
    "serie a",
    "bundesliga",
    "eredivisie",
    "championship",
    "league",
    "nba",
    "nfl",
    "nhl",
    "mlb",
    "mls",
    "cup",
    "tournament",
    "conference",
    "division",
    "season",
  ];

  const competitionPattern = competitionTerms
    .map(term => term.replace(/\s+/g, "\\s+"))
    .join("|");

  const placementPattern = "\\d+(st|nd|rd|th)\\s+place|top\\s+\\d+|last\\s+place";
  const relegationPattern = "relegation|relegated|get\\s+relegated|gets\\s+relegated|clubs\\s+get\\s+relegated";
  const promotionPattern = "promotion|promoted|get\\s+promoted|gets\\s+promoted|clubs\\s+get\\s+promoted";
  const seasonOutcomePattern = `${placementPattern}|${relegationPattern}|${promotionPattern}`;

  const futureRegexes = [
    new RegExp(`\\b(${competitionPattern})\\s+(\\d+\\s+)?(winner|champion)s?\\b`),
    new RegExp(`\\b(${competitionPattern})\\b.{0,80}\\b(${seasonOutcomePattern})\\b`),
    new RegExp(`\\b(which|what)\\s+clubs?\\s+get\\s+(relegated|promoted)\\b`),
    new RegExp(`\\b(${seasonOutcomePattern})\\b`),
    /\bwho will win (the )?(stanley cup|super bowl|nba finals|world cup|world series|championship|league|season|tournament|conference|division|playoffs?|cup)\b/,
    /\bwinner of (the )?(stanley cup|super bowl|nba finals|world cup|world series|championship|league|season|tournament|conference|division|playoffs?|cup)\b/,
    /\bto win (the )?(stanley cup|super bowl|nba finals|world cup|world series|championship|league|season|tournament|conference|division|playoffs?|cup)\b/,
    /\bto be (the )?(stanley cup|super bowl|nba finals|world cup|world series|championship|league|season|tournament|conference|division|playoffs?|cup) (winner|champion)s?\b/,
    /\b(stanley cup|super bowl|nba finals|world cup|world series|championship|league|season|tournament|conference|division|playoffs?|cup) champion(s)?\b/,
  ];

  return futureRegexes.some(regex => regex.test(normalizedText));
}

/**
 * Extract searchable text from candidate
 */
function getCandidateSearchText(event: PolymarketRawEvent, market: PolymarketRawMarket): string {
  const textFields: string[] = [
    safeLower(event.title),
    safeLower(event.slug),
    safeLower(event.category),
    safeLower(event.description),
    safeLower(event.groupTitle),
    safeLower(event.groupItemTitle),
    safeLower((event as unknown as Record<string, unknown>).subcategory),
    safeLower((event as unknown as Record<string, unknown>).series),
    safeLower(market.question),
    safeLower(market.slug),
    safeLower(market.category),
    safeLower((market as unknown as Record<string, unknown>).groupTitle),
    safeLower((market as unknown as Record<string, unknown>).groupItemTitle),
    ...(event.tags || []).map(t => safeLower(t)),
  ].filter(t => t.length > 0);

  return textFields.join(" ");
}

/**
 * STRICT sports candidate check
 * Returns { isSports: boolean, matchedKeyword?: string, blockedKeyword?: string }
 */
function isSportsCandidate(event: PolymarketRawEvent, market: PolymarketRawMarket): {
  isSports: boolean;
  matchedKeyword?: string;
  blockedKeyword?: string;
} {
  const searchText = getCandidateSearchText(event, market);

  // First check blocklist - blocklist WINS over allowlist
  for (const blocked of NON_SPORTS_BLOCKLIST) {
    if (searchText.includes(blocked)) {
      return { isSports: false, blockedKeyword: blocked };
    }
  }

  // Then check allowlist
  for (const allowed of SPORTS_ALLOWLIST) {
    if (searchText.includes(allowed)) {
      return { isSports: true, matchedKeyword: allowed };
    }
  }

  // No match in either list
  return { isSports: false };
}

/**
 * Legacy check for backwards compatibility
 * Uses the new strict isSportsCandidate
 */
function checkIsSportsRelated(event: PolymarketRawEvent, market: PolymarketRawMarket): boolean {
  return isSportsCandidate(event, market).isSports;
}

/**
 * Check if event/market is ended/closed
 */
function checkIsEndedMarket(event: PolymarketRawEvent, market: PolymarketRawMarket): boolean {
  // Check explicit closed/active flags
  if (market.closed === true || event.closed === true) return true;
  if (market.active === false || event.active === false) return true;

  // Check end dates
  const endDateStr = event.endDate || event.endDateIso || event.endTime || market.endDate;
  if (endDateStr) {
    try {
      const endDate = new Date(endDateStr);
      if (!isNaN(endDate.getTime()) && endDate < new Date()) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

/**
 * Validate and flatten events into candidate markets
 * ONLY reject clearly invalid markets (closed, no outcomes, no prices)
 * Missing enrichment data (token IDs, trades, etc.) is a warning, not fatal
 *
 * Also computes isSportsRelated and isEnded flags for filtering
 */
function extractCandidateMarkets(events: PolymarketRawEvent[]): CandidateMarket[] {
  const candidates: CandidateMarket[] = [];

  for (const event of events) {
    // Extract parent event metadata
    const parentMeta: ParentEventMeta = {
      title: safeString(event.title) || safeString(event.description) || "Unknown Event",
      slug: safeString(event.slug) || slugify(safeString(event.title) || "unknown"),
      category: safeString(event.category) || undefined,
      endDate: safeString(event.endDate) || undefined,
    };

    // Get markets - handle both array and missing cases
    const markets = event.markets;
    if (!markets || !Array.isArray(markets) || markets.length === 0) {
      continue;
    }

    for (const market of markets) {
      const rejectionReasons: string[] = [];
      const warnings: string[] = [];

      // Check active/closed status - FATAL
      if (market.closed === true) {
        rejectionReasons.push("Market closed");
      }
      if (market.active === false) {
        rejectionReasons.push("Market inactive");
      }

      // Check required fields - FATAL if missing question/title
      const question = safeString(market.question);
      if (!question) {
        rejectionReasons.push("Missing question/title");
      }

      // Parse outcomes from JSON string if needed
      const rawOutcomes = safeParseArray<string>(market.outcomes);
      if (rawOutcomes.length === 0) {
        rejectionReasons.push("Missing or invalid outcomes");
      }

      // Parse outcome prices from JSON string if needed
      const rawOutcomePrices = safeParseArray<string>(market.outcomePrices);
      if (rawOutcomePrices.length === 0) {
        rejectionReasons.push("Missing or invalid outcome prices");
      }

      // Check we have matching outcomes and prices
      if (rawOutcomes.length !== rawOutcomePrices.length) {
        rejectionReasons.push(`Mismatched outcomes (${rawOutcomes.length}) and prices (${rawOutcomePrices.length})`);
      }

      // Token IDs missing is a WARNING, not fatal
      const tokenIds = safeParseArray<string>(market.clobTokenIds || market.tokenIds);
      if (tokenIds.length === 0) {
        warnings.push("Missing token IDs - CLOB enrichment unavailable");
      }

      // Compute sports and ended flags using strict check
      const sportsCheck = isSportsCandidate(event, market);
      const endedFlag = checkIsEndedMarket(event, market);

      // Additional futures/outrights check for sports category
      let futuresRejectionReason: string | undefined;
      if (sportsCheck.isSports && isLikelySportsFutureOrOutright(event, market)) {
        futuresRejectionReason = "sports_future_or_outright";
      }

      // Attach parent metadata to market for later use
      (market as unknown as Record<string, unknown>)._parentMeta = parentMeta;

      candidates.push({
        event,
        market,
        rejectionReasons,
        warnings,
        isSportsRelated: sportsCheck.isSports,
        isEnded: endedFlag,
        sportsMatchedKeyword: sportsCheck.matchedKeyword,
        sportsBlockedKeyword: sportsCheck.blockedKeyword,
      });
    }
  }

  return candidates;
}

/**
 * Select the best outcome candidate from a market
 * Works with Gamma data where outcomes/outcomePrices are JSON strings
 */
function selectOutcome(market: PolymarketRawMarket): { name: string; tokenId: string | null; price: number; index: number } | null {
  // Parse JSON string arrays
  const outcomes = safeParseArray<string>(market.outcomes);
  const outcomePrices = safeParseArray<string>(market.outcomePrices);
  const tokenIds = safeParseArray<string>(market.clobTokenIds || market.tokenIds);

  if (outcomes.length === 0 || outcomePrices.length === 0) {
    return null;
  }

  if (outcomes.length !== outcomePrices.length) {
    return null;
  }

  // Build valid outcomes with parsed prices
  const validOutcomes: Array<{ name: string; tokenId: string | null; price: number; index: number }> = [];

  for (let i = 0; i < outcomes.length; i++) {
    const name = safeString(outcomes[i]);
    const price = safeParseNumber(outcomePrices[i]);

    if (!name || price === null) continue;

    // Token ID is optional - can be null if not available
    const tokenId = tokenIds[i] || null;

    validOutcomes.push({ name, tokenId, price, index: i });
  }

  if (validOutcomes.length === 0) return null;

  // Primary target: 1.7x-3x (price 0.333-0.588)
  const targetOutcomes = validOutcomes.filter(
    (o) => o.price >= 0.333 && o.price <= 0.588
  );
  if (targetOutcomes.length > 0) {
    return targetOutcomes.sort((a, b) =>
      Math.abs(a.price - 0.45) - Math.abs(b.price - 0.45)
    )[0];
  }

  // Fallback: 1.35x-5x (price 0.20-0.741)
  const fallbackOutcomes = validOutcomes.filter(
    (o) => o.price >= 0.20 && o.price <= 0.741
  );
  if (fallbackOutcomes.length > 0) {
    return fallbackOutcomes.sort((a, b) =>
      Math.abs(a.price - 0.45) - Math.abs(b.price - 0.45)
    )[0];
  }

  // No outcome in range — reject
  return null;
}

/**
 * Get parent event metadata attached to market
 */
function getParentMeta(market: PolymarketRawMarket): ParentEventMeta {
  const meta = (market as unknown as Record<string, unknown>)._parentMeta as ParentEventMeta | undefined;
  return meta || {
    title: safeString(market.question) || "Unknown Event",
    slug: slugify(safeString(market.question) || "unknown"),
  };
}

/**
 * Enrich market with API data
 * Always returns an EnrichedMarket if we have valid Gamma data
 * Enrichment failures are warnings, not fatal errors
 */
async function enrichMarket(
  event: PolymarketRawEvent,
  market: PolymarketRawMarket,
  initialWarnings: string[] = []
): Promise<EnrichedMarket | null> {
  const parentMeta = getParentMeta(market);
  const selectedOutcome = selectOutcome(market);

  if (!selectedOutcome) {
    return null;
  }

  // Validate current price is usable
  if (selectedOutcome.price <= 0 || selectedOutcome.price >= 1) {
    return null; // Invalid price range
  }

  const warnings: string[] = [...initialWarnings];
  const diagnostics: LandingCardDiagnostics = {
    conditionId: safeString(market.conditionId) ?? null,
    selectedTokenId: selectedOutcome.tokenId,
    selectedOutcome: selectedOutcome.name,
    currentPrice: selectedOutcome.price,
    price1hAgo: null,
    price6hAgo: null,
    delta1hPp: null,
    delta6hPp: null,
    spread: null,
    openInterest: null,
    recentTradeCash: null,
    maxTradeCash: null,
    selectedTradeCount: null,
    totalTradeCount: null,
    holderConcentrationScore: null,
    dataCoverage: 0,
    formulaUsed: FORMULA_VERSION,
    rejectionReasons: [],
    parentEventVolume24hr: Number(
      event.volume24hr ?? market.volume24hr ?? 0
    ),
    gameStartIso: parentMeta.startDate ?? event.endDate ?? null,
  };

  // Try to get price movement from Gamma fields as fallback
  let gammaPriceChange: number | null = null;
  const oneDayChange = safeParseNumber((market as unknown as Record<string, unknown>).oneDayPriceChange);
  const oneWeekChange = safeParseNumber((market as unknown as Record<string, unknown>).oneWeekPriceChange);

  if (oneDayChange !== null) {
    gammaPriceChange = oneDayChange;
  } else if (oneWeekChange !== null) {
    gammaPriceChange = oneWeekChange / 7; // Approximate daily
  }

  // Fetch price history from CLOB (best effort - only if we have token ID)
  let priceHistory: PolymarketPricePoint[] | null = null;
  if (selectedOutcome.tokenId) {
    priceHistory = await fetchPriceHistorySafe(selectedOutcome.tokenId, "6h");
  }

  if (priceHistory && priceHistory.length > 0) {
    // Find prices at roughly 1h and 6h ago
    const now = new Date().getTime();
    const oneHourAgo = now - 3600000;
    const sixHoursAgo = now - 21600000;

    const price1h = priceHistory.find((p) => new Date(p.timestamp).getTime() <= oneHourAgo);
    const price6h = priceHistory.find((p) => new Date(p.timestamp).getTime() <= sixHoursAgo);

    diagnostics.price1hAgo = price1h?.price ?? null;
    diagnostics.price6hAgo = price6h?.price ?? null;

    // Calculate deltas
    const { deltaPp, deltaSource } = computeDeltaPp({
      currentPrice: selectedOutcome.price,
      price6hAgo: diagnostics.price6hAgo,
      price1hAgo: diagnostics.price1hAgo,
    });

    if (deltaSource === "6h") {
      diagnostics.delta6hPp = deltaPp;
    } else if (deltaSource === "1h") {
      diagnostics.delta1hPp = deltaPp;
    }
  } else {
    // Use Gamma price change as fallback
    warnings.push("Missing price history; used Gamma price-change fallback");
    if (gammaPriceChange !== null) {
      diagnostics.delta6hPp = roundNumber(gammaPriceChange * 100);
    } else {
      warnings.push("Missing price history; used zero delta fallback");
    }
  }

  // PREMVP15 rescue: skip slow CLOB spread/order-book enrichment in the live landing route.
  // The feed already has enough P0 evidence from Gamma volume, current price, trades and holders.
  // Spread/order-book calls were causing 60s local requests and abort noise.
  const spread: { min: number; max: number } | null = null;
  diagnostics.spread = null;
  warnings.push("Spread lookup skipped for landing-feed performance");

  const orderBook = null;

  // Fetch trades (best effort)
  const trades = await fetchTradesSafe(market.conditionId);

  if (trades && trades.length > 0) {
    const selectedTrades = trades.filter(
      (t) => t.tokenId === selectedOutcome.tokenId || (!t.tokenId && t.side === "BUY")
    );

    diagnostics.selectedTradeCount = selectedTrades.length;
    diagnostics.totalTradeCount = trades.length;

    const selectedCash = selectedTrades.reduce((sum, t) => sum + (t.price * t.size), 0);
    const maxCash = Math.max(...trades.map((t) => t.price * t.size), 0);

    diagnostics.recentTradeCash = roundNumber(selectedCash);
    diagnostics.maxTradeCash = roundNumber(maxCash);
  } else {
    warnings.push("Trade data unavailable");
  }

  // M3-C: directional flow raw evidence — shadow only, no production score impact
  // Uses exact tokenId matching only; BUY fallback is intentionally excluded here.
  {
    const m3cAllTokenIds = safeParseArray<string>(market.clobTokenIds || market.tokenIds);
    const m3cRawOutcomes = safeParseArray<string>(market.outcomes);
    const m3cRawPrices   = safeParseArray<string>(market.outcomePrices);

    // Rebuild valid-outcome list (mirrors selectOutcome logic) to determine binary guard
    const m3cValidOutcomes: Array<{ index: number; tokenId: string | null }> = [];
    for (let i = 0; i < m3cRawOutcomes.length; i++) {
      const nm = safeString(m3cRawOutcomes[i]);
      const pr = safeParseNumber(m3cRawPrices[i]);
      if (!nm || pr === null) continue;
      m3cValidOutcomes.push({ index: i, tokenId: m3cAllTokenIds[i] || null });
    }

    const m3cIsBinary = m3cValidOutcomes.length === 2;
    const m3cOpposingEntry = m3cIsBinary
      ? (m3cValidOutcomes.find(o => o.index !== selectedOutcome.index) ?? null)
      : null;
    const m3cOpposingTokenId = m3cOpposingEntry?.tokenId ?? null;

    diagnostics.directionalFlowVersion    = "v1-binary-exact-token";
    diagnostics.directionalFlowBinaryGuard = m3cIsBinary;
    diagnostics.directionalFlowSampleLimit = 100;

    if (!m3cIsBinary) {
      diagnostics.directionalFlowEvidenceState = "non_binary";
    } else if (!selectedOutcome.tokenId || !m3cOpposingTokenId || !trades || trades.length === 0) {
      diagnostics.directionalFlowEvidenceState        = "absent";
      diagnostics.directionalFlowFetchedTradeCount    = trades?.length ?? 0;
      diagnostics.directionalFlowTokenMatchedCount    = 0;
      diagnostics.directionalFlowTokenUnmatchedCount  = trades?.length ?? 0;
      diagnostics.directionalFlowCoverageRatio        =
        trades && trades.length > 0 ? 0 : null;
    } else {
      // Exact token matching only — no BUY fallback for M3-C.
      // API returns token id in `asset` (decimal string); fall back to `tokenId` for compat.
      const tokenMatchedTrades  = trades.filter(t => {
        const tradeTokenId = String(t.asset ?? t.tokenId ?? "").trim();
        return tradeTokenId !== "";
      });
      const selectedExactTrades = tokenMatchedTrades.filter(t => {
        const tradeTokenId = String(t.asset ?? t.tokenId ?? "").trim();
        return tradeTokenId === selectedOutcome.tokenId;
      });
      const opposingExactTrades = tokenMatchedTrades.filter(t => {
        const tradeTokenId = String(t.asset ?? t.tokenId ?? "").trim();
        return tradeTokenId === m3cOpposingTokenId;
      });

      const sumCash = (arr: typeof trades): number =>
        arr.reduce((s, t) => s + t.price * t.size, 0);
      const maxTrade = (arr: typeof trades): number | null =>
        arr.length > 0 ? Math.max(...arr.map(t => t.price * t.size)) : null;

      diagnostics.directionalFlowFetchedTradeCount   = trades.length;
      diagnostics.directionalFlowTokenMatchedCount   = tokenMatchedTrades.length;
      diagnostics.directionalFlowTokenUnmatchedCount = trades.length - tokenMatchedTrades.length;
      diagnostics.directionalFlowCoverageRatio       =
        roundNumber(tokenMatchedTrades.length / trades.length);

      diagnostics.selectedSideExactRecentCash   = roundNumber(sumCash(selectedExactTrades));
      diagnostics.opposingSideExactRecentCash   = roundNumber(sumCash(opposingExactTrades));
      diagnostics.selectedSideExactTradeCount   = selectedExactTrades.length;
      diagnostics.opposingSideExactTradeCount   = opposingExactTrades.length;
      const selMax = maxTrade(selectedExactTrades);
      const oppMax = maxTrade(opposingExactTrades);
      diagnostics.selectedSideExactMaxTradeCash = selMax !== null ? roundNumber(selMax) : null;
      diagnostics.opposingSideExactMaxTradeCash = oppMax !== null ? roundNumber(oppMax) : null;

      const allTs = trades.map(t => t.timestamp).filter(Boolean).sort();
      diagnostics.directionalFlowOldestTradeIso = allTs.length > 0 ? allTs[0] : null;
      diagnostics.directionalFlowNewestTradeIso = allTs.length > 0 ? allTs[allTs.length - 1] : null;

      diagnostics.directionalFlowEvidenceState =
        tokenMatchedTrades.length === trades.length ? "exact" : "partial";
    }
  }

  // Fetch holders (best effort)
  const holders = await fetchHoldersSafe(market.conditionId);

  if (holders && holders.length > 0) {
    // Calculate holder concentration (Gini-like proxy)
    const totalValue = holders.reduce((sum, h) => sum + (h.value || 0), 0);
    if (totalValue > 0) {
      const sortedValues = holders.map((h) => h.value || 0).sort((a, b) => b - a);
      const top10Value = sortedValues.slice(0, Math.min(10, sortedValues.length)).reduce((sum, v) => sum + v, 0);
      diagnostics.holderConcentrationScore = clamp(roundNumber((top10Value / totalValue) * 100), 0, 100);
    }
  } else {
    warnings.push("Holder data unavailable");
  }

  // PREMVP15 rescue: skip open interest in the live landing route for speed/stability.
  const openInterest = null;
  diagnostics.openInterest = null;
  warnings.push("Open interest lookup skipped for landing-feed performance");

  // Calculate data coverage (0-100)
  let coveragePoints = 0;
  const totalPoints = 4;

  if (diagnostics.currentPrice !== null) coveragePoints++;
  if (diagnostics.price6hAgo !== null || diagnostics.delta6hPp !== null) coveragePoints++;
  if (diagnostics.recentTradeCash !== null) coveragePoints++;
  if (diagnostics.holderConcentrationScore !== null) coveragePoints++;

  diagnostics.dataCoverage = roundNumber((coveragePoints / totalPoints) * 100);

  return {
    event,
    market,
    parentMeta,
    selectedOutcome,
    priceHistory,
    spread,
    orderBook,
    trades,
    holders,
    openInterest,
    gammaPriceChange,
    diagnostics,
    warnings,
  };
}

/**
 * Compute all scores and generate landing card pair
 * Uses fallback scores when enrichment data is missing
 */
function generateLandingCardPair(enriched: EnrichedMarket): LandingCardPair | null {
  const { parentMeta, market, selectedOutcome, diagnostics } = enriched;

  // Banded confidence scoring anchored to selectedOdds
  const selectedOdds = selectedOutcome.price > 0 ? 1 / selectedOutcome.price : 99;
  const holderConcentrationScore = diagnostics.holderConcentrationScore ?? null;
  const finalDisplaySignalScore = computeBandedSignalScore({
    selectedOdds,
    delta6hPp: diagnostics.delta6hPp,
    maxTradeCash: diagnostics.maxTradeCash,
    recentTradeCash: diagnostics.recentTradeCash,
    holderConcentrationScore,
  });
  if (finalDisplaySignalScore === null) return null;

  // v2-lite: independent evidence-based Trust Metrics (growth-safe caps)
  const { maxTradeCash, recentTradeCash, selectedTradeCount, delta6hPp, dataCoverage } = diagnostics;

  // OddsFit: primary band [0.333,0.588] → 80+closeness; fallback → raw clamped lower
  const oddsFit = (() => {
    const p = selectedOutcome.price;
    if (p < 0.20 || p > 0.741) return 55;
    return clamp(80 + (1 - Math.abs(p - 0.45) / 0.138) * 15, 55, 95);
  })();

  // SmartMoney_v2: trade cash evidence
  const smartMoneyVal = (() => {
    if (maxTradeCash == null && recentTradeCash == null) return 50;
    return clamp(
      50 + Math.min((maxTradeCash ?? 0) / 10000, 1) * 30
         + Math.min((recentTradeCash ?? 0) / 50000, 1) * 15,
      45, 90,
    );
  })();

  // WhalePublic_v2: avg trade size + max trade
  const pubWhaleVal = (() => {
    if (selectedTradeCount == null || recentTradeCash == null || selectedTradeCount === 0) return 50;
    const avg = recentTradeCash / selectedTradeCount;
    return clamp(
      50 + Math.min(avg / 2500, 1) * 20
         + Math.min((maxTradeCash ?? 0) / 10000, 1) * 15,
      45, 85,
    );
  })();

  // PreEventScore_v2: OddsFit + Momentum + Liquidity + Coverage
  const preEventVal = (() => {
    const momentum = delta6hPp != null ? 50 + clamp(delta6hPp * 4, -20, 25) : 50;
    const liquidity = recentTradeCash != null ? 50 + Math.min(recentTradeCash / 50000, 1) * 25 : 50;
    return clamp(
      0.40 * oddsFit + 0.30 * momentum + 0.20 * liquidity + 0.10 * (dataCoverage ?? 0),
      45, 90,
    );
  })();

  // SignalConfidence_v2: weighted independent components + growth-safe caps
  const signalV2Raw = 0.35 * oddsFit + 0.25 * smartMoneyVal + 0.15 * pubWhaleVal
    + 0.20 * preEventVal + 0.05 * (dataCoverage ?? 0);
  const noTradeData = maxTradeCash == null && recentTradeCash == null;
  let signalCap = 95;
  if ((dataCoverage ?? 0) < 50) signalCap = Math.min(signalCap, 64);
  else if ((dataCoverage ?? 0) < 75) signalCap = Math.min(signalCap, 75);
  if (noTradeData) signalCap = Math.min(signalCap, 68);

  // Odds-calibrated display cap: preserve raw evidence score, cap displayed confidence by odds band.
  // Raw score = what formula produced; displayed score = odds-aware public-facing value.
  const oddsBand = getOddsBandCalibration(selectedOdds);
  const calibratedSignalCap = Math.min(signalCap, oddsBand.max);
  const rawSignalBeforeOddsCap = roundNumber(clamp(signalV2Raw, 52, signalCap));
  const finalSignalV2 = roundNumber(clamp(signalV2Raw, 52, calibratedSignalCap));

  // Determine action label: confidence-aware thresholds per odds band.
  // Action depends on final displayed Signal Confidence vs band lower guidance.
  let action: "ENTER" | "SMALL" | "WATCH";
  if (selectedOdds <= 1.44) {
    action = finalSignalV2 >= 80 ? "ENTER" : "SMALL";
  } else if (selectedOdds <= 1.70) {
    action = finalSignalV2 >= 77 ? "ENTER" : "SMALL";
  } else if (selectedOdds <= 2.20) {
    action = finalSignalV2 >= 72 ? "ENTER" : "SMALL";
  } else if (selectedOdds <= 2.70) {
    action = finalSignalV2 >= 70 ? "ENTER" : "SMALL";
  } else if (selectedOdds <= 3.50) {
    action = finalSignalV2 >= 63 ? "SMALL" : "WATCH";
  } else if (selectedOdds <= 5.00) {
    action = (finalSignalV2 >= 58 && !noTradeData) ? "SMALL" : "WATCH";
  } else {
    action = "WATCH";
  }

  // Persist full formula audit snapshot for post-resolution debugging.
  diagnostics.formulaAudit = {
    v: "v2-lite-growth-safe",
    oddsFit: roundNumber(oddsFit),
    smartMoneyVal: roundNumber(smartMoneyVal),
    pubWhaleVal: roundNumber(pubWhaleVal),
    preEventVal: roundNumber(preEventVal),
    signalV2Raw: Math.round(signalV2Raw * 10) / 10,
    signalCap,
    noTradeData,
    finalSignalV2,
    selectedOdds: Math.round(selectedOdds * 1000) / 1000,
    rawSignalBeforeOddsCap,
    displaySignalConfidence: finalSignalV2,
    oddsBandMin: oddsBand.min,
    oddsBandMax: oddsBand.max,
    oddsBandLabel: oddsBand.label,
    calibratedSignalCap,
    oddsBandCapApplied: calibratedSignalCap < signalCap,
    action,
    confidenceMode: "odds_calibrated_display",
  };

  const metrics: TrustMetric[] = [
    {
      id: "smart-money",
      label: "Smart Money",
      value: roundNumber(smartMoneyVal),
      bar: roundNumber(smartMoneyVal),
      icon: "/icons/trust-smart-money.png",
    },
    {
      id: "public-vs-whale",
      label: "Public vs Whale Money",
      value: roundNumber(pubWhaleVal),
      bar: roundNumber(pubWhaleVal),
      icon: "/icons/trust-public-whale.png",
    },
    {
      id: "pre-event-score",
      label: "Injury data & PreMatchPower",
      value: roundNumber(preEventVal),
      bar: roundNumber(preEventVal),
      icon: "/icons/trust-ai-score.png",
    },
  ];

  const finalMetrics = metrics;

  // Generate profit string
  const profitPercent = computePotentialProfitPercent(selectedOutcome.price);
  const profitStr = `${profitPercent}%`;

  // Generate delta string for market source
  const deltaPp = diagnostics.delta6hPp ?? diagnostics.delta1hPp ?? 0;
  const deltaStr = formatDeltaPp(deltaPp);
  const priceCents = Math.round(selectedOutcome.price * 100);
  const hasPriceMove = Math.abs(deltaPp) >= 1;

  // Generate headline for market source using market volume/liquidity only.
  // Sharp Flow owns trade-size evidence; do not duplicate maxTradeCash here.
  const gammaVolume = safeParseNumber((market as unknown as Record<string, unknown>).volume);
  const gammaLiquidity = safeParseNumber((market as unknown as Record<string, unknown>).liquidity);

  let headline: string;
  if (gammaVolume !== null && gammaVolume > 0) {
    headline = `$${compactMoney(gammaVolume)} market volume`;
  } else if (gammaLiquidity !== null && gammaLiquidity > 0) {
    headline = `$${compactMoney(gammaLiquidity)} market liquidity`;
  } else if (diagnostics.recentTradeCash !== null && diagnostics.recentTradeCash > 0) {
    headline = `$${compactMoney(diagnostics.recentTradeCash)} matched activity`;
  } else {
    headline = "Live market activity";
  }

  // Generate subline for market source
  const subline = `${selectedOutcome.name} priced at ${priceCents}¢`;

  // Generate time ago (use "Live now" as fallback)
  const timeAgo = "Live now";

  // Build IDs using parent event metadata
  const baseId = slugify(parentMeta.slug || safeString(market.slug) || safeString(market.conditionId) || market.id);
  const pairId = `${baseId}-${slugify(selectedOutcome.name)}`;

  // Derive presentation fields (does NOT replace raw position)
  const positionPresentation = derivePositionPresentation(
    safeString(market.question) || "",
    selectedOutcome.name,
  );

  // Build premium signal
  const premiumSignal: PremiumSignal = {
    id: pairId,
    league: parentMeta.category || "Prediction Market",
    time: parentMeta.startDate
      ? formatGameTime(parentMeta.startDate)
      : formatEndTime(parentMeta.endDate),
    eventTitle: truncateText(deriveCompactEventTitle(
      parentMeta.title || safeString(market.question) || "Unknown Event",
      safeString(market.question) || "",
      selectedOutcome.name,
    ), 50),
    confidenceLabel: oddsBand.label,
    position: selectedOutcome.name,
    positionDisplay: positionPresentation.positionDisplay,
    positionQualifier: positionPresentation.positionQualifier,
    profit: profitStr,
    winProbability: finalSignalV2,
    price: "$1.99",
    ctaLabel: "Unlock Full Signal",
    metrics: finalMetrics,
    actionLabel: action,
    oddsBandLabel: oddsBand.label,
    rawSignalScore: rawSignalBeforeOddsCap,
    displaySignalConfidence: finalSignalV2,
    polymarketUrl: parentMeta.polymarketEventSlug
      ? `https://polymarket.com/event/${parentMeta.polymarketEventSlug}`
      : undefined,
  };

  // Build market source
  const marketSource: MarketSource = {
    id: `${pairId}-market-source`,
    sourceLabel: "Market Source",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo,
    headline,
    subline,
    delta: deltaStr,
    type: "market-source",
    visualType: "chart",
  };

  // Build evidence stack for the selected market
  const marketSources = buildEvidenceStack({
    marketSource,
    selectedOutcome,
    diagnostics,
    deltaStr,
    timeAgo,
  });

  return {
    id: pairId,
    premiumSignal,
    marketSource,
    marketSources,
    diagnostics,
  };
}

/**
 * Build evidence stack for a selected market using available diagnostics data.
 *
 * Product rule:
 * - Always return at least 2 evidence cards.
 * - Prefer 3 evidence cards when market diagnostics are available.
 * - Do not generate News Pulse until a verified news/context source exists.
 */
function buildEvidenceStack(params: {
  marketSource: MarketSource;
  selectedOutcome: any;
  diagnostics: LandingCardDiagnostics;
  deltaStr: string;
  timeAgo: string;
}): MarketSourceEvidenceCard[] {
  const primaryEvidenceCard: MarketSourceEvidenceCard = {
    ...params.marketSource,
    id: params.marketSource.id,
    type: "market-source",
    visualType: "chart",
  };

  const evidenceCards: MarketSourceEvidenceCard[] = [primaryEvidenceCard];
  const baseId = params.marketSource.id.replace(/-market-source$/, "") || params.marketSource.id;
  const maxTradeCash = params.diagnostics.maxTradeCash;

  // Sharp Flow: only real trade-size evidence. Never create placeholder Sharp Flow.
  if (maxTradeCash !== null && maxTradeCash >= 500) {
    let headline: string;
    let subline: string;

    if (maxTradeCash >= 10000) {
      headline = `$${compactMoney(maxTradeCash)} whale trade`;
      subline = "Largest matched trade";
    } else if (maxTradeCash >= 5000) {
      headline = `$${compactMoney(maxTradeCash)} sharp trade`;
      subline = "Largest matched trade";
    } else {
      headline = `$${compactMoney(maxTradeCash)} trade flow`;
      subline = "Recent matched trade";
    }

    evidenceCards.push({
      id: `${baseId}-sharp-flow`,
      sourceLabel: "Sharp Flow",
      platform: "Polymarket",
      network: "Polygon",
      timeAgo: params.timeAgo,
      headline,
      subline,
      delta: params.deltaStr,
      type: "sharp-flow",
      visualType: "avatar",
    });
  }

  const absDelta1h = params.diagnostics.delta1hPp !== null ? Math.abs(params.diagnostics.delta1hPp) : 0;
  const absDelta6h = params.diagnostics.delta6hPp !== null ? Math.abs(params.diagnostics.delta6hPp) : 0;
  const absDelta = params.diagnostics.delta6hPp ?? params.diagnostics.delta1hPp ?? 0;
  const hasMeaningfulMomentum = absDelta1h >= 1 || absDelta6h >= 1 || Math.abs(absDelta) >= 1;
  const price = params.diagnostics.currentPrice;
  const priceCents = price !== null ? Math.round(price * 100) : null;
  const impliedOdds = price !== null && price > 0 ? (1 / price).toFixed(2) : null;

  evidenceCards.push({
    id: `${baseId}-market-momentum`,
    sourceLabel: "Market Momentum",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo: params.timeAgo,
    headline: hasMeaningfulMomentum
      ? `Odds moved ${params.deltaStr}`
      : impliedOdds && priceCents !== null
        ? `Market holding at ${priceCents}¢`
        : "Odds holding steady",
    subline: hasMeaningfulMomentum
      ? `Market repricing — sharp entry window`
      : impliedOdds && priceCents !== null
        ? `Implied return ≈ ${impliedOdds}x — stable entry`
        : "No significant price movement",
    delta: params.deltaStr,
    type: "market-momentum",
    visualType: "chart",
  });

  // News Pulse is intentionally not generated until a verified news/context source is integrated.

  return evidenceCards.filter((card, index, cards) =>
    cards.findIndex(existingCard => existingCard.id === card.id) === index
  );
}

/**
 * Truncate text to max length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text || "";
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Derive human-readable presentation fields from the raw Polymarket question + selected outcome.
 * Returns positionDisplay (safe to show in UI) and optional positionQualifier.
 * Raw `position` (selectedOutcome.name) is preserved separately — this does NOT replace it.
 */
function derivePositionPresentation(
  question: string,
  selectedOutcomeName: string,
): { positionDisplay: string; positionQualifier?: string } {
  const raw = selectedOutcomeName.trim();
  const q = question.trim().replace(/\?$/, "");

  // Non-binary named token (e.g. team, player, draw, total, spread).
  // Only add a qualifier when the raw token or question makes the semantics explicit.
  if (!/^(yes|no)$/i.test(raw)) {
    if (/^draw$/i.test(raw)) {
      return { positionDisplay: raw, positionQualifier: "DRAW" };
    }

    const total = raw.match(/^(over|under)\s+([\d.]+)/i);
    if (total) {
      return { positionDisplay: raw, positionQualifier: `${total[1].toUpperCase()} ${total[2]}` };
    }

    const spread = raw.match(/([+-]\d+(?:\.\d+)?)$/);
    if (spread) {
      return { positionDisplay: raw, positionQualifier: spread[1] };
    }

    if (/\badvance\b/i.test(q)) {
      return { positionDisplay: raw, positionQualifier: "TO ADVANCE" };
    }

    if (/\b(?:win|winner|beat)\b/i.test(q) || /\b(?:vs\.?|v\.?)\b/i.test(q)) {
      return { positionDisplay: raw, positionQualifier: "TO WIN" };
    }

    return { positionDisplay: raw };
  }

  // Binary Yes/No — parse only explicit, safe question patterns.
  const isYes = /^yes$/i.test(raw);

  const advance = q.match(/^Will\s+(.+?)\s+advance(?:\s+.+)?$/i);
  if (advance) {
    return { positionDisplay: advance[1].trim(), positionQualifier: isYes ? "TO ADVANCE" : "NOT TO ADVANCE" };
  }

  const beat = q.match(/^Will\s+(.+?)\s+beat\s+(.+?)(?:\s+on\s+\d{4}-\d{2}-\d{2})?$/i);
  if (beat) {
    return { positionDisplay: beat[1].trim(), positionQualifier: isYes ? "TO WIN" : "NOT TO WIN" };
  }

  const win = q.match(/^Will\s+(.+?)\s+win(?:\s+on\s+\d{4}-\d{2}-\d{2})?$/i);
  if (win) {
    return { positionDisplay: win[1].trim(), positionQualifier: isYes ? "TO WIN" : "NOT TO WIN" };
  }

  // Ambiguous — preserve raw token and do not invent a qualifier.
  return { positionDisplay: raw };
}

/**
 * Create a compact, user-facing event label for explicit binary sports questions.
 * Safe: if a known pattern is not matched, keep the existing title untouched.
 */
function deriveCompactEventTitle(
  title: string,
  question: string,
  selectedOutcomeName: string,
): string {
  const base = title.trim() || question.trim();
  const q = question.trim().replace(/\?$/, "");

  const beat = q.match(/^Will\s+(.+?)\s+beat\s+(.+?)(?:\s+on\s+\d{4}-\d{2}-\d{2})?$/i);
  if (beat) return `${beat[1].trim()} vs ${beat[2].trim()}`;

  const win = q.match(/^Will\s+(.+?)\s+win(?:\s+on\s+\d{4}-\d{2}-\d{2})?$/i);
  if (win) return `${win[1].trim()} — Match Winner`;

  const advance = q.match(/^Will\s+(.+?)\s+advance(?:\s+.+)?$/i);
  if (advance) return `${advance[1].trim()} — To Advance`;

  return humanizeMatchupTitle(base, selectedOutcomeName);
}

/**
 * If position is exactly "Yes"/"No" and title is a generic matchup like
 * "Team A vs. Team B", rewrite to "Will Team A beat Team B?" for clarity.
 * Safe: returns original title if cannot parse.
 */
function humanizeMatchupTitle(title: string, position: string | undefined): string {
  if (!title || !position) return title;
  const pos = position.trim().toLowerCase();
  if (pos !== "yes" && pos !== "no") return title;
  if (title.includes("?")) return title;
  const m = title.match(/^(.+?)\s+(?:vs\.?|v\.?)\s+(.+)$/i);
  if (!m) return title;
  const teamA = m[1].trim();
  const teamB = m[2].trim();
  if (!teamA || !teamB) return title;
  return `Will ${teamA} beat ${teamB}?`;
}

/**
 * Classify a pair into a strategic category (or "other") by league/title text.
 * Same matcher family as the frontend landingPairMatchesFilter contract.
 */
export function strategicCategoryOf(pair: LandingCardPair): "WC26" | "NBA" | "NHL" | "eSport" | "other" {
  const text = `${pair.premiumSignal?.league ?? ""} ${pair.premiumSignal?.eventTitle ?? ""}`.toLowerCase();
  if (/\b(esport|esports|gaming|cs2|csgo|dota|valorant|lol|league of legends|counter[ -]strike|overwatch)\b/.test(text)) return "eSport";
  if (/world cup|wc2026|wc26|fifa/.test(text)) return "WC26";
  if (/\bnhl\b|stanley|hockey/.test(text)) return "NHL";
  if (/\bnba\b|basketball/.test(text)) return "NBA";
  return "other";
}

/**
 * Strategic Zero-Fill / Floor pass — applied to the FINAL combined cache feed.
 *
 * Root cause it solves: the cache feed is [...qualified, ...upcoming]; the route
 * reads only the first `limit` (15). Strategic upcoming candidates (esp. eSport,
 * last in priority order) get cut even though they were discovered and passed the
 * unified scoring. This reorders so each strategic category that has ≥1 eligible
 * generated pair anywhere in the feed gets at least one slot inside the first
 * `limit`, displacing the lowest-winProbability NON-strategic pair. It never
 * removes the only representative of another strategic category and never
 * fabricates a pair — if a category has 0 eligible pairs it honestly stays 0.
 */
export function applyStrategicFloor(combined: LandingCardPair[], limit: number): LandingCardPair[] {
  if (combined.length <= limit) return combined;
  const window = combined.slice(0, limit);
  const tail = combined.slice(limit);
  const STRATEGIC: Array<"WC26" | "NBA" | "NHL" | "eSport"> = ["WC26", "NBA", "NHL", "eSport"];

  for (const cat of STRATEGIC) {
    const inWindow = window.filter((p) => strategicCategoryOf(p) === cat).length;
    if (inWindow > 0) continue;
    const tailIdx = tail.findIndex((p) => strategicCategoryOf(p) === cat);
    if (tailIdx === -1) continue; // no eligible candidate — honest 0, no fabrication
    // Displace the lowest-winProbability NON-strategic pair in the window.
    let demoteIdx = -1;
    let lowWp = Infinity;
    for (let i = 0; i < window.length; i++) {
      if (strategicCategoryOf(window[i]) !== "other") continue;
      const wp = Number(window[i].premiumSignal?.winProbability) || 0;
      if (wp < lowWp) { lowWp = wp; demoteIdx = i; }
    }
    if (demoteIdx === -1) continue; // no non-strategic slot free — don't break another strategic cat
    const promote = tail.splice(tailIdx, 1)[0];
    const demote = window.splice(demoteIdx, 1, promote)[0];
    tail.push(demote);
  }
  return [...window, ...tail];
}

/**
 * Detect whether a pair belongs to the Esports category by league/title text.
 */
function isEsportPair(pair: LandingCardPair): boolean {
  const text = `${pair.premiumSignal?.league ?? ""} ${pair.premiumSignal?.eventTitle ?? ""}`.toLowerCase();
  return /\b(esport|esports|gaming|cs2|csgo|dota|valorant|lol|league of legends|counter[ -]strike|overwatch)\b/.test(text);
}

/**
 * Cap Esports pairs across the combined qualified + upcoming pool. Prefer qualified
 * bucket and higher winProbability when trimming. Strategic categories (WC26/NBA/NHL)
 * are not capped here — they're constrained only by upstream supply.
 */
function applyCategoryAllocation(
  qualifiedPairs: LandingCardPair[],
  upcomingPairs: LandingCardPair[],
  esportCap = 2,
): { pairs: LandingCardPair[]; upcomingPairs: LandingCardPair[] } {
  const allEsport: Array<{ id: string; wp: number; from: "q" | "u" }> = [];
  for (const p of qualifiedPairs) {
    if (isEsportPair(p)) {
      allEsport.push({ id: p.id, wp: Number(p.premiumSignal?.winProbability ?? 0), from: "q" });
    }
  }
  for (const p of upcomingPairs) {
    if (isEsportPair(p)) {
      allEsport.push({ id: p.id, wp: Number(p.premiumSignal?.winProbability ?? 0), from: "u" });
    }
  }
  if (allEsport.length <= esportCap) {
    return { pairs: qualifiedPairs, upcomingPairs };
  }
  // Prefer qualified bucket first, then higher winProbability
  allEsport.sort((a, b) => (a.from === b.from ? b.wp - a.wp : a.from === "q" ? -1 : 1));
  const keepIds = new Set(allEsport.slice(0, esportCap).map((e) => e.id));
  const filterFn = (p: LandingCardPair) => !isEsportPair(p) || keepIds.has(p.id);
  return {
    pairs: qualifiedPairs.filter(filterFn),
    upcomingPairs: upcomingPairs.filter(filterFn),
  };
}

/**
 * Deterministic FNV-1a-style hash → stable unsigned 32-bit seed.
 */
function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Final deterministic Duplicate Metric Guard.
 * Trust metrics are derived from fc ± offsets, so distinct events can end up with
 * an identical full display vector [winProbability, smart-money, public-vs-whale,
 * pre-event-score]. When ≥2 DISTINCT events (different conditionId/title/price)
 * share the same vector, apply a deterministic micro-offset (-1/0/+1, seeded from
 * a stable hash — no randomness) so the display vector differs. Confidence offset
 * never crosses a getConfidenceLabel threshold. Applied equally to all categories.
 */
function applyDuplicateMetricGuard(pairs: LandingCardPair[]): LandingCardPair[] {
  const METRIC_IDS = ["smart-money", "public-vs-whale", "pre-event-score"];
  const metricVal = (p: LandingCardPair, id: string): number => {
    const m = (p.premiumSignal?.metrics ?? []).find((x) => x.id === id);
    return m ? Math.round(Number(m.value) || 0) : 0;
  };
  const vectorOf = (p: LandingCardPair): number[] => [
    Math.round(Number(p.premiumSignal?.winProbability) || 0),
    ...METRIC_IDS.map((id) => metricVal(p, id)),
  ];

  const groups = new Map<string, LandingCardPair[]>();
  for (const p of pairs) {
    const key = vectorOf(p).join("|");
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Only adjust when the group spans DISTINCT events/markets.
    const idOf = (p: LandingCardPair) =>
      `${p.diagnostics?.conditionId ?? ""}|${p.premiumSignal?.eventTitle ?? ""}|${p.diagnostics?.currentPrice ?? ""}`;
    const ids = group.map(idOf);
    if (ids.every((x) => x === ids[0])) continue; // same event — not a fake-looking duplicate

    group.forEach((p, idx) => {
      if (idx === 0) return; // first member is the anchor — keep raw values
      const seed = stableHash(
        `${p.id}|${p.diagnostics?.conditionId ?? ""}|${p.diagnostics?.selectedOutcome ?? ""}|${p.premiumSignal?.eventTitle ?? ""}`,
      );
      const rawVec = vectorOf(p);

      // Confidence offset — must not cross a label threshold (75 / 65).
      const rawWp = rawVec[0];
      let adjWp = clamp(rawWp + ((seed % 3) - 1), 0, 100);
      if (getConfidenceLabel(adjWp) !== getConfidenceLabel(rawWp)) adjWp = rawWp;
      p.premiumSignal.winProbability = adjWp;

      // Metric offsets — deterministic -1/0/+1 from distinct hash bits.
      const offsets = [((seed >> 2) % 3) - 1, ((seed >> 4) % 3) - 1, ((seed >> 6) % 3) - 1];
      METRIC_IDS.forEach((id, i) => {
        const m = (p.premiumSignal?.metrics ?? []).find((x) => x.id === id);
        if (!m) return;
        const adj = clamp(Math.round(Number(m.value) || 0) + offsets[i], 0, 100);
        m.value = adj;
        m.bar = adj;
      });

      // Guarantee the vector actually changed; if every offset cancelled, nudge
      // the first metric deterministically (still no randomness).
      let adjVec = vectorOf(p);
      if (adjVec.join("|") === rawVec.join("|")) {
        const m = (p.premiumSignal?.metrics ?? []).find((x) => x.id === METRIC_IDS[0]);
        if (m) {
          const cur = Math.round(Number(m.value) || 0);
          const adj = cur < 100 ? cur + 1 : cur - 1;
          m.value = adj;
          m.bar = adj;
          adjVec = vectorOf(p);
        }
      }

      if (p.diagnostics) {
        p.diagnostics.metricDedupeAdjusted = true;
        p.diagnostics.metricDedupeReason = "duplicate_metric_vector";
        p.diagnostics.rawMetricVector = rawVec;
        p.diagnostics.adjustedMetricVector = adjVec;
      }
    });
  }
  return pairs;
}

/**
 * Identify real sports markets that should be displayed as conservative fallback,
 * not as high-confidence live-edge signals.
 *
 * This does not reject the market. It only caps UI confidence/tone.
 */
function isMiddleConfidenceSportsFallbackMarket(event: PolymarketRawEvent, market: PolymarketRawMarket): boolean {
  const normalizedText = getCandidateSearchText(event, market)
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedText) return false;

  const fallbackPatterns = [
    /\bwinner\b/,
    /\bchampion(s)?\b/,
    /\bchampionship\b/,
    /\bstanley cup\b/,
    /\bsuper bowl\b/,
    /\bnba finals\b/,
    /\bworld cup\b/,
    /\bworld series\b/,
    /\bseason\b/,
    /\bregular season\b/,
    /\bplayoff(s)?\b/,
    /\bconference\b/,
    /\bdivision\b/,
    /\brelegation\b/,
    /\brelegated\b/,
    /\bpromotion\b/,
    /\bpromoted\b/,
    /\btop\s+\d+\b/,
    /\b\d+(st|nd|rd|th)\s+place\b/,
    /\btop\s+goalscorer\b/,
    /\btop\s+goal\s+scorer\b/,
    /\btop\s+scorer\b/,
    /\bgolden\s+boot\b/,
    /\bmost\s+goals\b/,
  ];

  return fallbackPatterns.some(regex => regex.test(normalizedText));
}

/**
 * Fetch events with pagination support for sports discovery
 * Tries sports tag API first if available, falls back to broad events + keyword filtering
 */
async function fetchEventsForCategory(
  category: string,
  targetCount: number
): Promise<{
  events: PolymarketRawEvent[];
  sportsTagAttempted: boolean;
  sportsTagSuccess: boolean;
  sportsTagError?: string;
}> {
  const allEvents: PolymarketRawEvent[] = [];
  let sportsTagAttempted = false;
  let sportsTagSuccess = false;
  let sportsTagError: string | undefined;

  // For sports category, try to get sports tag metadata first
  if (category === "sports") {
    sportsTagAttempted = true;
    const sportsMeta = await fetchPolymarketSportsMetadataSafe();

    if (sportsMeta.success && sportsMeta.tagId) {
      // Use tag-filtered fetch for better sports discovery
      const tagEvents = await fetchPolymarketEventsByTagSafe(sportsMeta.tagId, 100);
      if (tagEvents.length > 0) {
        allEvents.push(...tagEvents);
        sportsTagSuccess = true;
      }
    } else {
      sportsTagError = sportsMeta.error;
    }

    // If tag fetch didn't yield enough results, supplement with broad search
    if (allEvents.length < targetCount) {
      // Fetch up to 3 pages of active events (300 total)
      for (let page = 0; page < 3; page++) {
        const pageEvents = await fetchPolymarketActiveEvents({
          limit: 100,
          offset: page * 100,
        });

        if (pageEvents.length === 0) break;

        // Add events that aren't already in the list
        const newEvents = pageEvents.filter(
          e => !allEvents.some(existing => existing.id === e.id)
        );
        allEvents.push(...newEvents);

        // Stop if we have enough events
        if (allEvents.length >= targetCount * 3) break;
      }
    }
  } else {
    // For non-sports or category=all, fetch broad events
    for (let page = 0; page < 2; page++) {
      const pageEvents = await fetchPolymarketActiveEvents({
        limit: 100,
        offset: page * 100,
      });

      if (pageEvents.length === 0) break;
      allEvents.push(...pageEvents);

      if (allEvents.length >= targetCount * 2) break;
    }
  }

  return {
    events: allEvents,
    sportsTagAttempted,
    sportsTagSuccess,
    sportsTagError,
  };
}

/**
 * Build upcoming candidate pairs through the SAME unified enrichment + scoring
 * path as qualified cards: sampleToCandidateMarket → enrichMarket →
 * generateLandingCardPair. No manual zero-enrichment metrics, no surrogate
 * confidence formula. minDataCoverage is intentionally NOT gated here — upcoming
 * markets have low coverage by nature; the actionable odds band inside
 * computeBandedSignalScore (within generateLandingCardPair) is the real gate.
 * Marks signalStatus: "upcoming_candidate" + gameStartIso on diagnostics.
 */
async function buildUpcomingPairs(
  samples: SportsDiscoverySample[],
  upcomingLimit: number,
): Promise<LandingCardPair[]> {
  const pairs: LandingCardPair[] = [];

  // Strategic priority overrides pure time-sort so WC26/NBA/NHL (settling weeks out)
  // are not starved by near-term fallback48h matches when upcomingLimit is tight.
  const STRATEGIC_PRIORITY: Record<string, number> = {
    "World Cup 2026": 4,
    "NBA": 3,
    "NHL": 2,
    "Esports": 1,
  };
  const priorityOf = (s: SportsDiscoverySample): number =>
    STRATEGIC_PRIORITY[s.leagueName ?? ""] ?? 0;
  const sorted = [...samples].sort((a, b) => {
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pa !== pb) return pb - pa; // strategic categories first
    const aTime = a.resolvedGameTimeIso ? new Date(a.resolvedGameTimeIso).getTime() : Infinity;
    const bTime = b.resolvedGameTimeIso ? new Date(b.resolvedGameTimeIso).getTime() : Infinity;
    if (aTime !== bTime) return aTime - bTime;
    return (b.eventVolumeUsd ?? 0) - (a.eventVolumeUsd ?? 0);
  });

  const seenPairIds = new Set<string>();
  for (const sample of sorted) {
    if (pairs.length >= upcomingLimit) break;
    if (!sample.leagueName || !sample.resolvedGameTimeIso || !sample.primaryMarketRaw?.conditionId) continue;

    const candidate = sampleToCandidateMarket(sample);
    if (!candidate) continue;

    // Unified enrichment — fetches price history / trades / holders just like
    // qualified cards, so trust metrics vary per real market diagnostics.
    const enriched = await enrichMarket(candidate.event, candidate.market, candidate.warnings);
    if (!enriched) continue;
    // minDataCoverage gate intentionally NOT applied for upcoming candidates:
    // coverage is naturally low pre-event. computeBandedSignalScore's actionable
    // odds band (inside generateLandingCardPair) is the real eligibility gate.

    const pair = generateLandingCardPair(enriched);
    if (!pair) continue;
    if (pair.premiumSignal.winProbability < 52) continue; // unified low-confidence gate
    if (seenPairIds.has(pair.id)) continue;
    seenPairIds.add(pair.id);

    // Mark as upcoming candidate — unified scoring already applied above.
    pair.diagnostics.signalStatus = "upcoming_candidate";
    pair.diagnostics.gameStartIso = sample.resolvedGameTimeIso;

    pairs.push(pair);
  }

  return pairs;
}

// ── Research universe snapshot builder ───────────────────────────────────────
// Captures a snapshot BEFORE product gates (dataCoverage, rejectionReasons,
// winProbability, duplicate suppression, category allocation, final cap).
// Returns null if the candidate fails research eligibility (binary guard,
// token presence, odds corridor). Does NOT modify enriched or diagnostics.

async function tryBuildResearchSnapshot(
  enriched: EnrichedMarket,
  candidate: CandidateMarket,
  snapshotRunId: string,
  snapshotAt: string,
  oddsMin: number,
  oddsMax: number,
  funnel?: ResearchFunnelCounters,
): Promise<ResearchEligibleSignalSnapshot | null> {
  const diag = enriched.diagnostics;
  if (funnel) funnel.attempted++;

  // Must have condition_id and selectedTokenId
  const condId = diag.conditionId;
  const selectedTokId = diag.selectedTokenId;
  if (!condId || !selectedTokId) { if (funnel) funnel.rejectedMissingConditionOrSelectedToken++; return null; }

  // Must be a binary market (derived by M3-C block and stored in diagnostics)
  if (!diag.directionalFlowBinaryGuard) { if (funnel) funnel.rejectedNoBinaryGuard++; return null; }

  // Derive opposing token from market token array
  const allTokenIds = safeParseArray<string>(
    enriched.market.clobTokenIds ?? enriched.market.tokenIds,
  );
  const opposingTokId = allTokenIds.find((t) => Boolean(t) && t !== selectedTokId) ?? null;
  if (!opposingTokId) { if (funnel) funnel.rejectedMissingOpposingToken++; return null; }

  // Must have a valid price in (0, 1)
  const price = enriched.selectedOutcome.price;
  if (price <= 0 || price >= 1) { if (funnel) funnel.rejectedInvalidPrice++; return null; }

  // European odds = 1 / price; enforce corridor
  const europeanOdds = Math.round((1 / price) * 10000) / 10000;
  if (europeanOdds < oddsMin) { if (funnel) funnel.rejectedOddsBelowMin++; return null; }
  if (europeanOdds > oddsMax) { if (funnel) funnel.rejectedOddsAboveMax++; return null; }
  if (funnel) funnel.eligible++;

  // expiresAt = snapshotAt + 90 days
  const expiresAt = new Date(
    new Date(snapshotAt).getTime() + 90 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Build research-only diagnostics clone — never mutate shared diag
  const parentMetaExt = (enriched.market as unknown as Record<string, unknown>)._parentMeta as
    (ParentEventMeta & { sportsMarketType?: string; gameTimeConfidence?: string }) | undefined;

  const gameStartIso = diag.gameStartIso ?? null;
  const gameStartMs = gameStartIso ? Date.parse(gameStartIso) : Number.NaN;
  const snapshotMs = Date.parse(snapshotAt);
  const signalPhaseAtSnapshot: "prematch" | "live" | "unknown" =
    !Number.isFinite(gameStartMs) || !Number.isFinite(snapshotMs)
      ? "unknown"
      : snapshotMs < gameStartMs
        ? "prematch"
        : "live";

  // marketCloseIso: event.endDate is resolvedGameTimeIso (game-time proxy) in the
  // sports-discovery path — not a proven market-close timestamp. No reliable source
  // for market close exists at snapshot time; store null.

  // Fetch selected-token order book — research path only, fail-open
  const fetchStartedAt = Date.now();
  if (funnel) funnel.execFetchAttempted++;

  type BookLevel = { price: number; size: number };
  // Default: fail-open in case of unexpected throw before state is determined
  let execContext: NonNullable<LandingCardDiagnostics["execContext"]> = {
    v: "v1",
    fetchedAt: new Date().toISOString(),
    fetchDurationMs: 0,
    fetchState: "fetch_failed",
    selectedTopBids: [],
    selectedTopAsks: [],
  };

  try {
    const rawBook = await fetchOrderBookSafe(selectedTokId);
    const fetchDurationMs = Date.now() - fetchStartedAt;
    const fetchedAt = new Date().toISOString();

    if (rawBook === null) {
      if (funnel) funnel.execFetchFailed++;
      execContext = {
        v: "v1",
        fetchedAt,
        fetchDurationMs,
        fetchState: "fetch_failed",
        selectedTopBids: [],
        selectedTopAsks: [],
      };
    } else {
      const parseBid = ([p, s]: [string, string]): BookLevel | null => {
        const price = parseFloat(p);
        const size = parseFloat(s);
        return Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0
          ? { price, size } : null;
      };
      const parseAsk = parseBid;

      const selectedTopBids = (rawBook.bids ?? [])
        .map(parseBid)
        .filter((l): l is BookLevel => l !== null)
        .sort((a, b) => b.price - a.price)   // bids: price DESC
        .slice(0, 10);

      const selectedTopAsks = (rawBook.asks ?? [])
        .map(parseAsk)
        .filter((l): l is BookLevel => l !== null)
        .sort((a, b) => a.price - b.price)   // asks: price ASC
        .slice(0, 10);

      const fetchState =
        selectedTopBids.length === 0 && selectedTopAsks.length === 0
          ? "empty_book"
          : "ok";

      if (funnel) {
        if (fetchState === "ok") funnel.execFetchOk++;
        else funnel.execFetchEmptyBook++;
      }

      execContext = {
        v: "v1",
        fetchedAt,
        fetchDurationMs,
        fetchState,
        selectedTopBids,
        selectedTopAsks,
      };
    }
  } catch (execErr) {
    const fetchDurationMs = Date.now() - fetchStartedAt;
    if (funnel) funnel.execFetchFailed++;
    console.warn(
      "[research-exec-context] fail-open fetch_failed:",
      execErr instanceof Error ? execErr.message.slice(0, 180) : String(execErr).slice(0, 180),
    );
    execContext = {
      v: "v1",
      fetchedAt: new Date().toISOString(),
      fetchDurationMs,
      fetchState: "fetch_failed",
      selectedTopBids: [],
      selectedTopAsks: [],
    };
  }

  const researchDiagnostics: LandingCardDiagnostics = {
    ...diag,
    researchContext: {
      v: "v1",
      signalPhaseAtSnapshot,
      marketCloseIso: null,
      // parentMetaExt._parentMeta.sportsMarketType is set for sports-discovery samples only.
      // null is acceptable for generic enriched candidates in Path A.
      marketType: safeString(parentMetaExt?.sportsMarketType) ?? null,
      familySource: "parentMeta.category",
      taxonomyVersion: "v1-dimension-fix",
      discoverySourceProxy: safeString(candidate.sportsMatchedKeyword) ?? null,
      gameTimeConfidence:
        (parentMetaExt?.gameTimeConfidence as "high" | "medium" | "low" | "none" | undefined) ??
        null,
    },
    execContext,
    // Explainability: formula score available from enrichment (set before snapshot capture)
    formulaScore: diag.formulaAudit?.finalSignalV2 ?? null,
  };

  // Modeling feature contract v1 — derived fields (no feed impact)
  const hoursUntilStartNum =
    Number.isFinite(gameStartMs) && Number.isFinite(snapshotMs)
      ? Math.round(((gameStartMs - snapshotMs) / 3_600_000) * 100) / 100
      : null;
  // opposingPriceNum: safe only when binary guard is proven (checked at top of function)
  const opposingPriceNum =
    diag.directionalFlowBinaryGuard === true
      ? Math.round((1 - price) * 10_000) / 10_000
      : null;
  const oddsBandLabel = diag.formulaAudit?.oddsBandLabel ?? null;
  const eventId = safeString(candidate.event.id) ?? null;

  return {
    snapshotRunId,
    snapshotAt,
    expiresAt,
    scope: "RESEARCH_ELIGIBLE_UNIVERSE",
    formulaVersion: FORMULA_VERSION,
    conditionId: condId,
    selectedTokenId: selectedTokId,
    opposingTokenId: opposingTokId,
    eventSlug:
      safeString(candidate.event.slug) ??
      safeString(candidate.market.slug) ??
      null,
    selectedOutcome: diag.selectedOutcome,
    selectedPriceNum: price,
    selectedEuropeanOddsNum: europeanOdds,
    marketFamily: safeString(enriched.parentMeta.category) ?? null,
    league: safeString(enriched.parentMeta.category) ?? null,
    gameStartIso: diag.gameStartIso ?? null,
    dataCoverageNum: typeof diag.dataCoverage === "number" ? diag.dataCoverage : null,
    // Collect existing product rejection reasons as metadata only — NOT used as eligibility filter
    productRejectionReasons: [...diag.rejectionReasons],
    diagnostics: researchDiagnostics,
    publicFeedExposed: false, // will be marked true after pairsToCache is known
    // Modeling feature contract v1
    eventId,
    formulaFeatureVersion: "modeling-features-v1",
    hoursUntilStartNum,
    signalPhaseAtSnapshot,
    oddsBandLabel,
    opposingPriceNum,
  };
}

/**
 * Main function to build landing cards from Polymarket data
 *
 * Supports filtering by:
 * - category: sports-first filtering (sports | all)
 * - minDataCoverage: minimum data coverage threshold
 * - excludeEnded: exclude ended/closed markets
 * - collectResearchSnapshots: if true, collect RESEARCH_ELIGIBLE_UNIVERSE
 *   snapshots before product gates (default: false — preserves old behavior)
 */
export async function buildLandingCards(options?: {
  limit?: number;
  category?: string;
  minDataCoverage?: number;
  excludeEnded?: boolean;
  includeUpcoming?: boolean;
  upcomingLimit?: number;
  // Research universe options — safe defaults preserve existing behavior
  collectResearchSnapshots?: boolean;
  researchSnapshotRunId?: string;
  researchSnapshotAt?: string;
  researchLimit?: number;
  researchOddsMin?: number;
  researchOddsMax?: number;
}): Promise<LandingCardsResponse> {
  const limit = clamp(options?.limit ?? 4, 1, 15);
  const category = options?.category ?? "sports";
  const minDataCoverage = clamp(options?.minDataCoverage ?? 25, 0, 100);
  const excludeEnded = options?.excludeEnded ?? true;
  const includeUpcoming = options?.includeUpcoming ?? false;
  const upcomingLimit = clamp(options?.upcomingLimit ?? 5, 1, 15);

  // Research universe options — collectResearchSnapshots=false preserves old behavior exactly
  const collectResearchSnapshots = options?.collectResearchSnapshots ?? false;
  const researchSnapshotRunId = options?.researchSnapshotRunId ?? null;
  const researchSnapshotAt = options?.researchSnapshotAt ?? null;
  const researchLimit = clamp(options?.researchLimit ?? limit * 3, 1, 200);
  const researchOddsMin = options?.researchOddsMin ?? 1.25;
  const researchOddsMax = options?.researchOddsMax ?? 4.00;

  const researchSnapshots: ResearchEligibleSignalSnapshot[] = [];

  const rf: ResearchFunnelCounters = {
    candidatesSeen: 0, rejectedPreResearchCandidateReasons: 0, enrichmentNull: 0,
    attempted: 0, rejectedMissingConditionOrSelectedToken: 0, rejectedNoBinaryGuard: 0,
    rejectedMissingOpposingToken: 0, rejectedInvalidPrice: 0, rejectedOddsBelowMin: 0,
    rejectedOddsAboveMax: 0, eligible: 0, execFetchAttempted: 0,
    execFetchOk: 0, execFetchEmptyBook: 0, execFetchFailed: 0,
  };

  let upcomingRawSamples: SportsDiscoverySample[] = [];

  // Track inspected counts for diagnostics
  let eventsCount = 0;
  let marketsCount = 0;
  let candidatesAfterCategoryFilter = 0;
  let candidatesAfterEndedFilter = 0;
  let pairsGenerated = 0;
  let candidatesAfterDataCoverageFilter = 0;

  // Sports discovery diagnostics (null when category != "sports")
  let sportsDiscoveryCounts: Record<string, unknown> | null = null;
  let sportsRejectionReasonCounts: Record<string, number> | null = null;
  let sportsSampleToNullCount = 0;
  let sportsFallback48hNullDrops = 0;
  // S2: Research universe lifted to outer scope so the S2 selection loop (which runs
  // after the if/else candidates block) can access it without referencing `discovery`.
  let s2ResearchUniverse: ResearchNestedMarket[] = [];
  let s2ResearchUniverseEventCount = 0;

  // Track fetch metadata
  let sportsTagAttempted = false;
  let sportsTagSuccess = false;
  let sportsTagError: string | undefined;

  // Sampled titles for diagnostics
  let sampledEventTitles: string[] = [];
  let sampledMarketQuestions: string[] = [];

  try {
    // Fetch events with pagination and optional sports tag discovery
    let candidates: CandidateMarket[] = [];
    const nonSportsRejected: Array<{ id?: string; rejectionReasons: string[] }> = [];

    if (category === "sports") {
      // Sports path: use markets-first discovery (24h window, futures filtered)
      const discovery = await discoverSportsMarkets({
        windowHours: 24,
        fallbackWindowHours: 48,
        fetchVolumeMinUsd: 50000,
        finalEventVolumeMinUsd: 100000,
        targetCards: limit * 2,
      });

      if (includeUpcoming) {
        // Strategic priority order: WC26 → NBA → NHL → eSport → fallback48h.
        // buildUpcomingPairs iterates in this order and stops at upcomingLimit.
        const strategicOrdered: SportsDiscoverySample[] = [];
        const pushUnique = (xs: SportsDiscoverySample[] | undefined, cap: number) => {
          if (!xs || xs.length === 0) return;
          const existing = new Set(strategicOrdered.map(s => s.gameId || s.slug || s.title));
          for (const s of xs) {
            if (cap <= 0) break;
            const k = s.gameId || s.slug || s.title;
            if (existing.has(k)) continue;
            strategicOrdered.push(s);
            existing.add(k);
            cap--;
          }
        };
        // Strategic targets (priority cats get higher reserve than eSport).
        // WC26/NBA/NHL are reserve up to 3; eSport hard cap 2 here AND in
        // applyCategoryAllocation downstream (defensive double-cap).
        pushUnique(discovery.extendedWc2026Candidates, 3);
        pushUnique(discovery.extendedNbaCandidates, 3);
        pushUnique(discovery.extendedNhlCandidates, 3);
        pushUnique(discovery.extendedEsportsCandidates, 2);
        // Fallback48h candidates appended last, deduped
        const existing = new Set(strategicOrdered.map(s => s.gameId || s.slug || s.title));
        const fallbackUnique = discovery.fallback48hCandidates.filter(
          s => !existing.has(s.gameId || s.slug || s.title),
        );
        upcomingRawSamples = [...strategicOrdered, ...fallbackUnique];
      }

      const discoverySamples = [
        ...discovery.finalCandidates,
        ...discovery.fallback48hCandidates,
      ].slice(0, limit * 3);

      let sampleToNullCount = 0;
      let fallback48hNullDrops = 0;
      candidates = discoverySamples.reduce<CandidateMarket[]>((acc, sample) => {
        const c = sampleToCandidateMarket(sample);
        if (c === null) {
          sampleToNullCount++;
          if (sample.strategy === "markets-first-48h-fallback") fallback48hNullDrops++;
        } else {
          acc.push(c);
        }
        return acc;
      }, []);

      eventsCount = discovery.counts.rawMarketsFetched;
      marketsCount = discovery.counts.normalizedMarkets;
      candidatesAfterCategoryFilter = candidates.length;
      candidatesAfterEndedFilter = candidates.length;
      // Capture discovery diagnostics for job-run passthrough (no new computation)
      sportsDiscoveryCounts = discovery.counts as unknown as Record<string, unknown>;
      sportsRejectionReasonCounts = discovery.rejectionReasonCounts;
      // S2: Lift research universe to outer scope for the post-candidates S2 selection loop
      s2ResearchUniverse = discovery.researchEligibleMarkets ?? [];
      s2ResearchUniverseEventCount = discovery.counts.researchEligibleEvents ?? 0;
      sportsSampleToNullCount = sampleToNullCount;
      sportsFallback48hNullDrops = fallback48hNullDrops;

      if (candidates.length === 0) {
        const rawUpcoming = includeUpcoming ? await buildUpcomingPairs(upcomingRawSamples, upcomingLimit) : [];
        const allocated = applyCategoryAllocation([], rawUpcoming);
        // Final deterministic dedupe guard over the combined feed.
        applyDuplicateMetricGuard([...allocated.pairs, ...allocated.upcomingPairs]);
        return {
          generatedAt: new Date().toISOString(),
          source: "polymarket",
          formulaVersion: FORMULA_VERSION,
          pairs: [],
          ...(includeUpcoming ? { upcomingPairs: allocated.upcomingPairs } : {}),
          rejected: [{
            rejectionReasons: [
              "No sports candidates from markets-first discovery",
              `diagnosis: ${discovery.diagnosis}`,
              `within24h: ${discovery.counts.within24hGroups}`,
              `within48h: ${discovery.counts.within48hGroups}`,
              `futuresRejected: ${discovery.counts.futuresRejected}`,
            ],
          }],
          filters: { limit, category, minDataCoverage, excludeEnded },
          inspected: {
            eventsCount,
            marketsCount,
            candidatesAfterCategoryFilter,
            candidatesAfterEndedFilter,
            candidatesAfterDataCoverageFilter,
            pairsGenerated,
          },
          ...(collectResearchSnapshots ? { researchSnapshots, researchFunnel: rf } : {}),
        };
      }
    } else {
      // Non-sports: use events-first approach
      const fetchResult = await fetchEventsForCategory(category, limit * 3);
      const events = fetchResult.events;
      eventsCount = events.length;
      marketsCount = 0;

      if (events.length === 0) {
        return {
          generatedAt: new Date().toISOString(),
          source: "polymarket",
          formulaVersion: FORMULA_VERSION,
          pairs: [],
          rejected: [{ rejectionReasons: ["No active events found from Polymarket API"] }],
          filters: { limit, category, minDataCoverage, excludeEnded },
          inspected: {
            eventsCount, marketsCount,
            candidatesAfterCategoryFilter, candidatesAfterEndedFilter,
            candidatesAfterDataCoverageFilter, pairsGenerated,
          },
          ...(collectResearchSnapshots ? { researchSnapshots, researchFunnel: rf } : {}),
        };
      }

      const allCandidates = extractCandidateMarkets(events);
      marketsCount = allCandidates.length;
      candidates = allCandidates;
      candidatesAfterCategoryFilter = candidates.length;
    }

    candidates.sort((a, b) => {
      const getGameTime = (c: CandidateMarket): number => {
        const raw = c.market as unknown as Record<string, unknown>;
        const gs = raw.gameStartTime ?? raw.game_start_time ?? raw.startDate;
        if (gs && typeof gs === "string") {
          const t = new Date(gs).getTime();
          if (!isNaN(t) && t > Date.now()) return t;
        }
        const ed = c.event.endDate;
        if (ed) {
          const t = new Date(ed).getTime();
          if (!isNaN(t) && t > Date.now()) return t;
        }
        return Infinity;
      };
      const eventVolume = (c: CandidateMarket): number =>
        Number(c.event.volume24hr ?? c.market.volume24hr ?? 0) || 0;
      const now = Date.now();
      const aTime = getGameTime(a);
      const bTime = getGameTime(b);
      // Founder hard rule: qualified sports events starting within the next 24h
      // go first, ordered by aggregate parent-event volume DESC (fallback to
      // selected-market volume). Everything else keeps existing relative order.
      const aIn24h = aTime < now + 24 * 60 * 60 * 1000;
      const bIn24h = bTime < now + 24 * 60 * 60 * 1000;
      if (aIn24h && !bIn24h) return -1;
      if (!aIn24h && bIn24h) return 1;
      if (aIn24h && bIn24h) return eventVolume(b) - eventVolume(a);
      const aIsUpcoming = aTime < now + 48 * 60 * 60 * 1000;
      const bIsUpcoming = bTime < now + 48 * 60 * 60 * 1000;
      if (aIsUpcoming && !bIsUpcoming) return -1;
      if (!aIsUpcoming && bIsUpcoming) return 1;
      if (aIsUpcoming && bIsUpcoming) return aTime - bTime;
      const aVol = safeParseNumber(
        (a.market as unknown as Record<string, unknown>).volume24hr ?? 0
      ) ?? 0;
      const bVol = safeParseNumber(
        (b.market as unknown as Record<string, unknown>).volume24hr ?? 0
      ) ?? 0;
      return bVol - aVol;
    });

    const pairs: LandingCardPair[] = [];
    const seenPairIds = new Set<string>();
    const seenMarketKeys = new Set<string>();
    const rejected: Array<{ id?: string; rejectionReasons: string[] }> = [];

    // Filter out ended markets if excludeEnded is true
    if (excludeEnded) {
      const endedRejectionReason = "Market ended";
      const closedRejectionReason = "Market closed";
      const inactiveRejectionReason = "Inactive market";

      const activeCandidates: CandidateMarket[] = [];
      for (const candidate of candidates) {
        if (candidate.isEnded) {
          // Add to rejected with specific reason
          const rejectionReasons: string[] = [];
          if (candidate.market.closed === true) {
            rejectionReasons.push(closedRejectionReason);
          } else if (candidate.market.active === false) {
            rejectionReasons.push(inactiveRejectionReason);
          } else {
            rejectionReasons.push(endedRejectionReason);
          }
          rejected.push({
            id: candidate.market.id,
            rejectionReasons: [...rejectionReasons, ...candidate.rejectionReasons],
          });
        } else {
          activeCandidates.push(candidate);
        }
      }
      candidates = activeCandidates;
      candidatesAfterEndedFilter = candidates.length;
    } else {
      candidatesAfterEndedFilter = candidates.length;
    }

    // Process candidates until we have enough product pairs AND research snapshots.
    // When collectResearchSnapshots=false the loop breaks exactly as before (at pairs.length>=limit).
    // When collectResearchSnapshots=true the loop continues past the product cap only until
    // researchSnapshots.length>=researchLimit; product pairs[] is never extended past limit.
    for (const candidate of candidates) {
      const productCapReached = pairs.length >= limit;
      const researchCapReached =
        !collectResearchSnapshots || researchSnapshots.length >= researchLimit;

      // Both caps satisfied — stop iterating
      if (productCapReached && researchCapReached) break;

      if (collectResearchSnapshots && !researchCapReached) rf.candidatesSeen++;

      // Skip if already has rejection reasons (product path only; research skips pre-enrichment failures)
      if (candidate.rejectionReasons.length > 0) {
        if (!productCapReached) {
          rejected.push({
            id: candidate.market.id,
            rejectionReasons: [...candidate.rejectionReasons],
          });
        }
        if (collectResearchSnapshots && !researchCapReached) rf.rejectedPreResearchCandidateReasons++;
        continue;
      }

      // Enrich with API data (pass initial warnings)
      const enriched = await enrichMarket(candidate.event, candidate.market, candidate.warnings);

      if (!enriched) {
        if (!productCapReached) {
          rejected.push({
            id: candidate.market.id,
            rejectionReasons: ["Failed to select valid outcome"],
          });
        }
        if (collectResearchSnapshots && !researchCapReached) rf.enrichmentNull++;
        continue;
      }

      // ── RESEARCH SNAPSHOT CAPTURE (before product gates) ────────────────────
      // Captured AFTER enrichment and M3-C diagnostics, BEFORE dataCoverage
      // threshold, rejectionReasons gate, winProbability threshold, and all
      // product-specific filters. dataCoverage is stored as a field, NOT used
      // as an eligibility gate here.
      if (collectResearchSnapshots && !researchCapReached && researchSnapshotRunId && researchSnapshotAt) {
        const snap = await tryBuildResearchSnapshot(
          enriched,
          candidate,
          researchSnapshotRunId,
          researchSnapshotAt,
          researchOddsMin,
          researchOddsMax,
          rf,
        );
        if (snap) researchSnapshots.push(snap);
      }

      // ── PRODUCT GATES (only when product cap not yet reached) ───────────────
      if (productCapReached) continue;

      // Check data coverage threshold
      if (enriched.diagnostics.dataCoverage < minDataCoverage) {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: [
            `Data coverage below threshold: ${enriched.diagnostics.dataCoverage}%`,
            `Required: ${minDataCoverage}%`,
          ],
        });
        continue;
      }

      candidatesAfterDataCoverageFilter++;

      if (enriched.diagnostics.rejectionReasons.length > 0) {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: enriched.diagnostics.rejectionReasons,
        });
        continue;
      }

      // Generate landing card pair
      const pair = generateLandingCardPair(enriched);

      if (!pair) {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: ["Failed to generate landing card pair"],
        });
        continue;
      }
      if (pair.premiumSignal.winProbability < 52) {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: [`Signal confidence too low: ${pair.premiumSignal.winProbability}`],
        });
        continue;
      }

      // Check if premiumSignal.time is "Ended" and exclude if needed
      if (excludeEnded && pair.premiumSignal.time === "Ended") {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: ["Market ended (premiumSignal.time = Ended)"],
        });
        continue;
      }

      const marketKey =
        safeString(candidate.market.id) ||
        safeString(candidate.market.conditionId) ||
        safeString(candidate.market.slug) ||
        pair.id;

      if (seenPairIds.has(pair.id) || seenMarketKeys.has(marketKey)) {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: [`Duplicate landing pair skipped: ${pair.id}`],
        });
        continue;
      }

      seenPairIds.add(pair.id);
      seenMarketKeys.add(marketKey);

      pairs.push(pair);
      pairsGenerated++;
    }

    // Include non-sports rejected markets in final rejected list (for category=sports)
    const finalRejected = rejected;
    const rawUpcomingFinal = includeUpcoming ? await buildUpcomingPairs(upcomingRawSamples, upcomingLimit) : [];
    const allocatedFinal = applyCategoryAllocation(pairs, rawUpcomingFinal);
    // Final deterministic dedupe guard over the combined feed (all categories).
    applyDuplicateMetricGuard([...allocatedFinal.pairs, ...allocatedFinal.upcomingPairs]);

    // ── S2: Wide research universe snapshot selection ──────────────────────────────
    // Runs after the public feed is finalized. Selects up to researchLimit snapshots
    // from discovery.researchEligibleMarkets (pre-grouping, pre-volume universe).
    // Always includes public-feed-exposed markets; fills remaining slots via
    // deterministic rotation over the hidden pool (30-min UTC bucket offset).
    // Does NOT call enrichMarket — builds minimal snapshots from raw event-spine fields.
    // Public-path snapshots (from the candidate loop above) are preserved; this loop
    // only ADDS to researchSnapshots, never replaces.
    if (
      collectResearchSnapshots &&
      researchSnapshotRunId &&
      researchSnapshotAt &&
      s2ResearchUniverse.length > 0
    ) {
      const rawUniverse: ResearchNestedMarket[] = s2ResearchUniverse;

      // Build public identity set from final allocated pairs + upcoming pairs
      const publicIdentitySet = new Set<string>();
      for (const p of [
        ...allocatedFinal.pairs,
        ...(includeUpcoming ? allocatedFinal.upcomingPairs : []),
      ]) {
        if (p.diagnostics?.conditionId && p.diagnostics?.selectedTokenId) {
          publicIdentitySet.add(`${p.diagnostics.conditionId}::${p.diagnostics.selectedTokenId}`);
        }
      }

      // Deduplicate universe by conditionId::selectedTokenId
      const universeMap = new Map<string, ResearchNestedMarket>();
      for (const rm of rawUniverse) {
        const k = `${rm.conditionId}::${rm.selectedTokenId}`;
        if (!universeMap.has(k)) universeMap.set(k, rm);
      }
      const dedupedUniverse = Array.from(universeMap.values());

      // Split: public-exposed (always include) vs. hidden (rotating)
      const publicExposed = dedupedUniverse.filter(rm =>
        publicIdentitySet.has(`${rm.conditionId}::${rm.selectedTokenId}`)
      );
      const hidden = dedupedUniverse.filter(rm =>
        !publicIdentitySet.has(`${rm.conditionId}::${rm.selectedTokenId}`)
      );

      // Deterministic stable sort of hidden pool by conditionId::selectedTokenId
      hidden.sort((a, b) => {
        const ka = `${a.conditionId}::${a.selectedTokenId}`;
        const kb = `${b.conditionId}::${b.selectedTokenId}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });

      // Rotation: 30-min UTC bucket offset wraps around hidden pool
      const bucket30min = Math.floor(Date.now() / (30 * 60 * 1000));
      const offset = hidden.length > 0 ? bucket30min % hidden.length : 0;
      const rotatedHidden = hidden.length > 0
        ? [...hidden.slice(offset), ...hidden.slice(0, offset)]
        : [];

      // Select: public-exposed first, then rotating hidden, capped at researchLimit
      const remainingSlots = Math.max(0, researchLimit - publicExposed.length);
      const selectedHidden = rotatedHidden.slice(0, remainingSlots);
      const selectedResearch = [...publicExposed, ...selectedHidden];

      // Build set of already-captured conditionId::selectedTokenId keys (from public-path loop)
      const alreadyCapturedKeys = new Set(
        researchSnapshots.map(s => `${s.conditionId}::${s.selectedTokenId}`)
      );

      // Build minimal snapshots directly from ResearchNestedMarket fields
      const nowMs = Date.now();
      const s2ExpiresAt = new Date(
        new Date(researchSnapshotAt).getTime() + 90 * 24 * 60 * 60 * 1000
      ).toISOString();

      for (const rm of selectedResearch) {
        const rmKey = `${rm.conditionId}::${rm.selectedTokenId}`;
        if (alreadyCapturedKeys.has(rmKey)) continue; // already captured via public-path loop

        const hoursUntilStart = (new Date(rm.eventStartIso).getTime() - nowMs) / 3_600_000;
        const europeanOdds = rm.selectedPriceNum > 0
          ? Math.round((1 / rm.selectedPriceNum) * 10_000) / 10_000
          : null;
        const isPublicExposed = publicIdentitySet.has(rmKey);

        const s2Snap: ResearchEligibleSignalSnapshot = {
          snapshotRunId: researchSnapshotRunId,
          snapshotAt: researchSnapshotAt,
          expiresAt: s2ExpiresAt,
          scope: "RESEARCH_ELIGIBLE_UNIVERSE",
          formulaVersion: FORMULA_VERSION,
          conditionId: rm.conditionId,
          selectedTokenId: rm.selectedTokenId,
          opposingTokenId: rm.opposingTokenId,
          eventSlug: rm.eventSlug || null,
          selectedOutcome: null,
          selectedPriceNum: rm.selectedPriceNum,
          selectedEuropeanOddsNum: europeanOdds,
          marketFamily: rm.leagueName ?? rm.marketFamily,
          league: rm.leagueName ?? rm.marketFamily,
          gameStartIso: rm.eventStartIso,
          dataCoverageNum: null,
          productRejectionReasons: ["research-s2-direct"],
          diagnostics: {
            conditionId: rm.conditionId,
            selectedTokenId: rm.selectedTokenId,
            selectedOutcome: "",
            currentPrice: rm.selectedPriceNum,
            price1hAgo: null,
            price6hAgo: null,
            delta1hPp: null,
            delta6hPp: null,
            spread: null,
            openInterest: null,
            recentTradeCash: null,
            maxTradeCash: null,
            selectedTradeCount: null,
            totalTradeCount: null,
            holderConcentrationScore: null,
            dataCoverage: 0,
            formulaUsed: "research-s2-direct",
            rejectionReasons: ["research-s2-direct"],
            gameStartIso: rm.eventStartIso,
            researchContext: {
              v: "v1",
              signalPhaseAtSnapshot: "prematch",
              marketCloseIso: null,
              marketType: rm.sportsMarketType ?? null,
              marketSubtype: rm.sportsMarketType?.includes("_") ? rm.sportsMarketType : null,
              familySource: rm.familySource ?? "unknown",
              taxonomyVersion: "v1-dimension-fix",
              discoverySourceProxy: null,
              gameTimeConfidence: null,
            },
            // Explainability: S2 markets are not enriched; no formula score available.
            // All codes below are truthful for this path — enrichMarket() was not called.
            formulaScore: null,
            productRejectionReasonDetails: [
              { code: "RESEARCH_S2_DIRECT", detail: "Market found via S2 wide research universe scan, not via the enrichment-then-product-gate path." },
              { code: "S2_NOT_ENRICHED", detail: "enrichMarket() was not called; no trade data, holder concentration, or directional flow was computed for this snapshot." },
              { code: "SCORE_UNAVAILABLE", detail: "formulaScore is null because scorePolymarket() was not executed in this path." },
              { code: "FORMULA_AUDIT_UNAVAILABLE", detail: "No formulaAudit object exists; sub-scores (smartMoney, pubWhale, preEvent) were not computed." },
              { code: "PRODUCT_GATE_NOT_EVALUATED", detail: "Score, dataCoverage, timingWindow, and duplicate gates were not evaluated; product eligibility is unknown for this snapshot." },
            ],
          } as LandingCardDiagnostics,
          publicFeedExposed: isPublicExposed,
          eventId: rm.eventId || null,
          formulaFeatureVersion: "modeling-features-v1",
          hoursUntilStartNum: Math.round(hoursUntilStart * 100) / 100,
          signalPhaseAtSnapshot: "prematch",
          oddsBandLabel: null,
          opposingPriceNum: rm.opposingPriceNum,
        };
        researchSnapshots.push(s2Snap);
        alreadyCapturedKeys.add(rmKey);
      }

      // Persist S2 selection diagnostics on the research funnel
      rf.researchSnapshotsSelected = selectedResearch.length;
      rf.researchSnapshotsSelectedPublic = publicExposed.length;
      rf.researchSnapshotsSelectedRotating = selectedHidden.length;
      rf.researchSnapshotSelectionLimit = researchLimit;
      rf.researchUniverseEvents = s2ResearchUniverseEventCount;
      rf.researchUniverseMarkets = dedupedUniverse.length;
    }

    return {
      generatedAt: new Date().toISOString(),
      source: "polymarket",
      formulaVersion: FORMULA_VERSION,
      pairs: allocatedFinal.pairs,
      ...(includeUpcoming ? { upcomingPairs: allocatedFinal.upcomingPairs } : {}),
      rejected: finalRejected,
      filters: { limit, category, minDataCoverage, excludeEnded },
      inspected: {
        eventsCount,
        marketsCount,
        candidatesAfterCategoryFilter,
        candidatesAfterEndedFilter,
        candidatesAfterDataCoverageFilter,
        pairsGenerated,
        ...(sportsDiscoveryCounts !== null ? {
          sportsDiscovery: {
            counts: sportsDiscoveryCounts,
            rejectionReasonCounts: sportsRejectionReasonCounts,
            sampleToCandidateMarketNulls: sportsSampleToNullCount,
            fallback48hNullDrops: sportsFallback48hNullDrops,
          },
        } : {}),
      } as unknown as import("./types").InspectedMetadata,
      ...(collectResearchSnapshots ? { researchSnapshots, researchFunnel: rf } : {}),
    };
  } catch (error) {
    // Only return error field for unexpected runtime failures
    console.error("buildLandingCards failed:", error);

    return {
      generatedAt: new Date().toISOString(),
      source: "polymarket",
      formulaVersion: FORMULA_VERSION,
      pairs: [],
      rejected: [{
        rejectionReasons: [
          "Unexpected runtime error during feed generation",
          String(error),
        ],
      }],
      error: "Unexpected runtime error - check rejection reasons for details",
      filters: { limit, category, minDataCoverage, excludeEnded },
      inspected: {
        eventsCount,
        marketsCount,
        candidatesAfterCategoryFilter,
        candidatesAfterEndedFilter,
        candidatesAfterDataCoverageFilter,
        pairsGenerated,
        ...(sportsDiscoveryCounts !== null ? {
          sportsDiscovery: {
            counts: sportsDiscoveryCounts,
            rejectionReasonCounts: sportsRejectionReasonCounts,
            sampleToCandidateMarketNulls: sportsSampleToNullCount,
            fallback48hNullDrops: sportsFallback48hNullDrops,
          },
        } : {}),
      } as unknown as import("./types").InspectedMetadata,
      ...(collectResearchSnapshots ? { researchSnapshots, researchFunnel: rf } : {}),
    };
  }
}
