// DBClone-only, READ-ONLY daily research report. Run with:
//   npx tsx scripts/research-inplay-paper-settlement.ts [--day=YYYY-MM-DD]
// --day selects a half-open UTC day [00:00Z, +24h) on the frozen decision's admission_observed_at; omitted = all frozen decisions.
// Settles frozen paper BETs against the canonical provider resolver and prints A/B/C decisions, 1u economics, executable
// SELL-path diagnostics and missing-evidence flags as JSON. Writes nothing anywhere. Never reads production credentials.
import { createClient } from "@supabase/supabase-js";
import { fetchGammaMarketByConditionId } from "../lib/feed/resolveSignalOutcome";
import { runDailyReport, utcDayWindow } from "../lib/research/inplayPaperSettlement";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const dayArg = process.argv.find((a) => a.startsWith("--day="))?.slice(6);
const url = process.env.SUPABASE_CLONE_URL;
const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
if (!url || !key) {
  // Architect-side equivalent (read-only, aggregate): run on DBClone and compare with the CLI output.
  console.error(JSON.stringify({ STATUS: "DB_ACCESS_UNAVAILABLE", ERROR: "INPLAY_SETTLEMENT_CLONE_CONFIG_MISSING", ARCHITECT_AGGREGATE_SQL:
    "select strategy_id, status, provenance_class, count(*) n, count(distinct physical_event_id) games from research_inplay_paper_decisions group by 1,2,3 order by 1,2,3" }));
  process.exit(2);
}
if (!url.includes(CLONE_REF)) throw new Error("INPLAY_SETTLEMENT_NOT_THE_RESEARCH_CLONE");
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
runDailyReport(db, fetchGammaMarketByConditionId, dayArg ? utcDayWindow(dayArg) : null).then((r) => console.log(JSON.stringify({ STATUS: "SUCCESS", ...r }, null, 1)), (e) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : "UNKNOWN" }));
  process.exitCode = 1;
});
