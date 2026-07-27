// R0H RESERVATION SLOT ALLOCATION — fixed-clock production replay.
//   node --import tsx --test tests/contur3/reservationSlotAllocation.r0h.test.ts
//
// Production run night-plan:2026-07-27:1700-minsk (as_of 2026-07-27T17:30:33.404Z,
// controlled force rebuild) reported:
//
//   timing_eligible   33 -> 33   OUTSIDE_PLANNING_HORIZON = 0
//   slot_eligible     33 -> 0    NON_TIER1_EVENT = 0
//                                NO_EXECUTABLE_ANCHOR = 0
//                                SLOT_NOT_ALLOCATED = 33
//   reservations_proposed 0 -> 0
//
// That reads as "33 valid events, zero slots" — a capacity failure. It was not.
// SLOT_NOT_ALLOCATED is a DERIVED RESIDUAL of the slot_eligible stage:
//
//   residual = timing_eligible - proposed - NON_TIER1 - NO_EXECUTABLE_ANCHOR
//
// buildReservationPlan drops a physical event on six paths, and the residual
// subtracted only two of them. Events rejected at the full-match anchor gate
// (skipped_no_fullmatch_anchor) or the planning-identity gate
// (skipped_no_planning_identity) were therefore relabelled as slot failures.
// Both of those gates run BEFORE the horizon check, which is also why
// skipped_outside_horizon stayed 0 and timing_eligible reported a spurious 33.
//
// Slot capacity itself was never zero: TARGET_LIVE_SLOTS = 15, Tier1 primary is
// uncapped and the Tier2/Tier3 fallback ladder fills up to 15. This suite pins
// both facts: real capacity still allocates, and a non-slot rejection is never
// again reported as SLOT_NOT_ALLOCATED.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";

/** Production force-rebuild instant: 17:30:33.404Z = 20:30 Minsk, plan date 2026-07-27. */
const FORCE_REBUILD_MS = Date.parse("2026-07-27T17:30:33.404Z");
/** The natural planning anchor for the same plan date: 17:00 Minsk = 14:00Z. */
const NATURAL_PLAN_MS = Date.parse("2026-07-27T14:00:00.000Z");
const KICKOFF_ISO = "2026-07-27T21:00:00.000Z";
const PRODUCTION_PLAN_RUN_ID = "night-plan:2026-07-27:1700-minsk";
const EVENT_COUNT = 33;
/** Founder live-slot policy in lib/executor/nightEventReservations.ts. */
const TARGET_LIVE_SLOTS = 15;

async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SnapshotDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(value?: any) {
      super(value ?? ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = SnapshotDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Sanitized production-shaped generated_signal_pairs row (full-match moneyline). */
const SOURCE_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  condition_id: "cond-nyy-phi",
  selected_token_id: "tok-nyy-phi-yankees",
  selected_outcome: "New York Yankees",
  score: 80,
  signal_confidence_num: 70,
  smart_money_score_num: null,
  entry_price_num: 0.42,
  metric_formula_version: "v2-lite-growth-safe",
  created_at: "2026-07-27T13:30:00.000Z",
  expires_at: KICKOFF_ISO,
  signal_result: null,
  event_slug: "mlb-nyy-phi-2026-07-27",
  market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
  diagnostics: {
    gameStartIso: KICKOFF_ISO,
    dataCoverage: 60,
    shadowScope: "baseball",
    eventTitle: "New York Yankees vs Philadelphia Phillies",
    marketTitle: "Yankees vs Phillies moneyline",
  },
};

/** Production raw funnel head: 1832 db rows -> 180 policy-eligible full-match rows. */
const RAW_DIAGNOSTICS = {
  total_db_rows: 1832,
  raw_allowed_fullmatch_rows: 180,
  raw_forbidden_rows: 1652,
  fullmatch_admitted_count: 180,
  fullmatch_rejected_by_reason: {},
};

/**
 * Build N distinct physical events off one real selector-produced candidate, so
 * every field the allocator reads is production-shaped rather than hand-rolled.
 */
async function physicalEvents(
  count: number,
  nowMs: number,
  override: (index: number, candidate: FireModelCandidate) => FireModelCandidate = (_i, c) => c
): Promise<FireModelCandidate[]> {
  const base = await at(nowMs, () =>
    buildFireModelCandidates(100_000, "all", true, [SOURCE_ROW], "CONTRACT_A_PLANNING_V1")
  );
  const proto = base.candidates[0];
  assert.ok(proto, "precondition: the planning selector must produce a candidate for the source row");
  return Array.from({ length: count }, (_unused, i) =>
    override(i, {
      ...proto,
      signal_id: `sig-${i}`,
      condition_id: `cond-${i}`,
      token_id: `tok-${i}`,
      match_family_key: `pair:team-a${i}-vs-team-b${i}:2026-07-27`,
      canonical_event_key: `pair:team-a${i}-vs-team-b${i}:2026-07-27`,
      event_slug: `evt-${i}`,
    })
  );
}

async function planWith(candidates: FireModelCandidate[], nowMs: number = FORCE_REBUILD_MS) {
  return at(nowMs, () =>
    buildReservationPlan(nowMs, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchCandidates: async () => ({ candidates, rawDiagnostics: RAW_DIAGNOSTICS as any }),
    })
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slotStage(plan: { diagnostics: Record<string, unknown> }): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trace = (plan.diagnostics as any).r0_trace;
  assert.ok(trace, "the plan must carry an r0_trace when raw diagnostics are present");
  return trace.stages.find((s: { stage_name: string }) => s.stage_name === "slot_eligible");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slotEvidence(plan: { diagnostics: Record<string, unknown> }): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (plan.diagnostics as any).r0_trace.slot_allocation;
}

// ── 1. The production RED: valid future inventory must take slots ────────────

test("R0H-1 (production RED): 33 valid future physical events allocate approved Reservation slots at a 17:30 force rebuild", async () => {
  const plan = await planWith(await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS));
  const d = plan.diagnostics;

  // Same target plan window as production, despite the 17:30 invocation instant.
  assert.equal(plan.plan_run_id, PRODUCTION_PLAN_RUN_ID);
  assert.equal(d.event_groups, EVENT_COUNT, "all 33 physical events must survive grouping");
  assert.equal(d.skipped_outside_horizon, 0, "all 33 kickoffs are inside the planning horizon");
  assert.equal(d.skipped_no_executable_anchor, 0);
  assert.equal(d.skipped_no_fullmatch_anchor, 0);
  assert.equal(d.skipped_no_planning_identity, 0);

  // The business result: valid future inventory allocates at least one approved slot.
  assert.ok(
    plan.reservations.length >= 1,
    `valid future inventory should allocate at least one approved Reservation slot, got ${plan.reservations.length}`
  );
  // And exactly the approved capacity — never more.
  assert.equal(plan.reservations.length, TARGET_LIVE_SLOTS);
});

// ── 2. SLOT_NOT_ALLOCATED must mean a genuine slot failure, nothing else ────

test("R0H-2: an anchor rejection is reported as NO_FULLMATCH_ANCHOR, never as SLOT_NOT_ALLOCATED", async () => {
  const plan = await planWith(
    await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS, (i, c) => ({
      ...c,
      market_slug: `Will something happen in game ${i}?`,
      providerMarketQuestion: `Will something happen in game ${i}?`,
    }))
  );

  assert.equal(plan.diagnostics.skipped_no_fullmatch_anchor, EVENT_COUNT);
  const stage = slotStage(plan);
  assert.equal(stage.input_count, EVENT_COUNT);
  assert.equal(stage.output_count, 0);
  assert.equal(stage.rejection_counts.NO_FULLMATCH_ANCHOR, EVENT_COUNT);
  // The exact production mislabelling this branch removes.
  assert.equal(stage.rejection_counts.SLOT_NOT_ALLOCATED, 0);

  const evidence = slotEvidence(plan);
  assert.equal(evidence.first_slot_rejection_code, "NO_FULLMATCH_ANCHOR");
  assert.equal(evidence.slot_candidates_considered, 0, "no candidate ever reached the allocator");
  assert.equal(evidence.slot_unallocated_cause, null, "not a slot failure");
  assert.equal(evidence.slot_capacity_effective, TARGET_LIVE_SLOTS, "capacity was available throughout");
});

test("R0H-3: a planning-identity rejection is reported as NO_PLANNING_IDENTITY, never as SLOT_NOT_ALLOCATED", async () => {
  const plan = await planWith(
    await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS, (_i, c) => ({
      ...c,
      diagnostics: { ...c.diagnostics, game_start_iso: null as unknown as string },
    }))
  );

  assert.equal(plan.diagnostics.skipped_no_planning_identity, EVENT_COUNT);
  const stage = slotStage(plan);
  assert.equal(stage.rejection_counts.NO_PLANNING_IDENTITY, EVENT_COUNT);
  assert.equal(stage.rejection_counts.SLOT_NOT_ALLOCATED, 0);
  assert.equal(slotEvidence(plan).first_slot_rejection_code, "NO_PLANNING_IDENTITY");
  assert.equal(slotEvidence(plan).slot_unallocated_cause, null);
});

// ── 3. A real slot failure still reports as one, with an explaining cause ────

test("R0H-4: genuine over-supply reports SLOT_NOT_ALLOCATED with cause CAPACITY_FILLED", async () => {
  const plan = await planWith(await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS));
  const stage = slotStage(plan);

  assert.equal(stage.input_count, EVENT_COUNT);
  assert.equal(stage.output_count, TARGET_LIVE_SLOTS);
  assert.equal(stage.rejection_counts.SLOT_NOT_ALLOCATED, EVENT_COUNT - TARGET_LIVE_SLOTS);
  assert.equal(stage.rejection_counts.NO_FULLMATCH_ANCHOR, 0);
  assert.equal(stage.rejection_counts.NO_PLANNING_IDENTITY, 0);

  const evidence = slotEvidence(plan);
  assert.equal(evidence.slot_capacity_configured, TARGET_LIVE_SLOTS);
  assert.equal(evidence.slot_candidates_considered, EVENT_COUNT);
  assert.equal(evidence.slot_allocated_count, TARGET_LIVE_SLOTS);
  assert.equal(evidence.slot_unallocated_count, EVENT_COUNT - TARGET_LIVE_SLOTS);
  assert.equal(evidence.slot_remaining_capacity, 0);
  assert.equal(evidence.slot_unallocated_cause, "CAPACITY_FILLED");
  assert.equal(evidence.slot_policy_version, "r0h-slot-policy-v1");
});

// ── 4. Slot evidence is anchored to the target plan window, not the clock ────

test("R0H-5: slot evidence reports the target plan window separately from the invocation clock", async () => {
  const plan = await planWith(await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS));
  const evidence = slotEvidence(plan);

  assert.equal(evidence.slot_allocation_clock_iso, "2026-07-27T17:30:33.404Z");
  assert.equal(evidence.slot_target_plan_window_start_iso, plan.window.startIso);
  assert.equal(evidence.slot_target_plan_window_end_iso, plan.window.endIso);
  assert.notEqual(
    evidence.slot_allocation_clock_iso,
    evidence.slot_target_plan_window_start_iso,
    "a late force rebuild must not collapse the plan window onto the invocation instant"
  );
});

// ── 5. Capacity is a function of the plan, not of when the plan was built ────

test("R0H-6: a 17:30 force rebuild allocates the same approved capacity as the natural 17:00 run", async () => {
  const forced = await planWith(await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS), FORCE_REBUILD_MS);
  const natural = await planWith(await physicalEvents(EVENT_COUNT, NATURAL_PLAN_MS), NATURAL_PLAN_MS);

  assert.equal(natural.plan_run_id, PRODUCTION_PLAN_RUN_ID, "same plan date, same run id");
  assert.equal(forced.plan_run_id, natural.plan_run_id);
  assert.equal(forced.reservations.length, TARGET_LIVE_SLOTS);
  assert.equal(natural.reservations.length, TARGET_LIVE_SLOTS);
  assert.equal(
    slotEvidence(forced).slot_capacity_effective,
    slotEvidence(natural).slot_capacity_effective,
    "effective slot capacity must not depend on the invocation instant"
  );
});

// ── 6. Approved policy boundaries stay intact ───────────────────────────────

test("R0H-7: capacity is never exceeded and every Reservation is a distinct physical event", async () => {
  const plan = await planWith(await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS));
  const keys = plan.reservations.map((r) => r.match_family_key);

  assert.ok(plan.reservations.length <= TARGET_LIVE_SLOTS, "approved capacity is never exceeded");
  assert.equal(new Set(keys).size, keys.length, "one Reservation per physical event");
});

test("R0H-8: duplicate physical-event keys collapse to at most one Reservation", async () => {
  const duplicated = await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS, (_i, c) => ({
    ...c,
    match_family_key: "pair:team-a0-vs-team-b0:2026-07-27",
    canonical_event_key: "pair:team-a0-vs-team-b0:2026-07-27",
  }));
  const plan = await planWith(duplicated);

  assert.equal(plan.diagnostics.event_groups, 1, "33 rows for one physical game are one group");
  assert.equal(plan.reservations.length, 1);
});

test("R0H-9: an event outside the planning horizon stays rejected and is not a slot failure", async () => {
  // Kickoff 40h out: beyond the 18h planning horizon from the force-rebuild instant.
  const farKickoff = new Date(FORCE_REBUILD_MS + 40 * 3_600_000).toISOString();
  const plan = await planWith(
    await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS, (_i, c) => ({
      ...c,
      diagnostics: { ...c.diagnostics, game_start_iso: farKickoff },
    }))
  );

  assert.equal(plan.diagnostics.skipped_outside_horizon, EVENT_COUNT);
  assert.equal(plan.reservations.length, 0);
  const stage = slotStage(plan);
  // Rejected at timing_eligible, so the slot stage never sees them at all.
  assert.equal(stage.input_count, 0);
  assert.equal(stage.rejection_counts.SLOT_NOT_ALLOCATED, 0);
  assert.equal(slotEvidence(plan).slot_unallocated_cause, null);
});

test("R0H-10: a forbidden partial-scope anchor stays rejected as NO_EXECUTABLE_ANCHOR", async () => {
  const plan = await planWith(
    await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS, (i, c) => ({
      ...c,
      market_slug: `Team A${i} vs Team B${i} - 1st Half Winner`,
    }))
  );

  assert.equal(plan.diagnostics.skipped_no_executable_anchor, EVENT_COUNT);
  assert.equal(plan.reservations.length, 0);
  const stage = slotStage(plan);
  assert.equal(stage.rejection_counts.NO_EXECUTABLE_ANCHOR, EVENT_COUNT);
  assert.equal(stage.rejection_counts.SLOT_NOT_ALLOCATED, 0);
  assert.equal(slotEvidence(plan).first_slot_rejection_code, "NO_EXECUTABLE_ANCHOR");
});

// ── 7. The slot stage must always be fully attributable ─────────────────────

test("R0H-11: every timing-eligible event is accounted for by exactly one slot-stage code", async () => {
  const scenarios: Array<[string, FireModelCandidate[]]> = [
    ["all valid", await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS)],
    [
      "no fullmatch anchor",
      await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS, (i, c) => ({
        ...c,
        market_slug: `Will something happen in game ${i}?`,
        providerMarketQuestion: `Will something happen in game ${i}?`,
      })),
    ],
    [
      "no planning identity",
      await physicalEvents(EVENT_COUNT, FORCE_REBUILD_MS, (_i, c) => ({
        ...c,
        diagnostics: { ...c.diagnostics, game_start_iso: null as unknown as string },
      })),
    ],
  ];

  for (const [label, candidates] of scenarios) {
    const stage = slotStage(await planWith(candidates));
    const rejected = Object.values(stage.rejection_counts as Record<string, number>).reduce(
      (sum, n) => sum + n,
      0
    );
    assert.equal(
      stage.input_count - stage.output_count,
      rejected,
      `${label}: slot-stage rejections must exactly account for the input/output gap`
    );
  }
});
