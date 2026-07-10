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
import { runStrategyComparison } from "../../../lib/modeling/strategyComparison";
import type { StrategyDeclaration } from "../../../lib/modeling/strategyEvaluator";
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
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    input: null,
    allReady: false,
    strategyIds: [],
    inputFormat: "loose",
    includeDqaR4: false,
    dedupPolicy: null,
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

  const result = runStrategyComparison(comparisonRows, declarations, {
    requiredOnly,
    strategyIds: args.strategyIds.length > 0 ? args.strategyIds : undefined,
  });

  let dqaR4: OutcomeResolutionAuditSummary | undefined;
  if (args.includeDqaR4) {
    dqaR4 = auditOutcomeResolutionConsistency(comparisonRows as OutcomeResolutionAuditRow[]);
  }

  // dedupProjection is exposed as diagnostics only -- dedupedRows (raw row
  // payloads) is never included in CLI output.
  const dedupProjectionDiagnostics = dedupProjection
    ? (({ dedupedRows: _dedupedRows, ...diagnostics }) => diagnostics)(dedupProjection)
    : undefined;

  const output = {
    ...result,
    ...(inputValidation ? { inputValidation } : {}),
    ...(dedupProjectionDiagnostics ? { dedupProjection: dedupProjectionDiagnostics } : {}),
    ...(dqaR4 ? { dqaR4 } : {}),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
