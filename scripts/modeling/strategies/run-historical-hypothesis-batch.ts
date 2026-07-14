#!/usr/bin/env -S node --import tsx
// Automated Historical Hypothesis Batch Runner CLI (Phase 4C).
//
// Reads ONLY local files: a raw historical corpus export and the classifier
// registry. Builds the deterministic hypothesis-batch research-triage
// packet via the pure lib/modeling/historicalHypothesisBatch.ts (which
// itself reuses the canonical strict-dedup projection and comparison
// engine -- no ROI/dedup/grouping logic is reimplemented here). Never reads
// env vars, never touches Supabase or the network, never uses forward/
// post-cutoff data. Dry-run is the default and writes zero files;
// --write-artifacts writes exactly seven deterministic artifacts atomically,
// then re-reads and verifies every hash before reporting success.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildHistoricalHypothesisBatch,
  serializeHypothesisBatchJson,
  serializeHypothesisScorecardJson,
  renderHypothesisScorecardHtml,
  renderDecisionPacketHtml,
  buildHypothesisBatchManifest,
  type HistoricalHypothesisBatchResult,
} from "../../../lib/modeling/historicalHypothesisBatch";
import { loadExecutableFunnelClassifier, type ExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_CLASSIFIER = path.join("modeling", "model_registry", "executable_funnel_classifier.json");
const DEFAULT_OUTPUT_DIR = path.join("modeling", "local_exports", "historical_hypothesis_batch");
const DEFAULT_BASE = "ALT2_TS_SCORE_GE_65";
const DEFAULT_VARIANTS: readonly string[] = [
  "ALT2_TS_SCORE_GE_65",
  "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS",
  "ALT5_TS_SCORE_GE_65_TENNIS_ONLY",
  "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING",
];

const COMPARISON_FILENAME = "historical_hypothesis_comparison.json";
const COMPARISON_MANIFEST_FILENAME = "historical_hypothesis_comparison_manifest.json";
const SCORECARD_JSON_FILENAME = "historical_hypothesis_scorecard.json";
const SCORECARD_HTML_FILENAME = "historical_hypothesis_scorecard.html";
const DECISION_PACKET_JSON_FILENAME = "historical_hypothesis_decision_packet.json";
const DECISION_PACKET_HTML_FILENAME = "historical_hypothesis_decision_packet.html";
const BATCH_MANIFEST_FILENAME = "historical_hypothesis_batch_manifest.json";

export type HypothesisBatchCliMode = "dry-run" | "write";

export interface HypothesisBatchCliArgs {
  mode: HypothesisBatchCliMode;
  input: string;
  classifier: string;
  base: string;
  variants: string[];
  performanceSlice: string | null;
  outputDir: string;
}

const KNOWN_FLAGS = new Set([
  "--input",
  "--classifier",
  "--base",
  "--variant",
  "--performance-slice",
  "--output-dir",
  "--write-artifacts",
  "--dry-run",
]);

export function parseHistoricalHypothesisBatchArgs(argv: string[]): HypothesisBatchCliArgs {
  let input = DEFAULT_INPUT;
  let classifier = DEFAULT_CLASSIFIER;
  let base = DEFAULT_BASE;
  let variants: string[] = [];
  let performanceSlice: string | null = null;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let sawWrite = false;
  let sawDryRun = false;
  let baseExplicit = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
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
    else if (arg === "--base") {
      base = value;
      baseExplicit = true;
    } else if (arg === "--variant") {
      if (variants.includes(value)) {
        throw new Error(`duplicate --variant: ${value}`);
      }
      variants.push(value);
    } else if (arg === "--performance-slice") performanceSlice = value;
    else if (arg === "--output-dir") outputDir = value;
  }

  if (sawWrite && sawDryRun) {
    throw new Error("--dry-run and --write-artifacts cannot be used together");
  }

  if (variants.length === 0) {
    variants = baseExplicit ? [base] : [...DEFAULT_VARIANTS];
    if (baseExplicit && !variants.includes(base)) variants = [base];
  }

  if (!variants.includes(base)) {
    throw new Error(`base variant ${base} must be included in the requested variants`);
  }

  return {
    mode: sawWrite ? "write" : "dry-run",
    input,
    classifier,
    base,
    variants,
    performanceSlice,
    outputDir,
  };
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

function readJson<T>(p: string, label: string): T {
  ensureFile(p, label);
  const raw = readFileSync(p, "utf8");
  try {
    return JSON.parse(raw) as T;
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

function dryRunSummary(result: HistoricalHypothesisBatchResult): string {
  return `${JSON.stringify(
    {
      mode: "dry-run",
      rawRowCount: result.rawRowCount,
      strictDedupRowCount: result.strictDedupRowCount,
      baseVariantId: result.baseVariantId,
      variantCount: result.requestedVariantIds.length,
      candidateCount: result.candidates.length,
      comparisonHash: result.contentHash,
      decisionPacketHash: sha256(renderDecisionPacketHtml(result)),
      triageCounts: result.triageCounts,
    },
    null,
    2,
  )}\n`;
}

export function runHistoricalHypothesisBatchCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  let args: HypothesisBatchCliArgs;
  try {
    args = parseHistoricalHypothesisBatchArgs(argv);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }

  try {
    const rawRows = readJson<ExportRow[]>(args.input, "input corpus");
    if (!Array.isArray(rawRows)) {
      throw new Error(`input corpus must be a JSON array of rows: ${args.input}`);
    }
    const classifier: ExecutableFunnelClassifier = loadClassifierFromPathOrDefault(args.classifier);

    const result = buildHistoricalHypothesisBatch({
      rawRows,
      classifier,
      baseVariantId: args.base,
      requestedVariantIds: args.variants,
    });

    if (args.mode === "dry-run") {
      log(dryRunSummary(result));
      return 0;
    }

    const comparisonJson = serializeHypothesisBatchJson(result);
    const comparisonManifestJson = `${JSON.stringify(result.manifest, null, 2)}\n`;
    const scorecardJson = serializeHypothesisScorecardJson(result);
    const scorecardHtml = renderHypothesisScorecardHtml(result);
    const decisionPacketJson = comparisonJson; // decision packet JSON = the full candidates/triage payload
    const decisionPacketHtml = renderDecisionPacketHtml(result);

    const batchManifest = buildHypothesisBatchManifest(result, {
      comparisonJson,
      comparisonManifestJson,
      scorecardJson,
      scorecardHtml,
      decisionPacketJson,
      decisionPacketHtml,
    });
    const batchManifestJson = `${JSON.stringify(batchManifest, null, 2)}\n`;

    const outputs: Array<[string, string]> = [
      [COMPARISON_FILENAME, comparisonJson],
      [COMPARISON_MANIFEST_FILENAME, comparisonManifestJson],
      [SCORECARD_JSON_FILENAME, scorecardJson],
      [SCORECARD_HTML_FILENAME, scorecardHtml],
      [DECISION_PACKET_JSON_FILENAME, decisionPacketJson],
      [DECISION_PACKET_HTML_FILENAME, decisionPacketHtml],
      [BATCH_MANIFEST_FILENAME, batchManifestJson],
    ];

    for (const [filename, content] of outputs) {
      atomicWrite(path.join(args.outputDir, filename), content);
    }

    for (const [filename, content] of outputs) {
      const reread = readFileSync(path.join(args.outputDir, filename), "utf8");
      if (sha256(reread) !== sha256(content)) {
        throw new Error(`artifact verification failed: ${filename} changed after write`);
      }
    }

    log(`Wrote historical hypothesis batch artifacts to ${args.outputDir}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Error: ${message}\n`);
    return 1;
  }
}

function loadClassifierFromPathOrDefault(p: string): ExecutableFunnelClassifier {
  return p === DEFAULT_CLASSIFIER ? loadExecutableFunnelClassifier() : readJson<ExecutableFunnelClassifier>(p, "classifier");
}

if (require.main === module) {
  process.exit(runHistoricalHypothesisBatchCli(process.argv.slice(2)));
}
