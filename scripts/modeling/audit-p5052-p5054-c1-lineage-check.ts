/**
 * READ-ONLY audit script. Not part of PR #409. Does not touch
 * football-structural-authority.ts, the denominator scripts, or their
 * committed evidence. Reuses (imports, never reimplements):
 *   - runReconciliationV2 / RANGE_* / SEP_* (build-football-denominator-reconciliation-v2.ts)
 *   - buildStructuralCandidates / isOrdinaryHold / marketBucketOf / connectClone
 *     (football-structural-authority.ts)
 *   - runStandaloneStrict / settledBetsOnly / metricsFor (daily-portfolio-frontier.ts)
 *
 * Purpose: rebuild P50_52/P50_54/C1 football economics post PR#409's
 * fail-closed isOrdinaryHold fix, quantify unresolved-market-type
 * contamination in the OLD (pre-fix-style, no isOrdinaryHold filter)
 * selection, replay a MONEYLINE/TOTALS/SPREADS 0.50-0.54 "current live
 * policy" over resolved-only history, and run within-event sibling
 * statistics. Writes only to modeling/evidence/p5052-p5054-c1-lineage-audit-v1/.
 *
 *   npx tsx scripts/modeling/audit-p5052-p5054-c1-lineage-check.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  runReconciliationV2,
  RANGE_START,
  RANGE_END,
  AUG_END,
  SEP_START,
  SEP_1_12_END,
  SEP_13_24_START,
} from "./build-football-denominator-reconciliation-v2";
import {
  buildStructuralCandidates,
  isOrdinaryHold,
  marketBucketOf,
  connectClone,
  displayOdds,
  type StructuralCandidate,
} from "./football-structural-authority";
import {
  runStandaloneStrict,
  settledBetsOnly,
  metricsFor,
  type SelectedCandidate,
} from "./daily-portfolio-frontier";
import type { EvaluatedEvent } from "@/lib/modeling/research-engine";
import type { DecisionTimeCandidate } from "./factor-atlas";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

const OUT_DIR = "modeling/evidence/p5052-p5054-c1-lineage-audit-v1";

// New narrower sub-periods requested by this mission, carved out of SEP_13_24.
const SEP_13_20_END = "2026-09-20";
const SEP_21_24_START = "2026-09-21";

type ExtPeriodId = "AUG" | "SEP_1_12" | "SEP_13_20" | "SEP_21_24" | "SEP_13_24" | "COMBINED_RESOLVED_ONLY";

function periodOfExt(modelDate: string): "AUG" | "SEP_1_12" | "SEP_13_20" | "SEP_21_24" {
  if (modelDate <= AUG_END) return "AUG";
  if (modelDate <= SEP_1_12_END) return "SEP_1_12";
  if (modelDate <= SEP_13_20_END) return "SEP_13_20";
  return "SEP_21_24";
}

function candidatesFor(all: StructuralCandidate[], period: ExtPeriodId): StructuralCandidate[] {
  if (period === "COMBINED_RESOLVED_ONLY") {
    return all.filter((c) => {
      const p = periodOfExt(c.modelDate);
      return p === "AUG" || p === "SEP_13_20" || p === "SEP_21_24";
    });
  }
  if (period === "SEP_13_24") {
    return all.filter((c) => c.modelDate >= SEP_13_24_START && c.modelDate <= RANGE_END);
  }
  return all.filter((c) => periodOfExt(c.modelDate) === period);
}

const round = (v: number, dp = 4) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

interface RowReport {
  PERIOD: string;
  SELECTED_N: number;
  SETTLED_N: number;
  OPEN_N: number;
  OTHER_NONTERMINAL_N: number;
  WINS: number;
  LOSSES: number;
  HIT_RATE_PCT: number | null;
  AVG_ENTRY_PRICE: number | null;
  AVG_DECIMAL_ODDS: number | null;
  BREAKEVEN_HIT_RATE_PCT: number | null;
  REFERENCE_PNL_U: number;
  REFERENCE_ROI_PCT: number;
  MAX_DD_U: number;
  UNRESOLVED_MARKET_TYPE_EXCLUDED_N: number;
}

function computeRow(
  periodLabel: string,
  periodCandidates: StructuralCandidate[],
  settlement: Map<string, CorpusLabel>,
  priceBandPredicate: (e: StructuralCandidate) => boolean,
  enforceOrdinaryHold: boolean,
): RowReport {
  // How many soccer rows in this price band would be admitted WITHOUT the
  // fail-closed filter but ARE unresolved market type (contamination probe;
  // never itself used to select anything).
  const unresolvedInBand = periodCandidates.filter(
    (c) => priceBandPredicate(c) && marketBucketOf(c.marketTypeRaw) === "UNRESOLVED",
  ).length;

  const predicate = (e: EvaluatedEvent & DecisionTimeCandidate) => {
    const sc = e as unknown as StructuralCandidate;
    if (enforceOrdinaryHold && !isOrdinaryHold(sc.marketTypeRaw)) return false;
    return priceBandPredicate(sc);
  };
  const selected: SelectedCandidate[] = runStandaloneStrict(periodCandidates, predicate as any);
  const { settledBets, openN, otherNonterminalN } = settledBetsOnly(selected, settlement);
  const m = metricsFor(settledBets);
  const avgEntryPrice = selected.length ? selected.reduce((a, c) => a + c.entryPrice, 0) / selected.length : null;
  const avgDecOdds = avgEntryPrice ? 1 / avgEntryPrice : null;
  const hitRate = m.wins + m.losses > 0 ? round((m.wins / (m.wins + m.losses)) * 100, 2) : null;

  // Selected-set contamination: how many of THIS predicate's actual selected
  // bets sit on an unresolved-market-type row (only non-zero when
  // enforceOrdinaryHold=false, since isOrdinaryHold already excludes them).
  const marketTypeByIdentity = new Map<string, string | null>();
  for (const c of periodCandidates) marketTypeByIdentity.set(c.candidateIdentity, c.marketTypeRaw);
  const selectedUnresolvedN = selected.filter((s) => marketBucketOf(marketTypeByIdentity.get(s.candidateIdentity) ?? null) === "UNRESOLVED").length;

  return {
    PERIOD: periodLabel,
    SELECTED_N: selected.length,
    SETTLED_N: settledBets.length,
    OPEN_N: openN,
    OTHER_NONTERMINAL_N: otherNonterminalN,
    WINS: m.wins,
    LOSSES: m.losses,
    HIT_RATE_PCT: hitRate,
    AVG_ENTRY_PRICE: avgEntryPrice === null ? null : round(avgEntryPrice, 4),
    AVG_DECIMAL_ODDS: avgDecOdds === null ? null : round(avgDecOdds, 4),
    BREAKEVEN_HIT_RATE_PCT: avgDecOdds ? round((1 / avgDecOdds) * 100, 2) : null,
    REFERENCE_PNL_U: round(m.pnl_u, 2),
    REFERENCE_ROI_PCT: round(m.roi_pct, 2),
    MAX_DD_U: round(m.max_drawdown_u, 2),
    UNRESOLVED_MARKET_TYPE_EXCLUDED_N: enforceOrdinaryHold ? unresolvedInBand : selectedUnresolvedN,
  };
}

async function main() {
  const db = await connectClone();
  const recon = await runReconciliationV2(db);
  const { candidates, settlementByCandidateIdentity } = buildStructuralCandidates(recon.sourceRows, recon.overlay);

  const PERIODS: ExtPeriodId[] = ["AUG", "SEP_1_12", "SEP_13_20", "SEP_21_24", "COMBINED_RESOLVED_ONLY"];

  const bands: Record<string, (c: StructuralCandidate) => boolean> = {
    P50_52: (c) => c.entryPrice >= 0.5 && c.entryPrice < 0.52,
    P50_54: (c) => c.entryPrice >= 0.5 && c.entryPrice < 0.54,
    C1: (c) => c.entryPrice >= 0.5 && c.entryPrice < 0.6,
  };

  // TASK 1: SAFE (isOrdinaryHold-enforced) rebuild, per model per period.
  const task1: Record<string, RowReport[]> = {};
  for (const [modelId, band] of Object.entries(bands)) {
    task1[modelId] = PERIODS.map((p) => computeRow(p, candidatesFor(candidates, p), settlementByCandidateIdentity, band, true));
  }

  // TASK 2: OLD-STYLE (no isOrdinaryHold filter — matches
  // football-verification-review-a.ts's actual predicate, which never calls
  // isOrdinaryHold) selection, COMBINED over the full v2 range (AUG+SEP_1_12+SEP_13_24),
  // to compare against the previously reported old figures and quantify contamination.
  const fullRangeCandidates = candidates; // buildStructuralCandidates already = full AUG..SEP_13_24 range, soccer only
  const task2: Record<string, RowReport> = {};
  for (const [modelId, band] of Object.entries(bands)) {
    task2[modelId] = computeRow("OLD_STYLE_COMBINED_AUG_SEP1_12_SEP13_24_NO_MARKET_TYPE_FILTER", fullRangeCandidates, settlementByCandidateIdentity, band, false);
  }

  // TASK 3: current live policy replay — FOOTBALL, price 0.50-0.54,
  // MONEYLINE/TOTALS/SPREADS only, resolved periods only (AUG/SEP_13_20/SEP_21_24).
  const livePriceBand = (c: StructuralCandidate) => c.entryPrice >= 0.5 && c.entryPrice < 0.54;
  const liveFamilies = new Set(["moneyline", "totals", "spreads"]);
  const liveBandAllFamilies = (c: StructuralCandidate) => isOrdinaryHold(c.marketTypeRaw) && livePriceBand(c);
  const liveBandFamily = (fam: string) => (c: StructuralCandidate) => marketBucketOf(c.marketTypeRaw) === fam && livePriceBand(c);

  const resolvedCandidates = candidatesFor(candidates, "COMBINED_RESOLVED_ONLY");
  const task3Total = computeRow("CURRENT_LIVE_POLICY_RESOLVED_HISTORY", resolvedCandidates, settlementByCandidateIdentity, liveBandAllFamilies, false);
  const task3ByFamily: Record<string, RowReport> = {};
  for (const fam of liveFamilies) {
    task3ByFamily[fam] = computeRow(`CURRENT_LIVE_POLICY_${fam.toUpperCase()}`, resolvedCandidates, settlementByCandidateIdentity, liveBandFamily(fam), false);
  }
  const activeDaysResolved = new Set(resolvedCandidates.map((c) => c.modelDate)).size;
  const eventsPerDay = {
    TOTAL: activeDaysResolved ? round(task3Total.SELECTED_N / activeDaysResolved, 3) : null,
  };

  // TASK 4: within-event sibling stats, over the resolved corpus, ALL soccer
  // candidates (not just the live-band selection) grouped by physicalEventKey.
  function siblingStats(pop: StructuralCandidate[]) {
    const byEvent = new Map<string, StructuralCandidate[]>();
    for (const c of pop) {
      const arr = byEvent.get(c.physicalEventKey);
      if (arr) arr.push(c);
      else byEvent.set(c.physicalEventKey, [c]);
    }
    let ge2Identities = 0;
    let anyBandToken = 0;
    let ge2BandTokens = 0;
    const inOddsBand = (c: StructuralCandidate) => {
      const o = displayOdds(c.entryPrice);
      return o >= 1.75 && o < 2.0;
    };
    for (const rows of byEvent.values()) {
      const distinctIdentities = new Set(rows.map((r) => r.candidateIdentity)).size;
      if (distinctIdentities >= 2) ge2Identities++;
      const bandRows = rows.filter(inOddsBand);
      if (bandRows.length >= 1) anyBandToken++;
      if (bandRows.length >= 2) ge2BandTokens++;
    }
    return {
      EVENT_N: byEvent.size,
      EVENTS_WITH_GE2_IDENTITIES: ge2Identities,
      EVENTS_WITH_ANY_1_75_2_00_TOKEN: anyBandToken,
      EVENTS_WITH_GE2_1_75_2_00_TOKENS: ge2BandTokens,
    };
  }
  const task4Resolved = siblingStats(resolvedCandidates);
  const task4LiveBand = siblingStats(resolvedCandidates.filter(liveBandAllFamilies));

  // 45% sanity check.
  const sanity = [1.85, 1.92, 2.0].map((odds) => {
    const hit = 0.45;
    const ev = hit * (odds - 1) - (1 - hit);
    return { ODDS: odds, HIT_RATE: hit, EXPECTED_ROI_PCT: round(ev * 100, 4) };
  });

  const report = {
    MISSION: "P50_52_P50_54_C1_LINEAGE_AUDIT_V1",
    NOT_EXECUTION_AUTHORITY: true,
    RANGE_AVAILABLE_IN_CLONE: `${RANGE_START}..${RANGE_END}`,
    PERIOD_DEFINITIONS: {
      AUG: `${RANGE_START}..${AUG_END}`,
      SEP_1_12: `${SEP_START}..${SEP_1_12_END} (UNAVAILABLE_DUE_TO_MARKET_TYPE_LINEAGE for market-type-gated economics)`,
      SEP_13_20: `${SEP_13_24_START}..${SEP_13_20_END}`,
      SEP_21_24: `${SEP_21_24_START}..${RANGE_END}`,
      COMBINED_RESOLVED_ONLY: "AUG + SEP_13_20 + SEP_21_24 (SEP_1_12 excluded, not fabricated)",
    },
    TASK1_SAFE_REBUILD: task1,
    TASK2_OLD_STYLE_VS_REPORTED: {
      REPORTED_OLD_FIGURES_UNVERIFIED_INPUT: {
        P50_54: { SELECTED_N: 1231, SETTLED_N: 861, PNL_U: 158.57, ROI_PCT: 18.4 },
        P50_52: { SELECTED_N: 1023, SETTLED_N: 702, PNL_U: 148.59, ROI_PCT: 21.2 },
        C1: { SELECTED_N: 1592, SETTLED_N: 1062, PNL_U: 141.5, ROI_PCT: 13.3 },
      },
      RECOMPUTED_OLD_STYLE_NO_MARKET_TYPE_FILTER: task2,
    },
    TASK3_CURRENT_LIVE_POLICY_REPLAY: {
      TOTAL: task3Total,
      BY_FAMILY: task3ByFamily,
      ACTIVE_DAYS_RESOLVED: activeDaysResolved,
      EVENTS_PER_DAY: eventsPerDay,
    },
    TASK4_SIBLING_SELECTION: {
      RESOLVED_CORPUS_ALL_SOCCER_ROWS: task4Resolved,
      RESOLVED_CORPUS_LIVE_BAND_ORDINARY_ONLY: task4LiveBand,
      SELECTION_RULE_HISTORICAL: "runStandaloneStrict (scripts/modeling/daily-portfolio-frontier.ts): all candidates sorted chronologically by decisionTimestamp across the WHOLE window; for each physicalEventKey, the FIRST (earliest-observed) row that satisfies the predicate claims that event's one slot for the model; every later-observed row for the same event, even a higher-odds or different-market sibling, is discarded.",
      SELECTION_RULE_LIVE_EXECUTOR: "lib/executor/buildFireModelCandidates.ts, final candidates.sort() (~line 2602): candidates.sort((a,b) => TIER_ORDER[a.strategy]-TIER_ORDER[b.strategy] || b.diagnostics.score-a.diagnostics.score || a.diagnostics.hours_to_start_now-a.diagnostics.hours_to_start_now) -- ranks by strategy tier, then DESCENDING diagnostics.score, then soonest-to-start; duplicate slots per match_family_key are resolved by this ranking, not by earliest-observation-wins.",
      DO_HISTORICAL_AND_LIVE_SELECT_SAME_SIBLING_RULE: "NO",
      FIRST_EXACT_CODE_LEVEL_DIFFERENCE: "runStandaloneStrict claims a physicalEventKey slot for the FIRST chronologically-observed qualifying row (time-of-observation priority); buildFireModelCandidates.ts's final sort ranks candidates by strategy TIER_ORDER then descending diagnostics.score then soonest hours_to_start_now (quality/urgency priority), with no chronological-first-observation rule at all.",
    },
    SANITY_CHECK_45PCT: sanity,
    CAN_45PCT_HIT_RATE_BE_PROFITABLE_IN_1_75_2_00: sanity.every((s) => s.EXPECTED_ROI_PCT < 0) ? "NO" : "YES",
    TASK5_ACTUAL_LIVE_SEP25_27: {
      STATUS: "UNAVAILABLE_NO_PRODUCTION_ACCESS",
      NOTE: "No credential for production project (nbnldzfsxffztsfrrxqy or any other) exists in this session -- not in shell env, not via Supabase MCP. The 'known facts' MATCHED=28, terminal~=23, 12W/11L, hit rate~=52.17% are UNVERIFIED_ASSERTED_BY_PROMPT, not independently confirmed. No PnL computed for this task.",
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/AUDIT_REPORT.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e), STACK: e instanceof Error ? e.stack : undefined }));
    process.exitCode = 1;
  });
}
