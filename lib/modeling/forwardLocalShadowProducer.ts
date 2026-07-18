import type { ExportRow } from "./generatedSignalPairsExportContract";
import { getStrictDedupKeyForExportRow } from "./generatedSignalPairsExportContract";
import { getScoreValue, isAllowedFormulaVersion } from "./historicalFunnelVariants";
import { buildExecutionWaterfall, EXECUTION_WATERFALL_VERSION, type ExecutionCandidate } from "./executionWaterfall";
import { loadExecutableFunnelClassifier, type ExecutableFunnelClassifier } from "./executableFunnelClassifier";
import { stable, sha } from "./canonicalModelHandoff";

export const FORWARD_LOCAL_SHADOW_SCHEMA_VERSION = "FORWARD_LOCAL_SHADOW_DECISION_V1" as const;

const FORWARD_LEAKAGE_FIELDS = ["resolved_at", "signal_result", "result", "outcome_status", "realized_return_pct", "realizedReturnPct"] as const;

function hasLeakageField(row: ExportRow): string | null {
  for (const key of FORWARD_LEAKAGE_FIELDS) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return key;
  }
  return null;
}

function getEventStartIso(row: ExportRow): string | null {
  const diagnostics = row.diagnostics && typeof row.diagnostics === "object" ? (row.diagnostics as Record<string, unknown>) : null;
  const gameStartIso = diagnostics ? diagnostics.gameStartIso : undefined;
  return typeof gameStartIso === "string" && Number.isFinite(Date.parse(gameStartIso)) ? gameStartIso : null;
}

export function normalizeAsOfIso(asOf: string): string {
  const ms = Date.parse(asOf);
  if (typeof asOf !== "string" || asOf.trim() === "" || !Number.isFinite(ms)) throw new Error("FORWARD_PRODUCER_INVALID_AS_OF");
  return new Date(ms).toISOString();
}

export function validateForwardSnapshotRows(rows: readonly ExportRow[], asOfMs: number): void {
  for (const [index, row] of rows.entries()) {
    const leakageField = hasLeakageField(row);
    if (leakageField !== null) throw new Error(`FORWARD_PRODUCER_LEAKAGE_FIELD_DETECTED:index=${index}:field=${leakageField}`);
    const createdAt = typeof row.created_at === "string" ? row.created_at : null;
    const createdMs = createdAt !== null ? Date.parse(createdAt) : NaN;
    if (createdAt === null || !Number.isFinite(createdMs)) throw new Error(`FORWARD_PRODUCER_INVALID_CREATED_AT:index=${index}`);
    if (createdMs > asOfMs) throw new Error(`FORWARD_PRODUCER_CREATED_AT_AFTER_AS_OF:index=${index}`);
    if (getEventStartIso(row) === null) throw new Error(`FORWARD_PRODUCER_INVALID_EVENT_START:index=${index}`);
    if (getStrictDedupKeyForExportRow(row) === null) throw new Error(`FORWARD_PRODUCER_INVALID_IDENTITY:index=${index}`);
    if (getScoreValue(row) === null) throw new Error(`FORWARD_PRODUCER_INVALID_SCORE:index=${index}`);
    if (!isAllowedFormulaVersion(row)) throw new Error(`FORWARD_PRODUCER_UNSUPPORTED_METRIC_FORMULA_VERSION:index=${index}`);
  }
}

export interface ForwardShadowDecisionIdentityFields {
  observationId: string;
  asOfIso: string;
  waterfallVersion: string;
  classifierRegistrySha: string;
  metricFormulaVersion: string;
}

export function computeForwardDecisionIdentity(fields: ForwardShadowDecisionIdentityFields): string {
  return sha(stable(fields));
}

export function computeClassifierRegistrySha(classifier: ExecutableFunnelClassifier): string {
  return sha(stable(classifier));
}

export interface ForwardShadowDecision {
  decisionId: string;
  observationId: string;
  asOfIso: string;
  waterfallVersion: string;
  classifierRegistrySha: string;
  metricFormulaVersion: string;
  matchKey: string;
  decisionAtIso: string;
  createdAtIso: string;
  finalScore: number;
  dataCoverage: number;
  entryPrice: number;
}

export interface ForwardLocalShadowResult {
  asOfIso: string;
  waterfallVersion: string;
  classifierRegistrySha: string;
  inputRowCount: number;
  decisions: ForwardShadowDecision[];
}

function buildDecision(candidate: ExecutionCandidate, asOfIso: string, classifierRegistrySha: string): ForwardShadowDecision {
  const row = candidate.row as ExportRow;
  const metricFormulaVersion = String(row.metric_formula_version);
  const decisionId = computeForwardDecisionIdentity({
    observationId: candidate.observationId,
    asOfIso,
    waterfallVersion: EXECUTION_WATERFALL_VERSION,
    classifierRegistrySha,
    metricFormulaVersion,
  });
  return {
    decisionId,
    observationId: candidate.observationId,
    asOfIso,
    waterfallVersion: EXECUTION_WATERFALL_VERSION,
    classifierRegistrySha,
    metricFormulaVersion,
    matchKey: candidate.matchKey,
    decisionAtIso: candidate.decisionAtIso,
    createdAtIso: candidate.createdAtIso,
    finalScore: candidate.finalScore,
    dataCoverage: candidate.dataCoverage,
    entryPrice: candidate.entryPrice,
  };
}

export function produceForwardLocalShadowDecisions(rows: readonly ExportRow[], asOfIsoInput: string): ForwardLocalShadowResult {
  const asOfIso = normalizeAsOfIso(asOfIsoInput);
  const asOfMs = Date.parse(asOfIso);
  validateForwardSnapshotRows(rows, asOfMs);
  const classifier = loadExecutableFunnelClassifier();
  const classifierRegistrySha = computeClassifierRegistrySha(classifier);
  const waterfall = buildExecutionWaterfall(rows as ExportRow[], classifier);
  if (waterfall.version !== EXECUTION_WATERFALL_VERSION) throw new Error("FORWARD_PRODUCER_WATERFALL_VERSION_MISMATCH");
  const decisions = waterfall.executionCandidates
    .map((candidate) => buildDecision(candidate, asOfIso, classifierRegistrySha))
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  return { asOfIso, waterfallVersion: EXECUTION_WATERFALL_VERSION, classifierRegistrySha, inputRowCount: rows.length, decisions };
}
