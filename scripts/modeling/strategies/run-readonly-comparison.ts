#!/usr/bin/env -S node --import tsx
// Read-only local strategy comparison CLI (Phase 3D.2H).
//
// Reads rows from a local JSON file (--input) and strategy declaration JSON
// files from ./declarations, runs runStrategyComparison() from
// lib/modeling/strategyComparison.ts, and prints the JSON result to stdout.
//
// This CLI does NOT:
//   - read any environment variable
//   - import Supabase or any database client
//   - import Next.js app code
//   - compute ROI/PnL
//   - write any file or database record
//
// Usage:
//   node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
//     --input ./path/to/rows.json --required-only
//
//   --input <path>       Required. Path to a local JSON file containing an
//                         array of row objects.
//   --required-only      Run only declarations with requiredForComparison
//                         === true. This is the default when no other
//                         selection flag is given.
//   --all-ready           Run every loaded declaration (still refuses any
//                         that are not READY_TO_NORMALIZE or that need a
//                         comparator this CLI does not provide).
//   --strategy <id[,id2]> Run only the named strategyId(s). Repeatable or
//                         comma-separated. Overrides --required-only/--all-ready.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runStrategyComparison } from "../../../lib/modeling/strategyComparison";
import type { StrategyDeclaration } from "../../../lib/modeling/strategyEvaluator";

const DECLARATIONS_DIR = path.resolve(__dirname, "declarations");

interface ParsedArgs {
  input: string | null;
  allReady: boolean;
  strategyIds: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { input: null, allReady: false, strategyIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--required-only") {
      // Default behavior; accepted explicitly for clarity/documentation.
    } else if (arg === "--all-ready") {
      args.allReady = true;
    } else if (arg === "--strategy") {
      const value = argv[i + 1] ?? "";
      i += 1;
      args.strategyIds.push(
        ...value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }
  return args;
}

function loadDeclarations(): StrategyDeclaration[] {
  const files = readdirSync(DECLARATIONS_DIR).filter((file) => file.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(path.join(DECLARATIONS_DIR, file), "utf8");
    return JSON.parse(raw) as StrategyDeclaration;
  });
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    fail("--input <path> is required");
  }

  let rows: unknown;
  try {
    const raw = readFileSync(args.input as string, "utf8");
    rows = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(`failed to read/parse --input file: ${message}`);
  }

  if (!Array.isArray(rows)) {
    fail("--input file must contain a JSON array of rows");
  }

  let declarations: StrategyDeclaration[];
  try {
    declarations = loadDeclarations();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(`failed to load strategy declarations: ${message}`);
    return;
  }

  const requiredOnly = args.strategyIds.length > 0 ? false : !args.allReady;

  const result = runStrategyComparison(rows as Record<string, unknown>[], declarations, {
    requiredOnly,
    strategyIds: args.strategyIds.length > 0 ? args.strategyIds : undefined,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
