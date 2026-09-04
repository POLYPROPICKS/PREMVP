import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReservationsFromPlanningDecisions } from "../../lib/executor/nightEventReservations";
import { buildPlanRunId, resolveNightWindow } from "../../lib/executor/nightWindow";
import type {
  ContractADecisionResult,
  ContractAPlanningDecision,
} from "../../lib/executor/contractADecisions";

// EXPAND_ALLOWED_SOCCER_MARKET_UNIVERSE_V1 — Reservation invariant. Two
// distinct Contract A planning decisions for the SAME physical_event_id (one
// sourced from a moneyline candidate, one from a newly-admitted exact-score
// candidate) must still produce at most ONE Reservation for that physical
// event. This proves the existing dedup (rankAllocatableApprovedPhysicalEvents,
// keyed on physical_event_id) already absorbs the richer market universe
// without any change to Reservation ranking or cap logic.

const ANCHOR_MS = Date.parse("2026-09-10T14:00:00.000Z"); // 17:00 Minsk

function accepted(input: {
  physicalId: string;
  conditionId: string;
  score: number;
  anchorKind: "EXECUTABLE_MARKET" | "APPROVED_SOCCER_MARKET_FAMILY";
}): ContractADecisionResult<ContractAPlanningDecision> {
  const start = "2026-09-10T18:00:00.000Z";
  return {
    accepted: true,
    decision: {
      decision_version: "CONTRACT_A_DECISION_V1",
      contract_a_version: "CONTRACT_A_PLANNING_V1",
      status: "ACCEPTED",
      physical_event_id: `provider:polymarket:${input.physicalId}:2026-09-10`,
      source_lineage: {
        generated_signal_pair_id: input.conditionId,
        generated_signal_pair_id_is_uuid: false,
        observation_id: `condition-${input.conditionId}::token-${input.conditionId}`,
        event_slug: `display-${input.physicalId}`,
        provider_event_key: `polymarket:${input.physicalId}:2026-09-10`,
        provider_event_id: input.physicalId,
        provider_event_start_iso: start,
        provider_sport: "soccer",
        producer_source: "polymarket",
        source_created_at: "2026-09-10T12:00:00.000Z",
      },
      event_start_iso: start,
      event_start_iso_source: "source_row_game_start_iso",
      inferred_sport: "soccer",
      strategic_scope: "SOCCER",
      sport_metadata_source: "upstream",
      league: null,
      planning_score: input.score,
      planning_tier: "TIER1_CORE_STRICT_72_COV50",
      planning_rank: 1,
      planning_policy_verdict: {
        market_class: input.anchorKind === "APPROVED_SOCCER_MARKET_FAMILY" ? "forbidden_exact_score" : "allowed_fullmatch_moneyline",
        event_scope: "full_match",
        allowed: true,
        decided_by: "CONTRACT_A_PLANNING_V1",
        reason_code: input.anchorKind === "APPROVED_SOCCER_MARKET_FAMILY" ? "SOCCER_MARKET_FAMILY_APPROVED_SOCCER_EXACT_SCORE" : "EXECUTABLE_MARKET",
        anchor_kind: input.anchorKind,
        anchor_fingerprint: `fp-${input.conditionId}`,
      },
      execution_window: {
        stale_after: null,
        no_trade_after: null,
        timing_bucket: "T_2_6H",
      },
      final_identity_evidence: {
        condition_id: input.conditionId,
        token_id: `${input.conditionId}-yes`,
        side: "Yes",
        market_slug: `slug-${input.conditionId}`,
        canonical_market_key: `key-${input.conditionId}`,
        event_slug: `display-${input.physicalId}`,
      },
      rejection_trace: null,
    },
  };
}

test("a moneyline decision and an exact-score decision for the SAME physical event produce exactly one Reservation", () => {
  const result = buildReservationsFromPlanningDecisions(
    [
      accepted({ physicalId: "match-1", conditionId: "cid-moneyline", score: 70, anchorKind: "EXECUTABLE_MARKET" }),
      accepted({ physicalId: "match-1", conditionId: "cid-exact-score", score: 68, anchorKind: "APPROVED_SOCCER_MARKET_FAMILY" }),
    ],
    { planRunId: buildPlanRunId(ANCHOR_MS), window: resolveNightWindow(ANCHOR_MS), nowMs: ANCHOR_MS },
    [],
    {},
  );

  assert.equal(result.reservations.length, 1);
  assert.equal(result.reservations[0].physical_event_id, "provider:polymarket:match-1:2026-09-10");
  // Highest-score candidate wins the single slot -- the ranking logic itself is untouched.
  const winnerLineage = result.reservations[0].diagnostics?.source_lineage as { generated_signal_pair_id?: string } | undefined;
  assert.equal(winnerLineage?.generated_signal_pair_id, "cid-moneyline");
  assert.equal(result.duplicateRejected, 1);
  assert.ok(result.rejections.some((r) => r.reason_code === "DUPLICATE_PHYSICAL_EVENT"));
});

test("five distinct markets (moneyline/spread/total/exact-score/first-to-score) for one physical event still yield exactly one Reservation, cap unaffected", () => {
  const decisions = [
    accepted({ physicalId: "match-2", conditionId: "cid-moneyline", score: 75, anchorKind: "EXECUTABLE_MARKET" }),
    accepted({ physicalId: "match-2", conditionId: "cid-spread", score: 74, anchorKind: "EXECUTABLE_MARKET" }),
    accepted({ physicalId: "match-2", conditionId: "cid-total", score: 73, anchorKind: "EXECUTABLE_MARKET" }),
    accepted({ physicalId: "match-2", conditionId: "cid-exact-score", score: 72, anchorKind: "APPROVED_SOCCER_MARKET_FAMILY" }),
    accepted({ physicalId: "match-2", conditionId: "cid-first-to-score", score: 71, anchorKind: "APPROVED_SOCCER_MARKET_FAMILY" }),
  ];
  const result = buildReservationsFromPlanningDecisions(
    decisions,
    { planRunId: buildPlanRunId(ANCHOR_MS), window: resolveNightWindow(ANCHOR_MS), nowMs: ANCHOR_MS },
    [],
    {},
  );
  assert.equal(result.reservations.length, 1);
  assert.equal(result.duplicateRejected, 4);
  assert.equal(result.approvedCount, 5);
});
