// Orchestration for the Frozen Model Producer V2 Shadow. Thin CLI/IO layer
// around the pure lib/modeling/frozenModelProducerV2Shadow.ts contract. Reads
// rows from a local fixture file (--fixture) or, only when no fixture is
// given and the read-only Supabase env vars are present, from the approved
// generated_signal_pairs table via a dynamic import of
// lib/supabase/server.ts (so this module never eagerly constructs a
// Supabase client, and never throws just from being imported without env
// vars set). Writes a deterministic JSON artifact to --output and prints its
// SHA-256. This file must never import anything from
// lib/executor/nightEventReservations.ts, eventExecutionQueue*,
// executorOrderEvents*, executorQueueMark*, or any Ireland/CLOB client.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportRow } from "../generatedSignalPairsExportContract";
import { produceFrozenModelV2ShadowDecisions } from "../frozenModelProducerV2Shadow";

export interface RunFrozenModelProducerV2ShadowArgs {
  asOf?: string;
  output?: string;
  fixture?: string;
  limit?: string;
}

export function parseArgs(argv: readonly string[]): RunFrozenModelProducerV2ShadowArgs {
  const args: RunFrozenModelProducerV2ShadowArgs = {};
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

function loadFixtureRows(fixturePath: string): ExportRow[] {
  const raw = readFileSync(fixturePath, "utf8");
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  // Support both a JSON array file and JSONL (one row object per line) --
  // mirrors the forward-shadow snapshot loader convention.
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("FROZEN_RUNNER_FIXTURE_NOT_ARRAY");
    return parsed as ExportRow[];
  }
  return trimmed
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        return parsed as ExportRow;
      } catch {
        throw new Error(`FROZEN_RUNNER_MALFORMED_FIXTURE_LINE:${index + 1}`);
      }
    });
}

// Bounded-source-read requirement: production Supabase reads must always be
// bounded, even when the caller omits --limit. This default is only a safety
// bound (never used to silently truncate an explicit --limit).
const DEFAULT_SUPABASE_ROW_LIMIT = 5_000;

/**
 * Optional read-only production data seam. Only invoked when no --fixture is
 * given. Dynamically imports the existing admin Supabase client so that
 * simply importing this module (as tests do) never requires
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY to be set. Never logs or prints the
 * env var values themselves. Always bounded: an explicit --limit is honored;
 * otherwise DEFAULT_SUPABASE_ROW_LIMIT applies so an unbounded full-table
 * select can never happen in production mode.
 */
async function loadRowsFromSupabase(limit: number | undefined): Promise<ExportRow[]> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("FROZEN_RUNNER_NO_FIXTURE_AND_MISSING_SUPABASE_ENV");
  }
  const { supabaseAdmin } = await import("../../supabase/server");
  const boundedLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : DEFAULT_SUPABASE_ROW_LIMIT;
  const { data, error } = await supabaseAdmin.from("generated_signal_pairs").select("*").limit(boundedLimit);
  if (error) throw new Error(`FROZEN_RUNNER_SUPABASE_READ_FAILED:${error.message}`);
  return (data ?? []) as ExportRow[];
}

export interface RunFrozenModelProducerV2ShadowSummary {
  asOfIso: string;
  modelVersion: string;
  inputCount: number;
  eligibleCount: number;
  acceptedCount: number;
  rejectedCount: number;
  outputPath: string;
  artifactSha256: string;
}

export async function runFrozenModelProducerV2Shadow(
  argv: readonly string[],
): Promise<RunFrozenModelProducerV2ShadowSummary> {
  const { asOf, output, fixture, limit } = parseArgs(argv);
  if (asOf === undefined || asOf.trim() === "") throw new Error("FROZEN_RUNNER_AS_OF_REQUIRED");
  if (output === undefined || output.trim() === "") throw new Error("FROZEN_RUNNER_OUTPUT_REQUIRED");

  const parsedLimit = limit !== undefined && limit.trim() !== "" ? Number(limit) : undefined;
  if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
    throw new Error("FROZEN_RUNNER_INVALID_LIMIT");
  }

  let rows: ExportRow[];
  if (fixture !== undefined && fixture.trim() !== "") {
    if (!existsSync(fixture)) throw new Error("FROZEN_RUNNER_FIXTURE_NOT_FOUND");
    rows = loadFixtureRows(fixture);
  } else {
    rows = await loadRowsFromSupabase(parsedLimit);
  }
  if (parsedLimit !== undefined && fixture !== undefined) {
    rows = rows.slice(0, parsedLimit);
  }

  const result = produceFrozenModelV2ShadowDecisions(rows, asOf);

  // Deterministic serialization: stable key order, no trailing whitespace
  // ambiguity, single trailing newline.
  const artifact = {
    asOfIso: result.asOfIso,
    modelVersion: result.modelVersion,
    inputCount: result.inputCount,
    eligibleCount: result.eligibleCount,
    acceptedDecisions: result.acceptedDecisions,
    rejections: result.rejections,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const resolvedOutput = path.resolve(output);
  mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, serialized, "utf8");
  const artifactSha256 = createHash("sha256").update(serialized).digest("hex");

  return {
    asOfIso: result.asOfIso,
    modelVersion: result.modelVersion,
    inputCount: result.inputCount,
    eligibleCount: result.eligibleCount,
    acceptedCount: result.acceptedDecisions.length,
    rejectedCount: result.rejections.length,
    outputPath: resolvedOutput,
    artifactSha256,
  };
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runFrozenModelProducerV2Shadow(process.argv.slice(2))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
