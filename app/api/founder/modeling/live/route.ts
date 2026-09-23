import { NextResponse } from "next/server";
import { readLiveModelingRuntime } from "@/scripts/modeling/refresh-live-modeling-dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Same-origin, production SELECT-only runtime aggregate. The shared reader
 * hard-pins the production ref and returns STOPPED rather than ever reading
 * the research clone. */
export async function GET() {
  const body = await readLiveModelingRuntime();
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
