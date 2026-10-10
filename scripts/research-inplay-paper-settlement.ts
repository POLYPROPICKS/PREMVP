// DBClone-only, READ-ONLY research report. Run with: npx tsx scripts/research-inplay-paper-settlement.ts
// Settles frozen paper BETs against the canonical provider resolver and prints 1u economics + executable SELL-path
// diagnostics as JSON. Writes nothing anywhere. Never reads production credentials.
import { createClient } from "@supabase/supabase-js";
import { fetchGammaMarketByConditionId } from "../lib/feed/resolveSignalOutcome";
import { runSettlementReport } from "../lib/research/inplayPaperSettlement";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const url = process.env.SUPABASE_CLONE_URL;
const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("INPLAY_SETTLEMENT_CLONE_CONFIG_MISSING");
if (!url.includes(CLONE_REF)) throw new Error("INPLAY_SETTLEMENT_NOT_THE_RESEARCH_CLONE");
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
runSettlementReport(db, fetchGammaMarketByConditionId).then((r) => console.log(JSON.stringify({ STATUS: "SUCCESS", ...r }, null, 1)), (e) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : "UNKNOWN" }));
  process.exitCode = 1;
});
