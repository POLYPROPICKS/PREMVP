#!/usr/bin/env -S node --import tsx
// Local operator materializer for generated_signal_pairs exports (Phase 3D.2Oa).
//
// Takes raw text pasted/exported from Supabase (either a plain JSON array of
// rows, or a Supabase SQL-editor "wrapper" result where the JSON array is
// nested inside a `generated_signal_pairs_export` cell/column) and writes a
// normalized, pretty-printed JSON array file to a local path.
//
// This module does NOT:
//   - query Supabase or import any database client
//   - read any environment variable
//   - compute ROI/PnL/profit
//   - log or print raw row payloads
//   - mutate the rows it parses
//
// It only reads local text (file or stdin) and writes a local JSON file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const WRAPPER_KEY = "generated_signal_pairs_export";

const DEFAULT_OUTPUT_PATH = path.join(
  "modeling",
  "local_exports",
  "generated_signal_pairs_export.json",
);

export type MaterializedFormat = "raw_array" | "supabase_wrapper";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWrapperValue(wrapperValue: unknown): unknown[] {
  let value = wrapperValue;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(`${WRAPPER_KEY} field is not valid JSON`);
    }
  }
  if (!Array.isArray(value)) {
    throw new Error(`${WRAPPER_KEY} field did not resolve to a JSON array`);
  }
  return value;
}

/**
 * Parses raw text (a plain JSON array of rows, or a Supabase wrapper object
 * / single-element wrapper array carrying a `generated_signal_pairs_export`
 * field) and returns a normalized array of row objects. Throws a safe
 * Error (no row payload in the message) on any invalid input.
 */
export function materializeGeneratedSignalPairsExportFromText(inputText: string): unknown[] {
  const trimmed = inputText.trim();
  if (trimmed === "") {
    throw new Error("input text is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("input text is not valid JSON");
  }

  // Plain JSON array of row objects.
  if (Array.isArray(parsed)) {
    if (
      parsed.length === 1 &&
      isPlainObject(parsed[0]) &&
      WRAPPER_KEY in (parsed[0] as Record<string, unknown>)
    ) {
      return resolveWrapperValue((parsed[0] as Record<string, unknown>)[WRAPPER_KEY]);
    }
    return parsed;
  }

  // Supabase wrapper object: { generated_signal_pairs_export: "[...]" | [...] }.
  if (isPlainObject(parsed)) {
    if (!(WRAPPER_KEY in parsed)) {
      throw new Error(`parsed JSON object is missing the ${WRAPPER_KEY} field and is not a row array`);
    }
    return resolveWrapperValue(parsed[WRAPPER_KEY]);
  }

  throw new Error("parsed JSON did not resolve to a row array or a recognized Supabase wrapper");
}

/**
 * Writes `rows` as a pretty-printed JSON array to `outputPath`, creating
 * the containing directory if it does not exist. Does not mutate `rows`.
 */
export function writeGeneratedSignalPairsExportFile(rows: unknown[], outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outputPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

function detectFormat(inputText: string): MaterializedFormat {
  const trimmed = inputText.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed) && WRAPPER_KEY in parsed) return "supabase_wrapper";
    if (
      Array.isArray(parsed) &&
      parsed.length === 1 &&
      isPlainObject(parsed[0]) &&
      WRAPPER_KEY in (parsed[0] as Record<string, unknown>)
    ) {
      return "supabase_wrapper";
    }
  } catch {
    // fall through to default below; materializeGeneratedSignalPairsExportFromText will throw with detail
  }
  return "raw_array";
}

interface ParsedArgs {
  input: string | null;
  useStdin: boolean;
  output: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { input: null, useStdin: false, output: DEFAULT_OUTPUT_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--stdin") {
      args.useStdin = true;
    } else if (arg === "--output") {
      args.output = argv[i + 1] ?? DEFAULT_OUTPUT_PATH;
      i += 1;
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    throw new Error("failed to read stdin");
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input && !args.useStdin) {
    fail("either --input <path> or --stdin is required");
  }

  let inputText: string;
  if (args.input) {
    try {
      inputText = readFileSync(args.input, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      fail(`failed to read --input file: ${message}`);
      return;
    }
  } else {
    try {
      inputText = readStdinSync();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      fail(message);
      return;
    }
  }

  let rows: unknown[];
  try {
    rows = materializeGeneratedSignalPairsExportFromText(inputText);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(`failed to materialize export: ${message}`);
    return;
  }

  const format = detectFormat(inputText);

  try {
    writeGeneratedSignalPairsExportFile(rows, args.output);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(`failed to write output file: ${message}`);
    return;
  }

  process.stdout.write(
    `${JSON.stringify({ outputPath: args.output, rows: rows.length, format }, null, 2)}\n`,
  );
}

if (require.main === module) {
  main();
}
