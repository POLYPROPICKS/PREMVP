import { NextResponse } from "next/server";
import { PUBLIC_MODELING_ERROR_HEADERS, PUBLIC_MODELING_HEADERS } from "@/lib/auth/founderModeling";
import { sanitizePublicLive } from "@/lib/modeling/publicLiveSanitizer";
import { readLiveModelingRuntime } from "@/scripts/modeling/refresh-live-modeling-dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Public, aggregate-only. Same-origin, production SELECT-only runtime aggregate. The shared reader
 * hard-pins the production ref and returns STOPPED rather than ever reading the research clone.
 * Every response passes through sanitizePublicLive: no wallet balances, project refs or identifiers. */
export async function GET() {
  try {
    const body = sanitizePublicLive(await readLiveModelingRuntime());
    return NextResponse.json(body, { headers: body.status === "OK" ? PUBLIC_MODELING_HEADERS : PUBLIC_MODELING_ERROR_HEADERS });
  } catch {
    return NextResponse.json({ ARTIFACT: "LIVE_RUNTIME_DATA_V1", status: "STOPPED", stopReason: "RUNTIME_STOPPED", days: [] },
      { status: 503, headers: PUBLIC_MODELING_ERROR_HEADERS });
  }
}
