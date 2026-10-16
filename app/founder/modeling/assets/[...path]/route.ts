import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { PUBLIC_MODELING_ERROR_HEADERS, PUBLIC_MODELING_HEADERS } from "@/lib/auth/founderModeling";
import { sanitizePublicLiveAsset } from "@/lib/modeling/publicLiveSanitizer";

export const dynamic = "force-dynamic";

const ALLOWED_FILES: Record<string, string> = {
  "MODELING_DASHBOARD.html": "text/html; charset=utf-8",
  "MODELING_DAILY_DATA.js": "application/javascript; charset=utf-8",
  "CAPITAL_MODELING_DATA.js": "application/javascript; charset=utf-8",
  "FORWARD_SHADOW_DATA.js": "application/javascript; charset=utf-8",
  "LIVE_RUNTIME_DATA.js": "application/javascript; charset=utf-8",
  "CURRENT_MODELING_AUTHORITY.js": "application/javascript; charset=utf-8",
};

const ASSET_DIR = path.join(process.cwd(), "modeling", "evidence", "modeling-dashboard-v1");

// Public, read-only static assets (issue #550): exact-name allowlist, no session. The LIVE snapshot is
// always passed through the public sanitizer; the raw artifact (wallet, project ref) is never served.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  const fileName = segments?.[0];

  if (!fileName || segments.length !== 1 || !Object.hasOwn(ALLOWED_FILES, fileName)) {
    return new NextResponse("Not found", { status: 404, headers: PUBLIC_MODELING_ERROR_HEADERS });
  }

  const contentType = ALLOWED_FILES[fileName];
  const filePath = path.join(ASSET_DIR, fileName);

  try {
    const raw = await readFile(filePath);
    const contents = fileName === "LIVE_RUNTIME_DATA.js" ? sanitizePublicLiveAsset(raw.toString("utf8")) : raw;
    return new NextResponse(contents, {
      status: 200,
      headers: { ...PUBLIC_MODELING_HEADERS, "Content-Type": contentType },
    });
  } catch {
    return new NextResponse("Not found", { status: 404, headers: PUBLIC_MODELING_ERROR_HEADERS });
  }
}
