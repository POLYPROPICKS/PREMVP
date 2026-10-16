import { NextRequest, NextResponse } from "next/server";
import { isFounderModelingSession, PRIVATE_MODELING_HEADERS } from "@/lib/auth/founderModeling";
import { researchPaperClient } from "@/lib/research/founderPaperReader";
import { readFounderShadowMatches } from "@/lib/research/founderShadowMatches";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MESSAGES: Record<string,string> = {
  INVALID_RANGE: "Choose a whole number of days from 1 to 14.",
  RESEARCH_CONNECTION_UNAVAILABLE: "Research server connection is unavailable. No statistics are displayed.",
  NO_SHADOW_ROWS: "No SAFE shadow selections are available.",
  SHADOW_WINDOW_TOO_LARGE: "The requested window exceeds the bounded read limit. Choose fewer days.",
};

export async function GET(req: NextRequest) {
  if (!isFounderModelingSession(req.cookies.get("ppp_session")?.value)) {
    return NextResponse.json({error:"not_found"},{status:404,headers:PRIVATE_MODELING_HEADERS});
  }
  try {
    const report = await readFounderShadowMatches(researchPaperClient(), req.nextUrl.searchParams);
    return NextResponse.json(report,{headers:PRIVATE_MODELING_HEADERS});
  } catch (error) {
    const code = error instanceof Error && error.message in MESSAGES ? error.message : "RESEARCH_READ_UNAVAILABLE";
    return NextResponse.json({error:code,message:MESSAGES[code]??"Research reporting is unavailable. Retry later."},
      {status:code==="INVALID_RANGE"?400:503,headers:PRIVATE_MODELING_HEADERS});
  }
}
