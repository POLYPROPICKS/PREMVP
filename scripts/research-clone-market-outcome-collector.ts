// DBClone-only Box B market-outcome collector cycle. Run: npx tsx scripts/research-clone-market-outcome-collector.ts
// Flags: --report (read-only coverage report, no provider calls, no writes)
//        --force-recheck (proof only: ignore the recheck rotation gap)
//        --max-new=N --max-rechecks=N --deadline-ms=N (bounded overrides; env MARKET_OUTCOME_* also honoured)
// Never reads production credentials. Exit 1 on DB/code failure or provider outage (visible in Railway); it is a separate
// `;` step in the scheduled command, so its failure cannot suppress sync, paper decisions or paper settlement.
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_CONFIG, COLLECTOR_SOURCE, cycleFailed, runCollectorCycle, type CollectorConfig } from "../lib/research/marketOutcomeCollector";
import { createSupabaseStore } from "../lib/research/marketOutcomeCollectorStore";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const url = process.env.SUPABASE_CLONE_URL;
const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("MARKET_OUTCOME_COLLECTOR_CLONE_CONFIG_MISSING");
if (!url.includes(CLONE_REF)) throw new Error("MARKET_OUTCOME_COLLECTOR_NOT_THE_RESEARCH_CLONE");
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function num(flag: string, env: string, dflt: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  const raw = arg ? arg.split("=")[1] : process.env[env];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

async function coverageReport() {
  const latest = new Map<string, string>();
  let receipts = 0; let revisions = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("market_outcome_revisions").select("condition_id,revision_no,outcome_status")
      .order("condition_id").order("revision_no").range(from, from + 999);
    if (error) throw new Error(`REPORT_REVISIONS:${error.message.slice(0, 120)}`);
    for (const r of data ?? []) latest.set(r.condition_id as string, r.outcome_status as string);
    revisions += data?.length ?? 0;
    if (!data || data.length < 1000) break;
  }
  const rc = await db.from("market_outcome_provider_receipts").select("receipt_id", { count: "exact", head: true });
  receipts = rc.count ?? 0;
  const byStatus: Record<string, number> = {};
  for (const s of latest.values()) byStatus[s] = (byStatus[s] ?? 0) + 1;
  return { box_b_distinct_markets: latest.size, revisions, receipts, latest_status_counts: byStatus };
}

async function main() {
  if (process.argv.includes("--report")) {
    console.log(JSON.stringify({ STATUS: "REPORT", ...(await coverageReport()) }));
    return;
  }
  const cfg: CollectorConfig = {
    ...DEFAULT_CONFIG,
    maxNewMarkets: num("max-new", "MARKET_OUTCOME_MAX_NEW", DEFAULT_CONFIG.maxNewMarkets),
    maxRechecks: num("max-rechecks", "MARKET_OUTCOME_MAX_RECHECKS", DEFAULT_CONFIG.maxRechecks),
    deadlineMs: num("deadline-ms", "MARKET_OUTCOME_DEADLINE_MS", DEFAULT_CONFIG.deadlineMs),
    forceRecheck: process.argv.includes("--force-recheck"),
    concurrency: num("concurrency", "MARKET_OUTCOME_CONCURRENCY", DEFAULT_CONFIG.concurrency),
  };
  const { stats, state } = await runCollectorCycle(createSupabaseStore(db), { fetchImpl: fetch, now: () => new Date(), timeoutMs: 20_000 }, cfg);
  const failed = cycleFailed(stats);
  console.log(JSON.stringify({
    STATUS: failed ? "FAILED" : stats.rate_limited || stats.deadline_hit ? "PARTIAL" : "SUCCESS",
    source: COLLECTOR_SOURCE, stats, cursors: state,
  }));
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  const stats = (e as { stats?: unknown }).stats;
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message.slice(0, 500) : "UNKNOWN", stats }));
  process.exitCode = 1;
});
