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
