#!/usr/bin/env -S node --import tsx
// Founder robustness report CLI (Phase 3E.7).
//
// Reads the already-computed candidate robustness audit JSON and the
// classifier, then writes a deterministic founder-readable HTML report.
// Reads only local files; no env, no network, no DB. Does not recompute any
// audited figure.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { renderCandidateRobustnessReport } from "../../../lib/modeling/candidateRobustnessReport";
import type { CandidateRobustnessAuditResult } from "../../../lib/modeling/candidateRobustnessAudit";
import { loadExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";

const DEFAULT_AUDIT = path.join("modeling", "local_exports", "candidate_robustness_audit.json");
const DEFAULT_OUTPUT = path.join("modeling", "local_exports", "candidate_robustness_report.html");

interface ParsedArgs {
  audit: string;
  output: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { audit: DEFAULT_AUDIT, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--audit") args.audit = argv[++i] ?? args.audit;
    else if (a === "--output") args.output = argv[++i] ?? args.output;
  }
  return args;
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

export function runRenderRobustnessReportCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  const args = parseArgs(argv);
  try {
    ensureFile(args.audit, "audit result");
    const audit = JSON.parse(readFileSync(args.audit, "utf8")) as CandidateRobustnessAuditResult;
    const classifier = loadExecutableFunnelClassifier();
    const html = renderCandidateRobustnessReport({ audit, classifier });
    const dir = path.dirname(args.output);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(args.output, html, "utf8");
    log(`Wrote robustness report to ${args.output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Error: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runRenderRobustnessReportCli(process.argv.slice(2)));
}
