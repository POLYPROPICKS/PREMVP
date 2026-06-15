// FireModel1 operational checkpoint — read-only monitor.
// Reuses the exact executor candidate rules from lib/executor/buildFireModelCandidates.
// No SQL output, no model-formula change, no writes. Run: npm run firemodel1:checkpoint

import { buildFireModelCandidates } from "../lib/executor/buildFireModelCandidates";
import { supabaseAdmin } from "../lib/supabase/server";

const ALLOWED_VERSIONS = ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"];
const ESPORTS_RE = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;
const WC_RE = /world[\s-]?cup|wc2026|fifa|cabo|belgium|egypt|spain/i;

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;
}

async function main() {
  // Valid pool = all candidates that pass every FireModel1 gate (post bad-bucket / post started).
  const pool = await buildFireModelCandidates(500);
  const total = pool.length;

  // Tier counts
  const tier1 = pool.filter((c) => c.strategy === "TIER1_CORE_STRICT_72_COV50").length;
  const tier2 = pool.filter((c) => c.strategy === "TIER2_SAFE_EXPAND_60_COV50").length;
  const tier3 = pool.filter((c) => c.strategy === "TIER3_MICRO_EXPAND_50_COV25").length;

  // Action counts
  const act = (a: string) =>
    pool.filter((c) => c.diagnostics.executor_action === a).length;
  const bet = act("BET_OR_PAPER_GO");
  const queue =
    act("QUEUE_TOP_TIER_ONLY") + act("QUEUE_WAIT_T_MINUS_60") + act("QUEUE_LATER");
  const skip = act("SKIP_STARTED");

  // eSports limited (stake capped at 5 because esports) + WC2026
  const esportsLimited = pool.filter(
    (c) => ESPORTS_RE.test(c.market_slug) && c.stake_usd <= 5,
  ).length;
  const wc = pool.filter((c) => WC_RE.test(c.market_slug)).length;

  // Coverage of hard-required fields inside the valid pool (should be 100%).
  const tokenCov = pool.filter((c) => !!c.token_id).length;
  const gsiCov = pool.filter((c) => !!c.diagnostics.game_start_iso).length;
  const condCov = pool.filter((c) => !!c.condition_id).length;

  // Pre-filter raw metric: bad-bucket count (excluded by helper, so query raw).
  const { data: raw } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("entry_price_num, diagnostics")
    .in("metric_formula_version", ALLOWED_VERSIONS)
    .is("signal_result", null)
    .gt("expires_at", new Date().toISOString());
  let badBucket = 0;
  for (const r of (raw ?? []) as Array<{ entry_price_num: number | null; diagnostics: { dataCoverage?: number } }>) {
    const cov = r.diagnostics?.dataCoverage;
    const ep = r.entry_price_num;
    if (cov != null && ep != null && cov >= 50 && cov <= 74 && ep >= 0.44 && ep <= 0.58) badBucket++;
  }

  const line = "─".repeat(54);
  console.log(`\nFIREMODEL1 CHECKPOINT  ${new Date().toISOString()}`);
  console.log(line);
  console.log(`valid_candidates_total : ${total}`);
  console.log(`endpoint_can_return    : 10=${total >= 10}  25=${total >= 25}  50=${total >= 50}`);
  console.log(`tiers                  : T1=${tier1}  T2=${tier2}  T3=${tier3}`);
  console.log(`actions                : BET_OR_PAPER_GO=${bet}  QUEUE=${queue}  SKIP=${skip}`);
  console.log(`bad_bucket (pre-filter): ${badBucket}`);
  console.log(`esports_limited        : ${esportsLimited}`);
  console.log(`wc2026_count           : ${wc}`);
  console.log(`field coverage         : token=${pct(tokenCov, total)}  gameStartIso=${pct(gsiCov, total)}  condition=${pct(condCov, total)}`);
  console.log(line);
  console.log("TOP 10 CANDIDATES");
  for (const c of pool.slice(0, 10)) {
    const mkt = (c.market_slug || "").slice(0, 28).padEnd(28);
    console.log(
      `#${String(c.rank).padStart(2)} ${mkt} ${String(c.side).slice(0, 4).padEnd(4)} ` +
        `tok=${c.token_id ? "Y" : "N"} ent=${c.diagnostics.entry_price.toFixed(3)} ` +
        `max=${c.max_entry_price.toFixed(3)} $${c.stake_usd} ${c.diagnostics.executor_action}`,
    );
  }

  // Named markets if present
  const named = pool.filter((c) => /cabo|belgium|egypt/i.test(c.market_slug));
  if (named.length) {
    console.log(line);
    console.log("NAMED (Cabo / Belgium / Egypt)");
    for (const c of named) {
      console.log(
        `  ${c.market_slug.slice(0, 40)} ${c.side} tok=${c.token_id ? "Y" : "N"} ` +
          `ent=${c.diagnostics.entry_price.toFixed(3)} max=${c.max_entry_price.toFixed(3)} ` +
          `$${c.stake_usd} ${c.diagnostics.executor_action}`,
      );
    }
  } else {
    console.log("NAMED (Cabo / Belgium / Egypt): none in current pool");
  }
  console.log(line + "\n");
}

main().catch((e) => {
  console.error("CHECKPOINT_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
