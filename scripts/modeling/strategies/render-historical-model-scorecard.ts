#!/usr/bin/env -S node --import tsx
// Historical Model Run Visual Scorecard CLI (Phase 3E.6).
//
// Reads ONLY local files -- the already-computed historical comparison JSON
// (and, optionally, the run manifest and the sport/market performance slice,
// or a local strict-dedup corpus + classifier from which the canonical
// comparison engine is invoked in-process). Never reads env, never touches
// Supabase or the network, never uses forward/post-cutoff rows. Dry-run is the
// default and writes zero files; --write-artifacts writes exactly three
// deterministic artifacts atomically, then re-reads and verifies their hashes.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildHistoricalModelScorecardArtifacts,
  type ScorecardInputs,
} from "../../../lib/modeling/historicalModelScorecard";
import type { ComparisonWithHash } from "../../../lib/modeling/historicalFunnelScorecard";
import type { EvaluationRunManifest } from "../../../lib/modeling/evaluationRunManifest";
import type { SportMarketPerformanceSlice } from "../../../lib/modeling/sportMarketPerformanceSlice";
import {
  compareHistoricalFunnelVariants,
  LOCKED_EXECUTION_SET,
} from "../../../lib/modeling/historicalFunnelComparison";
import {
  projectGeneratedSignalPairsStrictDedup,
} from "../../../lib/modeling/generatedSignalPairsDedupPolicy";
import {
  loadExecutableFunnelClassifier,
  type ExecutableFunnelClassifier,
} from "../../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const DEFAULT_COMPARISON = path.join("modeling", "local_exports", "historical_funnel_comparison.json");
const DEFAULT_MANIFEST = path.join("modeling", "local_exports", "historical_funnel_comparison_manifest.json");
const DEFAULT_SLICE = path.join("modeling", "local_exports", "sport_market_performance_slice.json");
const DEFAULT_OUTPUT_DIR = path.join("modeling", "local_exports", "historical_model_scorecard");

const JSON_FILENAME = "historical_model_scorecard.json";
const HTML_FILENAME = "historical_model_scorecard.html";
const MANIFEST_FILENAME = "historical_model_scorecard_manifest.json";

export type ScorecardCliMode = "dry-run" | "write";

export interface HistoricalScorecardArgs {
  mode: ScorecardCliMode;
  comparison: string | null;
  manifest: string | null;
  performanceSlice: string | null;
  corpus: string | null;
  classifier: string | null;
  outputDir: string;
}

const KNOWN_FLAGS = new Set([
  "--comparison",
  "--manifest",
  "--performance-slice",
  "--corpus",
  "--classifier",
  "--output-dir",
  "--write-artifacts",
  "--dry-run",
]);

export function parseHistoricalScorecardArgs(argv: string[]): HistoricalScorecardArgs {
  let comparison: string | null = null;
  let manifest: string | null = null;
  let performanceSlice: string | null = null;
  let corpus: string | null = null;
  let classifier: string | null = null;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let sawWrite = false;
  let sawDryRun = false;

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
    if (arg === "--comparison") comparison = value;
    else if (arg === "--manifest") manifest = value;
    else if (arg === "--performance-slice") performanceSlice = value;
    else if (arg === "--corpus") corpus = value;
    else if (arg === "--classifier") classifier = value;
    else if (arg === "--output-dir") outputDir = value;
  }

  if (sawWrite && sawDryRun) {
    throw new Error("--dry-run and --write-artifacts cannot be used together");
  }

  return {
    mode: sawWrite ? "write" : "dry-run",
    comparison,
    manifest,
    performanceSlice,
    corpus,
    classifier,
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

function canonicalDedupCorpusHash(rows: readonly Record<string, unknown>[]): string {
  const ordered = [...rows].sort((a, b) => {
    const ak = `${String(a.condition_id ?? "")}::${String(a.token_id ?? "")}`;
    const bk = `${String(b.condition_id ?? "")}::${String(b.token_id ?? "")}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/**
 * Builds a ComparisonWithHash from a local strict-dedup corpus by invoking the
 * canonical historical comparison engine in-process. Reuses the exact strict-
 * dedup projection and comparison engine; no ROI/predicate is reimplemented,
 * no data is fetched.
 */
function comparisonFromCorpus(corpusPath: string, classifierPath: string | null): ComparisonWithHash {
  const parsed = readJson<unknown>(corpusPath, "corpus");
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`corpus must be a non-empty row-level JSON array: ${corpusPath}`);
  }
  const classifier: ExecutableFunnelClassifier = classifierPath
    ? readJson<ExecutableFunnelClassifier>(classifierPath, "classifier")
    : loadExecutableFunnelClassifier();
  const classifierSha256 = createHash("sha256")
    .update(JSON.stringify(classifier))
    .digest("hex");

  const projection = projectGeneratedSignalPairsStrictDedup(parsed as ExportRow[]);
  const dedupRows = projection.dedupedRows as Record<string, unknown>[];
  if (dedupRows.length === 0) throw new Error(`corpus dedup produced zero rows: ${corpusPath}`);

  const comparison = compareHistoricalFunnelVariants({
    rows: dedupRows,
    classifier,
    requestedVariantIds: [...LOCKED_EXECUTION_SET],
  });
  return { ...comparison, inputSha256: canonicalDedupCorpusHash(dedupRows), classifierSha256 };
}

function loadInputs(args: HistoricalScorecardArgs): ScorecardInputs {
  let comparison: ComparisonWithHash;
  if (args.comparison) {
    comparison = readJson<ComparisonWithHash>(args.comparison, "comparison");
  } else if (args.corpus) {
    comparison = comparisonFromCorpus(args.corpus, args.classifier);
  } else {
    ensureFile(DEFAULT_COMPARISON, "comparison");
    comparison = readJson<ComparisonWithHash>(DEFAULT_COMPARISON, "comparison");
  }

  const inputs: ScorecardInputs = { comparison };

  const manifestPath = args.manifest ?? (args.comparison ? null : existsSync(DEFAULT_MANIFEST) ? DEFAULT_MANIFEST : null);
  if (manifestPath) inputs.manifest = readJson<EvaluationRunManifest>(manifestPath, "manifest");

  const slicePath = args.performanceSlice ?? (args.comparison ? null : existsSync(DEFAULT_SLICE) ? DEFAULT_SLICE : null);
  if (slicePath) inputs.performanceSlice = readJson<SportMarketPerformanceSlice>(slicePath, "performance slice");

  return inputs;
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

export function runRenderHistoricalModelScorecardCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  let args: HistoricalScorecardArgs;
  try {
    args = parseHistoricalScorecardArgs(argv);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }

  try {
    const inputs = loadInputs(args);
    const bundle = buildHistoricalModelScorecardArtifacts(inputs);

    if (args.mode === "dry-run") {
      log(
        `dry-run: scorecard built (no files written). ` +
          `executedModels=${bundle.scorecard.executive.executedModelCount} ` +
          `blocked=${bundle.scorecard.executive.blockedOrSkippedModelCount} ` +
          `jsonBytes=${Buffer.byteLength(bundle.jsonString)} htmlBytes=${Buffer.byteLength(bundle.htmlString)} ` +
          `contentHash=${bundle.scorecard.contentHash}\n`,
      );
      return 0;
    }

    const jsonPath = path.join(args.outputDir, JSON_FILENAME);
    const htmlPath = path.join(args.outputDir, HTML_FILENAME);
    const manifestPath = path.join(args.outputDir, MANIFEST_FILENAME);

    atomicWrite(jsonPath, bundle.jsonString);
    atomicWrite(htmlPath, bundle.htmlString);
    atomicWrite(manifestPath, bundle.manifestString);

    // Re-read and verify every artifact before reporting success.
    if (sha256(readFileSync(jsonPath, "utf8")) !== sha256(bundle.jsonString)) {
      throw new Error("verification failed: scorecard JSON changed after write");
    }
    if (sha256(readFileSync(htmlPath, "utf8")) !== sha256(bundle.htmlString)) {
      throw new Error("verification failed: scorecard HTML changed after write");
    }
    const rereadManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scorecardContentHash: string };
    if (rereadManifest.scorecardContentHash !== bundle.scorecard.contentHash) {
      throw new Error("verification failed: manifest contentHash mismatch after write");
    }

    log(`Wrote scorecard artifacts to ${args.outputDir}\n${jsonPath}\n${htmlPath}\n${manifestPath}\n`);
    return 0;
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runRenderHistoricalModelScorecardCli(process.argv.slice(2)));
}
