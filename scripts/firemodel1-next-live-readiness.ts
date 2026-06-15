// FireModel1 Next Live Session Readiness — read-only, no wallet, no CLOB, no orders.
// Shows readiness for next controlled live session.
// Run: npm run firemodel1:live-readiness

import { buildFireModelCandidates } from "../lib/executor/buildFireModelCandidates";

const now = Date.now();

function hLabel(h: number): string {
  if (h < 0) return "STARTED";
  if (h <= 1) return "0-1h";
  if (h <= 2) return "1-2h";
  if (h <= 3) return "2-3h";
  if (h <= 6) return "3-6h";
  if (h <= 24) return "6-24h";
  return ">24h";
}

const WC_RE = /world[\s-]?cup|wc2026|fifa|cabo|belgium|egypt|spain/i;
const ESPORTS_RE = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;

async function main() {
  const pool = await buildFireModelCandidates(500);
  const line = "─".repeat(62);

  console.log(`\nFIREMODEL1 NEXT LIVE SESSION READINESS  ${new Date().toISOString()}`);
  console.log(`Pool size: ${pool.length}\n`);

  // Timing buckets
  const timingBuckets: Record<string, number> = {
    "0-1h": 0, "1-2h": 0, "2-3h": 0, "3-6h": 0, "6-24h": 0, ">24h": 0, STARTED: 0,
  };
  for (const c of pool) {
    const bucket = hLabel(c.diagnostics.hours_to_start_now);
    timingBuckets[bucket] = (timingBuckets[bucket] ?? 0) + 1;
  }

  console.log("TIMING DISTRIBUTION");
  for (const [k, v] of Object.entries(timingBuckets)) {
    console.log(`  ${k.padEnd(10)}: ${v}`);
  }

  // WC / eSports slice
  const wcCandidates = pool.filter((c) => WC_RE.test(c.market_slug));
  const esportsCandidates = pool.filter((c) => ESPORTS_RE.test(c.market_slug));
  console.log(`\nWC2026 candidates   : ${wcCandidates.length}`);
  console.log(`eSports candidates  : ${esportsCandidates.length}`);

  // Correlation / conflict check — same event different sides
  const eventGroups: Record<string, typeof pool> = {};
  for (const c of pool) {
    const eventKey = c.condition_id.slice(0, 42);
    if (!eventGroups[eventKey]) eventGroups[eventKey] = [];
    eventGroups[eventKey].push(c);
  }
  const conflicts: Array<{ event: string; candidates: typeof pool }> = [];
  for (const [ev, group] of Object.entries(eventGroups)) {
    if (group.length > 1) {
      const sides = new Set(group.map((c) => c.side));
      if (sides.size > 1) conflicts.push({ event: ev, candidates: group });
    }
  }

  if (conflicts.length > 0) {
    console.log(`\n⚠  POTENTIAL CONFLICTS (multiple sides same condition_id prefix):`);
    for (const { event, candidates } of conflicts.slice(0, 5)) {
      console.log(`   ${event.slice(0, 20)}... → ${candidates.map((c) => c.side).join(" vs ")}`);
    }
  } else {
    console.log(`\nCONFLICT_CHECK: no multi-side conflicts in current pool`);
  }

  // Top 10 candidates
  console.log(`\n${line}`);
  console.log("TOP 10 CANDIDATES FOR NEXT LIVE SESSION");
  console.log(`${"#".padEnd(3)} ${"MARKET".padEnd(26)} ${"SIDE".padEnd(5)} TOK ${"ENTRY".padEnd(6)} ${"MAX".padEnd(6)} ${"STK".padEnd(4)} ACTION`);
  for (const c of pool.slice(0, 10)) {
    const mkt = c.market_slug.slice(0, 25).padEnd(25);
    const side = (c.side || "?").slice(0, 4).padEnd(4);
    const tok = c.token_id ? "Y" : "N";
    const entry = c.diagnostics.entry_price.toFixed(3).padEnd(5);
    const max = c.max_entry_price.toFixed(3).padEnd(5);
    const stk = `$${c.stake_usd}`.padEnd(3);
    const action = c.diagnostics.executor_action;
    console.log(`#${String(c.rank).padStart(2)} ${mkt} ${side} ${tok}   ${entry} ${max} ${stk}  ${action}`);
  }

  // Risk notes
  const highSm = pool.filter((c) => (c.diagnostics.smart_money ?? 0) >= 75);
  if (highSm.length > 0) {
    console.log(`\n⚠  SM_CAUTION candidates (half-stake applied): ${highSm.length}`);
  }
  const lowSpreadRisk = pool.filter((c) => c.max_entry_price >= 0.90);
  if (lowSpreadRisk.length > 0) {
    console.log(`⚠  HIGH_PRICE_RISK (max_entry >= 0.90): ${lowSpreadRisk.length}`);
  }

  // Recommendation
  console.log(`\n${line}`);
  const betOrGo = pool.filter((c) => c.diagnostics.executor_action === "BET_OR_PAPER_GO");
  const readyNow = betOrGo.length >= 1;
  const poolOk = pool.length >= 10;

  console.log("READINESS VERDICT");
  console.log(`  READY_FOR_NEXT_CONTROLLED_LIVE : ${readyNow && poolOk ? "YES" : "NO"}`);

  if (!poolOk) {
    console.log(`  BLOCKER: pool < 10 candidates (current: ${pool.length})`);
  } else if (!readyNow) {
    console.log(`  BLOCKER: no BET_OR_PAPER_GO candidates within 2h window (pool ok, timing not ready)`);
  } else {
    const maxOrders = Math.min(betOrGo.length, 3);
    const totalStake = betOrGo.slice(0, maxOrders).reduce((s, c) => s + c.stake_usd, 0);
    console.log(`  max_first_orders : ${maxOrders}`);
    console.log(`  total_stake_cap  : $${totalStake}`);
    console.log(`  BET_OR_PAPER_GO  : ${betOrGo.length} candidates ready`);
    console.log(`  paper_only=true, real_trade=false (Ireland bridge mode)`);
  }

  // Blockers list
  console.log(`\nBLOCKERS:`);
  const noToken = pool.filter((c) => !c.token_id);
  if (noToken.length) console.log(`  HIGH: ${noToken.length} candidates missing token_id`);
  if (!poolOk) console.log(`  HIGH: pool < 10 candidates`);
  if (!readyNow) console.log(`  MEDIUM: no BET_OR_PAPER_GO within 2h`);
  if (conflicts.length) console.log(`  MEDIUM: ${conflicts.length} potential multi-side conflicts`);
  if (!noToken.length && poolOk && readyNow && !conflicts.length) {
    console.log(`  NONE`);
  }

  console.log(`${line}\n`);
}

main().catch((e) => {
  console.error("LIVE_READINESS_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
