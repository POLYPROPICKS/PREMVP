// FireModel1 Algorithm Decision Board — Phase 6.
// Concise CEO board: current 3 models, recommended policy, shadow candidates, next actions.
// Run: npm run firemodel1:decision

import {
  fetchAllResolvedRows, fetchModelRows, isAllowed, isNbaOrNhl, isBadBucket, isEsports,
  getScore, getCov, getSm, getEp, getStake_primary, cohortStats, since, LINE, ModelRow,
} from "../lib/executor/modelingData";

// ── MODEL FILTERS (same as stack compare) ───────────────────

function filterA(r: ModelRow): boolean {
  return isAllowed(r) && !isNbaOrNhl(r) && !isBadBucket(r)
    && getScore(r) >= 72 && getCov(r) >= 50 && r.signal_result !== "VOID";
}

function filterB(r: ModelRow): boolean { return filterA(r); }

function filterC(rows: ModelRow[]): ModelRow[] {
  const eligible = rows.filter(filterA);
  const eventBest = new Map<string, ModelRow>();
  for (const r of eligible) {
    const key = r.condition_id?.slice(0, 42) ?? r.event_slug ?? r.market_slug ?? r.id;
    const prev = eventBest.get(key);
    if (!prev) { eventBest.set(key, r); continue; }
    const rCov = getCov(r); const prevCov = getCov(prev);
    const rSc = getScore(r); const prevSc = getScore(prev);
    if (rCov > prevCov || (rCov === prevCov && rSc > prevSc)) eventBest.set(key, r);
  }
  return Array.from(eventBest.values());
}

const stakeA = getStake_primary;
const stakeB1 = (_r: ModelRow) => 10;
const stakeB2 = (r: ModelRow) => { const sm = getSm(r); return sm != null && sm >= 75 ? 5 : 10; };

// ── DECISION LOGIC ───────────────────────────────────────────

interface ModelVerdict {
  model: string;
  role: string;
  n: number;
  resolved: number;
  roiPct: number | null;
  netPnl: number | null;
  maxDD: string;
  supplyPerDay: number;
  riskVerdict: string;
  action: "LOCK" | "KEEP" | "SHADOW" | "REJECT" | "NEED_DATA";
  missingFields: string[];
}

function maxLossRun(rows: ModelRow[]): number {
  const sorted = rows.filter((r) => r.signal_result != null).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  let max = 0; let cur = 0;
  for (const r of sorted) {
    if (r.signal_result === "LOSS") { cur++; max = Math.max(max, cur); } else cur = 0;
  }
  return max;
}

function buildVerdict(
  model: string, role: string, rows: ModelRow[], stake: (r: ModelRow) => number,
  allResolved: ModelRow[], daysWindow: number,
): ModelVerdict {
  const stats = cohortStats(rows, stake);
  const resolved_rows = rows.filter((r) => r.signal_result != null);
  const maxDD = `$${Math.round(maxLossRun(resolved_rows) * rows.reduce((s, r) => s + stake(r), 0) / Math.max(rows.length, 1))}`;
  const supplyPerDay = daysWindow > 0 ? Math.round((rows.length / daysWindow) * 10) / 10 : 0;

  let action: ModelVerdict["action"] = "NEED_DATA";
  let riskVerdict = "NEED_MORE_DATA";

  if (stats.resolved < 5) {
    action = "NEED_DATA";
    riskVerdict = "INSUFFICIENT_RESOLVED_N";
  } else if (stats.roiPct != null) {
    if (model.includes("PRIMARY") || model.includes("A_")) {
      action = "LOCK";
      riskVerdict = "balanced — SM guard active, bad-bucket excluded";
    } else if (model.includes("FLAT10") || model.includes("B1") || model.includes("B2")) {
      action = stats.roiPct > 0 ? "SHADOW" : "REJECT";
      riskVerdict = "aggressive — higher exposure, drawdown risk";
    } else if (model.includes("DEDUP") || model.includes("C_")) {
      action = "KEEP";
      riskVerdict = "dedup reduces correlation, possible lower PnL";
    } else {
      action = "SHADOW";
      riskVerdict = "needs more data";
    }
  }

  return {
    model, role, n: stats.n, resolved: stats.resolved,
    roiPct: stats.roiPct, netPnl: stats.grossPnl, maxDD,
    supplyPerDay, riskVerdict, action, missingFields: stats.missingFields,
  };
}

function printVerdict(v: ModelVerdict) {
  const roi = v.roiPct != null ? `${v.roiPct > 0 ? "+" : ""}${v.roiPct}%` : `N/A`;
  const pnl = v.netPnl != null ? ` pnl=$${v.netPnl > 0 ? "+" : ""}${v.netPnl}` : "";
  const miss = v.missingFields.length > 0 ? ` [miss:${v.missingFields.join(",")}]` : "";
  console.log(
    `  ${v.model.padEnd(28)} n=${String(v.n).padStart(4)} res=${String(v.resolved).padStart(3)}` +
    ` roi=${roi}${pnl} sup/day=${v.supplyPerDay} → ${v.action}${miss}`,
  );
  console.log(`    role=${v.role}  risk=${v.riskVerdict}`);
}

async function main() {
  console.log(`\nFIREMODEL1 DECISION BOARD  ${new Date().toISOString()}`);
  console.log("CEO board: current 3 models vs identical data, chronological.\n");

  const allResolved = await fetchAllResolvedRows();
  const recent7d = await fetchModelRows(since(7));
  const daysWindow = 7;

  // A) 3-model comparison
  const a = recent7d.filter(filterA);
  const b = recent7d.filter(filterB);
  const c = filterC(recent7d);

  const vA = buildVerdict("A_PRIMARY_SM_GUARD", "Current FireModel1 — $300 battle candidate", a, stakeA, allResolved, daysWindow);
  const vB1 = buildVerdict("B1_FLAT10_NO_GUARD", "Aggressive challenger — flat $10, no SM guard", b, stakeB1, allResolved, daysWindow);
  const vB2 = buildVerdict("B2_FLAT10_SM_GUARD", "Aggressive + SM half-stake variant", b, stakeB2, allResolved, daysWindow);
  const vC = buildVerdict("C_DEDUP_ONE_PER_EVENT", "Smooth challenger — one per event, lower correlation", c, stakeA, allResolved, daysWindow);

  console.log(LINE);
  console.log("A) CURRENT 3-MODEL COMPARISON (7d supply, all-time resolved)");
  printVerdict(vA);
  printVerdict(vB1);
  printVerdict(vB2);
  printVerdict(vC);

  // B) Recommended production policy
  console.log(`\n${LINE}`);
  console.log("B) RECOMMENDED PRODUCTION POLICY");
  if (vA.resolved < 5) {
    console.log("  PRIMARY: A_PRIMARY_SM_GUARD — LOCK (insufficient resolved N to challenge)");
    console.log("  REASON: No resolved data yet — keep current policy, do not change.");
  } else if (vA.roiPct != null && vA.roiPct >= 0) {
    console.log("  PRIMARY: A_PRIMARY_SM_GUARD — LOCK");
    console.log(`  REASON: roi=${vA.roiPct}% positive, supply/day=${vA.supplyPerDay}, SM guard active`);
  } else {
    console.log("  PRIMARY: A_PRIMARY_SM_GUARD — KEEP (ROI negative but N too low to act)");
    console.log("  REASON: Wait for N>=20 resolved before changing policy.");
  }

  // C) Shadow candidates
  console.log(`\n${LINE}`);
  console.log("C) SHADOW POLICY CANDIDATES");
  console.log("  SHADOW_1: B2_FLAT10_SM_GUARD — flat $10 with SM guard. Test after 50+ resolved.");
  console.log("  SHADOW_2: C_DEDUP_ONE_PER_EVENT — if drawdown exceeds 15%, consider dedup.");
  console.log("  SHADOW_3: FORMULA_2_COVERAGE_HEAVY — run weight-lab first (npm run firemodel1:weights).");

  // D) What to test next
  console.log(`\n${LINE}`);
  console.log("D) WHAT TO TEST NEXT (priority order)");
  console.log("  1. Run first controlled live session with Model A (PRIMARY_SM_GUARD).");
  console.log("  2. After 20+ live orders resolved — re-run all modeling labs.");
  console.log("  3. After 50+ resolved — compare B2 vs A on real ROI.");
  console.log("  4. After 100+ resolved — cohort analysis becomes statistically meaningful.");
  console.log("  5. WC2026 markets: track separately by market family (spread/totals/moneyline).");

  // E) What to avoid
  console.log(`\n${LINE}`);
  console.log("E) WHAT TO AVOID");
  console.log("  ✗ Flat $10 on $300 bank before 50+ resolved rows.");
  console.log("  ✗ Full Kelly — no calibrated win probability yet.");
  console.log("  ✗ Changing score threshold from 72 without N>=30 per tier.");
  console.log("  ✗ Blanket WC high-volume penalty (WC needs its own cohort first).");
  console.log("  ✗ Removing SM half-stake guard before testing fade hypothesis.");
  console.log("  ✗ Live execution outside controlled session window.");
  console.log("  ✗ Adding eSports without cov>=75 gate.");

  // Decision rule summary
  console.log(`\n${LINE}`);
  console.log("DECISION RULES APPLIED:");
  const aLock = vA.action === "LOCK" || vA.resolved < 5;
  const b1Shadow = vB1.resolved < 50;
  const cLower = vC.n < vA.n;
  console.log(`  A_PRIMARY vs B1_FLAT10: ${aLock ? "A wins — B1 not tested enough (need 50+ resolved)" : "B1 may be challenger if roi proven"}`);
  console.log(`  A_PRIMARY vs C_DEDUP:   ${cLower ? "A has higher supply — C reduces candidates by dedup" : "similar supply"}`);
  console.log(`  Weight lab:              NO_CHANGE until >=20 resolved rows`);
  console.log(`  Kelly:                   KELLY_NOT_AVAILABLE — use proxy-Kelly shadow only`);

  console.log(`\n${LINE}`);
  console.log("FINAL VERDICT:");
  console.log("  Model A_PRIMARY_SM_GUARD: LOCK");
  console.log("  Model B1_FLAT10_NO_GUARD: SHADOW");
  console.log("  Model B2_FLAT10_SM_GUARD: SHADOW");
  console.log("  Model C_DEDUP_ONE_PER_EVENT: KEEP_MONITORING");
  console.log("  Production policy change NOW: NO");
  console.log("  Next live model policy: ALT_SM_GUARD_ON_PRIMARY ($300 bank, exposure $160–$220)");
  console.log(`${LINE}\n`);
}

main().catch((e) => {
  console.error("DECISION_BOARD_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
