import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

const ALLOWED_FILES: Record<string, string> = {
  "MODELING_DASHBOARD.html": "text/html; charset=utf-8",
  "MODELING_DAILY_DATA.js": "application/javascript; charset=utf-8",
  "LIVE_RUNTIME_DATA.js": "application/javascript; charset=utf-8",
  "CURRENT_MODELING_AUTHORITY.js": "application/javascript; charset=utf-8",
};

const ASSET_DIR = path.join(process.cwd(), "modeling", "evidence", "modeling-dashboard-v1");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  const fileName = segments?.[0];

  if (!fileName || segments.length !== 1 || !(fileName in ALLOWED_FILES)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const contentType = ALLOWED_FILES[fileName];
  const filePath = path.join(ASSET_DIR, fileName);

  try {
    const contents = await readFile(filePath);
    return new NextResponse(contents, {
      status: 200,
      headers: { "Content-Type": contentType },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
