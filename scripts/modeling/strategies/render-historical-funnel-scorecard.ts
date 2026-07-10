#!/usr/bin/env -S node --import tsx
// Founder scorecard CLI (Phase 3E.6).
//
// Reads the already-computed comparison JSON, the reproducible manifest JSON,
// and the executable funnel classifier, then writes a deterministic
// founder-readable HTML scorecard. Reads only local files; no env, no
// network, no DB. Does not recompute model predicates -- it renders what the
// comparison engine already produced (and refuses to render if the
// comparison and manifest describe different corpora).

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  renderHistoricalFunnelScorecard,
  type ComparisonWithHash,
} from "../../../lib/modeling/historicalFunnelScorecard";
import type { EvaluationRunManifest } from "../../../lib/modeling/evaluationRunManifest";
import { loadExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";

const DEFAULT_COMPARISON = path.join("modeling", "local_exports", "historical_funnel_comparison.json");
const DEFAULT_MANIFEST = path.join("modeling", "local_exports", "historical_funnel_comparison_manifest.json");
const DEFAULT_OUTPUT = path.join("modeling", "local_exports", "historical_funnel_scorecard.html");

interface ParsedArgs {
  comparison: string;
  manifest: string;
  output: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { comparison: DEFAULT_COMPARISON, manifest: DEFAULT_MANIFEST, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--comparison") args.comparison = argv[++i] ?? args.comparison;
    else if (a === "--manifest") args.manifest = argv[++i] ?? args.manifest;
    else if (a === "--output") args.output = argv[++i] ?? args.output;
  }
  return args;
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

export function runRenderScorecardCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  const args = parseArgs(argv);
  try {
    ensureFile(args.comparison, "comparison");
    ensureFile(args.manifest, "manifest");
    const comparison = JSON.parse(readFileSync(args.comparison, "utf8")) as ComparisonWithHash;
    const manifest = JSON.parse(readFileSync(args.manifest, "utf8")) as EvaluationRunManifest;
    const classifier = loadExecutableFunnelClassifier();
    const html = renderHistoricalFunnelScorecard({ comparison, manifest, classifier });
    const dir = path.dirname(args.output);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(args.output, html, "utf8");
    log(`Wrote scorecard to ${args.output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Error: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runRenderScorecardCli(process.argv.slice(2)));
}
