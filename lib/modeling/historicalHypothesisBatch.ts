// Automated Historical Hypothesis Batch Runner (Phase 4C).
//
// Composes existing canonical pure functions -- strict dedup
// (generatedSignalPairsDedupPolicy), the comparison engine
// (historicalFunnelComparison), and the reproducible run manifest builder
// (evaluationRunManifest) -- into ONE deterministic research-triage packet
// comparing N candidate variants against one base comparator. Never
// recomputes ROI/dedup/grouping, never fetches data, never reads env/
// network/Supabase, never selects a Champion, never promotes a model. This
// is research triage only.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  compareHistoricalFunnelVariants,
  COMPARISON_ENGINE_VERSION,
  type ComparisonResult,
  type VariantExecution,
} from "./historicalFunnelComparison";
import {
  projectGeneratedSignalPairsStrictDedup,
  STRICT_DEDUP_POLICY_NAME,
} from "./generatedSignalPairsDedupPolicy";
import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";
import { getBundle, type ExecutableFunnelClassifier } from "./executableFunnelClassifier";
import {
  buildEvaluationRunManifest,
  type ManifestInputs,
  type EvaluationRunManifest,
  type SkippedVariantRecord,
} from "./evaluationRunManifest";

// ---- sample class ----

export type SampleClass = "BROAD" | "SPECIALIST" | "INSUFFICIENT";

/** BROAD >= 200, SPECIALIST 30..199, INSUFFICIENT < 30. */
export function sampleClassOf(n: number): SampleClass {
  if (n >= 200) return "BROAD";
  if (n >= 30) return "SPECIALIST";
  return "INSUFFICIENT";
}

// ---- structural flags ----

export type StructuralFlag = "ONE_PER_EVENT" | "LOWER_CONCENTRATION" | "IDENTITY_LIMITATION";

export interface VariantMetricsLike {
  outputRows: number;
  workingEventGroups: number;
  flatUnitPnl: number | null;
  flatUnitRoi: number | null;
  winRate: number | null;
  maximumSignalsPerWorkingEvent: number;
  maximumDrawdownUnits: number;
}

/**
 * Structural comparison flags. IDENTITY_LIMITATION is never derived here --
 * the caller passes it in, reusing the classifier's own existing
 * runStatus === "READY_EXPLORATORY_WITH_IDENTITY_LIMITATION" signal rather
 * than reimplementing that judgement.
 */
export function computeStructuralFlags(
  candidate: VariantMetricsLike,
  base: VariantMetricsLike,
  hasIdentityLimitation: boolean,
): StructuralFlag[] {
  const flags: StructuralFlag[] = [];
  if (candidate.maximumSignalsPerWorkingEvent === 1) flags.push("ONE_PER_EVENT");
  if (candidate.maximumSignalsPerWorkingEvent < base.maximumSignalsPerWorkingEvent) flags.push("LOWER_CONCENTRATION");
  if (hasIdentityLimitation) flags.push("IDENTITY_LIMITATION");
  return flags;
}

// ---- deltas ----

export interface TriageDeltas {
  selectedObservations: number;
  eventGroups: number;
  pnlUnits: number | null;
  roiPercentagePoints: number | null;
  maximumDrawdownUnits: number;
  maxSignalsPerEvent: number;
  winRatePercentagePoints: number | null;
}

/** candidate minus base for every field; null propagates through null-safely, never NaN. */
export function computeTriageDeltas(candidate: VariantMetricsLike, base: VariantMetricsLike): TriageDeltas {
  return {
    selectedObservations: candidate.outputRows - base.outputRows,
    eventGroups: candidate.workingEventGroups - base.workingEventGroups,
    pnlUnits: candidate.flatUnitPnl !== null && base.flatUnitPnl !== null ? candidate.flatUnitPnl - base.flatUnitPnl : null,
    roiPercentagePoints: candidate.flatUnitRoi !== null && base.flatUnitRoi !== null ? candidate.flatUnitRoi - base.flatUnitRoi : null,
    maximumDrawdownUnits: candidate.maximumDrawdownUnits - base.maximumDrawdownUnits,
    maxSignalsPerEvent: candidate.maximumSignalsPerWorkingEvent - base.maximumSignalsPerWorkingEvent,
    winRatePercentagePoints: candidate.winRate !== null && base.winRate !== null ? candidate.winRate - base.winRate : null,
  };
}

// ---- triage classification ----

export const DECISION_TRIAGE_STATUSES = [
  "ADVANCE_BROAD_FOLLOWUP",
  "ADVANCE_SPECIALIST_FOLLOWUP",
  "ADVANCE_STRUCTURAL_FOLLOWUP",
  "HOLD_FOR_MORE_EVIDENCE",
  "REJECT_HISTORICAL_BATCH",
] as const;
export type TriageStatus = (typeof DECISION_TRIAGE_STATUSES)[number];

function gt(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && a > b;
}
function gte(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && a >= b;
}
function isPositive(v: number | null): boolean {
  return v !== null && v > 0;
}

/**
 * Research-triage classification only -- never a Champion/promotion
 * decision. Priority when multiple rules would match: BROAD -> SPECIALIST ->
 * STRUCTURAL -> HOLD -> REJECT. STRUCTURAL explicitly does not require the
 * candidate to beat base on total PnL (a concentration-control candidate
 * that keeps exactly one signal per event is not disqualified by lower
 * total PnL than a higher-volume base).
 */
export function classifyTriageStatus(
  candidate: VariantMetricsLike,
  base: VariantMetricsLike,
  structuralFlags: readonly StructuralFlag[],
): TriageStatus {
  const sampleClass = sampleClassOf(candidate.outputRows);

  const broadEligible =
    sampleClass === "BROAD" &&
    gt(candidate.flatUnitPnl, base.flatUnitPnl) &&
    gt(candidate.flatUnitRoi, base.flatUnitRoi) &&
    candidate.maximumDrawdownUnits < base.maximumDrawdownUnits;
  if (broadEligible) return "ADVANCE_BROAD_FOLLOWUP";

  const specialistEligible =
    sampleClass === "SPECIALIST" &&
    isPositive(candidate.flatUnitPnl) &&
    gt(candidate.flatUnitRoi, base.flatUnitRoi) &&
    candidate.maximumDrawdownUnits < base.maximumDrawdownUnits;
  if (specialistEligible) return "ADVANCE_SPECIALIST_FOLLOWUP";

  const structuralEligible =
    structuralFlags.includes("ONE_PER_EVENT") && isPositive(candidate.flatUnitPnl) && gte(candidate.flatUnitRoi, base.flatUnitRoi);
  if (structuralEligible) return "ADVANCE_STRUCTURAL_FOLLOWUP";

  if (isPositive(candidate.flatUnitPnl) && isPositive(candidate.flatUnitRoi)) return "HOLD_FOR_MORE_EVIDENCE";

  return "REJECT_HISTORICAL_BATCH";
}

// ---- pure builder ----

export interface HypothesisBatchCandidate {
  candidateId: string;
  baseId: string;
  candidateMetrics: VariantMetricsLike;
  baseMetrics: VariantMetricsLike;
  deltas: TriageDeltas;
  sampleClass: SampleClass;
  structuralFlags: StructuralFlag[];
  triageStatus: TriageStatus;
}

export interface HistoricalHypothesisBatchResult {
  schemaVersion: 1;
  inputSha256: string;
  classifierSha256: string;
  baseVariantId: string;
  requestedVariantIds: string[];
  rawRowCount: number;
  strictDedupRowCount: number;
  comparison: ComparisonResult;
  manifest: EvaluationRunManifest;
  candidates: HypothesisBatchCandidate[];
  triageCounts: Record<TriageStatus, number>;
  contentHash: string;
}

export interface HypothesisBatchOptions {
  rawRows: readonly ExportRow[];
  classifier: ExecutableFunnelClassifier;
  baseVariantId: string;
  requestedVariantIds: readonly string[];
  /** Injectable for tests; defaults to reading git via execFileSync (never env). */
  gitCommit?: string;
  gitBranch?: string;
}

function toMetricsLike(exec: VariantExecution): VariantMetricsLike {
  const m = exec.metrics!;
  return {
    outputRows: m.outputRows,
    workingEventGroups: m.workingEventGroups,
    flatUnitPnl: m.flatUnitPnl,
    flatUnitRoi: m.flatUnitRoi,
    winRate: m.winRate,
    maximumSignalsPerWorkingEvent: m.maximumSignalsPerWorkingEvent,
    maximumDrawdownUnits: m.equity.maximumDrawdownUnits,
  };
}

/** Deterministic corpus fingerprint: sorted by strict dedup key, JSON stringified, sha256. */
function dedupCorpusHash(rows: readonly ExportRow[]): string {
  const ordered = [...rows].sort((a, b) => {
    const ak = getStrictDedupKeyForExportRow(a) ?? "";
    const bk = getStrictDedupKeyForExportRow(b) ?? "";
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function classifierHash(classifier: ExecutableFunnelClassifier): string {
  return createHash("sha256").update(JSON.stringify(classifier)).digest("hex");
}

function readGit(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Builds the full hypothesis batch: strict-dedups `rawRows` (canonical
 * policy, reused verbatim), runs the canonical comparison engine for the
 * requested variants, and produces per-candidate deltas/structural
 * flags/triage status against `baseVariantId`. Pure: no fs/env/network.
 * Input rows are never mutated. Throws (fails closed) on an unknown variant
 * id or when the base did not execute.
 */
export function buildHistoricalHypothesisBatch(options: HypothesisBatchOptions): HistoricalHypothesisBatchResult {
  const { rawRows, classifier, baseVariantId, requestedVariantIds } = options;

  for (const id of requestedVariantIds) {
    if (!getBundle(classifier, id)) {
      throw new Error(`historical hypothesis batch: unknown variant id ${id}`);
    }
  }

  const projection = projectGeneratedSignalPairsStrictDedup(rawRows);
  const dedupRows = projection.dedupedRows;

  const comparison = compareHistoricalFunnelVariants({
    rows: dedupRows,
    classifier,
    requestedVariantIds,
  });

  const byId = new Map(comparison.executions.map((e) => [e.variantId, e]));
  const baseExec = byId.get(baseVariantId);
  if (!baseExec || baseExec.evaluationStatus !== "EXECUTED" || !baseExec.metrics) {
    throw new Error(`historical hypothesis batch: base variant ${baseVariantId} did not execute`);
  }
  const baseMetrics = toMetricsLike(baseExec);

  const candidateIds = requestedVariantIds.filter((id) => id !== baseVariantId);
  const candidates: HypothesisBatchCandidate[] = [];
  for (const id of candidateIds) {
    const exec = byId.get(id)!;
    if (exec.evaluationStatus !== "EXECUTED" || !exec.metrics) continue; // blocked/skipped: not triaged, still visible in `comparison`
    const candidateMetrics = toMetricsLike(exec);
    const bundle = getBundle(classifier, id)!;
    const hasIdentityLimitation = bundle.runStatus === "READY_EXPLORATORY_WITH_IDENTITY_LIMITATION";
    const structuralFlags = computeStructuralFlags(candidateMetrics, baseMetrics, hasIdentityLimitation);
    const deltas = computeTriageDeltas(candidateMetrics, baseMetrics);
    const triageStatus = classifyTriageStatus(candidateMetrics, baseMetrics, structuralFlags);
    candidates.push({
      candidateId: id,
      baseId: baseVariantId,
      candidateMetrics,
      baseMetrics,
      deltas,
      sampleClass: sampleClassOf(candidateMetrics.outputRows),
      structuralFlags,
      triageStatus,
    });
  }

  const triageCounts = DECISION_TRIAGE_STATUSES.reduce((acc, status) => {
    acc[status] = candidates.filter((c) => c.triageStatus === status).length;
    return acc;
  }, {} as Record<TriageStatus, number>);

  const inputSha256 = dedupCorpusHash(dedupRows);
  const classifierSha256 = classifierHash(classifier);

  const skipped: SkippedVariantRecord[] = comparison.executions
    .filter((e) => e.evaluationStatus !== "EXECUTED")
    .map((e) => ({ variantId: e.variantId, reason: e.evaluationStatus }));
  const executed = comparison.executions.filter((e) => e.evaluationStatus === "EXECUTED").map((e) => e.variantId);

  const manifestInputs: ManifestInputs = {
    gitCommit: options.gitCommit ?? readGit(["rev-parse", "HEAD"]),
    gitBranch: options.gitBranch ?? readGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    inputArtifactPath: "historical-hypothesis-batch-corpus",
    inputSha256,
    inputRowCount: dedupRows.length,
    inputFirstResolvedAt: comparison.corpus.firstResolvedAt,
    inputLastResolvedAt: comparison.corpus.lastResolvedAt,
    dedupPolicy: STRICT_DEDUP_POLICY_NAME,
    rawInputRowCount: rawRows.length,
    deduplicatedInputRowCount: dedupRows.length,
    duplicateRowsRemoved: rawRows.length - dedupRows.length,
    dedupApplied: true,
    dedupIdentityFields: ["condition_id", "token_id"],
    dedupOrderingField: "created_at",
    dedupResolutionBoundaryField: "resolved_at",
    classifierPath: "historical-hypothesis-batch-classifier",
    classifierSha256,
    classifierSchemaVersion: classifier.schemaVersion,
    comparisonEngineVersion: COMPARISON_ENGINE_VERSION,
    requestedVariantIds: [...requestedVariantIds],
    executedVariantIds: executed,
    skippedVariantsAndReasons: skipped,
    normalizedStakePolicy: { unit: "FLAT_1_UNIT", plainLanguage: "Канонический ROI: 1 единица на ставку." },
    roiContractSource: "lib/modeling/roiPnlContract.ts",
    eventIdentityPolicy: "Research triage batch -- see individual bundle identity limitations.",
    knownLimitations: ["This is a research-triage packet, not a promotion or Champion decision."],
    commands: ["node --import tsx scripts/modeling/strategies/run-historical-hypothesis-batch.ts"],
    createdAt: "1970-01-01T00:00:00.000Z", // deterministic placeholder; the batch manifest carries no timestamp at all
  };
  const manifest = buildEvaluationRunManifest(manifestInputs);

  const withoutHash: Omit<HistoricalHypothesisBatchResult, "contentHash"> = {
    schemaVersion: 1,
    inputSha256,
    classifierSha256,
    baseVariantId,
    requestedVariantIds: [...requestedVariantIds],
    rawRowCount: rawRows.length,
    strictDedupRowCount: dedupRows.length,
    comparison,
    manifest,
    candidates,
    triageCounts,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  return { ...withoutHash, contentHash };
}

/** Deterministic pretty JSON with exactly one trailing newline. */
export function serializeHypothesisBatchJson(result: HistoricalHypothesisBatchResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

// ---- HTML rendering (inline CSS, tables only, no JS/CDN/network) ----

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}
function fmtInt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}
function fmtDelta(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const s = value.toFixed(digits);
  return value > 0 ? `+${s}` : s;
}

const BASE_CSS =
  "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;color:#1a1a1a;background:#fafafa;max-width:1000px}" +
  "h1{font-size:20px}h2{font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:24px}" +
  ".banner{background:#7a1f1f;color:#fff;padding:10px 14px;border-radius:6px;font-weight:600}" +
  "table{border-collapse:collapse;width:100%;font-size:12px;margin-top:8px}th,td{border:1px solid #ddd;padding:3px 6px;text-align:right}" +
  "th:first-child,td:first-child{text-align:left}" +
  ".warn{background:#fff4e0;border:1px solid #d9a441;border-radius:4px;padding:6px 10px;font-size:12px;margin:6px 0}" +
  "@media print{body{background:#fff}}";

function bannerHtml(): string {
  return `<div class="banner">RESEARCH TRIAGE ONLY &middot; NO AUTOMATIC CHAMPION &middot; NO PROMOTION</div>`;
}

/** Deterministic, self-contained founder-facing decision packet. Never embeds raw corpus rows. */
export function renderDecisionPacketHtml(result: HistoricalHypothesisBatchResult): string {
  const rows = result.candidates
    .map((c) => {
      const warn = c.structuralFlags.includes("IDENTITY_LIMITATION")
        ? `<div class="warn">IDENTITY_LIMITATION: event-identity grouping is exploratory (MEDIUM confidence), not production-ready.</div>`
        : "";
      return (
        `<tr>` +
        `<td>${escapeHtml(c.candidateId)}${warn}</td>` +
        `<td>${fmtInt(c.candidateMetrics.outputRows)}</td>` +
        `<td>${fmtDelta(c.deltas.selectedObservations, 0)}</td>` +
        `<td>${fmt(c.candidateMetrics.flatUnitPnl)}</td>` +
        `<td>${fmtDelta(c.deltas.pnlUnits)}</td>` +
        `<td>${fmt(c.candidateMetrics.flatUnitRoi)}</td>` +
        `<td>${fmtDelta(c.deltas.roiPercentagePoints)}</td>` +
        `<td>${fmt(c.candidateMetrics.maximumDrawdownUnits)}</td>` +
        `<td>${fmtDelta(c.deltas.maximumDrawdownUnits)}</td>` +
        `<td>${fmtInt(c.candidateMetrics.maximumSignalsPerWorkingEvent)}</td>` +
        `<td>${escapeHtml(c.sampleClass)}</td>` +
        `<td>${escapeHtml(c.structuralFlags.join(", ") || "—")}</td>` +
        `<td><strong>${escapeHtml(c.triageStatus)}</strong></td>` +
        `</tr>`
      );
    })
    .join("");

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Historical Hypothesis Decision Packet</title><style>${BASE_CSS}</style></head><body>` +
    `<h1>Historical Hypothesis Decision Packet</h1>${bannerHtml()}` +
    `<section><h2>Corpus provenance</h2><table><tbody>` +
    `<tr><th>Raw rows</th><td>${fmtInt(result.rawRowCount)}</td></tr>` +
    `<tr><th>Strict-dedup rows</th><td>${fmtInt(result.strictDedupRowCount)}</td></tr>` +
    `<tr><th>Corpus hash</th><td>${escapeHtml(result.inputSha256)}</td></tr>` +
    `<tr><th>Classifier hash</th><td>${escapeHtml(result.classifierSha256)}</td></tr>` +
    `<tr><th>Base comparator</th><td>${escapeHtml(result.baseVariantId)}</td></tr>` +
    `</tbody></table></section>` +
    `<section><h2>Candidate comparison</h2><table><thead><tr>` +
    `<th>Candidate</th><th>N</th><th>ΔN</th><th>PnL</th><th>ΔPnL</th><th>ROI%</th><th>ΔROI pp</th>` +
    `<th>MaxDD</th><th>ΔMaxDD</th><th>MaxSig/Ev</th><th>Sample</th><th>Structural flags</th><th>Triage</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></section>` +
    `<footer><small>content ${escapeHtml(result.contentHash)}</small></footer>` +
    `</body></html>\n`
  );
}

/** Deterministic, self-contained lean scorecard for just the requested batch (not the full 12-model founder dashboard). */
export function renderHypothesisScorecardHtml(result: HistoricalHypothesisBatchResult): string {
  const baseRow =
    `<tr><td>${escapeHtml(result.baseVariantId)} (base)</td>` +
    `<td>${fmtInt(result.candidates[0]?.baseMetrics.outputRows ?? null)}</td>` +
    `<td>${fmt(result.candidates[0]?.baseMetrics.flatUnitPnl ?? null)}</td>` +
    `<td>${fmt(result.candidates[0]?.baseMetrics.flatUnitRoi ?? null)}</td>` +
    `<td>${fmt(result.candidates[0]?.baseMetrics.maximumDrawdownUnits ?? null)}</td>` +
    `<td>${fmtInt(result.candidates[0]?.baseMetrics.maximumSignalsPerWorkingEvent ?? null)}</td></tr>`;
  const candidateRows = result.candidates
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.candidateId)}</td><td>${fmtInt(c.candidateMetrics.outputRows)}</td><td>${fmt(c.candidateMetrics.flatUnitPnl)}</td><td>${fmt(c.candidateMetrics.flatUnitRoi)}</td><td>${fmt(c.candidateMetrics.maximumDrawdownUnits)}</td><td>${fmtInt(c.candidateMetrics.maximumSignalsPerWorkingEvent)}</td></tr>`,
    )
    .join("");

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Historical Hypothesis Scorecard</title><style>${BASE_CSS}</style></head><body>` +
    `<h1>Historical Hypothesis Scorecard</h1>${bannerHtml()}` +
    `<section><h2>Batch summary</h2><table><thead><tr><th>Variant</th><th>N</th><th>PnL</th><th>ROI%</th><th>MaxDD</th><th>MaxSig/Ev</th></tr></thead>` +
    `<tbody>${baseRow}${candidateRows}</tbody></table></section>` +
    `<footer><small>content ${escapeHtml(result.contentHash)}</small></footer>` +
    `</body></html>\n`
  );
}

/** Deterministic pretty JSON with exactly one trailing newline, for the lean batch scorecard. */
export function serializeHypothesisScorecardJson(result: HistoricalHypothesisBatchResult): string {
  const payload = {
    schemaVersion: 1,
    baseVariantId: result.baseVariantId,
    baseMetrics: result.candidates[0]?.baseMetrics ?? null,
    candidates: result.candidates.map((c) => ({ candidateId: c.candidateId, metrics: c.candidateMetrics, sampleClass: c.sampleClass })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// ---- batch manifest ----

export interface HypothesisBatchManifest {
  schemaVersion: 1;
  inputSha256: string;
  classifierSha256: string;
  requestedVariantIds: string[];
  baseVariantId: string;
  comparisonHash: string;
  scorecardHash: string;
  decisionPacketHash: string;
  artifactSha256s: Record<string, string>;
}

export interface HypothesisBatchManifestArtifacts {
  comparisonJson: string;
  comparisonManifestJson: string;
  scorecardJson: string;
  scorecardHtml: string;
  decisionPacketJson: string;
  decisionPacketHtml: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Provenance-only manifest tying every written artifact back to the source
 * corpus/classifier hashes. Deliberately carries no timestamp, absolute
 * path, env value, or run duration.
 */
export function buildHypothesisBatchManifest(
  result: HistoricalHypothesisBatchResult,
  artifacts: HypothesisBatchManifestArtifacts,
): HypothesisBatchManifest {
  return {
    schemaVersion: 1,
    inputSha256: result.inputSha256,
    classifierSha256: result.classifierSha256,
    requestedVariantIds: [...result.requestedVariantIds],
    baseVariantId: result.baseVariantId,
    comparisonHash: sha256(artifacts.comparisonJson),
    scorecardHash: sha256(artifacts.scorecardJson),
    decisionPacketHash: sha256(artifacts.decisionPacketJson),
    artifactSha256s: {
      "historical_hypothesis_comparison.json": sha256(artifacts.comparisonJson),
      "historical_hypothesis_comparison_manifest.json": sha256(artifacts.comparisonManifestJson),
      "historical_hypothesis_scorecard.json": sha256(artifacts.scorecardJson),
      "historical_hypothesis_scorecard.html": sha256(artifacts.scorecardHtml),
      "historical_hypothesis_decision_packet.json": sha256(artifacts.decisionPacketJson),
      "historical_hypothesis_decision_packet.html": sha256(artifacts.decisionPacketHtml),
    },
  };
}
