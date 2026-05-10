// GET /api/feed/landing-cards?limit=4
// TrustedInitialformulaLanding1.1 — Debug route for API-lite feed
// NOTE: This is a display-grade deterministic signal generator, NOT real predictive ML.

import { NextRequest, NextResponse } from "next/server";
import { buildLandingCards } from "@/lib/feed/buildLandingCards";
import { readLatestGeneratedSignalPairs } from "@/lib/feed/cacheGeneratedSignals";
import { normalizeLandingPairEvidenceStack } from "@/lib/feed/landingPairs";
import { FORMULA_VERSION, LandingCardsResponse, LandingCardPair } from "@/lib/feed/types";

export async function GET(request: NextRequest) {
  try {
    // Parse query params
    const searchParams = request.nextUrl.searchParams;

    // Clamp limit between 1 and 10 (default 4)
    const limitParam = searchParams.get("limit");
    let limit = 4;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed)) {
        limit = Math.max(1, Math.min(10, parsed));
      }
    }

    // Category filter (default sports)
    const category = searchParams.get("category") || "sports";

    // Min data coverage (default 40, clamp 0-100)
    const minDataCoverageParam = searchParams.get("minDataCoverage");
    let minDataCoverage = 40;
    if (minDataCoverageParam) {
      const parsed = parseInt(minDataCoverageParam, 10);
      if (!isNaN(parsed)) {
        minDataCoverage = Math.max(0, Math.min(100, parsed));
      }
    }

    // Exclude ended markets (default true)
    const excludeEndedParam = searchParams.get("excludeEnded");
    const excludeEnded = excludeEndedParam !== "false";

    // Try cache first
    let cacheStatus: "hit" | "miss" | "error" = "miss";
    let response: LandingCardsResponse;

    try {
      const cachedPairs = await readLatestGeneratedSignalPairs(limit);
      if (cachedPairs.length > 0) {
        // Cache hit - return cached pairs
        cacheStatus = "hit";
        response = {
          generatedAt: new Date().toISOString(),
          source: "polymarket",
          formulaVersion: FORMULA_VERSION,
          pairs: cachedPairs.map((cp) => {
            const pair = normalizeLandingPairEvidenceStack({
              id: cp.id || `${cp.premiumSignal.id}-${cp.marketSource.id}`,
              premiumSignal: cp.premiumSignal,
              marketSource: cp.marketSource,
              marketSources: cp.marketSources,
              filterTags: [],
              isDefaultToday: false,
              priority: 0,
              sortScore: 0,
              volumeUsd: 0,
              source: 'api',
            });

            return {
              id: pair.id,
              premiumSignal: pair.premiumSignal,
              marketSource: pair.marketSource,
              marketSources: pair.marketSources,
              diagnostics: cp.diagnostics,
            };
          }),
          rejected: [], // Cached pairs don't include rejection data
          filters: { limit, category, minDataCoverage, excludeEnded },
          inspected: {
            eventsCount: 0,
            marketsCount: 0,
            candidatesAfterCategoryFilter: cachedPairs.length,
            candidatesAfterEndedFilter: cachedPairs.length,
            candidatesAfterDataCoverageFilter: cachedPairs.length,
            pairsGenerated: cachedPairs.length,
          },
        };
        console.log(`[landing-cards] Cache hit: ${cachedPairs.length} pairs`);
      } else {
        // Cache miss - fall back to live generation
        cacheStatus = "miss";
        console.log("[landing-cards] Cache miss - falling back to live generation");
        response = await buildLandingCards({
          limit,
          category,
          minDataCoverage,
          excludeEnded,
        });
      }
    } catch (cacheError) {
      // Cache read error - fall back to live generation
      cacheStatus = "error";
      console.error("[landing-cards] Cache read failed:", cacheError);
      response = await buildLandingCards({
        limit,
        category,
        minDataCoverage,
        excludeEnded,
      });
    }

    // Add cache status to response
    const responseWithCache = {
      ...response,
      cacheStatus,
    };

    return NextResponse.json(responseWithCache, { status: 200 });
  } catch (error) {
    console.error("API route /api/feed/landing-cards failed:", error);

    // Return controlled 500 error
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        source: "polymarket",
        formulaVersion: FORMULA_VERSION,
        pairs: [],
        rejected: [],
        error: "Failed to generate landing cards",
        cacheStatus: "error",
      },
      { status: 500 }
    );
  }
}
