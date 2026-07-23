import { createHash } from "node:crypto";

export const R0_STAGE_REGISTRY_VERSION = "r0a-planning-v1" as const;

export type R0TransformationKind =
  | "FILTER_1_TO_0_OR_1"
  | "MAP_1_TO_1"
  | "GROUP_MANY_TO_1"
  | "FAN_OUT_1_TO_MANY"
  | "JOIN"
  | "TERMINAL_SIDE_EFFECT";

export type R0TraceStatus = "MEASURED" | "MEASUREMENT_MISSING" | "INFERRED" | "VIOLATION";

export interface R0StageRegistryEntry {
  stage_name: string;
  stage_index: number;
  stage_version: typeof R0_STAGE_REGISTRY_VERSION;
  input_entity_type: string;
  output_entity_type: string;
  transformation_kind: R0TransformationKind;
  required: true;
}

export const R0_STAGE_REGISTRY: readonly R0StageRegistryEntry[] = [
  ["source_rows_available", "source_row", "source_row", "MAP_1_TO_1"],
  ["fresh_in_window", "source_row", "fresh_source_row", "FILTER_1_TO_0_OR_1"],
  ["normalized_rows", "fresh_source_row", "normalized_row", "MAP_1_TO_1"],
  ["market_policy_eligible", "normalized_row", "policy_eligible_row", "FILTER_1_TO_0_OR_1"],
  ["planning_eligible", "policy_eligible_row", "planning_candidate", "FILTER_1_TO_0_OR_1"],
  ["distinct_physical_events", "planning_candidate", "physical_event", "GROUP_MANY_TO_1"],
  ["timing_eligible", "physical_event", "physical_event", "FILTER_1_TO_0_OR_1"],
  ["slot_eligible", "physical_event", "physical_event", "FILTER_1_TO_0_OR_1"],
  ["reservations_proposed", "physical_event", "reservation", "MAP_1_TO_1"],
  ["reservations_created", "reservation", "reservation", "TERMINAL_SIDE_EFFECT"],
].map(([stage_name, input_entity_type, output_entity_type, transformation_kind], stage_index) => ({
  stage_name,
  stage_index,
  stage_version: R0_STAGE_REGISTRY_VERSION,
  input_entity_type,
  output_entity_type,
  transformation_kind: transformation_kind as R0TransformationKind,
  required: true as const,
}));

export interface R0TargetLineage {
  source_row_id: string;
  physical_event_id: string | null;
  reservation_id: string | null;
  final_candidate_id?: string | null;
  queue_id?: string | null;
  transition: "REJECTION" | "GROUP_TRANSITION" | "SUCCESSOR_IDENTITY" | "TERMINAL_TRANSITION" | null;
}

export interface R0StageTrace extends R0StageRegistryEntry {
  run_id: string;
  as_of_iso: string;
  input_count: number | null;
  output_count: number | null;
  rejection_counts: Record<string, number>;
  status: R0TraceStatus;
  evidence_ref: string;
  evidence_sha256: string;
}

export interface R0PlanningTrace {
  run_id: string;
  as_of_iso: string;
  registry_version: typeof R0_STAGE_REGISTRY_VERSION;
  stages: R0StageTrace[];
  lineage: R0TargetLineage[];
}

export interface R0RawPlanningMetrics {
  total_db_rows: number;
  raw_allowed_fullmatch_rows: number;
  raw_forbidden_rows: number;
  fullmatch_admitted_count: number;
  fullmatch_rejected_by_reason: Record<string, number>;
}

export interface R0ReservationPlanMetrics {
  universe_size: number;
  event_groups: number;
  reserved_count: number;
  skipped_outside_horizon: number;
  skipped_non_tier1_event: number;
  skipped_no_executable_anchor: number;
  fallbackEligibleGroupsSeen: number;
  fallbackSlotFillReservedCount: number;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nonNegative(value: number): number {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

function stage(
  registry: R0StageRegistryEntry,
  input: Omit<R0StageTrace, keyof R0StageRegistryEntry>
): R0StageTrace {
  return {
    ...registry,
    ...input,
    evidence_sha256: sha256({
      stage_name: registry.stage_name,
      input_count: input.input_count,
      output_count: input.output_count,
      rejection_counts: input.rejection_counts,
      status: input.status,
      evidence_ref: input.evidence_ref,
    }),
  };
}

export function buildR0PlanningTrace(input: {
  runId: string;
  asOfIso: string;
  raw: R0RawPlanningMetrics;
  plan: R0ReservationPlanMetrics;
  reservationsCreated: number | null;
  lineage?: R0TargetLineage[];
  evidenceRef?: string;
}): R0PlanningTrace {
  const sourceRows = nonNegative(input.raw.total_db_rows);
  const policyEligible = nonNegative(input.raw.raw_allowed_fullmatch_rows);
  const planningEligible = nonNegative(input.plan.universe_size);
  const physicalEvents = nonNegative(input.plan.event_groups);
  const timingEligible = nonNegative(physicalEvents - input.plan.skipped_outside_horizon);
  const proposed = nonNegative(input.plan.reserved_count);
  const slotRejected = nonNegative(
    timingEligible -
      proposed -
      input.plan.skipped_non_tier1_event -
      input.plan.skipped_no_executable_anchor
  );
  const evidenceRef =
    input.evidenceRef ?? "runtime:buildFireModelCandidates->buildReservationPlan";
  const values: Array<{
    input_count: number | null;
    output_count: number | null;
    rejection_counts: Record<string, number>;
    status: R0TraceStatus;
  }> = [
    { input_count: sourceRows, output_count: sourceRows, rejection_counts: {}, status: "MEASURED" },
    { input_count: sourceRows, output_count: sourceRows, rejection_counts: {}, status: "MEASURED" },
    { input_count: sourceRows, output_count: sourceRows, rejection_counts: {}, status: "MEASURED" },
    {
      input_count: sourceRows,
      output_count: policyEligible,
      rejection_counts: { MARKET_POLICY_NOT_ALLOWED: nonNegative(sourceRows - policyEligible) },
      status: "MEASURED",
    },
    {
      input_count: policyEligible,
      output_count: planningEligible,
      rejection_counts: { ...input.raw.fullmatch_rejected_by_reason },
      status: "MEASURED",
    },
    {
      input_count: planningEligible,
      output_count: physicalEvents,
      rejection_counts: {},
      status: "MEASURED",
    },
    {
      input_count: physicalEvents,
      output_count: timingEligible,
      rejection_counts: { OUTSIDE_PLANNING_HORIZON: nonNegative(input.plan.skipped_outside_horizon) },
      status: "MEASURED",
    },
    {
      input_count: timingEligible,
      output_count: proposed,
      rejection_counts: {
        NON_TIER1_EVENT: nonNegative(input.plan.skipped_non_tier1_event),
        NO_EXECUTABLE_ANCHOR: nonNegative(input.plan.skipped_no_executable_anchor),
        SLOT_NOT_ALLOCATED: slotRejected,
      },
      status: "MEASURED",
    },
    { input_count: proposed, output_count: proposed, rejection_counts: {}, status: "MEASURED" },
    {
      input_count: proposed,
      output_count: input.reservationsCreated === null ? null : nonNegative(input.reservationsCreated),
      rejection_counts: {},
      status: input.reservationsCreated === null ? "MEASUREMENT_MISSING" : "MEASURED",
    },
  ];

  return {
    run_id: input.runId,
    as_of_iso: input.asOfIso,
    registry_version: R0_STAGE_REGISTRY_VERSION,
    stages: R0_STAGE_REGISTRY.map((registry, index) =>
      stage(registry, {
        run_id: input.runId,
        as_of_iso: input.asOfIso,
        evidence_ref: evidenceRef,
        evidence_sha256: "",
        ...values[index],
      })
    ),
    lineage: input.lineage ?? [],
  };
}

export type R0TraceFailure =
  | "REQUIRED_STAGE_MISSING"
  | "UNKNOWN_STAGE_FOR_VERSION"
  | "TRACE_COUNT_CONTINUITY_VIOLATION"
  | "TRACE_REJECTION_ACCOUNTING_VIOLATION"
  | "TARGET_LINEAGE_BROKEN_WITHOUT_TRANSITION"
  | "GATE_TRACE_CONTRADICTION";

export interface R0TraceValidation {
  valid: boolean;
  failures: R0TraceFailure[];
}

export function validateR0PlanningTrace(
  trace: R0PlanningTrace,
  gates: { OPPORTUNITY_DENOMINATOR_DEFINED?: "PASS" | "FAIL" | "OPEN" } = {}
): R0TraceValidation {
  const failures = new Set<R0TraceFailure>();
  const registryByName = new Map(R0_STAGE_REGISTRY.map((entry) => [entry.stage_name, entry]));
  const names = new Set(trace.stages.map((entry) => entry.stage_name));

  if (R0_STAGE_REGISTRY.some((entry) => !names.has(entry.stage_name))) {
    failures.add("REQUIRED_STAGE_MISSING");
  }
  if (trace.stages.some((entry) => !registryByName.has(entry.stage_name))) {
    failures.add("UNKNOWN_STAGE_FOR_VERSION");
  }
  if (trace.stages[0]?.stage_index !== 0) {
    failures.add("TRACE_COUNT_CONTINUITY_VIOLATION");
  }

  for (let index = 0; index < trace.stages.length; index += 1) {
    const current = trace.stages[index];
    const registry = registryByName.get(current.stage_name);
    if (registry && current.stage_index !== registry.stage_index) {
      failures.add("TRACE_COUNT_CONTINUITY_VIOLATION");
    }
    const next = trace.stages[index + 1];
    if (
      next &&
      current.output_entity_type === next.input_entity_type &&
      current.output_count !== null &&
      next.input_count !== null &&
      current.output_count !== next.input_count
    ) {
      failures.add("TRACE_COUNT_CONTINUITY_VIOLATION");
    }
    if (
      current.transformation_kind === "FILTER_1_TO_0_OR_1" &&
      current.input_count !== null &&
      current.output_count !== null
    ) {
      const rejected = Object.values(current.rejection_counts).reduce((sum, count) => sum + count, 0);
      if (current.output_count > current.input_count || rejected > current.input_count - current.output_count) {
        failures.add("TRACE_REJECTION_ACCOUNTING_VIOLATION");
      }
    }
  }

  if (
    trace.lineage.some(
      (target) =>
        target.physical_event_id === null &&
        target.reservation_id === null &&
        target.transition === null
    )
  ) {
    failures.add("TARGET_LINEAGE_BROKEN_WITHOUT_TRANSITION");
  }

  const hasMissing = trace.stages.some((entry) => entry.status !== "MEASURED");
  if (
    gates.OPPORTUNITY_DENOMINATOR_DEFINED === "PASS" &&
    (hasMissing || failures.size > 0)
  ) {
    failures.add("GATE_TRACE_CONTRADICTION");
  }

  return { valid: failures.size === 0, failures: [...failures].sort() };
}
