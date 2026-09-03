/**
 * DETERMINISTIC_RICH_MODEL_SCORECARD_V1 — deterministic economic scorecard for
 * the frozen C0/C1/C4/C5 model family over the canonical rolling research corpus.
 *
 * This module answers ONE product question:
 *   which already-frozen model hypotheses are actually supported by the honest
 *   7d / 14d / 30d data?
 *
 * It is BACKWARD-LOOKING DESCRIPTIVE only. It performs NO threshold search, NO
 * sizing beyond flat 1u, and reuses the frozen research-engine predicates and
 * settlement/metric primitives verbatim (never redefines PnL / ROI / MaxDD).
 *
 * Pure: no clock, no I/O, no network, no Map/Set iteration-order dependence.
 */
import {
  runResearchEngine,
  settleBetU,
  maxDrawdownU,
  round,
  FROZEN_MODEL_IDS,
  FROZEN_MODELS,
  MODEL_RESEARCH_ENGINE_VERSION,
  type FrozenModelId,
  type ModelResult,
  type ResearchEngineInputEvent,
  type SelectedBet,
} from "@/lib/modeling/research-engine";
import type {
  CorpusLabel,
  RollingManifest,
  ScorecardReadyRow,
  ScorecardRowView,
} from "@/lib/modeling/research-corpus/rollingCorpus";

export type Period = "7d" | "14d" | "30d";
export const PERIODS: Period[] = ["7d", "14d", "30d"];

/** Fixed, pre-declared Score LEVEL diagnostic buckets — NOT candidate thresholds. */
export const SCORE_LEVEL_BUCKETS = [
  "null",
  "<55",
  "55-59",
  "60-64",
  "65-69",
  "70-74",
  "75+",
] as const;
export type ScoreLevelBucket = (typeof SCORE_LEVEL_BUCKETS)[number];

const WIN_LOSS: ReadonlySet<CorpusLabel> = new Set<CorpusLabel>(["WIN", "LOSS"]);
const SETTLED: ReadonlySet<CorpusLabel> = new Set<CorpusLabel>(["WIN", "LOSS", "VOID"]);
const DAY_MS = 24 * 3600_000;

function scoreLevelBucket(sl: number | null): ScoreLevelBucket {
  if (sl === null) return "null";
  if (sl < 55) return "<55";
  if (sl < 60) return "55-59";
  if (sl < 65) return "60-64";
  if (sl < 70) return "65-69";
  if (sl < 75) return "70-74";
  return "75+";
}

function validEntryPrice(p: number | null): p is number {
  return typeof p === "number" && p > 0 && p < 1;
}

/** Chronological order over scorecard rows — total tiebreak, input-order independent. */
function rowCmp(a: ScorecardReadyRow, b: ScorecardReadyRow): number {
  if (a.decisionAt !== b.decisionAt) return a.decisionAt < b.decisionAt ? -1 : 1;
  if (a.conditionId !== b.conditionId) return a.conditionId < b.conditionId ? -1 : 1;
  return a.selectedTokenId < b.selectedTokenId ? -1 : a.selectedTokenId > b.selectedTokenId ? 1 : 0;
}

function maxDdFromPnls(pnls: number[]): number {
  return maxDrawdownU(pnls.map((p) => ({ pnlU: p }) as SelectedBet));
}

// ── engine input adapter ─────────────────────────────────────────────────
export interface AdapterExclusions {
  ALL_ROW_N: number;
  OPEN_N: number;
  NO_MATCH_N: number;
  AMBIGUOUS_N: number;
  VOID_N: number;
  WIN_LOSS_SETTLED_N: number;
  /** Among WIN/LOSS rows: identity has no provider_event_id (never folded via condition_id). */
  UNRESOLVED_PHYSICAL_EVENT_N: number;
  /** Among WIN/LOSS rows with a provider_event_id: eventStart absent → leadTimeHours not engine-computable. */
  MISSING_EVENT_START_N: number;
  /** Among WIN/LOSS rows otherwise eligible: entryPrice not in (0,1). */
  OUT_OF_RANGE_ENTRY_PRICE_N: number;
  ECONOMIC_ELIGIBLE_ROW_N: number;
  UNIT: string;
  SOURCE_STAGE: string;
}

function adaptForEngine(rows: ScorecardReadyRow[]): {
  input: ResearchEngineInputEvent[];
  exclusions: AdapterExclusions;
} {
  const input: ResearchEngineInputEvent[] = [];
  const ex: AdapterExclusions = {
    ALL_ROW_N: rows.length,
    OPEN_N: 0,
    NO_MATCH_N: 0,
    AMBIGUOUS_N: 0,
    VOID_N: 0,
    WIN_LOSS_SETTLED_N: 0,
    UNRESOLVED_PHYSICAL_EVENT_N: 0,
    MISSING_EVENT_START_N: 0,
    OUT_OF_RANGE_ENTRY_PRICE_N: 0,
    ECONOMIC_ELIGIBLE_ROW_N: 0,
    UNIT: "scorecard-ready unique-selection rows (labelAsOf view)",
    SOURCE_STAGE: "WINDOW_UNIQUE_SELECTION → ENGINE_INPUT_ADAPTER",
  };
  for (const r of [...rows].sort(rowCmp)) {
    const l = r.labelAsOf;
    if (l === "OPEN") { ex.OPEN_N++; continue; }
    if (l === "NO_MATCH") { ex.NO_MATCH_N++; continue; }
    if (l === "AMBIGUOUS") { ex.AMBIGUOUS_N++; continue; }
    if (l === "VOID") { ex.VOID_N++; continue; }
    if (!WIN_LOSS.has(l)) continue;
    ex.WIN_LOSS_SETTLED_N++;
    if (!r.providerEventId) { ex.UNRESOLVED_PHYSICAL_EVENT_N++; continue; }
    if (!r.eventStart) { ex.MISSING_EVENT_START_N++; continue; }
    if (!validEntryPrice(r.entryPrice)) { ex.OUT_OF_RANGE_ENTRY_PRICE_N++; continue; }
    ex.ECONOMIC_ELIGIBLE_ROW_N++;
    input.push({
      physicalEventKey: r.providerEventId,
      decisionTimestamp: r.decisionAt,
      eventStart: r.eventStart,
      entryPrice: r.entryPrice,
      sportFamily: r.sportFamily ?? "",
      outcome: l === "WIN" ? "WIN" : "LOSS",
      ref: r.conditionId,
    });
  }
  return { input, exclusions: ex };
}

// ── temporal stability ───────────────────────────────────────────────────
export interface StabilityBucket {
  BUCKET_INDEX: number;
  START_DATE: string; // inclusive, YYYY-MM-DD
  END_DATE: string; // exclusive, YYYY-MM-DD
  N: number;
  PNL_U: number;
  ROI_PCT: number;
  CUMULATIVE_PNL_U: number;
}
export interface ModelStability {
  BUCKET_DAYS: 7;
  BUCKETS: StabilityBucket[];
  POSITIVE_BUCKET_N: number;
  NEGATIVE_BUCKET_N: number;
  ZERO_OR_EMPTY_BUCKET_N: number;
  /** max |single-bucket PnL| / Σ|bucket PnL| — 1.0 ⇒ the whole result is one burst. */
  BURST_CONCENTRATION: number | null;
  NOTE: string;
}

function stability(bets: SelectedBet[], windowStart: string, windowDays: number): ModelStability {
  const startMs = Date.parse(`${windowStart}T00:00:00.000Z`);
  const bucketN = Math.ceil(windowDays / 7);
  const buckets: StabilityBucket[] = [];
  let cumulative = 0;
  for (let i = 0; i < bucketN; i++) {
    const bStart = startMs + i * 7 * DAY_MS;
    const bEnd = bStart + 7 * DAY_MS;
    const inBucket = bets.filter((b) => {
      const t = Date.parse(b.decisionTimestamp);
      return t >= bStart && t < bEnd;
    });
    const pnl = inBucket.reduce((a, b) => a + b.pnlU, 0);
    cumulative += pnl;
    buckets.push({
      BUCKET_INDEX: i,
      START_DATE: new Date(bStart).toISOString().slice(0, 10),
      END_DATE: new Date(bEnd).toISOString().slice(0, 10),
      N: inBucket.length,
      PNL_U: round(pnl, 2),
      ROI_PCT: inBucket.length ? round((pnl / inBucket.length) * 100, 4) : 0,
      CUMULATIVE_PNL_U: round(cumulative, 2),
    });
  }
  const nonEmpty = buckets.filter((b) => b.N > 0);
  const absSum = nonEmpty.reduce((a, b) => a + Math.abs(b.PNL_U), 0);
  const maxAbs = nonEmpty.reduce((a, b) => Math.max(a, Math.abs(b.PNL_U)), 0);
  return {
    BUCKET_DAYS: 7,
    BUCKETS: buckets,
    POSITIVE_BUCKET_N: nonEmpty.filter((b) => b.PNL_U > 0).length,
    NEGATIVE_BUCKET_N: nonEmpty.filter((b) => b.PNL_U < 0).length,
    ZERO_OR_EMPTY_BUCKET_N: buckets.length - nonEmpty.filter((b) => b.PNL_U !== 0).length,
    BURST_CONCENTRATION: absSum > 0 ? round(maxAbs / absSum, 4) : null,
    NOTE: "7-day chronological buckets anchored at WINDOW_START; BURST_CONCENTRATION near 1.0 means the economics come from one isolated period, not a repeated effect.",
  };
}

// ── Score LEVEL diagnostic ───────────────────────────────────────────────
export interface ScoreLevelBucketRow {
  BUCKET: ScoreLevelBucket;
  SETTLED_N: number;
  WIN: number;
  LOSS: number;
  VOID: number;
  /** WIN/LOSS rows with a provider_event_id and entryPrice∈(0,1), deduped to one bet per physical event. */
  ECONOMIC_N: number;
  PNL_U: number;
  ROI_PCT: number;
  MAX_DRAWDOWN_U: number;
}

function scoreLevelDiagnostic(rows: ScorecardReadyRow[]): ScoreLevelBucketRow[] {
  const settled = [...rows].filter((r) => SETTLED.has(r.labelAsOf)).sort(rowCmp);
  return SCORE_LEVEL_BUCKETS.map((bucket) => {
    const inB = settled.filter((r) => scoreLevelBucket(r.scoreLevel) === bucket);
    const win = inB.filter((r) => r.labelAsOf === "WIN").length;
    const loss = inB.filter((r) => r.labelAsOf === "LOSS").length;
    const voidN = inB.filter((r) => r.labelAsOf === "VOID").length;
    // economic subset: WIN/LOSS, resolved event, valid price, one bet per event (chronological first)
    const claimed = new Set<string>();
    const pnls: number[] = [];
    for (const r of inB) {
      if (!WIN_LOSS.has(r.labelAsOf)) continue;
      if (!r.providerEventId || !validEntryPrice(r.entryPrice)) continue;
      if (claimed.has(r.providerEventId)) continue;
      claimed.add(r.providerEventId);
      pnls.push(settleBetU(r.labelAsOf === "WIN" ? "WIN" : "LOSS", r.entryPrice));
    }
    const pnl = pnls.reduce((a, b) => a + b, 0);
    return {
      BUCKET: bucket,
      SETTLED_N: inB.length,
      WIN: win,
      LOSS: loss,
      VOID: voidN,
      ECONOMIC_N: pnls.length,
      PNL_U: round(pnl, 2),
      ROI_PCT: pnls.length ? round((pnl / pnls.length) * 100, 4) : 0,
      MAX_DRAWDOWN_U: round(maxDdFromPnls(pnls), 2),
    };
  });
}

// ── per Model × Population × Period cell ─────────────────────────────────
export interface ModelCell {
  MODEL_ID: FrozenModelId;
  ROLE: string;
  PREDICATE: string;
  INPUT_ELIGIBLE_ROW_N: number;
  SELECTED_PHYSICAL_EVENT_N: number;
  WINS: number;
  LOSSES: number;
  PNL_U: number;
  ROI_PCT: number;
  MAX_DRAWDOWN_U: number;
  PNL_PER_100_BETS: number;
  raw: ModelResult["raw"];
  STABILITY: ModelStability;
}

export interface DataQualityBlock {
  INPUT_ROWS: RollingManifest["POPULATIONS"][number]["INPUT_ROWS"];
  UNIQUE_SELECTION_N: RollingManifest["POPULATIONS"][number]["UNIQUE_SELECTION_N"];
  UNIQUE_PHYSICAL_EVENT_SELECTION_N: RollingManifest["POPULATIONS"][number]["UNIQUE_PHYSICAL_EVENT_SELECTION_N"];
  SETTLED_N: number;
  OPEN_N: number;
  NO_MATCH_N: number;
  SCORE_LEVEL: RollingManifest["POPULATIONS"][number]["SCORE_LEVEL"];
  SCORE_SERIES: {
    COVERAGE_PCT: number;
    STATUS: "DATA_QUALITY_ONLY";
    NOTE: string;
  };
  FEATURE_COVERAGE: RollingManifest["POPULATIONS"][number]["FEATURE_COVERAGE"];
}

export interface ScorecardCell {
  PERIOD: Period;
  POPULATION_ID: string;
  WINDOW_START: string;
  WINDOW_END: string;
  DATA_QUALITY: DataQualityBlock;
  ENGINE_INPUT_ADAPTER: AdapterExclusions;
  MODELS: Record<FrozenModelId, ModelCell>;
  SCORE_LEVEL_DIAGNOSTIC: ScoreLevelBucketRow[];
}

export interface ScorecardComparisonEntry {
  MODEL_ID: FrozenModelId;
  POPULATION_ID: string;
  BY_PERIOD: Record<Period, {
    N: number;
    PNL_U: number;
    ROI_PCT: number;
    MAX_DRAWDOWN_U: number;
    PNL_PER_100_BETS: number;
    POSITIVE_BUCKET_N: number;
    NEGATIVE_BUCKET_N: number;
    BURST_CONCENTRATION: number | null;
  }>;
}

export interface Scorecard {
  MISSION: "DETERMINISTIC_RICH_MODEL_SCORECARD_V1";
  GENERATED_AT: string;
  ENGINE_VERSION: string;
  MODEL_VERSION: string;
  EVALUATION_MODE: "BACKWARD_LOOKING_DESCRIPTIVE";
  FORWARD_VALIDATED: false;
  DISCLAIMER: string;
  THRESHOLD_SEARCH_PERFORMED: false;
  SIZING: "flat 1u per selected physical event";
  POPULATION_POOLING: "FORBIDDEN";
  SCORE_SERIES_USED_AS_PREDICATE: false;
  SCORE_LEVEL_BUCKETS_FIXED: readonly string[];
  WINDOW_END: string;
  CELLS: ScorecardCell[];
  COMPARISON: ScorecardComparisonEntry[];
}

export interface ScorecardInput {
  /** windowDays → { view, manifestPopulations } for that period, built by the caller from canonical partitions. */
  periods: Record<Period, {
    view: ScorecardRowView;
    manifestPopulations: RollingManifest["POPULATIONS"];
  }>;
  generatedAt: string;
}

function pnlPer100(pnlU: number, n: number): number {
  return n === 0 ? 0 : round((pnlU / n) * 100, 2);
}

function buildModelCell(
  id: FrozenModelId,
  result: ModelResult,
  eligibleN: number,
  windowStart: string,
  windowDays: number,
): ModelCell {
  return {
    MODEL_ID: id,
    ROLE: FROZEN_MODELS[id].ROLE,
    PREDICATE: FROZEN_MODELS[id].predicateDescription,
    INPUT_ELIGIBLE_ROW_N: eligibleN,
    SELECTED_PHYSICAL_EVENT_N: result.SELECTED_PHYSICAL_EVENT_N,
    WINS: result.WINS,
    LOSSES: result.LOSSES,
    PNL_U: result.PNL_U,
    ROI_PCT: result.ROI_PCT,
    MAX_DRAWDOWN_U: result.MAX_DRAWDOWN_U,
    PNL_PER_100_BETS: pnlPer100(result.raw.pnlU, result.SELECTED_PHYSICAL_EVENT_N),
    raw: result.raw,
    STABILITY: stability(result.selectedBets, windowStart, windowDays),
  };
}

const PERIOD_DAYS: Record<Period, number> = { "7d": 7, "14d": 14, "30d": 30 };

export function buildScorecard(input: ScorecardInput): Scorecard {
  const cells: ScorecardCell[] = [];

  for (const period of PERIODS) {
    const { view, manifestPopulations } = input.periods[period];
    const populationIds = [...new Set(view.rows.map((r) => r.populationId))].sort();

    for (const popId of populationIds) {
      const rows = view.rows.filter((r) => r.populationId === popId);
      const mp = manifestPopulations.find((p) => p.population_id === popId);
      const { input: engineInput, exclusions } = adaptForEngine(rows);
      const engine = runResearchEngine(engineInput, "all");

      const MODELS = {} as Record<FrozenModelId, ModelCell>;
      for (const id of FROZEN_MODEL_IDS) {
        MODELS[id] = buildModelCell(
          id,
          engine.models[id],
          engineInput.length,
          view.WINDOW_START,
          PERIOD_DAYS[period],
        );
      }

      const settledN = rows.filter((r) => SETTLED.has(r.labelAsOf)).length;
      cells.push({
        PERIOD: period,
        POPULATION_ID: popId,
        WINDOW_START: view.WINDOW_START,
        WINDOW_END: view.WINDOW_END,
        DATA_QUALITY: {
          INPUT_ROWS: mp?.INPUT_ROWS ?? { value: rows.length, unit: "scorecard rows", source_stage: "WINDOW_UNIQUE_SELECTION" },
          UNIQUE_SELECTION_N: mp?.UNIQUE_SELECTION_N ?? { value: rows.length, unit: "distinct selection identity", source_stage: "WINDOW_UNIQUE_SELECTION" },
          UNIQUE_PHYSICAL_EVENT_SELECTION_N: mp?.UNIQUE_PHYSICAL_EVENT_SELECTION_N ?? { value: 0, unit: "distinct provider_event_id", source_stage: "WINDOW_UNIQUE_PHYSICAL_EVENT" },
          SETTLED_N: settledN,
          OPEN_N: rows.filter((r) => r.labelAsOf === "OPEN").length,
          NO_MATCH_N: rows.filter((r) => r.labelAsOf === "NO_MATCH").length,
          SCORE_LEVEL: mp?.SCORE_LEVEL ?? {
            INPUT_DENOMINATOR: rows.length,
            SCORE_LEVEL_PRESENT_N: rows.filter((r) => typeof r.scoreLevel === "number").length,
            SCORE_LEVEL_COVERAGE_PCT: 0,
            MIN: null,
            MAX: null,
            UNIT: "unique-selection rows with a decision-time Score LEVEL",
            SOURCE_STAGE: "WINDOW_UNIQUE_SELECTION",
            SOURCE: "generated_signal_pairs.pre_event_score_num",
          },
          SCORE_SERIES: {
            COVERAGE_PCT: mp ? mp.FEATURE_COVERAGE.score_numeric_pct * 100 : 0,
            STATUS: "DATA_QUALITY_ONLY",
            NOTE: "Score SERIES (GSRS observation movement) is a DATA QUALITY dimension only. It is NEVER used as a predicate in this scorecard; a model that requires it is ineligible until its evidence exists.",
          },
          FEATURE_COVERAGE: mp?.FEATURE_COVERAGE ?? {
            score_numeric_pct: 0, score_numeric_n: 0,
            score_level_pct: 0, score_level_n: 0, score_level_min: null, score_level_max: null,
            price_path_pct: 0, volume_usd_pct: 0, lead_time_pct: 0,
            price_path_n: 0, volume_usd_n: 0, lead_time_n: 0,
          },
        },
        ENGINE_INPUT_ADAPTER: exclusions,
        MODELS,
        SCORE_LEVEL_DIAGNOSTIC: scoreLevelDiagnostic(rows),
      });
    }
  }

  // ── comparison table (Architect-facing; no winner is chosen here) ───────
  const comparison: ScorecardComparisonEntry[] = [];
  const popIds = [...new Set(cells.map((c) => c.POPULATION_ID))].sort();
  for (const id of FROZEN_MODEL_IDS) {
    for (const popId of popIds) {
      const byPeriod = {} as ScorecardComparisonEntry["BY_PERIOD"];
      for (const period of PERIODS) {
        const cell = cells.find((c) => c.PERIOD === period && c.POPULATION_ID === popId);
        const m = cell?.MODELS[id];
        byPeriod[period] = {
          N: m?.SELECTED_PHYSICAL_EVENT_N ?? 0,
          PNL_U: m?.PNL_U ?? 0,
          ROI_PCT: m?.ROI_PCT ?? 0,
          MAX_DRAWDOWN_U: m?.MAX_DRAWDOWN_U ?? 0,
          PNL_PER_100_BETS: m?.PNL_PER_100_BETS ?? 0,
          POSITIVE_BUCKET_N: m?.STABILITY.POSITIVE_BUCKET_N ?? 0,
          NEGATIVE_BUCKET_N: m?.STABILITY.NEGATIVE_BUCKET_N ?? 0,
          BURST_CONCENTRATION: m?.STABILITY.BURST_CONCENTRATION ?? null,
        };
      }
      comparison.push({ MODEL_ID: id, POPULATION_ID: popId, BY_PERIOD: byPeriod });
    }
  }

  const windowEnd = input.periods["30d"].view.WINDOW_END;
  return {
    MISSION: "DETERMINISTIC_RICH_MODEL_SCORECARD_V1",
    GENERATED_AT: input.generatedAt,
    ENGINE_VERSION: MODEL_RESEARCH_ENGINE_VERSION,
    MODEL_VERSION: MODEL_RESEARCH_ENGINE_VERSION,
    EVALUATION_MODE: "BACKWARD_LOOKING_DESCRIPTIVE",
    FORWARD_VALIDATED: false,
    DISCLAIMER:
      "Every number here is a BACKWARD-LOOKING DESCRIPTIVE statistic over settled corpus rows at the latest Gamma-authoritative AS-OF label state. It is NOT a forward-performance claim, NOT a strategy, and NOT investment advice. FORWARD_VALIDATED is false for every cell.",
    THRESHOLD_SEARCH_PERFORMED: false,
    SIZING: "flat 1u per selected physical event",
    POPULATION_POOLING: "FORBIDDEN",
    SCORE_SERIES_USED_AS_PREDICATE: false,
    SCORE_LEVEL_BUCKETS_FIXED: [...SCORE_LEVEL_BUCKETS],
    WINDOW_END: windowEnd,
    CELLS: cells,
    COMPARISON: comparison,
  };
}
