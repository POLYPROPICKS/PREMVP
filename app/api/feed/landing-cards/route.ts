// GET /api/feed/landing-cards?limit=4
// TrustedInitialformulaLanding1.1 — Debug route for API-lite feed
// NOTE: This is a display-grade deterministic signal generator, NOT real predictive ML.

import { NextRequest, NextResponse } from "next/server";
import { buildLandingCards } from "@/lib/feed/buildLandingCards";
import { FORMULA_VERSION } from "@/lib/feed/types";

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

    // Build landing cards with filters
    const response = await buildLandingCards({
      limit,
      category,
      minDataCoverage,
      excludeEnded,
    });

    return NextResponse.json(response, { status: 200 });
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
      },
      { status: 500 }
    );
  }
}
