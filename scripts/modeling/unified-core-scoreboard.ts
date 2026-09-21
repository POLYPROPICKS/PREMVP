/**
 * UNIFIED_CORE_SCOREBOARD_V1 — first business-readable comparison of the
 * current model/slice families over the common model-ready period
 * 2026-08-04..2026-09-20.
 *
 * Reuses the frozen research engine and existing exact Git predicates
 * verbatim — never re-implements settlement/economics in SQL:
 *   - C0/C1/C4/C5 predicates: lib/modeling/research-engine/models.ts
 *   - PORTFOLIO_BROAD tiers, P50_52/P50_54/TENNIS_P50_52/SCORE63_64_P50_52
 *     standalone predicates: scripts/modeling/daily-portfolio-frontier.ts
 *   - toAtlasInput row normalizer: scripts/modeling/factor-atlas.ts
 *   - evaluateEvent/sortChronologically/aggregateMetrics/settleBetU:
 *     lib/modeling/research-engine
 *
 * Source: research_model_ready_rows (RESEARCH CLONE, read-only) for
 * 2026-08-04..2026-09-20. LEGACY_C4_HISTORICAL is NOT recomputed here — it
 * is reported from the existing accepted golden-contract reference
 * (lib/modeling/research-engine/goldenContract.ts), kept strictly isolated
 * from this common-period denominator.
 *
 *   npx tsx scripts/modeling/unified-core-scoreboard.ts
 */
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

import type { ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import {
  evaluateEvent,
  sortChronologically,
  aggregateMetrics,
  settleBetU,
  ENTRY_PRICE_BAND,
  SOCCER_FAMILY,
  TABLE_TENNIS_FAMILY,
  C4_LEAD_TIME_HOURS_THRESHOLD,
  GOLDEN_REFERENCE_CONTRACT_V1,
  type SelectedBet,
} from "@/lib/modeling/research-engine";
import { resolveSportFamily } from "@/lib/research-clone/modelReady";
import { toAtlasInput, type AtlasInputEvent } from "./factor-atlas";

const START = "2026-08-04";
const END = "2026-09-20";
const AUG_END = "2026-08-31";
const SEP_START = "2026-09-01";
const PAGE = 1000;

type AtlasEvaluatedEvent = ReturnType<typeof evaluateEvent> & AtlasInputEvent;

function inC0(entryPrice: number): boolean {
  return entryPrice >= ENTRY_PRICE_BAND.minInclusive && entryPrice < ENTRY_PRICE_BAND.maxExclusive;
}

function minskDate(iso: string): string {
  return new Date(Date.parse(iso) + 3 * 3600_000).toISOString().slice(0, 10);
}

function toSelectedBet(event: AtlasEvaluatedEvent): SelectedBet {
  return {
    physicalEventKey: event.physicalEventKey,
    decisionTimestamp: event.decisionTimestamp,
    eventStart: event.eventStart,
    leadTimeHours: event.leadTimeHours,
    entryPrice: event.entryPrice,
    sportFamily: event.sportFamily,
    outcome: event.outcome,
    pnlU: settleBetU(event.outcome, event.entryPrice),
    ...(event.ref === undefined ? {} : { ref: event.ref }),
  };
}

function runStandalone(input: AtlasInputEvent[], predicate: (e: AtlasEvaluatedEvent) => boolean) {
  const ordered = sortChronologically(input.map((e) => evaluateEvent(e) as AtlasEvaluatedEvent)) as AtlasEvaluatedEvent[];
  const claimed = new Set<string>();
  const bets: SelectedBet[] = [];
  for (const event of ordered) {
    if (claimed.has(event.physicalEventKey)) continue;
    if (!predicate(event)) continue;
    claimed.add(event.physicalEventKey);
    bets.push(toSelectedBet(event));
  }
  return bets;
}

function runPortfolio(input: AtlasInputEvent[], tiers: Array<(e: AtlasEvaluatedEvent) => boolean>) {
  const evaluated = input.map((e) => evaluateEvent(e) as AtlasEvaluatedEvent);
  const grouped = new Map<string, AtlasEvaluatedEvent[]>();
  for (const event of evaluated) {
    const list = grouped.get(event.physicalEventKey);
    if (list) list.push(event);
    else grouped.set(event.physicalEventKey, [event]);
  }
  const bets: SelectedBet[] = [];
  for (const group of grouped.values()) {
    const sorted = sortChronologically(group) as AtlasEvaluatedEvent[];
    for (const tierPredicate of tiers) {
      const winner = sorted.find(tierPredicate);
      if (winner) {
        bets.push(toSelectedBet(winner));
        break;
      }
    }
  }
  return bets;
}

function metricsFor(bets: SelectedBet[]) {
  const chrono = [...bets].sort((a, b) => a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey));
  const m = aggregateMetrics(chrono);
  return { events: m.SELECTED_PHYSICAL_EVENT_N, wins: m.WINS, losses: m.LOSSES, pnl_u: m.PNL_U, roi_pct: m.ROI_PCT, max_drawdown_u: m.MAX_DRAWDOWN_U };
}

function splitByDate(bets: SelectedBet[], start: string, end: string) {
  return bets.filter((b) => {
    const d = minskDate(b.decisionTimestamp);
    return d >= start && d <= end;
  });
}

function sportComposition(bets: SelectedBet[]) {
  const counts = new Map<string, number>();
  for (const b of bets) {
    const key = b.sportFamily || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = bets.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sport, n]) => ({ sport, n, pct: round((n / total) * 100, 1) }));
}

function weeklyBlocks(bets: SelectedBet[]) {
  const weeks = [
    ["W1(08-04..08-10)", "2026-08-04", "2026-08-10"],
    ["W2(08-11..08-17)", "2026-08-11", "2026-08-17"],
    ["W3(08-18..08-24)", "2026-08-18", "2026-08-24"],
    ["W4(08-25..08-31)", "2026-08-25", "2026-08-31"],
    ["W5(09-01..09-07)", "2026-09-01", "2026-09-07"],
    ["W6(09-08..09-14)", "2026-09-08", "2026-09-14"],
    ["W7(09-15..09-20)", "2026-09-15", "2026-09-20"],
  ] as const;
  return weeks.map(([id, s, e]) => ({ id, ...metricsFor(splitByDate(bets, s, e)) }));
}

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function priceBucketComposition(bets: SelectedBet[]) {
  const buckets = [
    ["0.50-0.52", 0.5, 0.52],
    ["0.52-0.54", 0.52, 0.54],
    ["0.54-0.60", 0.54, 0.6],
  ] as const;
  return buckets.map(([id, lo, hi]) => metricsFor(bets.filter((b) => b.entryPrice >= lo && b.entryPrice < hi)) && { bucket: id, ...metricsFor(bets.filter((b) => b.entryPrice >= lo && b.entryPrice < hi)) });
}

async function resolveDb() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
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
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`FETCH_ROWS:${error.code ?? error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ canonical_row: ScorecardReadyRow }>) rows.push(r.canonical_row);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function main() {
  const rawRows = await fetchRows();
  const input = toAtlasInput(rawRows);
  const processedN = new Set(input.map((e) => e.physicalEventKey)).size;

  const TIER_PREFERRED = (e: AtlasEvaluatedEvent) =>
    (e.entryPrice >= 0.5 && e.entryPrice < 0.52 && e.sportFamily === "tennis") ||
    (e.entryPrice >= 0.5 && e.entryPrice < 0.52 && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65);
  const TIER_P50_52 = (e: AtlasEvaluatedEvent) => e.entryPrice >= 0.5 && e.entryPrice < 0.52;
  const TIER_P52_54 = (e: AtlasEvaluatedEvent) => e.entryPrice >= 0.52 && e.entryPrice < 0.54;

  const models: Array<{ id: string; rules: string; bets: SelectedBet[] }> = [
    { id: "C0", rules: "0.50<=price<0.60", bets: runStandalone(input, (e) => inC0(e.entryPrice)) },
    { id: "C1", rules: "0.50<=price<0.60 AND soccer", bets: runStandalone(input, (e) => inC0(e.entryPrice) && e.sportFamily === SOCCER_FAMILY) },
    {
      id: "C4",
      rules: "0.50<=price<0.60 AND (soccer OR lead>=24h)",
      bets: runStandalone(input, (e) => inC0(e.entryPrice) && (e.sportFamily === SOCCER_FAMILY || e.leadTimeHours >= C4_LEAD_TIME_HOURS_THRESHOLD)),
    },
    { id: "C5", rules: "0.50<=price<0.60 AND sport!=table-tennis", bets: runStandalone(input, (e) => inC0(e.entryPrice) && e.sportFamily !== TABLE_TENNIS_FAMILY) },
    { id: "C0_ONLY_NOT_C1", rules: "0.50<=price<0.60 AND sport!=soccer", bets: runStandalone(input, (e) => inC0(e.entryPrice) && e.sportFamily !== SOCCER_FAMILY) },
    { id: "PORTFOLIO_BROAD", rules: "tiered: (tennis|score63-64)@0.50-52 > 0.50-52 > 0.52-54", bets: runPortfolio(input, [TIER_PREFERRED, TIER_P50_52, TIER_P52_54]) },
    { id: "P50_52", rules: "0.50<=price<0.52", bets: runStandalone(input, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52) },
    { id: "P50_54", rules: "0.50<=price<0.54", bets: runStandalone(input, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54) },
    { id: "TENNIS_P50_52", rules: "0.50<=price<0.52 AND tennis", bets: runStandalone(input, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52 && e.sportFamily === "tennis") },
    {
      id: "SCORE63_64_OVERLAY",
      rules: "0.50<=price<0.60 AND score in [63,65)",
      bets: runStandalone(input, (e) => inC0(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65),
    },
    { id: "TENNIS_LEAD18_24_DIAG", rules: "0.50<=price<0.60 AND tennis AND lead in [18,24)", bets: runStandalone(input, (e) => inC0(e.entryPrice) && e.sportFamily === "tennis" && e.leadTimeHours >= 18 && e.leadTimeHours < 24) },
  ];

  const table = models.map((m) => {
    const overall = metricsFor(m.bets);
    const aug = metricsFor(splitByDate(m.bets, START, AUG_END));
    const sep = metricsFor(splitByDate(m.bets, SEP_START, END));
    const status = m.id === "TENNIS_LEAD18_24_DIAG" ? "SMALL_SAMPLE_DIAGNOSTIC" : overall.events >= 100 ? "MAIN" : "SMALL_SAMPLE";
    return {
      STATUS: status,
      MODEL: m.id,
      DATASET: "AUG04_SEP20_COMMON",
      PROCESSED: processedN,
      BET: overall.events,
      PROCESSED_TO_BET_PCT: round((overall.events / processedN) * 100, 2),
      SPORTS_IN_BETS: sportComposition(m.bets),
      ROI_PCT: overall.roi_pct,
      PNL_U: overall.pnl_u,
      MAX_DD_U: overall.max_drawdown_u,
      MAIN_RULES: m.rules,
      AUGUST: aug,
      SEPTEMBER_THROUGH_20: sep,
      WEEKLY: weeklyBlocks(m.bets),
      PRICE_BUCKETS: priceBucketComposition(m.bets),
    };
  });

  const legacy = {
    STATUS: "HISTORICAL_REFERENCE_ISOLATED",
    MODEL: "LEGACY_C4_HISTORICAL",
    DATASET: "JUN_AUG_HISTORICAL_NOT_IN_COMMON_DENOMINATOR",
    N: GOLDEN_REFERENCE_CONTRACT_V1.models.C4.N,
    WINS: GOLDEN_REFERENCE_CONTRACT_V1.models.C4.W,
    LOSSES: GOLDEN_REFERENCE_CONTRACT_V1.models.C4.L,
    PNL_U: GOLDEN_REFERENCE_CONTRACT_V1.models.C4.PNL_U,
    ROI_PCT: GOLDEN_REFERENCE_CONTRACT_V1.models.C4.ROI_PCT,
    MAX_DD_U: GOLDEN_REFERENCE_CONTRACT_V1.models.C4.MAX_DRAWDOWN_U,
  };

  console.log(
    JSON.stringify(
      {
        DATASET: "AUG04_SEP20_COMMON",
        PROCESSED_N: processedN,
        SOURCE_ROW_N: rawRows.length,
        MODELS: table,
        LEGACY_C4_HISTORICAL: legacy,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
