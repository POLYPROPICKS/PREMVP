#!/usr/bin/env -S node --import tsx
// Cohort-preserving formula-lineage comparison (Phase 3E.2j Commit A).
//
// Locked operator decision: the canonical research corpus after strict
// dedup must remain fully retained. formula_version and
// metric_formula_version are lineage/cohort dimensions -- not automatic
// quality filters. Rows outside a given cohort are never described as
// invalid/bad/rejected/removed; they are simply not members of that
// cohort while remaining part of the retained canonical corpus.
//
// This module reuses the existing canonical strict-dedup projection
// (generatedSignalPairsDedupPolicy) and the existing pure ROI calculator
// (roiPnlContract) rather than reimplementing either. It never reads
// fs/env/network, never mutates its input, and never ranks or selects a
// "champion" cohort -- every cohort's roi/pnl summary is descriptive only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  projectGeneratedSignalPairsStrictDedup,
  STRICT_DEDUP_POLICY_NAME,
} from "../../../lib/modeling/generatedSignalPairsDedupPolicy";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";
import {
  computeFlatStakeRoiSummary,
  type FlatStakeRoiSummary,
} from "../../../lib/modeling/roiPnlContract";

export const UNKNOWN_OR_MISSING_COHORT_VALUE = "UNKNOWN_OR_MISSING" as const;

export type CohortDimension = "formula_version" | "metric_formula_version";

export interface FormulaCohortEntry {
  cohortId: string;
  dimension: CohortDimension;
  value: string;
  membershipReason: "formula_lineage";
  qualityVerdict: "NOT_INFERRED_FROM_VERSION";
  rows: number;
  roi: FlatStakeRoiSummary;
}

export interface FormulaCohortComparisonReport {
  schemaVersion: 1;
  canonicalCorpus: {
    dedupPolicy: typeof STRICT_DEDUP_POLICY_NAME;
    sourceRows: number;
    dedupRows: number;
    retainedRows: number;
    droppedForFormulaVersion: number;
  };
  allDedupControl: {
    cohortId: "ALL_DEDUP_ROWS_CONTROL";
    rows: number;
    roi: FlatStakeRoiSummary;
  };
  formulaVersionCohorts: FormulaCohortEntry[];
  metricFormulaVersionCohorts: FormulaCohortEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads only the raw formula_version lineage field (top-level or diagnostics alias). */
function getFormulaVersion(row: ExportRow): string | null {
  const direct =
    (typeof row.formula_version === "string" && row.formula_version.trim() !== ""
      ? row.formula_version.trim()
      : null) ??
    (typeof row.formulaVersion === "string" && (row.formulaVersion as string).trim() !== ""
      ? (row.formulaVersion as string).trim()
      : null);
  if (direct !== null) return direct;
  const diagnostics = row.diagnostics;
  if (isPlainObject(diagnostics)) {
    const value = diagnostics.formulaVersion ?? diagnostics.formula_version;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** Reads only the raw metric_formula_version lineage field -- never merged with formula_version. */
function getMetricFormulaVersion(row: ExportRow): string | null {
  const direct =
    (typeof row.metric_formula_version === "string" && row.metric_formula_version.trim() !== ""
      ? row.metric_formula_version.trim()
      : null) ??
    (typeof row.metricFormulaVersion === "string" && (row.metricFormulaVersion as string).trim() !== ""
      ? (row.metricFormulaVersion as string).trim()
      : null);
  if (direct !== null) return direct;
  const diagnostics = row.diagnostics;
  if (isPlainObject(diagnostics)) {
    const value = diagnostics.metricFormulaVersion;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function buildCohorts(
  rows: readonly ExportRow[],
  dimension: CohortDimension,
  valueOf: (row: ExportRow) => string | null,
): FormulaCohortEntry[] {
  const buckets = new Map<string, ExportRow[]>();
  for (const row of rows) {
    const value = valueOf(row) ?? UNKNOWN_OR_MISSING_COHORT_VALUE;
    const bucket = buckets.get(value) ?? [];
    bucket.push(row);
    buckets.set(value, bucket);
  }
  const entries = Array.from(buckets.entries()).map(([value, bucketRows]) => ({
    cohortId: `${dimension}:${value}`,
    dimension,
    value,
    membershipReason: "formula_lineage" as const,
    qualityVerdict: "NOT_INFERRED_FROM_VERSION" as const,
    rows: bucketRows.length,
    roi: computeFlatStakeRoiSummary(bucketRows, { strict: true, stakeUnits: 1 }),
  }));
  entries.sort((a, b) => (b.rows - a.rows) || a.value.localeCompare(b.value));
  return entries;
}

/**
 * Pure cohort-preserving comparison. Every strict-dedup row is retained
 * (canonicalCorpus.retainedRows === dedupRows, droppedForFormulaVersion is
 * always 0). Cohorts split the retained corpus for descriptive ROI
 * comparison only -- they never remove rows and never rank/select a
 * "champion". No fs/env/network; never mutates `rows`.
 */
export function compareFormulaCohorts(rows: readonly ExportRow[]): FormulaCohortComparisonReport {
  const sourceRows = rows.length;
  const projection = projectGeneratedSignalPairsStrictDedup(rows as ExportRow[]);
  const dedupedRows = projection.dedupedRows;
  const dedupRows = projection.dedupRows;

  const formulaVersionCohorts = buildCohorts(dedupedRows, "formula_version", getFormulaVersion);
  const metricFormulaVersionCohorts = buildCohorts(
    dedupedRows,
    "metric_formula_version",
    getMetricFormulaVersion,
  );

  return {
    schemaVersion: 1,
    canonicalCorpus: {
      dedupPolicy: STRICT_DEDUP_POLICY_NAME,
      sourceRows,
      dedupRows,
      retainedRows: dedupRows,
      droppedForFormulaVersion: 0,
    },
    allDedupControl: {
      cohortId: "ALL_DEDUP_ROWS_CONTROL",
      rows: dedupedRows.length,
      roi: computeFlatStakeRoiSummary(dedupedRows, { strict: true, stakeUnits: 1 }),
    },
    formulaVersionCohorts,
    metricFormulaVersionCohorts,
  };
}

// ---- CLI ----

const DEFAULT_INPUT_PATH = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_OUTPUT_PATH = path.join(
  "modeling",
  "local_exports",
  "generated_signal_pairs_formula_cohort_comparison.json",
);

interface ParsedArgs {
  input: string;
  output: string;
  exportSummary: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { input: DEFAULT_INPUT_PATH, output: DEFAULT_OUTPUT_PATH, exportSummary: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = argv[i + 1] ?? DEFAULT_INPUT_PATH;
      i += 1;
    } else if (arg === "--output") {
      args.output = argv[i + 1] ?? DEFAULT_OUTPUT_PATH;
      i += 1;
    } else if (arg === "--export-summary") {
      args.exportSummary = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let rows: unknown;
  try {
    rows = JSON.parse(readFileSync(args.input, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(`failed to read/parse --input file: ${message}`);
  }
  if (!Array.isArray(rows)) {
    fail("--input file must contain a JSON array of rows");
  }

  const report = compareFormulaCohorts(rows as ExportRow[]);

  try {
    const dir = path.dirname(args.output);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(`failed to write --output file: ${message}`);
  }

  process.stdout.write(`Wrote formula cohort comparison to ${args.output}\n`);
}

if (require.main === module) {
  main();
}
