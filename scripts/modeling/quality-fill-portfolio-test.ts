/**
 * QUALITY_FILL_PORTFOLIO_TEST_V1 — extends DAILY_CAP_PNL_OPTIMIZATION_V1 (this
 * same PR) by testing a SMALL FIXED SET of evidence-backed daily portfolio
 * fill strategies against the existing P50_52/PORTFOLIO_BROAD baselines.
 *
 * Business question: can a simple evidence-backed quality ordering beat
 * P50_52 @ cap50 (+379.30u) while preserving/improving 30-50/day supply?
 * This is a fixed-candidate allocation test, not a threshold/score sweep.
 *
 * ENGINE_REUSE: runStandalone/runPortfolio/computeDailyResults/computeCapacity
 * imported verbatim from scripts/modeling/daily-portfolio-frontier.ts. The
 * only new code is the FIXED tier predicates for the 3 QUALITY_FILL
 * candidates (ordinary price/sport-family boolean composition of the same
 * fields the frozen engine already exposes) and the reporting/aggregation
 * around them. No new score threshold. No new capacity engine.
 *
 *   npx tsx scripts/modeling/quality-fill-portfolio-test.ts \
 *     --start=2026-08-04 --end=2026-09-20
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import "dotenv/config";

import { enumerateMinskDates, type ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { SOCCER_FAMILY } from "@/lib/modeling/research-engine/models";
import { toAtlasInput, type AtlasInputEvent } from "./factor-atlas";
import {
  runStandalone,
  runPortfolio,
  computeDailyResults,
  computeCapacity,
  metricsFor,
  type TieredBet,
  type CapacityResult,
} from "./daily-portfolio-frontier";

const DEFAULT_START = "2026-08-04";
const DEFAULT_END = "2026-09-20";
const PAGE = 1000;
const CAPS = [20, 30, 40, 50] as const;
const DISPLAY_CAPS = [30, 40, 50] as const;
const AUG_END = "2026-08-31";
const SEP_START = "2026-09-01";
const EVIDENCE_OUT_DIR = "modeling/evidence/daily-cap-pnl-optimization-v1";
const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";

const ESPORTS_FAMILY = "esports";

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((v) => v.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const START = arg("start", DEFAULT_START);
const END = arg("end", DEFAULT_END);

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function projectRefOf(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

/** Fail-closed: only ever runs against the bound research-clone project — never production. */
async function resolveDb() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = projectRefOf(url);
  if (ref !== EXPECTED_CLONE_PROJECT_REF) {
    throw new Error(`REFUSING_NON_CLONE_TARGET: expected research-clone project ${EXPECTED_CLONE_PROJECT_REF}, got ${ref}`);
  }
  return createClient(url, key);
}

async function fetchRows(): Promise<ScorecardReadyRow[]> {
  const db = await resolveDb();
  const rows: ScorecardReadyRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("research_model_ready_rows")
      .select("canonical_row")
      .gte("model_date", START)
      .lte("model_date", END)
      .order("model_date")
      .order("population_id")
      .order("condition_id")
      .order("selected_token_id")
      .order("decision_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`FETCH_ROWS:${error.code ?? error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ canonical_row: ScorecardReadyRow }>) rows.push(r.canonical_row);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// ── FIXED tier predicates (evidence-backed sleeves already proven in this PR) ──
type Ev = { entryPrice: number; sportFamily: string };
const inP5052 = (e: Ev) => e.entryPrice >= 0.5 && e.entryPrice < 0.52;
const inP5254 = (e: Ev) => e.entryPrice >= 0.52 && e.entryPrice < 0.54;
const inP5460 = (e: Ev) => e.entryPrice >= 0.54 && e.entryPrice < 0.6;

const TIER_TENNIS_P5052 = (e: Ev) => inP5052(e) && e.sportFamily === "tennis";
const TIER_SOCCER_P5054 = (e: Ev) => (inP5052(e) || inP5254(e)) && e.sportFamily === SOCCER_FAMILY;
const TIER_REMAINING_P5052 = (e: Ev) => inP5052(e);
const TIER_NON_ESPORTS_REMAINING_P5052 = (e: Ev) => inP5052(e) && e.sportFamily !== ESPORTS_FAMILY;
const TIER_ESPORTS_P5052 = (e: Ev) => inP5052(e) && e.sportFamily === ESPORTS_FAMILY;
const TIER_SOCCER_P5460 = (e: Ev) => inP5460(e) && e.sportFamily === SOCCER_FAMILY;

const QUALITY_PORTFOLIOS: Record<string, Array<(e: Ev) => boolean>> = {
  QUALITY_FILL_A: [TIER_TENNIS_P5052, TIER_SOCCER_P5054, TIER_REMAINING_P5052],
  QUALITY_FILL_B: [TIER_TENNIS_P5052, TIER_SOCCER_P5054, TIER_NON_ESPORTS_REMAINING_P5052, TIER_ESPORTS_P5052],
  QUALITY_FILL_C: [
    TIER_TENNIS_P5052,
    TIER_SOCCER_P5054,
    TIER_NON_ESPORTS_REMAINING_P5052,
    TIER_ESPORTS_P5052,
    TIER_SOCCER_P5460,
  ],
};

const REQUIRED_MODELS = ["P50_52", "PORTFOLIO_BROAD", "QUALITY_FILL_A", "QUALITY_FILL_B", "QUALITY_FILL_C"] as const;

// P50_52 / PORTFOLIO_BROAD tier definitions reused verbatim (same predicates as daily-portfolio-frontier.ts).
const TIER_PREFERRED = (e: Ev & { scoreLevel?: number }) =>
  (inP5052(e) && e.sportFamily === "tennis") ||
  (inP5052(e) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65);
const TIER_P50_52 = (e: Ev) => inP5052(e);
const TIER_P52_54 = (e: Ev) => inP5254(e);

interface CapEconRow extends CapacityResult {
  MODEL: string;
  SEGMENT: "OVERALL" | "AUGUST" | "SEPTEMBER";
  CALENDAR_DAYS: number;
  PNL_PER_CALENDAR_DAY: number;
  PROJECTION_30D_PNL_U_FLAT_1U: number;
}

function capEconomics(model: string, segment: CapEconRow["SEGMENT"], bets: TieredBet[], cap: number, dates: string[]): CapEconRow {
  const c = computeCapacity(bets, cap, dates);
  const calendarDays = dates.length;
  const pnlPerCalendarDay = calendarDays ? round(c.total_pnl_u / calendarDays, 4) : 0;
  return {
    MODEL: model,
    SEGMENT: segment,
    ...c,
    CALENDAR_DAYS: calendarDays,
    PNL_PER_CALENDAR_DAY: pnlPerCalendarDay,
    PROJECTION_30D_PNL_U_FLAT_1U: round(pnlPerCalendarDay * 30, 2),
  };
}

function fillRates(bets: TieredBet[], dates: string[]) {
  const daily = computeDailyResults(bets, dates);
  const n = dates.length;
  return {
    FILL_RATE_30: n ? round(daily.filter((d) => d.event_n >= 30).length / n, 4) : 0,
    FILL_RATE_40: n ? round(daily.filter((d) => d.event_n >= 40).length / n, 4) : 0,
    FILL_RATE_50: n ? round(daily.filter((d) => d.event_n >= 50).length / n, 4) : 0,
  };
}

interface MarginalLayerRow {
  MODEL: string;
  LAYER: string;
  INCREMENTAL_EVENT_N: number;
  INCREMENTAL_PNL_U: number;
  INCREMENTAL_ROI_PCT: number;
  INCREMENTAL_PNL_PER_CALENDAR_DAY: number;
}
const MARGINAL_LAYERS: Array<[number, number, string]> = [
  [20, 30, "21_TO_30"],
  [30, 40, "31_TO_40"],
  [40, 50, "41_TO_50"],
];
function marginalLayers(model: string, capMap: Map<number, CapEconRow>, calendarDays: number): MarginalLayerRow[] {
  return MARGINAL_LAYERS.map(([lo, hi, label]) => {
    const a = capMap.get(lo)!;
    const b = capMap.get(hi)!;
    const incN = b.selected_event_n - a.selected_event_n;
    const incPnl = round(b.total_pnl_u - a.total_pnl_u, 2);
    const incRoi = incN > 0 ? round((incPnl / incN) * 100, 4) : 0;
    return {
      MODEL: model,
      LAYER: label,
      INCREMENTAL_EVENT_N: incN,
      INCREMENTAL_PNL_U: incPnl,
      INCREMENTAL_ROI_PCT: incRoi,
      INCREMENTAL_PNL_PER_CALENDAR_DAY: calendarDays ? round(incPnl / calendarDays, 4) : 0,
    };
  });
}

function pairedComparisonAtCap50(baselineBets: TieredBet[], candidateBets: TieredBet[], baselineDates: string[]) {
  const cap = 50;
  const baseCapped = new Set(
    (function () {
      const byDay = new Map<string, TieredBet[]>();
      for (const b of baselineBets) {
        const l = byDay.get(b.day);
        if (l) l.push(b);
        else byDay.set(b.day, [b]);
      }
      const kept: TieredBet[] = [];
      for (const dayBets of byDay.values()) {
        const ordered = [...dayBets].sort(
          (a, b) => a.tier - b.tier || a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey),
        );
        kept.push(...ordered.slice(0, cap));
      }
      return kept;
    })().map((b) => b.physicalEventKey),
  );
  const candCapped = (function () {
    const byDay = new Map<string, TieredBet[]>();
    for (const b of candidateBets) {
      const l = byDay.get(b.day);
      if (l) l.push(b);
      else byDay.set(b.day, [b]);
    }
    const kept: TieredBet[] = [];
    for (const dayBets of byDay.values()) {
      const ordered = [...dayBets].sort(
        (a, b) => a.tier - b.tier || a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey),
      );
      kept.push(...ordered.slice(0, cap));
    }
    return kept;
  })();
  const candKeys = new Set(candCapped.map((b) => b.physicalEventKey));
  const shared = [...candKeys].filter((k) => baseCapped.has(k));
  const added = candCapped.filter((b) => !baseCapped.has(b.physicalEventKey));
  const removed = [...baseCapped].filter((k) => !candKeys.has(k));
  const baseMetrics = metricsFor(
    (function () {
      const byDay = new Map<string, TieredBet[]>();
      for (const b of baselineBets) {
        const l = byDay.get(b.day);
        if (l) l.push(b);
        else byDay.set(b.day, [b]);
      }
      const kept: TieredBet[] = [];
      for (const dayBets of byDay.values()) {
        const ordered = [...dayBets].sort(
          (a, b) => a.tier - b.tier || a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey),
        );
        kept.push(...ordered.slice(0, cap));
      }
      return kept;
    })(),
  );
  const candMetrics = metricsFor(candCapped);
  const baseFill = fillRates(baselineBets, baselineDates);
  const candFill = fillRates(candidateBets, baselineDates);
  return {
    SHARED_EVENT_N: shared.length,
    ADDED_EVENT_N: added.length,
    REMOVED_EVENT_N: removed.length,
    BASELINE_CAP50_N: baseCapped.size,
    CANDIDATE_CAP50_N: candCapped.length,
    BASELINE_CAP50_PNL_U: baseMetrics.pnl_u,
    CANDIDATE_CAP50_PNL_U: candMetrics.pnl_u,
    PNL_DELTA_U: round(candMetrics.pnl_u - baseMetrics.pnl_u, 2),
    FILL_RATE_50_DELTA: round(candFill.FILL_RATE_50 - baseFill.FILL_RATE_50, 4),
  };
}

async function main() {
  const rawRows = await fetchRows();
  const input: AtlasInputEvent[] = toAtlasInput(rawRows);

  const dates = enumerateMinskDates(START, END);
  const augDates = dates.filter((d) => d <= AUG_END);
  const sepDates = dates.filter((d) => d >= SEP_START);

  const betsByModel = new Map<string, TieredBet[]>();
  betsByModel.set("P50_52", runStandalone(input, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52));
  betsByModel.set("PORTFOLIO_BROAD", runPortfolio(input, [TIER_PREFERRED, TIER_P50_52, TIER_P52_54]));
  for (const [id, tiers] of Object.entries(QUALITY_PORTFOLIOS)) {
    betsByModel.set(id, runPortfolio(input, tiers));
  }

  // TABLE 1 — MODEL x CAP economics (overall + Aug + Sep-through-Sep20), cap 30/40/50; fill rates once per model
  interface Table1Row {
    CAP: number;
    OVERALL: CapEconRow;
    AUGUST: CapEconRow;
    SEPTEMBER: CapEconRow;
  }
  interface Table1Block {
    ROWS: Table1Row[];
    FILL_RATE_30: number;
    FILL_RATE_40: number;
    FILL_RATE_50: number;
  }
  const table1: Record<string, Table1Block> = {};
  const capMapOverallByModel = new Map<string, Map<number, CapEconRow>>();
  for (const modelId of REQUIRED_MODELS) {
    const bets = betsByModel.get(modelId)!;
    const overallCapMap = new Map<number, CapEconRow>();
    for (const cap of CAPS) overallCapMap.set(cap, capEconomics(modelId, "OVERALL", bets, cap, dates));
    capMapOverallByModel.set(modelId, overallCapMap);

    // computeCapacity aggregates over whatever bet set it is given (its `allDates` arg only
    // shapes the daily/active-day breakdown, not the totals) — so Aug/Sep segments must be
    // pre-filtered to their own bets, not just given a narrower `dates` array over full-range bets.
    const augBets = bets.filter((b) => b.day <= AUG_END);
    const sepBets = bets.filter((b) => b.day >= SEP_START);
    const rows = DISPLAY_CAPS.map((cap) => ({
      CAP: cap,
      OVERALL: overallCapMap.get(cap)!,
      AUGUST: capEconomics(modelId, "AUGUST", augBets, cap, augDates),
      SEPTEMBER: capEconomics(modelId, "SEPTEMBER", sepBets, cap, sepDates),
    }));
    table1[modelId] = { ROWS: rows, ...fillRates(bets, dates) };
  }

  // TABLE 2 — marginal 21-30 / 31-40 / 41-50
  const table2: Record<string, MarginalLayerRow[]> = {};
  for (const modelId of REQUIRED_MODELS) {
    table2[modelId] = marginalLayers(modelId, capMapOverallByModel.get(modelId)!, dates.length);
  }

  // TABLE 3 — fill rate 30/40/50 (already embedded in table1[modelId] top-level fields, re-surfaced standalone)
  const table3: Record<string, { FILL_RATE_30: number; FILL_RATE_40: number; FILL_RATE_50: number }> = {};
  for (const modelId of REQUIRED_MODELS) {
    table3[modelId] = fillRates(betsByModel.get(modelId)!, dates);
  }

  // TABLE 4 — cap50 paired comparison vs P50_52
  const baseline = betsByModel.get("P50_52")!;
  const table4: Record<string, ReturnType<typeof pairedComparisonAtCap50>> = {};
  for (const modelId of REQUIRED_MODELS) {
    if (modelId === "P50_52") continue;
    table4[modelId] = pairedComparisonAtCap50(baseline, betsByModel.get(modelId)!, dates);
  }

  const artifact = {
    MISSION: "QUALITY_FILL_PORTFOLIO_TEST_V1",
    PARENT_MISSION: "DAILY_CAP_PNL_OPTIMIZATION_V1",
    ENGINE_REUSE:
      "runStandalone/runPortfolio/computeDailyResults/computeCapacity imported verbatim from scripts/modeling/daily-portfolio-frontier.ts. Only new code: FIXED tier predicates for QUALITY_FILL_A/B/C (ordinary price+sport-family composition), no new score threshold, no new capacity engine.",
    DATASET_RANGE: { start: START, end: END },
    CALENDAR_DAYS: dates.length,
    SOURCE_ROW_N: rawRows.length,
    TABLE_1_MODEL_X_CAP_ECONOMICS: table1,
    TABLE_2_MARGINAL_LAYERS: table2,
    TABLE_3_FILL_RATES: table3,
    TABLE_4_CAP50_PAIRED_VS_P50_52: table4,
  };

  console.log(JSON.stringify(artifact, null, 2));

  mkdirSync(EVIDENCE_OUT_DIR, { recursive: true });
  const outPath = `${EVIDENCE_OUT_DIR}/QUALITY_FILL_PORTFOLIO_TEST_${START}_${END}.json`;
  writeFileSync(outPath, JSON.stringify({ GENERATED_AT: new Date().toISOString(), ...artifact }, null, 2));
  console.error(`Wrote aggregate evidence artifact: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
