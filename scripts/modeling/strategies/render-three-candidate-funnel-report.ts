#!/usr/bin/env -S node --import tsx
// Three-candidate funnel catalog + report CLI (Phase 3E.8A).
//
// Builds the catalog from the classifier, writes the machine-readable catalog
// JSON, and renders the founder/CEO HTML report. Optionally loads an existing
// historical comparison for the "actual attrition" section -- but only when
// its corpus hash matches the expected value (otherwise the section stays
// HISTORICAL_ATTRITION_NOT_LOADED). Reads only local files; no env, no
// network, no DB.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  buildThreeCandidateFunnelCatalog,
  THREE_CANDIDATE_IDS,
} from "../../../lib/modeling/threeCandidateFunnelCatalog";
import {
  renderThreeCandidateFunnelReport,
  type HistoricalComparisonLike,
} from "../../../lib/modeling/threeCandidateFunnelReport";
import { loadExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";

const DEFAULT_CATALOG_OUT = path.join("modeling", "local_exports", "three_candidate_funnel_catalog.json");
const DEFAULT_REPORT_OUT = path.join("modeling", "local_exports", "three_candidate_funnel_report.html");
const DEFAULT_COMPARISON = path.join("modeling", "local_exports", "historical_funnel_comparison.json");
const EXPECTED_CORPUS_SHA256 = "90ce9662c43185d7b1c4bc03ce66b46f8bf481faeac186d835dbd2638d739b72";

interface ParsedArgs {
  catalogOut: string;
  reportOut: string;
  comparison: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { catalogOut: DEFAULT_CATALOG_OUT, reportOut: DEFAULT_REPORT_OUT, comparison: DEFAULT_COMPARISON };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog-output") args.catalogOut = argv[++i] ?? args.catalogOut;
    else if (a === "--report-output") args.reportOut = argv[++i] ?? args.reportOut;
    else if (a === "--comparison") args.comparison = argv[++i] ?? args.comparison;
  }
  return args;
}

function safeWrite(outPath: string, content: string): void {
  const dir = path.dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, content, "utf8");
}

export function runRenderThreeCandidateReportCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  const args = parseArgs(argv);
  try {
    const classifier = loadExecutableFunnelClassifier();
    const catalog = buildThreeCandidateFunnelCatalog({ classifier, candidateIds: [...THREE_CANDIDATE_IDS] });

    let historicalComparison: HistoricalComparisonLike | undefined;
    if (existsSync(args.comparison)) {
      try {
        historicalComparison = JSON.parse(readFileSync(args.comparison, "utf8")) as HistoricalComparisonLike;
      } catch {
        historicalComparison = undefined; // unreadable -> attrition stays NOT_LOADED
      }
    }

    const html = renderThreeCandidateFunnelReport({
      catalog,
      historicalComparison,
      expectedCorpusSha256: EXPECTED_CORPUS_SHA256,
    });

    safeWrite(args.catalogOut, `${JSON.stringify(catalog, null, 2)}\n`);
    safeWrite(args.reportOut, html);

    log(`Wrote catalog to ${args.catalogOut}\nWrote report to ${args.reportOut}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Error: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runRenderThreeCandidateReportCli(process.argv.slice(2)));
}
