#!/usr/bin/env -S node --import tsx
// One-command Historical Research Pipeline CLI (Phase 4D.1 / D1).
//
// Reads ONLY local files (raw canonical corpus + classifier registry),
// builds the entire A1 -> A2 -> B1 -> B2A -> C1 -> D1 chain via the pure lib
// module (which itself calls only the existing accepted stage build
// functions -- no stage math is reimplemented), and (only under
// --write-artifacts) writes every upstream stage's own artifacts plus the
// final D1 packet under a sibling staging directory, verifies every write,
// and only then atomically replaces the final output root. A failed run
// never touches a previously valid output root and never leaves a stale
// staging directory. Dry-run is the default and writes zero files, and does
// not execute the (expensive) stage calculations. No env reads, no network,
// no Supabase, no forward data. Import never auto-runs.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildFullPipeline,
  STAGE_ARTIFACT_NAMES,
  PACKET_ARTIFACT_NAMES,
  PIPELINE_STAGES,
} from "../../../lib/modeling/historicalResearchPipeline";
import { loadExecutableFunnelClassifier, type ExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_CLASSIFIER = path.join("modeling", "model_registry", "executable_funnel_classifier.json");
const DEFAULT_OUTPUT_ROOT = path.join("modeling", "local_exports", "historical_research_pipeline");

export type HistoricalResearchPipelineCliMode = "dry-run" | "write";

export interface HistoricalResearchPipelineArgs {
  mode: HistoricalResearchPipelineCliMode;
  input: string;
  classifier: string;
  outputRoot: string;
}

const KNOWN_FLAGS = new Set(["--input", "--classifier", "--output-root", "--write-artifacts", "--dry-run"]);

export function parseHistoricalResearchPipelineArgs(argv: string[]): HistoricalResearchPipelineArgs {
  let input = DEFAULT_INPUT;
  let classifier = DEFAULT_CLASSIFIER;
  let outputRoot = DEFAULT_OUTPUT_ROOT;
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
    else if (arg === "--output-root") outputRoot = value;
  }

  if (sawWrite && sawDryRun) throw new Error("--dry-run and --write-artifacts cannot be used together");

  return { mode: sawWrite ? "write" : "dry-run", input, classifier, outputRoot };
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

function readRaw(p: string, label: string): string {
  ensureFile(p, label);
  return readFileSync(p, "utf8");
}

function parseJson<T>(raw: string, label: string, p: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label} is not valid JSON: ${p}`);
  }
}

function writeVerified(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, "utf8");
  if (readFileSync(filePath, "utf8") !== content) {
    throw new Error(`artifact verification failed after write: ${path.basename(filePath)}`);
  }
}

// Deterministic within a single process run (pid-scoped); never persisted
// into any JSON/HTML/manifest content -- filesystem staging name only.
function stagingDirFor(outputRoot: string): string {
  return `${outputRoot}.tmp-${process.pid}`;
}

export function runHistoricalResearchPipelineCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  let args: HistoricalResearchPipelineArgs;
  try {
    args = parseHistoricalResearchPipelineArgs(argv);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }

  let stagingDir: string | null = null;

  try {
    const inputRaw = readRaw(args.input, "input corpus");
    const rawRows = parseJson<ExportRow[]>(inputRaw, "input corpus", args.input);
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw new Error(`input corpus must be a non-empty JSON array of rows: ${args.input}`);
    }

    const classifierRaw = args.classifier === DEFAULT_CLASSIFIER ? null : readRaw(args.classifier, "classifier");
    const classifier: ExecutableFunnelClassifier =
      classifierRaw === null ? loadExecutableFunnelClassifier() : parseJson<ExecutableFunnelClassifier>(classifierRaw, "classifier", args.classifier);

    if (args.mode === "dry-run") {
      // Dry-run validates inputs and reports an execution plan only -- it
      // never runs the (expensive) stage build functions.
      log(
        `${JSON.stringify(
          {
            mode: "dry-run",
            plannedStages: [...PIPELINE_STAGES],
            inputRowCount: rawRows.length,
            outputRoot: args.outputRoot,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    // ---- transactional write: build everything in a sibling staging dir ----
    stagingDir = stagingDirFor(args.outputRoot);
    // Remove only a stale staging directory owned by this pipeline (pid-scoped
    // name already guarantees ownership); never touch the valid final output.
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    const artifacts = buildFullPipeline({ rawRows, classifier });

    const stageDirNames: Record<keyof typeof STAGE_ARTIFACT_NAMES, string> = {
      STAGE_A1_DECOMPOSITION: "a1",
      STAGE_A2_DASHBOARD: "a2",
      STAGE_B1_COMPONENTS: "b1",
      STAGE_B2A_EXPERIMENTS: "b2a",
      STAGE_C1_REGISTRY: "c1",
    };
    const stageArtifactContents: Record<keyof typeof STAGE_ARTIFACT_NAMES, [string, string, string]> = {
      STAGE_A1_DECOMPOSITION: [artifacts.a1.json, artifacts.a1.html, artifacts.a1.manifest],
      STAGE_A2_DASHBOARD: [artifacts.a2.json, artifacts.a2.html, artifacts.a2.manifest],
      STAGE_B1_COMPONENTS: [artifacts.b1.json, artifacts.b1.html, artifacts.b1.manifest],
      STAGE_B2A_EXPERIMENTS: [artifacts.b2a.json, artifacts.b2a.html, artifacts.b2a.manifest],
      STAGE_C1_REGISTRY: [artifacts.c1.json, artifacts.c1.html, artifacts.c1.manifest],
    };

    for (const stageId of Object.keys(stageDirNames) as Array<keyof typeof STAGE_ARTIFACT_NAMES>) {
      const dirName = stageDirNames[stageId];
      const names = STAGE_ARTIFACT_NAMES[stageId];
      const contents = stageArtifactContents[stageId];
      for (let i = 0; i < names.length; i++) {
        writeVerified(path.join(stagingDir, "stages", dirName, names[i]), contents[i]);
      }
    }

    const packetContents = [artifacts.packet.json, artifacts.packet.html, artifacts.packet.manifest];
    for (let i = 0; i < PACKET_ARTIFACT_NAMES.length; i++) {
      writeVerified(path.join(stagingDir, "packet", PACKET_ARTIFACT_NAMES[i]), packetContents[i]);
    }

    // ---- re-read verification of every written byte before replacing ----
    for (const stageId of Object.keys(stageDirNames) as Array<keyof typeof STAGE_ARTIFACT_NAMES>) {
      const dirName = stageDirNames[stageId];
      const names = STAGE_ARTIFACT_NAMES[stageId];
      const contents = stageArtifactContents[stageId];
      for (let i = 0; i < names.length; i++) {
        const p = path.join(stagingDir, "stages", dirName, names[i]);
        if (sha256(readFileSync(p, "utf8")) !== sha256(contents[i])) {
          throw new Error(`artifact verification failed: ${dirName}/${names[i]} changed after write`);
        }
      }
    }
    for (let i = 0; i < PACKET_ARTIFACT_NAMES.length; i++) {
      const p = path.join(stagingDir, "packet", PACKET_ARTIFACT_NAMES[i]);
      if (sha256(readFileSync(p, "utf8")) !== sha256(packetContents[i])) {
        throw new Error(`artifact verification failed: packet/${PACKET_ARTIFACT_NAMES[i]} changed after write`);
      }
    }

    // ---- atomic replace: only now touch the final output root ----
    const backupDir = `${args.outputRoot}.bak-${process.pid}`;
    if (existsSync(args.outputRoot)) {
      renameSync(args.outputRoot, backupDir);
    }
    try {
      renameSync(stagingDir, args.outputRoot);
      stagingDir = null;
    } catch (error) {
      // Roll back: restore the previous valid output, remove the failed staging dir.
      if (existsSync(backupDir)) renameSync(backupDir, args.outputRoot);
      throw error;
    }
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });

    log(`Wrote historical research pipeline artifacts to ${args.outputRoot}\n`);
    return 0;
  } catch (error) {
    if (stagingDir && existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

if (require.main === module) {
  process.exit(runHistoricalResearchPipelineCli(process.argv.slice(2)));
}
