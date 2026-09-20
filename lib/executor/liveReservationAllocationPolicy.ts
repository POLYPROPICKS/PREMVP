import type { ContractADecisionResult, ContractAPlanningDecision } from "./contractADecisions";

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

/**
 * PORTFOLIO_BROAD — the proven research Decision Policy for live Reservation.
 * Event-level: one physical event may qualify through many accepted
 * identities, but its authoritative tier is the HIGHEST-priority qualifying
 * tier (1 before 2 before 3), and capacity across physical events is ordered
 * strictly by tier, then decision time, then physical event id — never by
 * score, sport preference or provider volume.
 *
 * targetReservationSlots (30) is the ACTIVE cap for this release.
 * hardReservationCeiling (50) is the policy invariant ceiling for the next
 * controlled capacity promotion — it is NOT activated by this release.
 */
export const LIVE_RESERVATION_PORTFOLIO_BROAD_V2 = Object.freeze({
  policyId: "LIVE_RESERVATION_PORTFOLIO_BROAD_V2",
  minStartLeadMinutes: 30,
  targetReservationSlots: 30,
  hardReservationCeiling: 50,
  preferredStrategicScopes: [] as const,
  rankingOrder: [
    "PORTFOLIO_TIER_ASC",
    "PORTFOLIO_DECISION_AT_ASC",
    "PHYSICAL_EVENT_ID_ASC",
  ] as const,
});

if (LIVE_RESERVATION_PORTFOLIO_BROAD_V2.hardReservationCeiling !== 50) {
  throw new Error("LIVE_RESERVATION_PORTFOLIO_BROAD_V2_INVARIANT_VIOLATED: hardReservationCeiling must equal 50");
}
if (
  LIVE_RESERVATION_PORTFOLIO_BROAD_V2.targetReservationSlots >
  LIVE_RESERVATION_PORTFOLIO_BROAD_V2.hardReservationCeiling
) {
  throw new Error(
    "LIVE_RESERVATION_PORTFOLIO_BROAD_V2_INVARIANT_VIOLATED: targetReservationSlots must be <= hardReservationCeiling",
  );
}

export type PortfolioBroadTier = 1 | 2 | 3;

export type LiveReservationRankingOrder =
  | readonly [
      "SIGNAL_SCORE_DESC",
      "SPORT_PREFERENCE",
      "PROVIDER_MARKET_VOLUME_DESC",
      "PHYSICAL_EVENT_ID_ASC",
    ]
  | readonly ["PORTFOLIO_TIER_ASC", "PORTFOLIO_DECISION_AT_ASC", "PHYSICAL_EVENT_ID_ASC"];

export interface LiveReservationAllocationPolicy {
  readonly policyId: string;
  readonly minStartLeadMinutes: number;
  readonly targetReservationSlots: number;
  readonly hardReservationCeiling?: number;
  readonly preferredStrategicScopes: readonly string[];
  readonly rankingOrder: LiveReservationRankingOrder;
}

export interface LiveReservationAllocationCandidate {
  decision: ContractAPlanningDecision;
  providerMarketVolume: number | null;
  /** PORTFOLIO_BROAD only — the event's authoritative qualifying tier. */
  portfolioTier?: PortfolioBroadTier;
  /** PORTFOLIO_BROAD only — source_created_at of the winning qualifying identity. */
  portfolioDecisionAt?: string | null;
  /** PORTFOLIO_BROAD only — model evidence persisted verbatim, never re-derived downstream. */
  portfolioEntryPriceNum?: number | null;
  portfolioPreEventScoreNum?: number | null;
  portfolioConditionId?: string | null;
  portfolioTokenId?: string | null;
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

function isPortfolioBroadRankingOrder(policy: LiveReservationAllocationPolicy): boolean {
  return policy.rankingOrder[0] === "PORTFOLIO_TIER_ASC";
}

function comparePortfolioBroadCandidates(
  left: LiveReservationAllocationCandidate,
  right: LiveReservationAllocationCandidate,
): number {
  const leftTier = left.portfolioTier ?? Number.POSITIVE_INFINITY;
  const rightTier = right.portfolioTier ?? Number.POSITIVE_INFINITY;
  if (leftTier !== rightTier) return leftTier - rightTier;

  const leftAt = left.portfolioDecisionAt ?? "";
  const rightAt = right.portfolioDecisionAt ?? "";
  const atDiff = leftAt.localeCompare(rightAt);
  if (atDiff !== 0) return atDiff;

  return left.decision.physical_event_id.localeCompare(right.decision.physical_event_id);
}

export function compareLiveReservationAllocationCandidates(
  left: LiveReservationAllocationCandidate,
  right: LiveReservationAllocationCandidate,
  policy: LiveReservationAllocationPolicy = LIVE_RESERVATION_ALLOCATION_V1,
): number {
  if (isPortfolioBroadRankingOrder(policy)) {
    return comparePortfolioBroadCandidates(left, right);
  }

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

// ── PORTFOLIO_BROAD qualification (event-level Decision Policy) ─────────────

const PORTFOLIO_BROAD_PRICE_TIER12_MIN = 0.5;
const PORTFOLIO_BROAD_PRICE_TIER12_MAX_EXCLUSIVE = 0.52;
const PORTFOLIO_BROAD_PRICE_TIER3_MAX_EXCLUSIVE = 0.54;
const PORTFOLIO_BROAD_TIER1_SCORE_MIN = 63;
const PORTFOLIO_BROAD_TIER1_SCORE_MAX_EXCLUSIVE = 65;

/**
 * Exact PORTFOLIO_BROAD tier classification for ONE identity. Never invents a
 * missing pre_event_score_num — a missing score still permits Tier 1 for
 * TENNIS, and otherwise falls through to Tier 2 (price alone qualifies it).
 * Returns null when the identity does not qualify at all (price >= 0.54 or
 * price < 0.50).
 */
export function classifyPortfolioBroadTier(
  entryPriceNum: number,
  preEventScoreNum: number | null,
  strategicScope: string,
): PortfolioBroadTier | null {
  if (
    entryPriceNum >= PORTFOLIO_BROAD_PRICE_TIER12_MIN &&
    entryPriceNum < PORTFOLIO_BROAD_PRICE_TIER12_MAX_EXCLUSIVE
  ) {
    const scoreQualifiesTier1 =
      preEventScoreNum != null &&
      preEventScoreNum >= PORTFOLIO_BROAD_TIER1_SCORE_MIN &&
      preEventScoreNum < PORTFOLIO_BROAD_TIER1_SCORE_MAX_EXCLUSIVE;
    if (strategicScope === "TENNIS" || scoreQualifiesTier1) return 1;
    return 2;
  }
  if (
    entryPriceNum >= PORTFOLIO_BROAD_PRICE_TIER12_MAX_EXCLUSIVE &&
    entryPriceNum < PORTFOLIO_BROAD_PRICE_TIER3_MAX_EXCLUSIVE
  ) {
    return 3;
  }
  return null;
}

export interface PortfolioBroadSourceRowFields {
  condition_id: string;
  token_id: string;
  entry_price_num: number;
  pre_event_score_num: number | null;
  source_created_at: string | null;
}

/**
 * ONE accepted Contract A Planning Decision, resolved to its exact source
 * row's model evidence and PORTFOLIO_BROAD tier. Never a raw row that did NOT
 * produce an accepted decision.
 */
export interface PortfolioBroadIdentityCandidate {
  decision: ContractAPlanningDecision;
  tier: PortfolioBroadTier;
  row: PortfolioBroadSourceRowFields;
}

/** Chronological-first tie-break within a tier: source_created_at ASC, condition_id ASC, token_id ASC. */
function comparePortfolioBroadIdentities(
  a: PortfolioBroadIdentityCandidate,
  b: PortfolioBroadIdentityCandidate,
): number {
  return (
    (a.row.source_created_at ?? "").localeCompare(b.row.source_created_at ?? "") ||
    a.row.condition_id.localeCompare(b.row.condition_id) ||
    a.row.token_id.localeCompare(b.row.token_id)
  );
}

export interface PortfolioBroadPhysicalEventAllocation {
  physical_event_id: string;
  decision: ContractAPlanningDecision;
  portfolio_policy_id: string;
  portfolio_tier: PortfolioBroadTier;
  portfolio_decision_at: string | null;
  portfolio_entry_price_num: number;
  portfolio_pre_event_score_num: number | null;
  portfolio_condition_id: string;
  portfolio_token_id: string;
}

export interface PortfolioBroadResolution {
  /** One entry per accepted physical event that has at least one qualifying identity. */
  qualified: Map<string, PortfolioBroadPhysicalEventAllocation>;
  /** Accepted physical events with zero qualifying identities. */
  notQualifiedPhysicalEventIds: string[];
}

/**
 * PURE resolver. Considers ONLY decisions already present in `acceptedDecisions`
 * (the caller is responsible for restricting this to Contract A ACCEPTED
 * Planning Decisions — never a rejected one). Each decision is correlated back
 * to its exact source row via canonical lineage
 * (generated_signal_pair_id -> row.id, falling back to observation_id ->
 * condition_id::token_id), mirroring providerVolumeByPhysicalEventId's exact
 * correlation. A decision whose source row cannot be resolved, or whose
 * resolved row does not qualify any tier, contributes nothing. For each
 * physical event, the authoritative tier is the lowest (highest-priority)
 * qualifying tier number; ties within that tier are broken chronologically.
 */
export function resolvePortfolioBroadPhysicalEventAllocations(
  acceptedDecisions: readonly ContractAPlanningDecision[],
  sourceRows: readonly Record<string, unknown>[],
  policyId: string = LIVE_RESERVATION_PORTFOLIO_BROAD_V2.policyId,
): PortfolioBroadResolution {
  const rowsById = new Map<string, Record<string, unknown>>();
  const rowsByObservation = new Map<string, Record<string, unknown>>();
  for (const row of sourceRows) {
    if (typeof row.id === "string" && row.id) rowsById.set(row.id, row);
    const conditionId = typeof row.condition_id === "string" ? row.condition_id : "";
    const tokenId = typeof row.selected_token_id === "string" ? row.selected_token_id : "";
    if (conditionId && tokenId) rowsByObservation.set(`${conditionId}::${tokenId}`, row);
  }

  const byPhysicalEvent = new Map<string, PortfolioBroadIdentityCandidate[]>();
  const acceptedPhysicalEventIds = new Set<string>();

  for (const decision of acceptedDecisions) {
    acceptedPhysicalEventIds.add(decision.physical_event_id);
    const lineage = decision.source_lineage;
    const row =
      (lineage.generated_signal_pair_id ? rowsById.get(lineage.generated_signal_pair_id) : undefined) ??
      (lineage.observation_id ? rowsByObservation.get(lineage.observation_id) : undefined);
    if (!row) continue;

    const conditionId = typeof row.condition_id === "string" ? row.condition_id : null;
    const tokenId = typeof row.selected_token_id === "string" ? row.selected_token_id : null;
    const entryPriceNum =
      typeof row.entry_price_num === "number" && Number.isFinite(row.entry_price_num)
        ? row.entry_price_num
        : null;
    if (conditionId === null || tokenId === null || entryPriceNum === null) continue;
    const preEventScoreNum =
      typeof row.pre_event_score_num === "number" && Number.isFinite(row.pre_event_score_num)
        ? row.pre_event_score_num
        : null;
    const sourceCreatedAt = typeof row.created_at === "string" ? row.created_at : null;

    const tier = classifyPortfolioBroadTier(entryPriceNum, preEventScoreNum, decision.strategic_scope);
    if (tier === null) continue;

    const candidate: PortfolioBroadIdentityCandidate = {
      decision,
      tier,
      row: {
        condition_id: conditionId,
        token_id: tokenId,
        entry_price_num: entryPriceNum,
        pre_event_score_num: preEventScoreNum,
        source_created_at: sourceCreatedAt,
      },
    };
    const list = byPhysicalEvent.get(decision.physical_event_id);
    if (list) list.push(candidate);
    else byPhysicalEvent.set(decision.physical_event_id, [candidate]);
  }

  const qualified = new Map<string, PortfolioBroadPhysicalEventAllocation>();
  for (const [physicalEventId, candidates] of byPhysicalEvent) {
    const minTier = Math.min(...candidates.map((c) => c.tier)) as PortfolioBroadTier;
    const atMinTier = candidates.filter((c) => c.tier === minTier);
    atMinTier.sort(comparePortfolioBroadIdentities);
    const winner = atMinTier[0];
    qualified.set(physicalEventId, {
      physical_event_id: physicalEventId,
      decision: winner.decision,
      portfolio_policy_id: policyId,
      portfolio_tier: winner.tier,
      portfolio_decision_at: winner.row.source_created_at,
      portfolio_entry_price_num: winner.row.entry_price_num,
      portfolio_pre_event_score_num: winner.row.pre_event_score_num,
      portfolio_condition_id: winner.row.condition_id,
      portfolio_token_id: winner.row.token_id,
    });
  }

  const notQualifiedPhysicalEventIds = [...acceptedPhysicalEventIds].filter(
    (id) => !qualified.has(id),
  );

  return { qualified, notQualifiedPhysicalEventIds };
}

export function resultsToAcceptedDecisions(
  results: readonly ContractADecisionResult<ContractAPlanningDecision>[],
): ContractAPlanningDecision[] {
  const accepted: ContractAPlanningDecision[] = [];
  for (const result of results) {
    if (result.accepted) accepted.push(result.decision);
  }
  return accepted;
}
