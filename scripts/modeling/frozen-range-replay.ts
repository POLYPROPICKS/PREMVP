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
    return { POPULATION_ID: pop, ROW_N: popRows.length, MODELS, C4_SPORT_FAMILY_BREAKDOWN };
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
