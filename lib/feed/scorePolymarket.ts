// TrustedInitialformulaLanding1.1 — Deterministic scoring utilities
// NOTE: These are display-grade proxy formulas, NOT real predictive ML or calibrated probabilities.

import { FORMULA_VERSION } from "./types";

/**
 * Clamp value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round number to nearest integer
 */
export function roundNumber(value: number): number {
  return Math.round(value);
}

/**
 * Normalize weighted score components to 0-100 scale
 */
export function normalizeWeightedScore(
  components: Array<{ value: number | null; weight: number }>
): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const component of components) {
    if (component.value !== null && !isNaN(component.value)) {
      weightedSum += clamp(component.value, 0, 100) * component.weight;
      totalWeight += component.weight;
    }
  }

  if (totalWeight === 0) return 50; // neutral fallback

  return roundNumber(weightedSum / totalWeight);
}

/**
 * Safely extract number from any value
 */
export function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return isNaN(value) ? null : value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Safely extract string from any value
 */
export function safeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * Compact money value for display (e.g., 13000 -> "13K")
 */
export function compactMoney(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(0)}K`;
  }
  return `${value}`;
}

/**
 * Format timestamp as time ago string
 */
export function formatTimeAgo(timestamp: string | number | Date): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins === 1) return "1 min ago";
  if (diffMins < 60) return `${diffMins} min ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

/**
 * Format delta in percentage points with + sign
 */
export function formatDeltaPp(value: number): string {
  const rounded = roundNumber(value);
  if (Math.abs(rounded) === 0) {
    return "0%";
  }

  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}%`;
}

/**
 * Format game start time for display (e.g. "In 3h", "In 2 days")
 */
export function formatGameTime(startDate: string | null | undefined): string {
  if (!startDate) return "Live";

  const start = new Date(startDate);
  const now = new Date();
  const diffMs = start.getTime() - now.getTime();

  if (diffMs < 0) return "Live";

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays >= 2) return `In ${diffDays} days`;
  if (diffHours >= 1) return `In ${diffHours}h`;
  if (diffMins >= 1) return `In ${diffMins}m`;
  return "Starting soon";
}

/**
 * Format end time for display
 */
export function formatEndTime(endDate: string | undefined): string {
  if (!endDate) return "Live";

  const end = new Date(endDate);
  const now = new Date();
  const diffMs = end.getTime() - now.getTime();

  if (diffMs < 0) return "Ended";

  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays > 30) return `${Math.floor(diffDays / 30)} months`;
  if (diffDays > 1) return `${diffDays} days`;
  if (diffHours > 1) return `${diffHours} hours`;
  return "Ending soon";
}

/**
 * Create URL-friendly slug
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// =============================================================================
// TRUSTED INITIAL FORMULA V1.1 — DISPLAY SIGNAL SCORES (NOT REAL WIN PROBABILITY)
// =============================================================================

/**
 * Compute side action score for position selection
 * Weights: impliedProbability 35%, momentum 25%, tradeFlow 15%, liquidity 10%, spread 10%, openInterest 5%
 */
export function computeSideActionScore(params: {
  impliedProbabilityScore: number | null;
  momentumScore: number | null;
  tradeFlowScore: number | null;
  liquidityDepthScore: number | null;
  spreadQualityScore: number | null;
  openInterestScore: number | null;
}): number {
  const components = [
    { value: params.impliedProbabilityScore, weight: 0.35 },
    { value: params.momentumScore, weight: 0.25 },
    { value: params.tradeFlowScore, weight: 0.15 },
    { value: params.liquidityDepthScore, weight: 0.10 },
    { value: params.spreadQualityScore, weight: 0.10 },
    { value: params.openInterestScore, weight: 0.05 },
  ];

  return normalizeWeightedScore(components);
}

/**
 * Compute potential profit percentage for display
 * NOTE: This is (1/currentPrice - 1) * 100, representing potential return if resolved at $1.
 * This is NOT expected profit or expected value.
 */
export function computePotentialProfitPercent(currentPrice: number): number {
  if (!currentPrice || currentPrice <= 0 || currentPrice >= 1) return 0;
  return roundNumber(((1 / currentPrice) - 1) * 100);
}

/**
 * Compute delta in percentage points
 * Falls back: 6h -> 1h -> 0
 */
export function computeDeltaPp(params: {
  currentPrice: number;
  price6hAgo: number | null;
  price1hAgo: number | null;
}): { deltaPp: number; deltaSource: "6h" | "1h" | "none" } {
  const { currentPrice, price6hAgo, price1hAgo } = params;

  if (price6hAgo !== null && price6hAgo > 0) {
    return {
      deltaPp: roundNumber((currentPrice - price6hAgo) * 100),
      deltaSource: "6h",
    };
  }

  if (price1hAgo !== null && price1hAgo > 0) {
    return {
      deltaPp: roundNumber((currentPrice - price1hAgo) * 100),
      deltaSource: "1h",
    };
  }

  return { deltaPp: 0, deltaSource: "none" };
}

/**
 * Compute Smart Money proxy score
 * With holders: 40% largeTrade + 35% holderConc + 15% liquidity + 10% OI
 * Without holders: 55% largeTrade + 25% liquidity + 20% OI
 * Without trades: 60% liquidity + 40% OI
 */
export function computeSmartMoneyProxy(params: {
  largeTradePressureScore: number | null;
  holderConcentrationScore: number | null;
  liquidityDepthScore: number | null;
  openInterestScore: number | null;
}): number {
  const { largeTradePressureScore, holderConcentrationScore, liquidityDepthScore, openInterestScore } = params;

  // Full formula with all components
  if (largeTradePressureScore !== null && holderConcentrationScore !== null) {
    return normalizeWeightedScore([
      { value: largeTradePressureScore, weight: 0.40 },
      { value: holderConcentrationScore, weight: 0.35 },
      { value: liquidityDepthScore, weight: 0.15 },
      { value: openInterestScore, weight: 0.10 },
    ]);
  }

  // Without holders
  if (largeTradePressureScore !== null) {
    return normalizeWeightedScore([
      { value: largeTradePressureScore, weight: 0.55 },
      { value: liquidityDepthScore, weight: 0.25 },
      { value: openInterestScore, weight: 0.20 },
    ]);
  }

  // Without trades (fallback)
  return normalizeWeightedScore([
    { value: liquidityDepthScore, weight: 0.60 },
    { value: openInterestScore, weight: 0.40 },
  ]);
}

/**
 * Compute Public vs Whale Money proxy score
 * Based on trade count share vs money share disparity
 */
export function computePublicVsWhaleProxy(params: {
  selectedTradeCount: number | null;
  totalTradeCount: number | null;
  selectedTradeCashVolume: number | null;
  totalTradeCashVolume: number | null;
}): number {
  const { selectedTradeCount, totalTradeCount, selectedTradeCashVolume, totalTradeCashVolume } = params;

  // Need at least counts to compute
  if (selectedTradeCount === null || totalTradeCount === null || totalTradeCount === 0) {
    return 50; // neutral
  }

  const publicShare = selectedTradeCount / totalTradeCount;

  // If we have volume data, use it; otherwise estimate from counts
  let moneyShare: number;
  if (selectedTradeCashVolume !== null && totalTradeCashVolume !== null && totalTradeCashVolume > 0) {
    moneyShare = selectedTradeCashVolume / totalTradeCashVolume;
  } else {
    moneyShare = publicShare; // assume proportional if no volume data
  }

  // Calculate disparity: positive means whale-heavy, negative means retail-heavy
  const disparity = (moneyShare - publicShare) * 100;

  // Center at 50, clamp to 0-100
  return clamp(50 + disparity, 0, 100);
}

/**
 * Compute PreEventScore AI (market quality score, NOT AI prediction)
 */
export function computePreEventScoreAI(params: {
  momentumScore: number | null;
  liquidityDepthScore: number | null;
  spreadQualityScore: number | null;
  openInterestScore: number | null;
  recencyScore: number | null;
}): number {
  return normalizeWeightedScore([
    { value: params.momentumScore, weight: 0.30 },
    { value: params.liquidityDepthScore, weight: 0.25 },
    { value: params.spreadQualityScore, weight: 0.20 },
    { value: params.openInterestScore, weight: 0.15 },
    { value: params.recencyScore, weight: 0.10 },
  ]);
}

/**
 * Compute Display Signal Score (UI winProbability field)
 * With holders: 25% marketProb + 20% momentum + 20% tradeFlow + 15% holders + 10% liquidity + 10% spread
 * Without holders: 30% marketProb + 25% momentum + 20% tradeFlow + 15% liquidity + 10% spread
 * NOTE: This is clamped to 52-89 for UI consistency, NOT a real probability.
 */
export function computeDisplaySignalScore(params: {
  marketImpliedProbabilityScore: number | null;
  momentumScore: number | null;
  tradeFlowScore: number | null;
  holderConcentrationScore: number | null;
  liquidityDepthScore: number | null;
  spreadQualityScore: number | null;
}): number {
  const { marketImpliedProbabilityScore, momentumScore, tradeFlowScore, holderConcentrationScore, liquidityDepthScore, spreadQualityScore } = params;

  let score: number;

  if (holderConcentrationScore !== null) {
    score = normalizeWeightedScore([
      { value: marketImpliedProbabilityScore, weight: 0.25 },
      { value: momentumScore, weight: 0.20 },
      { value: tradeFlowScore, weight: 0.20 },
      { value: holderConcentrationScore, weight: 0.15 },
      { value: liquidityDepthScore, weight: 0.10 },
      { value: spreadQualityScore, weight: 0.10 },
    ]);
  } else {
    const impliedProb = clamp(marketImpliedProbabilityScore ?? 50, 0, 100);
    const momentumAdj = ((momentumScore ?? 50) - 50) * 0.10;
    score = clamp(35 + impliedProb * 0.65 + momentumAdj, 35, 97);
  }

  // Clamp to 35-97 for full range display
  return clamp(score, 35, 97);
}

/**
 * Get confidence label based on display signal score
 */
export function getConfidenceLabel(score: number): string {
  if (score >= 75) return "HIGH CONFIDENCE";
  if (score >= 65) return "STRONG SIGNAL";
  return "LIVE SIGNAL";
}
