// GET /api/build-info
// Read-only deployment build-provenance endpoint. Proves which Git commit is
// embedded in the running production build. Reads build-baked env values
// only — no Git state or shell commands are evaluated per request.

import { NextResponse } from "next/server";
import { buildBuildInfoResponse } from "@/lib/runtime/buildProvenance";

export const dynamic = "force-dynamic";

export async function GET() {
  const { body, status } = buildBuildInfoResponse({
    commitSha: process.env.BUILD_PROVENANCE_COMMIT_SHA,
    provenanceSource: process.env.BUILD_PROVENANCE_SOURCE,
  });

  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
