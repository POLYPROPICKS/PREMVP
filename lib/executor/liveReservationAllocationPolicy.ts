import type { ContractAPlanningDecision } from "./contractADecisions";

export const LIVE_RESERVATION_ALLOCATION_V1 = Object.freeze({
  policyId: "LIVE_RESERVATION_ALLOCATION_V1",
  minStartLeadMinutes: 30,
  targetReservationSlots: 15,
  preferredStrategicScopes: ["SOCCER", "TENNIS"] as const,
  rankingOrder: [
    "SIGNAL_SCORE_DESC",
    "SPORT_PREFERENCE",
    "PROVIDER_MARKET_VOLUME_DESC",
    "PHYSICAL_EVENT_ID_ASC",
  ] as const,
});

export interface LiveReservationAllocationPolicy {
  readonly policyId: string;
  readonly minStartLeadMinutes: number;
  readonly targetReservationSlots: number;
  readonly preferredStrategicScopes: readonly string[];
  readonly rankingOrder: readonly [
    "SIGNAL_SCORE_DESC",
    "SPORT_PREFERENCE",
    "PROVIDER_MARKET_VOLUME_DESC",
    "PHYSICAL_EVENT_ID_ASC",
  ];
}

export interface LiveReservationAllocationCandidate {
  decision: ContractAPlanningDecision;
  providerMarketVolume: number | null;
}

export interface RankedLiveReservationAllocation {
  rankedDistinct: LiveReservationAllocationCandidate[];
  excludedBeforeMinimumLead: ContractAPlanningDecision[];
  duplicateDecisionsRemoved: ContractAPlanningDecision[];
  duplicatesRemoved: number;
}

function sportPriority(
  strategicScope: string,
  policy: LiveReservationAllocationPolicy,
): number {
  return policy.preferredStrategicScopes.includes(strategicScope) ? 0 : 1;
}

function finiteVolumeOrBottom(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NEGATIVE_INFINITY;
}

export function compareLiveReservationAllocationCandidates(
  left: LiveReservationAllocationCandidate,
  right: LiveReservationAllocationCandidate,
  policy: LiveReservationAllocationPolicy = LIVE_RESERVATION_ALLOCATION_V1,
): number {
  const scoreDiff = right.decision.planning_score - left.decision.planning_score;
  if (scoreDiff !== 0) return scoreDiff;

  const sportDiff =
    sportPriority(left.decision.strategic_scope, policy) -
    sportPriority(right.decision.strategic_scope, policy);
  if (sportDiff !== 0) return sportDiff;

  const leftVolume = finiteVolumeOrBottom(left.providerMarketVolume);
  const rightVolume = finiteVolumeOrBottom(right.providerMarketVolume);
  if (leftVolume !== rightVolume) {
    if (leftVolume === Number.NEGATIVE_INFINITY) return 1;
    if (rightVolume === Number.NEGATIVE_INFINITY) return -1;
    return rightVolume > leftVolume ? 1 : -1;
  }

  return left.decision.physical_event_id.localeCompare(right.decision.physical_event_id);
}

export function rankAllocatableApprovedPhysicalEvents(
  candidates: readonly LiveReservationAllocationCandidate[],
  planningAnchorMs: number,
  policy: LiveReservationAllocationPolicy = LIVE_RESERVATION_ALLOCATION_V1,
): RankedLiveReservationAllocation {
  const minimumStartMs = planningAnchorMs + policy.minStartLeadMinutes * 60_000;
  const excludedBeforeMinimumLead: ContractAPlanningDecision[] = [];
  const withinLeadGuard: LiveReservationAllocationCandidate[] = [];

  for (const candidate of candidates) {
    const startMs = Date.parse(candidate.decision.event_start_iso);
    if (startMs < minimumStartMs) {
      excludedBeforeMinimumLead.push(candidate.decision);
    } else {
      withinLeadGuard.push(candidate);
    }
  }

  withinLeadGuard.sort((left, right) =>
    compareLiveReservationAllocationCandidates(left, right, policy),
  );

  const seen = new Set<string>();
  const rankedDistinct: LiveReservationAllocationCandidate[] = [];
  const duplicateDecisionsRemoved: ContractAPlanningDecision[] = [];
  let duplicatesRemoved = 0;
  for (const candidate of withinLeadGuard) {
    if (seen.has(candidate.decision.physical_event_id)) {
      duplicatesRemoved += 1;
      duplicateDecisionsRemoved.push(candidate.decision);
      continue;
    }
    seen.add(candidate.decision.physical_event_id);
    rankedDistinct.push(candidate);
  }

  return {
    rankedDistinct,
    excludedBeforeMinimumLead,
    duplicateDecisionsRemoved,
    duplicatesRemoved,
  };
}
