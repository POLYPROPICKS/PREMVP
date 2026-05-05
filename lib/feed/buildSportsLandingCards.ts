// Isolated sports card mapper for Phase 3.6B-2A
// Converts discoverSportsMarkets finalCandidates to UI-compatible PremiumSignal + MarketSource pairs

import { discoverSportsMarkets } from "./discoverSportsMarkets";
import type { SportsDiscoverySample } from "./types";

// Local diagnostics type for debug route
interface SportsCardDiagnostics {
  conditionId?: string;
  selectedOutcome: string;
  eventVolumeUsd: number;
  resolvedGameTimeIso: string | null;
  gameTimeSource: string;
  gameTimeConfidence: "high" | "medium" | "low" | "none";
  sportsMarketType?: string;
  marketCount: number;
  profit: number;
  winProbability: number;
  price: number;
  selectedPrice: number;
  priceSource: string;
  outcomeCount: number;
  priceCount: number;
}

// TrustMetric-like interface for metrics
interface TrustMetric {
  id: string;
  label: string;
  value: string | number;
  bar?: number;
  icon: string;
}

// PremiumSignal shape matching UI
interface PremiumSignal {
  id: string;
  league: string;
  time: string;
  eventTitle: string;
  confidenceLabel: string;
  position: string;
  profit: string;
  winProbability: number;
  price: string;
  ctaLabel: string;
  metrics: TrustMetric[];
}

// MarketSource shape matching UI
interface MarketSource {
  id: string;
  sourceLabel: string;
  platform: string;
  network: string;
  timeAgo: string;
  headline: string;
  subline: string;
  delta: string;
}

// Pair interface
interface SportsCardPair {
  premiumSignal: PremiumSignal;
  marketSource: MarketSource;
  diagnostics: SportsCardDiagnostics;
}

// Response interface for debug route
interface SportsCardsResponse {
  generatedAt: string;
  source: "polymarket";
  formulaVersion: "trusted-initial-formula-v1.1";
  feedStatus: "ok" | "partial" | "manual_fallback_required";
  pairs: SportsCardPair[];
  counts: Record<string, number>;
  warnings: string[];
}

// Helper to format compact money
function compactMoney(amount: number): string {
  if (amount >= 1000000) {
    return `${(amount / 1000000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `${(amount / 1000).toFixed(0)}K`;
  }
  return amount.toFixed(0);
}

// Helper to format game time
function formatGameTime(isoString: string | null): string {
  if (!isoString) return "Upcoming";
  
  try {
    const date = new Date(isoString);
    const now = new Date();
    const hoursUntil = Math.round((date.getTime() - now.getTime()) / (1000 * 60 * 60));
    
    if (hoursUntil < 0) return "Started";
    if (hoursUntil <= 1) return "Starting soon";
    if (hoursUntil < 24) return `In ${hoursUntil}h`;
    
    return date.toLocaleDateString("en-US", { 
      month: "short", 
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return "Upcoming";
  }
}

// Infer league from question/title
function inferLeague(text: string): string {
  const textLC = text.toLowerCase();
  
  const leagues: Record<string, string[]> = {
    "NBA": ["nba", "basketball", "lakers", "celtics", "warriors", "knicks"],
    "NFL": ["nfl", "football", "chiefs", "eagles", "ravens", "49ers"],
    "MLB": ["mlb", "baseball", "dodgers", "yankees", "red sox"],
    "NHL": ["nhl", "hockey", "bruins", "rangers", "blackhawks", "maple leafs"],
    "UFC": ["ufc", "mma", "fighting"],
    "Tennis": ["tennis", "atp", "wta", "wimbledon", "us open", "french open"],
    "Soccer": ["premier league", "epl", "laliga", "serie a", "bundesliga", "champions league"],
    "F1": ["formula 1", "f1", "grand prix"],
    "Golf": ["pga", "lpga", "masters", "golf"],
    "WNBA": ["wnba"],
  };
  
  for (const [league, keywords] of Object.entries(leagues)) {
    if (keywords.some(kw => textLC.includes(kw))) {
      return league;
    }
  }
  
  return "Sports Market";
}

// Select best outcome with valid profit (35–350) using real outcome prices
function selectOutcomeForCard(
  candidate: SportsDiscoverySample
): { position: string; price: number; profit: number; winProbability: number } | null {
  const marketTypeText = String(candidate.sportsMarketType || "").toLowerCase();
  const title = String(candidate.title || "").trim();

  // P0: spread/totals need special wording. Do not publish unreadable Yes/No cards yet.
  if (marketTypeText.includes("total") || marketTypeText.includes("spread")) {
    return null;
  }

  // Try to get raw market data from multiple sources
  const rawMarket = candidate.primaryMarketRaw;
  
  if (!rawMarket) {
    console.warn(`[selectOutcomeForCard] No raw market data for candidate: ${title}`);
    return null;
  }

  // Parse outcomes and prices safely
  const outcomes = safeParseArray(rawMarket.outcomes).map(cleanText);
  const rawPrices = safeParseArray(rawMarket.outcomePrices).map(toNumber);
  const clobTokenIds = safeParseArray(rawMarket.clobTokenIds).map(cleanText);

  if (outcomes.length === 0 || rawPrices.length === 0) {
    console.warn(`[selectOutcomeForCard] Missing outcomes or prices for candidate: ${title}`);
    return null;
  }

  if (outcomes.length !== rawPrices.length) {
    console.warn(`[selectOutcomeForCard] Outcomes/prices length mismatch for candidate: ${title}`);
    return null;
  }

  // Filter valid prices (0 < price < 1)
  const validIndices: Array<{ index: number; outcome: string; price: number; profit: number }> = [];
  
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const price = rawPrices[i];
    
    if (!outcome || !price || price <= 0 || price >= 1) continue;
    
    const profit = Math.round(((1 / price) - 1) * 100);
    
    if (profit >= 35 && profit <= 350) {
      validIndices.push({ index: i, outcome, price, profit });
    }
  }

  if (validIndices.length === 0) {
    console.warn(`[selectOutcomeForCard] No valid outcomes with profit 35-350 for candidate: ${title}`);
    return null;
  }

  // Sort by preference: moneyline/winner outcomes first, then by price closest to 0.50
  validIndices.sort((a, b) => {
    const aOutcome = a.outcome.toLowerCase();
    const bOutcome = b.outcome.toLowerCase();
    
    // Prefer moneyline/winner outcomes
    const aIsPreferred = aOutcome === "yes" || aOutcome.includes("winner") || aOutcome.includes("moneyline");
    const bIsPreferred = bOutcome === "yes" || bOutcome.includes("winner") || bOutcome.includes("moneyline");
    
    if (aIsPreferred && !bIsPreferred) return -1;
    if (!aIsPreferred && bIsPreferred) return 1;
    
    // Then prefer price closer to 0.50
    const aDistance = Math.abs(a.price - 0.50);
    const bDistance = Math.abs(b.price - 0.50);
    return aDistance - bDistance;
  });

  const selected = validIndices[0];
  let position = selected.outcome;

  // Handle "Yes" outcomes by extracting team name from question
  if (position.toLowerCase() === "yes") {
    const extractedTeam = extractYesPositionFromQuestion(rawMarket.question || title);
    if (extractedTeam) {
      position = extractedTeam;
    } else {
      // Try to extract from "Team A vs Team B" pattern
      if (/\s+vs\.?\s+/i.test(title)) {
        position = title.split(/\s+vs\.?\s+/i)[0].trim();
      } else {
        console.warn(`[selectOutcomeForCard] Cannot extract readable position from Yes outcome: ${title}`);
        return null;
      }
    }
  }

  // Reject "No" outcomes for P0
  if (position.toLowerCase() === "no") {
    console.warn(`[selectOutcomeForCard] Rejecting No outcome for P0: ${title}`);
    return null;
  }

  // Final validation of position
  if (!position || /^(yes|no)$/i.test(position) || position.length < 2) {
    console.warn(`[selectOutcomeForCard] Invalid position: ${position} for candidate: ${title}`);
    return null;
  }

  // Calculate winProbability based on selected price and volume
  const volumeScore = Math.min(12, Math.log10(Math.max(1, candidate.eventVolumeUsd || 1)) * 2);
  const winProbability = clamp(Math.round(52 + (1 - selected.price) * 25 + volumeScore), 52, 89);

  console.log(`[selectOutcomeForCard] Selected outcome: ${position} at price ${selected.price} (${selected.profit}% profit) for ${title}`);

  return {
    position,
    price: selected.price,
    profit: selected.profit,
    winProbability,
  };
}

// Build card pair from sports discovery candidate
function buildCardFromDiscoveryCandidate(
  candidate: SportsDiscoverySample,
  index: number
): SportsCardPair | null {
  const outcomeSelection = selectOutcomeForCard(candidate);
  
  if (!outcomeSelection) {
    return null;
  }
  
  const { position, price, profit, winProbability } = outcomeSelection;
  
  // Validation
  if (!candidate.title || candidate.title.trim() === "") {
    return null;
  }
  
  if (candidate.eventVolumeUsd < 100000) {
    return null;
  }
  
  if (!candidate.resolvedGameTimeIso) {
    return null;
  }
  
  // Check for futures keywords
  const futuresKeywords = ["champion", "championship", "cup winner", "2027", "2028", "2029", "election", "president", "mvp", "crypto", "geopolitics"];
  const titleLC = candidate.title.toLowerCase();
  if (futuresKeywords.some(kw => titleLC.includes(kw))) {
    return null;
  }
  
  const cleanedTitle = candidate.title.replace(/\?\s*$/g, "").replace(/[""']+$/g, "").trim();
  const league = inferLeague(candidate.title);
  const timeStr = formatGameTime(candidate.resolvedGameTimeIso);
  
  // Determine confidence label
  let confidenceLabel: string;
  if (winProbability >= 75) {
    confidenceLabel = "HIGH CONFIDENCE";
  } else if (winProbability >= 65) {
    confidenceLabel = "STRONG SIGNAL";
  } else {
    confidenceLabel = "LIVE SIGNAL";
  }
  
  // Build premium signal
  const premiumSignal: PremiumSignal = {
    id: `sports-${index}-${Date.now()}`,
    league,
    time: timeStr,
    eventTitle: cleanedTitle,
    confidenceLabel,
    position,
    profit: `${profit}%`,
    winProbability,
    price: `${Math.round(price * 100)}¢`,
    ctaLabel: "Unlock Premium Insights",
    metrics: [
      {
        id: "pre-event-score",
        label: "Pre‑Event Score AI",
        value: Math.round(Math.max(55, Math.min(90, winProbability + 7))),
        bar: winProbability,
        icon: "/icons/trust-ai-score.png"
      },
      {
        id: "smart-money",
        label: "Smart Money",
        value: Math.round(Math.max(50, Math.min(88, winProbability + 3))),
        bar: winProbability,
        icon: "/icons/trust-smart-money.png"
      },
      {
        id: "public-whale",
        label: "Public vs Whale Money",
        value: Math.round(Math.max(50, Math.min(82, 50 + winProbability / 4))),
        bar: winProbability,
        icon: "/icons/trust-public-whale.png"
      }
    ],
  };
  
  // Build market source
  const marketSource: MarketSource = {
    id: `market-${index}-${Date.now()}`,
    sourceLabel: "Market Source",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo: "Live market",
    headline: `$${compactMoney(candidate.eventVolumeUsd)} market volume`,
    subline: `${position} priced at ${Math.round(price * 100)}¢`,
    delta: "+0%", // No price history yet
  };
  
  // Build diagnostics
  const rawMarket = candidate.primaryMarketRaw;
  const diagnostics: SportsCardDiagnostics = {
    conditionId: candidate.gameId || rawMarket?.conditionId || `cond-${index}`,
    selectedOutcome: position,
    eventVolumeUsd: candidate.eventVolumeUsd,
    resolvedGameTimeIso: candidate.resolvedGameTimeIso,
    gameTimeSource: candidate.gameTimeSource,
    gameTimeConfidence: candidate.gameTimeConfidence,
    sportsMarketType: candidate.sportsMarketType,
    marketCount: candidate.marketCount,
    profit,
    winProbability,
    price,
    selectedPrice: price,
    priceSource: "gammaOutcomePrices",
    outcomeCount: rawMarket?.outcomes?.length || 0,
    priceCount: rawMarket?.outcomePrices?.length || 0,
  };
  
  return {
    premiumSignal,
    marketSource,
    diagnostics,
  };
}

// Safe parsing helpers
function safeParseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      // Try comma-separated
      return value.split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

function cleanText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return value.toString();
  return "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function extractYesPositionFromQuestion(question: string): string | null {
  const willWinMatch = question.match(/^Will\s+(.+?)\s+win\s+on\s+/i);
  if (willWinMatch && willWinMatch[1]) {
    return willWinMatch[1].trim();
  }
  return null;
}

// Main function to build sports landing cards
export async function buildSportsLandingCards(options?: {
  limit?: number;
}): Promise<SportsCardsResponse> {
  const limit = Math.max(1, Math.min(10, options?.limit ?? 5));
  
  console.log(`[buildSportsLandingCards] Starting with limit=${limit}`);
  
  // Run markets-first discovery
  const discoveryResult = await discoverSportsMarkets({
    windowHours: 24,
    fallbackWindowHours: 48,
    fetchVolumeMinUsd: 50000,
    finalEventVolumeMinUsd: 100000,
    targetCards: limit,
  });
  
  const pairs: SportsCardPair[] = [];
  const warnings: string[] = [...discoveryResult.warnings];
  
  // Process final candidates
  for (let i = 0; i < discoveryResult.finalCandidates.length; i++) {
    const candidate = discoveryResult.finalCandidates[i];
    
    const pair = buildCardFromDiscoveryCandidate(candidate, i);
    
    if (pair) {
      // Validate metrics shape
      if (pair.premiumSignal.metrics.length !== 3) {
        warnings.push(`Invalid metrics count for candidate ${i}`);
        continue;
      }
      
      // Validate all metrics have required fields
      const validMetrics = pair.premiumSignal.metrics.every(m => 
        m.id && m.label && m.value !== undefined && m.icon
      );
      
      if (!validMetrics) {
        warnings.push(`Invalid metric structure for candidate ${i}`);
        continue;
      }
      
      pairs.push(pair);
    } else {
      warnings.push(`Failed to build card for candidate ${i}`);
    }
  }
  
  // Determine feed status
  let feedStatus: "ok" | "partial" | "manual_fallback_required";
  if (pairs.length >= 4) {
    feedStatus = "ok";
  } else if (pairs.length >= 2) {
    feedStatus = "partial";
  } else {
    feedStatus = "manual_fallback_required";
  }
  
  console.log(`[buildSportsLandingCards] Generated ${pairs.length} pairs, ${warnings.length} warnings`);
  console.log(`[buildSportsLandingCards] Feed status: ${feedStatus}`);
  
  return {
    generatedAt: discoveryResult.generatedAt,
    source: "polymarket",
    formulaVersion: "trusted-initial-formula-v1.1",
    feedStatus,
    pairs,
    counts: discoveryResult.counts as unknown as Record<string, number>,
    warnings,
  };
}
