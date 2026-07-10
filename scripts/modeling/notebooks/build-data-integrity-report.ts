#!/usr/bin/env -S node --import tsx
// Phase 3D.2R -- Data Integrity Notebook/report CLI.
//
// Read-only founder review surface. Reads the two already-generated
// canonical local JSON exports (corpus audit + formula cohort
// comparison), validates the cross-artifact contract, and writes a
// deterministic HTML report. Never queries Supabase, never reads
// SUPABASE_* env values, never recomputes dedup/ROI, never writes
// outside --output.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CorpusAuditReport } from "../strategies/audit-generated-signal-pairs-corpus";
import type { FormulaCohortComparisonReport } from "../strategies/compare-formula-cohorts";
import {
  buildDataIntegrityReportModel,
  DataIntegrityContractError,
  DATA_INTEGRITY_REPORT_PHASE,
  parseCanonicalReportJson,
  renderDataIntegrityHtml,
  validateDataIntegrityContract,
} from "../../../lib/modeling/dataIntegrityReport";

const DEFAULT_CORPUS_AUDIT_INPUT = path.join(
  "modeling",
  "local_exports",
  "generated_signal_pairs_corpus_audit.json",
);
const DEFAULT_FORMULA_COHORT_INPUT = path.join(
  "modeling",
  "local_exports",
  "generated_signal_pairs_formula_cohort_comparison.json",
);
const DEFAULT_OUTPUT_PATH = path.join("modeling", "local_exports", "data_integrity_3d2r.html");

interface ParsedArgs {
  corpusAuditInput: string;
  formulaCohortInput: string;
  output: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    corpusAuditInput: DEFAULT_CORPUS_AUDIT_INPUT,
    formulaCohortInput: DEFAULT_FORMULA_COHORT_INPUT,
    output: DEFAULT_OUTPUT_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--corpus-audit-input") {
      args.corpusAuditInput = argv[i + 1] ?? DEFAULT_CORPUS_AUDIT_INPUT;
      i += 1;
    } else if (arg === "--formula-cohort-input") {
      args.formulaCohortInput = argv[i + 1] ?? DEFAULT_FORMULA_COHORT_INPUT;
      i += 1;
    } else if (arg === "--output") {
      args.output = argv[i + 1] ?? DEFAULT_OUTPUT_PATH;
      i += 1;
    }
  }
  return args;
}

function logContractError(error: DataIntegrityContractError): void {
  process.stderr.write(
    `${JSON.stringify(
      {
        phase: DATA_INTEGRITY_REPORT_PHASE,
        inputArtifactPath: error.inputArtifactPath,
        contractField: error.contractField,
        expected: error.expected,
        actual: error.actual,
        message: error.message,
      },
      null,
      2,
    )}\n`,
  );
}

function readRequiredInput(inputPath: string): string {
  if (!existsSync(inputPath)) {
    logContractError(
      new DataIntegrityContractError({
        message: `required canonical input is missing: ${inputPath}`,
        inputArtifactPath: inputPath,
        contractField: "file_exists",
        expected: true,
        actual: false,
      }),
    );
    process.exit(1);
  }
  return readFileSync(inputPath, "utf8");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const corpusAuditRaw = readRequiredInput(args.corpusAuditInput);
  const formulaCohortRaw = readRequiredInput(args.formulaCohortInput);

  let corpusAudit: CorpusAuditReport;
  let formulaCohort: FormulaCohortComparisonReport;
  try {
    corpusAudit = parseCanonicalReportJson<CorpusAuditReport>(corpusAuditRaw, args.corpusAuditInput);
    formulaCohort = parseCanonicalReportJson<FormulaCohortComparisonReport>(
      formulaCohortRaw,
      args.formulaCohortInput,
    );
  } catch (error) {
    if (error instanceof DataIntegrityContractError) {
      logContractError(error);
      process.exit(1);
    }
    throw error;
  }

  const violations = validateDataIntegrityContract({
    corpusAuditPath: args.corpusAuditInput,
    corpusAudit,
    formulaCohortPath: args.formulaCohortInput,
    formulaCohort,
  });
  if (violations.length > 0) {
    for (const violation of violations) logContractError(violation);
    process.exit(1);
  }

  const model = buildDataIntegrityReportModel({
    corpusAuditPath: args.corpusAuditInput,
    corpusAudit,
    formulaCohortPath: args.formulaCohortInput,
    formulaCohort,
  });
  const html = renderDataIntegrityHtml(model);

  const dir = path.dirname(args.output);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(args.output, html, "utf8");

  process.stdout.write(`Wrote data integrity report to ${args.output}\n`);
}

if (require.main === module) {
  main();
}
