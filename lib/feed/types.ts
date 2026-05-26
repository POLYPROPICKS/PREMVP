// TrustedInitialformulaLanding1.1 — API-lite feed types
// NOTE: This is a display-grade deterministic signal generator, NOT a real predictive ML model.
// The "winProbability" field name is preserved for UI compatibility but represents a displaySignalScore.

export const FORMULA_VERSION = "trusted-initial-formula-v1.1" as const;

// PREMVP12 approved types for evidence stack
export type MarketSourceCardType = "market-source" | "news-pulse" | "market-momentum" | "sharp-flow";
export type MarketSourceVisualType = "chart" | "news-image" | "team-crests" | "avatar";
export type LegacyMarketSourceVisualType = "shark-avatar" | "event-icon" | "news-icon";

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
  polymarketUrl?: string;
  // Odds-calibrated display fields (v2-lite-growth-safe)
  actionLabel?: string;       // "ENTER" | "SMALL" | "WATCH"
  oddsBandLabel?: string;     // e.g. "Longshot Value"
  rawSignalScore?: number;    // pre-odds-cap score for audit
  displaySignalConfidence?: number; // same as winProbability after cap
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
  type?: "market-source" | "news-pulse" | "market-momentum" | "sharp-flow";
  visualType?: "chart" | "news-image" | "team-crests" | "avatar" | "shark-avatar" | "event-icon" | "news-icon";
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
  signalStatus?: "qualified" | "upcoming_candidate";
  gameStartIso?: string | null;
  metricDedupeAdjusted?: boolean;
  metricDedupeReason?: string;
  rawMetricVector?: number[];
  adjustedMetricVector?: number[];
  formulaAudit?: {
    v: string;
    oddsFit: number;
    smartMoneyVal: number;
    pubWhaleVal: number;
    preEventVal: number;
    signalV2Raw: number;
    signalCap: number;
    noTradeData: boolean;
    finalSignalV2: number;
    selectedOdds: number;
    // Odds-calibrated display fields
    rawSignalBeforeOddsCap?: number;
    displaySignalConfidence?: number;
    oddsBandMin?: number;
    oddsBandMax?: number;
    oddsBandLabel?: string;
    calibratedSignalCap?: number;
    oddsBandCapApplied?: boolean;
    action?: string;
    confidenceMode?: string;
  };
}

export interface LandingCardPair {
  id: string;
  premiumSignal: PremiumSignal;
  marketSource: MarketSource;
  marketSources?: MarketSourceEvidenceCard[];
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
  upcomingPairs?: LandingCardPair[];
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

// ============================================================================
// Sports Discovery Types (Phase 3.6B)
// ============================================================================

export interface SportsMarketCandidate {
  id: string;
  slug: string;
  question: string;
  conditionId?: string;
  active: boolean;
  closed: boolean;
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
}

export interface GameGroup {
  groupKey: string;
  markets: SportsMarketCandidate[];
  gameId?: string;
  nestedEventId?: string;
  teamAID?: string;
  teamBID?: string;
  resolvedGameTimeIso: string | null;
  gameTimeSource: string;
  gameTimeConfidence: "high" | "medium" | "low" | "none";
  eventVolumeUsd: number;
  highestVolumeMarket: SportsMarketCandidate | null;
  primaryMarket: SportsMarketCandidate | null;
}

export interface SportsDiscoveryConfig {
  windowHours: number;
  fallbackWindowHours: number;
  fetchVolumeMinUsd: number;
  finalEventVolumeMinUsd: number;
  targetCards: number;
  platform: string;
  network: string;
  formulaVersion: string;
}

export interface SportsDiscoveryCounts {
  rawMarketsFetched: number;
  normalizedMarkets: number;
  activeMarkets: number;
  closedRejected: number;
  withGameId: number;
  withSportsMarketType: number;
  withTeamIds: number;
  withGameStartTime: number;
  withEventStartTime: number;
  withNestedEventStartTime: number;
  strongGameSignalCandidates: number;
  mediumGameSignalCandidates: number;
  futuresRejected: number;
  groupedGames: number;
  within24hGroups: number;
  within48hGroups: number;
  volumeEligibleGroups: number;
  finalPairs: number;
}

export interface SportsDiscoverySample {
  title: string;
  slug: string;
  gameId?: string;
  sportsMarketType?: string;
  eventVolumeUsd: number;
  resolvedGameTimeIso: string | null;
  gameTimeSource: string;
  gameTimeConfidence: "high" | "medium" | "low" | "none";
  marketCount: number;
  strategy: string;
  rejectionReason?: string;
  primaryMarketRaw?: {
    outcomes: string[];
    outcomePrices: number[];
    clobTokenIds: string[];
    question: string;
    sportsMarketType?: string;
    gameId?: string;
    conditionId?: string;
    volumeNum?: number | null;
    volume24hr?: number | null;
    volumeClob?: number | null;
    oneDayPriceChange?: number | null;
  } | null;
  marketsRaw?: Array<{
    outcomes: string[];
    outcomePrices: number[];
    clobTokenIds: string[];
    question: string;
    sportsMarketType?: string;
    conditionId?: string;
    volumeNum?: number | null;
    volume24hr?: number | null;
    volumeClob?: number | null;
    oneDayPriceChange?: number | null;
  }>;
  leagueName?: string;
  polymarketEventSlug?: string;
  teamALogo?: string | null;
  teamBLogo?: string | null;
  teamAName?: string | null;
  teamBName?: string | null;
  eventImage?: string | null;
}

export interface MarketSourceEvidenceCard {
  id: string;
  sourceLabel: string;
  platform: string;
  network: string;
  timeAgo: string;
  headline: string;
  subline: string;
  delta: string;
  type?: MarketSourceCardType;
  visualType?: MarketSourceVisualType | LegacyMarketSourceVisualType;
}

export interface SportsDiscoveryResult {
  generatedAt: string;
  config: SportsDiscoveryConfig;
  counts: SportsDiscoveryCounts;
  rejectionReasonCounts: Record<string, number>;
  acceptedSamples: SportsDiscoverySample[];
  rejectedSamples: SportsDiscoverySample[];
  warnings: string[];
  finalCandidates: SportsDiscoverySample[];
  fallback48hCandidates: SportsDiscoverySample[];
  extendedWc2026Candidates?: SportsDiscoverySample[];
  extendedEsportsCandidates?: SportsDiscoverySample[];
  extendedNbaCandidates?: SportsDiscoverySample[];
  extendedNhlCandidates?: SportsDiscoverySample[];
  diagnosis?: string;
  recommendedPath?: string;
}
