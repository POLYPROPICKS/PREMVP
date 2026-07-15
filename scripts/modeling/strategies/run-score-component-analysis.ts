#!/usr/bin/env -S node --import tsx
// Score-Component / Fine-Timing / Interaction Analysis CLI (Phase 4B.1 / B1).
//
// Reads ONLY local files (raw historical corpus export + classifier
// registry), builds the deterministic score-component analysis via the pure
// lib module, and (only under --write-artifacts) writes exactly three
// artifacts atomically with re-read hash verification. Dry-run is the default
// and writes zero files. No env reads, no network, no Supabase, no forward
// data. Import never auto-runs (guarded by require.main === module).

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildScoreComponentAnalysis,
  serializeScoreComponentAnalysisJson,
  renderScoreComponentAnalysisHtml,
  buildScoreComponentAnalysisManifest,
} from "../../../lib/modeling/scoreComponentAnalysis";
import { SCORECARD_MODEL_ORDER } from "../../../lib/modeling/historicalModelScorecard";
import {
  loadExecutableFunnelClassifier,
  type ExecutableFunnelClassifier,
} from "../../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_CLASSIFIER = path.join("modeling", "model_registry", "executable_funnel_classifier.json");
const DEFAULT_OUTPUT_DIR = path.join("modeling", "local_exports", "score_component_analysis");

/** Default analysis set: the exported canonical scorecard model order. */
export const DEFAULT_SCORE_COMPONENT_VARIANTS: readonly string[] = [...SCORECARD_MODEL_ORDER];
const KNOWN_VARIANTS = new Set<string>(SCORECARD_MODEL_ORDER);

const JSON_FILENAME = "score_component_analysis.json";
const HTML_FILENAME = "score_component_analysis.html";
const MANIFEST_FILENAME = "score_component_analysis_manifest.json";

export type ScoreComponentCliMode = "dry-run" | "write";

export interface ScoreComponentAnalysisArgs {
  mode: ScoreComponentCliMode;
  input: string;
  classifier: string;
  variants: string[];
  outputDir: string;
}

const KNOWN_FLAGS = new Set(["--input", "--classifier", "--variant", "--output-dir", "--write-artifacts", "--dry-run"]);

export function parseScoreComponentAnalysisArgs(argv: string[]): ScoreComponentAnalysisArgs {
  let input = DEFAULT_INPUT;
  let classifier = DEFAULT_CLASSIFIER;
  let variants: string[] = [];
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
    else if (arg === "--classifier") classifier = value;
    else if (arg === "--variant") {
      if (variants.includes(value)) throw new Error(`duplicate --variant: ${value}`);
      if (!KNOWN_VARIANTS.has(value)) throw new Error(`unknown --variant: ${value}`);
      variants.push(value);
    } else if (arg === "--output-dir") outputDir = value;
  }

  if (sawWrite && sawDryRun) throw new Error("--dry-run and --write-artifacts cannot be used together");
  if (variants.length === 0) variants = [...DEFAULT_SCORE_COMPONENT_VARIANTS];

  return { mode: sawWrite ? "write" : "dry-run", input, classifier, variants, outputDir };
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

function readJson<T>(p: string, label: string): T {
  ensureFile(p, label);
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    throw new Error(`${label} is not valid JSON: ${p}`);
  }
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

export function runScoreComponentAnalysisCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  let args: ScoreComponentAnalysisArgs;
  try {
    args = parseScoreComponentAnalysisArgs(argv);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }

  try {
    const rawRows = readJson<ExportRow[]>(args.input, "input corpus");
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw new Error(`input corpus must be a non-empty JSON array of rows: ${args.input}`);
    }
    const classifier: ExecutableFunnelClassifier =
      args.classifier === DEFAULT_CLASSIFIER
        ? loadExecutableFunnelClassifier()
        : readJson<ExecutableFunnelClassifier>(args.classifier, "classifier");

    const result = buildScoreComponentAnalysis({
      rawRows,
      classifier,
      requestedVariantIds: args.variants,
    });

    if (args.mode === "dry-run") {
      log(
        `${JSON.stringify(
          {
            mode: "dry-run",
            rawRowCount: result.corpusSummary.rawRowCount,
            strictDedupRowCount: result.corpusSummary.strictDedupRowCount,
            cohortCount: result.uniqueCohorts.length,
            b2DirectionCount: result.b2EvidenceDirections.length,
            formulaFeasibility: result.formulaFeasibility,
            contentHash: result.contentHash,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    const jsonString = serializeScoreComponentAnalysisJson(result);
    const htmlString = renderScoreComponentAnalysisHtml(result);
    const manifest = buildScoreComponentAnalysisManifest(result, jsonString, htmlString);
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

    log(`Wrote score component analysis artifacts to ${args.outputDir}\n`);
    return 0;
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runScoreComponentAnalysisCli(process.argv.slice(2)));
}
