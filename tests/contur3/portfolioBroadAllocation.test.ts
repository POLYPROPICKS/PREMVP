// LIVE_RESERVATION_PORTFOLIO_BROAD_V2
//   node --import tsx --test tests/contur3/portfolioBroadAllocation.test.ts
//
// PORTFOLIO_BROAD is the proven research Decision Policy: event-level tier
// qualification (Tier 1 before Tier 2 before Tier 3), capacity ordered by
// tier -> decision time -> physical event id -- never by score, sport
// preference or provider volume. One physical event may hold many accepted
// identities; only its highest-priority qualifying identity is ever a
// Reservation candidate, and only accepted Contract A Planning Decisions
// (never a raw unaccepted source row) can qualify an event.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_RESERVATION_PORTFOLIO_BROAD_V2,
  classifyPortfolioBroadTier,
} from "../../lib/executor/liveReservationAllocationPolicy";
import { buildReservationsFromPlanningDecisions } from "../../lib/executor/nightEventReservations";
import { buildPlanRunId, resolveNightWindow } from "../../lib/executor/nightWindow";
import type {
  ContractADecisionResult,
  ContractAPlanningDecision,
} from "../../lib/executor/contractADecisions";

const ANCHOR_MS = Date.parse("2026-08-11T14:00:00.000Z"); // 17:00 Minsk
const EVENT_START = "2026-08-11T16:00:00.000Z"; // >= 30min lead from ANCHOR_MS

function acceptedFor(input: {
  physicalEventId: string;
  generatedSignalPairId: string;
  conditionId: string;
  tokenId: string;
  sport?: "SOCCER" | "TENNIS" | "MLB";
  start?: string;
}): ContractADecisionResult<ContractAPlanningDecision> {
  const sport = input.sport ?? "MLB";
  const start = input.start ?? EVENT_START;
  return {
    accepted: true,
    decision: {
      decision_version: "CONTRACT_A_DECISION_V1",
      contract_a_version: "CONTRACT_A_PLANNING_V1",
      status: "ACCEPTED",
      physical_event_id: input.physicalEventId,
      source_lineage: {
        generated_signal_pair_id: input.generatedSignalPairId,
        generated_signal_pair_id_is_uuid: false,
        observation_id: `${input.conditionId}::${input.tokenId}`,
        event_slug: `display-${input.physicalEventId}`,
        provider_event_key: input.physicalEventId,
        provider_event_id: input.physicalEventId,
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
      planning_score: 64,
      planning_tier: "TIER3_MICRO_EXPAND_50_COV25",
      planning_rank: 1,
      planning_policy_verdict: null,
      execution_window: { stale_after: null, no_trade_after: null, timing_bucket: "T_6H_PLUS" },
      final_identity_evidence: null,
      rejection_trace: null,
    },
  };
}

function sourceRow(input: {
  id: string;
  conditionId: string;
  tokenId: string;
  entryPrice: number;
  preEventScore?: number | null;
  createdAt?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    condition_id: input.conditionId,
    selected_token_id: input.tokenId,
    entry_price_num: input.entryPrice,
    pre_event_score_num: input.preEventScore ?? null,
    created_at: input.createdAt ?? "2026-08-11T10:00:00.000Z",
  };
}

function build(
  results: ContractADecisionResult<ContractAPlanningDecision>[],
  rows: Record<string, unknown>[],
) {
  return buildReservationsFromPlanningDecisions(
    results,
    { planRunId: buildPlanRunId(ANCHOR_MS), window: resolveNightWindow(ANCHOR_MS), nowMs: ANCHOR_MS },
    [],
    {
      allocationPolicy: LIVE_RESERVATION_PORTFOLIO_BROAD_V2,
      sourceRowsForCandidateManifest: rows,
    },
  );
}

// ── Pure tier classification ────────────────────────────────────────────────

test("1: TENNIS + price 0.51 + missing pre_event_score -> Tier 1", () => {
  assert.equal(classifyPortfolioBroadTier(0.51, null, "TENNIS"), 1);
});

test("2: non-tennis + price 0.51 + pre_event_score 63 -> Tier 1", () => {
  assert.equal(classifyPortfolioBroadTier(0.51, 63, "MLB"), 1);
});

test("3: non-tennis + price 0.51 + missing score -> Tier 2", () => {
  assert.equal(classifyPortfolioBroadTier(0.51, null, "MLB"), 2);
});

test("4: price 0.53 -> Tier 3", () => {
  assert.equal(classifyPortfolioBroadTier(0.53, null, "MLB"), 3);
});

test("5: price 0.54 -> NOT qualified", () => {
  assert.equal(classifyPortfolioBroadTier(0.54, null, "TENNIS"), null);
});

test("6: price 0.49 -> NOT qualified", () => {
  assert.equal(classifyPortfolioBroadTier(0.49, 90, "TENNIS"), null);
});

// ── Event-level tier priority and chronological tie-break ──────────────────

test("7: one physical event with a Tier2 and a Tier1 accepted identity -- Tier1 wins", () => {
  const physicalEventId = "provider:polymarket:evt-a:2026-08-11";
  const results = [
    acceptedFor({ physicalEventId, generatedSignalPairId: "row-tier2", conditionId: "c-tier2", tokenId: "t-tier2" }),
    acceptedFor({ physicalEventId, generatedSignalPairId: "row-tier1", conditionId: "c-tier1", tokenId: "t-tier1", sport: "TENNIS" }),
  ];
  const rows = [
    sourceRow({ id: "row-tier2", conditionId: "c-tier2", tokenId: "t-tier2", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
    sourceRow({ id: "row-tier1", conditionId: "c-tier1", tokenId: "t-tier1", entryPrice: 0.51, createdAt: "2026-08-11T11:00:00.000Z" }),
  ];
  const result = build(results, rows);
  assert.equal(result.reservations.length, 1);
  assert.equal(result.reservations[0].diagnostics.portfolio_tier, 1);
  const diagnostics = result.reservations[0].diagnostics as { source_lineage: { observation_id: string } };
  assert.equal(diagnostics.source_lineage.observation_id, "c-tier1::t-tier1");
});

test("8: same tier -- earliest source_created_at wins; condition_id/token_id are deterministic tie-breaks", () => {
  const physicalEventId = "provider:polymarket:evt-b:2026-08-11";
  const results = [
    acceptedFor({ physicalEventId, generatedSignalPairId: "row-later", conditionId: "c-z", tokenId: "t-z" }),
    acceptedFor({ physicalEventId, generatedSignalPairId: "row-earlier", conditionId: "c-a", tokenId: "t-a" }),
  ];
  const rows = [
    sourceRow({ id: "row-later", conditionId: "c-z", tokenId: "t-z", entryPrice: 0.51, createdAt: "2026-08-11T11:00:00.000Z" }),
    sourceRow({ id: "row-earlier", conditionId: "c-a", tokenId: "t-a", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
  ];
  const result = build(results, rows);
  const diagnostics = (id: number) => result.reservations[id]?.diagnostics as { source_lineage: { observation_id: string } };
  assert.equal(result.reservations.length, 1);
  assert.equal(diagnostics(0).source_lineage.observation_id, "c-a::t-a");

  // Tie-break: identical source_created_at -> condition_id ASC decides.
  const tieRows = [
    sourceRow({ id: "row-later", conditionId: "c-z", tokenId: "t-z", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
    sourceRow({ id: "row-earlier", conditionId: "c-a", tokenId: "t-a", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
  ];
  const tieResult = build(results, tieRows);
  const tieDiagnostics = tieResult.reservations[0]?.diagnostics as { source_lineage: { observation_id: string } };
  assert.equal(tieDiagnostics.source_lineage.observation_id, "c-a::t-a");
});

// ── Raw unaccepted rows cannot qualify ───────────────────────────────────────

test("9: a raw source row with no corresponding ACCEPTED decision cannot qualify the physical event", () => {
  const physicalEventId = "provider:polymarket:evt-c:2026-08-11";
  // Only ONE decision is accepted (row-accepted); row-unaccepted is a source
  // row that exists in the snapshot but never produced an accepted decision.
  const results = [
    acceptedFor({ physicalEventId, generatedSignalPairId: "row-accepted", conditionId: "c-accepted", tokenId: "t-accepted", sport: "SOCCER" }),
  ];
  const rows = [
    // Qualifying price, but NOT tied to any accepted decision.
    sourceRow({ id: "row-unaccepted", conditionId: "c-unaccepted", tokenId: "t-unaccepted", entryPrice: 0.51 }),
    // The accepted decision's own row does NOT qualify (price outside band).
    sourceRow({ id: "row-accepted", conditionId: "c-accepted", tokenId: "t-accepted", entryPrice: 0.6 }),
  ];
  const result = build(results, rows);
  assert.equal(result.reservations.length, 0, "the unaccepted row must never qualify the event");
  assert.equal(
    result.rejections.find((r) => r.physical_event_id === physicalEventId)?.reason_code,
    "PORTFOLIO_BROAD_NOT_QUALIFIED",
  );
});

// ── One physical event, one Reservation maximum ─────────────────────────────

test("10: one physical event produces at most one Reservation even with 3 qualifying identities", () => {
  const physicalEventId = "provider:polymarket:evt-d:2026-08-11";
  const results = [
    acceptedFor({ physicalEventId, generatedSignalPairId: "r1", conditionId: "c1", tokenId: "t1" }),
    acceptedFor({ physicalEventId, generatedSignalPairId: "r2", conditionId: "c2", tokenId: "t2" }),
    acceptedFor({ physicalEventId, generatedSignalPairId: "r3", conditionId: "c3", tokenId: "t3" }),
  ];
  const rows = [
    sourceRow({ id: "r1", conditionId: "c1", tokenId: "t1", entryPrice: 0.51 }),
    sourceRow({ id: "r2", conditionId: "c2", tokenId: "t2", entryPrice: 0.52 }),
    sourceRow({ id: "r3", conditionId: "c3", tokenId: "t3", entryPrice: 0.53 }),
  ];
  const result = build(results, rows);
  assert.equal(result.reservations.length, 1);
});

// ── Capacity ordering: tier ASC -> decision_at ASC -> physical_event_id ASC ─

test("11: capacity ordering is exactly tier ASC, then decision_at ASC, then physical_event_id ASC", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:z-tier3:2026-08-11", generatedSignalPairId: "z3", conditionId: "cz3", tokenId: "tz3" }),
    acceptedFor({ physicalEventId: "provider:polymarket:a-tier1-late:2026-08-11", generatedSignalPairId: "a1l", conditionId: "ca1l", tokenId: "ta1l", sport: "TENNIS" }),
    acceptedFor({ physicalEventId: "provider:polymarket:b-tier1-early:2026-08-11", generatedSignalPairId: "b1e", conditionId: "cb1e", tokenId: "tb1e", sport: "TENNIS" }),
  ];
  const rows = [
    sourceRow({ id: "z3", conditionId: "cz3", tokenId: "tz3", entryPrice: 0.53, createdAt: "2026-08-11T08:00:00.000Z" }),
    sourceRow({ id: "a1l", conditionId: "ca1l", tokenId: "ta1l", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
    sourceRow({ id: "b1e", conditionId: "cb1e", tokenId: "tb1e", entryPrice: 0.51, createdAt: "2026-08-11T08:30:00.000Z" }),
  ];
  const result = build(results, rows);
  assert.deepEqual(result.reservations.map((r) => r.physical_event_id), [
    "provider:polymarket:b-tier1-early:2026-08-11",
    "provider:polymarket:a-tier1-late:2026-08-11",
    "provider:polymarket:z-tier3:2026-08-11",
  ]);
});

// ── Capacity cap: 31 qualifying events -> 30 reserved, 1 cap-excluded ───────

test("12: 31 qualifying physical events -> 30 Reservations, 1 CAP_EXCLUDED", () => {
  const results: ContractADecisionResult<ContractAPlanningDecision>[] = [];
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 31; i++) {
    const id = `event-${String(i).padStart(2, "0")}`;
    const physicalEventId = `provider:polymarket:${id}:2026-08-11`;
    results.push(acceptedFor({ physicalEventId, generatedSignalPairId: id, conditionId: `c-${id}`, tokenId: `t-${id}` }));
    rows.push(sourceRow({ id, conditionId: `c-${id}`, tokenId: `t-${id}`, entryPrice: 0.51, createdAt: `2026-08-11T${String(8 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00.000Z` }));
  }
  const result = build(results, rows);
  assert.equal(result.reservations.length, 30);
  assert.equal(result.capExcluded, 1);
  assert.equal(result.rejections.filter((r) => r.reason_code === "CAP_EXCLUDED").length, 1);
});

// ── Policy invariant ──────────────────────────────────────────────────────

test("13: policy invariant -- active target = 30, hard ceiling = 50", () => {
  assert.equal(LIVE_RESERVATION_PORTFOLIO_BROAD_V2.targetReservationSlots, 30);
  assert.equal(LIVE_RESERVATION_PORTFOLIO_BROAD_V2.hardReservationCeiling, 50);
  assert.ok(
    LIVE_RESERVATION_PORTFOLIO_BROAD_V2.targetReservationSlots <=
      LIVE_RESERVATION_PORTFOLIO_BROAD_V2.hardReservationCeiling,
  );
});

// ── No final executable identity is chosen at Reservation ──────────────────

test("15: no final executable identity field is populated at Reservation -- only model decision evidence", () => {
  const physicalEventId = "provider:polymarket:evt-e:2026-08-11";
  const results = [
    acceptedFor({ physicalEventId, generatedSignalPairId: "r1", conditionId: "c1", tokenId: "t1" }),
  ];
  const rows = [sourceRow({ id: "r1", conditionId: "c1", tokenId: "t1", entryPrice: 0.51 })];
  const result = build(results, rows);
  assert.equal(result.reservations.length, 1);
  const diagnostics = result.reservations[0].diagnostics as Record<string, unknown>;
  assert.equal(diagnostics.planning_final_identity_evidence, null);
  assert.equal(diagnostics.portfolio_policy_id, "LIVE_RESERVATION_PORTFOLIO_BROAD_V2");
});

// ── RESERVATION_WINDOW_BOUNDARY_RESTORE_V1 ─────────────────────────────────
// An approved physical event may occupy a slot of THIS plan only inside
// nowMs < start AND [window.startMs, window.horizonEndMs) (isWithinHorizon).

const W_NOW = ANCHOR_MS;
const W_WINDOW = {
  ...resolveNightWindow(ANCHOR_MS),
  startMs: ANCHOR_MS + 1 * 3_600_000, // 15:00Z, after nowMs so "before window" is reachable
  horizonEndMs: ANCHOR_MS + 9 * 3_600_000, // 23:00Z exclusive
  horizonEndIso: new Date(ANCHOR_MS + 9 * 3_600_000).toISOString(),
};

function buildWindowed(startIsoById: Record<string, string>) {
  const results: ContractADecisionResult<ContractAPlanningDecision>[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const [id, start] of Object.entries(startIsoById)) {
    results.push(acceptedFor({ physicalEventId: `provider:polymarket:${id}:2026-08-11`, generatedSignalPairId: id, conditionId: `c-${id}`, tokenId: `t-${id}`, sport: "TENNIS", start }));
    rows.push(sourceRow({ id, conditionId: `c-${id}`, tokenId: `t-${id}`, entryPrice: 0.51 }));
  }
  return buildReservationsFromPlanningDecisions(
    results,
    { planRunId: buildPlanRunId(ANCHOR_MS), window: W_WINDOW, nowMs: W_NOW },
    [],
    { allocationPolicy: LIVE_RESERVATION_PORTFOLIO_BROAD_V2, sourceRowsForCandidateManifest: rows },
  );
}
const reasonOf = (r: ReturnType<typeof buildWindowed>, id: string) =>
  r.rejections.find((x) => x.physical_event_id?.includes(`:${id}:`))?.reason_code;

test("W1: an event inside the current window is admitted", () => {
  const r = buildWindowed({ inside: "2026-08-11T16:00:00.000Z" });
  assert.equal(r.reservations.length, 1);
});

test("W2-W5: before-window, already-started, exactly-at-end and after-end events are OUTSIDE_RESERVATION_HORIZON", () => {
  const r = buildWindowed({
    inside: "2026-08-11T16:00:00.000Z",
    before: "2026-08-11T14:30:00.000Z", // > nowMs but < window.startMs
    started: "2026-08-11T13:00:00.000Z", // <= nowMs
    atend: new Date(W_WINDOW.horizonEndMs).toISOString(), // exclusive bound
    after: "2026-08-13T10:00:00.000Z", // the 2026-09-22-style leak
  });
  assert.deepEqual(r.reservations.map((x) => x.physical_event_id), ["provider:polymarket:inside:2026-08-11"]);
  for (const id of ["before", "started", "atend", "after"]) {
    assert.equal(reasonOf(r, id), "OUTSIDE_RESERVATION_HORIZON", id);
  }
});

test("W6: out-of-window Broad events cannot consume Reservation capacity", () => {
  const start: Record<string, string> = {};
  for (let i = 0; i < 2; i++) start[`late-${i}`] = "2026-08-13T10:00:00.000Z";
  for (let i = 0; i < 30; i++) start[`in-${String(i).padStart(2, "0")}`] = "2026-08-11T16:00:00.000Z";
  const r = buildWindowed(start);
  assert.equal(r.reservations.length, 30, "all 30 slots go to in-window events");
  assert.ok(r.reservations.every((x) => x.physical_event_id?.includes(":in-")));
  assert.equal(r.capExcluded, 0);
});

test("W7: in-window Broad events still rank tier ASC, decision_at ASC, physical_event_id ASC", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:z-tier3:2026-08-11", generatedSignalPairId: "z3", conditionId: "cz3", tokenId: "tz3", start: "2026-08-11T16:00:00.000Z" }),
    acceptedFor({ physicalEventId: "provider:polymarket:a-tier1:2026-08-11", generatedSignalPairId: "a1", conditionId: "ca1", tokenId: "ta1", sport: "TENNIS", start: "2026-08-11T16:00:00.000Z" }),
  ];
  const rows = [
    sourceRow({ id: "z3", conditionId: "cz3", tokenId: "tz3", entryPrice: 0.53, createdAt: "2026-08-11T08:00:00.000Z" }),
    sourceRow({ id: "a1", conditionId: "ca1", tokenId: "ta1", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
  ];
  const r = buildReservationsFromPlanningDecisions(results, { planRunId: buildPlanRunId(ANCHOR_MS), window: W_WINDOW, nowMs: W_NOW }, [], { allocationPolicy: LIVE_RESERVATION_PORTFOLIO_BROAD_V2, sourceRowsForCandidateManifest: rows });
  assert.deepEqual(r.reservations.map((x) => x.physical_event_id), [
    "provider:polymarket:a-tier1:2026-08-11",
    "provider:polymarket:z-tier3:2026-08-11",
  ]);
});
