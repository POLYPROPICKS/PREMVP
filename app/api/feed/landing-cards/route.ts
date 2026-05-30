// GET /api/feed/landing-cards?limit=4
// TrustedInitialformulaLanding1.1 — API-lite feed
// NOTE: This is a display-grade deterministic signal generator, NOT real predictive ML.

import { NextRequest, NextResponse } from "next/server";
import { buildLandingCards } from "@/lib/feed/buildLandingCards";
import { readLatestGeneratedSignalPairs } from "@/lib/feed/cacheGeneratedSignals";
import {
  FORMULA_VERSION,
  LandingCardDiagnostics,
  LandingCardPair,
  LandingCardsResponse,
  MarketSource,
  MarketSourceEvidenceCard,
  PremiumSignal,
} from "@/lib/feed/types";
import { premiumSignals as staticPremiumSignals } from "@/content/signals";
import { marketSources as staticMarketSources } from "@/content/marketSources";

function orderLivePairsForResponse<T extends {
  premiumSignal?: { eventTitle?: string };
  diagnostics?: {
    gameStartIso?: string | null;
    parentEventVolume24hr?: number | null;
  };
}>(pairs: T[]): T[] {
  const now = Date.now();
  const horizon = now + 24 * 60 * 60 * 1000;

  const indexed = pairs.map((pair, index) => ({ pair, index }));

  const primaryMarketRank = (pair: T) => {
    const title = String(pair.premiumSignal?.eventTitle ?? "").toLowerCase();
    if (title.includes("match winner") || title.includes("moneyline")) return 0;
    if (title.includes("spread") || title.includes("handicap")) return 1;
    return 2;
  };

  indexed.sort((a, b) => {
    const aStart = Date.parse(String(a.pair.diagnostics?.gameStartIso ?? ""));
    const bStart = Date.parse(String(b.pair.diagnostics?.gameStartIso ?? ""));

    const aWithin24h =
      Number.isFinite(aStart) && aStart > now && aStart <= horizon;
    const bWithin24h =
      Number.isFinite(bStart) && bStart > now && bStart <= horizon;

    if (aWithin24h !== bWithin24h) return aWithin24h ? -1 : 1;

    if (aWithin24h && bWithin24h) {
      const aVolume = Number(a.pair.diagnostics?.parentEventVolume24hr ?? 0);
      const bVolume = Number(b.pair.diagnostics?.parentEventVolume24hr ?? 0);

      if (aVolume !== bVolume) return bVolume - aVolume;

      const rankDiff = primaryMarketRank(a.pair) - primaryMarketRank(b.pair);
      if (rankDiff !== 0) return rankDiff;
    }

    return a.index - b.index;
  });

  let ordered = indexed.map(({ pair }) => pair);

  // CEO emergency safety pin. Auto-expires shortly after kickoff.
  const PSG_PIN_UNTIL = Date.parse("2026-05-30T16:15:00Z");

  if (Date.now() < PSG_PIN_UNTIL) {
    const psgIndex = ordered.findIndex((pair) => {
      const title = String(pair.premiumSignal?.eventTitle ?? "").toLowerCase();
      return (
        title.includes("paris saint-germain") &&
        title.includes("match winner")
      );
    });

    if (psgIndex > 0) {
      ordered = [
        ordered[psgIndex],
        ...ordered.slice(0, psgIndex),
        ...ordered.slice(psgIndex + 1),
      ];
    }
  }

  return ordered;
}

type CacheStatus = "hit" | "miss" | "error" | "fallback_static";

type RawPairLike = Partial<LandingCardPair> & {
  id?: string;
  premiumSignal?: PremiumSignal;
  marketSource?: MarketSource;
  marketSources?: MarketSourceEvidenceCard[];
  diagnostics?: LandingCardDiagnostics;
};

function clampNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDeltaPp(delta: unknown): number {
  const text = String(delta ?? "").trim();
  if (!text) return 0;
  const parsed = Number(text.replace("%", "").replace("+", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDelta(delta: unknown): string {
  const value = parseDeltaPp(delta);
  if (Math.abs(value) < 0.01) return "0%";
  return `${value > 0 ? "+" : ""}${Math.round(value)}%`;
}

function extractPriceCents(source: MarketSource): number | null {
  const candidates = [source.subline, source.headline, source.delta].join(" ");
  const match = candidates.match(/(\d+(?:\.\d+)?)\s*¢/);
  if (!match) return null;
  const cents = Number(match[1]);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function makeMomentumEvidence(baseId: string, marketSource: MarketSource, diagnostics?: LandingCardDiagnostics): MarketSourceEvidenceCard {
  const delta = normalizeDelta(marketSource.delta || diagnostics?.delta6hPp || diagnostics?.delta1hPp || 0);
  const currentPrice = typeof diagnostics?.currentPrice === "number" ? diagnostics.currentPrice : null;
  const cents = currentPrice && currentPrice > 0 ? Math.round(currentPrice * 100) : extractPriceCents(marketSource);
  const impliedOdds = cents && cents > 0 ? (100 / cents).toFixed(2) : null;
  const hasMovement = delta !== "0%";

  return {
    id: `${baseId}-market-momentum`,
    sourceLabel: "Market Momentum",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo: marketSource.timeAgo || "Live market",
    headline: hasMovement ? `Odds moved ${delta}` : "Odds holding",
    subline: hasMovement
      ? `Market repricing detected: ${delta}`
      : impliedOdds && cents
        ? `Implied odds from ${cents}¢ price: ≈ ${impliedOdds}x`
        : "No repricing detected",
    delta,
    type: "market-momentum",
    visualType: "team-crests",
  };
}

function makeSharpFlowEvidence(baseId: string, marketSource: MarketSource, diagnostics?: LandingCardDiagnostics): MarketSourceEvidenceCard | null {
  const maxTradeCash = diagnostics?.maxTradeCash ?? null;
  if (maxTradeCash === null || maxTradeCash < 1000) return null;

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

  return {
    id: `${baseId}-sharp-flow`,
    sourceLabel: "Sharp Flow",
    platform: "Polymarket",
    network: "Polygon",
    timeAgo: marketSource.timeAgo || "Live market",
    headline,
    subline,
    delta: normalizeDelta(marketSource.delta || diagnostics?.delta6hPp || diagnostics?.delta1hPp || 0),
    type: "sharp-flow",
    visualType: "avatar",
  };
}

function compactMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

function ensureMarketSourceType(marketSource: MarketSource): MarketSourceEvidenceCard {
  return {
    ...marketSource,
    type: "market-source",
    visualType: "chart",
  };
}

function buildCanonicalMarketSources(pair: RawPairLike): MarketSourceEvidenceCard[] {
  if (!pair.marketSource) return [];

  const baseId = pair.marketSource.id?.replace(/-market-source$/, "") || pair.id || pair.marketSource.id || "market";
  const primary = ensureMarketSourceType(pair.marketSource);
  const existing = Array.isArray(pair.marketSources) ? pair.marketSources : [];

  const byType = new Map<string, MarketSourceEvidenceCard>();
  byType.set("market-source", primary);

  for (const card of existing) {
    if (!card || !card.id) continue;
    const type = card.type || "market-source";
    if (type === "market-source") {
      byType.set("market-source", ensureMarketSourceType({ ...pair.marketSource, ...card } as MarketSource));
      continue;
    }
    if (type === "sharp-flow" || type === "market-momentum") {
      byType.set(type, card);
    }
  }

  const realSharpFlow = makeSharpFlowEvidence(baseId, pair.marketSource, pair.diagnostics);
  if (realSharpFlow && !byType.has("sharp-flow")) {
    byType.set("sharp-flow", realSharpFlow);
  }

  if (!byType.has("market-momentum")) {
    byType.set("market-momentum", makeMomentumEvidence(baseId, pair.marketSource, pair.diagnostics));
  }

  const ordered = [byType.get("market-source"), byType.get("sharp-flow"), byType.get("market-momentum")]
    .filter((card): card is MarketSourceEvidenceCard => Boolean(card));

  return ordered.filter((card, index, cards) => cards.findIndex((c) => c.id === card.id) === index);
}

function makeFallbackDiagnostics(signal: PremiumSignal, marketSource: MarketSource): LandingCardDiagnostics {
  const priceCents = extractPriceCents(marketSource);
  const price = priceCents ? priceCents / 100 : null;

  return {
    conditionId: null,
    selectedTokenId: null,
    selectedOutcome: signal.position,
    currentPrice: price,
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
    dataCoverage: 40,
    formulaUsed: `${FORMULA_VERSION}-route-fallback`,
    rejectionReasons: ["route_static_fallback"],
  };
}

function canonicalizePair(rawPair: RawPairLike, index: number): LandingCardPair | null {
  if (!rawPair?.premiumSignal || !rawPair?.marketSource) return null;

  const diagnostics = rawPair.diagnostics ?? makeFallbackDiagnostics(rawPair.premiumSignal, rawPair.marketSource);
  const marketSources = buildCanonicalMarketSources({ ...rawPair, diagnostics });
  if (marketSources.length < 2) return null;

  return {
    id: rawPair.id || `${rawPair.premiumSignal.id}-${rawPair.marketSource.id}-${index}`,
    premiumSignal: rawPair.premiumSignal,
    marketSource: marketSources[0],
    marketSources,
    diagnostics,
  };
}

function canonicalizePairs(rawPairs: RawPairLike[], limit: number): LandingCardPair[] {
  const pairs: LandingCardPair[] = [];
  const seenIds = new Set<string>();

  for (const rawPair of rawPairs) {
    if (pairs.length >= limit) break;
    const pair = canonicalizePair(rawPair, pairs.length);
    if (!pair || seenIds.has(pair.id)) continue;
    seenIds.add(pair.id);
    pairs.push(pair);
  }

  return pairs;
}

function buildStaticFallbackPairs(limit: number): LandingCardPair[] {
  const rawPairs: RawPairLike[] = staticPremiumSignals.flatMap((signal, index) => {
    const marketSource = staticMarketSources[index] ?? staticMarketSources[0];
    if (!marketSource) return [];
    return [{
      id: `static-fallback-${index}`,
      premiumSignal: signal as PremiumSignal,
      marketSource: marketSource as MarketSource,
      diagnostics: makeFallbackDiagnostics(signal as PremiumSignal, marketSource as MarketSource),
    }];
  });

  return canonicalizePairs(rawPairs, limit);
}

function buildResponse(
  pairs: LandingCardPair[],
  limit: number,
  category: string,
  minDataCoverage: number,
  excludeEnded: boolean,
  cacheStatus: CacheStatus,
  rejected: LandingCardsResponse["rejected"] = [],
  inspected?: LandingCardsResponse["inspected"],
  cacheBypassed = false,
  cacheBypassReason?: string,
  upcomingPairs?: LandingCardPair[],
) {
  return {
    generatedAt: new Date().toISOString(),
    source: "polymarket" as const,
    formulaVersion: FORMULA_VERSION,
    pairs,
    ...(upcomingPairs !== undefined ? { upcomingPairs } : {}),
    rejected,
    filters: { limit, category, minDataCoverage, excludeEnded },
    inspected: inspected ?? {
      eventsCount: 0,
      marketsCount: 0,
      candidatesAfterCategoryFilter: pairs.length,
      candidatesAfterEndedFilter: pairs.length,
      candidatesAfterDataCoverageFilter: pairs.length,
      pairsGenerated: pairs.length,
    },
    cacheStatus,
    cacheBypassed,
    ...(cacheBypassReason ? { cacheBypassReason } : {}),
  };
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    const limitParam = searchParams.get("limit");
    let limit = 4;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed)) {
        limit = Math.max(1, Math.min(15, parsed));
      }
    }

    const category = searchParams.get("category") || "sports";

    const minDataCoverageParam = searchParams.get("minDataCoverage");
    let minDataCoverage = 40;
    if (minDataCoverageParam) {
      const parsed = parseInt(minDataCoverageParam, 10);
      if (!isNaN(parsed)) {
        minDataCoverage = Math.max(0, Math.min(100, parsed));
      }
    }

    const excludeEndedParam = searchParams.get("excludeEnded");
    const excludeEnded = excludeEndedParam !== "false";

    const includeUpcoming = searchParams.get("includeUpcoming") === "true";
    const emptyUpcoming: LandingCardPair[] = [];

    try {
      const cachedPairs = await readLatestGeneratedSignalPairs(limit);
      const allCachedPairs = canonicalizePairs(cachedPairs, limit);
      const canonicalCachedPairs = includeUpcoming
        ? allCachedPairs
        : allCachedPairs.filter(
            (p) => p.diagnostics?.signalStatus !== "upcoming_candidate"
          );
      if (canonicalCachedPairs.length > 0) {
        const orderedCachedPairs = orderLivePairsForResponse(canonicalCachedPairs).slice(0, limit);
        return NextResponse.json(
          buildResponse(orderedCachedPairs, limit, category, minDataCoverage, excludeEnded, "hit",
            undefined, undefined, false, undefined,
            includeUpcoming ? emptyUpcoming : undefined),
          { status: 200 }
        );
      }
    } catch (cacheError) {
      console.error("[landing-cards] Cache read failed; falling back to live generation:", cacheError);
    }

    const generated = await buildLandingCards({
      limit,
      category,
      minDataCoverage,
      excludeEnded,
      ...(includeUpcoming ? { includeUpcoming: true, upcomingLimit: 5 } : {}),
    });

    const canonicalGeneratedPairs = canonicalizePairs(generated.pairs, limit);
    if (canonicalGeneratedPairs.length > 0) {
      const orderedGeneratedPairs = orderLivePairsForResponse(canonicalGeneratedPairs).slice(0, limit);
      return NextResponse.json(
        buildResponse(
          orderedGeneratedPairs,
          limit,
          category,
          minDataCoverage,
          excludeEnded,
          "miss",
          generated.rejected,
          generated.inspected,
          false,
          undefined,
          includeUpcoming ? (generated.upcomingPairs ?? emptyUpcoming) : undefined,
        ),
        { status: 200 }
      );
    }

    const fallbackPairs = buildStaticFallbackPairs(limit);
    return NextResponse.json(
      buildResponse(
        fallbackPairs,
        limit,
        category,
        minDataCoverage,
        excludeEnded,
        "fallback_static",
        generated.rejected,
        generated.inspected,
        false,
        "empty_generated_pairs",
        includeUpcoming ? (generated.upcomingPairs ?? emptyUpcoming) : undefined,
      ),
      { status: 200 }
    );
  } catch (error) {
    console.error("API route /api/feed/landing-cards failed:", error);

    const fallbackPairs = buildStaticFallbackPairs(4);
    return NextResponse.json(
      buildResponse(fallbackPairs, 4, "sports", 40, true, "error", [{
        rejectionReasons: ["route_runtime_error", String(error)],
      }]),
      { status: 200 }
    );
  }
}
