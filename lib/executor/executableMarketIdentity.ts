// lib/executor/executableMarketIdentity.ts
//
// CANONICAL IMMUTABLE EXECUTION IDENTITY CONTRACT (R0E).
//
// One shared decision type backs the whole live-money chain:
//
//   production source observation
//     -> canonical market selection            (planning)
//     -> ExecutableMarketIdentityDecision      (this module)
//     -> Reservation stores the exact identity (nightEventReservations)
//     -> rebalance reloads and VALIDATES it    (eventExecutionQueue)
//     -> queue copies the identity verbatim    (buildQueueRow)
//     -> Ireland receives exact condition_id/token_id/side
//
// Hard invariants enforced here and by its callers:
//   1. No complete identity -> no Reservation row (the slot is not consumed).
//   2. Strings never determine execution after identity creation.
//   3. The Reservation stores the exact resolved identity.
//   4. Rebalance validates the stored identity; it never substitutes a
//      different market (no slug/title/lineage rediscovery).
//   5. The queue copies the stored identity verbatim.
//   6. Display titles/slugs are diagnostics only.
//   7. A string mismatch may BLOCK execution; it may never select another token.
//   8. No synthetic or defaulted IDs -- absent means rejected.
//
// Pure: no DB, no network, no clock.

import type { FireModelCandidate } from "./buildFireModelCandidates";

export type ExecutableMarketIdentityReasonCode =
  | "CONDITION_ID_MISSING"
  | "TOKEN_ID_MISSING"
  | "SIDE_MISSING"
  | "PHYSICAL_EVENT_ID_MISSING"
  | "MARKET_NOT_IN_AUTHORITATIVE_UNIVERSE"
  | "MARKET_ANCHOR_REJECTED"
  | "NO_IDENTITY_COMPLETE_REPRESENTATIVE"
  | "IDENTITY_NOT_PERSISTED"
  | "SOURCE_CHANGED_SINCE_PLANNING";

/** The immutable execution identity of exactly one market outcome. */
export interface ExecutableMarketIdentity {
  physicalEventKey: string;
  conditionId: string;
  tokenId: string;
  side: string;
  marketType: string;
  marketFamily: string;
  sourceObservationId: string;
  sourceSignalId?: string;
  snapshotId?: string;
}

export type ExecutableMarketIdentityDecision =
  | ({ allowed: true } & ExecutableMarketIdentity)
  | {
      allowed: false;
      reasonCode: ExecutableMarketIdentityReasonCode;
      sourceStage: string;
    };

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

function reject(
  reasonCode: ExecutableMarketIdentityReasonCode,
  sourceStage: string
): ExecutableMarketIdentityDecision {
  return { allowed: false, reasonCode, sourceStage };
}

/**
 * Resolve the immutable execution identity of one candidate.
 *
 * The authoritative provenance block (diagnostics.authoritative_*) wins when
 * present; otherwise the candidate's own condition_id/token_id/side are used.
 * Both are read directly -- nothing is derived from a title, slug, or key, and
 * no value is ever defaulted or synthesized.
 *
 * `anchorAllowed=false` means the caller's canonical market-anchor policy
 * rejected this market (activity label, halftime/corners/props, non-full-match
 * submarket). Such a market can never carry an execution identity even when its
 * condition/token/side are fully populated -- see the KC handicap regression.
 */
export function resolveExecutableMarketIdentity(input: {
  candidate: FireModelCandidate;
  physicalEventKey: string | null;
  sourceStage: string;
  anchorAllowed: boolean;
  /** false when the candidate is outside the authoritative execution universe. */
  inAuthoritativeUniverse?: boolean;
}): ExecutableMarketIdentityDecision {
  const { candidate, sourceStage } = input;
  const diag = candidate.diagnostics ?? ({} as FireModelCandidate["diagnostics"]);

  const physicalEventKey =
    trimmedOrNull(input.physicalEventKey) ?? trimmedOrNull(diag.authoritative_event_key);
  if (physicalEventKey === null) return reject("PHYSICAL_EVENT_ID_MISSING", sourceStage);

  if (input.inAuthoritativeUniverse === false) {
    return reject("MARKET_NOT_IN_AUTHORITATIVE_UNIVERSE", sourceStage);
  }
  if (!input.anchorAllowed) return reject("MARKET_ANCHOR_REJECTED", sourceStage);

  const conditionId =
    trimmedOrNull(diag.authoritative_condition_id) ?? trimmedOrNull(candidate.condition_id);
  if (conditionId === null) return reject("CONDITION_ID_MISSING", sourceStage);

  const tokenId = trimmedOrNull(diag.authoritative_token_id) ?? trimmedOrNull(candidate.token_id);
  if (tokenId === null) return reject("TOKEN_ID_MISSING", sourceStage);

  const side =
    trimmedOrNull(diag.authoritative_side) ??
    trimmedOrNull(candidate.side) ??
    trimmedOrNull(candidate.selected_outcome);
  if (side === null) return reject("SIDE_MISSING", sourceStage);

  const sourceObservationId =
    trimmedOrNull(diag.authoritative_observation_id) ?? trimmedOrNull(candidate.signal_id);
  if (sourceObservationId === null) return reject("PHYSICAL_EVENT_ID_MISSING", sourceStage);

  return {
    allowed: true,
    physicalEventKey,
    conditionId,
    tokenId,
    side,
    marketType: candidate.strategy,
    marketFamily: candidate.market_family,
    sourceObservationId,
    ...(trimmedOrNull(candidate.generated_signal_pair_id) !== null
      ? { sourceSignalId: (candidate.generated_signal_pair_id as string).trim() }
      : {}),
    ...(trimmedOrNull(candidate.signal_id) !== null ? { snapshotId: candidate.signal_id.trim() } : {}),
  };
}

export interface IdentityCompleteRepresentative {
  candidate: FireModelCandidate;
  identity: ExecutableMarketIdentity;
}

/**
 * Deterministically pick the representative of one physical event: the FIRST
 * candidate in the caller's already-ranked order whose identity resolves.
 * Ranking is the caller's (compareCandidateQuality); this function only filters,
 * so a lower-ranked identity-complete representation deterministically wins over
 * a higher-ranked incomplete one instead of the group being lost.
 *
 * Returns the winning representative, or the rejection decision of the
 * best-ranked candidate (falling back to NO_IDENTITY_COMPLETE_REPRESENTATIVE)
 * so the caller can report an exact reason code.
 */
export function selectIdentityCompleteRepresentative(
  rankedGroup: readonly FireModelCandidate[],
  input: {
    physicalEventKey: string | null;
    sourceStage: string;
    anchorAllowed: (candidate: FireModelCandidate) => boolean;
    inAuthoritativeUniverse?: (candidate: FireModelCandidate) => boolean;
  }
): { selected: IdentityCompleteRepresentative | null; rejection: ExecutableMarketIdentityDecision } {
  let firstRejection: ExecutableMarketIdentityDecision | null = null;
  for (const candidate of rankedGroup) {
    const decision = resolveExecutableMarketIdentity({
      candidate,
      physicalEventKey: input.physicalEventKey,
      sourceStage: input.sourceStage,
      anchorAllowed: input.anchorAllowed(candidate),
      inAuthoritativeUniverse: input.inAuthoritativeUniverse
        ? input.inAuthoritativeUniverse(candidate)
        : undefined,
    });
    if (decision.allowed) {
      const { allowed: _allowed, ...identity } = decision;
      return { selected: { candidate, identity }, rejection: decision };
    }
    if (firstRejection === null) firstRejection = decision;
  }
  return {
    selected: null,
    rejection:
      firstRejection ?? reject("NO_IDENTITY_COMPLETE_REPRESENTATIVE", input.sourceStage),
  };
}

/**
 * The exact diagnostics fragment persisted into night_event_reservations.diagnostics
 * (an existing JSONB column -- no schema migration). Field names are the
 * established authoritative_* provenance keys so every existing reader keeps
 * working; the identity_* keys are the canonical contract fields.
 */
export function buildPersistedIdentityDiagnostics(
  identity: ExecutableMarketIdentity
): Record<string, unknown> {
  return {
    authoritative_condition_id: identity.conditionId,
    authoritative_token_id: identity.tokenId,
    authoritative_side: identity.side,
    authoritative_observation_id: identity.sourceObservationId,
    authoritative_event_key: identity.physicalEventKey,
    identity_physical_event_key: identity.physicalEventKey,
    identity_market_type: identity.marketType,
    identity_market_family: identity.marketFamily,
    ...(identity.sourceSignalId !== undefined ? { identity_source_signal_id: identity.sourceSignalId } : {}),
    ...(identity.snapshotId !== undefined ? { identity_snapshot_id: identity.snapshotId } : {}),
  };
}

/**
 * Read back the identity a Reservation (or queue row) persisted. Never falls
 * back to slug/title/lineage: an absent field is IDENTITY_NOT_PERSISTED, which
 * fails closed rather than triggering a rediscovery.
 */
export function readPersistedExecutableIdentity(
  diagnostics: Record<string, unknown> | null | undefined,
  sourceStage: string
): ExecutableMarketIdentityDecision {
  const diag = diagnostics ?? {};
  const conditionId = trimmedOrNull(diag.authoritative_condition_id);
  const tokenId = trimmedOrNull(diag.authoritative_token_id);
  const side = trimmedOrNull(diag.authoritative_side);
  const physicalEventKey =
    trimmedOrNull(diag.identity_physical_event_key) ?? trimmedOrNull(diag.authoritative_event_key);
  const sourceObservationId = trimmedOrNull(diag.authoritative_observation_id);

  if (conditionId === null && tokenId === null && side === null) {
    return reject("IDENTITY_NOT_PERSISTED", sourceStage);
  }
  if (conditionId === null) return reject("CONDITION_ID_MISSING", sourceStage);
  if (tokenId === null) return reject("TOKEN_ID_MISSING", sourceStage);
  if (side === null) return reject("SIDE_MISSING", sourceStage);
  if (physicalEventKey === null) return reject("PHYSICAL_EVENT_ID_MISSING", sourceStage);
  if (sourceObservationId === null) return reject("IDENTITY_NOT_PERSISTED", sourceStage);

  return {
    allowed: true,
    physicalEventKey,
    conditionId,
    tokenId,
    side,
    marketType: trimmedOrNull(diag.identity_market_type) ?? "",
    marketFamily: trimmedOrNull(diag.identity_market_family) ?? "",
    sourceObservationId,
    ...(trimmedOrNull(diag.identity_source_signal_id) !== null
      ? { sourceSignalId: trimmedOrNull(diag.identity_source_signal_id) as string }
      : {}),
    ...(trimmedOrNull(diag.identity_snapshot_id) !== null
      ? { snapshotId: trimmedOrNull(diag.identity_snapshot_id) as string }
      : {}),
  };
}

/**
 * Exact-ID equality of two execution identities. Titles, slugs, scores and
 * market labels are deliberately NOT compared: a display-string difference must
 * never fail parity, and a different ID must always fail it.
 */
export function executionIdentitiesMatch(
  a: Pick<ExecutableMarketIdentity, "conditionId" | "tokenId" | "side">,
  b: Pick<ExecutableMarketIdentity, "conditionId" | "tokenId" | "side">
): boolean {
  return a.conditionId === b.conditionId && a.tokenId === b.tokenId && a.side === b.side;
}

/**
 * Locate the candidate in the authoritative universe that IS the stored
 * identity -- exact condition_id/token_id/side equality only. More than one
 * match is ambiguous and fails closed. Never matches by slug, title, event key,
 * or source lineage, so this can only ever confirm the stored market; it can
 * never substitute a different one.
 */
export function findCandidateForStoredIdentity(
  identity: Pick<ExecutableMarketIdentity, "conditionId" | "tokenId" | "side">,
  universe: readonly FireModelCandidate[]
): { candidate: FireModelCandidate | null; ambiguityCount: number } {
  const matches = universe.filter((c) =>
    executionIdentitiesMatch(
      { conditionId: c.condition_id, tokenId: c.token_id, side: c.side },
      identity
    )
  );
  if (matches.length === 1) return { candidate: matches[0], ambiguityCount: 1 };
  return { candidate: null, ambiguityCount: matches.length };
}

/** Deterministic, PII-free trace id built from real IDs (never "unknown"). */
export function buildIdentityBattleTraceId(
  planRunId: string,
  identity: ExecutableMarketIdentity
): string {
  return `contur3:${planRunId}:${identity.physicalEventKey}:${identity.conditionId}:${identity.tokenId}`;
}
