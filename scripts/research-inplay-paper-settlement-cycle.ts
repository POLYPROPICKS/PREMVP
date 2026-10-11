// DBClone-only autonomous A/B/C settlement cycle. Run with: npx tsx scripts/research-inplay-paper-settlement-cycle.ts
// No arguments: derives the UTC days to settle, writes bounded daily report rows to DBClone. Never reads production credentials.
// Exit code 1 when any day failed or the report table is missing (never silent success); it is a separate `;` step in the
// scheduled command, so its failure cannot suppress the Production -> DBClone sync or the paper decision cycle.
import { createClient } from "@supabase/supabase-js";
import { fetchGammaMarketByConditionId } from "../lib/feed/resolveSignalOutcome";
import { runSettlementCycle } from "../lib/research/inplayPaperSettlementCycle";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const url = process.env.SUPABASE_CLONE_URL;
const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("INPLAY_SETTLEMENT_CYCLE_CLONE_CONFIG_MISSING");
if (!url.includes(CLONE_REF)) throw new Error("INPLAY_SETTLEMENT_CYCLE_NOT_THE_RESEARCH_CLONE");
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
runSettlementCycle(db, fetchGammaMarketByConditionId).then((r) => {
  console.log(JSON.stringify({ STATUS: r.ok ? "SUCCESS" : "FAILED", ...r }));
  if (!r.ok) process.exitCode = 1;
}, (e) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message.slice(0, 500) : "UNKNOWN" }));
  process.exitCode = 1;
});
