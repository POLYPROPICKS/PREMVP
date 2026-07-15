#!/usr/bin/env -S node --import tsx
// Unified Hypothesis Registry CLI (Phase 4C.1 / C1).
//
// Reads ONLY local files (the A1/A2/B1/B2A evidence artifacts), validates
// their lineage (content hashes, corpus counts, strict-dedup policy, ALT4
// base comparator, frozen 3-candidate budget), builds the deterministic
// registry snapshot via the pure lib module, and (only under
// --write-artifacts) writes exactly three artifacts atomically with re-read
// hash verification. Dry-run is the default and writes zero files. No env
// reads, no network, no Supabase, no forward data. Import never auto-runs.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildHypothesisRegistry,
  serializeHypothesisRegistryJson,
  renderHypothesisRegistryHtml,
  buildHypothesisRegistryManifest,
} from "../../../lib/modeling/hypothesisRegistry";
import type { ExtendedHistoricalDecomposition } from "../../../lib/modeling/extendedHistoricalDecomposition";
import type { ExtendedHistoricalDashboard } from "../../../lib/modeling/extendedHistoricalDashboard";
import type { ScoreComponentAnalysisResult } from "../../../lib/modeling/scoreComponentAnalysis";
import type { BoundedRoutingResult } from "../../../lib/modeling/boundedRoutingExperiments";

const DEFAULT_DECOMPOSITION = path.join("modeling", "local_exports", "extended_historical_decomposition", "extended_historical_decomposition.json");
const DEFAULT_DASHBOARD = path.join("modeling", "local_exports", "extended_historical_dashboard", "extended_historical_dashboard.json");
const DEFAULT_COMPONENTS = path.join("modeling", "local_exports", "score_component_analysis", "score_component_analysis.json");
const DEFAULT_EXPERIMENTS = path.join("modeling", "local_exports", "bounded_routing_experiments", "bounded_routing_experiments.json");
const DEFAULT_OUTPUT_DIR = path.join("modeling", "local_exports", "hypothesis_registry");

const JSON_FILENAME = "hypothesis_registry.json";
const HTML_FILENAME = "hypothesis_registry.html";
const MANIFEST_FILENAME = "hypothesis_registry_manifest.json";

export type HypothesisRegistryCliMode = "dry-run" | "write";

export interface HypothesisRegistryArgs {
  mode: HypothesisRegistryCliMode;
  decomposition: string;
  dashboard: string;
  components: string;
  experiments: string;
  outputDir: string;
}

const KNOWN_FLAGS = new Set(["--decomposition", "--dashboard", "--components", "--experiments", "--output-dir", "--write-artifacts", "--dry-run"]);

export function parseHypothesisRegistryArgs(argv: string[]): HypothesisRegistryArgs {
  let decomposition = DEFAULT_DECOMPOSITION;
  let dashboard = DEFAULT_DASHBOARD;
  let components = DEFAULT_COMPONENTS;
  let experiments = DEFAULT_EXPERIMENTS;
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
    if (arg === "--decomposition") decomposition = value;
    else if (arg === "--dashboard") dashboard = value;
    else if (arg === "--components") components = value;
    else if (arg === "--experiments") experiments = value;
    else if (arg === "--output-dir") outputDir = value;
  }

  if (sawWrite && sawDryRun) throw new Error("--dry-run and --write-artifacts cannot be used together");

  return { mode: sawWrite ? "write" : "dry-run", decomposition, dashboard, components, experiments, outputDir };
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

export function runBuildHypothesisRegistryCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  let args: HypothesisRegistryArgs;
  try {
    args = parseHypothesisRegistryArgs(argv);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }

  try {
    const decompositionRaw = readRaw(args.decomposition, "decomposition (A1)");
    const dashboardRaw = readRaw(args.dashboard, "dashboard (A2)");
    const componentsRaw = readRaw(args.components, "components (B1)");
    const experimentsRaw = readRaw(args.experiments, "experiments (B2A)");

    const decomposition = parseJson<ExtendedHistoricalDecomposition>(decompositionRaw, "decomposition (A1)", args.decomposition);
    const dashboard = parseJson<ExtendedHistoricalDashboard>(dashboardRaw, "dashboard (A2)", args.dashboard);
    const components = parseJson<ScoreComponentAnalysisResult>(componentsRaw, "components (B1)", args.components);
    const experiments = parseJson<BoundedRoutingResult>(experimentsRaw, "experiments (B2A)", args.experiments);

    const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });

    if (args.mode === "dry-run") {
      log(
        `${JSON.stringify(
          {
            mode: "dry-run",
            rawRowCount: result.corpusSummary.rawRowCount,
            strictDedupRowCount: result.corpusSummary.strictDedupRowCount,
            hypothesisCount: result.hypotheses.length,
            registrySummary: result.registrySummary,
            contentHash: result.contentHash,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    const jsonString = serializeHypothesisRegistryJson(result);
    const htmlString = renderHypothesisRegistryHtml(result);
    const manifest = buildHypothesisRegistryManifest(
      result,
      {
        decompositionSha256: sha256(decompositionRaw),
        dashboardSha256: sha256(dashboardRaw),
        componentsSha256: sha256(componentsRaw),
        experimentsSha256: sha256(experimentsRaw),
      },
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

    log(`Wrote hypothesis registry artifacts to ${args.outputDir}\n`);
    return 0;
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runBuildHypothesisRegistryCli(process.argv.slice(2)));
}
