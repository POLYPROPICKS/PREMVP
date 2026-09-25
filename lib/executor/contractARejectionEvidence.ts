// lib/executor/contractARejectionEvidence.ts
//
// DATA_CAPTURE_V2_REJECTION_EVIDENCE_V1 — telemetry-only, REJECTED rows only.
//
// SELECTED already has an authoritative carrier (night_event_reservations
// .diagnostics) and is not duplicated here. NOT_EVALUATED is never persisted:
// it stays derivable as the anti-join of the run's source-row denominator
// minus the exact identities persisted in this relation, reservation rows and
// the candidate manifests. job_runs.diagnostics keeps its documented
// identity-free aggregate contract and is untouched.
//
// One durable row = one Contract A rejection decision (a complete
// ContractARejectionTrace). Idempotent across retries of the same planning run.
// No truncation, no raw provider payloads, no JSON blobs, no orderbook data.

import type { ContractADecisionResult, ContractARejectionTrace } from "./contractADecisions";

export const CONTRACT_A_REJECTION_EVIDENCE_VERSION =
  "DATA_CAPTURE_V2_REJECTION_EVIDENCE_V1" as const;

export type RejectionIdentityLevel =
  | "EXACT_CANDIDATE"
  | "PARTIAL_CANDIDATE"
  | "SOURCE_CANDIDATE"
  | "PHYSICAL_EVENT"
  | "UNKNOWN";

export interface ContractARejectionEvidenceRow {
  rejection_key: string;
  rejection_evidence_version: string;
  plan_run_id: string;
  decision_at: string;
  decision_version: string;
  contract_a_version: string;
  stage: string;
  reason_code: string;
  reason_detail: string | null;
  identity_level: RejectionIdentityLevel;
  physical_event_id: string | null;
  observation_id: string | null;
  generated_signal_pair_id: string | null;
  provider_event_id: string | null;
  provider_event_start_iso: string | null;
  producer_source: string | null;
  source_created_at: string | null;
  condition_id: string | null;
  selected_token_id: string | null;
  side: string | null;
}

export interface ContractARejectionEvidenceWritePort {
  upsert(rows: readonly ContractARejectionEvidenceRow[]): Promise<void>;
}

function splitObservationIdentity(observationId: string | null): {
  conditionId: string | null;
  tokenId: string | null;
} {
  if (!observationId) return { conditionId: null, tokenId: null };
  const sep = observationId.indexOf("::");
  if (sep <= 0) return { conditionId: observationId, tokenId: null };
  return { conditionId: observationId.slice(0, sep), tokenId: observationId.slice(sep + 2) };
}

export function rejectionEvidenceKey(parts: {
  planRunId: string;
  contractAVersion: string;
  stage: string;
  reasonCode: string;
  identityValue: string;
}): string {
  return [parts.planRunId, parts.contractAVersion, parts.stage, parts.reasonCode, parts.identityValue].join("|");
}

export interface BuildContractARejectionEvidenceInput {
  planRunId: string;
  decidedAtIso: string;
  results: readonly ContractADecisionResult<unknown>[];
  sourceRows?: readonly Record<string, unknown>[];
}

export function buildContractARejectionEvidence(
  input: BuildContractARejectionEvidenceInput
): ContractARejectionEvidenceRow[] {
  const rowsBySourceParent = new Map<string, Record<string, unknown>>();
  for (const row of input.sourceRows ?? []) {
    const parentId = typeof row.id === "string" ? row.id : null;
    if (parentId && !rowsBySourceParent.has(parentId)) rowsBySourceParent.set(parentId, row);
  }

  const rows: ContractARejectionEvidenceRow[] = [];
  const seenKeys = new Set<string>();
  let identitylessSequence = 0;

  for (const result of input.results) {
    if (result.accepted) continue;
    const trace = (result as { rejection: ContractARejectionTrace }).rejection;
    const lineage = trace.source_lineage;
    const observationId = lineage?.observation_id ?? null;
    const generatedSignalPairId = lineage?.generated_signal_pair_id ?? null;
    const physicalEventId = trace.physical_event_id ?? null;
    const conditionToken = splitObservationIdentity(observationId);
    const sourceRow =
      (generatedSignalPairId ? rowsBySourceParent.get(generatedSignalPairId) : undefined) ?? undefined;
    const sourceConditionId = typeof sourceRow?.condition_id === "string" && sourceRow.condition_id.trim() !== ""
      ? sourceRow.condition_id
      : null;
    const sourceTokenId = typeof sourceRow?.selected_token_id === "string" && sourceRow.selected_token_id.trim() !== ""
      ? sourceRow.selected_token_id
      : null;
    const sourceSide = typeof sourceRow?.selected_outcome === "string" && sourceRow.selected_outcome.trim() !== ""
      ? sourceRow.selected_outcome
      : null;

    const exactAvailable = conditionToken.conditionId !== null && conditionToken.tokenId !== null;

    let identityLevel: RejectionIdentityLevel;
    let conditionId: string | null;
    let selectedTokenId: string | null;
    let side: string | null;

    if (exactAvailable && sourceSide !== null) {
      identityLevel = "EXACT_CANDIDATE";
      conditionId = conditionToken.conditionId;
      selectedTokenId = conditionToken.tokenId;
      side = sourceSide;
    } else if (exactAvailable) {
      identityLevel = "PARTIAL_CANDIDATE";
      conditionId = conditionToken.conditionId;
      selectedTokenId = conditionToken.tokenId;
      side = null;
    } else if (sourceRow && sourceConditionId && sourceTokenId && sourceSide !== null) {
      identityLevel = "EXACT_CANDIDATE";
      conditionId = sourceConditionId;
      selectedTokenId = sourceTokenId;
      side = sourceSide;
    } else if (sourceRow && sourceConditionId && sourceTokenId) {
      identityLevel = "PARTIAL_CANDIDATE";
      conditionId = sourceConditionId;
      selectedTokenId = sourceTokenId;
      side = null;
    } else if (physicalEventId) {
      identityLevel = "PHYSICAL_EVENT";
      conditionId = null;
      selectedTokenId = null;
      side = null;
    } else {
      identityLevel = "UNKNOWN";
      conditionId = null;
      selectedTokenId = null;
      side = null;
    }

    const tokenLevel =
      identityLevel === "EXACT_CANDIDATE" || identityLevel === "PARTIAL_CANDIDATE";

    const identityValue =
      tokenLevel
        ? `${conditionId}::${selectedTokenId}`
        : physicalEventId ?? `NO_IDENTITY_${identityLevel}_${++identitylessSequence}`;

    const rejectionKey = rejectionEvidenceKey({
      planRunId: input.planRunId,
      contractAVersion: trace.contract_a_version,
      stage: trace.stage,
      reasonCode: trace.reason_code,
      identityValue: `${generatedSignalPairId ?? "-"}::${identityValue}${
        identityLevel === "EXACT_CANDIDATE" ? `::${side ?? "-"}` : ""
      }`,
    });
    if (seenKeys.has(rejectionKey)) continue;
    seenKeys.add(rejectionKey);

    rows.push({
      rejection_key: rejectionKey,
      rejection_evidence_version: CONTRACT_A_REJECTION_EVIDENCE_VERSION,
      plan_run_id: input.planRunId,
      decision_at: input.decidedAtIso,
      decision_version: trace.decision_version,
      contract_a_version: trace.contract_a_version,
      stage: trace.stage,
      reason_code: trace.reason_code,
      reason_detail: trace.detail ?? null,
      identity_level: identityLevel,
      physical_event_id: physicalEventId,
      observation_id: observationId,
      generated_signal_pair_id: generatedSignalPairId,
      provider_event_id: lineage?.provider_event_id ?? null,
      provider_event_start_iso: lineage?.provider_event_start_iso ?? null,
      producer_source: lineage?.producer_source ?? null,
      source_created_at: lineage?.source_created_at ?? null,
      condition_id: conditionId,
      selected_token_id: selectedTokenId,
      side: side,
    });
  }

  rejectFabricatedExactIdentity(rows);
  return rows;
}

function rejectFabricatedExactIdentity(rows: ContractARejectionEvidenceRow[]): void {
  for (const row of rows) {
    const level = row.identity_level;
    if (level === "EXACT_CANDIDATE") {
      if (row.condition_id === null || row.selected_token_id === null || row.side === null) {
        throw new Error("REJECTION_EVIDENCE_EXACT_CANDIDATE_INCOMPLETE");
      }
    } else if (level === "PARTIAL_CANDIDATE") {
      if (row.condition_id === null || row.selected_token_id === null || row.side !== null) {
        throw new Error("REJECTION_EVIDENCE_PARTIAL_MASQUERADE");
      }
    } else if (level === "PHYSICAL_EVENT" || level === "UNKNOWN") {
      if (row.condition_id !== null || row.selected_token_id !== null || row.side !== null) {
        throw new Error("REJECTION_EVIDENCE_IDENTITY_FABRICATION");
      }
    }
  }
}

export function rejectedExactIdentitiesOf(
  rows: readonly ContractARejectionEvidenceRow[]
): Set<string> {
  return new Set(
    rows
      .filter((row) => row.condition_id !== null && row.selected_token_id !== null)
      .map((row) => `${row.condition_id}::${row.selected_token_id}`)
  );
}

export function deriveNotEvaluatedIdentities(args: {
  sourceRows: readonly Record<string, unknown>[];
  rejectedRows: readonly ContractARejectionEvidenceRow[];
  /**
   * Exact persisted identities (condition_id::selected_token_id) of candidates
   * that WERE evaluated (SELECTED/accepted). NOT_EVALUATED = denominator minus
   * (evaluated ∪ rejected); without this input the helper cannot be correct.
   */
  evaluatedExactIdentities?: ReadonlySet<string>;
}): Array<{ condition_id: string; selected_token_id: string; side: string | null }> {
  const rejected = rejectedExactIdentitiesOf(args.rejectedRows);
  const evaluated = args.evaluatedExactIdentities ?? new Set<string>();
  const out: Array<{ condition_id: string; selected_token_id: string; side: string | null }> = [];
  const seen = new Set<string>();
  for (const row of args.sourceRows) {
    const conditionId = typeof row.condition_id === "string" ? row.condition_id.trim() : "";
    const tokenId = typeof row.selected_token_id === "string" ? row.selected_token_id.trim() : "";
    if (!conditionId || !tokenId) continue;
    const side = typeof row.selected_outcome === "string" && row.selected_outcome.trim() !== ""
      ? row.selected_outcome
      : null;
    const identity = `${conditionId}::${tokenId}`;
    if (rejected.has(identity)) continue;
    if (evaluated.has(identity)) continue;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({ condition_id: conditionId, selected_token_id: tokenId, side });
  }
  return out;
}
