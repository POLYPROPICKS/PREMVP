// GET /api/feed/debug-sports-cards?limit=5
// Phase 3.6B-2A — Isolated sports card mapper debug route

import { NextRequest, NextResponse } from "next/server";
import { buildSportsLandingCards } from "@/lib/feed/buildSportsLandingCards";

export async function GET(request: NextRequest) {
  try {
    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 5;

    // Validate limit
    if (isNaN(limit) || limit < 1 || limit > 10) {
      return NextResponse.json(
        { error: "Invalid limit parameter. Must be between 1 and 10." },
        { status: 400 }
      );
    }

    console.log(`[debug-sports-cards] Request received with limit=${limit}`);

    // Build sports landing cards
    const result = await buildSportsLandingCards({ limit });

    console.log(`[debug-sports-cards] Generated ${result.pairs.length} pairs`);
    console.log(`[debug-sports-cards] Feed status: ${result.feedStatus}`);

    // Return response
    return NextResponse.json(result, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });

  } catch (error) {
    console.error("[debug-sports-cards] Error:", error);
    
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    
    return NextResponse.json(
      { 
        error: "Internal server error",
        details: errorMessage,
        generatedAt: new Date().toISOString(),
        source: "polymarket",
        formulaVersion: "trusted-initial-formula-v1.1",
        feedStatus: "manual_fallback_required" as const,
        pairs: [],
        counts: {},
        warnings: [errorMessage]
      },
      { status: 500 }
    );
  }
}
