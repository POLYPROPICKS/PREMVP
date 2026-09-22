/**
 * AUGUST_FACTOR_ATLAS_V1 — deterministic broad factor + pairwise-interaction
 * screen over the already-immutable Aug04-Aug31 research corpus.
 *
 * Local disk only: reads CORPUS/MANIFEST via the existing loadPartition()
 * (fail-closed hash verification) and reuses the existing frozen-range
 * explicit view + frozen-engine primitives verbatim. SCREENING ONLY — never
 * promotes a model, never modifies frozen C0/C1/C4/C5, never touches
 * DB/Railway/Gamma.
 *
 *   npx tsx scripts/modeling/factor-atlas.ts \
 *     --start=2026-08-04 --end=2026-08-31 --pretty
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildExplicitDateRangeRowView,
  enumerateMinskDates,
  type CorpusLabel,
  type DerivedSeries,
  type LoadedPartition,
  type ScorecardReadyRow,
} from "@/lib/modeling/research-corpus/rollingCorpus";
import { evaluateRows, resolveSportFamily } from "@/lib/research-clone/modelReady";
import {
  ENTRY_PRICE_BAND,
  evaluateEvent,
  sortChronologically,
  aggregateMetrics,
  settleBetU,
  type EvaluatedEvent,
  type ResearchEngineInputEvent,
  type SelectedBet,
} from "@/lib/modeling/research-engine";
import { loadPartition } from "./rolling-research-corpus";

export const ATLAS_OUT_DIR = "modeling/evidence/factor-atlas-v1";

/** Existing accepted frozen-engine reference artifact (PR #350). Read-only. */
const FROZEN_REFERENCE_ARTIFACT = "modeling/evidence/frozen-range-replay-v1/REPLAY_2026-08-04_2026-08-31.json";

export const WEEKS = [
  { WEEK_ID: "W1", start: "2026-08-04", end: "2026-08-10" },
  { WEEK_ID: "W2", start: "2026-08-11", end: "2026-08-17" },
  { WEEK_ID: "W3", start: "2026-08-18", end: "2026-08-24" },
  { WEEK_ID: "W4", start: "2026-08-25", end: "2026-08-31" },
] as const;

const INTERACTION_MIN_N = 30;
const SPORT_MIN_N = 20;

export interface AtlasInputEvent extends ResearchEngineInputEvent {
  scoreLevel: number | null;
  score: DerivedSeries;
  selectedPrice: DerivedSeries;
  volumeUsd: number | null;
  /** Verbatim ScorecardReadyRow.leadTimeHours — distinct from the engine-computed leadTimeHours. */
  rowLeadTimeHours: number | null;
  /**
   * Verbatim canonical_row.marketTypeRaw. Not declared on the
   * ScorecardReadyRow TS interface (lib/modeling/research-corpus/rollingCorpus.ts),
   * but rows written by the direct materializer
   * (scripts/modeling/materialize-research-model-ready.ts:219 spreads the
   * full forward-rich row — lib/modeling/forward-rich/materializeForwardRichResearch.ts:271 —
   * before narrowing the TS type) DO carry it on the persisted JSON. Read
   * directly off canonical_row here; never reconstructed via a secondary
   * evidence-table join.
   */
  marketTypeRaw: string | null;
}
/** canonical_row carries more fields at runtime than the ScorecardReadyRow TS interface declares — see AtlasInputEvent.marketTypeRaw. */
type ScorecardReadyRowWithMarketType = ScorecardReadyRow & { marketTypeRaw?: unknown };
interface AtlasEvaluatedEvent extends EvaluatedEvent {
  scoreLevel: number | null;
  score: DerivedSeries;
  selectedPrice: DerivedSeries;
  volumeUsd: number | null;
  rowLeadTimeHours: number | null;
}

function inC0PriceBand(entryPrice: number): boolean {
  return entryPrice >= ENTRY_PRICE_BAND.minInclusive && entryPrice < ENTRY_PRICE_BAND.maxExclusive;
}

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
    .join(",")}}`;
}
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Same normalized/filtered input the frozen engine consumes, carrying every allowed decision-time feature. */
export function toAtlasInput(rows: ScorecardReadyRow[]): AtlasInputEvent[] {
  return rows
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
      candidateRef: r.selectedTokenId,
      scoreLevel: typeof r.scoreLevel === "number" ? r.scoreLevel : null,
      score: r.score,
      selectedPrice: r.selectedPrice,
      volumeUsd: typeof r.volumeUsd === "number" ? r.volumeUsd : null,
      rowLeadTimeHours: typeof r.leadTimeHours === "number" ? r.leadTimeHours : null,
      marketTypeRaw: typeof (r as ScorecardReadyRowWithMarketType).marketTypeRaw === "string" ? ((r as ScorecardReadyRowWithMarketType).marketTypeRaw as string) : null,
    }));
}

/**
 * SELECTION_BEFORE_SETTLEMENT_V1 — decision-time-only candidate input.
 *
 * Identical qualification to `toAtlasInput()` above MINUS the
 * `labelAsOf === WIN/LOSS` filter. `labelAsOf` is carried through verbatim
 * for a caller to read strictly AFTER a candidate has already been selected
 * and capped (see `runStandaloneStrict`/`runPortfolioStrict` and
 * `partialMetricsFor` in scripts/modeling/daily-portfolio-frontier.ts) — it
 * is never exposed to a qualification predicate or to the chronological
 * comparator, so settlement availability can never influence which
 * candidate occupies a physical event's slot.
 */
export interface DecisionTimeCandidate {
  physicalEventKey: string;
  decisionTimestamp: string;
  eventStart: string;
  entryPrice: number;
  sportFamily: string;
  ref: string;
  candidateRef: string;
  scoreLevel: number | null;
  score: DerivedSeries;
  selectedPrice: DerivedSeries;
  volumeUsd: number | null;
  rowLeadTimeHours: number | null;
  marketTypeRaw: string | null;
  /** Settlement status, attached but NEVER read for qualification/ordering. */
  labelAsOf: CorpusLabel;
}

export function toDecisionTimeCandidates(rows: ScorecardReadyRow[]): DecisionTimeCandidate[] {
  return rows
    .filter(
      (r) =>
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
      ref: r.conditionId,
      candidateRef: r.selectedTokenId,
      scoreLevel: typeof r.scoreLevel === "number" ? r.scoreLevel : null,
      score: r.score,
      selectedPrice: r.selectedPrice,
      volumeUsd: typeof r.volumeUsd === "number" ? r.volumeUsd : null,
      rowLeadTimeHours: typeof r.leadTimeHours === "number" ? r.leadTimeHours : null,
      marketTypeRaw: typeof (r as ScorecardReadyRowWithMarketType).marketTypeRaw === "string" ? ((r as ScorecardReadyRowWithMarketType).marketTypeRaw as string) : null,
      labelAsOf: r.labelAsOf,
    }));
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
    ...(event.candidateRef === undefined ? {} : { candidateRef: event.candidateRef }),
  };
}

export interface CellRunResult {
  events: number;
  wins: number;
  losses: number;
  pnl_u: number;
  roi_pct: number;
  max_drawdown_u: number;
  selectedBets: SelectedBet[];
}

/**
 * Deterministic economic evaluation of ONE cell predicate over normalized
 * input, reusing only the exported frozen-engine primitives (never an
 * independent settlement/ordering formula): evaluateEvent,
 * sortChronologically, aggregateMetrics, settleBetU. The predicate is applied
 * to qualify candidate rows BEFORE chronological physical-event selection —
 * never a post-selection partition of an already-selected result. Same
 * invariant as the frozen engine: one physicalEventKey -> maximum one
 * selected bet, chronological-first qualifying row wins.
 */
export function runCell(input: AtlasInputEvent[], predicate: (e: AtlasEvaluatedEvent) => boolean): CellRunResult {
  const ordered = sortChronologically(input.map((e) => evaluateEvent(e) as AtlasEvaluatedEvent)) as AtlasEvaluatedEvent[];
  const selectedBets: SelectedBet[] = [];
  const claimedKeys = new Set<string>();
  for (const event of ordered) {
    if (claimedKeys.has(event.physicalEventKey)) continue; // one physical event -> maximum one selected bet
    if (!predicate(event)) continue;
    claimedKeys.add(event.physicalEventKey);
    selectedBets.push(toSelectedBet(event));
  }
  const m = aggregateMetrics(selectedBets);
  return {
    events: m.SELECTED_PHYSICAL_EVENT_N,
    wins: m.WINS,
    losses: m.LOSSES,
    pnl_u: m.PNL_U,
    roi_pct: m.ROI_PCT,
    max_drawdown_u: m.MAX_DRAWDOWN_U,
    selectedBets,
  };
}

// ── Bucket / factor-family definitions ──────────────────────────────────────

interface Bucket {
  id: string;
  predicate: (e: AtlasEvaluatedEvent) => boolean;
}
interface Factor {
  id: string;
  buckets: Bucket[];
}

const PRICE_FACTOR: Factor = {
  id: "PRICE",
  buckets: [
    { id: "P50_52", predicate: (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52 },
    { id: "P52_54", predicate: (e) => e.entryPrice >= 0.52 && e.entryPrice < 0.54 },
    { id: "P54_56", predicate: (e) => e.entryPrice >= 0.54 && e.entryPrice < 0.56 },
    { id: "P56_58", predicate: (e) => e.entryPrice >= 0.56 && e.entryPrice < 0.58 },
    { id: "P58_60", predicate: (e) => e.entryPrice >= 0.58 && e.entryPrice < 0.6 },
  ],
};

const SCORE_LEVEL_FACTOR: Factor = {
  id: "SCORE_LEVEL",
  buckets: [
    { id: "S_LT60", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel < 60 },
    { id: "S_60_62", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 60 && e.scoreLevel < 63 },
    { id: "S_63_64", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65 },
    { id: "S_65_67", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 65 && e.scoreLevel < 68 },
    { id: "S_GE68", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 68 },
  ],
};

const LEAD_TIME_FACTOR: Factor = {
  id: "LEAD_TIME",
  buckets: [
    { id: "L_LT3", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.rowLeadTimeHours === "number" && e.rowLeadTimeHours < 3 },
    { id: "L_3_6", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.rowLeadTimeHours === "number" && e.rowLeadTimeHours >= 3 && e.rowLeadTimeHours < 6 },
    { id: "L_6_12", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.rowLeadTimeHours === "number" && e.rowLeadTimeHours >= 6 && e.rowLeadTimeHours < 12 },
    { id: "L_12_18", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.rowLeadTimeHours === "number" && e.rowLeadTimeHours >= 12 && e.rowLeadTimeHours < 18 },
    { id: "L_18_24", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.rowLeadTimeHours === "number" && e.rowLeadTimeHours >= 18 && e.rowLeadTimeHours < 24 },
    { id: "L_GE24", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.rowLeadTimeHours === "number" && e.rowLeadTimeHours >= 24 },
  ],
};

const VOLUME_FACTOR: Factor = {
  id: "VOLUME",
  buckets: [
    { id: "V_LT100K", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.volumeUsd === "number" && e.volumeUsd < 100_000 },
    { id: "V_100_200K", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.volumeUsd === "number" && e.volumeUsd >= 100_000 && e.volumeUsd < 200_000 },
    { id: "V_200_350K", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.volumeUsd === "number" && e.volumeUsd >= 200_000 && e.volumeUsd < 350_000 },
    { id: "V_350_500K", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.volumeUsd === "number" && e.volumeUsd >= 350_000 && e.volumeUsd < 500_000 },
    { id: "V_GE500K", predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.volumeUsd === "number" && e.volumeUsd >= 500_000 },
  ],
};

const SCORE_SERIES_DIRECTION_FACTOR: Factor = {
  id: "SCORE_SERIES_DIRECTION",
  buckets: [
    { id: "SCORE_DELTA_NEG", predicate: (e) => inC0PriceBand(e.entryPrice) && e.score.observationCount >= 2 && typeof e.score.delta === "number" && e.score.delta < 0 },
    { id: "SCORE_DELTA_ZERO", predicate: (e) => inC0PriceBand(e.entryPrice) && e.score.observationCount >= 2 && typeof e.score.delta === "number" && e.score.delta === 0 },
    { id: "SCORE_DELTA_POS", predicate: (e) => inC0PriceBand(e.entryPrice) && e.score.observationCount >= 2 && typeof e.score.delta === "number" && e.score.delta > 0 },
  ],
};

const PRICE_SERIES_DIRECTION_FACTOR: Factor = {
  id: "PRICE_SERIES_DIRECTION",
  buckets: [
    { id: "PRICE_DELTA_NEG", predicate: (e) => inC0PriceBand(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta < 0 },
    { id: "PRICE_DELTA_ZERO", predicate: (e) => inC0PriceBand(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta === 0 },
    { id: "PRICE_DELTA_POS", predicate: (e) => inC0PriceBand(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta > 0 },
  ],
};

const PRICE_SERIES_MAGNITUDE_FACTOR: Factor = {
  id: "PRICE_SERIES_MAGNITUDE",
  buckets: [
    { id: "PRICE_DELTA_LE_NEG_002", predicate: (e) => inC0PriceBand(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta <= -0.02 },
    { id: "PRICE_DELTA_NEG_002_TO_0", predicate: (e) => inC0PriceBand(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta > -0.02 && e.selectedPrice.delta < 0 },
    { id: "PRICE_DELTA_0_TO_POS_002", predicate: (e) => inC0PriceBand(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta >= 0 && e.selectedPrice.delta < 0.02 },
    { id: "PRICE_DELTA_GE_POS_002", predicate: (e) => inC0PriceBand(e.entryPrice) && e.selectedPrice.observationCount >= 2 && typeof e.selectedPrice.delta === "number" && e.selectedPrice.delta >= 0.02 },
  ],
};

/** SPORT is dynamic per population: exact normalized sportFamily values with C0-band N>=20. Never collapsed to OTHER. */
function buildSportFactor(c0Input: AtlasEvaluatedEvent[]): Factor {
  const counts = new Map<string, number>();
  for (const e of c0Input) {
    if (!e.sportFamily) continue;
    counts.set(e.sportFamily, (counts.get(e.sportFamily) ?? 0) + 1);
  }
  const sports = [...counts.entries()]
    .filter(([, n]) => n >= SPORT_MIN_N)
    .map(([sport]) => sport)
    .sort();
  return {
    id: "SPORT",
    buckets: sports.map((sport) => ({
      id: `SPORT_${sport.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
      predicate: (e: AtlasEvaluatedEvent) => inC0PriceBand(e.entryPrice) && e.sportFamily === sport,
    })),
  };
}

const INTERACTION_PAIRS: Array<[string, string]> = [
  ["PRICE", "SPORT"],
  ["SCORE_LEVEL", "SPORT"],
  ["PRICE", "SCORE_LEVEL"],
  ["LEAD_TIME", "SPORT"],
  ["VOLUME", "PRICE"],
  ["SCORE_SERIES_DIRECTION", "SPORT"],
  ["PRICE_SERIES_DIRECTION", "SPORT"],
  ["SCORE_LEVEL", "LEAD_TIME"],
];

function sampleFlag(n: number): "N_LT30" | "N_30_99" | "N_100_299" | "N_GE300" {
  if (n < 30) return "N_LT30";
  if (n < 100) return "N_30_99";
  if (n < 300) return "N_100_299";
  return "N_GE300";
}
function robustnessFlag(positiveWeekN: number | null): string | null {
  if (positiveWeekN === null) return null;
  return `${positiveWeekN}_POS`;
}

interface WeeklyAgg {
  rows: Array<{ WEEK_ID: string; event_n: number; pnl_u: number; roi_pct: number }>;
  positive: number;
  negative: number;
  zero: number;
}
function weeklyAggFromRows(rows: Array<{ event_n: number; pnl_u: number }>): Pick<WeeklyAgg, "positive" | "negative" | "zero"> {
  let positive = 0;
  let negative = 0;
  let zero = 0;
  for (const r of rows) {
    if (r.pnl_u > 0) positive += 1;
    else if (r.pnl_u < 0) negative += 1;
    else zero += 1;
  }
  return { positive, negative, zero };
}

export interface CellOut {
  SOURCE: "MAIN_EFFECT" | "INTERACTION";
  FACTOR_ID: string;
  CELL_ID: string;
  events: number;
  wins: number;
  losses: number;
  pnl_u: number;
  roi_pct: number;
  max_drawdown_u: number;
  sample_flag: string;
  positive_week_n: number | null;
  negative_week_n: number | null;
  zero_week_n: number | null;
  robustness: string | null;
  weekly: Array<{ WEEK_ID: string; event_n: number; pnl_u: number; roi_pct: number }> | null;
}

interface WeekPartitions {
  WEEK_ID: string;
  start: string;
  end: string;
  partitions: LoadedPartition[];
}

function computeWeeklyForPredicate(
  weekPartitions: WeekPartitions[],
  populationId: string,
  predicate: (e: AtlasEvaluatedEvent) => boolean,
): WeeklyAgg {
  const rows = weekPartitions.map((w) => {
    const weekView = buildExplicitDateRangeRowView({ rangeStart: w.start, rangeEnd: w.end, partitions: w.partitions });
    const popRows = weekView.rows.filter((r: ScorecardReadyRow) => r.populationId === populationId);
    const input = toAtlasInput(popRows);
    const result = runCell(input, predicate);
    return { WEEK_ID: w.WEEK_ID, event_n: result.events, pnl_u: result.pnl_u, roi_pct: result.roi_pct };
  });
  return { rows, ...weeklyAggFromRows(rows) };
}

function evaluateAndReport(
  source: CellOut["SOURCE"],
  factorId: string,
  cellId: string,
  input: AtlasInputEvent[],
  weekPartitions: WeekPartitions[],
  populationId: string,
  predicate: (e: AtlasEvaluatedEvent) => boolean,
): CellOut {
  const result = runCell(input, predicate);
  let weekly: WeeklyAgg | null = null;
  if (result.events >= 30) {
    weekly = computeWeeklyForPredicate(weekPartitions, populationId, predicate);
  }
  return {
    SOURCE: source,
    FACTOR_ID: factorId,
    CELL_ID: cellId,
    events: result.events,
    wins: result.wins,
    losses: result.losses,
    pnl_u: result.pnl_u,
    roi_pct: result.roi_pct,
    max_drawdown_u: result.max_drawdown_u,
    sample_flag: sampleFlag(result.events),
    positive_week_n: weekly?.positive ?? null,
    negative_week_n: weekly?.negative ?? null,
    zero_week_n: weekly?.zero ?? null,
    robustness: robustnessFlag(weekly?.positive ?? null),
    weekly: weekly?.rows ?? null,
  };
}

interface FrozenReferenceModel {
  events: number;
  wins: number;
  losses: number;
  pnl_u: number;
  roi_pct: number;
  max_drawdown_u: number;
}
function loadFrozenReferenceC0(): Record<string, FrozenReferenceModel> {
  const json = JSON.parse(readFileSync(FROZEN_REFERENCE_ARTIFACT, "utf8")) as {
    POPULATIONS: Array<{
      POPULATION_ID: string;
      MODELS: Array<{
        MODEL_ID: string;
        SELECTED_PHYSICAL_EVENT_N: number;
        WINS: number;
        LOSSES: number;
        PNL_U: number;
        ROI_PCT: number;
        MAX_DRAWDOWN_U: number;
      }>;
    }>;
  };
  const out: Record<string, FrozenReferenceModel> = {};
  for (const pop of json.POPULATIONS) {
    const c0 = pop.MODELS.find((m) => m.MODEL_ID === "C0");
    if (!c0) throw new Error(`FROZEN_REFERENCE_C0_MISSING: ${pop.POPULATION_ID}`);
    out[pop.POPULATION_ID] = {
      events: c0.SELECTED_PHYSICAL_EVENT_N,
      wins: c0.WINS,
      losses: c0.LOSSES,
      pnl_u: c0.PNL_U,
      roi_pct: c0.ROI_PCT,
      max_drawdown_u: c0.MAX_DRAWDOWN_U,
    };
  }
  return out;
}

export interface AtlasBusinessResult {
  RANGE: { START: string; END: string };
  PARTITION_HASHES: Record<string, string>;
  PIT_FUTURE_LEAK_N: number;
  POPULATIONS: string[];
  FEATURE_COVERAGE: Record<
    string,
    { c0_band_input_n: number; score_level_n: number; score_series_ge2_n: number; price_series_ge2_n: number; volume_n: number; lead_n: number; sport_n: number }
  >;
  C0_PARITY: Record<string, { PASS: boolean; expected: FrozenReferenceModel; actual: FrozenReferenceModel }>;
  MAIN_EFFECTS: Record<string, CellOut[]>;
  INTERACTIONS: Record<string, CellOut[]>;
  LEADERBOARDS: Record<
    string,
    { TOP_BY_TOTAL_PNL: CellOut[]; TOP_BY_ROI_WITH_N_GE100: CellOut[]; TOP_BY_ROBUSTNESS_WITH_N_GE100: CellOut[] }
  >;
}

export function buildAtlasResult(start: string, end: string, partitions: LoadedPartition[]): AtlasBusinessResult {
  const view = buildExplicitDateRangeRowView({ rangeStart: start, rangeEnd: end, partitions });
  if (view.PIT_FUTURE_LEAK_N !== 0) {
    throw new Error(`ATLAS_PIT_FUTURE_LEAK_NONZERO: ${view.PIT_FUTURE_LEAK_N}`);
  }
  const populationIds = Object.keys(view.POPULATION_ROW_N).sort();
  const frozenReferenceC0 = loadFrozenReferenceC0();

  const weekPartitions: WeekPartitions[] = WEEKS.map((w) => ({
    ...w,
    partitions: partitions.filter((p) => p.partitionDate >= w.start && p.partitionDate <= w.end),
  }));

  const FEATURE_COVERAGE: AtlasBusinessResult["FEATURE_COVERAGE"] = {};
  const C0_PARITY: AtlasBusinessResult["C0_PARITY"] = {};
  const MAIN_EFFECTS: AtlasBusinessResult["MAIN_EFFECTS"] = {};
  const INTERACTIONS: AtlasBusinessResult["INTERACTIONS"] = {};
  const LEADERBOARDS: AtlasBusinessResult["LEADERBOARDS"] = {};

  for (const pop of populationIds) {
    const popRows = view.rows.filter((r: ScorecardReadyRow) => r.populationId === pop);
    const input = toAtlasInput(popRows);

    // --- C0 parity (exact existing engine) ---
    const evaluated = evaluateRows(popRows) as Record<string, any>;
    const actualC0: FrozenReferenceModel = {
      events: evaluated.C0.SELECTED_PHYSICAL_EVENT_N,
      wins: evaluated.C0.WINS,
      losses: evaluated.C0.LOSSES,
      pnl_u: evaluated.C0.PNL_U,
      roi_pct: evaluated.C0.ROI_PCT,
      max_drawdown_u: evaluated.C0.MAX_DRAWDOWN_U,
    };
    const expectedC0 = frozenReferenceC0[pop];
    if (!expectedC0) throw new Error(`FROZEN_REFERENCE_MISSING: ${pop}`);
    const pass = canonicalJson(actualC0) === canonicalJson(expectedC0);
    if (!pass) throw new Error(`C0_PARITY_FAIL: ${pop} expected=${canonicalJson(expectedC0)} actual=${canonicalJson(actualC0)}`);
    C0_PARITY[pop] = { PASS: pass, expected: expectedC0, actual: actualC0 };

    // --- feature coverage (mechanical, on C0-band normalized input) ---
    const ordered = sortChronologically(input.map((e) => evaluateEvent(e) as AtlasEvaluatedEvent)) as AtlasEvaluatedEvent[];
    const c0Band = ordered.filter((e) => inC0PriceBand(e.entryPrice));
    FEATURE_COVERAGE[pop] = {
      c0_band_input_n: c0Band.length,
      score_level_n: c0Band.filter((e) => typeof e.scoreLevel === "number").length,
      score_series_ge2_n: c0Band.filter((e) => e.score.observationCount >= 2).length,
      price_series_ge2_n: c0Band.filter((e) => e.selectedPrice.observationCount >= 2).length,
      volume_n: c0Band.filter((e) => typeof e.volumeUsd === "number").length,
      lead_n: c0Band.filter((e) => typeof e.rowLeadTimeHours === "number").length,
      sport_n: c0Band.filter((e) => e.sportFamily).length,
    };

    // --- factor families (SPORT built dynamically from this population's C0 band) ---
    const sportFactor = buildSportFactor(c0Band);
    const factorsById = new Map<string, Factor>([
      [PRICE_FACTOR.id, PRICE_FACTOR],
      [SCORE_LEVEL_FACTOR.id, SCORE_LEVEL_FACTOR],
      [LEAD_TIME_FACTOR.id, LEAD_TIME_FACTOR],
      [VOLUME_FACTOR.id, VOLUME_FACTOR],
      [sportFactor.id, sportFactor],
      [SCORE_SERIES_DIRECTION_FACTOR.id, SCORE_SERIES_DIRECTION_FACTOR],
      [PRICE_SERIES_DIRECTION_FACTOR.id, PRICE_SERIES_DIRECTION_FACTOR],
      [PRICE_SERIES_MAGNITUDE_FACTOR.id, PRICE_SERIES_MAGNITUDE_FACTOR],
    ]);

    // --- main effects ---
    const allCells: CellOut[] = [];
    for (const factor of factorsById.values()) {
      const cells = factor.buckets.map((bucket) => evaluateAndReport("MAIN_EFFECT", factor.id, bucket.id, input, weekPartitions, pop, bucket.predicate));
      MAIN_EFFECTS[`${pop}::${factor.id}`] = cells;
      allCells.push(...cells);
    }

    // --- pairwise interactions ---
    for (const [aId, bId] of INTERACTION_PAIRS) {
      const factorA = factorsById.get(aId);
      const factorB = factorsById.get(bId);
      if (!factorA || !factorB) continue;
      const interactionId = `${aId}_X_${bId}`;
      const cells: CellOut[] = [];
      for (const bucketA of factorA.buckets) {
        for (const bucketB of factorB.buckets) {
          const cellId = `${bucketA.id}__${bucketB.id}`;
          const predicate = (e: AtlasEvaluatedEvent) => bucketA.predicate(e) && bucketB.predicate(e);
          const cell = evaluateAndReport("INTERACTION", interactionId, cellId, input, weekPartitions, pop, predicate);
          cells.push(cell);
          allCells.push(cell);
        }
      }
      // Smaller cells are still conserved above (allCells) but omitted from the ranked atlas.
      INTERACTIONS[`${pop}::${interactionId}`] = cells.filter((c) => c.events >= INTERACTION_MIN_N);
    }

    // --- leaderboards (pooled across main effects + interactions) ---
    const byPnl = [...allCells].sort((a, b) => b.pnl_u - a.pnl_u).slice(0, 20);
    const byRoi = allCells
      .filter((c) => c.events >= 100)
      .sort((a, b) => b.roi_pct - a.roi_pct)
      .slice(0, 20);
    const byRobustness = allCells
      .filter((c) => c.events >= 100 && c.positive_week_n !== null)
      .sort((a, b) => (b.positive_week_n! - a.positive_week_n!) || (b.pnl_u - a.pnl_u))
      .slice(0, 20);
    LEADERBOARDS[pop] = { TOP_BY_TOTAL_PNL: byPnl, TOP_BY_ROI_WITH_N_GE100: byRoi, TOP_BY_ROBUSTNESS_WITH_N_GE100: byRobustness };
  }

  return {
    RANGE: { START: start, END: end },
    PARTITION_HASHES: view.PARTITION_HASHES,
    PIT_FUTURE_LEAK_N: view.PIT_FUTURE_LEAK_N,
    POPULATIONS: populationIds,
    FEATURE_COVERAGE,
    C0_PARITY,
    MAIN_EFFECTS,
    INTERACTIONS,
    LEADERBOARDS,
  };
}

export function buildAtlasWithDeterminismProof(
  start: string,
  end: string,
  partitions: LoadedPartition[],
): { result: AtlasBusinessResult; canonicalSha256: string } {
  const result = buildAtlasResult(start, end, partitions);
  const reversed = buildAtlasResult(start, end, [...partitions].reverse());
  const a = sha256(canonicalJson(result));
  const b = sha256(canonicalJson(reversed));
  if (a !== b) throw new Error(`ATLAS_NONDETERMINISTIC_UNDER_PARTITION_ORDER: ${a} != ${b}`);
  return { result, canonicalSha256: a };
}

function arg(name: string): string | undefined {
  const eq = process.argv.find((v) => v.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function main(): Promise<void> {
  const start = arg("--start");
  const end = arg("--end");
  if (!start || !end) throw new Error("FACTOR_ATLAS_ARGS_REQUIRED: --start=YYYY-MM-DD --end=YYYY-MM-DD");
  const pretty = process.argv.includes("--pretty");

  const dates = enumerateMinskDates(start, end);
  if (dates.length !== 28) throw new Error(`FACTOR_ATLAS_RANGE_NOT_28_DAYS: ${dates.length}`);
  const partitions = dates.map((d) => loadPartition(d));
  const { result, canonicalSha256 } = buildAtlasWithDeterminismProof(start, end, partitions);

  const artifact = {
    ARTIFACT: "AUGUST_FACTOR_ATLAS_V1",
    ...result,
    DETERMINISM_REVERSED_PARTITIONS: "PASS",
    CANONICAL_RESULT_SHA256: canonicalSha256,
  };
  const json = JSON.stringify(artifact, null, 2) + "\n";
  mkdirSync(ATLAS_OUT_DIR, { recursive: true });
  const base = `ATLAS_${start}_${end}`;
  const jsonPath = join(ATLAS_OUT_DIR, `${base}.json`);
  writeFileSync(jsonPath, json, "utf8");
  const fileSha = sha256(json);
  writeFileSync(join(ATLAS_OUT_DIR, `${base}.SHA256SUMS.txt`), `${fileSha}  ${base}.json\n`, "utf8");

  const summary = {
    ARTIFACT: jsonPath.replace(/\\/g, "/"),
    ARTIFACT_SHA256: fileSha,
    CANONICAL_RESULT_SHA256: canonicalSha256,
    AVAILABLE_PARTITION_N: dates.length,
    MISSING_PARTITION_N: 0,
    PIT_FUTURE_LEAK_N: result.PIT_FUTURE_LEAK_N,
    C0_PARITY: result.C0_PARITY,
    FEATURE_COVERAGE: result.FEATURE_COVERAGE,
  };
  console.log(pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
