#!/usr/bin/env -S node --import tsx
// Phase 3E.8E.2E -- read-only post-cutoff CLI and deterministic artifacts.
//
// A thin filesystem runner: reads a local generated_signal_pairs export JSON
// array, builds the canonical post-cutoff evaluation dataset (Phase
// 3E.8E.2C-B), evaluates exactly the three frozen PRIMARY/ALT2/ALT1 models
// (Phase 3E.8E.2D), and -- only under --write-artifacts -- writes three
// deterministic JSON artifacts plus a manifest, re-reading and verifying
// hashes after writing. Dry-run is the default and writes zero files.
//
// This module does NOT read env vars, does NOT touch Supabase/network, does
// NOT call the system clock or a random source, does NOT refit or promote a
// model, and never stores raw rows in the manifest.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildPostCutoffEvaluationDataset,
  type PostCutoffEvaluationDataset,
} from "../../../lib/modeling/postCutoffEvaluationDataset";
import {
  evaluatePostCutoffFrozenModels,
  type PostCutoffFrozenModelEvaluation,
} from "../../../lib/modeling/postCutoffModelMembership";
import { POST_CUTOFF_RESOLVED_AT_EXCLUSIVE } from "../../../lib/modeling/postCutoffObservation";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_OUTPUT_DIR = path.join("modeling", "local_exports", "post_cutoff_observation");

export type CliMode = "dry-run" | "write";

export interface PostCutoffCliArgs {
  mode: CliMode;
  inputPath: string;
  outputDir: string;
  cutoff: string;
}

const KNOWN_FLAGS = new Set(["--input", "--output-dir", "--cutoff", "--write-artifacts", "--dry-run"]);

/**
 * Parses CLI arguments. Dry-run is the default mode; --write-artifacts and
 * --dry-run together are a deterministic argument error. Unknown flags and
 * missing values throw.
 */
export function parsePostCutoffCliArgs(argv: string[]): PostCutoffCliArgs {
  let inputPath = DEFAULT_INPUT;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let cutoff: string = POST_CUTOFF_RESOLVED_AT_EXCLUSIVE;
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
    if (value === undefined) {
      throw new Error(`missing value for argument: ${arg}`);
    }
    i += 1;
    if (arg === "--input") inputPath = value;
    else if (arg === "--output-dir") outputDir = value;
    else if (arg === "--cutoff") cutoff = value;
  }

  if (sawWrite && sawDryRun) {
    throw new Error("--dry-run and --write-artifacts cannot be used together");
  }

  return { mode: sawWrite ? "write" : "dry-run", inputPath, outputDir, cutoff };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Loads and validates the canonical export envelope: a JSON array of row
 * objects. Throws a safe error (never raw file content) for a missing file,
 * malformed JSON, a non-array top level, or a row that is not an object.
 */
export function loadExportRows(inputPath: string): ExportRow[] {
  if (!existsSync(inputPath)) {
    throw new Error(`input file not found: ${inputPath}`);
  }
  let raw: string;
  try {
    raw = readFileSync(inputPath, "utf8");
  } catch {
    throw new Error(`input file could not be read: ${inputPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`input file is not valid JSON: ${inputPath}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`input file must be a JSON array of rows (got a non-array envelope): ${inputPath}`);
  }
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`input file contains a non-object row: ${inputPath}`);
    }
  }
  return parsed as ExportRow[];
}

export interface PostCutoffRunArtifacts {
  dataset: PostCutoffEvaluationDataset;
  evaluation: PostCutoffFrozenModelEvaluation;
  inputContentHash: string;
}

/** Builds the dataset + evaluation artifacts. Pure; no fs beyond the caller-provided rows. */
export function buildPostCutoffRunArtifacts(
  rows: readonly ExportRow[],
  cutoff: string,
  inputPath: string,
): PostCutoffRunArtifacts {
  const dataset = buildPostCutoffEvaluationDataset(rows, cutoff);
  const evaluation = evaluatePostCutoffFrozenModels(dataset);
  const inputContentHash = sha256(readFileSync(inputPath, "utf8"));
  return { dataset, evaluation, inputContentHash };
}

interface PostCutoffModelSummary {
  variantId: string;
  selectedObservationCount: number;
  totalPnlUnits: number | null;
  roiPct: number | null;
  currentDrawdownUnits: number | null;
  maxDrawdownUnits: number | null;
}

export interface PostCutoffRunSummary {
  mode: CliMode;
  cutoff: string;
  inputRowCount: number;
  eligibleRowCount: number;
  uniqueObservationCount: number;
  datasetHash: string;
  evaluationHash: string;
  models: PostCutoffModelSummary[];
  emptyWindow: boolean;
}

export interface PostCutoffRunManifest {
  schemaVersion: 1;
  cutoffResolvedAtExclusive: string;

  inputPath: string;
  inputRowCount: number;
  inputContentHash: string;

  datasetArtifact: {
    filename: string;
    datasetHash: string;
    uniqueObservationCount: number;
  };

  evaluationArtifact: {
    filename: string;
    evaluationHash: string;
    modelCount: number;
  };

  emptyWindow: boolean;
}

const DATASET_FILENAME = "post_cutoff_evaluation_dataset.json";
const EVALUATION_FILENAME = "post_cutoff_frozen_model_evaluation.json";
const MANIFEST_FILENAME = "post_cutoff_run_manifest.json";

function buildSummary(
  mode: CliMode,
  rowCount: number,
  artifacts: PostCutoffRunArtifacts,
): PostCutoffRunSummary {
  const { dataset, evaluation } = artifacts;
  const emptyWindow = dataset.uniqueObservationCount === 0;
  return {
    mode,
    cutoff: dataset.cutoffResolvedAtExclusive,
    inputRowCount: rowCount,
    eligibleRowCount: dataset.eligibleRowCount,
    uniqueObservationCount: dataset.uniqueObservationCount,
    datasetHash: dataset.datasetHash,
    evaluationHash: evaluation.evaluationHash,
    models: evaluation.models.map((m) => ({
      variantId: m.variantId,
      selectedObservationCount: m.selectedObservationCount,
      totalPnlUnits: m.totalPnlUnits,
      roiPct: m.roiPct,
      currentDrawdownUnits: m.currentDrawdownUnits,
      maxDrawdownUnits: m.maxDrawdownUnits,
    })),
    emptyWindow,
  };
}

function buildManifest(
  inputPath: string,
  rowCount: number,
  artifacts: PostCutoffRunArtifacts,
): PostCutoffRunManifest {
  const { dataset, evaluation, inputContentHash } = artifacts;
  return {
    schemaVersion: 1,
    cutoffResolvedAtExclusive: dataset.cutoffResolvedAtExclusive,
    inputPath,
    inputRowCount: rowCount,
    inputContentHash,
    datasetArtifact: {
      filename: DATASET_FILENAME,
      datasetHash: dataset.datasetHash,
      uniqueObservationCount: dataset.uniqueObservationCount,
    },
    evaluationArtifact: {
      filename: EVALUATION_FILENAME,
      evaluationHash: evaluation.evaluationHash,
      modelCount: evaluation.models.length,
    },
    emptyWindow: dataset.uniqueObservationCount === 0,
  };
}

/** Deterministic pretty JSON with a trailing newline. */
export function serializeDeterministicJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Atomic write: write to a sibling temp file, then rename into place. */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

export interface PostCutoffRunResult {
  exitCode: number;
  summary: PostCutoffRunSummary;
  error?: string;
}

/**
 * Runs the full CLI: parses args, loads + validates input rows, builds the
 * dataset and evaluation, and (mode === "write") writes the three artifacts
 * atomically, re-reads them, and verifies every cross-artifact hash/count
 * before reporting success. Never throws to the caller -- all failures
 * become a non-zero exit code with a safe error message.
 */
export function runPostCutoffModelEvaluation(argv: string[]): PostCutoffRunResult {
  try {
    const args = parsePostCutoffCliArgs(argv);
    const rows = loadExportRows(args.inputPath);
    const artifacts = buildPostCutoffRunArtifacts(rows, args.cutoff, args.inputPath);
    const summary = buildSummary(args.mode, rows.length, artifacts);

    if (args.mode === "dry-run") {
      return { exitCode: 0, summary };
    }

    const manifest = buildManifest(args.inputPath, rows.length, artifacts);

    if (!existsSync(args.outputDir)) {
      mkdirSync(args.outputDir, { recursive: true });
    }

    const datasetPath = path.join(args.outputDir, DATASET_FILENAME);
    const evaluationPath = path.join(args.outputDir, EVALUATION_FILENAME);
    const manifestPath = path.join(args.outputDir, MANIFEST_FILENAME);

    const datasetJson = serializeDeterministicJson(artifacts.dataset);
    const evaluationJson = serializeDeterministicJson(artifacts.evaluation);
    const manifestJson = serializeDeterministicJson(manifest);

    atomicWrite(datasetPath, datasetJson);
    atomicWrite(evaluationPath, evaluationJson);
    atomicWrite(manifestPath, manifestJson);

    // Re-read written files and verify every cross-artifact invariant before
    // reporting success. A failure here throws (caught below), leaving no
    // manifest that falsely claims a verified, reconciled write.
    const rereadDataset = JSON.parse(readFileSync(datasetPath, "utf8")) as PostCutoffEvaluationDataset;
    const rereadEvaluation = JSON.parse(readFileSync(evaluationPath, "utf8")) as PostCutoffFrozenModelEvaluation;
    const rereadManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PostCutoffRunManifest;

    if (rereadDataset.datasetHash !== artifacts.dataset.datasetHash) {
      throw new Error("artifact verification failed: dataset hash mismatch after write");
    }
    if (rereadEvaluation.datasetHash !== rereadDataset.datasetHash) {
      throw new Error("artifact verification failed: evaluation datasetHash does not match dataset artifact");
    }
    if (rereadEvaluation.evaluationHash !== artifacts.evaluation.evaluationHash) {
      throw new Error("artifact verification failed: evaluation hash mismatch after write");
    }
    if (rereadManifest.datasetArtifact.datasetHash !== rereadDataset.datasetHash) {
      throw new Error("artifact verification failed: manifest datasetHash does not match dataset artifact");
    }
    if (rereadManifest.evaluationArtifact.evaluationHash !== rereadEvaluation.evaluationHash) {
      throw new Error("artifact verification failed: manifest evaluationHash does not match evaluation artifact");
    }
    if (rereadManifest.datasetArtifact.uniqueObservationCount !== rereadDataset.uniqueObservationCount) {
      throw new Error("artifact verification failed: manifest uniqueObservationCount does not match dataset artifact");
    }
    if (rereadManifest.evaluationArtifact.modelCount !== rereadEvaluation.models.length) {
      throw new Error("artifact verification failed: manifest modelCount does not match evaluation artifact");
    }

    return { exitCode: 0, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      exitCode: 1,
      summary: {
        mode: "dry-run",
        cutoff: "",
        inputRowCount: 0,
        eligibleRowCount: 0,
        uniqueObservationCount: 0,
        datasetHash: "",
        evaluationHash: "",
        models: [],
        emptyWindow: false,
      },
      error: message,
    };
  }
}

function main(): void {
  const result = runPostCutoffModelEvaluation(process.argv.slice(2));
  if (result.exitCode !== 0) {
    process.stderr.write(`Error: ${result.error}\n`);
  } else if (result.summary.mode === "dry-run") {
    process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  }
  process.exit(result.exitCode);
}

if (require.main === module) {
  main();
}
