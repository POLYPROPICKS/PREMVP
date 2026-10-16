import { NextRequest, NextResponse } from "next/server";
import { isFounderModelingSession, PRIVATE_MODELING_HEADERS } from "@/lib/auth/founderModeling";
import { readLiveModelingRuntime } from "@/scripts/modeling/refresh-live-modeling-dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Founder-session only. Same-origin, production SELECT-only runtime aggregate. The shared reader
 * hard-pins the production ref and returns STOPPED rather than ever reading
 * the research clone. */
export async function GET(req: NextRequest) {
  if (!isFounderModelingSession(req.cookies.get("ppp_session")?.value)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: PRIVATE_MODELING_HEADERS });
  }
  const body = await readLiveModelingRuntime();
  return NextResponse.json(body, { headers: PRIVATE_MODELING_HEADERS });
}
