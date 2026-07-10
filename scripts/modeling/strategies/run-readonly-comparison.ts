#!/usr/bin/env -S node --import tsx
// Read-only local strategy comparison CLI (Phase 3D.2H / 3D.2I / 3D.2K / 3D.2N).
//
// Reads rows from a local JSON file (--input) and strategy declaration JSON
// files from ./declarations, runs runStrategyComparison() from
// lib/modeling/strategyComparison.ts, and prints the JSON result to stdout.
//
// This CLI does NOT:
//   - read any environment variable
//   - import Supabase or any database client
//   - import Next.js app code
//   - compute ROI/PnL
//   - write any file or database record
//   - fix any outcome-resolution behavior (DQA-R4 below is audit-only)
//   - deduplicate rows by default (dedup is opt-in via --dedup-policy)
//
// Usage:
//   node --import tsx scripts/modeling/strategies/run-readonly-comparison.ts \
//     --input ./path/to/rows.json --required-only \
//     --input-format generated_signal_pairs --include-dqa-r4 \
//     --dedup-policy strict_latest_created_before_resolved
//
//   --input <path>       Required. Path to a local JSON file containing an
//                         array of row objects.
//   --required-only      Run only declarations with requiredForComparison
//                         === true. This is the default when no other
//                         selection flag is given.
//   --all-ready           Run every loaded declaration (still refuses any
//                         that are not READY_TO_NORMALIZE or that need a
//                         comparator this CLI does not provide).
//   --strategy <id[,id2]> Run only the named strategyId(s). Repeatable or
//                         comma-separated. Overrides --required-only/--all-ready.
//   --input-format <fmt>  "loose" (default) or "generated_signal_pairs". In
//                         generated_signal_pairs mode, the rows are also run
//                         through validateGeneratedSignalPairsExportRows()
//                         from lib/modeling/generatedSignalPairsExportContract.ts
//                         and the resulting diagnostics are included in the
//                         output as `inputValidation`. This is structural
//                         validation only -- no rows are rejected, filtered,
//                         or fixed as a result.
//   --include-dqa-r4       Also run auditOutcomeResolutionConsistency() from
//                         lib/modeling/datasetAudit/outcomeResolutionConsistency.ts
//                         and include the result as top-level `dqaR4` in the
//                         output. Requires --input-format generated_signal_pairs
//                         (the CLI exits non-zero otherwise). Audit-only: it
//                         never changes outcome-resolution behavior or strategy
//                         selection. When combined with --dedup-policy, DQA-R4
//                         runs against the deduped rows.
//   --dedup-policy <name>  Optional. Currently only
//                         "strict_latest_created_before_resolved" is
//                         supported. Requires --input-format
//                         generated_signal_pairs (the CLI exits non-zero
//                         otherwise). When present, runs
//                         projectGeneratedSignalPairsStrictDedup() from
//                         lib/modeling/generatedSignalPairsDedupPolicy.ts,
//                         includes the projection diagnostics as top-level
//                         `dedupProjection`, and runs the strategy
//                         comparison (and DQA-R4, if requested) on the
//                         deduped rows instead of the raw rows. Without
//                         this flag, the default/loose behavior is
//                         unchanged: strategies always run on raw rows.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  runStrategyComparison,
  runStrategyComparisonWithSelectedRows,
} from "../../../lib/modeling/strategyComparison";
import type { StrategyDeclaration, EvaluatorRow } from "../../../lib/modeling/strategyEvaluator";
import { computeFlatStakeRoiSummary } from "../../../lib/modeling/roiPnlContract";
import {
  validateGeneratedSignalPairsExportRows,
  type ExportRow,
  type GeneratedSignalPairsExportDiagnostics,
} from "../../../lib/modeling/generatedSignalPairsExportContract";
import {
  auditOutcomeResolutionConsistency,
  type OutcomeResolutionAuditRow,
  type OutcomeResolutionAuditSummary,
} from "../../../lib/modeling/datasetAudit/outcomeResolutionConsistency";
import {
  projectGeneratedSignalPairsStrictDedup,
  STRICT_DEDUP_POLICY_NAME,
  type GeneratedSignalPairsDedupProjection,
} from "../../../lib/modeling/generatedSignalPairsDedupPolicy";

const DECLARATIONS_DIR = path.resolve(__dirname, "declarations");

const SUPPORTED_INPUT_FORMATS = ["loose", "generated_signal_pairs"] as const;
type InputFormat = (typeof SUPPORTED_INPUT_FORMATS)[number];

const SUPPORTED_DEDUP_POLICIES = [STRICT_DEDUP_POLICY_NAME] as const;
type DedupPolicy = (typeof SUPPORTED_DEDUP_POLICIES)[number];

interface ParsedArgs {
  input: string | null;
  allReady: boolean;
  strategyIds: string[];
  inputFormat: InputFormat;
  includeDqaR4: boolean;
  dedupPolicy: DedupPolicy | null;
  includeRoi: boolean;
  exportSummary: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    input: null,
    allReady: false,
    strategyIds: [],
    inputFormat: "loose",
    includeDqaR4: false,
    dedupPolicy: null,
    includeRoi: false,
    exportSummary: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--required-only") {
      // Default behavior; accepted explicitly for clarity/documentation.
    } else if (arg === "--all-ready") {
      args.allReady = true;
    } else if (arg === "--strategy") {
      const value = argv[i + 1] ?? "";
      i += 1;
      args.strategyIds.push(
        ...value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg === "--input-format") {
      const value = argv[i + 1] ?? "";
      i += 1;
      if ((SUPPORTED_INPUT_FORMATS as readonly string[]).includes(value)) {
        args.inputFormat = value as InputFormat;
      } else {
        fail(
          `invalid --input-format "${value}" (supported: ${SUPPORTED_INPUT_FORMATS.join(", ")})`,
        );
      }
    } else if (arg === "--include-dqa-r4") {
      args.includeDqaR4 = true;
    } else if (arg === "--include-roi") {
      args.includeRoi = true;
    } else if (arg === "--export-summary") {
      args.exportSummary = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--dedup-policy") {
      const value = argv[i + 1] ?? "";
      i += 1;
      if ((SUPPORTED_DEDUP_POLICIES as readonly string[]).includes(value)) {
        args.dedupPolicy = value as DedupPolicy;
      } else {
        fail(
          `invalid --dedup-policy "${value}" (supported: ${SUPPORTED_DEDUP_POLICIES.join(", ")})`,
        );
      }
    }
  }

  if (args.includeDqaR4 && args.inputFormat !== "generated_signal_pairs") {
    fail("--include-dqa-r4 requires --input-format generated_signal_pairs");
  }

  if (args.dedupPolicy && args.inputFormat !== "generated_signal_pairs") {
    fail("--dedup-policy requires --input-format generated_signal_pairs");
  }

  if (args.includeRoi) {
    if (args.inputFormat !== "generated_signal_pairs") {
      fail("--include-roi requires --input-format generated_signal_pairs");
    }
    if (args.dedupPolicy !== STRICT_DEDUP_POLICY_NAME) {
      fail(`--include-roi requires --dedup-policy ${STRICT_DEDUP_POLICY_NAME}`);
    }
    if (!args.includeDqaR4) {
      fail("--include-roi requires --include-dqa-r4");
    }
    if (!args.exportSummary) {
      fail("--include-roi requires --export-summary <path>");
    }
  }

  return args;
}

function loadDeclarations(): StrategyDeclaration[] {
  const files = readdirSync(DECLARATIONS_DIR).filter((file) => file.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(path.join(DECLARATIONS_DIR, file), "utf8");
    return JSON.parse(raw) as StrategyDeclaration;
  });
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

const VALID_COMPLETION_PROOFS = new Set(["LAST_PAGE_SHORT", "EMPTY_PAGE"]);

/**
 * Pure gate over an export summary sidecar's completeness claim. Accepts
 * either shape produced by export-generated-signal-pairs-from-supabase.ts:
 *   - legacy exact-count complete (Phase 3D.2P/3E.2a):
 *     exportCompleteness === "COMPLETE" and missingRows === 0
 *   - exhaustion complete (Phase 3E.2b): exportCompleteness ===
 *     "COMPLETE_BY_EXHAUSTION", exportMode === "FULL_RESOLVED_BY_EXHAUSTION",
 *     a valid completionProof ("LAST_PAGE_SHORT" | "EMPTY_PAGE"), a
 *     non-empty exportCutoffResolvedAt string, and missingRows === 0.
 * Both shapes additionally require fetchedRows === inputValidationTotalRows.
 * Anything else (DEBUG_CAPPED/INTENTIONALLY_CAPPED, an unreadable summary,
 * an unrecognized exportCompleteness value, or a mismatched row count) is
 * blocked with machine-readable reasons. Never mutates its input.
 */
function evaluateExportCompletenessForRoi(
  exportSummary: Record<string, unknown> | null,
  inputValidationTotalRows: number | undefined,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!exportSummary) {
    return { ok: false, reasons: ["export_summary_unreadable"] };
  }

  const completeness = exportSummary.exportCompleteness;
  const isLegacyComplete = completeness === "COMPLETE";
  const isExhaustionComplete = completeness === "COMPLETE_BY_EXHAUSTION";

  if (!isLegacyComplete && !isExhaustionComplete) {
    reasons.push("EXPORT_NOT_COMPLETE");
  }

  if (isExhaustionComplete) {
    if (exportSummary.exportMode !== "FULL_RESOLVED_BY_EXHAUSTION") {
      reasons.push("EXPORT_NOT_COMPLETE");
    }
    if (!VALID_COMPLETION_PROOFS.has(exportSummary.completionProof as string)) {
      reasons.push("EXPORT_COMPLETENESS_PROOF_MISSING");
    }
    if (typeof exportSummary.exportCutoffResolvedAt !== "string" || exportSummary.exportCutoffResolvedAt === "") {
      reasons.push("EXPORT_CUTOFF_MISSING");
    }
  }

  if (exportSummary.exportMode === "DEBUG_CAPPED" || completeness === "INTENTIONALLY_CAPPED") {
    reasons.push("EXPORT_INTENTIONALLY_CAPPED");
  }

  if (exportSummary.missingRows !== 0) {
    reasons.push("missing_rows");
  }

  if (exportSummary.fetchedRows !== inputValidationTotalRows) {
    reasons.push("EXPORT_FETCHED_ROWS_MISMATCH");
  }

  return { ok: reasons.length === 0, reasons };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    fail("--input <path> is required");
  }

  let rows: unknown;
  try {
    const raw = readFileSync(args.input as string, "utf8");
    rows = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(`failed to read/parse --input file: ${message}`);
  }

  if (!Array.isArray(rows)) {
    fail("--input file must contain a JSON array of rows");
  }

  let declarations: StrategyDeclaration[];
  try {
    declarations = loadDeclarations();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(`failed to load strategy declarations: ${message}`);
    return;
  }

  const requiredOnly = args.strategyIds.length > 0 ? false : !args.allReady;

  let inputValidation: GeneratedSignalPairsExportDiagnostics | undefined;
  if (args.inputFormat === "generated_signal_pairs") {
    inputValidation = validateGeneratedSignalPairsExportRows(rows as ExportRow[]);
  }

  let dedupProjection: GeneratedSignalPairsDedupProjection | undefined;
  let comparisonRows = rows as Record<string, unknown>[];
  if (args.dedupPolicy) {
    dedupProjection = projectGeneratedSignalPairsStrictDedup(rows as ExportRow[]);
    comparisonRows = dedupProjection.dedupedRows;
  }

  const { result, selectedRowsByStrategyId } = runStrategyComparisonWithSelectedRows(
    comparisonRows as EvaluatorRow[],
    declarations,
    {
      requiredOnly,
      strategyIds: args.strategyIds.length > 0 ? args.strategyIds : undefined,
    },
  );

  let dqaR4: OutcomeResolutionAuditSummary | undefined;
  if (args.includeDqaR4) {
    dqaR4 = auditOutcomeResolutionConsistency(comparisonRows as OutcomeResolutionAuditRow[]);
  }

  // dedupProjection is exposed as diagnostics only -- dedupedRows (raw row
  // payloads) is never included in CLI output.
  const dedupProjectionDiagnostics = dedupProjection
    ? (({ dedupedRows: _dedupedRows, ...diagnostics }) => diagnostics)(dedupProjection)
    : undefined;

  // Phase 3E.2: gated ROI. All prerequisite flags are enforced in parseArgs,
  // so when includeRoi is set, inputFormat/dedupPolicy/includeDqaR4/exportSummary
  // are all present. ROI is computed only if every gate passes, and only on
  // the selected deduped rows -- never on raw duplicates, never output as raw
  // rows.
  let roiGate: Record<string, unknown> | undefined;
  let strategiesOutput: unknown[] = result.strategies as unknown[];

  if (args.includeRoi) {
    let exportSummary: Record<string, unknown> | null = null;
    try {
      const rawSummary = readFileSync(args.exportSummary as string, "utf8");
      const parsedSummary = JSON.parse(rawSummary);
      if (parsedSummary && typeof parsedSummary === "object" && !Array.isArray(parsedSummary)) {
        exportSummary = parsedSummary as Record<string, unknown>;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      fail(`failed to read/parse --export-summary file: ${message}`);
    }

    const inputTotal = inputValidation ? inputValidation.totalRows : undefined;
    const completenessCheck = evaluateExportCompletenessForRoi(exportSummary, inputTotal);
    const reasons: string[] = [...completenessCheck.reasons];

    if (!dedupProjection) {
      reasons.push("no_dedup_projection");
    } else if (dedupProjection.rowsMissingStrictDedupKey !== 0) {
      reasons.push("rows_missing_strict_dedup_key");
    }
    if (!dqaR4) {
      reasons.push("no_dqa_r4");
    } else if (dqaR4.hasBlockingViolations) {
      reasons.push("dqa_r4_blocking");
    }
    const anySelected = result.strategies.some((s) => s.selectedRows > 0);
    if (!anySelected) {
      reasons.push("no_strategy_selected_rows");
    }

    const status = reasons.length === 0 ? "READY" : "BLOCKED";

    roiGate = {
      requested: true,
      status,
      reasons,
      exportCompleteness: exportSummary ? exportSummary.exportCompleteness : null,
      fetchedRows: exportSummary ? exportSummary.fetchedRows : null,
      inputRows: inputTotal ?? null,
      dedupRows: dedupProjection ? dedupProjection.dedupRows : null,
    };

    if (status === "READY") {
      strategiesOutput = result.strategies.map((summary) => {
        if (summary.error !== null || summary.selectedRows === 0) {
          return summary;
        }
        const selected = selectedRowsByStrategyId[summary.strategyId] ?? [];
        const roi = computeFlatStakeRoiSummary(selected, { strict: true, stakeUnits: 1 });
        return { ...summary, roi };
      });
    }
  }

  const output = {
    ...result,
    strategies: strategiesOutput,
    ...(inputValidation ? { inputValidation } : {}),
    ...(dedupProjectionDiagnostics ? { dedupProjection: dedupProjectionDiagnostics } : {}),
    ...(dqaR4 ? { dqaR4 } : {}),
    ...(roiGate ? { roiGate } : {}),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
