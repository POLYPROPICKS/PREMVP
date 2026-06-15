// FireModel1 3-Model Stack Comparison — Phase 2.
// Compares ALT_SM_GUARD_ON_PRIMARY vs ALT3_FLAT10_RAW_PROFIT vs ALT1_ONE_PER_EVENT_BEST_COVERAGE
// on identical data, identical chronology, identical cost assumptions.
// Run: npm run firemodel1:stack

import { fetchModelRows, fetchAllResolvedRows, isAllowed, isNbaOrNhl, isBadBucket, isEsports,
  getScore, getCov, getSm, getStake_primary, cohortStats, printCohort, since, LINE, ModelRow,
} from "../lib/executor/modelingData";

// ── MODEL DEFINITIONS ────────────────────────────────────────

// MODEL_A: Primary SM Guard (FireModel1 current)
function filterA(r: ModelRow): boolean {
  return isAllowed(r) && !isNbaOrNhl(r) && !isBadBucket(r)
    && getScore(r) >= 72 && getCov(r) >= 50
    && r.signal_result !== "VOID";
}
const stakeA = getStake_primary;

// MODEL_B1: Aggressive Flat $10, no SM guard
function filterB(r: ModelRow): boolean { return filterA(r); }
const stakeB1 = (_r: ModelRow) => 10;
const stakeB2 = (r: ModelRow) => { const sm = getSm(r); return sm != null && sm >= 75 ? 5 : 10; };

// MODEL_C: Dedup one-per-event (highest coverage then score)
function filterC(rows: ModelRow[]): ModelRow[] {
  const eligible = rows.filter(filterA);
  const eventBest = new Map<string, ModelRow>();
  for (const r of eligible) {
    const eventKey = r.condition_id?.slice(0, 42) ?? r.event_slug ?? r.market_slug ?? r.id;
    const prev = eventBest.get(eventKey);
    if (!prev) { eventBest.set(eventKey, r); continue; }
    const prevCov = getCov(prev); const rCov = getCov(r);
    const prevSc = getScore(prev); const rSc = getScore(r);
    if (rCov > prevCov || (rCov === prevCov && rSc > prevSc)) eventBest.set(eventKey, r);
  }
  return Array.from(eventBest.values());
}

// MODEL_D: Baseline V1 (primary + include NBA/NHL as shadow info only, mark)
function filterD(r: ModelRow): boolean {
  return isAllowed(r) && !isBadBucket(r) && getScore(r) >= 72 && getCov(r) >= 50;
}

// ── WINDOW RUNNER ────────────────────────────────────────────
interface ModelMetrics {
  label: string; n: number; resolved: number; wins: number; losses: number;
  roiPct: number | null; grossPnl: number | null; totalStake: number;
  winRate: number | null; avgEntry: number | null; missingFields: string[];
  maxLossRun: number; supply: number; daysWithData: number;
}

function calcMaxLossRun(rows: ModelRow[]): number {
  const resolved = rows.filter((r) => r.signal_result != null).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  let maxRun = 0; let cur = 0;
  for (const r of resolved) {
    if (r.signal_result === "LOSS") { cur++; maxRun = Math.max(maxRun, cur); } else cur = 0;
  }
  return maxRun;
}

function modelMetrics(label: string, rows: ModelRow[], stakeFunc: (r: ModelRow) => number): ModelMetrics {
  const c = cohortStats(rows, stakeFunc);
  const days = new Set(rows.map((r) => r.created_at.slice(0, 10))).size;
  return {
    label, n: c.n, resolved: c.resolved, wins: c.wins, losses: c.losses,
    roiPct: c.roiPct, grossPnl: c.grossPnl, totalStake: c.totalStake,
    winRate: c.winRate, avgEntry: c.avgEntry, missingFields: c.missingFields,
    maxLossRun: calcMaxLossRun(rows), supply: c.n, daysWithData: days,
  };
}

function printModelRow(m: ModelMetrics) {
  const roi = m.roiPct != null ? `${m.roiPct > 0 ? "+" : ""}${m.roiPct}%` : `N/A(${m.missingFields[0] ?? "?"})`;
  const pnl = m.grossPnl != null ? ` pnl=${m.grossPnl > 0 ? "+" : ""}$${m.grossPnl}` : "";
  const wr = m.winRate != null ? `WR=${m.winRate}%` : "WR=N/A";
  const warn = m.resolved < 10 ? "⚠N<10" : "";
  console.log(
    `  ${m.label.padEnd(28)} n=${String(m.n).padStart(4)} res=${m.resolved} ${wr}` +
    ` roi=${roi}${pnl} stake=$${m.totalStake} maxLoss=${m.maxLossRun} ${warn}`,
  );
}

async function runWindow(label: string, rows: ModelRow[], allResolved: ModelRow[]) {
  console.log(`\n${LINE}`);
  console.log(`WINDOW: ${label}  (${rows.length} total rows in window)`);

  const windowIds = new Set(rows.map((r) => r.id));
  const resolvedInWindow = allResolved.filter((r) => windowIds.has(r.id));

  const a = rows.filter(filterA);
  const b = rows.filter(filterB);
  const c = filterC(rows);
  const d = rows.filter(filterD);

  printModelRow(modelMetrics("A_PRIMARY_SM_GUARD", a, stakeA));
  printModelRow(modelMetrics("B1_FLAT10_NO_GUARD", b, stakeB1));
  printModelRow(modelMetrics("B2_FLAT10_SM_GUARD", b, stakeB2));
  printModelRow(modelMetrics("C_DEDUP_ONE_PER_EVENT", c, stakeA));
  printModelRow(modelMetrics("D_BASELINE_INCL_NBA", d, stakeA));

  // Cost stress on Model A
  if (a.length > 0) {
    const ares = a.filter((r) => r.signal_result != null && r.realized_return_pct != null);
    if (ares.length > 0) {
      console.log(`\n  COST STRESS (Model A, ${ares.length} resolved):`);
      for (const slip of [0, 0.01, 0.02, 0.04, 0.08]) {
        const adj = ares.reduce((s, r) => s + (r.realized_return_pct ?? 0) - slip * 100, 0) / ares.length;
        const be = ares.reduce((s, r) => s + (r.realized_return_pct ?? 0), 0) / ares.length / 100;
        console.log(`    slip=+${(slip * 100).toFixed(0)}c  adj_roi=${adj > 0 ? "+" : ""}${adj.toFixed(1)}%  breakeven_slip=${be.toFixed(3)}`);
      }
    } else {
      console.log(`  COST_STRESS: ROI_NOT_AVAILABLE: missing realized_return_pct`);
    }
  }

  // Holdout note
  const nResolved = resolvedInWindow.length;
  if (nResolved < 100) {
    console.log(`  HOLDOUT_NOT_ENOUGH_N: ${nResolved} resolved (need >=100)`);
  }

  void resolvedInWindow; // may use in future
}

async function main() {
  console.log(`\nFIREMODEL1 3-MODEL STACK COMPARE  ${new Date().toISOString()}`);
  console.log("Models: A=Primary_SM_Guard  B1=Flat10_NoGuard  B2=Flat10_SMGuard  C=Dedup1PerEvent  D=Baseline");

  const allResolved = await fetchAllResolvedRows();
  const windows = [
    { label: "all-available", rows: allResolved },
    { label: "7d", rows: await fetchModelRows(since(7)) },
    { label: "96h", rows: await fetchModelRows(since(4)) },
    { label: "48h", rows: await fetchModelRows(since(2)) },
    { label: "24h", rows: await fetchModelRows(since(1)) },
  ];

  for (const { label, rows } of windows) {
    await runWindow(label, rows, allResolved);
  }

  console.log(`\n${LINE}`);
  console.log("RECOMMENDATION (pending ROI data):");
  console.log("  A_PRIMARY_SM_GUARD: LOCK (balanced risk/reward, SM guard active)");
  console.log("  B1_FLAT10_NO_GUARD: SHADOW (aggressive PnL, untested drawdown)");
  console.log("  B2_FLAT10_SM_GUARD: SHADOW (less aggressive B1 variant)");
  console.log("  C_DEDUP_ONE_PER_EVENT: KEEP_MONITORING (lower correlation risk)");
  console.log("  D_BASELINE_INCL_NBA: REFERENCE_ONLY");
  console.log(`${LINE}\n`);
}

main().catch((e) => {
  console.error("STACK_COMPARE_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
