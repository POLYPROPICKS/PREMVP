// Orchestration for the Frozen Execution Contract Bridge (Integration
// Milestone 2B). Thin CLI/IO layer around the pure
// lib/modeling/frozenExecutionContractBridge.ts comparator. This module must
// never import anything from lib/executor/nightEventReservations.ts,
// eventExecutionQueue*, executorOrderEvents*, executorQueueMark*, or any
// Ireland/CLOB client. Importing lib/executor/buildFireModelCandidates.ts
// (the Contur3 READ path) is fine and expected in live mode.
//
// ARCHITECTURE DECISION -- fixture mode vs live mode (deliberate, disclosed):
//
// buildFireModelCandidates() ALWAYS does
// `const { supabaseAdmin } = await import("@/lib/supabase/server")`
// internally and queries generated_signal_pairs live -- there is no
// fixture-injection parameter on it, and adding one would mean modifying a
// frozen/accepted Contur3 contract file, which this milestone's brief
// forbids. So:
//
//   * LIVE mode (no --fixture, Supabase env vars present): this runner
//     dynamically imports and actually CALLS the real
//     buildFireModelCandidates(limit, "all", true) -- planningMode=true,
//     confirmed by reading lib/executor/buildFireModelCandidates.ts: planning
//     mode is the read-only, no-live-order-placement universe (it widens the
//     source-version set to include the full planning universe and is used
//     by the night-plan diagnostics route, never by the live order-submission
//     path) -- for the Contur3 side, and the frozen producer's own row-load
//     for the frozen side. Both reads are bounded (DEFAULT_SUPABASE_ROW_LIMIT
//     fallback, same pattern as the frozen-model runner) and read-only.
//
//   * FIXTURE mode (--fixture <path>): since buildFireModelCandidates cannot
//     be fixture-driven without modifying Contur3, the fixture file supplies
//     BOTH the frozen-model raw rows (generated_signal_pairs export rows,
//     fed through produceFrozenModelV2ShadowDecisions exactly as the frozen
//     runner does) AND a pre-computed Contur3CandidateSlice[] array
//     representing what buildFireModelCandidates would have produced for
//     that same snapshot. This keeps deterministic fixture-based testing
//     possible for a function that fundamentally cannot be fixture-injected
//     without touching a frozen contract file. The fixture's Contur3 array
//     is validated/typed against the REAL FireModelCandidate contract (see
//     tests/modeling/frozenExecutionContractBridge.test.ts's "real contract
//     regression" test), so the comparator is contract-accurate even though
//     fixture mode does not literally invoke the live function.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportRow } from "../generatedSignalPairsExportContract";
import { produceFrozenModelV2ShadowDecisions, FROZEN_MODEL_V2_VERSION } from "../frozenModelProducerV2Shadow";
import { compareFrozenAndContur3, type Contur3CandidateSlice } from "../frozenExecutionContractBridge";

export interface RunFrozenExecutionContractBridgeArgs {
  asOf?: string;
  output?: string;
  fixture?: string;
  limit?: string;
}

export function parseArgs(argv: readonly string[]): RunFrozenExecutionContractBridgeArgs {
  const args: RunFrozenExecutionContractBridgeArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--as-of") args.asOf = value;
    else if (flag === "--output") args.output = value;
    else if (flag === "--fixture") args.fixture = value;
    else if (flag === "--limit") args.limit = value;
    else continue;
    i += 1;
  }
  return args;
}

interface BridgeFixture {
  frozenSourceRows: ExportRow[];
  contur3Candidates: Contur3CandidateSlice[];
}

function loadFixture(fixturePath: string): BridgeFixture {
  const raw = readFileSync(fixturePath, "utf8");
  const trimmed = raw.trim();
  if (trimmed === "") return { frozenSourceRows: [], contur3Candidates: [] };
  const parsed = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("BRIDGE_RUNNER_FIXTURE_MUST_BE_OBJECT");
  }
  const obj = parsed as Record<string, unknown>;
  const frozenSourceRows = Array.isArray(obj.frozenSourceRows) ? (obj.frozenSourceRows as ExportRow[]) : [];
  const contur3Candidates = Array.isArray(obj.contur3Candidates)
    ? (obj.contur3Candidates as Contur3CandidateSlice[])
    : [];
  return { frozenSourceRows, contur3Candidates };
}

// Bounded-source-read requirement: production Supabase reads must always be
// bounded, even when the caller omits --limit. Mirrors
// lib/modeling/strategies/runFrozenModelProducerV2Shadow.ts's
// DEFAULT_SUPABASE_ROW_LIMIT pattern exactly.
const DEFAULT_SUPABASE_ROW_LIMIT = 5_000;

/**
 * Live-mode data seam. Only invoked when no --fixture is given. Dynamically
 * imports the real generated_signal_pairs row loader (via the frozen
 * model's own live-Supabase read path, so no thresholds/queries are
 * duplicated here) for the frozen side, and dynamically imports and calls
 * the real buildFireModelCandidates(limit, "all", true) -- planningMode=true
 * -- for the Contur3 side. Never invoked eagerly at import time, so this
 * module never requires Supabase env vars to be set just to be imported (as
 * tests do).
 */
async function loadLiveInputs(
  limit: number | undefined,
): Promise<{ frozenSourceRows: ExportRow[]; contur3Candidates: Contur3CandidateSlice[] }> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("BRIDGE_RUNNER_NO_FIXTURE_AND_MISSING_SUPABASE_ENV");
  }
  const boundedLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : DEFAULT_SUPABASE_ROW_LIMIT;

  const { supabaseAdmin } = await import("../../supabase/server");
  const { data, error } = await supabaseAdmin.from("generated_signal_pairs").select("*").limit(boundedLimit);
  if (error) throw new Error(`BRIDGE_RUNNER_SUPABASE_READ_FAILED:${error.message}`);
  const frozenSourceRows = (data ?? []) as ExportRow[];

  const { buildFireModelCandidates } = await import("../../executor/buildFireModelCandidates");
  const { candidates } = await buildFireModelCandidates(boundedLimit, "all", true);
  const contur3Candidates = candidates as unknown as Contur3CandidateSlice[];

  return { frozenSourceRows, contur3Candidates };
}

export interface RunFrozenExecutionContractBridgeSummary {
  asOfIso: string;
  modelVersion: string;
  sourceRowCount: number;
  frozenDecisionCount: number;
  contur3CandidateCount: number;
  exactCompatibleCount: number;
  classificationCounts: Record<string, number>;
  outputPath: string;
  artifactSha256: string;
}

export async function runFrozenExecutionContractBridge(
  argv: readonly string[],
): Promise<RunFrozenExecutionContractBridgeSummary> {
  const { asOf, output, fixture, limit } = parseArgs(argv);
  if (asOf === undefined || asOf.trim() === "") throw new Error("BRIDGE_RUNNER_AS_OF_REQUIRED");
  if (output === undefined || output.trim() === "") throw new Error("BRIDGE_RUNNER_OUTPUT_REQUIRED");

  const parsedLimit = limit !== undefined && limit.trim() !== "" ? Number(limit) : undefined;
  if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
    throw new Error("BRIDGE_RUNNER_INVALID_LIMIT");
  }

  let frozenSourceRows: ExportRow[];
  let contur3Candidates: Contur3CandidateSlice[];
  if (fixture !== undefined && fixture.trim() !== "") {
    if (!existsSync(fixture)) throw new Error("BRIDGE_RUNNER_FIXTURE_NOT_FOUND");
    const loaded = loadFixture(fixture);
    frozenSourceRows = loaded.frozenSourceRows;
    contur3Candidates = loaded.contur3Candidates;
    if (parsedLimit !== undefined) {
      frozenSourceRows = frozenSourceRows.slice(0, parsedLimit);
      contur3Candidates = contur3Candidates.slice(0, parsedLimit);
    }
  } else {
    const loaded = await loadLiveInputs(parsedLimit);
    frozenSourceRows = loaded.frozenSourceRows;
    contur3Candidates = loaded.contur3Candidates;
  }

  const frozenResult = produceFrozenModelV2ShadowDecisions(frozenSourceRows, asOf);
  const comparison = compareFrozenAndContur3(frozenResult.acceptedDecisions, frozenSourceRows, contur3Candidates);

  // Deterministic serialization: stable key order, single trailing newline.
  const artifact = {
    metadata: {
      generatedBy: "runFrozenExecutionContractBridge",
      schemaVersion: "FROZEN_EXECUTION_CONTRACT_BRIDGE_V1",
    },
    asOfIso: frozenResult.asOfIso,
    frozenModelVersion: FROZEN_MODEL_V2_VERSION,
    sourceRowCount: frozenSourceRows.length,
    frozenDecisionCount: frozenResult.acceptedDecisions.length,
    contur3CandidateCount: contur3Candidates.length,
    eventCount: comparison.eventCount,
    exactCompatibleCount: comparison.classificationCounts.EXACT_EXECUTION_COMPATIBLE,
    classificationCounts: comparison.classificationCounts,
    comparisonRows: comparison.rows,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const resolvedOutput = path.resolve(output);
  mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, serialized, "utf8");
  const artifactSha256 = createHash("sha256").update(serialized).digest("hex");

  return {
    asOfIso: frozenResult.asOfIso,
    modelVersion: FROZEN_MODEL_V2_VERSION,
    sourceRowCount: frozenSourceRows.length,
    frozenDecisionCount: frozenResult.acceptedDecisions.length,
    contur3CandidateCount: contur3Candidates.length,
    exactCompatibleCount: comparison.classificationCounts.EXACT_EXECUTION_COMPATIBLE,
    classificationCounts: comparison.classificationCounts,
    outputPath: resolvedOutput,
    artifactSha256,
  };
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runFrozenExecutionContractBridge(process.argv.slice(2))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
