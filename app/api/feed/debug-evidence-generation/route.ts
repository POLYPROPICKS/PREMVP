import { NextResponse } from "next/server";

import { buildLandingCards } from "@/lib/feed/buildLandingCards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Debug endpoint disabled in production" },
      { status: 404 }
    );
  }

  const { searchParams } = new URL(request.url);

  const rawLimit = Number(searchParams.get("limit") ?? "3");
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 5)
    : 3;

  const category = searchParams.get("category") ?? "sports";

  const rawMinDataCoverage = Number(searchParams.get("minDataCoverage") ?? "40");
  const minDataCoverage = Number.isFinite(rawMinDataCoverage)
    ? rawMinDataCoverage
    : 40;

  const excludeEnded = searchParams.get("excludeEnded") !== "false";

  const result = await buildLandingCards({
    limit,
    category,
    minDataCoverage,
    excludeEnded,
  });

  const pairs = result.pairs ?? [];

  return NextResponse.json({
    debug: "fresh-evidence-generation",
    cacheBypassed: true,
    generatedAt: result.generatedAt,
    source: result.source,
    formulaVersion: result.formulaVersion,
    pairCount: pairs.length,
    pairs: pairs.map((pair) => {
      const evidence = pair.marketSources ?? [];

      return {
        id: pair.id,
        hasMarketSource: Boolean(pair.marketSource),
        marketSourceId: pair.marketSource?.id,
        marketSourceType: pair.marketSource?.type,
        marketSourceVisualType: pair.marketSource?.visualType,
        hasMarketSources: Array.isArray(pair.marketSources),
        marketSourcesLength: evidence.length,
        firstMarketSourceId: pair.marketSource?.id,
        firstEvidenceId: evidence[0]?.id,
        firstEvidenceMatches: evidence[0]?.id === pair.marketSource?.id,
        evidenceTypes: evidence.map((item) => item.type),
        evidenceVisualTypes: evidence.map((item) => item.visualType),
        evidenceIds: evidence.map((item) => item.id),
        evidenceHeadlines: evidence.map((item) => item.headline),
        evidenceSubline: evidence.map((item) => item.subline),
        evidenceDelta: evidence.map((item) => item.delta),
      };
    }),
  });
}
