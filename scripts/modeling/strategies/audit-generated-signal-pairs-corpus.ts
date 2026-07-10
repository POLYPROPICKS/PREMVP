#!/usr/bin/env -S node --import tsx
// Read-only, deterministic corpus + formula-cohort audit for a local
// generated_signal_pairs export (Phase 3E.2i).
//
// Answers the model-review questions the operator needs before any ROI
// interpretation, entirely from the existing local export -- no Supabase
// query, no DB write, no ROI/PnL computation:
//   - date coverage of raw vs strict-deduped signals;
//   - date coverage + selected/rejected split of the trusted-formula cohort;
//   - formula-version and metric-formula-version breakdowns;
//   - market / sporting-event / strict-signal cardinality (a match with two
//     markets is ONE event but TWO distinct strict market/outcome signals);
//   - signals-per-event distribution.
//
// The pure function `auditGeneratedSignalPairsCorpus` reuses the existing
// canonical helpers -- strict dedup projection
// (generatedSignalPairsDedupPolicy), strict dedup key + formula-version
// extraction (generatedSignalPairsExportContract), and the event-group
// fallback chain (eventGroupSelection) -- rather than re-implementing any
// business logic. It never reads fs/env/network and never mutates its
// input. The CLI section (guarded by require.main === module) reads the
// input export file and writes the report.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  projectGeneratedSignalPairsStrictDedup,
  STRICT_DEDUP_POLICY_NAME,
} from "../../../lib/modeling/generatedSignalPairsDedupPolicy";
import {
  getFormulaVersionForExportRow,
  getStrictDedupKeyForExportRow,
  type ExportRow,
} from "../../../lib/modeling/generatedSignalPairsExportContract";
import {
  buildEventGroupKey,
  EVENT_GROUP_KEY_FIELD_PRIORITY,
} from "../../../lib/modeling/eventGroupSelection";

const MISSING_VERSION_BUCKET = "(none)";

// ---- Event-identity evidence gate (Phase 3E.2j Commit B) ----
//
// Strict market/outcome dedup (condition_id + token_id) is never altered
// by this section. A match with two markets (e.g. moneyline and
// total-goals) remains two strict signals and two markets -- it is only
// treated as one sporting event when the identity evidence below actually
// supports it. Confidence is classified from which field-priority tier
// supplied the identity, mirroring the same 7-field fallback chain and
// alias set already established in eventGroupSelection.ts /
// generatedSignalPairsExportContract.ts (EVENT_GROUP_CANDIDATE_FIELDS):
// match_family_key > canonical_event_key > parent_event_key (STRONG),
// event_slug > event_title (MEDIUM), market_slug > condition_id (WEAK).
// Only alias field names already confirmed present in those two files are
// read here -- no speculative diagnostics alias is invented.

export type EventIdentitySourceField =
  | "match_family_key"
  | "canonical_event_key"
  | "parent_event_key"
  | "event_slug"
  | "event_title"
  | "market_slug"
  | "condition_id"
  | null;

export type EventIdentitySourceLocation = "top_level" | "diagnostics" | null;

export type EventIdentityConfidenceClass = "STRONG" | "MEDIUM" | "WEAK" | "MISSING" | "CONFLICT";

export interface EventIdentityCandidate {
  field: EventIdentitySourceField;
  value: string;
  location: "top_level" | "diagnostics";
}

export interface EventIdentityEvidence {
  eventKey: string | null;
  sourceField: EventIdentitySourceField;
  sourceLocation: EventIdentitySourceLocation;
  confidenceClass: EventIdentityConfidenceClass;
  candidates: EventIdentityCandidate[];
}

interface IdentityFieldSpec {
  field: EventIdentitySourceField;
  topLevelKeys: string[];
  diagnosticsKeys: string[];
  keyPrefix: string;
}

const STRONG_FIELD_SPECS: IdentityFieldSpec[] = [
  { field: "match_family_key", topLevelKeys: ["match_family_key"], diagnosticsKeys: ["matchFamilyKey"], keyPrefix: "match" },
  { field: "canonical_event_key", topLevelKeys: ["canonical_event_key"], diagnosticsKeys: ["canonicalEventKey"], keyPrefix: "canonical" },
  { field: "parent_event_key", topLevelKeys: ["parent_event_key"], diagnosticsKeys: ["parentEventKey"], keyPrefix: "parent" },
];

const MEDIUM_FIELD_SPECS: IdentityFieldSpec[] = [
  { field: "event_slug", topLevelKeys: ["event_slug"], diagnosticsKeys: ["eventSlug"], keyPrefix: "slug" },
  { field: "event_title", topLevelKeys: ["event_title"], diagnosticsKeys: ["eventTitle"], keyPrefix: "title" },
];

const WEAK_FIELD_SPECS: IdentityFieldSpec[] = [
  { field: "market_slug", topLevelKeys: ["market_slug"], diagnosticsKeys: ["marketSlug"], keyPrefix: "market" },
  { field: "condition_id", topLevelKeys: ["condition_id"], diagnosticsKeys: ["conditionId"], keyPrefix: "condition" },
];

function identityNormalizeText(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readIdentityField(
  row: Record<string, unknown>,
  spec: IdentityFieldSpec,
): { value: string; location: "top_level" | "diagnostics" } | null {
  for (const key of spec.topLevelKeys) {
    const value = row[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim() !== "") {
      return { value: String(value).trim(), location: "top_level" };
    }
  }
  const diagnostics = row.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    const obj = diagnostics as Record<string, unknown>;
    for (const key of spec.diagnosticsKeys) {
      const value = obj[key];
      if ((typeof value === "string" || typeof value === "number") && String(value).trim() !== "") {
        return { value: String(value).trim(), location: "diagnostics" };
      }
    }
  }
  return null;
}

function resolveTierEvidence(
  row: Record<string, unknown>,
  specs: IdentityFieldSpec[],
  confidenceClass: "STRONG" | "MEDIUM" | "WEAK",
  candidates: EventIdentityCandidate[],
): { evidence: Partial<EventIdentityEvidence>; present: boolean } {
  const found: Array<{ spec: IdentityFieldSpec; value: string; location: "top_level" | "diagnostics" }> = [];
  for (const spec of specs) {
    const result = readIdentityField(row, spec);
    if (result !== null) {
      candidates.push({ field: spec.field, value: result.value, location: result.location });
      found.push({ spec, value: result.value, location: result.location });
    }
  }
  if (found.length === 0) {
    return { evidence: {}, present: false };
  }
  const distinctNormalized = new Set(found.map((f) => identityNormalizeText(f.value)));
  if (distinctNormalized.size > 1) {
    return {
      evidence: { eventKey: null, sourceField: null, sourceLocation: null, confidenceClass: "CONFLICT" },
      present: true,
    };
  }
  const winner = found[0];
  return {
    evidence: {
      eventKey: `${winner.spec.keyPrefix}:${identityNormalizeText(winner.value)}`,
      sourceField: winner.spec.field,
      sourceLocation: winner.location,
      confidenceClass,
    },
    present: true,
  };
}

/**
 * Extracts structured event-identity evidence for a single row: which
 * field supplied the identity, at what confidence tier, from where
 * (top-level vs diagnostics), plus every raw candidate found -- so a
 * caller can see a CONFLICT rather than have one silently hidden. Never
 * mutates its input, no fs/env/network, deterministic.
 */
export function extractEventIdentityEvidence(row: Record<string, unknown>): EventIdentityEvidence {
  const candidates: EventIdentityCandidate[] = [];

  const strong = resolveTierEvidence(row, STRONG_FIELD_SPECS, "STRONG", candidates);
  if (strong.present) {
    return { candidates, ...strong.evidence } as EventIdentityEvidence;
  }

  const medium = resolveTierEvidence(row, MEDIUM_FIELD_SPECS, "MEDIUM", candidates);
  if (medium.present) {
    return { candidates, ...medium.evidence } as EventIdentityEvidence;
  }

  const weak = resolveTierEvidence(row, WEAK_FIELD_SPECS, "WEAK", candidates);
  if (weak.present) {
    return { candidates, ...weak.evidence } as EventIdentityEvidence;
  }

  return { eventKey: null, sourceField: null, sourceLocation: null, confidenceClass: "MISSING", candidates };
}

export interface EventIdentityEvidenceSummary {
  rowsByConfidenceClass: Record<EventIdentityConfidenceClass, number>;
  rowsBySourceField: Record<string, number>;
  rowsBySourceLocation: Record<string, number>;
  conflictRows: number;
  identityReadyRows: number;
  workingEventCount: number;
  strongIdentityEventCount: number;
  mediumOrBetterEventCount: number;
  weakFallbackEventCount: number;
  oneEventComparatorReady: false;
  status: "NEEDS_FOUNDER_POLICY";
  blockingReasons: string[];
}

/**
 * Aggregates per-row identity evidence into corpus-level counts. Does not
 * invent a readiness threshold: `oneEventComparatorReady` is always
 * `false` with `status: "NEEDS_FOUNDER_POLICY"` unless/until an existing
 * project contract defines one -- none currently exists in this repo.
 */
export function buildEventIdentityEvidenceSummary(
  evidences: readonly EventIdentityEvidence[],
): EventIdentityEvidenceSummary {
  const rowsByConfidenceClass: Record<EventIdentityConfidenceClass, number> = {
    STRONG: 0,
    MEDIUM: 0,
    WEAK: 0,
    MISSING: 0,
    CONFLICT: 0,
  };
  const rowsBySourceField: Record<string, number> = {};
  const rowsBySourceLocation: Record<string, number> = {};
  const strongEventKeys = new Set<string>();
  const mediumOrBetterEventKeys = new Set<string>();
  const weakEventKeys = new Set<string>();

  for (const evidence of evidences) {
    rowsByConfidenceClass[evidence.confidenceClass] += 1;
    const fieldBucket = evidence.sourceField ?? MISSING_VERSION_BUCKET;
    rowsBySourceField[fieldBucket] = (rowsBySourceField[fieldBucket] ?? 0) + 1;
    const locationBucket = evidence.sourceLocation ?? MISSING_VERSION_BUCKET;
    rowsBySourceLocation[locationBucket] = (rowsBySourceLocation[locationBucket] ?? 0) + 1;

    if (evidence.confidenceClass === "STRONG" && evidence.eventKey !== null) {
      strongEventKeys.add(evidence.eventKey);
      mediumOrBetterEventKeys.add(evidence.eventKey);
    } else if (evidence.confidenceClass === "MEDIUM" && evidence.eventKey !== null) {
      mediumOrBetterEventKeys.add(evidence.eventKey);
    } else if (evidence.confidenceClass === "WEAK" && evidence.eventKey !== null) {
      weakEventKeys.add(evidence.eventKey);
    }
  }

  const identityReadyRows = rowsByConfidenceClass.STRONG + rowsByConfidenceClass.MEDIUM;
  const workingEventCount = mediumOrBetterEventKeys.size + weakEventKeys.size;

  return {
    rowsByConfidenceClass,
    rowsBySourceField,
    rowsBySourceLocation,
    conflictRows: rowsByConfidenceClass.CONFLICT,
    identityReadyRows,
    workingEventCount,
    strongIdentityEventCount: strongEventKeys.size,
    mediumOrBetterEventCount: mediumOrBetterEventKeys.size,
    weakFallbackEventCount: weakEventKeys.size,
    oneEventComparatorReady: false,
    status: "NEEDS_FOUNDER_POLICY",
    blockingReasons: ["no_project_defined_readiness_threshold"],
  };
}

export interface CoverageSummary {
  minResolvedAt: string | null;
  maxResolvedAt: string | null;
  calendarDaysInclusive: number;
  rowsWithInvalidOrMissingResolvedAt: number;
}

export interface FormulaVersionBreakdownEntry {
  formulaVersion: string;
  rows: number;
  pctOfDedupRows: number;
  minResolvedAt: string | null;
  maxResolvedAt: string | null;
}

export interface CorpusAuditReport {
  schemaVersion: 1;
  sourceRows: number;
  dedupPolicy: typeof STRICT_DEDUP_POLICY_NAME;
  dedupRows: number;
  droppedDuplicateRows: number;
  rawCoverage: CoverageSummary;
  dedupCoverage: CoverageSummary;
  trustedFormula: {
    formulaVersion: string;
    selectedRows: number;
    rejectedRows: number;
    minResolvedAt: string | null;
    maxResolvedAt: string | null;
    calendarDaysInclusive: number;
    rowsWithInvalidOrMissingResolvedAt: number;
  };
  formulaVersionBreakdown: FormulaVersionBreakdownEntry[];
  metricFormulaVersionBreakdown: FormulaVersionBreakdownEntry[];
  cardinality: {
    uniqueStrictMarketOutcomeSignals: number;
    uniqueMarkets: number;
    uniqueSportingEvents: number;
    rowsMissingMarketIdentity: number;
    rowsMissingEventIdentity: number;
  };
  signalsPerSportingEvent: {
    eventCount: number;
    min: number;
    median: number;
    p75: number;
    p90: number;
    max: number;
    eventsWithMoreThanOneSignal: number;
  };
  eventGrouping: {
    priority: string[];
    fallbackUsage: Record<string, number>;
  };
  eventIdentityEvidence: EventIdentityEvidenceSummary;
}

export interface AuditOptions {
  trustedFormulaVersion: string;
}

function getValidMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function getResolvedAtString(row: ExportRow): string | null {
  const value = row.resolved_at;
  return typeof value === "string" && getValidMs(value) !== null ? value : null;
}

/** Inclusive count of distinct UTC calendar days spanned by [minMs, maxMs]. */
function calendarDaysInclusive(minMs: number | null, maxMs: number | null): number {
  if (minMs === null || maxMs === null) return 0;
  const dayMs = 86400000;
  const minDay = Math.floor(minMs / dayMs);
  const maxDay = Math.floor(maxMs / dayMs);
  return maxDay - minDay + 1;
}

function summarizeCoverage(rows: readonly ExportRow[]): CoverageSummary {
  let minMs: number | null = null;
  let maxMs: number | null = null;
  let minStr: string | null = null;
  let maxStr: string | null = null;
  let invalid = 0;
  for (const row of rows) {
    const raw = typeof row.resolved_at === "string" ? row.resolved_at : "";
    const ms = getValidMs(raw);
    if (ms === null) {
      invalid += 1;
      continue;
    }
    if (minMs === null || ms < minMs) {
      minMs = ms;
      minStr = raw;
    }
    if (maxMs === null || ms > maxMs) {
      maxMs = ms;
      maxStr = raw;
    }
  }
  return {
    minResolvedAt: minStr,
    maxResolvedAt: maxStr,
    calendarDaysInclusive: calendarDaysInclusive(minMs, maxMs),
    rowsWithInvalidOrMissingResolvedAt: invalid,
  };
}

/**
 * Groups rows by a version key (extracted via `versionOf`), producing a
 * per-version count, percentage of the deduped corpus, and resolved-at
 * coverage. Deterministic sort: rows descending, then version name
 * ascending. Rows with no version go to the "(none)" bucket.
 */
function buildVersionBreakdown(
  rows: readonly ExportRow[],
  dedupRows: number,
  versionOf: (row: ExportRow) => string | null,
): FormulaVersionBreakdownEntry[] {
  const buckets = new Map<string, { rows: ExportRow[]; count: number }>();
  for (const row of rows) {
    const version = versionOf(row) ?? MISSING_VERSION_BUCKET;
    const bucket = buckets.get(version) ?? { rows: [], count: 0 };
    bucket.rows.push(row);
    bucket.count += 1;
    buckets.set(version, bucket);
  }
  const entries = Array.from(buckets.entries()).map(([formulaVersion, bucket]) => {
    const coverage = summarizeCoverage(bucket.rows);
    return {
      formulaVersion,
      rows: bucket.count,
      pctOfDedupRows: dedupRows > 0 ? (bucket.count / dedupRows) * 100 : 0,
      minResolvedAt: coverage.minResolvedAt,
      maxResolvedAt: coverage.maxResolvedAt,
    };
  });
  entries.sort((a, b) => (b.rows - a.rows) || a.formulaVersion.localeCompare(b.formulaVersion));
  return entries;
}

/** Reads only the raw metric_formula_version lineage (never merged with formula_version). */
function getMetricFormulaVersion(row: ExportRow): string | null {
  const direct =
    (typeof row.metric_formula_version === "string" && row.metric_formula_version.trim() !== ""
      ? row.metric_formula_version.trim()
      : null) ??
    (typeof row.metricFormulaVersion === "string" && row.metricFormulaVersion.trim() !== ""
      ? (row.metricFormulaVersion as string).trim()
      : null);
  if (direct !== null) return direct;
  const diagnostics = row.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    const value = (diagnostics as Record<string, unknown>).metricFormulaVersion;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function getConditionId(row: ExportRow): string | null {
  for (const key of ["condition_id", "conditionId"]) {
    const value = row[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

/**
 * Deterministic nearest-rank percentile over an ascending-sorted numeric
 * array: index = clamp(ceil(p/100 * n) - 1, 0, n-1). Median is p = 50.
 */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[idx];
}

/**
 * Pure corpus + formula-cohort audit. Reuses the canonical strict-dedup
 * projection, strict dedup key / formula-version extraction, and event-group
 * fallback chain. No fs/env/network; never mutates `rows`.
 */
export function auditGeneratedSignalPairsCorpus(
  rows: readonly ExportRow[],
  options: AuditOptions,
): CorpusAuditReport {
  const sourceRows = rows.length;
  const projection = projectGeneratedSignalPairsStrictDedup(rows as ExportRow[]);
  const dedupedRows = projection.dedupedRows;
  const dedupRows = projection.dedupRows;

  const rawCoverage = summarizeCoverage(rows);
  const dedupCoverage = summarizeCoverage(dedupedRows);

  // Trusted cohort uses the strategy's effective formula-version matcher
  // (getFormulaVersionForExportRow), which is exactly what
  // FORMULA_TRUSTED_INITIAL_V1_1_ALL selects on.
  const trustedRows = dedupedRows.filter(
    (row) => getFormulaVersionForExportRow(row) === options.trustedFormulaVersion,
  );
  const trustedCoverage = summarizeCoverage(trustedRows);

  // Breakdowns keep the two lineage fields distinct: the primary breakdown
  // uses the effective formula-version matcher; the metric breakdown reads
  // only the raw metric_formula_version field.
  const formulaVersionBreakdown = buildVersionBreakdown(dedupedRows, dedupRows, getFormulaVersionForExportRow);
  const metricFormulaVersionBreakdown = buildVersionBreakdown(dedupedRows, dedupRows, getMetricFormulaVersion);

  // Cardinality over deduped rows.
  const strictSignalKeys = new Set<string>();
  const marketIds = new Set<string>();
  const eventKeys = new Set<string>();
  let rowsMissingMarketIdentity = 0;
  let rowsMissingEventIdentity = 0;
  const eventSignalCounts = new Map<string, number>();
  const fallbackUsage: Record<string, number> = {};

  for (const row of dedupedRows) {
    const strictKey = getStrictDedupKeyForExportRow(row);
    if (strictKey !== null) strictSignalKeys.add(strictKey);

    const conditionId = getConditionId(row);
    if (conditionId === null) {
      rowsMissingMarketIdentity += 1;
    } else {
      marketIds.add(conditionId);
    }

    const eventGroup = buildEventGroupKey(row);
    fallbackUsage[eventGroup.source] = (fallbackUsage[eventGroup.source] ?? 0) + 1;
    // An event key that collapses to the empty condition fallback
    // ("condition:") means the row has no usable event identity at all.
    if (eventGroup.key === "condition:") {
      rowsMissingEventIdentity += 1;
    }
    eventKeys.add(eventGroup.key);
    eventSignalCounts.set(eventGroup.key, (eventSignalCounts.get(eventGroup.key) ?? 0) + 1);
  }

  const perEventCounts = Array.from(eventSignalCounts.values()).sort((a, b) => a - b);
  const eventsWithMoreThanOneSignal = perEventCounts.filter((c) => c > 1).length;

  const identityEvidences = dedupedRows.map((row) => extractEventIdentityEvidence(row as Record<string, unknown>));
  const eventIdentityEvidence = buildEventIdentityEvidenceSummary(identityEvidences);

  return {
    schemaVersion: 1,
    sourceRows,
    dedupPolicy: STRICT_DEDUP_POLICY_NAME,
    dedupRows,
    droppedDuplicateRows: projection.droppedDuplicateRows,
    rawCoverage,
    dedupCoverage,
    trustedFormula: {
      formulaVersion: options.trustedFormulaVersion,
      selectedRows: trustedRows.length,
      rejectedRows: dedupRows - trustedRows.length,
      minResolvedAt: trustedCoverage.minResolvedAt,
      maxResolvedAt: trustedCoverage.maxResolvedAt,
      calendarDaysInclusive: trustedCoverage.calendarDaysInclusive,
      rowsWithInvalidOrMissingResolvedAt: trustedCoverage.rowsWithInvalidOrMissingResolvedAt,
    },
    formulaVersionBreakdown,
    metricFormulaVersionBreakdown,
    cardinality: {
      uniqueStrictMarketOutcomeSignals: strictSignalKeys.size,
      uniqueMarkets: marketIds.size,
      uniqueSportingEvents: eventKeys.size,
      rowsMissingMarketIdentity,
      rowsMissingEventIdentity,
    },
    signalsPerSportingEvent: {
      eventCount: perEventCounts.length,
      min: perEventCounts.length > 0 ? perEventCounts[0] : 0,
      median: percentile(perEventCounts, 50),
      p75: percentile(perEventCounts, 75),
      p90: percentile(perEventCounts, 90),
      max: perEventCounts.length > 0 ? perEventCounts[perEventCounts.length - 1] : 0,
      eventsWithMoreThanOneSignal,
    },
    eventGrouping: {
      priority: [...EVENT_GROUP_KEY_FIELD_PRIORITY],
      fallbackUsage,
    },
    eventIdentityEvidence,
  };
}

// ---- CLI ----

const DEFAULT_INPUT_PATH = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_OUTPUT_PATH = path.join("modeling", "local_exports", "generated_signal_pairs_corpus_audit.json");
const TRUSTED_DECLARATION_PATH = path.join(
  __dirname,
  "declarations",
  "trusted_initial_formula_v1_1_all.json",
);

interface ParsedArgs {
  input: string;
  output: string;
  trustedFormulaVersion?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { input: DEFAULT_INPUT_PATH, output: DEFAULT_OUTPUT_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = argv[i + 1] ?? DEFAULT_INPUT_PATH;
      i += 1;
    } else if (arg === "--output") {
      args.output = argv[i + 1] ?? DEFAULT_OUTPUT_PATH;
      i += 1;
    } else if (arg === "--trusted-formula-version") {
      args.trustedFormulaVersion = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

/**
 * Reads the trusted formula-version string from the canonical strategy
 * declaration (filters.formulaVersionEquals) so the CLI does not duplicate
 * a magic string. Throws on a malformed declaration.
 */
function resolveTrustedFormulaVersionFromDeclaration(): string {
  const raw = readFileSync(TRUSTED_DECLARATION_PATH, "utf8");
  const declaration = JSON.parse(raw) as { filters?: { formulaVersionEquals?: unknown } };
  const value = declaration.filters?.formulaVersionEquals;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("trusted declaration is missing filters.formulaVersionEquals");
  }
  return value;
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

  let trustedFormulaVersion = args.trustedFormulaVersion;
  if (!trustedFormulaVersion) {
    try {
      trustedFormulaVersion = resolveTrustedFormulaVersionFromDeclaration();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      fail(`failed to resolve default trusted formula version: ${message}`);
    }
  }

  const report = auditGeneratedSignalPairsCorpus(rows as ExportRow[], {
    trustedFormulaVersion: trustedFormulaVersion as string,
  });

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

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main();
}
