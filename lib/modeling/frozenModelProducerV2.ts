import { buildCanonicalModelHandoff, DATASET_DIR, DATASET_SHA, EXECUTION_SHA, IDENTITY_SHA } from "./canonicalModelHandoff";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildExecutionWaterfall } from "./executionWaterfall";
import { loadExecutableFunnelClassifier } from "./executableFunnelClassifier";
import { getScoreValue } from "./historicalFunnelVariants";
import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";
import { isAllowedFormulaVersion } from "./historicalFunnelVariants";
import { filterLockedExecutionSequence, loadFrozenAuditInputs } from "./postJuneCanonicalFreeze";

export type FrozenDecision = { executionSequenceIndex: number; observationId: string; decisionAtIso: string; resolvedAtIso: string; operatingDay: string; stake: number; terminalReason: string };
export type FrozenModelProducerInput = { corpus: ExportRow[]; audit: unknown };

export function validateFrozenModelProducerRows(rows: readonly ExportRow[]): void {
  for (const [index, row] of rows.entries()) {
    if (typeof row.id !== "string" || row.id.length === 0 || getStrictDedupKeyForExportRow(row) === null) throw new Error(`FROZEN_PRODUCER_INVALID_IDENTITY:index=${index}`);
    if (getScoreValue(row) === null) throw new Error(`FROZEN_PRODUCER_UNSUPPORTED_SCORE:index=${index}:id=${row.id}`);
    if (!isAllowedFormulaVersion(row)) throw new Error(`FROZEN_PRODUCER_UNSUPPORTED_METRIC_FORMULA_VERSION:index=${index}:id=${row.id}`);
  }
}

function canonicalReplay(rows: readonly FrozenDecision[], canonical: readonly FrozenDecision[]): FrozenDecision[] {
  const byId = new Map<string, FrozenDecision>();
  for (const row of rows) {
    if (typeof row.observationId !== "string" || row.observationId.length === 0) throw new Error("FROZEN_PRODUCER_INVALID_OBSERVATION_ID");
    if (byId.has(row.observationId)) throw new Error(`FROZEN_PRODUCER_DUPLICATE_OBSERVATION_ID:${row.observationId}`);
    byId.set(row.observationId, row);
  }
  if (byId.size !== canonical.length || canonical.some((row) => !byId.has(row.observationId))) throw new Error("FROZEN_PRODUCER_LOCKED_SEQUENCE_MISMATCH");
  return canonical.map((row) => byId.get(row.observationId)!);
}

function postJuneFromLockedSequence(rows: readonly FrozenDecision[], canonical: readonly FrozenDecision[]): FrozenDecision[] {
  const lockedRows = canonicalReplay(rows, canonical);
  const postJuneIds = filterLockedExecutionSequence(lockedRows.map((row) => ({ ...row, executionIndex: row.executionSequenceIndex })), "2026-06-09").map((row) => row.observationId);
  const decisionById = new Map(lockedRows.map((row) => [row.observationId, row]));
  const postJuneRows = postJuneIds.map((id) => decisionById.get(id));
  if (postJuneRows.some((row) => row === undefined)) throw new Error("FROZEN_PRODUCER_POST_JUNE_NOT_IN_LOCKED_SEQUENCE");
  return postJuneRows as FrozenDecision[];
}

export function produceFrozenModelProducerV2(root: string, input?: FrozenModelProducerInput) {
  const { corpus } = input ?? loadFrozenAuditInputs(root);
  if (!Array.isArray(corpus) || (input === undefined ? corpus.length !== 49_400 : corpus.length < 49_400)) throw new Error("FROZEN_PRODUCER_DATASET_ROW_COUNT_MISMATCH");
  const waterfall = buildExecutionWaterfall(corpus as ExportRow[], loadExecutableFunnelClassifier());
  if (waterfall.version !== "EXECUTION_WATERFALL_V1") throw new Error("FROZEN_PRODUCER_WATERFALL_VERSION_MISMATCH");
  const handoff = buildCanonicalModelHandoff(root);
  const selectedDecisions = handoff.executionSequence.records as FrozenDecision[];
  const rawById = new Map((corpus as ExportRow[]).map((row) => [row.id, row]));
  const selectedRows = selectedDecisions.map((decision) => rawById.get(decision.observationId));
  if (selectedRows.some((row) => row === undefined)) throw new Error("FROZEN_PRODUCER_LOCKED_ROW_MISSING");
  validateFrozenModelProducerRows(selectedRows as ExportRow[]);
  const postJuneDecisions = postJuneFromLockedSequence(selectedDecisions, selectedDecisions);
  const contract = JSON.parse(readFileSync(path.join(root, "modeling/canonical/model-handoff-v1/canonical_model_contract.json"), "utf8"));
  if (contract.dataset?.sha256 !== DATASET_SHA || contract.identitySet?.sha256 !== IDENTITY_SHA || contract.executionSequence?.sha256 !== EXECUTION_SHA) throw new Error("FROZEN_PRODUCER_MANIFEST_PARITY_FAILED");
  if (selectedDecisions.length !== 231 || postJuneDecisions.length !== 124 || handoff.identitySet.sha256 !== IDENTITY_SHA || handoff.executionSequence.sha256 !== EXECUTION_SHA) throw new Error("FROZEN_PRODUCER_CANONICAL_PARITY_FAILED");
  return {
    datasetRows: corpus.length,
    processedInputRows: corpus.length,
    datasetHash: DATASET_SHA,
    datasetPath: DATASET_DIR,
    selectedDecisions,
    postJuneDecisions,
    identitySetHash: handoff.identitySet.sha256,
    executionSequenceHash: handoff.executionSequence.sha256,
    replayFromRows: (rows: readonly FrozenDecision[]) => canonicalReplay(rows, selectedDecisions),
    postJuneFromProducedRows: (rows: readonly FrozenDecision[]) => postJuneFromLockedSequence(rows, selectedDecisions),
  };
}
