import { NextRequest, NextResponse } from "next/server";
import { buildFireModelCandidates } from "@/lib/executor/buildFireModelCandidates";

const VALID_SCOPES = new Set(["all", "wc", "soccer", "mlb", "esport"]);

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-executor-secret");
  const expectedSecret = process.env.EXECUTOR_CANDIDATES_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = parseInt(searchParams.get("limit") ?? "25", 10);
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 25 : Math.min(rawLimit, 50);
  const rawScope = (searchParams.get("scope") ?? "all").toLowerCase();
  const scope = VALID_SCOPES.has(rawScope) ? rawScope : "all";

  try {
    const candidates = await buildFireModelCandidates(limit, scope);

    return NextResponse.json(
      {
        success: true,
        source: "FireModel1_private_executor",
        policy_version: "battle-sm-guard-v1-20260615",
        scope,
        count: candidates.length,
        limit,
        candidates,
      },
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[executor/candidates] Error:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
