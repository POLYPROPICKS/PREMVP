import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { REPORT_TABLE, REPORT_VERSION, SOURCE_PROVENANCE } from "./inplayPaperSettlementCycle";
import { mergePaperSnapshots, type PaperSnapshot } from "./paperScorecardSnapshot";

const DAY = 86_400_000;
export function paperRange(params: URLSearchParams, first: string, now: number) {
  const midnight = Math.floor(now / DAY) * DAY;
  const range = params.get("range") ?? "all";
  let from = first.slice(0,10), to = new Date(midnight + DAY).toISOString().slice(0,10);
  if (["7","14","30"].includes(range)) from = new Date(midnight - (Number(range)-1)*DAY).toISOString().slice(0,10);
  else if (range === "custom") { from = params.get("from") ?? ""; const end = params.get("to") ?? "";
    if (!validDay(end)) throw Error("INVALID_RANGE");
    to = new Date(Date.parse(end) + DAY).toISOString().slice(0,10);
  } else if (range !== "all") throw Error("INVALID_RANGE");
  if (!validDay(from) || !validDay(to) || from >= to || Date.parse(to)-Date.parse(from)>366*DAY || Date.parse(to)>midnight+DAY) throw Error("INVALID_RANGE");
  return { from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z` };
}
function validDay(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value; }

export function researchPaperClient() {
  const url = process.env.SUPABASE_CLONE_URL, key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Error("RESEARCH_CONNECTION_UNAVAILABLE");
  // Reuse the research pipeline's existing target authority; never fall back to production.
  const expected = SOURCE_PROVENANCE.match(/^DBClone ([a-z0-9]+):/)?.[1];
  if (!expected || new URL(url).hostname !== `${expected}.supabase.co` || new URL(url).protocol !== "https:") throw Error("RESEARCH_CONNECTION_UNAVAILABLE");
  return createClient(url, key, { auth: { persistSession:false, autoRefreshToken:false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache:"no-store", signal: AbortSignal.timeout(12_000) }) } });
}

export async function readFounderPaper(db: SupabaseClient, params: URLSearchParams, now = Date.now()) {
  const readAt = new Date(now).toISOString();
  // One projected timestamp, never decision identities or raw financial positions.
  const first = await db.from("research_inplay_paper_decisions").select("admission_observed_at").lte("created_at",readAt).order("admission_observed_at").limit(1);
  if (first.error) throw Error("RESEARCH_READ_UNAVAILABLE");
  if (!first.data?.length) throw Error("NO_RESEARCH_DECISIONS");
  const {from,to} = paperRange(params, first.data[0].admission_observed_at, now);
  const query = (status?: string) => {
    let q = db.from("research_inplay_paper_decisions").select("decision_id",{count:"exact",head:true}).gte("admission_observed_at",from).lt("admission_observed_at",to).lte("created_at",readAt);
    if (status) q=q.eq("status",status);
    return q;
  };
  const [reports, total, bet, waiting] = await Promise.all([
    db.from(REPORT_TABLE).select("utc_day,generated_at,status,last_attempt_status,scorecard:summary->paper_scorecard").eq("report_version",REPORT_VERSION).gte("utc_day",from.slice(0,10)).lt("utc_day",to.slice(0,10)).lte("generated_at",readAt).order("utc_day").limit(367),
    query(), query("BET"), query("WAITING"),
  ]);
  if (reports.error || total.error || bet.error || waiting.error) throw Error("RESEARCH_READ_UNAVAILABLE");
  if (!reports.data?.length || reports.data.length>366 || reports.data.some(r=>!r.scorecard || r.status==="FAILED")) throw Error("REPORT_REFRESH_REQUIRED");
  const snapshots = reports.data.map(r=>r.scorecard as unknown as PaperSnapshot);
  const report = mergePaperSnapshots(snapshots,from,to,readAt);
  const rows = report.strategy_totals;
  const sum = (field: "bet"|"skip"|"waiting") => rows.reduce((n,r)=>n+r[field],0);
  if (sum("bet")!==bet.count || sum("waiting")!==waiting.count || sum("bet")+sum("skip")+sum("waiting")!==total.count) throw Error("REPORT_COHORT_BEHIND_DECISIONS");
  const relevant = reports.data.filter(r => r.status!=="FULLY_RESOLVED" || r.utc_day===readAt.slice(0,10));
  const freshnessMs = relevant.length ? Math.max(...relevant.map(r=>now-Date.parse(r.generated_at))) : 0;
  return { ...report, freshness: freshnessMs>2*3_600_000 || reports.data.some(r=>r.last_attempt_status!=="SUCCESS") ? "STALE" : "CURRENT",
    freshness_seconds: Math.max(0,Math.floor(freshnessMs/1000)),
    shared_economics: "Execution & Optimal Exit Authority: shared economics/data-quality; net fees UNKNOWN; no betting-model status." };
}
