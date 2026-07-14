#!/usr/bin/env -S node --import tsx
// Extended Historical Dashboard CLI (Phase A2).
//
// Reads ONLY the local A1 extended-decomposition JSON (no raw corpus input
// required), builds the dashboard via the pure lib module, and (only under
// --write-artifacts) writes exactly three deterministic artifacts atomically
// with re-read hash verification. Dry-run is the default and writes zero
// files. No env reads, no network, no Supabase, no forward data. Import
// never auto-runs.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildExtendedHistoricalDashboard,
  serializeExtendedDashboardJson,
  renderExtendedHistoricalDashboardHtml,
  buildExtendedDashboardManifest,
  DashboardValidationError,
} from "../../../lib/modeling/extendedHistoricalDashboard";
import type { ExtendedHistoricalDecomposition } from "../../../lib/modeling/extendedHistoricalDecomposition";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "extended_historical_decomposition", "extended_historical_decomposition.json");
const DEFAULT_OUTPUT_DIR = path.join("modeling", "local_exports", "extended_historical_dashboard");

const JSON_FILENAME = "extended_historical_dashboard.json";
const HTML_FILENAME = "extended_historical_dashboard.html";
const MANIFEST_FILENAME = "extended_historical_dashboard_manifest.json";

export type ExtendedDashboardCliMode = "dry-run" | "write";

export interface ExtendedDashboardArgs {
  mode: ExtendedDashboardCliMode;
  input: string;
  outputDir: string;
}

const KNOWN_FLAGS = new Set(["--input", "--output-dir", "--write-artifacts", "--dry-run"]);

export function parseExtendedDashboardArgs(argv: string[]): ExtendedDashboardArgs {
  let input = DEFAULT_INPUT;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let sawWrite = false;
  let sawDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (arg === "--write-artifacts") {
      sawWrite = true;
      continue;
    }
    if (arg === "--dry-run") {
      sawDryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for argument: ${arg}`);
    i += 1;
    if (arg === "--input") input = value;
    else if (arg === "--output-dir") outputDir = value;
  }

  if (sawWrite && sawDryRun) throw new Error("--dry-run and --write-artifacts cannot be used together");

  return { mode: sawWrite ? "write" : "dry-run", input, outputDir };
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function runRenderExtendedHistoricalDashboardCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  let args: ExtendedDashboardArgs;
  try {
    args = parseExtendedDashboardArgs(argv);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }

  try {
    ensureFile(args.input, "decomposition input");
    const raw = readFileSync(args.input, "utf8");
    let decomposition: ExtendedHistoricalDecomposition;
    try {
      decomposition = JSON.parse(raw) as ExtendedHistoricalDecomposition;
    } catch {
      throw new Error(`decomposition input is not valid JSON: ${args.input}`);
    }

    const dashboard = buildExtendedHistoricalDashboard({ decomposition });

    if (args.mode === "dry-run") {
      log(
        `${JSON.stringify(
          {
            mode: "dry-run",
            modelCount: dashboard.corpusSummary.modelCount,
            evidenceCount: dashboard.crossModelEvidence.length,
            directionCount: dashboard.nextResearchDirections.length,
            contentHash: dashboard.contentHash,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    const jsonString = serializeExtendedDashboardJson(dashboard);
    const htmlString = renderExtendedHistoricalDashboardHtml(dashboard);
    const manifest = buildExtendedDashboardManifest(dashboard, raw, jsonString, htmlString);
    const manifestString = `${JSON.stringify(manifest, null, 2)}\n`;

    const outputs: Array<[string, string]> = [
      [JSON_FILENAME, jsonString],
      [HTML_FILENAME, htmlString],
      [MANIFEST_FILENAME, manifestString],
    ];

    for (const [filename, content] of outputs) {
      atomicWrite(path.join(args.outputDir, filename), content);
    }
    for (const [filename, content] of outputs) {
      if (sha256(readFileSync(path.join(args.outputDir, filename), "utf8")) !== sha256(content)) {
        throw new Error(`artifact verification failed: ${filename} changed after write`);
      }
    }

    log(`Wrote extended historical dashboard artifacts to ${args.outputDir}\n`);
    return 0;
  } catch (error) {
    if (error instanceof DashboardValidationError) {
      log(`Error: ${error.message}\n`);
      return 1;
    }
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runRenderExtendedHistoricalDashboardCli(process.argv.slice(2)));
}
