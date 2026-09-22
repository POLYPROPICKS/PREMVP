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
 * identities via PORTFOLIO_TIER price/score band qualification (see
 * classifyPortfolioBroadTier + resolvePortfolioBroadPhysicalEventAllocations)
 * -- qualification/tier remains diagnostic evidence on the winning identity,
 * but capacity across physical events is ordered by Signal Score first
 * (RESTORE_SIGNAL_SCORE_AND_FOOTBALL_RESERVATION_PRIORITY_V1): highest
 * planning Signal Score wins, football (SOCCER/WC) is preferred at equal
 * score, then freshest source evidence, then provider volume, then physical
 * event id. Portfolio tier never overrides a higher Signal Score here.
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
  preferredStrategicScopes: ["SOCCER", "WC"] as const,
  rankingOrder: [
    "SIGNAL_SCORE_DESC",
    "FOOTBALL_PRIORITY",
    "FRESHEST_SOURCE_EVIDENCE_DESC",
    "PROVIDER_MARKET_VOLUME_DESC",
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
  | readonly [
      "SIGNAL_SCORE_DESC",
      "FOOTBALL_PRIORITY",
      "FRESHEST_SOURCE_EVIDENCE_DESC",
      "PROVIDER_MARKET_VOLUME_DESC",
      "PHYSICAL_EVENT_ID_ASC",
    ];

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

function isPortfolioBroadPolicyId(policy: LiveReservationAllocationPolicy): boolean {
  return policy.policyId === LIVE_RESERVATION_PORTFOLIO_BROAD_V2.policyId;
}

/**
 * PORTFOLIO_BROAD capacity ranking across physical events
 * (RESTORE_SIGNAL_SCORE_AND_FOOTBALL_RESERVATION_PRIORITY_V1): Signal Score
 * first, football preference second, then freshest-source, provider volume
 * and physical event id as deterministic tie-breaks. Portfolio tier is
 * qualification/diagnostic evidence only here -- it never overrides a higher
 * Signal Score.
 */
function comparePortfolioBroadCandidates(
  left: LiveReservationAllocationCandidate,
  right: LiveReservationAllocationCandidate,
  policy: LiveReservationAllocationPolicy,
): number {
  const scoreDiff = right.decision.planning_score - left.decision.planning_score;
  if (scoreDiff !== 0) return scoreDiff;

  const sportDiff =
    sportPriority(left.decision.strategic_scope, policy) -
    sportPriority(right.decision.strategic_scope, policy);
  if (sportDiff !== 0) return sportDiff;

  const leftAt = left.portfolioDecisionAt ?? "";
  const rightAt = right.portfolioDecisionAt ?? "";
  const atDiff = rightAt.localeCompare(leftAt);
  if (atDiff !== 0) return atDiff;

  const leftVolume = finiteVolumeOrBottom(left.providerMarketVolume);
  const rightVolume = finiteVolumeOrBottom(right.providerMarketVolume);
  if (leftVolume !== rightVolume) {
    if (leftVolume === Number.NEGATIVE_INFINITY) return 1;
    if (rightVolume === Number.NEGATIVE_INFINITY) return -1;
    return rightVolume > leftVolume ? 1 : -1;
  }

  return left.decision.physical_event_id.localeCompare(right.decision.physical_event_id);
}

export function compareLiveReservationAllocationCandidates(
  left: LiveReservationAllocationCandidate,
  right: LiveReservationAllocationCandidate,
  policy: LiveReservationAllocationPolicy = LIVE_RESERVATION_ALLOCATION_V1,
): number {
  if (isPortfolioBroadPolicyId(policy)) {
    return comparePortfolioBroadCandidates(left, right, policy);
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
 * missing pre_event_score_num — a missing score falls through to Tier 2
 * (price alone qualifies it), for every strategic scope including TENNIS
 * (RESTORE_SIGNAL_SCORE_AND_FOOTBALL_RESERVATION_PRIORITY_V1 removes the
 * prior TENNIS-only automatic Tier 1 special case; tennis now qualifies Tier
 * 1 only via the same score band every other sport uses, never automatically).
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
    if (scoreQualifiesTier1) return 1;
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
  /** Whether this identity's own expires_at was already <= the resolution snapshot time. Model evidence only -- never executable-identity authority. */
  is_expired_source: boolean;
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

/** Freshest-first tie-break within a tier: source_created_at DESC, condition_id ASC, token_id ASC. */
function comparePortfolioBroadIdentities(
  a: PortfolioBroadIdentityCandidate,
  b: PortfolioBroadIdentityCandidate,
): number {
  return (
    (b.row.source_created_at ?? "").localeCompare(a.row.source_created_at ?? "") ||
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
  portfolio_is_expired_source: boolean;
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
  snapshotAtIso: string = new Date().toISOString(),
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
    const isExpiredSource = typeof row.expires_at === "string" && row.expires_at <= snapshotAtIso;

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
        is_expired_source: isExpiredSource,
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
      portfolio_is_expired_source: winner.row.is_expired_source,
    });
  }

  const notQualifiedPhysicalEventIds = [...acceptedPhysicalEventIds].filter(
    (id) => !qualified.has(id),
  );

  return { qualified, notQualifiedPhysicalEventIds };
}

// ── LIVE MIX GUARD (RESERVATION_MIX_GUARD_V1) ───────────────────────────────
//
// Reservation allocation must keep football (SOCCER/WC) the dominant share of
// live money while capping TENNIS's share, without ever letting either bound
// widen the cap. Priority order when filling slots is always
// football -> eligible tennis -> other qualified sports; when the available
// candidates cannot fill the cap while respecting both ratios, the final
// reservation count N shrinks rather than violating either bound.

export interface LiveReservationMixGuardConfig {
  /** Hard ceiling on the final reservation count N. */
  readonly cap: number;
  /** football share of N must be STRICTLY GREATER than this fraction. */
  readonly footballMinShareExclusive: number;
  /** tennis share of N must be STRICTLY LESS than this fraction. */
  readonly tennisMaxShareExclusive: number;
}

/** Production default: cap 30, football > 65%, tennis < 25%. */
export const LIVE_RESERVATION_MIX_GUARD_V1: LiveReservationMixGuardConfig = Object.freeze({
  cap: 30,
  footballMinShareExclusive: 0.65,
  tennisMaxShareExclusive: 0.25,
});

export interface LiveReservationMixGuardResult<T> {
  selected: T[];
  footballCount: number;
  tennisCount: number;
  otherCount: number;
  finalN: number;
}

/** Smallest football count strictly greater than footballMinShareExclusive * n. */
function minFootballForN(n: number, footballMinShareExclusive: number): number {
  if (n <= 0) return 0;
  return Math.floor(n * footballMinShareExclusive) + 1;
}

/** Largest tennis count strictly less than tennisMaxShareExclusive * n. */
function maxTennisForN(n: number, tennisMaxShareExclusive: number): number {
  if (n <= 0) return 0;
  return Math.max(0, Math.ceil(n * tennisMaxShareExclusive) - 1);
}

/**
 * Pure slot-mix selector. Operates on three already-ranked pools (highest
 * priority first within each pool) and returns the largest N <= cap for
 * which a valid football/tennis/other split exists -- football maximized
 * first (priority + it can only help the football-share floor), then
 * tennis up to its share ceiling, then other filling any remainder.
 *
 * football has no upper bound (more football only strengthens its own
 * floor), tennis is bounded above by maxTennisForN, and N shrinks from the
 * cap downward until a feasible split is found (or N=0).
 */
export function selectLiveReservationMix<T>(
  footballRanked: readonly T[],
  eligibleTennisRanked: readonly T[],
  otherQualifiedRanked: readonly T[],
  config: LiveReservationMixGuardConfig = LIVE_RESERVATION_MIX_GUARD_V1,
): LiveReservationMixGuardResult<T> {
  const cap = Math.max(0, Math.floor(config.cap));
  const maxPossibleN = Math.min(
    cap,
    footballRanked.length + eligibleTennisRanked.length + otherQualifiedRanked.length,
  );

  for (let n = maxPossibleN; n > 0; n--) {
    const footballCount = Math.min(footballRanked.length, n);
    const remainingAfterFootball = n - footballCount;
    const tennisCap = maxTennisForN(n, config.tennisMaxShareExclusive);
    const tennisCount = Math.min(eligibleTennisRanked.length, tennisCap, remainingAfterFootball);
    const remainingAfterTennis = remainingAfterFootball - tennisCount;
    const otherCount = Math.min(otherQualifiedRanked.length, remainingAfterTennis);

    if (footballCount + tennisCount + otherCount !== n) continue;
    if (footballCount < minFootballForN(n, config.footballMinShareExclusive)) continue;

    return {
      selected: [
        ...footballRanked.slice(0, footballCount),
        ...eligibleTennisRanked.slice(0, tennisCount),
        ...otherQualifiedRanked.slice(0, otherCount),
      ],
      footballCount,
      tennisCount,
      otherCount,
      finalN: n,
    };
  }

  return { selected: [], footballCount: 0, tennisCount: 0, otherCount: 0, finalN: 0 };
}

function isFootballScope(scope: string): boolean {
  return scope === "SOCCER" || scope === "WC";
}

/**
 * Apply the mix guard to an already fully-ranked candidate list (e.g.
 * rankAllocatableApprovedPhysicalEvents's rankedDistinct), preserving the
 * original relative rank order of whichever candidates survive the guard.
 *
 * A no-op when no TENNIS candidate is present: the guard exists to bound
 * TENNIS's share against football, so a football/other-only night (the
 * overwhelming majority of nights before TENNIS went money-eligible) keeps
 * its existing unmixed top-N-by-score behavior exactly, cap included.
 */
export function applyLiveReservationMixGuard(
  rankedDistinct: readonly LiveReservationAllocationCandidate[],
  config: LiveReservationMixGuardConfig = LIVE_RESERVATION_MIX_GUARD_V1,
): LiveReservationAllocationCandidate[] {
  const football: LiveReservationAllocationCandidate[] = [];
  const tennis: LiveReservationAllocationCandidate[] = [];
  const other: LiveReservationAllocationCandidate[] = [];
  for (const candidate of rankedDistinct) {
    const scope = candidate.decision.strategic_scope;
    if (isFootballScope(scope)) football.push(candidate);
    else if (scope === "TENNIS") tennis.push(candidate);
    else other.push(candidate);
  }

  if (tennis.length === 0) {
    return rankedDistinct.slice();
  }

  const { selected } = selectLiveReservationMix(football, tennis, other, config);
  const selectedSet = new Set(selected);
  return rankedDistinct.filter((candidate) => selectedSet.has(candidate));
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
