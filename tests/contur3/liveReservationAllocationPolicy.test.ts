import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_RESERVATION_ALLOCATION_V1,
  type LiveReservationAllocationPolicy,
} from "../../lib/executor/liveReservationAllocationPolicy";
import {
  buildReservationsFromPlanningDecisions,
} from "../../lib/executor/nightEventReservations";
import { buildPlanRunId, resolveNightWindow } from "../../lib/executor/nightWindow";
import type {
  ContractADecisionResult,
  ContractAPlanningDecision,
} from "../../lib/executor/contractADecisions";

const ANCHOR_MS = Date.parse("2026-08-11T14:00:00.000Z"); // 17:00 Minsk

function accepted(input: {
  id: string;
  start?: string;
  score?: number;
  sport?: "SOCCER" | "TENNIS" | "MLB";
  rank?: number;
  text?: string;
}): ContractADecisionResult<ContractAPlanningDecision> {
  const sport = input.sport ?? "MLB";
  const start = input.start ?? "2026-08-11T16:00:00.000Z";
  return {
    accepted: true,
    decision: {
      decision_version: "CONTRACT_A_DECISION_V1",
      contract_a_version: "CONTRACT_A_PLANNING_V1",
      status: "ACCEPTED",
      physical_event_id: `provider:polymarket:${input.id}:2026-08-11`,
      source_lineage: {
        generated_signal_pair_id: input.id,
        generated_signal_pair_id_is_uuid: false,
        observation_id: `condition-${input.id}::token-${input.id}`,
        event_slug: input.text ?? `display-${input.id}`,
        provider_event_key: `polymarket:${input.id}:2026-08-11`,
        provider_event_id: input.id,
        provider_event_start_iso: start,
        provider_sport: sport.toLowerCase(),
        producer_source: "polymarket",
        source_created_at: "2026-08-11T12:38:52.000Z",
      },
      event_start_iso: start,
      event_start_iso_source: "source_row_game_start_iso",
      inferred_sport: sport.toLowerCase(),
      strategic_scope: sport,
      sport_metadata_source: "upstream",
      league: null,
      planning_score: input.score ?? 64,
      planning_tier: "TIER3_MICRO_EXPAND_50_COV25",
      planning_rank: input.rank ?? 99,
      planning_policy_verdict: null,
      execution_window: {
        stale_after: null,
        no_trade_after: null,
        timing_bucket: "T_6H_PLUS",
      },
      final_identity_evidence: null,
      rejection_trace: null,
    },
  };
}

function rejected(id: string): ContractADecisionResult<ContractAPlanningDecision> {
  return {
    accepted: false,
    rejection: {
      decision_version: "CONTRACT_A_DECISION_V1",
      contract_a_version: "CONTRACT_A_PLANNING_V1",
      stage: "PLANNING",
      reason_code: "MARKET_POLICY_REJECTED",
      detail: null,
      physical_event_id: `provider:polymarket:${id}:2026-08-11`,
      source_lineage: null,
    },
  };
}

function build(
  results: ContractADecisionResult<ContractAPlanningDecision>[],
  volumes: Record<string, number | null> = {},
  policy: LiveReservationAllocationPolicy = LIVE_RESERVATION_ALLOCATION_V1,
) {
  const volumeMap = new Map(
    Object.entries(volumes).map(([id, volume]) => [`provider:polymarket:${id}:2026-08-11`, volume]),
  );
  return buildReservationsFromPlanningDecisions(
    results,
    {
      planRunId: buildPlanRunId(ANCHOR_MS),
      window: resolveNightWindow(ANCHOR_MS),
      nowMs: ANCHOR_MS,
    },
    [],
    { allocationPolicy: policy, providerVolumeByPhysicalEventId: volumeMap },
  );
}

test("Contract-A-rejected decisions never enter allocation", () => {
  const result = build([rejected("rejected"), accepted({ id: "approved" })]);
  assert.deepEqual(result.reservations.map((row) => row.physical_event_id), [
    "provider:polymarket:approved:2026-08-11",
  ]);
});

test("29-minute starts exclude while exactly 30 minutes is allocatable", () => {
  const result = build([
    accepted({ id: "too-early", start: "2026-08-11T14:29:00.000Z" }),
    accepted({ id: "boundary", start: "2026-08-11T14:30:00.000Z" }),
  ]);
  assert.deepEqual(result.reservations.map((row) => row.physical_event_id), [
    "provider:polymarket:boundary:2026-08-11",
  ]);
  assert.equal(result.rejections.find((row) => row.physical_event_id?.includes("too-early"))?.reason_code, "MIN_START_LEAD_NOT_MET");
});

test("ranking is score desc, preferred sport, provider volume desc, then stable provider identity", () => {
  const result = build([
    accepted({ id: "low-score-soccer", score: 63, sport: "SOCCER", rank: 1 }),
    accepted({ id: "high-score-mlb", score: 70, sport: "MLB", rank: 99 }),
    accepted({ id: "equal-mlb", score: 64, sport: "MLB" }),
    accepted({ id: "equal-tennis-high-volume", score: 64, sport: "TENNIS" }),
    accepted({ id: "equal-soccer-high-volume", score: 64, sport: "SOCCER" }),
    accepted({ id: "equal-soccer-a", score: 64, sport: "SOCCER" }),
  ], {
    "equal-mlb": 999_999,
    "equal-tennis-high-volume": 700,
    "equal-soccer-high-volume": 500,
    "equal-soccer-a": 500,
  });
  assert.deepEqual(result.reservations.map((row) => row.physical_event_id), [
    "provider:polymarket:high-score-mlb:2026-08-11",
    "provider:polymarket:equal-tennis-high-volume:2026-08-11",
    "provider:polymarket:equal-soccer-a:2026-08-11",
    "provider:polymarket:equal-soccer-high-volume:2026-08-11",
    "provider:polymarket:equal-mlb:2026-08-11",
    "provider:polymarket:low-score-soccer:2026-08-11",
  ]);
});

test("missing volume sorts last within an equal score and sport priority without exclusion", () => {
  const result = build([
    accepted({ id: "missing", score: 64, sport: "TENNIS" }),
    accepted({ id: "present", score: 64, sport: "TENNIS" }),
  ], { present: 1 });
  assert.deepEqual(result.reservations.map((row) => row.physical_event_id), [
    "provider:polymarket:present:2026-08-11",
    "provider:polymarket:missing:2026-08-11",
  ]);
});

test("duplicates consume one slot and display text cannot affect allocation", () => {
  const first = accepted({ id: "dup", text: "title A" });
  const duplicate = accepted({ id: "dup", text: "question/slug B" });
  const baseline = build([first, duplicate, accepted({ id: "other" })]);
  const changed = build([
    accepted({ id: "dup", text: "completely different display text" }),
    accepted({ id: "dup", text: "another display-only value" }),
    accepted({ id: "other", text: "changed other title" }),
  ]);
  assert.equal(baseline.reservations.length, 2);
  assert.equal(new Set(baseline.reservations.map((row) => row.physical_event_id)).size, 2);
  assert.deepEqual(changed.reservations.map((row) => row.physical_event_id), baseline.reservations.map((row) => row.physical_event_id));
});

test("target slot count is configurable and 15 selects exactly 15 distinct events", () => {
  const events = Array.from({ length: 20 }, (_, index) =>
    accepted({ id: `event-${String(index).padStart(2, "0")}`, score: 80 - index }),
  );
  assert.equal(build(events).reservations.length, 15);
  const top20 = {
    ...LIVE_RESERVATION_ALLOCATION_V1,
    targetReservationSlots: 20,
  } satisfies LiveReservationAllocationPolicy;
  assert.equal(build(events, {}, top20).reservations.length, 20);
});
