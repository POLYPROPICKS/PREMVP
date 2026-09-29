// Compact telemetry carrier for completed Contract A rejections only.
// Selected decisions remain authoritative in night_event_reservations.
import type { ContractADecisionResult, ContractARejectionTrace } from "./contractADecisions";

export const CONTRACT_A_REJECTION_EVIDENCE_VERSION =
  "DATA_CAPTURE_V2_REJECTION_EVIDENCE_V1" as const;

export type RejectionIdentityLevel =
  | "EXACT_CANDIDATE"
  | "PARTIAL_CANDIDATE"
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

export function buildContractARejectionEvidence(input: {
  planRunId: string;
  decidedAtIso: string;
  results: readonly ContractADecisionResult<unknown>[];
  sourceRows?: readonly Record<string, unknown>[];
}): ContractARejectionEvidenceRow[] {
  const rowsBySourceParent = new Map<string, Record<string, unknown>>();
  for (const row of input.sourceRows ?? []) {
    if (typeof row.id === "string" && !rowsBySourceParent.has(row.id)) rowsBySourceParent.set(row.id, row);
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
    const observation = splitObservationIdentity(observationId);
    const sourceRow = generatedSignalPairId ? rowsBySourceParent.get(generatedSignalPairId) : undefined;
    const sourceCondition = typeof sourceRow?.condition_id === "string" && sourceRow.condition_id.trim()
      ? sourceRow.condition_id : null;
    const sourceToken = typeof sourceRow?.selected_token_id === "string" && sourceRow.selected_token_id.trim()
      ? sourceRow.selected_token_id : null;
    const sourceSide = typeof sourceRow?.selected_outcome === "string" && sourceRow.selected_outcome.trim()
      ? sourceRow.selected_outcome : null;
    const observationIsExact = observation.conditionId !== null && observation.tokenId !== null;

    let identityLevel: RejectionIdentityLevel;
    let conditionId: string | null;
    let selectedTokenId: string | null;
    let side: string | null;
    if (observationIsExact) {
      conditionId = observation.conditionId;
      selectedTokenId = observation.tokenId;
      side = sourceSide;
      identityLevel = side === null ? "PARTIAL_CANDIDATE" : "EXACT_CANDIDATE";
    } else if (sourceRow && sourceCondition && sourceToken) {
      conditionId = sourceCondition;
      selectedTokenId = sourceToken;
      side = sourceSide;
      identityLevel = side === null ? "PARTIAL_CANDIDATE" : "EXACT_CANDIDATE";
    } else {
      conditionId = null;
      selectedTokenId = null;
      side = null;
      identityLevel = physicalEventId ? "PHYSICAL_EVENT" : "UNKNOWN";
    }

    const candidateIdentity = identityLevel === "EXACT_CANDIDATE" || identityLevel === "PARTIAL_CANDIDATE";
    const identity = candidateIdentity
      ? `${conditionId}::${selectedTokenId}`
      : physicalEventId ?? `NO_IDENTITY_${identityLevel}_${++identitylessSequence}`;
    const rejectionKey = [
      input.planRunId,
      trace.contract_a_version,
      trace.stage,
      trace.reason_code,
      `${generatedSignalPairId ?? "-"}::${identity}${identityLevel === "EXACT_CANDIDATE" ? `::${side}` : ""}`,
    ].join("|");
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
      side,
    });
  }
  return rows;
}
