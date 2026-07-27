import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildR0PlanningTrace,
  validateR0PlanningTrace,
  type R0PlanningTrace,
} from "../../lib/executor/r0PlanningTrace";

const RAW = {
  total_db_rows: 8,
  raw_allowed_fullmatch_rows: 6,
  raw_forbidden_rows: 2,
  fullmatch_admitted_count: 4,
  fullmatch_rejected_by_reason: {
    LOW_SCORE: 1,
    LOW_COVERAGE: 1,
  },
};

const PLAN = {
  universe_size: 4,
  event_groups: 3,
  reserved_count: 2,
  skipped_outside_horizon: 1,
  skipped_non_tier1_event: 0,
  skipped_no_executable_anchor: 0,
  fallbackEligibleGroupsSeen: 0,
  fallbackSlotFillReservedCount: 0,
};

test("R0 trace composes exact source-to-reservation stages without treating grouping as rejection", () => {
  const trace = buildR0PlanningTrace({
    runId: "r0-test",
    asOfIso: "2026-07-23T14:00:00.000Z",
    raw: RAW,
    plan: PLAN,
    reservationsCreated: 2,
    evidenceRef: "fixture:tests/contur3/r0PlanningTrace.test.ts",
    lineage: [
      {
        source_row_id: "row-a",
        physical_event_id: "event-a",
        reservation_id: "reservation-a",
        transition: "SUCCESSOR_IDENTITY",
      },
    ],
  });

  assert.deepEqual(
    trace.stages.map((stage) => [stage.stage_name, stage.input_count, stage.output_count, stage.status]),
    [
      ["source_rows_available", 8, 8, "MEASURED"],
      ["fresh_in_window", 8, 8, "MEASURED"],
      ["normalized_rows", 8, 8, "MEASURED"],
      ["market_policy_eligible", 8, 6, "MEASURED"],
      ["planning_eligible", 6, 4, "MEASURED"],
      ["distinct_physical_events", 4, 3, "MEASURED"],
      // R0H: each gate buildReservationPlan applies is its own stage, in order.
      ["executable_anchor_eligible", 3, 3, "MEASURED"],
      ["fullmatch_anchor_eligible", 3, 3, "MEASURED"],
      ["planning_identity_eligible", 3, 3, "MEASURED"],
      ["timing_eligible", 3, 2, "MEASURED"],
      ["slot_eligible", 2, 2, "MEASURED"],
      ["reservations_proposed", 2, 2, "MEASURED"],
      ["reservations_created", 2, 2, "MEASURED"],
    ]
  );
  assert.deepEqual(trace.stages[3].rejection_counts, { MARKET_POLICY_NOT_ALLOWED: 2 });
  assert.deepEqual(trace.stages[4].rejection_counts, { LOW_SCORE: 1, LOW_COVERAGE: 1 });
  assert.deepEqual(trace.stages[5].rejection_counts, {});
  assert.equal(trace.stages[0].evidence_ref, "fixture:tests/contur3/r0PlanningTrace.test.ts");
  assert.equal(validateR0PlanningTrace(trace).valid, true);
});

test("R0H: SLOT_NOT_ALLOCATED is a true residual and never absorbs anchor or identity rejections", () => {
  // Production night-plan:2026-07-27:1700-minsk shape: 33 timing-eligible physical
  // events, zero reserved, and every one of them rejected at the full-match anchor
  // gate. Before R0H the slot residual subtracted only NON_TIER1_EVENT and
  // NO_EXECUTABLE_ANCHOR, so this reported SLOT_NOT_ALLOCATED = 33.
  const trace = buildR0PlanningTrace({
    runId: "night-plan:2026-07-27:1700-minsk",
    asOfIso: "2026-07-27T17:30:33.404Z",
    raw: {
      ...RAW,
      total_db_rows: 1832,
      raw_allowed_fullmatch_rows: 180,
      fullmatch_rejected_by_reason: {},
    },
    plan: {
      ...PLAN,
      universe_size: 180,
      event_groups: 33,
      reserved_count: 0,
      skipped_outside_horizon: 0,
      skipped_no_fullmatch_anchor: 33,
      target_live_slots: 15,
      target_plan_window_start_iso: "2026-07-27T14:00:00.000Z",
      target_plan_window_end_iso: "2026-07-28T05:00:00.000Z",
    },
    reservationsCreated: 0,
  });

  // The rejection is attributed to the gate that actually applied it.
  const anchor = trace.stages.find((stage) => stage.stage_name === "fullmatch_anchor_eligible")!;
  assert.equal(anchor.input_count, 33);
  assert.equal(anchor.output_count, 0);
  assert.equal(anchor.rejection_counts.NO_FULLMATCH_ANCHOR, 33);

  // Nothing survived it, so every downstream stage must see zero input.
  const identity = trace.stages.find((stage) => stage.stage_name === "planning_identity_eligible")!;
  const timing = trace.stages.find((stage) => stage.stage_name === "timing_eligible")!;
  const slot = trace.stages.find((stage) => stage.stage_name === "slot_eligible")!;
  assert.equal(identity.input_count, 0);
  assert.equal(timing.input_count, 0);
  assert.equal(slot.input_count, 0);
  assert.equal(slot.output_count, 0);
  assert.equal(slot.rejection_counts.NO_FULLMATCH_ANCHOR, undefined);
  assert.equal(slot.rejection_counts.SLOT_NOT_ALLOCATED, 0);

  assert.equal(trace.slot_allocation.first_slot_rejection_code, "NO_FULLMATCH_ANCHOR");
  assert.equal(trace.slot_allocation.slot_candidates_considered, 0);
  assert.equal(trace.slot_allocation.slot_capacity_configured, 15);
  assert.equal(trace.slot_allocation.slot_capacity_effective, 15);
  assert.equal(trace.slot_allocation.slot_unallocated_cause, null);
  assert.equal(trace.slot_allocation.slot_target_plan_window_start_iso, "2026-07-27T14:00:00.000Z");
  assert.equal(trace.slot_allocation.slot_allocation_clock_iso, "2026-07-27T17:30:33.404Z");
  assert.equal(validateR0PlanningTrace(trace).valid, true);
});

test("R0H: a genuine capacity stop reports SLOT_NOT_ALLOCATED with cause CAPACITY_FILLED", () => {
  const trace = buildR0PlanningTrace({
    runId: "r0h-capacity",
    asOfIso: "2026-07-27T17:30:33.404Z",
    raw: RAW,
    plan: {
      ...PLAN,
      event_groups: 33,
      reserved_count: 15,
      skipped_outside_horizon: 0,
      target_live_slots: 15,
    },
    reservationsCreated: 15,
  });

  const slot = trace.stages.find((stage) => stage.stage_name === "slot_eligible")!;
  assert.equal(slot.rejection_counts.SLOT_NOT_ALLOCATED, 18);
  assert.equal(trace.slot_allocation.slot_unallocated_cause, "CAPACITY_FILLED");
  assert.equal(trace.slot_allocation.slot_candidates_considered, 33);
  assert.equal(trace.slot_allocation.slot_allocated_count, 15);
  assert.equal(trace.slot_allocation.slot_remaining_capacity, 0);
  assert.equal(validateR0PlanningTrace(trace).valid, true);
});

test("R0H: an unconfigured slot capacity is reported as MISSING_POLICY_FIELD, not as a silent zero", () => {
  const trace = buildR0PlanningTrace({
    runId: "r0h-missing-policy",
    asOfIso: "2026-07-27T17:30:33.404Z",
    raw: RAW,
    plan: { ...PLAN, event_groups: 33, reserved_count: 0, skipped_outside_horizon: 0 },
    reservationsCreated: 0,
  });

  assert.equal(trace.slot_allocation.slot_capacity_configured, null);
  assert.equal(trace.slot_allocation.slot_unallocated_cause, "MISSING_POLICY_FIELD");
});

test("R0 trace reports reservation creation as MEASUREMENT_MISSING when no write evidence exists", () => {
  const trace = buildR0PlanningTrace({
    runId: "r0-preview",
    asOfIso: "2026-07-23T14:00:00.000Z",
    raw: RAW,
    plan: PLAN,
    reservationsCreated: null,
  });
  const terminal = trace.stages.at(-1)!;
  assert.equal(terminal.stage_name, "reservations_created");
  assert.equal(terminal.status, "MEASUREMENT_MISSING");
  assert.equal(terminal.output_count, null);
});

test("R0 validator rejects missing stages, unknown registry stages, invalid continuity, broken lineage, and gate contradictions", () => {
  const base = buildR0PlanningTrace({
    runId: "r0-invalid",
    asOfIso: "2026-07-23T14:00:00.000Z",
    raw: RAW,
    plan: PLAN,
    reservationsCreated: 2,
  });
  const invalid: R0PlanningTrace = {
    ...base,
    stages: [
      ...base.stages.slice(1),
      {
        ...base.stages[1],
        stage_name: "invented_stage",
        stage_index: 99,
        input_count: 99,
        output_count: 99,
      },
    ],
    lineage: [
      {
        source_row_id: "row-lost",
        physical_event_id: null,
        reservation_id: null,
        transition: null,
      },
    ],
  };
  const verdict = validateR0PlanningTrace(invalid, {
    OPPORTUNITY_DENOMINATOR_DEFINED: "PASS",
  });
  assert.equal(verdict.valid, false);
  assert.ok(verdict.failures.includes("REQUIRED_STAGE_MISSING"));
  assert.ok(verdict.failures.includes("UNKNOWN_STAGE_FOR_VERSION"));
  assert.ok(verdict.failures.includes("TRACE_COUNT_CONTINUITY_VIOLATION"));
  assert.ok(verdict.failures.includes("TARGET_LINEAGE_BROKEN_WITHOUT_TRANSITION"));
  assert.ok(verdict.failures.includes("GATE_TRACE_CONTRADICTION"));
});
