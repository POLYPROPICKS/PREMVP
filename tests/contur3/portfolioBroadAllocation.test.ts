// LIVE_RESERVATION_PORTFOLIO_BROAD_V2
//   node --import tsx --test tests/contur3/portfolioBroadAllocation.test.ts
//
// PORTFOLIO_BROAD is the proven research Decision Policy: event-level tier
// qualification (Tier 1 before Tier 2 before Tier 3) still governs which
// identity wins WITHIN one physical event (see classifyPortfolioBroadTier +
// resolvePortfolioBroadPhysicalEventAllocations, unchanged by this file).
//
// RESTORE_SIGNAL_SCORE_AND_FOOTBALL_RESERVATION_PRIORITY_V1: capacity
// ordering ACROSS physical events no longer uses tier -> decision_at ASC.
// It is now Signal Score DESC (the canonical planning_score persisted on the
// Contract A Planning Decision, never pre_event_score_num) -> football
// preference (SOCCER/WC only; TENNIS gets no automatic priority) -> freshest
// source evidence DESC -> provider volume DESC -> physical event id ASC.
// Portfolio tier is qualification/diagnostic evidence only at capacity time;
// it never outranks a higher Signal Score. One physical event may hold many
// accepted identities; only its highest-priority qualifying identity is ever
// a Reservation candidate, and only accepted Contract A Planning Decisions
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
  sport?: "SOCCER" | "TENNIS" | "MLB" | "WC";
  start?: string;
  planningScore?: number;
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
      planning_score: input.planningScore ?? 64,
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
  providerVolumeByPhysicalEventId?: Map<string, number>,
) {
  return buildReservationsFromPlanningDecisions(
    results,
    { planRunId: buildPlanRunId(ANCHOR_MS), window: resolveNightWindow(ANCHOR_MS), nowMs: ANCHOR_MS },
    [],
    {
      allocationPolicy: LIVE_RESERVATION_PORTFOLIO_BROAD_V2,
      sourceRowsForCandidateManifest: rows,
      providerVolumeByPhysicalEventId,
    },
  );
}

// ── Pure tier classification ────────────────────────────────────────────────

test("1: TENNIS + price 0.51 + missing pre_event_score -> Tier 2, NOT automatic Tier 1", () => {
  // RESTORE_SIGNAL_SCORE_AND_FOOTBALL_RESERVATION_PRIORITY_V1 removes the
  // prior TENNIS-only automatic Tier 1 special case.
  assert.equal(classifyPortfolioBroadTier(0.51, null, "TENNIS"), 2);
});

test("1b: TENNIS + price 0.51 + qualifying pre_event_score 64 -> Tier 1, via the same score band every sport uses", () => {
  assert.equal(classifyPortfolioBroadTier(0.51, 64, "TENNIS"), 1);
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

// ── Event-level tier priority (identity selection WITHIN one physical event) ──
// unchanged by this mission: still governs which identity wins an event.

test("7: one physical event with a Tier2 and a genuinely-qualifying Tier1 accepted identity -- Tier1 wins", () => {
  const physicalEventId = "provider:polymarket:evt-a:2026-08-11";
  const results = [
    acceptedFor({ physicalEventId, generatedSignalPairId: "row-tier2", conditionId: "c-tier2", tokenId: "t-tier2" }),
    acceptedFor({ physicalEventId, generatedSignalPairId: "row-tier1", conditionId: "c-tier1", tokenId: "t-tier1", sport: "TENNIS" }),
  ];
  const rows = [
    sourceRow({ id: "row-tier2", conditionId: "c-tier2", tokenId: "t-tier2", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
    // Qualifies Tier 1 via a real score in-band -- NOT because it is tennis.
    sourceRow({ id: "row-tier1", conditionId: "c-tier1", tokenId: "t-tier1", entryPrice: 0.51, preEventScore: 64, createdAt: "2026-08-11T11:00:00.000Z" }),
  ];
  const result = build(results, rows);
  assert.equal(result.reservations.length, 1);
  assert.equal(result.reservations[0].diagnostics.portfolio_tier, 1);
  const diagnostics = result.reservations[0].diagnostics as { source_lineage: { observation_id: string } };
  assert.equal(diagnostics.source_lineage.observation_id, "c-tier1::t-tier1");
});

test("8: same tier -- freshest (newest) source_created_at wins; condition_id/token_id are deterministic tie-breaks", () => {
  // RESTORE_FRESH_RESERVATION_EVIDENCE_V1 (preserved by this mission): same-
  // tier ties within one physical event prefer the newest source_created_at,
  // never the oldest.
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
  assert.equal(diagnostics(0).source_lineage.observation_id, "c-z::t-z");

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

// ── One physical event, one Reservation maximum (unchanged) ─────────────────

test("physical-event dedupe: one physical event produces at most one Reservation even with 3 qualifying identities", () => {
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

// ── RESTORE_SIGNAL_SCORE_AND_FOOTBALL_RESERVATION_PRIORITY_V1: capacity
// ordering across physical events is Signal Score DESC -> football
// preference -> freshest source -> provider volume -> physical event id ────

test("capacity-1: score 74 tennis vs score 76 football -> the higher-score football event ranks first", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:evt-tennis-74:2026-08-11", generatedSignalPairId: "t74", conditionId: "ct74", tokenId: "tt74", sport: "TENNIS", planningScore: 74 }),
    acceptedFor({ physicalEventId: "provider:polymarket:evt-soccer-76:2026-08-11", generatedSignalPairId: "s76", conditionId: "cs76", tokenId: "ts76", sport: "SOCCER", planningScore: 76 }),
  ];
  const rows = [
    sourceRow({ id: "t74", conditionId: "ct74", tokenId: "tt74", entryPrice: 0.51 }),
    sourceRow({ id: "s76", conditionId: "cs76", tokenId: "ts76", entryPrice: 0.51 }),
  ];
  const result = build(results, rows);
  assert.deepEqual(result.reservations.map((r) => r.physical_event_id), [
    "provider:polymarket:evt-soccer-76:2026-08-11",
    "provider:polymarket:evt-tennis-74:2026-08-11",
  ]);
});

test("capacity-2: score 74 football vs score 74 tennis, equal score -> football ranks first", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:evt-tennis-74b:2026-08-11", generatedSignalPairId: "t74b", conditionId: "ct74b", tokenId: "tt74b", sport: "TENNIS", planningScore: 74 }),
    acceptedFor({ physicalEventId: "provider:polymarket:evt-soccer-74b:2026-08-11", generatedSignalPairId: "s74b", conditionId: "cs74b", tokenId: "ts74b", sport: "SOCCER", planningScore: 74 }),
  ];
  const rows = [
    sourceRow({ id: "t74b", conditionId: "ct74b", tokenId: "tt74b", entryPrice: 0.51 }),
    sourceRow({ id: "s74b", conditionId: "cs74b", tokenId: "ts74b", entryPrice: 0.51 }),
  ];
  const result = build(results, rows);
  assert.deepEqual(result.reservations.map((r) => r.physical_event_id), [
    "provider:polymarket:evt-soccer-74b:2026-08-11",
    "provider:polymarket:evt-tennis-74b:2026-08-11",
  ]);
});

test("capacity-3: score 75 tennis vs score 70 football -> tennis ranks first (Signal Score is truly primary, football is only a tie-break)", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:evt-tennis-75:2026-08-11", generatedSignalPairId: "t75", conditionId: "ct75", tokenId: "tt75", sport: "TENNIS", planningScore: 75 }),
    acceptedFor({ physicalEventId: "provider:polymarket:evt-soccer-70:2026-08-11", generatedSignalPairId: "s70", conditionId: "cs70", tokenId: "ts70", sport: "SOCCER", planningScore: 70 }),
  ];
  const rows = [
    sourceRow({ id: "t75", conditionId: "ct75", tokenId: "tt75", entryPrice: 0.51 }),
    sourceRow({ id: "s70", conditionId: "cs70", tokenId: "ts70", entryPrice: 0.51 }),
  ];
  const result = build(results, rows);
  assert.deepEqual(result.reservations.map((r) => r.physical_event_id), [
    "provider:polymarket:evt-tennis-75:2026-08-11",
    "provider:polymarket:evt-soccer-70:2026-08-11",
  ]);
});

test("capacity-4: football (WC) preferred over a non-football, non-tennis sport at equal score", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:evt-mlb-70:2026-08-11", generatedSignalPairId: "m70", conditionId: "cm70", tokenId: "tm70", sport: "MLB", planningScore: 70 }),
    acceptedFor({ physicalEventId: "provider:polymarket:evt-wc-70:2026-08-11", generatedSignalPairId: "w70", conditionId: "cw70", tokenId: "tw70", sport: "WC", planningScore: 70 }),
  ];
  const rows = [
    sourceRow({ id: "m70", conditionId: "cm70", tokenId: "tm70", entryPrice: 0.51 }),
    sourceRow({ id: "w70", conditionId: "cw70", tokenId: "tw70", entryPrice: 0.51 }),
  ];
  const result = build(results, rows);
  assert.deepEqual(result.reservations.map((r) => r.physical_event_id), [
    "provider:polymarket:evt-wc-70:2026-08-11",
    "provider:polymarket:evt-mlb-70:2026-08-11",
  ]);
});

test("capacity-5: equal score and equal football-preference tier -> freshest source evidence wins, then provider volume, then physical_event_id", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:z-evt:2026-08-11", generatedSignalPairId: "z", conditionId: "cz", tokenId: "tz", sport: "MLB", planningScore: 70 }),
    acceptedFor({ physicalEventId: "provider:polymarket:a-evt:2026-08-11", generatedSignalPairId: "a", conditionId: "ca", tokenId: "ta", sport: "MLB", planningScore: 70 }),
    acceptedFor({ physicalEventId: "provider:polymarket:b-evt:2026-08-11", generatedSignalPairId: "b", conditionId: "cb", tokenId: "tb", sport: "MLB", planningScore: 70 }),
  ];
  const rows = [
    sourceRow({ id: "z", conditionId: "cz", tokenId: "tz", entryPrice: 0.51, createdAt: "2026-08-11T08:00:00.000Z" }),
    sourceRow({ id: "a", conditionId: "ca", tokenId: "ta", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
    sourceRow({ id: "b", conditionId: "cb", tokenId: "tb", entryPrice: 0.51, createdAt: "2026-08-11T08:30:00.000Z" }),
  ];
  const result = build(results, rows);
  assert.deepEqual(result.reservations.map((r) => r.physical_event_id), [
    "provider:polymarket:a-evt:2026-08-11", // 09:00 -- freshest
    "provider:polymarket:b-evt:2026-08-11", // 08:30
    "provider:polymarket:z-evt:2026-08-11", // 08:00 -- oldest
  ]);
});

test("capacity-6: equal score, equal football-preference tier, equal freshness -> higher provider volume wins", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:low-vol:2026-08-11", generatedSignalPairId: "lv", conditionId: "clv", tokenId: "tlv", sport: "MLB", planningScore: 70 }),
    acceptedFor({ physicalEventId: "provider:polymarket:high-vol:2026-08-11", generatedSignalPairId: "hv", conditionId: "chv", tokenId: "thv", sport: "MLB", planningScore: 70 }),
  ];
  const rows = [
    sourceRow({ id: "lv", conditionId: "clv", tokenId: "tlv", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
    sourceRow({ id: "hv", conditionId: "chv", tokenId: "thv", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
  ];
  const volumes = new Map([
    ["provider:polymarket:low-vol:2026-08-11", 100],
    ["provider:polymarket:high-vol:2026-08-11", 9000],
  ]);
  const result = build(results, rows, volumes);
  assert.deepEqual(result.reservations.map((r) => r.physical_event_id), [
    "provider:polymarket:high-vol:2026-08-11",
    "provider:polymarket:low-vol:2026-08-11",
  ]);
});

// ── Capacity cap: 31 qualifying events -> 30 reserved, 1 cap-excluded (unchanged) ──

test("cap: 31 qualifying physical events -> 30 Reservations, 1 CAP_EXCLUDED", () => {
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

test("W7: in-window Broad events still rank by Signal Score, then football preference, then freshest source", () => {
  const results = [
    acceptedFor({ physicalEventId: "provider:polymarket:z-tennis-70:2026-08-11", generatedSignalPairId: "z3", conditionId: "cz3", tokenId: "tz3", sport: "TENNIS", planningScore: 70, start: "2026-08-11T16:00:00.000Z" }),
    acceptedFor({ physicalEventId: "provider:polymarket:a-soccer-76:2026-08-11", generatedSignalPairId: "a1", conditionId: "ca1", tokenId: "ta1", sport: "SOCCER", planningScore: 76, start: "2026-08-11T16:00:00.000Z" }),
  ];
  const rows = [
    sourceRow({ id: "z3", conditionId: "cz3", tokenId: "tz3", entryPrice: 0.53, createdAt: "2026-08-11T08:00:00.000Z" }),
    sourceRow({ id: "a1", conditionId: "ca1", tokenId: "ta1", entryPrice: 0.51, createdAt: "2026-08-11T09:00:00.000Z" }),
  ];
  const r = buildReservationsFromPlanningDecisions(results, { planRunId: buildPlanRunId(ANCHOR_MS), window: W_WINDOW, nowMs: W_NOW }, [], { allocationPolicy: LIVE_RESERVATION_PORTFOLIO_BROAD_V2, sourceRowsForCandidateManifest: rows });
  assert.deepEqual(r.reservations.map((x) => x.physical_event_id), [
    "provider:polymarket:a-soccer-76:2026-08-11",
    "provider:polymarket:z-tennis-70:2026-08-11",
  ]);
});
