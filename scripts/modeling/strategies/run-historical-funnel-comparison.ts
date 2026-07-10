#!/usr/bin/env -S node --import tsx
// Real runner for the historical funnel comparison (Phase 3E.5).
//
// Reads ONLY local files: a row-level canonical strict-dedup corpus and the
// executable funnel classifier. Validates both, SHA-256 hashes both, runs the
// deterministic comparison engine, and writes a comparison JSON plus a
// reproducible run manifest. Never reads env vars, never imports Supabase,
// never touches the network. Fails non-zero with a concise, secret-free error.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  compareHistoricalFunnelVariants,
  LOCKED_EXECUTION_SET,
  COMPARISON_ENGINE_VERSION,
} from "../../../lib/modeling/historicalFunnelComparison";
import {
  loadExecutableFunnelClassifier,
  validateExecutableFunnelClassifier,
  type ExecutableFunnelClassifier,
} from "../../../lib/modeling/executableFunnelClassifier";
import {
  buildEvaluationRunManifest,
  type ManifestInputs,
  type SkippedVariantRecord,
} from "../../../lib/modeling/evaluationRunManifest";

// Requested set = locked execution set plus the excluded ids (so nothing
// silently disappears from the visible result and manifest).
const DEFAULT_REQUESTED: readonly string[] = [
  ...LOCKED_EXECUTION_SET,
  "MODEL_A",
  "ALT1_PY_EVENT_KEY_VARIANT",
  "ALT1_ONE_PER_EVENT_BEST_COVERAGE",
  "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH",
  "ALT3_V1_AVOID_NBA_NHL",
  "CHAMPION_CURRENT",
  "PUBLISHED_ONE_PER_FIXTURE",
  "FIRE_FAMILY_SELECTIVE",
  "SAFETY_BASELINE",
  "TIERED_LIVE_CONTOUR",
  "FIRE_MODEL_1_LOCKED",
];

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_CLASSIFIER = path.join("modeling", "model_registry", "executable_funnel_classifier.json");
const DEFAULT_OUTPUT = path.join("modeling", "local_exports", "historical_funnel_comparison.json");
const DEFAULT_MANIFEST = path.join("modeling", "local_exports", "historical_funnel_comparison_manifest.json");

export interface RowLevelValidation {
  ok: boolean;
  reason?: string;
  rows?: Record<string, unknown>[];
}

/**
 * Guards against a corpus-audit SUMMARY object being passed where a
 * row-level array is required. A real corpus is a non-empty array of row
 * objects carrying at least an identity + a resolved_at-style field; an audit
 * summary is a single object with schemaVersion/dedupRows/breakdown keys.
 */
export function validateRowLevelInput(parsed: unknown): RowLevelValidation {
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "input is not a row-level array (looks like a summary object, not corpus rows)" };
  }
  if (parsed.length === 0) {
    return { ok: false, reason: "input row-level array is empty" };
  }
  const first = parsed[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return { ok: false, reason: "input array elements are not row objects" };
  }
  const keys = Object.keys(first as Record<string, unknown>);
  const looksLikeRow = keys.includes("condition_id") || keys.includes("signal_confidence_num") || keys.includes("resolved_at");
  if (!looksLikeRow) {
    return { ok: false, reason: "input array elements do not look like generated_signal_pairs rows" };
  }
  return { ok: true, rows: parsed as Record<string, unknown>[] };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readGit(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

interface ParsedArgs {
  input: string;
  classifier: string;
  output: string;
  manifest: string;
  variants: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    input: DEFAULT_INPUT,
    classifier: DEFAULT_CLASSIFIER,
    output: DEFAULT_OUTPUT,
    manifest: DEFAULT_MANIFEST,
    variants: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") { args.input = argv[++i] ?? args.input; }
    else if (arg === "--classifier") { args.classifier = argv[++i] ?? args.classifier; }
    else if (arg === "--output") { args.output = argv[++i] ?? args.output; }
    else if (arg === "--manifest") { args.manifest = argv[++i] ?? args.manifest; }
    else if (arg === "--variant") { const v = argv[++i]; if (v) args.variants.push(v); }
  }
  return args;
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

function safeWrite(outPath: string, content: string): void {
  const dir = path.dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  writeFileSync(outPath, content, "utf8");
  try { require("node:fs").rmSync(tmp, { force: true }); } catch { /* best effort */ }
}

/**
 * CLI entry point returning a process exit code (0 = success). `log` defaults
 * to stderr; injectable for tests. Never throws to the caller -- all failures
 * become a non-zero return with a concise, secret-free message.
 */
export function runHistoricalFunnelComparisonCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  const args = parseArgs(argv);
  try {
    ensureFile(args.input, "input artifact");
    ensureFile(args.classifier, "classifier");

    const inputRaw = readFileSync(args.input, "utf8");
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(inputRaw);
    } catch {
      throw new Error(`input artifact is not valid JSON: ${args.input}`);
    }
    const rowCheck = validateRowLevelInput(parsedInput);
    if (!rowCheck.ok) {
      throw new Error(`input validation failed (${args.input}): ${rowCheck.reason}`);
    }
    const rows = rowCheck.rows!;

    const classifierRaw = readFileSync(args.classifier, "utf8");
    let classifier: ExecutableFunnelClassifier;
    try {
      classifier = JSON.parse(classifierRaw) as ExecutableFunnelClassifier;
      validateExecutableFunnelClassifier(classifier);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      throw new Error(`classifier validation failed (${args.classifier}): ${reason}`);
    }

    const requested = args.variants.length > 0 ? args.variants : [...DEFAULT_REQUESTED];
    const comparison = compareHistoricalFunnelVariants({ rows, classifier, requestedVariantIds: requested });

    const inputSha = sha256(inputRaw);
    const classifierSha = sha256(classifierRaw);

    const skipped: SkippedVariantRecord[] = comparison.executions
      .filter((e) => e.evaluationStatus !== "EXECUTED")
      .map((e) => ({ variantId: e.variantId, reason: e.evaluationStatus }));
    const executed = comparison.executions
      .filter((e) => e.evaluationStatus === "EXECUTED")
      .map((e) => e.variantId);

    const manifestInputs: ManifestInputs = {
      gitCommit: readGit(["rev-parse", "HEAD"]),
      gitBranch: readGit(["rev-parse", "--abbrev-ref", "HEAD"]),
      inputArtifactPath: args.input,
      inputSha256: inputSha,
      inputRowCount: rows.length,
      inputFirstResolvedAt: comparison.corpus.firstResolvedAt,
      inputLastResolvedAt: comparison.corpus.lastResolvedAt,
      dedupPolicy: "strict_latest_created_before_resolved",
      classifierPath: args.classifier,
      classifierSha256: classifierSha,
      classifierSchemaVersion: classifier.schemaVersion,
      comparisonEngineVersion: COMPARISON_ENGINE_VERSION,
      requestedVariantIds: requested,
      executedVariantIds: executed,
      skippedVariantsAndReasons: skipped,
      normalizedStakePolicy: { unit: "FLAT_1_UNIT", plainLanguage: "Канонический ROI: 1 единица на ставку." },
      roiContractSource: "lib/modeling/roiPnlContract.ts",
      eventIdentityPolicy: "MEDIUM event_slug grouping allowed for exploratory evaluation only; not sufficient for production promotion.",
      knownLimitations: [
        "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP is RUNNABLE_APPROX_ONLY (source self-labelled APPROX).",
        "ALT1_CANONICAL_EVENT_GROUPING is exploratory MEDIUM event identity, not production-ready.",
        "ALT1_PY_EVENT_KEY_VARIANT requires event_key, absent from the 27-column canonical export.",
      ],
      commands: [
        `node --import tsx scripts/modeling/strategies/run-historical-funnel-comparison.ts --input ${args.input} --classifier ${args.classifier} --output ${args.output} --manifest ${args.manifest}`,
      ],
      createdAt: new Date().toISOString(),
    };
    const manifest = buildEvaluationRunManifest(manifestInputs);

    // The comparison JSON carries its own input hash so a scorecard can prove
    // comparison and manifest reference the same corpus.
    const comparisonWithHash = { ...comparison, inputSha256: inputSha, classifierSha256: classifierSha };

    safeWrite(args.output, `${JSON.stringify(comparisonWithHash, null, 2)}\n`);
    safeWrite(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

    log(`Wrote comparison to ${args.output}\nWrote manifest to ${args.manifest}\nrunId: ${manifest.runId}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Error: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runHistoricalFunnelComparisonCli(process.argv.slice(2)));
}
