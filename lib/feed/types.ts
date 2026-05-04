// TrustedInitialformulaLanding1.1 — API-lite feed types
// NOTE: This is a display-grade deterministic signal generator, NOT a real predictive ML model.
// The "winProbability" field name is preserved for UI compatibility but represents a displaySignalScore.

export const FORMULA_VERSION = "trusted-initial-formula-v1.1" as const;

export interface TrustMetric {
  id: string;
  label: string;
  value: number;
  bar: number;
  icon: string;
}

export interface PremiumSignal {
  id: string;
  league: string;
  time: string;
  eventTitle: string;
  confidenceLabel: string;
  position: string;
  profit: string;
  winProbability: number; // NOTE: displaySignalScore for UI compatibility, NOT real win probability
  price: string;
  ctaLabel: string;
  metrics: TrustMetric[];
}

export interface MarketSource {
  id: string;
  sourceLabel: string;
  platform: string;
  network: string;
  timeAgo: string;
  headline: string;
  subline: string;
  delta: string;
  type?: "sharp-flow" | "market-momentum" | "news-pulse";
  visualType?: "chart" | "shark-avatar" | "event-icon" | "news-icon";
}

export interface LandingCardDiagnostics {
  conditionId: string | null;
  selectedTokenId: string | null;
  selectedOutcome: string;
  currentPrice: number | null;
  price1hAgo: number | null;
  price6hAgo: number | null;
  delta1hPp: number | null;
  delta6hPp: number | null;
  spread: number | null;
  openInterest: number | null;
  recentTradeCash: number | null;
  maxTradeCash: number | null;
  selectedTradeCount: number | null;
  totalTradeCount: number | null;
  holderConcentrationScore: number | null;
  dataCoverage: number;
  formulaUsed: string;
  rejectionReasons: string[];
}

export interface LandingCardPair {
  id: string;
  premiumSignal: PremiumSignal;
  marketSource: MarketSource;
  diagnostics: LandingCardDiagnostics;
}

export interface FilterParams {
  limit: number;
  category: string;
  minDataCoverage: number;
  excludeEnded: boolean;
}

export interface InspectedMetadata {
  eventsCount: number;
  marketsCount: number;
  candidatesAfterCategoryFilter: number;
  candidatesAfterEndedFilter: number;
  candidatesAfterDataCoverageFilter: number;
  pairsGenerated: number;
}

export interface LandingCardsResponse {
  generatedAt: string;
  source: "polymarket";
  formulaVersion: typeof FORMULA_VERSION;
  pairs: LandingCardPair[];
  rejected: Array<{ id?: string; rejectionReasons: string[] }>;
  error?: string;
  filters?: FilterParams;
  inspected?: InspectedMetadata;
}

// Polymarket API raw types
export interface PolymarketRawOutcome {
  id: string;
  name: string;
  price?: number;
  probability?: number;
}

export interface PolymarketRawMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  category?: string;
  endDate?: string;
  outcomes?: PolymarketRawOutcome[] | string; // Can be JSON string
  outcomePrices?: Record<string, number> | string; // Can be JSON string
  tokenIds?: Record<string, string> | string; // Can be JSON string
  clobTokenIds?: string[] | string; // Gamma API specific field
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  spread?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
  description?: string;
  icon?: string;
  lastTradePrice?: number;
}

export interface PolymarketRawEvent {
  id: string;
  title: string;
  slug: string;
  description?: string;
  category?: string;
  endDate?: string;
  endDateIso?: string;
  endTime?: string;
  active: boolean;
  closed: boolean;
  markets: PolymarketRawMarket[];
  volume24hr?: number;
  liquidity?: number;
  tags?: string[]; // Event tags for filtering
  groupTitle?: string; // Group title for categorization
  groupItemTitle?: string; // Item title within group
}

export interface PolymarketPricePoint {
  timestamp: string;
  price: number;
}

export interface PolymarketTrade {
  id: string;
  timestamp: string;
  price: number;
  size: number;
  side: string;
  tokenId?: string;
}

export interface PolymarketHolder {
  address: string;
  balance: number;
  value: number;
}
