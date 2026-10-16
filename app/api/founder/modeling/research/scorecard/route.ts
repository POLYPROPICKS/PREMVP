import { NextRequest, NextResponse } from "next/server";
import { PUBLIC_MODELING_ERROR_HEADERS, PUBLIC_MODELING_HEADERS } from "@/lib/auth/founderModeling";
import { readFounderPaper, researchPaperClient } from "@/lib/research/founderPaperReader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MESSAGES: Record<string,string> = {
  INVALID_RANGE: "Choose valid UTC dates spanning at most 366 days, ending no later than today.",
  RESEARCH_CONNECTION_UNAVAILABLE: "Research server connection is unavailable. No statistics are displayed.",
  REPORT_REFRESH_REQUIRED: "The existing research settlement pipeline must refresh its scorecard summaries. No current statistics are claimed.",
  REPORT_COHORT_BEHIND_DECISIONS: "Research decisions have advanced beyond the durable reports. Await the existing settlement refresh.",
  NO_RESEARCH_DECISIONS: "No research decisions are available for reporting.",
};

// Public, read-only aggregate scorecard (issue #550): no session required.
export async function GET(req: NextRequest) {
  try {
    const report = await readFounderPaper(researchPaperClient(), req.nextUrl.searchParams);
    return NextResponse.json(report,{headers:PUBLIC_MODELING_HEADERS});
  } catch (error) {
    const code = error instanceof Error && error.message in MESSAGES ? error.message : "RESEARCH_READ_UNAVAILABLE";
    return NextResponse.json({error:code,message:MESSAGES[code]??"Research reporting is unavailable. Retry after the next pipeline refresh.",cacheStatus:"bypassed"},
      {status:code==="INVALID_RANGE"?400:503,headers:PUBLIC_MODELING_ERROR_HEADERS});
  }
}
