#!/usr/bin/env -S node --import tsx
// Real runner for the sport/market performance slice (Phase 3E.8C).
//
// Reads ONLY local files: the raw export and the classifier. Applies the
// same canonical strict dedup as run-historical-funnel-comparison.ts,
// verifies the resulting corpus hash against the expected value, runs the
// slice for the three analyzed models, and writes a deterministic JSON
// result. Never reads env vars, never touches Supabase or the network.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildSportMarketPerformanceSlice,
  ANALYZED_MODEL_IDS,
} from "../../../lib/modeling/sportMarketPerformanceSlice";
import { loadExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";
import { projectGeneratedSignalPairsStrictDedup } from "../../../lib/modeling/generatedSignalPairsDedupPolicy";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";
import { validateRowLevelInput } from "./run-historical-funnel-comparison";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_OUTPUT = path.join("modeling", "local_exports", "sport_market_performance_slice.json");
const EXPECTED_CORPUS_SHA256 = "90ce9662c43185d7b1c4bc03ce66b46f8bf481faeac186d835dbd2638d739b72";

interface ParsedArgs {
  input: string;
  output: string;
  expectHash: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, expectHash: EXPECTED_CORPUS_SHA256 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i] ?? args.input;
    else if (a === "--output") args.output = argv[++i] ?? args.output;
    else if (a === "--no-hash-check") args.expectHash = null;
  }
  return args;
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

export function runSportMarketPerformanceSliceCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  const args = parseArgs(argv);
  try {
    ensureFile(args.input, "input artifact");
    const inputRaw = readFileSync(args.input, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputRaw);
    } catch {
      throw new Error(`input artifact is not valid JSON: ${args.input}`);
    }
    const rowCheck = validateRowLevelInput(parsed);
    if (!rowCheck.ok) {
      throw new Error(`input validation failed (${args.input}): ${rowCheck.reason}`);
    }

    const projection = projectGeneratedSignalPairsStrictDedup(rowCheck.rows! as ExportRow[]);
    const dedupRows = projection.dedupedRows;

    const classifier = loadExecutableFunnelClassifier();

    const rawSlice = buildSportMarketPerformanceSlice({
      rows: dedupRows,
      classifier,
      candidateIds: [...ANALYZED_MODEL_IDS],
      expectedCorpusSha256: args.expectHash ?? undefined,
    });

    // Never write raw row references into the persisted artifact.
    const persistable = {
      ...rawSlice,
      models: rawSlice.models.map(({ selectedRowsForVerificationOnly, ...m }) => m),
    };
    void (rawSlice.models[0] && rawSlice.models[0].selectedRowsForVerificationOnly);

    const dir = path.dirname(args.output);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(args.output, `${JSON.stringify(persistable, null, 2)}\n`, "utf8");

    log(`Wrote sport/market performance slice to ${args.output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Error: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runSportMarketPerformanceSliceCli(process.argv.slice(2)));
}
