import { NextResponse } from "next/server";
import { PUBLIC_MODELING_ERROR_HEADERS, PUBLIC_MODELING_HEADERS } from "@/lib/auth/founderModeling";
import { sanitizePublicLive } from "@/lib/modeling/publicLiveSanitizer";
import { readLiveModelingRuntime } from "@/scripts/modeling/refresh-live-modeling-dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const OK_TTL_MS = 30_000;
const STOPPED_TTL_MS = 10_000;
const STOPPED_BODY = { ARTIFACT: "LIVE_RUNTIME_DATA_V1", status: "STOPPED", stopReason: "RUNTIME_STOPPED", days: [] };

// The endpoint is anonymous, so the production read is shared: concurrent and repeated requests reuse one
// in-flight/recent sanitized result instead of each issuing ~10 production queries.
let cached: { at: number; ttl: number; body: Record<string, unknown> } | null = null;
let inflight: Promise<Record<string, unknown>> | null = null;

async function loadPublicLive(): Promise<Record<string, unknown>> {
  if (cached && Date.now() - cached.at < cached.ttl) return cached.body;
  inflight ??= (async () => {
    let body: Record<string, unknown>;
    try { body = sanitizePublicLive(await readLiveModelingRuntime()); } catch { body = STOPPED_BODY; }
    cached = { at: Date.now(), ttl: body.status === "OK" ? OK_TTL_MS : STOPPED_TTL_MS, body };
    return body;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Public, aggregate-only. Same-origin, production SELECT-only runtime aggregate. The shared reader
 * hard-pins the production ref and returns STOPPED rather than ever reading the research clone.
 * Every response passes through sanitizePublicLive: no wallet balances, project refs or identifiers. */
export async function GET() {
  const body = await loadPublicLive();
  return NextResponse.json(body, body.status === "OK"
    ? { headers: PUBLIC_MODELING_HEADERS }
    : { status: 503, headers: PUBLIC_MODELING_ERROR_HEADERS });
}
