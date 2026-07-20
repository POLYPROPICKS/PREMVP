// Frozen Execution Contract Bridge (Integration Milestone 2B). Pure,
// read-only, side-effect-free comparator between:
//   (a) the FROZEN Model V2 shadow decisions (produceFrozenModelV2ShadowDecisions
//       from lib/modeling/frozenModelProducerV2Shadow.ts -- never re-implemented
//       or reimported thresholds here), and
//   (b) Contur3's current planning-candidate construction
//       (FireModelCandidate[] as produced by
//       lib/executor/buildFireModelCandidates.ts).
//
// This module NEVER touches reservations/queue/callbacks/Ireland/CLOB, and
// never mutates either producer's output. It only groups both sides by
// canonical physical-event identity (buildEventGroupKey, reused verbatim --
// no locally invented event-key heuristic) and classifies each event-level
// pairing.
//
// Field-name mapping (frozen decision -> Contur3 candidate):
//   frozen.eventKey            <-> buildEventGroupKey(candidate) [canonical_event_key /
//                                   event_slug / match_family_key fallback chain]
//   (frozen decisions do not carry condition_id/token_id directly in the
//   FrozenModelV2Decision type -- see NOTE below)
//   frozen.selectedOutcome     <-> candidate.selected_outcome ?? candidate.side
//   frozen.entryPrice          <-> candidate.max_entry_price (price policy ceiling)
//   frozen.minutesUntilStart   <-> candidate.timing_bucket (eligible window)
//
// NOTE on condition_id/token_id: FrozenModelV2Decision (the frozen model's
// OWN output type) intentionally does not carry condition_id/token_id --
// only observationId (the strict dedup key) and eventKey. Those identity
// fields live on the raw export row that was fed into the frozen model, not
// on the decision itself. To classify CONDITION_ID_MISMATCH / TOKEN_ID_MISMATCH
// / SIDE_MISMATCH precisely, this module accepts the frozen SOURCE ROWS
// alongside the frozen DECISIONS (see FrozenSidePairing) and reads
// condition_id/token_id/selected_outcome off the row that produced each
// accepted decision (matched by observationId), never off decision-derived
// heuristics and never by re-deriving them from scratch.

import type { ExportRow } from "./generatedSignalPairsExportContract";
import {
  getStrictDedupKeyForExportRow,
} from "./generatedSignalPairsExportContract";
import type { FrozenModelV2Decision } from "./frozenModelProducerV2Shadow";
import { buildEventGroupKey, type EventGroupRow } from "./eventGroupSelection";

// ---- Minimal structural slice of the real FireModelCandidate contract ----
// (imported as a TYPE at the call sites that construct real fixtures; this
// module itself only depends on the field names it actually reads, kept in
// sync with lib/executor/buildFireModelCandidates.ts's exported interface.)
export interface Contur3CandidateSlice {
  condition_id: string;
  token_id: string;
  side: string;
  selected_outcome: string | null;
  market_slug: string;
  canonical_market_key: string | null;
  canonical_event_key: string | null;
  match_family_key: string;
  event_slug: string | null;
  max_entry_price: number;
  timing_bucket: string;
  inferred_sport: string;
  market_family: string;
}

export type ClassificationCode =
  | "EXACT_EXECUTION_COMPATIBLE"
  | "SAME_EVENT_DIFFERENT_MARKET"
  | "FROZEN_ONLY"
  | "CONTUR3_ONLY"
  | "CONDITION_ID_MISMATCH"
  | "TOKEN_ID_MISMATCH"
  | "SIDE_MISMATCH"
  | "EVENT_IDENTITY_GAP"
  | "PRICE_POLICY_GAP"
  | "TIME_WINDOW_GAP"
  | "MARKET_TAXONOMY_GAP"
  | "MISSING_EXECUTION_FIELDS";

export interface ComparisonRow {
  eventKey: string;
  classification: ClassificationCode;
  frozenObservationId: string | null;
  frozenSelectedOutcome: string | null;
  frozenEntryPrice: number | null;
  frozenMinutesUntilStart: number | null;
  frozenConditionId: string | null;
  frozenTokenId: string | null;
  contur3ConditionId: string | null;
  contur3TokenId: string | null;
  contur3Side: string | null;
  contur3MarketSlug: string | null;
  contur3MaxEntryPrice: number | null;
  contur3TimingBucket: string | null;
  contur3InferredSport: string | null;
  contur3MarketFamily: string | null;
}

export interface FrozenSidePairing {
  decision: FrozenModelV2Decision;
  sourceRow: ExportRow;
}

export interface BridgeComparisonSummary {
  eventCount: number;
  classificationCounts: Record<ClassificationCode, number>;
  rows: ComparisonRow[];
}

// Timing-bucket eligible-window boundaries (minutes), mirroring the
// TimingBucket taxonomy documented on FireModelCandidate. Read-only mapping,
// never a re-derivation of Contur3's own bucket-assignment logic.
const TIMING_BUCKET_MAX_MINUTES: Record<string, number> = {
  T_0_30M: 30,
  T_30_60M: 60,
  T_1_2H: 120,
  T_2_6H: 360,
  T_6H_PLUS: Number.POSITIVE_INFINITY,
  STARTED_OR_MISSING: 0,
};

/**
 * Normalizes a buildEventGroupKey() result for CROSS-SIDE comparison.
 *
 * buildEventGroupKey() prefixes its key with the source field it fell back
 * to (e.g. "match:nba-team-a-vs-team-b" from match_family_key vs
 * "slug:nba-team-a-vs-team-b" from event_slug). The frozen side's decisions
 * are keyed off the RAW export row (which typically does not carry a
 * precomputed match_family_key -- that field is derived by
 * buildFireModelCandidates itself from the raw row, not stored on it), while
 * the Contur3 side's candidates DO carry match_family_key. Comparing the raw
 * prefixed keys would therefore almost always report FROZEN_ONLY/
 * CONTUR3_ONLY for the exact same physical event purely because the two
 * sides fell back to different fields in the same priority chain -- not
 * because the events actually differ.
 *
 * To group correctly while still reusing buildEventGroupKey verbatim (never
 * inventing a new event-key heuristic), this strips the source-field prefix
 * and compares on the normalized identity text only. The frozen model's own
 * eventKey (used inside FrozenModelV2Decision, e.g. for its one-per-event
 * dedup) is untouched -- this normalization is local to the bridge's
 * cross-side grouping only.
 */
function normalizedPhysicalEventIdentity(key: string): string {
  const idx = key.indexOf(":");
  return idx === -1 ? key : key.slice(idx + 1);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function frozenSourceIdentity(row: ExportRow): { conditionId: string | null; tokenId: string | null; selectedOutcome: string | null } {
  const conditionId = str(row.condition_id) ?? str(row.conditionId);
  const tokenId = str(row.token_id) ?? str(row.tokenId);
  const selectedOutcome = str(row.selected_outcome) ?? str(row.selectedOutcome);
  return { conditionId, tokenId, selectedOutcome };
}

/**
 * Groups frozen (decision, sourceRow) pairs by canonical physical-event
 * identity, matched by observationId (the frozen model's own strict dedup
 * key). Pairings whose source row cannot be located by observationId are
 * dropped defensively (should not happen given accepted decisions always
 * originate from a row in the same input set) rather than crashing.
 */
function pairFrozenDecisionsWithSourceRows(
  decisions: readonly FrozenModelV2Decision[],
  sourceRows: readonly ExportRow[],
): FrozenSidePairing[] {
  const byObservationId = new Map<string, ExportRow>();
  for (const row of sourceRows) {
    const key = getStrictDedupKeyForExportRow(row);
    if (key !== null && !byObservationId.has(key)) byObservationId.set(key, row);
  }
  const pairings: FrozenSidePairing[] = [];
  for (const decision of decisions) {
    const sourceRow = byObservationId.get(decision.observationId);
    if (sourceRow === undefined) continue;
    pairings.push({ decision, sourceRow });
  }
  return pairings;
}

function classificationCounts(): Record<ClassificationCode, number> {
  return {
    EXACT_EXECUTION_COMPATIBLE: 0,
    SAME_EVENT_DIFFERENT_MARKET: 0,
    FROZEN_ONLY: 0,
    CONTUR3_ONLY: 0,
    CONDITION_ID_MISMATCH: 0,
    TOKEN_ID_MISMATCH: 0,
    SIDE_MISMATCH: 0,
    EVENT_IDENTITY_GAP: 0,
    PRICE_POLICY_GAP: 0,
    TIME_WINDOW_GAP: 0,
    MARKET_TAXONOMY_GAP: 0,
    MISSING_EXECUTION_FIELDS: 0,
  };
}

/**
 * Classifies one event's frozen-side vs Contur3-side pairing. Precedence
 * order (first matching rule wins -- deterministic, no ambiguity):
 *   1. FROZEN_ONLY / CONTUR3_ONLY -- present on only one side.
 *   2. MISSING_EXECUTION_FIELDS -- defensive fail-closed handling: either
 *      side is missing a field required to ever become a queue candidate
 *      (condition_id/token_id/selected_outcome). This should already be
 *      structurally impossible on the frozen side (the frozen model fails
 *      closed on these fields before ever emitting a decision) -- see
 *      tests/modeling/frozenExecutionContractBridge.test.ts's proof test --
 *      but the comparator itself must never crash if it ever occurs on
 *      either side, including a malformed Contur3-side fixture.
 *   3. condition_id mismatch -> CONDITION_ID_MISMATCH.
 *   4. condition_id matches, token_id differs -> TOKEN_ID_MISMATCH.
 *   5. token_id matches, side/selected_outcome differs -> SIDE_MISMATCH.
 *   6. All three match exactly -> check market identity: if the
 *      canonical_market_key/market_slug on the Contur3 side is a materially
 *      different market than what the frozen decision's identity implies
 *      (multiple distinct Contur3 markets exist for the same physical
 *      event) -> SAME_EVENT_DIFFERENT_MARKET; otherwise
 *      EXACT_EXECUTION_COMPATIBLE.
 *   7. Otherwise (identity fields present but none of the above triggered,
 *      e.g. taxonomy/timing/price gaps on an otherwise-identity-incomplete
 *      pairing) fall through to the generic gap checks: PRICE_POLICY_GAP,
 *      TIME_WINDOW_GAP, MARKET_TAXONOMY_GAP, and finally EVENT_IDENTITY_GAP
 *      as the last-resort catch-all.
 */
function classifyEvent(
  eventKey: string,
  frozenPairings: readonly FrozenSidePairing[],
  contur3Candidates: readonly Contur3CandidateSlice[],
): ComparisonRow[] {
  if (frozenPairings.length === 0 && contur3Candidates.length > 0) {
    return contur3Candidates.map((c) => baseRow(eventKey, null, c, "CONTUR3_ONLY"));
  }
  if (contur3Candidates.length === 0 && frozenPairings.length > 0) {
    return frozenPairings.map((f) => baseRow(eventKey, f, null, "FROZEN_ONLY"));
  }

  const rows: ComparisonRow[] = [];
  for (const frozen of frozenPairings) {
    const { conditionId: frozenConditionId, tokenId: frozenTokenId, selectedOutcome: frozenSelectedOutcome } =
      frozenSourceIdentity(frozen.sourceRow);

    // Defensive fail-closed: frozen side itself missing an execution field.
    if (frozenConditionId === null || frozenTokenId === null || frozenSelectedOutcome === null) {
      rows.push(baseRow(eventKey, frozen, null, "MISSING_EXECUTION_FIELDS"));
      continue;
    }

    let bestMatch: Contur3CandidateSlice | null = null;
    let bestClassification: ClassificationCode = "EVENT_IDENTITY_GAP";

    for (const candidate of contur3Candidates) {
      const cConditionId = str(candidate.condition_id);
      const cTokenId = str(candidate.token_id);
      const cSide = str(candidate.selected_outcome) ?? str(candidate.side);

      if (cConditionId === null || cTokenId === null || cSide === null) {
        // Note: once bestClassification becomes EXACT_EXECUTION_COMPATIBLE
        // below, the loop always `break`s, so this branch can never observe
        // that value here -- only EVENT_IDENTITY_GAP (initial) is upgraded,
        // preserving precedence against an already-found mismatch classification.
        if (bestClassification === "EVENT_IDENTITY_GAP") {
          bestMatch = candidate;
          bestClassification = "MISSING_EXECUTION_FIELDS";
        }
        continue;
      }

      if (cConditionId !== frozenConditionId) {
        if (bestClassification === "EVENT_IDENTITY_GAP" || bestClassification === "MISSING_EXECUTION_FIELDS") {
          bestMatch = candidate;
          bestClassification = "CONDITION_ID_MISMATCH";
        }
        continue;
      }
      if (cTokenId !== frozenTokenId) {
        if (
          bestClassification === "EVENT_IDENTITY_GAP" ||
          bestClassification === "MISSING_EXECUTION_FIELDS" ||
          bestClassification === "CONDITION_ID_MISMATCH"
        ) {
          bestMatch = candidate;
          bestClassification = "TOKEN_ID_MISMATCH";
        }
        continue;
      }
      if (cSide !== frozenSelectedOutcome) {
        if (
          bestClassification === "EVENT_IDENTITY_GAP" ||
          bestClassification === "MISSING_EXECUTION_FIELDS" ||
          bestClassification === "CONDITION_ID_MISMATCH" ||
          bestClassification === "TOKEN_ID_MISMATCH"
        ) {
          bestMatch = candidate;
          bestClassification = "SIDE_MISMATCH";
        }
        continue;
      }

      // condition_id + token_id + side/selected_outcome all match exactly.
      bestMatch = candidate;
      bestClassification = "EXACT_EXECUTION_COMPATIBLE";
      break;
    }

    if (bestClassification === "EXACT_EXECUTION_COMPATIBLE" && bestMatch !== null) {
      const finalClassification = checkMarketAndGaps(frozen, bestMatch);
      rows.push(baseRow(eventKey, frozen, bestMatch, finalClassification));
    } else if (bestMatch !== null) {
      rows.push(baseRow(eventKey, frozen, bestMatch, bestClassification));
    } else {
      rows.push(baseRow(eventKey, frozen, null, "EVENT_IDENTITY_GAP"));
    }
  }

  // Contur3 candidates that were never selected as bestMatch for any frozen
  // pairing on this event are reported as CONTUR3_ONLY (materially distinct
  // market on the same physical event that has no frozen counterpart).
  const matchedCandidates = new Set(
    rows.map((r) => (r.contur3ConditionId !== null ? `${r.contur3ConditionId}:${r.contur3TokenId}:${r.contur3Side}` : null)).filter((v): v is string => v !== null),
  );
  for (const candidate of contur3Candidates) {
    const key = `${candidate.condition_id}:${candidate.token_id}:${candidate.side}`;
    if (!matchedCandidates.has(key)) {
      rows.push(baseRow(eventKey, null, candidate, "CONTUR3_ONLY"));
    }
  }

  return rows;
}

/**
 * Given an exact identity match (condition_id + token_id + side all equal),
 * checks for market-taxonomy divergence and policy/window gaps, in this
 * order: SAME_EVENT_DIFFERENT_MARKET (market identity itself diverges even
 * though the token matched -- should not normally co-occur with an exact
 * token match, but checked defensively) -> PRICE_POLICY_GAP ->
 * TIME_WINDOW_GAP -> MARKET_TAXONOMY_GAP -> EXACT_EXECUTION_COMPATIBLE.
 */
function checkMarketAndGaps(frozen: FrozenSidePairing, candidate: Contur3CandidateSlice): ClassificationCode {
  const candidateMarketKey = candidate.canonical_market_key ?? candidate.market_slug;
  const frozenMarketKey = str((frozen.sourceRow as Record<string, unknown>).canonical_market_key) ?? str(frozen.sourceRow.market_slug);
  if (frozenMarketKey !== null && candidateMarketKey !== null && frozenMarketKey !== candidateMarketKey) {
    return "SAME_EVENT_DIFFERENT_MARKET";
  }

  if (frozen.decision.entryPrice > candidate.max_entry_price) {
    return "PRICE_POLICY_GAP";
  }

  const bucketMaxMinutes = TIMING_BUCKET_MAX_MINUTES[candidate.timing_bucket];
  if (
    bucketMaxMinutes !== undefined &&
    (frozen.decision.minutesUntilStart < 0 || frozen.decision.minutesUntilStart > bucketMaxMinutes)
  ) {
    return "TIME_WINDOW_GAP";
  }

  const frozenSport = str((frozen.sourceRow as Record<string, unknown>).inferred_sport);
  if (frozenSport !== null && frozenSport !== candidate.inferred_sport) {
    return "MARKET_TAXONOMY_GAP";
  }

  return "EXACT_EXECUTION_COMPATIBLE";
}

function baseRow(
  eventKey: string,
  frozen: FrozenSidePairing | null,
  candidate: Contur3CandidateSlice | null,
  classification: ClassificationCode,
): ComparisonRow {
  const frozenIdentity = frozen !== null ? frozenSourceIdentity(frozen.sourceRow) : { conditionId: null, tokenId: null, selectedOutcome: null };
  return {
    eventKey,
    classification,
    frozenObservationId: frozen?.decision.observationId ?? null,
    frozenSelectedOutcome: frozen?.decision.selectedOutcome ?? null,
    frozenEntryPrice: frozen?.decision.entryPrice ?? null,
    frozenMinutesUntilStart: frozen?.decision.minutesUntilStart ?? null,
    frozenConditionId: frozenIdentity.conditionId,
    frozenTokenId: frozenIdentity.tokenId,
    contur3ConditionId: candidate?.condition_id ?? null,
    contur3TokenId: candidate?.token_id ?? null,
    contur3Side: candidate !== null ? (str(candidate.selected_outcome) ?? str(candidate.side)) : null,
    contur3MarketSlug: candidate?.market_slug ?? null,
    contur3MaxEntryPrice: candidate?.max_entry_price ?? null,
    contur3TimingBucket: candidate?.timing_bucket ?? null,
    contur3InferredSport: candidate?.inferred_sport ?? null,
    contur3MarketFamily: candidate?.market_family ?? null,
  };
}

function comparisonRowSortKey(row: ComparisonRow): string {
  return [
    row.eventKey,
    row.classification,
    row.frozenObservationId ?? "",
    row.contur3ConditionId ?? "",
    row.contur3TokenId ?? "",
    row.contur3Side ?? "",
  ].join("");
}

/**
 * Top-level pure entry point. Groups both sides by canonical physical-event
 * identity (buildEventGroupKey) and classifies each pairing deterministically.
 * Input order never affects output: both sides are grouped into maps keyed
 * by eventKey (order-independent), and the final row list is sorted by a
 * stable composite key before returning.
 */
export function compareFrozenAndContur3(
  frozenDecisions: readonly FrozenModelV2Decision[],
  frozenSourceRows: readonly ExportRow[],
  contur3Candidates: readonly Contur3CandidateSlice[],
): BridgeComparisonSummary {
  const pairings = pairFrozenDecisionsWithSourceRows(frozenDecisions, frozenSourceRows);

  const frozenByEvent = new Map<string, FrozenSidePairing[]>();
  for (const pairing of pairings) {
    const key = normalizedPhysicalEventIdentity(pairing.decision.eventKey);
    const group = frozenByEvent.get(key);
    if (group) group.push(pairing);
    else frozenByEvent.set(key, [pairing]);
  }

  const contur3ByEvent = new Map<string, Contur3CandidateSlice[]>();
  for (const candidate of contur3Candidates) {
    const key = normalizedPhysicalEventIdentity(buildEventGroupKey(candidate as unknown as EventGroupRow).key);
    const group = contur3ByEvent.get(key);
    if (group) group.push(candidate);
    else contur3ByEvent.set(key, [candidate]);
  }

  const allEventKeys = new Set<string>([...frozenByEvent.keys(), ...contur3ByEvent.keys()]);

  const rows: ComparisonRow[] = [];
  for (const eventKey of allEventKeys) {
    const frozenPairings = frozenByEvent.get(eventKey) ?? [];
    const candidates = contur3ByEvent.get(eventKey) ?? [];
    rows.push(...classifyEvent(eventKey, frozenPairings, candidates));
  }

  rows.sort((a, b) => comparisonRowSortKey(a).localeCompare(comparisonRowSortKey(b)));

  const counts = classificationCounts();
  for (const row of rows) counts[row.classification] += 1;

  return {
    eventCount: allEventKeys.size,
    classificationCounts: counts,
    rows,
  };
}
