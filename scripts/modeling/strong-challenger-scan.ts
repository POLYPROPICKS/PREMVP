/**
 * STRONG_CHALLENGER_SCAN_V1 — deterministic strong-challenger robustness batch
 * over the already-immutable Aug04-Aug31 research corpus.
 *
 * SCREENING ONLY. Never promotes a model, never modifies frozen C0/C1/C4/C5,
 * never touches DB/Railway/Gamma. Local disk only: reads CORPUS/MANIFEST via
 * the existing loadPartition() (fail-closed hash verification) and reuses the
 * existing frozen-range explicit view + frozen-engine primitives verbatim.
 *
 *   npx tsx scripts/modeling/strong-challenger-scan.ts \
 *     --start=2026-08-04 --end=2026-08-31 --pretty
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildExplicitDateRangeRowView,
  enumerateMinskDates,
  type LoadedPartition,
  type ScorecardReadyRow,
} from "@/lib/modeling/research-corpus/rollingCorpus";
import { evaluateRows, resolveSportFamily } from "@/lib/research-clone/modelReady";
import {
  ENTRY_PRICE_BAND,
  SOCCER_FAMILY,
  FROZEN_MODEL_IDS,
  evaluateEvent,
  sortChronologically,
  aggregateMetrics,
  settleBetU,
  type EvaluatedEvent,
  type ResearchEngineInputEvent,
  type SelectedBet,
} from "@/lib/modeling/research-engine";
import { loadPartition } from "./rolling-research-corpus";

export const SCAN_OUT_DIR = "modeling/evidence/strong-challenger-scan-v1";

/** Existing accepted frozen-engine reference artifact (PR #350). Read-only. */
const FROZEN_REFERENCE_ARTIFACT = "modeling/evidence/frozen-range-replay-v1/REPLAY_2026-08-04_2026-08-31.json";

export const WEEKS = [
  { WEEK_ID: "W1", start: "2026-08-04", end: "2026-08-10" },
  { WEEK_ID: "W2", start: "2026-08-11", end: "2026-08-17" },
  { WEEK_ID: "W3", start: "2026-08-18", end: "2026-08-24" },
  { WEEK_ID: "W4", start: "2026-08-25", end: "2026-08-31" },
] as const;

interface ChallengerInputEvent extends ResearchEngineInputEvent {
  scoreLevel: number | null;
}
interface ChallengerEvaluatedEvent extends EvaluatedEvent {
  scoreLevel: number | null;
}

function inC0PriceBand(entryPrice: number): boolean {
  return entryPrice >= ENTRY_PRICE_BAND.minInclusive && entryPrice < ENTRY_PRICE_BAND.maxExclusive;
}

interface Challenger {
  CHALLENGER_ID: string;
  predicate: (e: ChallengerEvaluatedEvent) => boolean;
}

/** Fixed challenger set — do not expand in this mission. */
export const CHALLENGERS: Challenger[] = [
  { CHALLENGER_ID: "PRICE_050_054", predicate: (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54 },
  { CHALLENGER_ID: "PRICE_054_058", predicate: (e) => e.entryPrice >= 0.54 && e.entryPrice < 0.58 },
  { CHALLENGER_ID: "PRICE_058_060", predicate: (e) => e.entryPrice >= 0.58 && e.entryPrice < 0.6 },
  {
    CHALLENGER_ID: "C0_SCORE_GE50",
    predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 50,
  },
  {
    CHALLENGER_ID: "C0_SCORE_GE60",
    predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 60,
  },
  {
    CHALLENGER_ID: "C0_SCORE_GE65",
    predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 65,
  },
  {
    CHALLENGER_ID: "C0_SCORE_GE72",
    predicate: (e) => inC0PriceBand(e.entryPrice) && typeof e.scoreLevel === "number" && e.scoreLevel >= 72,
  },
  {
    CHALLENGER_ID: "SOCCER_SCORE_GE50",
    predicate: (e) =>
      inC0PriceBand(e.entryPrice) && e.sportFamily === SOCCER_FAMILY && typeof e.scoreLevel === "number" && e.scoreLevel >= 50,
  },
  {
    CHALLENGER_ID: "SOCCER_SCORE_GE60",
    predicate: (e) =>
      inC0PriceBand(e.entryPrice) && e.sportFamily === SOCCER_FAMILY && typeof e.scoreLevel === "number" && e.scoreLevel >= 60,
  },
  {
    CHALLENGER_ID: "SOCCER_SCORE_GE65",
    predicate: (e) =>
      inC0PriceBand(e.entryPrice) && e.sportFamily === SOCCER_FAMILY && typeof e.scoreLevel === "number" && e.scoreLevel >= 65,
  },
  {
    CHALLENGER_ID: "SOCCER_SCORE_GE72",
    predicate: (e) =>
      inC0PriceBand(e.entryPrice) && e.sportFamily === SOCCER_FAMILY && typeof e.scoreLevel === "number" && e.scoreLevel >= 72,
  },
  {
    CHALLENGER_ID: "NONSOCCER_LEAD_GE24",
    predicate: (e) => inC0PriceBand(e.entryPrice) && e.sportFamily !== SOCCER_FAMILY && e.leadTimeHours >= 24,
  },
];

const REFERENCE_IDS = FROZEN_MODEL_IDS.map((id) => `REF_${id}`);

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Stable JSON: object keys sorted recursively, so the hash is order independent. */
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

/** Same normalized/filtered input the frozen engine consumes, with scoreLevel retained. */
export function toChallengerInput(rows: ScorecardReadyRow[]): ChallengerInputEvent[] {
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
      scoreLevel: typeof r.scoreLevel === "number" ? r.scoreLevel : null,
    }));
}

function toSelectedBet(event: ChallengerEvaluatedEvent): SelectedBet {
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

export interface ChallengerRunResult {
  SELECTED_PHYSICAL_EVENT_N: number;
  WINS: number;
  LOSSES: number;
  PNL_U: number;
  ROI_PCT: number;
  MAX_DRAWDOWN_U: number;
  selectedBets: SelectedBet[];
}

/**
 * Deterministic economic evaluation of ONE predicate over normalized input,
 * reusing only the exported frozen-engine primitives (never an independent
 * settlement/ordering formula): evaluateEvent, sortChronologically,
 * aggregateMetrics, settleBetU. Same invariant as the frozen engine: one
 * physicalEventKey -> maximum one selected bet, chronological-first wins.
 */
export function runChallenger(
  input: ChallengerInputEvent[],
  predicate: (e: ChallengerEvaluatedEvent) => boolean,
): ChallengerRunResult {
  const ordered = sortChronologically(input.map((e) => evaluateEvent(e) as ChallengerEvaluatedEvent)) as ChallengerEvaluatedEvent[];
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
    SELECTED_PHYSICAL_EVENT_N: m.SELECTED_PHYSICAL_EVENT_N,
    WINS: m.WINS,
    LOSSES: m.LOSSES,
    PNL_U: m.PNL_U,
    ROI_PCT: m.ROI_PCT,
    MAX_DRAWDOWN_U: m.MAX_DRAWDOWN_U,
    selectedBets,
  };
}

function sampleFlag(n: number): "N_LT_20" | "N_20_49" | "N_50_199" | "N_GE_200" {
  if (n < 20) return "N_LT_20";
  if (n < 50) return "N_20_49";
  if (n < 200) return "N_50_199";
  return "N_GE_200";
}

export interface MembershipDelta {
  shared_event_n: number;
  c0_only_event_n: number;
  challenger_only_event_n: number;
}

function membershipDelta(c0Bets: SelectedBet[], challengerBets: SelectedBet[]): MembershipDelta {
  const c0Keys = new Set(c0Bets.map((b) => b.physicalEventKey));
  const chKeys = new Set(challengerBets.map((b) => b.physicalEventKey));
  let shared = 0;
  for (const k of c0Keys) if (chKeys.has(k)) shared += 1;
  return {
    shared_event_n: shared,
    c0_only_event_n: c0Keys.size - shared,
    challenger_only_event_n: chKeys.size - shared,
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

function loadFrozenReference(): Record<string, Record<string, FrozenReferenceModel>> {
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
  const out: Record<string, Record<string, FrozenReferenceModel>> = {};
  for (const pop of json.POPULATIONS) {
    out[pop.POPULATION_ID] = {};
    for (const m of pop.MODELS) {
      out[pop.POPULATION_ID][m.MODEL_ID] = {
        events: m.SELECTED_PHYSICAL_EVENT_N,
        wins: m.WINS,
        losses: m.LOSSES,
        pnl_u: m.PNL_U,
        roi_pct: m.ROI_PCT,
        max_drawdown_u: m.MAX_DRAWDOWN_U,
      };
    }
  }
  return out;
}

export interface ScanBusinessResult {
  RANGE: { START: string; END: string };
  PARTITION_HASHES: Record<string, string>;
  POPULATION_ROW_N: Record<string, number>;
  REF_PARITY: Record<string, Record<string, { PASS: boolean; expected: FrozenReferenceModel; actual: FrozenReferenceModel }>>;
  CHALLENGERS: Record<
    string,
    Array<{
      CHALLENGER_ID: string;
      events: number;
      wins: number;
      losses: number;
      pnl_u: number;
      roi_pct: number;
      max_drawdown_u: number;
      sample_flag: string;
      positive_week_n: number;
      negative_week_n: number;
      zero_week_n: number;
    }>
  >;
  WEEKLY_RESULTS: Record<string, Record<string, Array<{ WEEK_ID: string; event_n: number; pnl_u: number; roi_pct: number }>>>;
  MEMBERSHIP_DELTAS: Record<string, Record<string, MembershipDelta>>;
  SAMPLE_FLAGS: Record<string, Record<string, string>>;
  SCORE_LEVEL_SUPPORT: Record<string, { c0_band_input_n: number; score_level_available_n: number; score_level_missing_n: number }>;
}

/** Pure business result for one explicit range over already-loaded partitions. */
export function buildScanResult(start: string, end: string, partitions: LoadedPartition[]): ScanBusinessResult {
  const view = buildExplicitDateRangeRowView({ rangeStart: start, rangeEnd: end, partitions });
  if (view.PIT_FUTURE_LEAK_N !== 0) {
    throw new Error(`SCAN_PIT_FUTURE_LEAK_NONZERO: ${view.PIT_FUTURE_LEAK_N}`);
  }
  const populationIds = Object.keys(view.POPULATION_ROW_N).sort();
  const frozenReference = loadFrozenReference();

  const REF_PARITY: ScanBusinessResult["REF_PARITY"] = {};
  const CHALLENGERS_OUT: ScanBusinessResult["CHALLENGERS"] = {};
  const WEEKLY_RESULTS: ScanBusinessResult["WEEKLY_RESULTS"] = {};
  const MEMBERSHIP_DELTAS: ScanBusinessResult["MEMBERSHIP_DELTAS"] = {};
  const SAMPLE_FLAGS: ScanBusinessResult["SAMPLE_FLAGS"] = {};
  const SCORE_LEVEL_SUPPORT: ScanBusinessResult["SCORE_LEVEL_SUPPORT"] = {};

  // Pre-split loaded partitions by week for independent weekly economics.
  const weekPartitions = WEEKS.map((w) => ({
    ...w,
    partitions: partitions.filter((p) => p.partitionDate >= w.start && p.partitionDate <= w.end),
  }));

  for (const pop of populationIds) {
    const popRows = view.rows.filter((r: ScorecardReadyRow) => r.populationId === pop);

    // --- REFERENCE FROZEN MODELS (exact existing engine, parity-checked) ---
    const evaluated = evaluateRows(popRows) as Record<string, any>;
    REF_PARITY[pop] = {};
    const c0Bets: SelectedBet[] = evaluated.C0.selectedBets;
    for (const id of FROZEN_MODEL_IDS) {
      const actual: FrozenReferenceModel = {
        events: evaluated[id].SELECTED_PHYSICAL_EVENT_N,
        wins: evaluated[id].WINS,
        losses: evaluated[id].LOSSES,
        pnl_u: evaluated[id].PNL_U,
        roi_pct: evaluated[id].ROI_PCT,
        max_drawdown_u: evaluated[id].MAX_DRAWDOWN_U,
      };
      const expected = frozenReference[pop]?.[id];
      if (!expected) throw new Error(`FROZEN_REFERENCE_MISSING: ${pop}/${id}`);
      const pass = canonicalJson(actual) === canonicalJson(expected);
      if (!pass) {
        throw new Error(`REF_PARITY_FAIL: ${pop}/${id} expected=${canonicalJson(expected)} actual=${canonicalJson(actual)}`);
      }
      REF_PARITY[pop][id] = { PASS: pass, expected, actual };
    }

    // --- C0 price-band score-level support (mechanical, on normalized input) ---
    const challengerInput = toChallengerInput(popRows);
    const c0BandInput = challengerInput.filter((e) => inC0PriceBand(e.entryPrice));
    const scoreAvail = c0BandInput.filter((e) => typeof e.scoreLevel === "number").length;
    SCORE_LEVEL_SUPPORT[pop] = {
      c0_band_input_n: c0BandInput.length,
      score_level_available_n: scoreAvail,
      score_level_missing_n: c0BandInput.length - scoreAvail,
    };

    CHALLENGERS_OUT[pop] = [];
    WEEKLY_RESULTS[pop] = {};
    MEMBERSHIP_DELTAS[pop] = {};
    SAMPLE_FLAGS[pop] = {};

    // Full-range economics per challenger (reusing the SAME evaluated reference bets for REF_*).
    for (const id of FROZEN_MODEL_IDS) {
      const refId = `REF_${id}`;
      const bets: SelectedBet[] = evaluated[id].selectedBets;
      const metrics = {
        SELECTED_PHYSICAL_EVENT_N: evaluated[id].SELECTED_PHYSICAL_EVENT_N,
        WINS: evaluated[id].WINS,
        LOSSES: evaluated[id].LOSSES,
        PNL_U: evaluated[id].PNL_U,
        ROI_PCT: evaluated[id].ROI_PCT,
        MAX_DRAWDOWN_U: evaluated[id].MAX_DRAWDOWN_U,
        selectedBets: bets,
      };
      const weekly = computeWeeklyForKeySet(weekPartitions, pop, new Set(bets.map((b) => b.physicalEventKey)));
      WEEKLY_RESULTS[pop][refId] = weekly.rows;
      CHALLENGERS_OUT[pop].push({
        CHALLENGER_ID: refId,
        events: metrics.SELECTED_PHYSICAL_EVENT_N,
        wins: metrics.WINS,
        losses: metrics.LOSSES,
        pnl_u: metrics.PNL_U,
        roi_pct: metrics.ROI_PCT,
        max_drawdown_u: metrics.MAX_DRAWDOWN_U,
        sample_flag: sampleFlag(metrics.SELECTED_PHYSICAL_EVENT_N),
        positive_week_n: weekly.positive,
        negative_week_n: weekly.negative,
        zero_week_n: weekly.zero,
      });
      SAMPLE_FLAGS[pop][refId] = sampleFlag(metrics.SELECTED_PHYSICAL_EVENT_N);
    }

    for (const challenger of CHALLENGERS) {
      const result = runChallenger(challengerInput, challenger.predicate);
      const weekly = computeWeeklyForPredicate(weekPartitions, pop, challenger.predicate);
      WEEKLY_RESULTS[pop][challenger.CHALLENGER_ID] = weekly.rows;
      CHALLENGERS_OUT[pop].push({
        CHALLENGER_ID: challenger.CHALLENGER_ID,
        events: result.SELECTED_PHYSICAL_EVENT_N,
        wins: result.WINS,
        losses: result.LOSSES,
        pnl_u: result.PNL_U,
        roi_pct: result.ROI_PCT,
        max_drawdown_u: result.MAX_DRAWDOWN_U,
        sample_flag: sampleFlag(result.SELECTED_PHYSICAL_EVENT_N),
        positive_week_n: weekly.positive,
        negative_week_n: weekly.negative,
        zero_week_n: weekly.zero,
      });
      SAMPLE_FLAGS[pop][challenger.CHALLENGER_ID] = sampleFlag(result.SELECTED_PHYSICAL_EVENT_N);
      MEMBERSHIP_DELTAS[pop][challenger.CHALLENGER_ID] = membershipDelta(c0Bets, result.selectedBets);
    }
  }

  return {
    RANGE: { START: start, END: end },
    PARTITION_HASHES: view.PARTITION_HASHES,
    POPULATION_ROW_N: view.POPULATION_ROW_N,
    REF_PARITY,
    CHALLENGERS: CHALLENGERS_OUT,
    WEEKLY_RESULTS,
    MEMBERSHIP_DELTAS,
    SAMPLE_FLAGS,
    SCORE_LEVEL_SUPPORT,
  };
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

export function computeWeeklyForPredicate(
  weekPartitions: Array<{ WEEK_ID: string; start: string; end: string; partitions: LoadedPartition[] }>,
  populationId: string,
  predicate: (e: ChallengerEvaluatedEvent) => boolean,
): WeeklyAgg {
  const rows = weekPartitions.map((w) => {
    const weekView = buildExplicitDateRangeRowView({ rangeStart: w.start, rangeEnd: w.end, partitions: w.partitions });
    const popRows = weekView.rows.filter((r: ScorecardReadyRow) => r.populationId === populationId);
    const input = toChallengerInput(popRows);
    const result = runChallenger(input, predicate);
    return { WEEK_ID: w.WEEK_ID, event_n: result.SELECTED_PHYSICAL_EVENT_N, pnl_u: result.PNL_U, roi_pct: result.ROI_PCT };
  });
  return { rows, ...weeklyAggFromRows(rows) };
}

/** Weekly slice for a REFERENCE model: same weekly economics, restricted to the frozen engine's own selected keys. */
function computeWeeklyForKeySet(
  weekPartitions: Array<{ WEEK_ID: string; start: string; end: string; partitions: LoadedPartition[] }>,
  populationId: string,
  fullRangeKeys: Set<string>,
): WeeklyAgg {
  const rows = weekPartitions.map((w) => {
    const weekView = buildExplicitDateRangeRowView({ rangeStart: w.start, rangeEnd: w.end, partitions: w.partitions });
    const popRows = weekView.rows.filter((r: ScorecardReadyRow) => r.populationId === populationId);
    const input = toChallengerInput(popRows);
    const result = runChallenger(input, (e) => fullRangeKeys.has(e.physicalEventKey));
    return { WEEK_ID: w.WEEK_ID, event_n: result.SELECTED_PHYSICAL_EVENT_N, pnl_u: result.PNL_U, roi_pct: result.ROI_PCT };
  });
  return { rows, ...weeklyAggFromRows(rows) };
}

/** Builds the result, then again with partitions in REVERSE order; must be identical. */
export function buildScanWithDeterminismProof(
  start: string,
  end: string,
  partitions: LoadedPartition[],
): { result: ScanBusinessResult; canonicalSha256: string } {
  const result = buildScanResult(start, end, partitions);
  const reversed = buildScanResult(start, end, [...partitions].reverse());
  const a = sha256(canonicalJson(result));
  const b = sha256(canonicalJson(reversed));
  if (a !== b) throw new Error(`SCAN_NONDETERMINISTIC_UNDER_PARTITION_ORDER: ${a} != ${b}`);
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
  if (!start || !end) throw new Error("STRONG_CHALLENGER_SCAN_ARGS_REQUIRED: --start=YYYY-MM-DD --end=YYYY-MM-DD");
  const pretty = process.argv.includes("--pretty");

  const dates = enumerateMinskDates(start, end);
  if (dates.length !== 28) throw new Error(`STRONG_CHALLENGER_SCAN_RANGE_NOT_28_DAYS: ${dates.length}`);
  // loadPartition() throws on a missing file and on any hash mismatch (fail closed).
  const partitions = dates.map((d) => loadPartition(d));
  const { result, canonicalSha256 } = buildScanWithDeterminismProof(start, end, partitions);

  const artifact = {
    ARTIFACT: "STRONG_CHALLENGER_SCAN_V1",
    ...result,
    DETERMINISM_REVERSED_PARTITIONS: "PASS",
    CANONICAL_RESULT_SHA256: canonicalSha256,
  };
  const json = JSON.stringify(artifact, null, 2) + "\n";
  mkdirSync(SCAN_OUT_DIR, { recursive: true });
  const base = `SCAN_${start}_${end}`;
  const jsonPath = join(SCAN_OUT_DIR, `${base}.json`);
  writeFileSync(jsonPath, json, "utf8");
  const fileSha = sha256(json);
  writeFileSync(join(SCAN_OUT_DIR, `${base}.SHA256SUMS.txt`), `${fileSha}  ${base}.json\n`, "utf8");

  const summary = {
    ARTIFACT: jsonPath.replace(/\\/g, "/"),
    ARTIFACT_SHA256: fileSha,
    CANONICAL_RESULT_SHA256: canonicalSha256,
    AVAILABLE_PARTITION_N: dates.length,
    MISSING_PARTITION_N: 0,
    POPULATION_ROW_N: result.POPULATION_ROW_N,
    REF_PARITY: result.REF_PARITY,
    SCORE_LEVEL_SUPPORT: result.SCORE_LEVEL_SUPPORT,
  };
  console.log(pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary));
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
