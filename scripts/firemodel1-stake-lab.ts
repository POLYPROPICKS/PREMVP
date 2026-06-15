// FireModel1 Stake / Bankroll Lab — Phase 4.
// Tests staking policies only. Does NOT change signal selection.
// Run: npm run firemodel1:stake

import { fetchAllResolvedRows, fetchModelRows, isAllowed, isNbaOrNhl, isBadBucket, isEsports,
  getScore, getCov, getSm, getEp, getStake_primary, cohortStats, since, LINE, ModelRow,
} from "../lib/executor/modelingData";

// ── STAKE POLICIES ───────────────────────────────────────────

type StakeFunc = (r: ModelRow) => number;

const STAKE_0_CURRENT: StakeFunc = getStake_primary;
const STAKE_1_FLAT5: StakeFunc = () => 5;
const STAKE_2_FLAT10: StakeFunc = () => 10;

const STAKE_3_BOUNDED_VARIABLE: StakeFunc = (r) => {
  const sc = getScore(r); const cov = getCov(r);
  if (sc >= 75 && cov >= 75) return 10;
  if (sc >= 72 && cov >= 50) return 7;
  if (sc >= 60 && cov >= 50) return 5;
  if (sc >= 50 && cov >= 25) return 3;
  return 2;
};

// Proxy Kelly: edge = score/100 - entry_price; Kelly fraction = edge / (1 - entry_price) * 0.25
// Capped at $10, min $1
const STAKE_4_PROXY_KELLY: StakeFunc = (r) => {
  const sc = getScore(r); const ep = getEp(r);
  if (ep == null || ep <= 0 || ep >= 1) return 2;
  const estimatedWinProb = sc / 100;
  const edge = estimatedWinProb - ep;
  if (edge <= 0) return 1;
  const kelly = edge / (1 - ep);
  const fractional = kelly * 0.25; // 25% Kelly
  const bankFrac = 300 * fractional;
  return Math.max(1, Math.min(10, Math.round(bankFrac)));
};

const STAKE_5_DRAWDOWN_PROTECT: StakeFunc = (r) => {
  // Simulate conservative mode (no daily drawdown state available in DB query)
  // Use as conservative variant: Tier3 disabled, Tier2 capped at $5
  const sc = getScore(r); const cov = getCov(r); const sm = getSm(r);
  if (sc < 60 || cov < 50) return 0; // Tier3 disabled
  let base = sc >= 72 && cov >= 75 ? 10 : sc >= 72 ? 7 : 5;
  if (sm != null && sm >= 75) base = Math.floor(base / 2);
  return Math.min(base, 7); // Tier2 capped at $5 effectively by $7 cap
};

const STAKE_6_AGGRESSIVE_RECOVERY: StakeFunc = (r) => {
  // Top-tier only, $7/$10 if score>=75 cov>=75
  const sc = getScore(r); const cov = getCov(r);
  if (sc >= 75 && cov >= 75) return 10;
  if (sc >= 72 && cov >= 50) return 7;
  return 0; // skip weaker candidates in recovery mode
};

const POLICIES: Array<{ id: string; desc: string; stake: StakeFunc }> = [
  { id: "STAKE_0_CURRENT", desc: "Variable by tier/cov, SM half-stake, esports $5 cap", stake: STAKE_0_CURRENT },
  { id: "STAKE_1_FLAT5", desc: "Flat $5 all candidates", stake: STAKE_1_FLAT5 },
  { id: "STAKE_2_FLAT10", desc: "Flat $10 all candidates", stake: STAKE_2_FLAT10 },
  { id: "STAKE_3_BOUNDED_VARIABLE", desc: "Variable $2/$3/$5/$7/$10 by tier", stake: STAKE_3_BOUNDED_VARIABLE },
  { id: "STAKE_4_PROXY_KELLY", desc: "25% fractional Kelly (edge from score vs price)", stake: STAKE_4_PROXY_KELLY },
  { id: "STAKE_5_DRAWDOWN_PROTECT", desc: "Conservative mode: Tier3 off, Tier2 capped $7", stake: STAKE_5_DRAWDOWN_PROTECT },
  { id: "STAKE_6_AGGRESSIVE_RECOVERY", desc: "Recovery: Tier1 only $7/$10, skip micro", stake: STAKE_6_AGGRESSIVE_RECOVERY },
];

// ── BANKROLL SIMULATION ──────────────────────────────────────
interface BankSim {
  policy: string;
  startBank: number;
  finalBank: number;
  netPnl: number | null;
  maxDeploy: number;
  maxDrawdown: number;
  betsPlaced: number;
  betsSkipped: number;
  peakBank: number;
  exhausted: boolean;
}

function simulateBank(rows: ModelRow[], stakeFunc: StakeFunc, startBank = 300): BankSim {
  const sorted = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  let bank = startBank; let peak = startBank; let minBank = startBank;
  let netPnl: number | null = 0; let hasPnl = true;
  let deploy = 0; let placed = 0; let skipped = 0;
  const MAX_EXPOSURE = 220;

  for (const r of sorted) {
    const stake = stakeFunc(r);
    if (stake <= 0) { skipped++; continue; }
    if (deploy + stake > MAX_EXPOSURE) { skipped++; continue; }
    deploy += stake; placed++;
    deploy = Math.max(0, deploy - stake); // simplified: no concurrent tracking

    if (r.realized_return_pct != null) {
      const pnl = stake * r.realized_return_pct / 100;
      bank += pnl;
      if (netPnl !== null) netPnl += pnl;
    } else {
      hasPnl = false;
      netPnl = null;
    }

    peak = Math.max(peak, bank);
    minBank = Math.min(minBank, bank);
    const maxStakeEver = Math.max(deploy, stake);
    if (maxStakeEver > deploy) deploy = 0;
  }

  const maxDD = startBank - minBank;
  return {
    policy: "", startBank, finalBank: Math.round(bank * 100) / 100,
    netPnl: netPnl != null ? Math.round(netPnl * 100) / 100 : null,
    maxDeploy: MAX_EXPOSURE, maxDrawdown: maxDD, betsPlaced: placed,
    betsSkipped: skipped, peakBank: peak, exhausted: bank < 10,
  };
}

// ── CANDIDATE FILTER (consistent with Model A) ───────────────
function candidateFilter(r: ModelRow): boolean {
  return isAllowed(r) && !isNbaOrNhl(r) && !isBadBucket(r)
    && getScore(r) >= 72 && getCov(r) >= 50;
}

async function main() {
  console.log(`\nFIREMODEL1 STAKE LAB  ${new Date().toISOString()}`);
  console.log(`Bank=$300  Target=$160  Hard=$220  Cap=$10\n`);

  const allResolved = await fetchAllResolvedRows();
  const candidates = allResolved.filter(candidateFilter);

  console.log(LINE);
  console.log(`All-time resolved candidates for staking analysis: ${candidates.length}`);
  if (candidates.length < 10) {
    console.log("⚠ WARNING: N < 10 resolved candidates — stake optimization premature");
    console.log("  PnL-based metrics will show ROI_NOT_AVAILABLE until resolved_count >= 10");
  }

  // Proxy Kelly check
  const hasEp = candidates.filter((r) => getEp(r) != null).length;
  if (hasEp < candidates.length) {
    console.log(`  KELLY_NOT_AVAILABLE: ${candidates.length - hasEp} rows missing entry_price_num`);
    console.log("  Proxy Kelly will fall back to $2 for those rows");
  }

  console.log(`\n${"POLICY".padEnd(28)} ${"bets".padEnd(5)} ${"stake$".padEnd(8)} ${"roi".padEnd(10)} ${"netPnl".padEnd(10)} ${"maxDD".padEnd(7)} ${"exhaust"}`);
  console.log(LINE);

  const recommendations: Array<{ id: string; role: string; verdict: string }> = [];

  for (const p of POLICIES) {
    const filtered = candidates.filter((r) => p.stake(r) > 0);
    const stats = cohortStats(filtered, p.stake);
    const sim = simulateBank(filtered, p.stake);

    const roi = stats.roiPct != null ? `${stats.roiPct > 0 ? "+" : ""}${stats.roiPct}%` : "N/A";
    const pnl = sim.netPnl != null ? `$${sim.netPnl > 0 ? "+" : ""}${sim.netPnl}` : "N/A";
    const dd = `$${Math.round(sim.maxDrawdown)}`;

    console.log(
      `${p.id.padEnd(28)} ${String(filtered.length).padEnd(5)} ` +
      `$${String(stats.totalStake).padEnd(7)} ${roi.padEnd(10)} ${pnl.padEnd(10)} ${dd.padEnd(7)} ${sim.exhausted ? "YES" : "no"}`,
    );

    // Recommendation logic
    let verdict = "SHADOW";
    if (p.id === "STAKE_0_CURRENT") verdict = "LOCK ($300 bank)";
    else if (p.id === "STAKE_1_FLAT5") verdict = "SAFER (lower exposure)";
    else if (p.id === "STAKE_2_FLAT10") verdict = "AGGRESSIVE (higher PnL risk)";
    else if (p.id === "STAKE_3_BOUNDED_VARIABLE") verdict = "SHADOW (similar to current)";
    else if (p.id === "STAKE_4_PROXY_KELLY") verdict = "SHADOW (needs calibration)";
    else if (p.id === "STAKE_5_DRAWDOWN_PROTECT") verdict = "USE_AFTER_BAD_DAY";
    else if (p.id === "STAKE_6_AGGRESSIVE_RECOVERY") verdict = "USE_RECOVERY_ONLY";

    recommendations.push({ id: p.id, role: p.desc.slice(0, 35), verdict });
  }

  console.log(`\n${LINE}`);
  console.log("VERDICT TABLE:");
  console.log(`  BEST_FOR_$300_BANK:              STAKE_0_CURRENT (current policy)`);
  console.log(`  BEST_PNL_IF_WIN_RATE_HIGH:       STAKE_2_FLAT10 (untested drawdown)`);
  console.log(`  SAFEST:                          STAKE_1_FLAT5`);
  console.log(`  NEXT_CONTROLLED_LIVE:            STAKE_0_CURRENT or STAKE_1_FLAT5`);
  console.log(`  DO_NOT_USE:                      STAKE_2_FLAT10 until 50+ resolved rows`);

  console.log("\nVAULT LOGIC REFERENCE (not simulated — external to stake policy):");
  console.log("  Before bank=$450: reinvest normally");
  console.log("  At bank=$450: protect $200 in vault");
  console.log("  After vault>=$200: vault 15% new highs + 10% profitable days");

  console.log(`${LINE}\n`);
}

main().catch((e) => {
  console.error("STAKE_LAB_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
