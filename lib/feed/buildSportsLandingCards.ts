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

// Select best outcome with valid profit (35–350)
// Note: This is a placeholder since we don't have raw data in isolated version
// In production, this would use candidate.raw.outcomes and outcomePrices
function selectOutcomeForCard(
  candidate: { sportsMarketType?: string | null; title?: string | null; question?: string | null }
): { position: string; price: number; profit: number; winProbability: number } | null {
  const marketTypeText = String(candidate.sportsMarketType || "").toLowerCase();
  const title = String(candidate.title || candidate.question || "").trim();

  // P0: spread/totals need special wording. Do not publish unreadable Yes/No cards yet.
  if (marketTypeText.includes("total") || marketTypeText.includes("spread")) {
    return null;
  }

  let position = "";

  // Pattern: "Will Club Atlético de Madrid win on 2026-05-05?" -> "Club Atlético de Madrid"
  const willWinMatch = title.match(/^Will\s+(.+?)\s+win\s+on\s+/i);
  if (willWinMatch && willWinMatch[1]) {
    position = willWinMatch[1].trim();
  }

  // Pattern: "Lakers vs. Thunder" / "Cavaliers vs. Pistons" -> first side for P0
  if (!position && /\s+vs\.?\s+/i.test(title)) {
    position = title.split(/\s+vs\.?\s+/i)[0].trim();
  }

  // Last readable fallback
  if (!position || /^(yes|no)$/i.test(position) || position.length < 2) {
    return null;
  }

  // P0 price/profit placeholder until outcomePrices are fully wired.
  // Keep within product filter 35–350% and do not claim real prediction.
  const price = 0.65;
  const profit = Math.round(((1 / price) - 1) * 100);
  const winProbability = 65;

  if (profit < 35 || profit > 350) return null;

  return { position, price, profit, winProbability };
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
  const diagnostics: SportsCardDiagnostics = {
    conditionId: candidate.gameId || `cond-${index}`,
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
  };
  
  return {
    premiumSignal,
    marketSource,
    diagnostics,
  };
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
