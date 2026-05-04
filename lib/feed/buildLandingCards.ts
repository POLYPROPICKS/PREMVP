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
  type TrustMetric,
  type PolymarketRawEvent,
  type PolymarketRawMarket,
  type PolymarketPricePoint,
  type PolymarketTrade,
  type PolymarketHolder,
} from "./types";

import {
  fetchPolymarketActiveEvents,
  fetchPriceHistorySafe,
  fetchSpreadSafe,
  fetchOrderBookSafe,
  fetchTradesSafe,
  fetchHoldersSafe,
  fetchOpenInterestSafe,
} from "./polymarketClient";

import {
  safeNumber,
  safeString,
  compactMoney,
  formatTimeAgo,
  formatDeltaPp,
  formatEndTime,
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

interface CandidateMarket {
  event: PolymarketRawEvent;
  market: PolymarketRawMarket;
  rejectionReasons: string[];
  warnings: string[];
}

interface ParentEventMeta {
  title: string;
  slug: string;
  category?: string;
  endDate?: string;
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
 * Validate and flatten events into candidate markets
 * ONLY reject clearly invalid markets (closed, no outcomes, no prices)
 * Missing enrichment data (token IDs, trades, etc.) is a warning, not fatal
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

      // Attach parent metadata to market for later use
      (market as unknown as Record<string, unknown>)._parentMeta = parentMeta;

      candidates.push({ event, market, rejectionReasons, warnings });
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
  const balancedOutcomes = validOutcomes.filter((o) => o.price > 0.2 && o.price < 0.8);

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

  // Fetch spread (best effort - only if we have token ID)
  let spread: { min: number; max: number } | null = null;
  if (selectedOutcome.tokenId) {
    spread = await fetchSpreadSafe(selectedOutcome.tokenId);
  }
  if (spread) {
    diagnostics.spread = roundNumber((spread.max - spread.min) * 100);
  } else {
    warnings.push("Spread data unavailable");
  }

  // Fetch order book (best effort)
  const orderBook = selectedOutcome.tokenId
    ? await fetchOrderBookSafe(selectedOutcome.tokenId)
    : null;

  // Fetch trades (best effort)
  const trades = await fetchTradesSafe(market.id);

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
  const holders = await fetchHoldersSafe(market.id);

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

  // Fetch open interest (best effort)
  const openInterest = await fetchOpenInterestSafe(market.id);
  diagnostics.openInterest = openInterest;
  if (openInterest === null) {
    warnings.push("Open interest data unavailable");
  }

  // Calculate data coverage (0-100)
  let coveragePoints = 0;
  let totalPoints = 6;

  if (diagnostics.currentPrice !== null) coveragePoints++;
  if (diagnostics.price6hAgo !== null || diagnostics.delta6hPp !== null) coveragePoints++;
  if (diagnostics.spread !== null) coveragePoints++;
  if (diagnostics.recentTradeCash !== null) coveragePoints++;
  if (diagnostics.holderConcentrationScore !== null) coveragePoints++;
  if (diagnostics.openInterest !== null) coveragePoints++;

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

  // Generate profit string
  const profitPercent = computePotentialProfitPercent(selectedOutcome.price);
  const profitStr = `${profitPercent}%`;

  // Generate delta string for market source
  const deltaPp = diagnostics.delta6hPp ?? diagnostics.delta1hPp ?? 0;
  const deltaStr = formatDeltaPp(deltaPp);

  // Generate headline for market source using Gamma data as fallback
  const gammaVolume = safeParseNumber((market as unknown as Record<string, unknown>).volume);
  const gammaLiquidity = safeParseNumber((market as unknown as Record<string, unknown>).liquidity);

  let headline: string;
  if (diagnostics.maxTradeCash !== null && diagnostics.maxTradeCash >= 10000) {
    headline = `$${compactMoney(diagnostics.maxTradeCash)} whale entry`;
  } else if (diagnostics.maxTradeCash !== null && diagnostics.maxTradeCash >= 3000) {
    headline = `$${compactMoney(diagnostics.maxTradeCash)} sharp entry`;
  } else if (diagnostics.recentTradeCash !== null && diagnostics.recentTradeCash > 0) {
    headline = `$${compactMoney(diagnostics.recentTradeCash)} market flow`;
  } else if (gammaVolume !== null && gammaVolume > 0) {
    headline = `$${compactMoney(gammaVolume)} volume`;
  } else if (gammaLiquidity !== null && gammaLiquidity > 0) {
    headline = `$${compactMoney(gammaLiquidity)} liquidity`;
  } else {
    headline = "Live market flow";
  }

  // Generate subline for market source
  const subline = `${selectedOutcome.name} odds moved ${deltaStr}`;

  // Generate time ago (use "Live now" as fallback)
  const timeAgo = "Live now";

  // Build IDs using parent event metadata
  const baseId = slugify(parentMeta.slug || safeString(market.slug) || safeString(market.conditionId) || market.id);
  const pairId = `${baseId}-${slugify(selectedOutcome.name)}`;

  // Build premium signal
  const premiumSignal: PremiumSignal = {
    id: pairId,
    league: parentMeta.category || "Prediction Market",
    time: formatEndTime(parentMeta.endDate),
    eventTitle: truncateText(parentMeta.title || safeString(market.question) || "Unknown Event", 50),
    confidenceLabel: getConfidenceLabel(displaySignalScore),
    position: selectedOutcome.name,
    profit: profitStr,
    winProbability: displaySignalScore, // NOTE: displaySignalScore for UI, NOT real win probability
    price: "$1.99",
    ctaLabel: "Unlock Full Signal",
    metrics,
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
    type: "sharp-flow",
    visualType: "chart",
  };

  return {
    id: pairId,
    premiumSignal,
    marketSource,
    diagnostics,
  };
}

/**
 * Truncate text to max length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text || "";
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Main function to build landing cards from Polymarket data
 */
export async function buildLandingCards(options?: {
  limit?: number;
}): Promise<LandingCardsResponse> {
  const limit = clamp(options?.limit ?? 4, 1, 10);

  try {
    // Fetch active events
    const events = await fetchPolymarketActiveEvents({ limit: 20 });

    // Detailed diagnostics for debugging
    const debugInfo = {
      eventsCount: events.length,
      responseType: Array.isArray(events) ? "array" : typeof events,
      firstEventSample: events.length > 0 ? {
        hasTitle: !!events[0].title,
        hasMarkets: Array.isArray(events[0].markets),
        marketsCount: events[0].markets?.length,
      } : null,
    };

    if (events.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        source: "polymarket",
        formulaVersion: FORMULA_VERSION,
        pairs: [],
        rejected: [{
          rejectionReasons: [
            "No active events found",
            `Response type: ${debugInfo.responseType}`,
          ],
        }],
      };
    }

    // Extract candidate markets
    const candidates = extractCandidateMarkets(events);

    const pairs: LandingCardPair[] = [];
    const rejected: Array<{ id?: string; rejectionReasons: string[] }> = [];

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

      pairs.push(pair);
    }

    return {
      generatedAt: new Date().toISOString(),
      source: "polymarket",
      formulaVersion: FORMULA_VERSION,
      pairs,
      rejected,
    };
  } catch (error) {
    console.error("buildLandingCards failed:", error);

    return {
      generatedAt: new Date().toISOString(),
      source: "polymarket",
      formulaVersion: FORMULA_VERSION,
      pairs: [],
      rejected: [],
      error: "Failed to generate landing cards",
    };
  }
}
