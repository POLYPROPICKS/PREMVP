#!/usr/bin/env -S node --import tsx
// Sport/market performance report CLI (Phase 3E.8C).
//
// Reads the already-computed sport/market performance slice JSON and writes
// a deterministic founder-readable HTML report. Reads only local files; no
// env, no network, no DB.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { renderSportMarketPerformanceReport } from "../../../lib/modeling/sportMarketPerformanceReport";
import type { SportMarketPerformanceSlice } from "../../../lib/modeling/sportMarketPerformanceSlice";

const DEFAULT_SLICE = path.join("modeling", "local_exports", "sport_market_performance_slice.json");
const DEFAULT_OUTPUT = path.join("modeling", "local_exports", "sport_market_performance_report.html");

interface ParsedArgs {
  slice: string;
  output: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { slice: DEFAULT_SLICE, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slice" || a === "--input") args.slice = argv[++i] ?? args.slice;
    else if (a === "--output") args.output = argv[++i] ?? args.output;
  }
  return args;
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

export function runRenderSportMarketReportCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  const args = parseArgs(argv);
  try {
    ensureFile(args.slice, "sport/market performance slice");
    const slice = JSON.parse(readFileSync(args.slice, "utf8")) as SportMarketPerformanceSlice;
    const html = renderSportMarketPerformanceReport({ slice });
    const dir = path.dirname(args.output);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(args.output, html, "utf8");
    log(`Wrote sport/market performance report to ${args.output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Error: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runRenderSportMarketReportCli(process.argv.slice(2)));
}
