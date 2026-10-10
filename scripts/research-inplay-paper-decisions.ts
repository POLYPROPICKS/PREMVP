// DBClone-only research runner. Run with: npx tsx scripts/research-inplay-paper-decisions.ts
// Reads observations and writes frozen paper decisions on the research clone ONLY. Never reads production credentials.
import { createClient } from "@supabase/supabase-js";
import { runPaperDecisionCycle } from "../lib/research/inplayPaperDecisions";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const url = process.env.SUPABASE_CLONE_URL;
const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("INPLAY_PAPER_CLONE_CONFIG_MISSING");
if (!url.includes(CLONE_REF)) throw new Error("INPLAY_PAPER_NOT_THE_RESEARCH_CLONE");
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
runPaperDecisionCycle(db).then((r) => console.log(JSON.stringify({ STATUS: "SUCCESS", ...r })), (e) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : "UNKNOWN" }));
  process.exitCode = 1;
});
