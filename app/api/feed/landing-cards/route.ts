// GET /api/feed/landing-cards?limit=4
// TrustedInitialformulaLanding1.1 — Debug route for API-lite feed
// NOTE: This is a display-grade deterministic signal generator, NOT real predictive ML.

import { NextRequest, NextResponse } from "next/server";
import { buildLandingCards } from "@/lib/feed/buildLandingCards";
import { FORMULA_VERSION } from "@/lib/feed/types";

export async function GET(request: NextRequest) {
  try {
    // Parse limit from query params
    const searchParams = request.nextUrl.searchParams;
    const limitParam = searchParams.get("limit");

    // Clamp limit between 1 and 10
    let limit = 4;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed)) {
        limit = Math.max(1, Math.min(10, parsed));
      }
    }

    // Build landing cards
    const response = await buildLandingCards({ limit });

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
