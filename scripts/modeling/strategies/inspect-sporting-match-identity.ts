#!/usr/bin/env -S node --import tsx
// Local, read-only identity diagnostics runner. No network, env, database,
// model execution, or artifact writes.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inspectSportingMatchIdentity } from "../../../lib/modeling/sportingMatchIdentityDiagnostics";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");

export interface SportingMatchIdentityArgs { input: string; }

export function parseSportingMatchIdentityArgs(argv: string[]): SportingMatchIdentityArgs {
  if (argv.length === 0) return { input: DEFAULT_INPUT };
  if (argv.length === 2 && argv[0] === "--input" && argv[1].trim() !== "") return { input: argv[1] };
  throw new Error("usage: inspect-sporting-match-identity.ts [--input <export.json>]");
}

export function runSportingMatchIdentityCli(argv: string[], log: (text: string) => void = (text) => process.stdout.write(text)): number {
  try {
    const { input } = parseSportingMatchIdentityArgs(argv);
    if (!existsSync(input) || statSync(input).isDirectory()) throw new Error(`input export not found: ${input}`);
    const parsed: unknown = JSON.parse(readFileSync(input, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`input export must be a JSON array: ${input}`);
    if (!parsed.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) throw new Error(`input export must contain object rows: ${input}`);
    log(`${JSON.stringify(inspectSportingMatchIdentity(parsed as ExportRow[]), null, 2)}\n`);
    return 0;
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(runSportingMatchIdentityCli(process.argv.slice(2)));
