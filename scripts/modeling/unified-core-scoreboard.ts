/**
 * UNIFIED_CORE_SCOREBOARD_V1 — the owned, reproducible Git entrypoint for
 * the business-readable comparison of the current model/slice families,
 * gate economics, market-type economics and selected-price-movement
 * economics over the common research-clone model-ready period.
 *
 * Reuses the frozen research engine and existing exact Git predicates
 * verbatim — never re-implements settlement/economics in SQL:
 *   - C0/C1/C4/C5 predicates: lib/modeling/research-engine/models.ts
 *   - PORTFOLIO_BROAD tiers, P50_52/P50_54/TENNIS_P50_52/SCORE63_64_P50_52
 *     standalone predicates: scripts/modeling/daily-portfolio-frontier.ts
 *   - toAtlasInput row normalizer + SCORE_LEVEL/LEAD_TIME/PRICE_SERIES_DIRECTION
 *     bucket boundaries: scripts/modeling/factor-atlas.ts
 *   - evaluateEvent/sortChronologically/aggregateMetrics/settleBetU:
 *     lib/modeling/research-engine
 *   - BAD_BUCKET_COV_PRICE predicate: lib/executor/buildFireModelCandidates.ts
 *
 * Source: research_model_ready_rows (RESEARCH CLONE, read-only, deterministic
 * paginated reads ordered on the persisted identity key). marketTypeRaw is
 * read directly off canonical_row (via factor-atlas.ts's toAtlasInput — see
 * AtlasInputEvent.marketTypeRaw for why it's present there despite not being
 * declared on the ScorecardReadyRow TS interface). Coverage (for the
 * BAD_BUCKET_COV_PRICE counterfactual only) genuinely is not persisted on
 * canonical_row and is reconstructed via the same already-proven bounded
 * evidence read the materializer itself uses (readResearchEvidencePageRows),
 * joined back onto the model-ready identity — never a new corpus or table.
 * LEGACY_C4_HISTORICAL is NOT recomputed here — it is reported from the
 * existing accepted golden-contract reference
 * (lib/modeling/research-engine/goldenContract.ts), kept strictly isolated
 * from this common-period denominator.
 *
 * Canonical invocation (also `npm run research-clone:scoreboard --`):
 *   npx tsx scripts/modeling/unified-core-scoreboard.ts \
 *     --start=2026-08-04 --end=2026-09-20
 *
 * Emits Founder-readable tables to stdout and one aggregate structured JSON
 * artifact under modeling/evidence/ (never raw model-ready rows). Running
 * twice on unchanged clone data reproduces identical business metrics.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { readResearchEvidencePageRows } from "./live-d1-research-corpus";

const DEFAULT_START = "2026-08-04";
const DEFAULT_END = "2026-09-20";
const PAGE = 1000;
const EVIDENCE_OUT_DIR = "modeling/evidence/unified-core-scoreboard-v1";
/** Research-clone project ref this runner is bound to — fail-closed guard against pointing at production. */
const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((v) => v.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const START = arg("start", DEFAULT_START);
const END = arg("end", DEFAULT_END);
/** Aug/Sep split is a fixed calendar boundary independent of --start/--end. */
const AUG_END = "2026-08-31";
const SEP_START = "2026-09-01";

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

/**
 * Legacy BAD_BUCKET_COV_PRICE coverage input (coverage 50-74 AND
 * entry_price 0.44-0.58 — lib/executor/buildFireModelCandidates.ts:2115) is a
 * per-row diagnostics scalar that genuinely is NOT persisted onto
 * research_model_ready_rows.canonical_row (unlike marketTypeRaw — see
 * AtlasInputEvent.marketTypeRaw for why that field IS present there). It is
 * reconstructed here via the SAME already-proven bounded evidence read the
 * materializer itself uses (readResearchEvidencePageRows) — no new corpus,
 * no new table — joined back onto the model-ready identity (condition_id,
 * selected_token_id, decision_at).
 */
async function fetchCoverageMap(): Promise<Map<string, number | null>> {
  const db = await resolveDb();
  const startUtc = new Date(Date.parse(`${START}T00:00:00Z`) - 2 * 86_400_000).toISOString();
  const endUtc = new Date(Date.parse(`${END}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const { pairs } = await readResearchEvidencePageRows(db, startUtc, endUtc);
  const map = new Map<string, number | null>();
  for (const p of pairs) {
    const key = `${p.conditionId}|${p.selectedTokenId}|${p.decisionAt}`;
    map.set(key, typeof p.dataCoverage === "number" ? p.dataCoverage : null);
  }
  return map;
}

function isBadBucket(e: { entryPrice: number; coverage: number | null }): boolean {
  return typeof e.coverage === "number" && e.coverage >= 50 && e.coverage <= 74 && e.entryPrice >= 0.44 && e.entryPrice <= 0.58;
}

async function main() {
  const rawRows = await fetchRows();
  const input = toAtlasInput(rawRows);
  const processedN = new Set(input.map((e) => e.physicalEventKey)).size;

  // marketTypeRaw comes straight off canonical_row via `input` (toAtlasInput) —
  // no evidence-table reconstruction. Only BAD_BUCKET's coverage genuinely
  // needs the secondary join.
  const coverageMap = await fetchCoverageMap();
  const coverageOf = (r: ScorecardReadyRow) => coverageMap.get(`${r.conditionId}|${r.selectedTokenId}|${r.decisionAt}`);
  const coverageMatchedRawN = rawRows.filter((r) => coverageOf(r) !== undefined).length;
  const marketTypeMatchedN = new Set(input.filter((e) => e.marketTypeRaw != null).map((e) => e.physicalEventKey)).size;
  // Mirrors toAtlasInput's exact filter (factor-atlas.ts) — rebuilt here from
  // rawRows directly (rather than zipped against the already-filtered
  // `input`) so each event keeps its exact conditionId/selectedTokenId for
  // the coverage join.
  const inputWithCoverage = rawRows
    .filter(
      (r) =>
        (r.labelAsOf === "WIN" || r.labelAsOf === "LOSS") &&
        r.providerEventId &&
        r.eventStart &&
        r.entryPrice !== null &&
        r.entryPrice > 0 &&
        r.entryPrice < 1,
    )
    .map((r) => ({
      physicalEventKey: r.providerEventId!,
      decisionTimestamp: r.decisionAt,
      eventStart: r.eventStart!,
      entryPrice: r.entryPrice!,
      sportFamily: resolveSportFamily(r) ?? "",
      outcome: r.labelAsOf as "WIN" | "LOSS",
      ref: r.conditionId,
      scoreLevel: typeof r.scoreLevel === "number" ? r.scoreLevel : null,
      score: r.score,
      selectedPrice: r.selectedPrice,
      volumeUsd: typeof r.volumeUsd === "number" ? r.volumeUsd : null,
      rowLeadTimeHours: typeof r.leadTimeHours === "number" ? r.leadTimeHours : null,
      marketTypeRaw: null, // unused by BAD_BUCKET logic; market-type economics use `input` (toAtlasInput) directly
      coverage: coverageOf(r) ?? null,
    }));

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

  // ── B: SCORE ECONOMICS (existing factor-atlas SCORE_LEVEL buckets, C0 band) ──
  const SCORE_BUCKETS: Array<[string, number, number]> = [
    ["50-59", 50, 60],
    ["60-62", 60, 63],
    ["63-64", 63, 65],
    ["65-67", 65, 68],
    ["68+", 68, Infinity],
  ];
  const scoreTable = SCORE_BUCKETS.map(([id, lo, hi]) => {
    const bets = runStandalone(input, (e) => inC0(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= lo && e.scoreLevel < hi);
    return { BUCKET: id, ...metricsFor(bets), AUGUST: metricsFor(splitByDate(bets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(bets, SEP_START, END)) };
  });
  const score50_64Bets = runStandalone(input, (e) => inC0(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 50 && e.scoreLevel < 65);
  const scoreGe65Bets = runStandalone(input, (e) => inC0(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 65);
  const scoreSummary = {
    SCORE_50_64: { ...metricsFor(score50_64Bets), AUGUST: metricsFor(splitByDate(score50_64Bets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(score50_64Bets, SEP_START, END)) },
    SCORE_GE_65: { ...metricsFor(scoreGe65Bets), AUGUST: metricsFor(splitByDate(scoreGe65Bets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(scoreGe65Bets, SEP_START, END)) },
  };

  // ── C: LEGACY BAD_BUCKET_COV_PRICE HARD-REJECT COUNTERFACTUAL (C0 base) ──
  const c0Bets = runStandalone(inputWithCoverage, (e) => inC0(e.entryPrice));
  const isBB = (e: AtlasEvaluatedEvent) => isBadBucket(e as unknown as { entryPrice: number; coverage: number | null });
  const badBucketRemovedBets = runStandalone(inputWithCoverage, (e) => inC0(e.entryPrice) && isBB(e));
  const badBucketRetainedBets = runStandalone(inputWithCoverage, (e) => inC0(e.entryPrice) && !isBB(e));
  const broadBets = runStandalone(inputWithCoverage, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54);
  const badBucketRemovedBroadBets = runStandalone(inputWithCoverage, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54 && isBB(e));
  const badBucketRetainedBroadBets = runStandalone(inputWithCoverage, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54 && !isBB(e));
  const badBucketCounterfactual = {
    COVERAGE_SOURCE_NOTE:
      "coverage is not persisted on research_model_ready_rows.canonical_row; reconstructed via the same proven bounded evidence read the materializer uses (readResearchEvidencePageRows), joined on condition_id+selected_token_id+decision_at.",
    COVERAGE_JOIN_MATCH_N: coverageMatchedRawN,
    COVERAGE_JOIN_TOTAL_RAW_N: rawRows.length,
    WITHIN_C0: {
      BASELINE_N: c0Bets.length,
      REMOVED: { ...metricsFor(badBucketRemovedBets), AUGUST: metricsFor(splitByDate(badBucketRemovedBets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(badBucketRemovedBets, SEP_START, END)), SPORTS: sportComposition(badBucketRemovedBets) },
      RETAINED: { ...metricsFor(badBucketRetainedBets), AUGUST: metricsFor(splitByDate(badBucketRetainedBets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(badBucketRetainedBets, SEP_START, END)), SPORTS: sportComposition(badBucketRetainedBets) },
    },
    WITHIN_BROAD_0_50_0_54: {
      BASELINE_N: broadBets.length,
      REMOVED: { ...metricsFor(badBucketRemovedBroadBets), AUGUST: metricsFor(splitByDate(badBucketRemovedBroadBets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(badBucketRemovedBroadBets, SEP_START, END)), SPORTS: sportComposition(badBucketRemovedBroadBets) },
      RETAINED: { ...metricsFor(badBucketRetainedBroadBets), AUGUST: metricsFor(splitByDate(badBucketRetainedBroadBets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(badBucketRetainedBroadBets, SEP_START, END)), SPORTS: sportComposition(badBucketRetainedBroadBets) },
    },
  };

  // ── D: LEAD-TIME / C4 DECOMPOSITION (existing factor-atlas LEAD_TIME buckets, C0 band) ──
  const LEAD_BUCKETS: Array<[string, number, number]> = [
    ["<3h", -Infinity, 3],
    ["3-6h", 3, 6],
    ["6-12h", 6, 12],
    ["12-18h", 12, 18],
    ["18-24h", 18, 24],
    [">=24h", 24, Infinity],
  ];
  const leadTable = LEAD_BUCKETS.map(([id, lo, hi]) => {
    const bets = runStandalone(input, (e) => inC0(e.entryPrice) && e.leadTimeHours >= lo && e.leadTimeHours < hi);
    return { BUCKET: id, ...metricsFor(bets), AUGUST: metricsFor(splitByDate(bets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(bets, SEP_START, END)) };
  });
  const c4SoccerBets = runStandalone(input, (e) => inC0(e.entryPrice) && e.sportFamily === SOCCER_FAMILY);
  const c4NonSoccerLead24Bets = runStandalone(input, (e) => inC0(e.entryPrice) && e.sportFamily !== SOCCER_FAMILY && e.leadTimeHours >= C4_LEAD_TIME_HOURS_THRESHOLD);
  const c4Full = table.find((m) => m.MODEL === "C4")!;
  const c4Decomposition = {
    C4_COMBINED: { N: c4Full.BET, PNL_U: c4Full.PNL_U, ROI_PCT: c4Full.ROI_PCT, MAX_DD_U: c4Full.MAX_DD_U },
    SOCCER_COMPONENT: { ...metricsFor(c4SoccerBets), AUGUST: metricsFor(splitByDate(c4SoccerBets, START, AUG_END)), SEPTEMBER_THROUGH_20: metricsFor(splitByDate(c4SoccerBets, SEP_START, END)) },
    NON_SOCCER_LEAD_GE_24_COMPONENT: {
      ...metricsFor(c4NonSoccerLead24Bets),
      AUGUST: metricsFor(splitByDate(c4NonSoccerLead24Bets, START, AUG_END)),
      SEPTEMBER_THROUGH_20: metricsFor(splitByDate(c4NonSoccerLead24Bets, SEP_START, END)),
      SPORTS: sportComposition(c4NonSoccerLead24Bets),
    },
  };

  // ── E: MARKET-TYPE ECONOMICS (exact Architect-identified marketTypeRaw categories) ──
  const MATERIAL_MARKET_TYPES = ["moneyline", "totals", "spreads", "child_moneyline", "tennis_completed_match", "total_corners"];
  const marketTypeTable = MATERIAL_MARKET_TYPES.map((mt) => {
    const bets = runStandalone(input, (e) => e.marketTypeRaw === mt);
    return {
      MARKET_TYPE: mt,
      ...metricsFor(bets),
      AUGUST: metricsFor(splitByDate(bets, START, AUG_END)),
      SEPTEMBER_THROUGH_20: metricsFor(splitByDate(bets, SEP_START, END)),
      SPORTS: sportComposition(bets),
      PRICE_BUCKETS: priceBucketComposition(bets),
    };
  });
  const DIAGNOSTIC_MARKET_TYPES = ["soccer_exact_score", "soccer_first_to_score"];
  const marketTypeDiagnostics = DIAGNOSTIC_MARKET_TYPES.map((mt) => {
    const bets = runStandalone(input, (e) => e.marketTypeRaw === mt);
    return { STATUS: "SMALL_SAMPLE_DIAGNOSTIC", MARKET_TYPE: mt, ...metricsFor(bets) };
  });
  const marketTypeAttribution = {
    NOTE: "marketTypeRaw is read directly off canonical_row (see AtlasInputEvent.marketTypeRaw) — no secondary evidence-table reconstruction. Attribution is still partial (not every canonical row carries a resolvable marketTypeRaw) — do not treat as explaining the full processed population.",
    PHYSICAL_EVENTS_WITH_MARKET_TYPE_ATTRIBUTION_N: marketTypeMatchedN,
    PROCESSED_N: processedN,
    UWCL_NOTE: "Not reconstructed — league identity is weak/absent in this common layer, per mission boundary.",
  };

  // ── F: SELECTED-PRICE-MOVEMENT ECONOMICS (existing factor-atlas PRICE_SERIES_DIRECTION buckets, C0 band) ──
  const priceMovementBuckets = [
    { ID: "PRICE_DELTA_NEG", predicate: (e: AtlasEvaluatedEvent) => inC0(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta < 0 },
    { ID: "PRICE_DELTA_ZERO", predicate: (e: AtlasEvaluatedEvent) => inC0(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta === 0 },
    { ID: "PRICE_DELTA_POS", predicate: (e: AtlasEvaluatedEvent) => inC0(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta > 0 },
  ];
  const priceMovementTable = priceMovementBuckets.map(({ ID, predicate }) => {
    const bets = runStandalone(input, predicate);
    const overall = metricsFor(bets);
    return {
      STATUS: overall.events >= 100 ? "MAIN" : "SMALL_SAMPLE_DIAGNOSTIC",
      BUCKET: ID,
      ...overall,
      AUGUST: metricsFor(splitByDate(bets, START, AUG_END)),
      SEPTEMBER_THROUGH_20: metricsFor(splitByDate(bets, SEP_START, END)),
    };
  });
  const priceMovementUsableN = runStandalone(input, (e) => inC0(e.entryPrice) && e.selectedPrice.observationCount >= 2).length;

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

  const artifact = {
    MISSION: "UNIFIED_CORE_SCOREBOARD_V1",
    DATASET_RANGE: { start: START, end: END },
    SOURCE_ROW_N: rawRows.length,
    PROCESSED_N: processedN,
    MODELS: table,
    LEGACY_C4_HISTORICAL: legacy,
    SCORE_ECONOMICS: { BUCKETS: scoreTable, SUMMARY_50_64_VS_GE_65: scoreSummary },
    LEGACY_BAD_BUCKET_COUNTERFACTUAL: badBucketCounterfactual,
    LEAD_TIME_ECONOMICS: { BUCKETS: leadTable, C4_DECOMPOSITION: c4Decomposition },
    MARKET_TYPE_ECONOMICS: { MATERIAL_TYPES: marketTypeTable, DIAGNOSTIC_TYPES: marketTypeDiagnostics, ATTRIBUTION: marketTypeAttribution },
    SELECTED_PRICE_MOVEMENT_ECONOMICS: { USABLE_SERIES_N_WITHIN_C0: priceMovementUsableN, BUCKETS: priceMovementTable },
  };

  console.log(JSON.stringify(artifact, null, 2));

  mkdirSync(EVIDENCE_OUT_DIR, { recursive: true });
  const outPath = `${EVIDENCE_OUT_DIR}/SCOREBOARD_${START}_${END}.json`;
  writeFileSync(outPath, JSON.stringify({ GENERATED_AT: new Date().toISOString(), ...artifact }, null, 2));
  console.error(`Wrote aggregate evidence artifact: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
