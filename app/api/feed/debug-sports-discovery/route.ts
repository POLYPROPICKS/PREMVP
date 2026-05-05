// Debug API route for markets-first sports discovery
// Phase 3.6B — GET /api/feed/debug-sports-discovery?windowHours=24&minVolume=100000

import { NextRequest } from "next/server";
import { discoverSportsMarkets } from "@/lib/feed/discoverSportsMarkets";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Parse query params
    const windowHours = parseInt(searchParams.get("windowHours") || "24", 10);
    const fallbackWindowHours = parseInt(searchParams.get("fallbackWindowHours") || "48", 10);
    const minVolume = parseInt(searchParams.get("minVolume") || "100000", 10);
    const targetCards = parseInt(searchParams.get("targetCards") || "5", 10);

    // Validate params
    if (isNaN(windowHours) || windowHours < 1 || windowHours > 168) {
      return Response.json(
        { error: "Invalid windowHours. Must be between 1 and 168." },
        { status: 400 }
      );
    }

    if (isNaN(minVolume) || minVolume < 0) {
      return Response.json(
        { error: "Invalid minVolume. Must be a positive number." },
        { status: 400 }
      );
    }

    // Run discovery
    const result = await discoverSportsMarkets({
      windowHours,
      fallbackWindowHours,
      finalEventVolumeMinUsd: minVolume,
      targetCards,
    });

    return Response.json(result, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    console.error("Debug sports discovery error:", error);
    return Response.json(
      {
        error: "Discovery failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
