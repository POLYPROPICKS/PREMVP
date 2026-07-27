import { createHash } from "node:crypto";

// v2 (R0H): the funnel now names every gate buildReservationPlan actually applies,
// in the order it applies them. v1 collapsed the executable-anchor, full-match-anchor
// and planning-identity gates into a single `slot_eligible` stage whose rejection set
// was a residual, so an event rejected at an upstream gate was still counted as input
// to the timing and slot stages it never reached.
export const R0_STAGE_REGISTRY_VERSION = "r0h-planning-v2" as const;

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
  // ── The real per-group gate order inside buildReservationPlan ─────────────
  // Each of these `continue`s out of the loop before the next predicate runs,
  // so each stage's input is strictly the previous stage's survivor set.
  ["executable_anchor_eligible", "physical_event", "physical_event", "FILTER_1_TO_0_OR_1"],
  ["fullmatch_anchor_eligible", "physical_event", "physical_event", "FILTER_1_TO_0_OR_1"],
  ["planning_identity_eligible", "physical_event", "physical_event", "FILTER_1_TO_0_OR_1"],
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

export const R0_SLOT_POLICY_VERSION = "r0h-slot-policy-v1" as const;

export interface R0PlanningTrace {
  run_id: string;
  as_of_iso: string;
  registry_version: typeof R0_STAGE_REGISTRY_VERSION;
  stages: R0StageTrace[];
  lineage: R0TargetLineage[];
  slot_allocation: R0SlotAllocationEvidence;
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
  // ── R0H slot attribution ──────────────────────────────────────────────────
  // buildReservationPlan drops a physical event on SIX paths before it can
  // consume a slot, but the slot_eligible stage originally accounted for only
  // two of them (NON_TIER1_EVENT, NO_EXECUTABLE_ANCHOR). SLOT_NOT_ALLOCATED is
  // computed as the residual of that stage, so every event rejected at the
  // full-match anchor or the planning-identity gate was silently relabelled as
  // a slot-allocation failure. Production night-plan:2026-07-27:1700-minsk
  // reported SLOT_NOT_ALLOCATED=33 with zero measured slot pressure for exactly
  // this reason. These two counters close that hole; both are optional so
  // existing callers keep their current (now explicitly zero) attribution.
  skipped_no_fullmatch_anchor?: number;
  skipped_no_planning_identity?: number;
  // Slot policy inputs, so a future SLOT_NOT_ALLOCATED is self-explanatory.
  target_live_slots?: number;
  tier1_reserved_count?: number;
  existing_reservation_count?: number;
  quota_by_scope?: Record<string, number>;
  target_plan_window_start_iso?: string;
  target_plan_window_end_iso?: string;
}

/**
 * Why a timing-eligible physical event that reached the allocator did not take a
 * slot. `null` means no event was left unallocated. Only the causes the current
 * allocator can actually produce are derived here; the remaining members exist so
 * a future bucketed or de-duplicating allocator can emit them without a registry
 * version bump.
 */
export type R0SlotUnallocatedCause =
  | "CAPACITY_ZERO"
  | "CAPACITY_FILLED"
  | "BUCKET_CAP_ZERO"
  | "RANKED_BELOW_CUTOFF"
  | "MISSING_POLICY_FIELD"
  | "DUPLICATE_EVENT";

export interface R0SlotAllocationEvidence {
  slot_policy_version: string;
  slot_capacity_configured: number | null;
  slot_capacity_effective: number | null;
  slot_candidates_considered: number;
  slot_allocated_count: number;
  slot_unallocated_count: number;
  slot_remaining_capacity: number | null;
  slot_existing_reservation_count: number;
  slot_quota_by_scope: Record<string, number>;
  slot_allocation_clock_iso: string;
  slot_target_plan_window_start_iso: string | null;
  slot_target_plan_window_end_iso: string | null;
  first_slot_rejection_code: string | null;
  slot_rejection_counts_by_code: Record<string, number>;
  slot_unallocated_cause: R0SlotUnallocatedCause | null;
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
  const proposed = nonNegative(input.plan.reserved_count);
  const nonTier1 = nonNegative(input.plan.skipped_non_tier1_event);
  const noExecutableAnchor = nonNegative(input.plan.skipped_no_executable_anchor);
  const noFullmatchAnchor = nonNegative(input.plan.skipped_no_fullmatch_anchor ?? 0);
  const noPlanningIdentity = nonNegative(input.plan.skipped_no_planning_identity ?? 0);
  const outsideHorizon = nonNegative(input.plan.skipped_outside_horizon);

  // Survivor set after each real gate, in the order buildReservationPlan applies
  // them. Every count is the previous survivor set minus exactly the events that
  // gate rejected -- never a residual over pre-filter inventory.
  const executableAnchorEligible = nonNegative(physicalEvents - noExecutableAnchor);
  const fullmatchAnchorEligible = nonNegative(executableAnchorEligible - noFullmatchAnchor);
  const planningIdentityEligible = nonNegative(fullmatchAnchorEligible - noPlanningIdentity);
  const timingEligible = nonNegative(planningIdentityEligible - outsideHorizon);

  // SLOT_NOT_ALLOCATED is now a residual over the SLOT STAGE ONLY: events that
  // passed the executable anchor, the full-match anchor, the planning identity
  // and the horizon, were rankable under the existing tier policy, and still lost
  // on real capacity or ranking.
  const slotRejected = nonNegative(timingEligible - nonTier1 - proposed);
  // Why the plan reached the allocator with the inventory it did. This spans the
  // whole path on purpose -- it answers "why was nothing reserved", which an
  // operator asks about the run, not about one stage. The per-stage attribution
  // lives on the stages themselves, where each code appears at its own gate.
  const slotRejectionCountsByCode: Record<string, number> = {};
  for (const [code, count] of [
    ["NO_EXECUTABLE_ANCHOR", noExecutableAnchor],
    ["NO_FULLMATCH_ANCHOR", noFullmatchAnchor],
    ["NO_PLANNING_IDENTITY", noPlanningIdentity],
    ["OUTSIDE_PLANNING_HORIZON", outsideHorizon],
    ["NON_TIER1_EVENT", nonTier1],
    ["SLOT_NOT_ALLOCATED", slotRejected],
  ] as const) {
    if (count > 0) slotRejectionCountsByCode[code] = count;
  }
  // Pipeline order: the earliest gate that rejected anything this run.
  const firstSlotRejectionCode =
    (
      [
        "NO_EXECUTABLE_ANCHOR",
        "NO_FULLMATCH_ANCHOR",
        "NO_PLANNING_IDENTITY",
        "OUTSIDE_PLANNING_HORIZON",
        "NON_TIER1_EVENT",
        "SLOT_NOT_ALLOCATED",
      ] as const
    ).find((code) => (slotRejectionCountsByCode[code] ?? 0) > 0) ?? null;

  const capacityConfigured =
    input.plan.target_live_slots === undefined ? null : nonNegative(input.plan.target_live_slots);
  const existingReservations = nonNegative(input.plan.existing_reservation_count ?? 0);
  const capacityEffective =
    capacityConfigured === null ? null : Math.max(0, capacityConfigured - existingReservations);
  const remainingCapacity =
    capacityConfigured === null
      ? null
      : Math.max(0, capacityConfigured - existingReservations - proposed);
  // Candidates that survived every named gate and were genuinely ranked for a slot.
  const slotCandidatesConsidered = nonNegative(timingEligible - nonTier1);
  const slotUnallocatedCause: R0SlotUnallocatedCause | null =
    slotRejected === 0
      ? null
      : capacityConfigured === null
        ? "MISSING_POLICY_FIELD"
        : capacityConfigured === 0
          ? "CAPACITY_ZERO"
          : capacityEffective === 0 || remainingCapacity === 0
            ? "CAPACITY_FILLED"
            : "RANKED_BELOW_CUTOFF";
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
      output_count: executableAnchorEligible,
      rejection_counts: { NO_EXECUTABLE_ANCHOR: noExecutableAnchor },
      status: "MEASURED",
    },
    {
      input_count: executableAnchorEligible,
      output_count: fullmatchAnchorEligible,
      rejection_counts: { NO_FULLMATCH_ANCHOR: noFullmatchAnchor },
      status: "MEASURED",
    },
    {
      input_count: fullmatchAnchorEligible,
      output_count: planningIdentityEligible,
      rejection_counts: { NO_PLANNING_IDENTITY: noPlanningIdentity },
      status: "MEASURED",
    },
    {
      input_count: planningIdentityEligible,
      output_count: timingEligible,
      rejection_counts: { OUTSIDE_PLANNING_HORIZON: outsideHorizon },
      status: "MEASURED",
    },
    {
      // Only events that survived every upstream gate reach the allocator, so
      // these two codes are the only ones that can be applied here.
      input_count: timingEligible,
      output_count: proposed,
      rejection_counts: {
        NON_TIER1_EVENT: nonTier1,
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
    slot_allocation: {
      slot_policy_version: R0_SLOT_POLICY_VERSION,
      slot_capacity_configured: capacityConfigured,
      slot_capacity_effective: capacityEffective,
      slot_candidates_considered: slotCandidatesConsidered,
      slot_allocated_count: proposed,
      slot_unallocated_count: slotRejected,
      slot_remaining_capacity: remainingCapacity,
      slot_existing_reservation_count: existingReservations,
      slot_quota_by_scope: { ...(input.plan.quota_by_scope ?? {}) },
      slot_allocation_clock_iso: input.asOfIso,
      slot_target_plan_window_start_iso: input.plan.target_plan_window_start_iso ?? null,
      slot_target_plan_window_end_iso: input.plan.target_plan_window_end_iso ?? null,
      first_slot_rejection_code: firstSlotRejectionCode,
      slot_rejection_counts_by_code: slotRejectionCountsByCode,
      slot_unallocated_cause: slotUnallocatedCause,
    },
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
