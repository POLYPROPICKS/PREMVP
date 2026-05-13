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
  computeSmartMoneyProxy,
  computePublicVsWhaleProxy,
  computePreEventScoreAI,
  computeDisplaySignalScore,
  getConfidenceLabel,
} from "./scorePolymarket";

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
  };

  (market as unknown as Record<string, unknown>)._parentMeta = {
    title: sample.title,
    slug: sample.slug,
    category: "sports",
    endDate: sample.resolvedGameTimeIso || undefined,
    startDate: sample.resolvedGameTimeIso || undefined,
    polymarketEventSlug: sample.polymarketEventSlug || undefined,
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

  // Prefer outcomes with price between 0.2 and 0.8 (not too extreme)
  const balancedOutcomes = validOutcomes.filter(
    (o) => o.price > 0.2 && o.price < 0.8 && ((1 / o.price) - 1) * 100 >= 15
  );

  if (balancedOutcomes.length > 0) {
    // Select the one closest to 0.5 (most balanced)
    return balancedOutcomes.sort((a, b) =>
      Math.abs(a.price - 0.5) - Math.abs(b.price - 0.5)
    )[0];
  }

  // Fallback: select highest price outcome (most "Yes" biased)
  return validOutcomes.sort((a, b) => b.price - a.price)[0];
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
  const { parentMeta, market, selectedOutcome, diagnostics, gammaPriceChange } = enriched;

  // Compute component scores (0-100 scale)
  const marketImpliedProbabilityScore = clamp(roundNumber(selectedOutcome.price * 100), 0, 100);

  // Momentum score from delta (if available)
  let momentumScore = 50; // neutral
  if (diagnostics.delta6hPp !== null) {
    momentumScore = clamp(50 + diagnostics.delta6hPp, 0, 100);
  } else if (diagnostics.delta1hPp !== null) {
    momentumScore = clamp(50 + diagnostics.delta1hPp * 2, 0, 100); // amplify 1h signal
  } else if (gammaPriceChange !== null) {
    // Use Gamma price change as fallback
    momentumScore = clamp(50 + roundNumber(gammaPriceChange * 100), 0, 100);
  }

  // Trade flow score from recent activity (fallback to neutral if missing)
  let tradeFlowScore = 50; // neutral
  if (diagnostics.recentTradeCash !== null && diagnostics.recentTradeCash > 0) {
    // Higher trade volume = higher score (logarithmic scale)
    const logVolume = Math.log10(Math.max(diagnostics.recentTradeCash, 1));
    tradeFlowScore = clamp(roundNumber((logVolume / 6) * 100), 0, 100);
  }

  // Liquidity depth score from spread (inverse - tighter spread = higher score)
  let liquidityDepthScore = 50;
  if (diagnostics.spread !== null) {
    // Spread in percentage points, tighter is better
    liquidityDepthScore = clamp(100 - diagnostics.spread * 2, 0, 100);
  }

  // Spread quality score (same as liquidity for now)
  const spreadQualityScore = liquidityDepthScore;

  // Open interest score
  let openInterestScore = 50;
  if (diagnostics.openInterest !== null && diagnostics.openInterest > 0) {
    const logOI = Math.log10(Math.max(diagnostics.openInterest, 1));
    openInterestScore = clamp(roundNumber((logOI / 8) * 100), 0, 100);
  }

  // Large trade pressure score from max trade (fallback to neutral)
  let largeTradePressureScore = 50;
  if (diagnostics.maxTradeCash !== null && diagnostics.maxTradeCash > 0) {
    const logMax = Math.log10(Math.max(diagnostics.maxTradeCash, 1));
    largeTradePressureScore = clamp(roundNumber((logMax / 5) * 100), 0, 100);
  }

  // Holder concentration score (already computed, fallback to neutral)
  const holderConcentrationScore = diagnostics.holderConcentrationScore ?? 50;

  // Recency score (assume recent if we have data)
  const recencyScore = 80; // default to recent

  // Compute display signal score (UI winProbability) - uses fallbacks
  const displaySignalScore = computeDisplaySignalScore({
    marketImpliedProbabilityScore,
    momentumScore,
    tradeFlowScore,
    holderConcentrationScore,
    liquidityDepthScore,
    spreadQualityScore,
  });

  const isMiddleConfidenceFallbackMarket = isMiddleConfidenceSportsFallbackMarket(enriched.event, market);
  const finalDisplaySignalScore = isMiddleConfidenceFallbackMarket
    ? clamp(displaySignalScore, 45, 65)
    : displaySignalScore;

  // Compute metrics with fallbacks
  const smartMoneyProxy = computeSmartMoneyProxy({
    largeTradePressureScore,
    holderConcentrationScore,
    liquidityDepthScore,
    openInterestScore,
  });

  const publicVsWhaleProxy = computePublicVsWhaleProxy({
    selectedTradeCount: diagnostics.selectedTradeCount,
    totalTradeCount: diagnostics.totalTradeCount,
    selectedTradeCashVolume: diagnostics.recentTradeCash,
    totalTradeCashVolume: diagnostics.recentTradeCash, // Use same if we don't have total
  });

  const preEventScoreAI = computePreEventScoreAI({
    momentumScore,
    liquidityDepthScore,
    spreadQualityScore,
    openInterestScore,
    recencyScore,
  });

  // Build trust metrics
  const metrics: TrustMetric[] = [
    {
      id: "smart-money",
      label: "Smart Money",
      value: roundNumber(smartMoneyProxy),
      bar: roundNumber(smartMoneyProxy),
      icon: "/icons/trust-smart-money.png",
    },
    {
      id: "public-vs-whale",
      label: "Public vs Whale Money",
      value: roundNumber(publicVsWhaleProxy),
      bar: roundNumber(publicVsWhaleProxy),
      icon: "/icons/trust-public-whale.png",
    },
    {
      id: "pre-event-score",
      label: "PreEventScore AI",
      value: roundNumber(preEventScoreAI),
      bar: roundNumber(preEventScoreAI),
      icon: "/icons/trust-ai-score.png",
    },
  ];

  const finalMetrics = isMiddleConfidenceFallbackMarket
    ? metrics.map(metric => ({
        ...metric,
        value: Math.min(metric.value, 65),
        bar: Math.min(metric.bar, 65),
      }))
    : metrics;

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

  // Build premium signal
  const premiumSignal: PremiumSignal = {
    id: pairId,
    league: parentMeta.category || "Prediction Market",
    time: parentMeta.startDate
      ? formatGameTime(parentMeta.startDate)
      : formatEndTime(parentMeta.endDate),
    eventTitle: truncateText(parentMeta.title || safeString(market.question) || "Unknown Event", 50),
    confidenceLabel: getConfidenceLabel(finalDisplaySignalScore),
    position: selectedOutcome.name,
    profit: profitStr,
    winProbability: finalDisplaySignalScore, // NOTE: displaySignalScore for UI, NOT real win probability
    price: "$1.99",
    ctaLabel: "Unlock Full Signal",
    metrics: finalMetrics,
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
 * Main function to build landing cards from Polymarket data
 *
 * Supports filtering by:
 * - category: sports-first filtering (sports | all)
 * - minDataCoverage: minimum data coverage threshold
 * - excludeEnded: exclude ended/closed markets
 */
export async function buildLandingCards(options?: {
  limit?: number;
  category?: string;
  minDataCoverage?: number;
  excludeEnded?: boolean;
}): Promise<LandingCardsResponse> {
  const limit = clamp(options?.limit ?? 4, 1, 10);
  const category = options?.category ?? "sports";
  const minDataCoverage = clamp(options?.minDataCoverage ?? 25, 0, 100);
  const excludeEnded = options?.excludeEnded ?? true;

  // Track inspected counts for diagnostics
  let eventsCount = 0;
  let marketsCount = 0;
  let candidatesAfterCategoryFilter = 0;
  let candidatesAfterEndedFilter = 0;
  let pairsGenerated = 0;
  let candidatesAfterDataCoverageFilter = 0;

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

      const discoverySamples = [
        ...discovery.finalCandidates,
        ...discovery.fallback48hCandidates,
      ].slice(0, limit * 3);

      candidates = discoverySamples
        .map(sampleToCandidateMarket)
        .filter((c): c is CandidateMarket => c !== null);

      eventsCount = discovery.counts.rawMarketsFetched;
      marketsCount = discovery.counts.normalizedMarkets;
      candidatesAfterCategoryFilter = candidates.length;
      candidatesAfterEndedFilter = candidates.length;

      if (candidates.length === 0) {
        return {
          generatedAt: new Date().toISOString(),
          source: "polymarket",
          formulaVersion: FORMULA_VERSION,
          pairs: [],
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
      const now = Date.now();
      const aTime = getGameTime(a);
      const bTime = getGameTime(b);
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

    // Process candidates until we have enough pairs
    for (const candidate of candidates) {
      if (pairs.length >= limit) break;

      // Skip if already has rejection reasons
      if (candidate.rejectionReasons.length > 0) {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: [...candidate.rejectionReasons],
        });
        continue;
      }

      // Enrich with API data (pass initial warnings)
      const enriched = await enrichMarket(candidate.event, candidate.market, candidate.warnings);

      if (!enriched) {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: ["Failed to select valid outcome"],
        });
        continue;
      }

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

      // Check if premiumSignal.time is "Ended" and exclude if needed
      if (excludeEnded && pair.premiumSignal.time === "Ended") {
        rejected.push({
          id: candidate.market.id,
          rejectionReasons: ["Market ended (premiumSignal.time = Ended)"],
        });
        continue;
      }

      const marketKey = safeString(candidate.market.id)
        || safeString(candidate.market.conditionId)
        || safeString(candidate.market.slug)
        || pair.id;

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

    return {
      generatedAt: new Date().toISOString(),
      source: "polymarket",
      formulaVersion: FORMULA_VERSION,
      pairs,
      rejected: finalRejected,
      filters: { limit, category, minDataCoverage, excludeEnded },
      inspected: {
        eventsCount,
        marketsCount,
        candidatesAfterCategoryFilter,
        candidatesAfterEndedFilter,
        candidatesAfterDataCoverageFilter,
        pairsGenerated,
      },
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
      },
    };
  }
}
