#!/usr/bin/env -S node --import tsx
// Bounded Routing Experiments CLI (Phase 4B.2A / B2A).
//
// Reads ONLY local files (raw canonical corpus, classifier registry, and the
// B1 score-component evidence artifact), validates evidence provenance, builds
// the deterministic bounded-routing experiment via the pure lib module, and
// (only under --write-artifacts) writes exactly three artifacts atomically
// with re-read hash verification. Dry-run is the default and writes zero
// files. The three candidates are FROZEN by this version -- there are no
// candidate-selection flags. No env reads, no network, no Supabase, no forward
// data. Import never auto-runs (guarded by require.main === module).

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildBoundedRoutingExperiments,
  serializeBoundedRoutingJson,
  renderBoundedRoutingHtml,
  buildBoundedRoutingManifest,
} from "../../../lib/modeling/boundedRoutingExperiments";
import {
  loadExecutableFunnelClassifier,
  type ExecutableFunnelClassifier,
} from "../../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_CLASSIFIER = path.join("modeling", "model_registry", "executable_funnel_classifier.json");
const DEFAULT_EVIDENCE = path.join("modeling", "local_exports", "score_component_analysis", "score_component_analysis.json");
const DEFAULT_OUTPUT_DIR = path.join("modeling", "local_exports", "bounded_routing_experiments");

const JSON_FILENAME = "bounded_routing_experiments.json";
const HTML_FILENAME = "bounded_routing_experiments.html";
const MANIFEST_FILENAME = "bounded_routing_experiments_manifest.json";

export type BoundedRoutingCliMode = "dry-run" | "write";

export interface BoundedRoutingArgs {
  mode: BoundedRoutingCliMode;
  input: string;
  classifier: string;
  evidence: string;
  outputDir: string;
}

const KNOWN_FLAGS = new Set(["--input", "--classifier", "--evidence", "--output-dir", "--write-artifacts", "--dry-run"]);

export function parseBoundedRoutingArgs(argv: string[]): BoundedRoutingArgs {
  let input = DEFAULT_INPUT;
  let classifier = DEFAULT_CLASSIFIER;
  let evidence = DEFAULT_EVIDENCE;
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
    else if (arg === "--evidence") evidence = value;
    else if (arg === "--output-dir") outputDir = value;
  }

  if (sawWrite && sawDryRun) throw new Error("--dry-run and --write-artifacts cannot be used together");

  return { mode: sawWrite ? "write" : "dry-run", input, classifier, evidence, outputDir };
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

export function runBoundedRoutingExperimentsCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  let args: BoundedRoutingArgs;
  try {
    args = parseBoundedRoutingArgs(argv);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }

  try {
    const inputRaw = readRaw(args.input, "input corpus");
    const rawRows = parseJson<ExportRow[]>(inputRaw, "input corpus", args.input);
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw new Error(`input corpus must be a non-empty JSON array of rows: ${args.input}`);
    }

    const classifierRaw = args.classifier === DEFAULT_CLASSIFIER ? null : readRaw(args.classifier, "classifier");
    const classifier: ExecutableFunnelClassifier =
      classifierRaw === null ? loadExecutableFunnelClassifier() : parseJson<ExecutableFunnelClassifier>(classifierRaw, "classifier", args.classifier);
    const classifierSha256 =
      classifierRaw === null ? sha256(readFileSync(path.join("modeling", "model_registry", "executable_funnel_classifier.json"), "utf8")) : sha256(classifierRaw);

    const evidenceRaw = readRaw(args.evidence, "evidence");
    const evidence = parseJson<unknown>(evidenceRaw, "evidence", args.evidence);

    const result = buildBoundedRoutingExperiments({ rawRows, classifier, evidence });

    if (args.mode === "dry-run") {
      log(
        `${JSON.stringify(
          {
            mode: "dry-run",
            rawRowCount: result.corpusSummary.rawRowCount,
            strictDedupRowCount: result.corpusSummary.strictDedupRowCount,
            baseComparator: result.baseComparator,
            candidateIds: result.candidateMetrics.map((m) => m.id),
            triage: result.triage.map((t) => ({ candidateId: t.candidateId, status: t.status })),
            contentHash: result.contentHash,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    const jsonString = serializeBoundedRoutingJson(result);
    const htmlString = renderBoundedRoutingHtml(result);
    const manifest = buildBoundedRoutingManifest(
      result,
      { inputSha256: sha256(inputRaw), classifierSha256, evidenceSha256: sha256(evidenceRaw) },
      jsonString,
      htmlString,
    );
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

    log(`Wrote bounded routing experiment artifacts to ${args.outputDir}\n`);
    return 0;
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runBoundedRoutingExperimentsCli(process.argv.slice(2)));
}
