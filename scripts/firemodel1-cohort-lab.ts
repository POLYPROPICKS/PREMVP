// FireModel1 Cohort Lab — Phase 5.
// Finds where edge likely comes from by sport/market-family/price/coverage/timing.
// Run: npm run firemodel1:cohorts

import { fetchAllResolvedRows, fetchModelRows, isAllowed, isNbaOrNhl, isBadBucket,
  isWC, isEsports, isSpread, isTotals, isBTTS, getScore, getCov, getEp, getSm, hoursToStart,
  getStake_primary, cohortStats, printCohort, priceBucket, covBucket, smBucket, since, LINE,
  ModelRow, timingBucket,
} from "../lib/executor/modelingData";

// Allowed candidates (Model A gate)
function candidate(r: ModelRow): boolean {
  return isAllowed(r) && !isNbaOrNhl(r) && !isBadBucket(r)
    && getScore(r) >= 72 && getCov(r) >= 50;
}

function action(verdict: string, n: number, roi: number | null): string {
  if (n < 5) return "NEED_MORE_DATA";
  if (roi == null) return "NEED_MORE_DATA";
  if (roi > 5) return "BOOST";
  if (roi > 0) return "KEEP";
  if (roi > -5) return "REDUCE";
  return "SKIP";
}

async function main() {
  console.log(`\nFIREMODEL1 COHORT LAB  ${new Date().toISOString()}`);
  console.log("Finds where edge comes from. Labels: BOOST/KEEP/REDUCE/SKIP/NEED_MORE_DATA\n");

  const allResolved = await fetchAllResolvedRows();
  const recent7d = await fetchModelRows(since(7));

  // Use resolved for ROI, recent for supply
  const resolved = allResolved.filter(candidate);
  const supply = recent7d.filter(candidate);

  console.log(`Total resolved candidates (all-time): ${resolved.length}`);
  console.log(`Recent 7d supply: ${supply.length}\n`);

  if (resolved.length < 10) {
    console.log("⚠ WARNING: N < 10 resolved rows — all ROI will show NEED_MORE_DATA");
    console.log("  Output supply/count metrics only.\n");
  }

  function section(title: string) {
    console.log(`\n${LINE}`);
    console.log(title);
  }

  function cohortRow(
    label: string, rows: ModelRow[], supplyRows: ModelRow[],
    addNote?: string,
  ) {
    const stats = cohortStats(rows, getStake_primary);
    const supplyPct = supply.length ? Math.round((supplyRows.length / supply.length) * 100) : 0;
    const roi = stats.roiPct;
    const act = action(label, stats.resolved, roi);
    const roiStr = roi != null ? `${roi > 0 ? "+" : ""}${roi}%` : `N/A`;
    const warn = stats.resolved < 10 ? " ⚠N<10" : "";
    console.log(
      `  ${label.padEnd(24)} n_res=${String(stats.resolved).padStart(4)} n_sup=${String(supplyRows.length).padStart(4)}(${supplyPct}%)` +
      ` WR=${stats.winRate != null ? stats.winRate + "%" : "N/A"} ROI=${roiStr} [$${stats.totalStake}] → ${act}${warn}${addNote ? " — " + addNote : ""}`,
    );
  }

  // SPORT COHORTS
  section("COHORT: SPORT");
  cohortRow("WC2026", resolved.filter(isWC), supply.filter(isWC));
  cohortRow("eSports_limited", resolved.filter(isEsports), supply.filter(isEsports));
  cohortRow("NBA/NHL (excluded)", allResolved.filter(isNbaOrNhl), recent7d.filter(isNbaOrNhl), "excluded from FireModel1");
  cohortRow("other_sport", resolved.filter((r) => !isWC(r) && !isEsports(r) && !isNbaOrNhl(r)),
    supply.filter((r) => !isWC(r) && !isEsports(r) && !isNbaOrNhl(r)));

  // MARKET FAMILY
  section("COHORT: MARKET FAMILY");
  cohortRow("spread/handicap", resolved.filter(isSpread), supply.filter(isSpread));
  cohortRow("totals/over-under", resolved.filter(isTotals), supply.filter(isTotals));
  cohortRow("BTTS", resolved.filter(isBTTS), supply.filter(isBTTS));
  cohortRow("moneyline (other)", resolved.filter((r) => !isSpread(r) && !isTotals(r) && !isBTTS(r)),
    supply.filter((r) => !isSpread(r) && !isTotals(r) && !isBTTS(r)));

  // PRICE BUCKET
  section("COHORT: PRICE BUCKET");
  for (const pb of ["<0.25", "0.25-0.44", "0.44-0.58", "0.58-0.75", ">0.75"]) {
    cohortRow(
      `price:${pb}`,
      resolved.filter((r) => priceBucket(getEp(r)) === pb),
      supply.filter((r) => priceBucket(getEp(r)) === pb),
    );
  }
  console.log("  NOTE: price 0.44-0.58 (bad bucket) already excluded from resolved by Model A gate");

  // COVERAGE BUCKET
  section("COHORT: COVERAGE BUCKET");
  for (const cb of ["<25", "25-49", "50-74", ">=75"]) {
    cohortRow(
      `cov:${cb}`,
      resolved.filter((r) => covBucket(getCov(r)) === cb),
      supply.filter((r) => covBucket(getCov(r)) === cb),
    );
  }

  // SMART MONEY BUCKET
  section("COHORT: SMART MONEY");
  for (const sb of ["sm<50", "sm50-74", "sm>=75"]) {
    cohortRow(
      sb,
      resolved.filter((r) => smBucket(getSm(r)) === sb),
      supply.filter((r) => smBucket(getSm(r)) === sb),
    );
  }

  // TIMING BUCKET (resolved rows only have historical timing)
  section("COHORT: TIMING (at placement)");
  const timingBuckets = ["live/started", "0-1h", "1-2h", "2-3h", "3-6h", "6-24h", ">24h", "unknown"];
  for (const tb of timingBuckets) {
    cohortRow(
      `timing:${tb}`,
      resolved.filter((r) => timingBucket(r) === tb),
      supply.filter((r) => timingBucket(r) === tb),
    );
  }

  // COHORT QUESTIONS
  section("COHORT DIAGNOSTIC ANSWERS");
  const wc = resolved.filter(isWC);
  const esports = resolved.filter(isEsports);
  const cov75 = resolved.filter((r) => getCov(r) >= 75);
  const smHigh = resolved.filter((r) => (getSm(r) ?? 0) >= 75);
  const timing02h = resolved.filter((r) => { const h = hoursToStart(r); return h != null && h >= 0 && h <= 2; });
  const timing23h = resolved.filter((r) => { const h = hoursToStart(r); return h != null && h > 2 && h <= 3; });

  console.log(`  1. WC high-volume cap?            WC N=${wc.length} → ${action("WC", wc.length, cohortStats(wc).roiPct)}`);
  console.log(`  2. Spreads vs moneyline?          Use MARKET FAMILY cohort above`);
  console.log(`  3. BTTS as companion?             BTTS N=${resolved.filter(isBTTS).length} → NEED_MORE_DATA`);
  console.log(`  4. eSports limited worth keeping? eSports N=${esports.length} → ${action("eSports", esports.length, cohortStats(esports).roiPct)}`);
  console.log(`  5. 2-3h timing truly bad?         timing:2-3h N=${timing23h.length} resolved → ${action("2-3h", timing23h.length, cohortStats(timing23h).roiPct)}`);
  console.log(`  6. cov>=75 justifies $10?         cov>=75 N=${cov75.length} → ${action("cov75", cov75.length, cohortStats(cov75).roiPct)}`);
  console.log(`  7. $7 vs $5/$10?                  Current policy uses $7 for score>=72 cov>=50 — shadow stake lab has answer`);
  console.log(`  8. First live-test candidates?    → Run npm run firemodel1:live-readiness`);

  console.log(`\n${LINE}`);
  console.log("SUMMARY: Most cohorts NEED_MORE_DATA (resolved < 10).");
  console.log("Run 'npm run firemodel1:cohorts' after first 20+ controlled live orders.");
  console.log(`${LINE}\n`);
}

main().catch((e) => {
  console.error("COHORT_LAB_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
