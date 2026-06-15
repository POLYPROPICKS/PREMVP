// FireModel1 Weight Function Lab — Phase 3.
// Shadow-tests formula variants. Does NOT change production formula.
// Run: npm run firemodel1:weights

import { fetchAllResolvedRows, isAllowed, isNbaOrNhl, isBadBucket, isWC, isEsports,
  getScore, getCov, getEp, getSm, getStake_primary, cohortStats, printCohort, LINE, ModelRow,
} from "../lib/executor/modelingData";

// ── FORMULA DEFINITIONS ──────────────────────────────────────
// Each formula: include(row) => boolean, shadow_score(row) => number

interface Formula {
  id: string;
  description: string;
  include: (r: ModelRow) => boolean;
  stake: (r: ModelRow) => number;
}

const base = (r: ModelRow) => isAllowed(r) && !isNbaOrNhl(r) && r.signal_result !== "VOID";

const F0_CURRENT: Formula = {
  id: "FORMULA_0_CURRENT",
  description: "Current FireModel1: score>=72 cov>=50 bad-bucket-excluded SM-half-stake",
  include: (r) => base(r) && getScore(r) >= 72 && getCov(r) >= 50 && !isBadBucket(r),
  stake: getStake_primary,
};

const F1_PRICE_SAFE: Formula = {
  id: "FORMULA_1_PRICE_SAFE",
  description: "Stronger price penalty: avoid >0.75 and 0.44-0.75 entirely, prefer <0.44",
  include: (r) => {
    const ep = getEp(r); if (ep == null) return false;
    if (ep > 0.75) return false; // stronger high-price penalty
    if (ep >= 0.44 && ep <= 0.75 && getCov(r) < 75) return false; // bad zone only ok with cov>=75
    return base(r) && getScore(r) >= 72 && getCov(r) >= 50;
  },
  stake: getStake_primary,
};

const F2_COVERAGE_HEAVY: Formula = {
  id: "FORMULA_2_COVERAGE_HEAVY",
  description: "Coverage>=75 required unless score>=80",
  include: (r) => {
    const cov = getCov(r); const sc = getScore(r);
    return base(r) && sc >= 72 && (cov >= 75 || (cov >= 50 && sc >= 80)) && !isBadBucket(r);
  },
  stake: (r) => {
    const base2 = getStake_primary(r);
    const cov = getCov(r);
    // boost: coverage>=75 gets full stake, cov50-74 capped at $5
    if (cov >= 75) return Math.min(base2, 10);
    return Math.min(base2, 5);
  },
};

const F3_SMART_FADE: Formula = {
  id: "FORMULA_3_SMART_FADE",
  description: "SM>=75 hard fade (exclude), SM50-74 neutral, SM<50 mild positive",
  include: (r) => {
    const sm = getSm(r);
    if (sm != null && sm >= 75) return false; // hard fade: skip entirely
    return base(r) && getScore(r) >= 72 && getCov(r) >= 50 && !isBadBucket(r);
  },
  stake: getStake_primary,
};

const F4_TIMING_PRIORITY: Formula = {
  id: "FORMULA_4_TIMING_PRIORITY",
  description: "0-60m full stake, 1-2h allowed, 2-3h only T1+cov>=75, >3h skip",
  include: (r) => {
    const g = r.diagnostics?.gameStartIso;
    if (!g || g === "null") return false;
    const h = (new Date(g).getTime() - Date.now()) / 3_600_000;
    if (h < 0) return false; // started
    if (h <= 2) return base(r) && getScore(r) >= 72 && getCov(r) >= 50 && !isBadBucket(r);
    if (h <= 3) return base(r) && getScore(r) >= 75 && getCov(r) >= 75 && !isBadBucket(r);
    return false; // >3h: skip in this variant
  },
  stake: getStake_primary,
};

const F5_WC_MARKET_FAMILY: Formula = {
  id: "FORMULA_5_WC_MARKET_FAMILY",
  description: "WC spread/totals allowed at lower price; WC moneyline price-capped at 0.70",
  include: (r) => {
    const ep = getEp(r); if (ep == null) return false;
    if (!base(r) || getScore(r) < 72 || getCov(r) < 50 || isBadBucket(r)) return false;
    if (isWC(r)) {
      const mref = (r.market_slug ?? "").toLowerCase();
      const isMoneyline = !(/spread|handicap|over|under|total|btts/i.test(mref));
      if (isMoneyline && ep > 0.70) return false; // cap WC ML at 0.70
      return true;
    }
    return true;
  },
  stake: getStake_primary,
};

const F6_COMPOSITE: Formula = {
  id: "FORMULA_6_COMPOSITE",
  description: "Composite: price-safe + coverage-heavy + timing-priority (non-overfit union)",
  include: (r) => {
    const ep = getEp(r); if (ep == null) return false;
    if (ep > 0.75 && getCov(r) < 75) return false; // F1 price rule
    if (getCov(r) < 50 || getScore(r) < 72) return false;
    if (isBadBucket(r) || isNbaOrNhl(r) || !isAllowed(r)) return false;
    const g = r.diagnostics?.gameStartIso;
    if (!g || g === "null") return false;
    const h = (new Date(g).getTime() - Date.now()) / 3_600_000;
    if (h < 0 || h > 6) return false; // F4 timing gate
    return true;
  },
  stake: (r) => {
    const base2 = getStake_primary(r);
    const cov = getCov(r);
    if (cov >= 75) return Math.min(base2, 10);
    return Math.min(base2, 7); // F2 coverage modifier
  },
};

const FORMULAS = [F0_CURRENT, F1_PRICE_SAFE, F2_COVERAGE_HEAVY, F3_SMART_FADE, F4_TIMING_PRIORITY, F5_WC_MARKET_FAMILY, F6_COMPOSITE];

async function main() {
  console.log(`\nFIREMODEL1 WEIGHT LAB  ${new Date().toISOString()}`);
  console.log("Shadow analysis only. Does NOT change production formula.\n");

  const rows = await fetchAllResolvedRows();
  // For timing formulas we also need unresolved to show supply
  const { fetchModelRows } = await import("../lib/executor/modelingData");
  const recent = await fetchModelRows(new Date(Date.now() - 7 * 86_400_000).toISOString(), 2000);

  const f0rows = recent.filter(F0_CURRENT.include);

  interface FormulaResult {
    id: string; desc: string; n: number; resolved: number;
    roiPct: number | null; winRate: number | null; grossPnl: number | null;
    missingFields: string[]; added: number; removed: number;
    avgScore: number | null; avgCov: number | null; avgEntry: number | null;
    verdict: string;
  }

  const results: FormulaResult[] = [];

  console.log(LINE);
  console.log("FORMULA COMPARISON (7d window + all-resolved)");

  for (const f of FORMULAS) {
    const included = recent.filter(f.include);
    const resolvedIncluded = rows.filter(f.include);
    const stats = cohortStats(resolvedIncluded, f.stake);

    const f0set = new Set(f0rows.map((r) => r.id));
    const fset = new Set(included.map((r) => r.id));
    const added = included.filter((r) => !f0set.has(r.id)).length;
    const removed = f0rows.filter((r) => !fset.has(r.id)).length;

    let verdict = "SHADOW_ONLY";
    if (f.id === "FORMULA_0_CURRENT") verdict = "LOCK (current production)";
    else if (stats.resolved < 10 || stats.roiPct == null) verdict = "NEED_MORE_DATA";
    else if (stats.roiPct > 0 && added > 0 && removed < f0rows.length * 0.3) verdict = "CANDIDATE";
    else if (removed > f0rows.length * 0.5 && stats.resolved < 20) verdict = "REDUCES_SUPPLY";

    results.push({
      id: f.id, desc: f.description, n: included.length, resolved: resolvedIncluded.length,
      roiPct: stats.roiPct, winRate: stats.winRate, grossPnl: stats.grossPnl,
      missingFields: stats.missingFields, added, removed,
      avgScore: stats.avgScore, avgCov: stats.avgCov, avgEntry: stats.avgEntry,
      verdict,
    });

    console.log(`\n  ${f.id}`);
    console.log(`  ${f.description}`);
    printCohort("  result", stats);
    console.log(`  added=${added} removed=${removed} verdict=${verdict}`);
    if (stats.roiPct == null) {
      console.log(`  ROI_NOT_AVAILABLE: missing ${stats.missingFields.join(",")}`);
    }
  }

  console.log(`\n${LINE}`);
  console.log("TOP 3 FORMULA CANDIDATES (by data confidence):");
  const ranked = results
    .filter((r) => r.id !== "FORMULA_0_CURRENT")
    .sort((a, b) => {
      if (a.roiPct != null && b.roiPct != null) return b.roiPct - a.roiPct;
      if (a.resolved !== b.resolved) return b.resolved - a.resolved;
      return b.n - a.n;
    });
  for (const r of ranked.slice(0, 3)) {
    console.log(`  ${r.id.padEnd(30)} verdict=${r.verdict} n=${r.n} added=${r.added} removed=${r.removed}`);
  }

  console.log("\nANTI-OVERFIT GATES CHECK:");
  for (const r of results) {
    if (r.id === "FORMULA_0_CURRENT") continue;
    const issues: string[] = [];
    if (r.resolved < 20) issues.push("N_TOO_LOW");
    if (r.removed > f0rows.length * 0.4) issues.push("REDUCES_SUPPLY_TOO_MUCH");
    if (r.n < 5) issues.push("SUPPLY_BELOW_5_DAY");
    console.log(`  ${r.id.padEnd(30)} ${issues.length ? issues.join(", ") : "OK"}`);
  }

  console.log("\nRECOMMENDED NEXT PRODUCTION CHANGE:");
  const anyReady = results.some((r) => r.verdict === "CANDIDATE");
  console.log(`  ${anyReady ? "SHADOW_ONLY (verify with >=20 resolved rows first)" : "NO_CHANGE"}`);
  console.log(`${LINE}\n`);
}

main().catch((e) => {
  console.error("WEIGHT_LAB_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
