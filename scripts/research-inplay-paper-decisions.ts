// DBClone-only research runner. Run with: npx tsx scripts/research-inplay-paper-decisions.ts
// Reads observations and writes frozen paper decisions on the research clone ONLY. Never reads production credentials.
import { createClient } from "@supabase/supabase-js";
import { runPaperDecisionCycle } from "../lib/research/inplayPaperDecisions";
import { runTailForwardCycle } from "../lib/research/inplayTailForward";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const url = process.env.SUPABASE_CLONE_URL;
const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("INPLAY_PAPER_CLONE_CONFIG_MISSING");
if (!url.includes(CLONE_REF)) throw new Error("INPLAY_PAPER_NOT_THE_RESEARCH_CLONE");
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const msg = (e: unknown) => (e instanceof Error ? e.message : "UNKNOWN");
// TAIL_FORWARD_EVIDENCE_V1 runs after (never inside) the control cycle with its own checkpoint; a failure of either
// is reported and sets a non-zero exit code, but neither can suppress the other.
async function main() {
  let failed = false;
  try { console.log(JSON.stringify({ STATUS: "SUCCESS", ...(await runPaperDecisionCycle(db)) })); }
  catch (e) { failed = true; console.error(JSON.stringify({ STATUS: "FAILED", ERROR: msg(e) })); }
  try { console.log(JSON.stringify({ STATUS: "SUCCESS", PROCESSOR: "TAIL_FORWARD_EVIDENCE_V1", ...(await runTailForwardCycle(db)) })); }
  catch (e) { failed = true; console.error(JSON.stringify({ STATUS: "FAILED", PROCESSOR: "TAIL_FORWARD_EVIDENCE_V1", ERROR: msg(e) })); }
  if (failed) process.exitCode = 1;
}
void main();
