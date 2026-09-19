/**
 * FROZEN_RANGE_REPLAY_V1 — deterministic explicit-date-range replay of the four
 * already-frozen research models (C0/C1/C4/C5) over IMMUTABLE accepted corpus
 * partitions.
 *
 * Local disk only: reads CORPUS/MANIFEST/SHA256SUMS via the existing
 * loadPartition() (which verifies the canonical content hash). No database, no
 * Railway, no Gamma, no rematerialization. Every requested date must exist —
 * a missing partition fails closed. Populations are evaluated SEPARATELY and
 * never pooled.
 *
 *   npx tsx scripts/modeling/frozen-range-replay.ts \
 *     --start=2026-08-04 --end=2026-08-31 --pretty
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildExplicitDateRangeRowView,
  enumerateMinskDates,
  type LoadedPartition,
  type ScorecardReadyRow,
} from "@/lib/modeling/research-corpus/rollingCorpus";
import { evaluateRows } from "@/lib/research-clone/modelReady";
import { FROZEN_MODEL_IDS, MODEL_RESEARCH_ENGINE_VERSION } from "@/lib/modeling/research-engine";
import { loadPartition } from "./rolling-research-corpus";

export const REPLAY_OUT_DIR = "modeling/evidence/frozen-range-replay-v1";

export interface ReplayModelResult {
  MODEL_ID: string;
  SELECTED_PHYSICAL_EVENT_N: number;
  WINS: number;
  LOSSES: number;
  PNL_U: number;
  ROI_PCT: number;
  MAX_DRAWDOWN_U: number;
}

export interface ReplaySportRow {
  sport_family: string;
  selected_event_n: number;
  pnl_u: number;
  roi_pct: number;
}

export interface ReplayPopulation {
  POPULATION_ID: string;
  ROW_N: number;
  MODELS: ReplayModelResult[];
  /** Descriptive only; never alters C4 membership. */
  C4_SPORT_FAMILY_BREAKDOWN: ReplaySportRow[];
  /** Exact membership deltas from the frozen engine's own selected bets (single-factor transitions). */
  PAIRWISE_DELTAS: { C0_TO_C5: PairwiseDelta; C1_TO_C4: PairwiseDelta };
}

export interface ReplayBusinessResult {
  RANGE_START: string;
  RANGE_END: string;
  PARTITION_N: number;
  PARTITION_HASHES: Record<string, string>;
  PRE_COLLAPSE_ROW_N: number;
  ROW_N: number;
  PIT_FUTURE_LEAK_N: number;
  POPULATION_ROW_N: Record<string, number>;
  MODEL_RESEARCH_ENGINE_VERSION: string;
  POPULATIONS: ReplayPopulation[];
}

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Minimal shape of a frozen-engine model result consumed by the pairwise delta. */
export interface PairwiseModelInput {
  MODEL_ID: string;
  PNL_U: number;
  selectedBets: Array<{
    physicalEventKey: string;
    ref?: string;
    decisionTimestamp: string;
    entryPrice: number;
    sportFamily: string;
    pnlU: number;
  }>;
}

export interface PairwiseDelta {
  LEFT_MODEL: string;
  RIGHT_MODEL: string;
  LEFT_EVENT_N: number;
  RIGHT_EVENT_N: number;
  UNION_EVENT_N: number;
  SHARED_EVENT_N: number;
  LEFT_ONLY_EVENT_N: number;
  RIGHT_ONLY_EVENT_N: number;
  SHARED_SAME_SELECTION_N: number;
  SHARED_CHANGED_SELECTION_N: number;
  LEFT_PNL_U: number;
  RIGHT_PNL_U: number;
  DELTA_PNL_U: number;
  LEFT_ONLY_PNL_U: number;
  RIGHT_ONLY_PNL_U: number;
  SHARED_CHANGED_LEFT_PNL_U: number;
  SHARED_CHANGED_RIGHT_PNL_U: number;
  SHARED_CHANGED_DELTA_PNL_U: number;
}

/** Deterministic economic selection carrier already present on a selected bet (outcome excluded). */
function selectionCarrier(b: PairwiseModelInput["selectedBets"][number]): string {
  return JSON.stringify([b.ref ?? "", b.decisionTimestamp, b.entryPrice, b.sportFamily]);
}

/**
 * Exact membership accounting between two frozen models, computed ONLY from the
 * frozen engine's own selected bets (physical identity = physicalEventKey).
 * Throws if any count invariant is violated.
 */
export function computePairwiseDelta(left: PairwiseModelInput, right: PairwiseModelInput): PairwiseDelta {
  const L = new Map(left.selectedBets.map((b) => [b.physicalEventKey, b]));
  const R = new Map(right.selectedBets.map((b) => [b.physicalEventKey, b]));
  let leftOnlyPnl = 0;
  let rightOnlyPnl = 0;
  let changedLeftPnl = 0;
  let changedRightPnl = 0;
  let leftOnly = 0;
  let rightOnly = 0;
  let same = 0;
  let changed = 0;
  for (const [key, lb] of L) {
    const rb = R.get(key);
    if (!rb) {
      leftOnly++;
      leftOnlyPnl += lb.pnlU;
    } else if (selectionCarrier(lb) === selectionCarrier(rb)) {
      same++;
    } else {
      changed++;
      changedLeftPnl += lb.pnlU;
      changedRightPnl += rb.pnlU;
    }
  }
  for (const [key, rb] of R) {
    if (!L.has(key)) {
      rightOnly++;
      rightOnlyPnl += rb.pnlU;
    }
  }
  const shared = same + changed;
  const out: PairwiseDelta = {
    LEFT_MODEL: left.MODEL_ID,
    RIGHT_MODEL: right.MODEL_ID,
    LEFT_EVENT_N: L.size,
    RIGHT_EVENT_N: R.size,
    UNION_EVENT_N: shared + leftOnly + rightOnly,
    SHARED_EVENT_N: shared,
    LEFT_ONLY_EVENT_N: leftOnly,
    RIGHT_ONLY_EVENT_N: rightOnly,
    SHARED_SAME_SELECTION_N: same,
    SHARED_CHANGED_SELECTION_N: changed,
    LEFT_PNL_U: left.PNL_U,
    RIGHT_PNL_U: right.PNL_U,
    DELTA_PNL_U: round(right.PNL_U - left.PNL_U, 2),
    LEFT_ONLY_PNL_U: round(leftOnlyPnl, 2),
    RIGHT_ONLY_PNL_U: round(rightOnlyPnl, 2),
    SHARED_CHANGED_LEFT_PNL_U: round(changedLeftPnl, 2),
    SHARED_CHANGED_RIGHT_PNL_U: round(changedRightPnl, 2),
    SHARED_CHANGED_DELTA_PNL_U: round(changedRightPnl - changedLeftPnl, 2),
  };
  if (
    out.LEFT_EVENT_N !== out.SHARED_EVENT_N + out.LEFT_ONLY_EVENT_N ||
    out.RIGHT_EVENT_N !== out.SHARED_EVENT_N + out.RIGHT_ONLY_EVENT_N ||
    out.UNION_EVENT_N !== out.SHARED_EVENT_N + out.LEFT_ONLY_EVENT_N + out.RIGHT_ONLY_EVENT_N ||
    out.SHARED_EVENT_N !== out.SHARED_SAME_SELECTION_N + out.SHARED_CHANGED_SELECTION_N
  ) {
    throw new Error(`PAIRWISE_INVARIANT_VIOLATED ${left.MODEL_ID}->${right.MODEL_ID}`);
  }
  return out;
}

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

/** Pure business result for one explicit range over already-loaded partitions. */
export function buildReplayResult(
  start: string,
  end: string,
  partitions: LoadedPartition[],
): ReplayBusinessResult {
  const view = buildExplicitDateRangeRowView({ rangeStart: start, rangeEnd: end, partitions });
  if (view.PIT_FUTURE_LEAK_N !== 0) {
    throw new Error(`REPLAY_PIT_FUTURE_LEAK_NONZERO: ${view.PIT_FUTURE_LEAK_N}`);
  }
  const populationIds = Object.keys(view.POPULATION_ROW_N).sort();
  const POPULATIONS: ReplayPopulation[] = populationIds.map((pop) => {
    const popRows = view.rows.filter((r: ScorecardReadyRow) => r.populationId === pop);
    const evaluated = evaluateRows(popRows) as Record<string, any>;
    const MODELS: ReplayModelResult[] = [...FROZEN_MODEL_IDS].map((id) => {
      const m = evaluated[id];
      return {
        MODEL_ID: id,
        SELECTED_PHYSICAL_EVENT_N: m.SELECTED_PHYSICAL_EVENT_N,
        WINS: m.WINS,
        LOSSES: m.LOSSES,
        PNL_U: m.PNL_U,
        ROI_PCT: m.ROI_PCT,
        MAX_DRAWDOWN_U: m.MAX_DRAWDOWN_U,
      };
    });
    const bySport = new Map<string, { n: number; pnl: number }>();
    for (const b of evaluated.C4.selectedBets as Array<{ sportFamily: string; pnlU: number }>) {
      const cur = bySport.get(b.sportFamily) ?? { n: 0, pnl: 0 };
      cur.n += 1;
      cur.pnl += b.pnlU;
      bySport.set(b.sportFamily, cur);
    }
    const C4_SPORT_FAMILY_BREAKDOWN: ReplaySportRow[] = [...bySport.entries()]
      .map(([sport_family, v]) => ({
        sport_family,
        selected_event_n: v.n,
        pnl_u: round(v.pnl, 2),
        roi_pct: round((v.pnl / v.n) * 100, 4),
      }))
      .sort((a, b) => b.selected_event_n - a.selected_event_n || a.sport_family.localeCompare(b.sport_family));
    const PAIRWISE_DELTAS = {
      C0_TO_C5: computePairwiseDelta(evaluated.C0, evaluated.C5),
      C1_TO_C4: computePairwiseDelta(evaluated.C1, evaluated.C4),
    };
    return { POPULATION_ID: pop, ROW_N: popRows.length, MODELS, C4_SPORT_FAMILY_BREAKDOWN, PAIRWISE_DELTAS };
  });
  return {
    RANGE_START: start,
    RANGE_END: end,
    PARTITION_N: view.AVAILABLE_PARTITION_N,
    PARTITION_HASHES: view.PARTITION_HASHES,
    PRE_COLLAPSE_ROW_N: view.PRE_COLLAPSE_ROW_N,
    ROW_N: view.ROW_N,
    PIT_FUTURE_LEAK_N: view.PIT_FUTURE_LEAK_N,
    POPULATION_ROW_N: view.POPULATION_ROW_N,
    MODEL_RESEARCH_ENGINE_VERSION,
    POPULATIONS,
  };
}

/** Builds the result, then again with partitions in REVERSE order; must be identical. */
export function buildReplayWithDeterminismProof(
  start: string,
  end: string,
  partitions: LoadedPartition[],
): { result: ReplayBusinessResult; canonicalSha256: string } {
  const result = buildReplayResult(start, end, partitions);
  const reversed = buildReplayResult(start, end, [...partitions].reverse());
  const a = sha256(canonicalJson(result));
  const b = sha256(canonicalJson(reversed));
  if (a !== b) throw new Error(`REPLAY_NONDETERMINISTIC_UNDER_PARTITION_ORDER: ${a} != ${b}`);
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
  if (!start || !end) throw new Error("FROZEN_RANGE_REPLAY_ARGS_REQUIRED: --start=YYYY-MM-DD --end=YYYY-MM-DD");
  const pretty = process.argv.includes("--pretty");

  const dates = enumerateMinskDates(start, end);
  // loadPartition() throws on a missing file and on any hash mismatch (fail closed).
  const partitions = dates.map((d) => loadPartition(d));
  const { result, canonicalSha256 } = buildReplayWithDeterminismProof(start, end, partitions);

  const artifact = {
    ARTIFACT: "FROZEN_RANGE_REPLAY_V1",
    ...result,
    DETERMINISM_REVERSED_PARTITIONS: "PASS",
    CANONICAL_RESULT_SHA256: canonicalSha256,
  };
  const json = JSON.stringify(artifact, null, 2) + "\n";
  mkdirSync(REPLAY_OUT_DIR, { recursive: true });
  const base = `REPLAY_${start}_${end}`;
  const jsonPath = join(REPLAY_OUT_DIR, `${base}.json`);
  writeFileSync(jsonPath, json, "utf8");
  const fileSha = sha256(json);
  writeFileSync(join(REPLAY_OUT_DIR, `${base}.SHA256SUMS.txt`), `${fileSha}  ${base}.json\n`, "utf8");

  const summary = {
    ARTIFACT: jsonPath.replace(/\\/g, "/"),
    ARTIFACT_SHA256: fileSha,
    CANONICAL_RESULT_SHA256: canonicalSha256,
    REQUESTED_PARTITION_N: dates.length,
    AVAILABLE_PARTITION_N: result.PARTITION_N,
    MISSING_PARTITION_N: 0,
    PIT_FUTURE_LEAK_N: result.PIT_FUTURE_LEAK_N,
    POPULATION_ROW_N: result.POPULATION_ROW_N,
    POPULATIONS: result.POPULATIONS,
  };
  console.log(pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
