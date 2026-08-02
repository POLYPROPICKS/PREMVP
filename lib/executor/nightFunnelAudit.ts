// lib/executor/nightFunnelAudit.ts
//
// Pure (no DB, no network) assembly of the exact night-plan funnel from
// values ALREADY produced by the real production functions:
//   - RawPlanningDiagnostics          (buildFireModelCandidates planningMode)
//   - ReservationPlan["diagnostics"]  (buildReservationPlan)
//   - FrozenModelV2ShadowResult       (produceFrozenModelV2ShadowDecisions)
//
// This module NEVER recomputes a threshold, score, tier, timing, price, or
// grouping decision — it only reshapes counts the production code already
// emitted into an auditable input/dropped/output funnel and enforces the
// arithmetic invariant `input === dropped + output` per stage. It has no
// Supabase import and performs no I/O, so it is fully unit-testable with
// fixtures and can never mutate production state.

import type { RawPlanningDiagnostics } from "./buildFireModelCandidates";
import type { ReservationPlan } from "./nightEventReservations";
import type {
  FrozenModelV2ShadowResult,
  FrozenModelV2Rejection,
  FrozenModelV2RejectionReason,
} from "@/lib/modeling/frozenModelProducerV2Shadow";

export type ReservationPlanDiagnostics = ReservationPlan["diagnostics"];

export interface FunnelStage {
  /** Human-ordered stage label, e.g. "01 source rows loaded". */
  stage: string;
  input: number;
  dropped: number;
  output: number;
  /** Exact reason code for the drop at this stage (never an unexplained "other"). */
  reason: string;
  /** Production file/function the numbers came from. */
  source: string;
}

export class FunnelArithmeticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunnelArithmeticError";
  }
}

/**
 * Thrown when the builder's named rejection-reason totals do not reconcile
 * with the observed drop between source-admitted rows and returned
 * candidates. This is a STRICTER check than assertStageArithmetic: a stage
 * built as `output = input - dropped` always balances trivially, so an
 * unattributed collapse (candidates == 0 with no named reason explaining it)
 * or a contradiction (named reasons summing to something other than the
 * actual drop) must fail closed here instead of silently passing.
 */
export class PlanningAttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningAttributionError";
  }
}

/**
 * Enforce `input === dropped + output` on every stage. Throws
 * FunnelArithmeticError on the first violation, naming the offending stage —
 * an audit that cannot balance its own arithmetic must fail loudly, never
 * silently print numbers that don't add up.
 */
export function assertStageArithmetic(stages: readonly FunnelStage[]): void {
  for (const s of stages) {
    if (s.input !== s.dropped + s.output) {
      throw new FunnelArithmeticError(
        `stage "${s.stage}": input=${s.input} !== dropped=${s.dropped} + output=${s.output}`,
      );
    }
  }
}

/**
 * Enforce continuity for the real planning chain, at minimum:
 *   stage 04 output === stage 04b input
 *   stage 04b output === stage 05 input (via the 04c upstream-authority
 *     bridge, when present -- 04b output === 04c input === 04c output === 05
 *     input)
 *
 * Deliberately NOT a blanket adjacent-pair check over the whole funnel:
 * stages 18->19 compare PLANNED vs ACTUAL persisted reservations by design
 * (they are allowed to differ), and the contract-A funnel is two
 * intentionally separate same-granularity segments (row-level A01-A02,
 * group-level A03-A06) per buildContractAFunnel's own contract -- forcing
 * continuity across either of those would misreport a designed comparison
 * point as a data gap. Only the named planning-chain stages are checked here.
 * Throws PlanningAttributionError before arithmetic_ok can ever be reported
 * true on a genuine silent gap in this chain.
 */
export function assertFunnelContinuity(stages: readonly FunnelStage[]): void {
  const byPrefix = (prefix: string): FunnelStage | undefined =>
    stages.find((s) => s.stage.startsWith(prefix));

  const stage04 = byPrefix("04 rows after source-admission");
  const stage04b = byPrefix("04b");
  const stage04c = byPrefix("04c");
  const stage05 = byPrefix("05 planning candidate universe");

  if (stage04 && stage04b && stage04.output !== stage04b.input) {
    throw new PlanningAttributionError(
      `funnel continuity break: "${stage04.stage}".output=${stage04.output} !== "${stage04b.stage}".input=${stage04b.input}`,
    );
  }

  if (stage04b && stage04c && stage04b.output !== stage04c.input) {
    throw new PlanningAttributionError(
      `funnel continuity break: "${stage04b.stage}".output=${stage04b.output} !== "${stage04c.stage}".input=${stage04c.input}`,
    );
  }

  if (stage05) {
    const bridge = stage04c ?? stage04b;
    if (bridge && bridge.output !== stage05.input) {
      throw new PlanningAttributionError(
        `funnel continuity break: "${bridge.stage}".output=${bridge.output} !== "${stage05.stage}".input=${stage05.input}`,
      );
    }
  }
}

/** Evidence-backed invocation counts, incremented only by real call sites (never a manual constant). */
export interface BuilderInvocationCounters {
  builderInvocationCount: number;
  planFetchCandidatesCallCount: number;
}

export function createBuilderInvocationCounters(): BuilderInvocationCounters {
  return { builderInvocationCount: 0, planFetchCandidatesCallCount: 0 };
}

/**
 * Wrap the exact function that calls buildFireModelCandidates so
 * `builderInvocationCount` increments only when that call actually runs and
 * resolves -- proof by call site, not a manually incremented constant.
 */
export function wrapBuilderInvocation<F extends (...args: never[]) => Promise<unknown>>(
  counters: BuilderInvocationCounters,
  builderCall: F,
): F {
  return (async (...args: Parameters<F>) => {
    const result = await builderCall(...args);
    counters.builderInvocationCount += 1;
    return result;
  }) as F;
}

/**
 * Wrap the exact `deps.fetchCandidates` closure supplied to
 * buildReservationPlan so `planFetchCandidatesCallCount` increments only
 * inside that seam -- proof the plan consumed the SAME candidate set, never a
 * second database candidate load.
 */
export function wrapPlanFetchCandidates<F extends (...args: never[]) => Promise<unknown>>(
  counters: BuilderInvocationCounters,
  fetchCandidates: F,
): F {
  return (async (...args: Parameters<F>) => {
    counters.planFetchCandidatesCallCount += 1;
    return fetchCandidates(...args);
  }) as F;
}

/** A stage whose input is the previous stage's output; drops `dropped` for `reason`. */
function chain(
  stage: string,
  input: number,
  dropped: number,
  reason: string,
  source: string,
): FunnelStage {
  return { stage, input, dropped, output: input - dropped, reason, source };
}

export interface PlanningAttributionInput {
  raw: RawPlanningDiagnostics | null;
  /** Exact candidates.length returned by the SAME single builder invocation. */
  returnedCandidateCount: number;
  /** Evidence-backed count of buildFireModelCandidates calls (must be exactly 1). */
  builderInvocationCount: number;
  /** Evidence-backed count of buildReservationPlan's deps.fetchCandidates calls (must be exactly 1). */
  planFetchCandidatesCallCount: number;
}

export interface PlanningAttributionResult {
  stage: FunnelStage;
  /**
   * One zero-width "P-reason <CODE>" stage per named POST-source-admission
   * rejection reason. Deliberately excludes WEAK_EVENT_IDENTITY and
   * UNKNOWN_REJECT_NEEDS_CODE_TRACE -- those rows were already counted as
   * dropped at stage 03 (planning-shadow rejection); surfacing them again
   * here would double-count the same row. See
   * `planning_shadow_reasons_already_counted_at_stage_03`.
   */
  reasonStages: FunnelStage[];
  /** Full raw map, unfiltered -- never removed or renamed, per contract. */
  rejected_before_planning_by_reason: Record<string, number>;
  /** The subset of the map above already attributed to stage 03 (planning-shadow). */
  planning_shadow_reasons_already_counted_at_stage_03: Record<string, number>;
  dropped_by_formula_version_and_reason: Record<string, Record<string, number>>;
  market_policy_rejected_by_reason: Record<string, number>;
  fullmatch_rejected_by_reason: Record<string, number>;
  malformed_provider_sport_count: number;
  unsupported_provider_sport_count: number;
  rejected_rows_by_raw_provider_sport_and_reason: Record<string, Record<string, number>>;
  missing_fullmatch_fixtures: RawPlanningDiagnostics["missing_fullmatch_fixtures"];
  returned_candidate_count: number;
  builder_invocation_count: number;
  plan_fetch_candidates_call_count: number;
}

/**
 * Rejection reasons that `buildFireModelCandidates` already attributed to the
 * stage 03 planning-shadow rejection (see
 * PlanningAttributionInput/`raw.planning_shadow_rejected_count`). They are
 * present in `rejected_before_planning_by_reason` (the whole-builder map) but
 * MUST NOT also appear as a stage 04b (post-admission) P-reason -- that would
 * count the same dropped row twice.
 */
const SHADOW_REASONS_ALREADY_COUNTED_AT_STAGE_03 = [
  "WEAK_EVENT_IDENTITY",
  "UNKNOWN_REJECT_NEEDS_CODE_TRACE",
] as const;

/** Sum of a reason-count record's values. */
function sumReasonCounts(byReason: Record<string, number>): number {
  return Object.values(byReason).reduce((a, b) => a + b, 0);
}

/**
 * Stage 04b: source-admitted (scored) rows -> planning candidates.
 *
 * Two DISTINCT invariants are enforced, never conflated:
 *
 *  1. Whole-builder invariant (all rows the builder ever saw):
 *       raw.total_db_rows === authoritativeDropped + returnedCandidateCount
 *     where authoritativeDropped = sum(raw.rejected_before_planning_by_reason)
 *     — this includes BOTH the stage-03 planning-shadow rejects AND the
 *     post-admission rejects, because every dropped merged row (shadow or
 *     not) passes through `rejectReason(reason)` into that one map.
 *
 *  2. Stage 04b arithmetic (only the scored/post-admission universe):
 *       raw.scored_rows_count === postAdmissionDropped + returnedCandidateCount
 *     where postAdmissionDropped = authoritativeDropped - shadowDropped.
 *     Using `raw.total_db_rows` here (as before) silently re-counts the
 *     403 planning-shadow rejects a second time on top of the 2827-row
 *     scored pool -- that double-counting is exactly what this stage must
 *     never do again.
 *
 * A third check (planning-shadow overlap) proves the two shadow reason codes
 * inside `rejected_before_planning_by_reason` are exactly what stage 03
 * already reported as dropped, so subtracting them once here is provably
 * correct rather than assumed.
 *
 * No Math.max is used anywhere in this function: every contradiction must
 * throw PlanningAttributionError, never be silently floored to zero.
 */
export function buildAttributablePlanningStage(
  input: PlanningAttributionInput,
): PlanningAttributionResult {
  const { raw, returnedCandidateCount, builderInvocationCount, planFetchCandidatesCallCount } = input;
  const src = "buildFireModelCandidates(CONTRACT_A_PLANNING_V1)/RawPlanningDiagnostics";
  const stageName = "04b source-admitted rows -> planning candidates";

  if (builderInvocationCount !== 1) {
    throw new PlanningAttributionError(
      `stage "${stageName}": builder_invocation_count=${builderInvocationCount}, expected exactly 1 ` +
        `(audit must call buildFireModelCandidates exactly once, never a second database candidate load)`,
    );
  }
  if (planFetchCandidatesCallCount !== 1) {
    throw new PlanningAttributionError(
      `stage "${stageName}": plan_fetch_candidates_call_count=${planFetchCandidatesCallCount}, expected exactly 1 ` +
        `(buildReservationPlan must consume the SAME builder candidate set, never a second fetch)`,
    );
  }

  const byReason = raw?.rejected_before_planning_by_reason ?? {};
  const authoritativeDropped = sumReasonCounts(byReason);
  const totalDbRows = raw?.total_db_rows ?? 0;

  // 1. Whole-builder invariant -- separate from stage 04b arithmetic below.
  if (totalDbRows !== authoritativeDropped + returnedCandidateCount) {
    throw new PlanningAttributionError(
      `stage "${stageName}": total_db_rows=${totalDbRows} !== authoritative_dropped=${authoritativeDropped} ` +
        `+ returned_candidate_count=${returnedCandidateCount}; rejected_before_planning_by_reason does not reconcile ` +
        `with the whole-builder row count`,
    );
  }

  const shadowDropped = raw?.planning_shadow_rejected_count ?? 0;
  const shadowWeakEventIdentity = byReason.WEAK_EVENT_IDENTITY ?? 0;
  const shadowUnknownReject = byReason.UNKNOWN_REJECT_NEEDS_CODE_TRACE ?? 0;

  // 2. Planning-shadow overlap invariant.
  if (shadowDropped !== shadowWeakEventIdentity + shadowUnknownReject) {
    throw new PlanningAttributionError(
      `stage "${stageName}": planning_shadow_rejected_count=${shadowDropped} !== ` +
        `rejected_before_planning_by_reason.WEAK_EVENT_IDENTITY=${shadowWeakEventIdentity} + ` +
        `rejected_before_planning_by_reason.UNKNOWN_REJECT_NEEDS_CODE_TRACE=${shadowUnknownReject}`,
    );
  }

  const inputCount = raw?.scored_rows_count ?? 0;
  const postAdmissionDropped = authoritativeDropped - shadowDropped;

  if (postAdmissionDropped < 0) {
    throw new PlanningAttributionError(
      `stage "${stageName}": post_admission_dropped=${postAdmissionDropped} is negative ` +
        `(authoritative_dropped=${authoritativeDropped}, shadow_dropped=${shadowDropped})`,
    );
  }

  // 3. Stage 04b arithmetic on the scored (post-admission) universe only.
  if (inputCount !== postAdmissionDropped + returnedCandidateCount) {
    throw new PlanningAttributionError(
      `stage "${stageName}": scored_rows_count=${inputCount} !== post_admission_dropped=${postAdmissionDropped} ` +
        `+ returned_candidate_count=${returnedCandidateCount}`,
    );
  }

  const stage: FunnelStage = {
    stage: stageName,
    input: inputCount,
    dropped: postAdmissionDropped,
    output: returnedCandidateCount,
    reason: "REJECTED_AFTER_SOURCE_ADMISSION (see P-reason breakdown)",
    source: `${src}.{scored_rows_count,rejected_before_planning_by_reason}`,
  };

  const shadowReasonsAlreadyCounted: Record<string, number> = {};
  for (const key of SHADOW_REASONS_ALREADY_COUNTED_AT_STAGE_03) {
    if (byReason[key] !== undefined) shadowReasonsAlreadyCounted[key] = byReason[key];
  }

  const reasonStages: FunnelStage[] = Object.keys(byReason)
    .filter((reason) => !(SHADOW_REASONS_ALREADY_COUNTED_AT_STAGE_03 as readonly string[]).includes(reason))
    .sort()
    .map((reason) => ({
      stage: `P-reason ${reason}`,
      input: byReason[reason],
      dropped: byReason[reason],
      output: 0,
      reason,
      source: `${src}.rejected_before_planning_by_reason`,
    }));

  return {
    stage,
    reasonStages,
    rejected_before_planning_by_reason: byReason,
    planning_shadow_reasons_already_counted_at_stage_03: shadowReasonsAlreadyCounted,
    dropped_by_formula_version_and_reason: raw?.dropped_by_formula_version_and_reason ?? {},
    market_policy_rejected_by_reason: raw?.market_policy_rejected_by_reason ?? {},
    fullmatch_rejected_by_reason: raw?.fullmatch_rejected_by_reason ?? {},
    malformed_provider_sport_count: raw?.malformed_provider_sport_count ?? 0,
    unsupported_provider_sport_count: raw?.unsupported_provider_sport_count ?? 0,
    rejected_rows_by_raw_provider_sport_and_reason:
      raw?.rejected_rows_by_raw_provider_sport_and_reason ?? {},
    missing_fullmatch_fixtures: raw?.missing_fullmatch_fixtures ?? [],
    returned_candidate_count: returnedCandidateCount,
    builder_invocation_count: builderInvocationCount,
    plan_fetch_candidates_call_count: planFetchCandidatesCallCount,
  };
}

/**
 * Planning funnel (generated_signal_pairs -> RESERVED/SKIPPED), assembled
 * strictly from RawPlanningDiagnostics + ReservationPlan.diagnostics. Reserved
 * and skipped counts come from the ACTUAL persisted reservation rows for the
 * plan (read by the caller), not recomputed here.
 */
export function buildPlanningFunnel(input: {
  raw: RawPlanningDiagnostics | null;
  plan: ReservationPlanDiagnostics;
  reservedCount: number;
  skippedCount: number;
  /** Exact candidates.length returned by the SAME single builder invocation. */
  returnedCandidateCount: number;
  /** Evidence-backed count of buildFireModelCandidates calls (must be exactly 1). */
  builderInvocationCount: number;
  /** Evidence-backed count of buildReservationPlan's deps.fetchCandidates calls (must be exactly 1). */
  planFetchCandidatesCallCount: number;
}): FunnelStage[] {
  const { raw, plan } = input;
  const src = "buildFireModelCandidates(CONTRACT_A_PLANNING_V1)/RawPlanningDiagnostics";
  const planSrc = "buildReservationPlan/ReservationPlan.diagnostics";
  const stages: FunnelStage[] = [];

  if (raw) {
    const totalDb = raw.total_db_rows;
    const shadowRejected = raw.planning_shadow_rejected_count;
    const scored = raw.scored_rows_count;

    stages.push(chain("01 source rows loaded", totalDb, 0, "SOURCE_TOTAL", `${src}.total_db_rows`));
    stages.push(
      chain(
        "03 rows rejected by source/version/lookback predicates",
        totalDb,
        shadowRejected,
        "PLANNING_SHADOW_REJECTED (see planning_shadow_reject_reasons)",
        `${src}.planning_shadow_rejected_count`,
      ),
    );
    // scored_rows_count is the survivors after version/shadow admission.
    stages.push(
      chain(
        "04 rows after source-admission (scored universe)",
        totalDb - shadowRejected,
        Math.max(0, totalDb - shadowRejected - scored),
        "PRE_SCORE_ADMISSION_DELTA",
        `${src}.scored_rows_count`,
      ),
    );

    const attribution = buildAttributablePlanningStage({
      raw,
      returnedCandidateCount: input.returnedCandidateCount,
      builderInvocationCount: input.builderInvocationCount,
      planFetchCandidatesCallCount: input.planFetchCandidatesCallCount,
    });
    stages.push(attribution.stage);
    stages.push(...attribution.reasonStages);

    // Stage 04c: ReservationPlan's own upstream-authority filter
    // (buildReservationPlan drops any candidate failing isUpstreamRejected
    // BEFORE computing universe_size). This is a real, separate drop -- not
    // part of stage 04b -- so it gets its own bridging stage rather than
    // silently reconciling stage 04b's output against a smaller universe_size.
    stages.push(
      chain(
        "04c candidates surviving ReservationPlan upstream-authority filter",
        input.returnedCandidateCount,
        plan.upstream_rejected_candidates_dropped,
        "UPSTREAM_REJECTED (ReservationPlan authority boundary)",
        `${planSrc}.upstream_rejected_candidates_dropped`,
      ),
    );
  }

  // Reservation-plan grouping/selection stages (physical-event dedup + slots).
  const universe = plan.universe_size;
  const canonicalGroups = plan.canonical_event_groups;
  const eventGroups = plan.event_groups;

  stages.push(
    chain(
      "05 planning candidate universe",
      universe,
      0,
      "PLANNING_UNIVERSE",
      `${planSrc}.universe_size`,
    ),
  );
  stages.push(
    chain(
      "13 unique physical events (after canonical grouping)",
      universe,
      Math.max(0, universe - canonicalGroups),
      "COLLAPSED_TO_CANONICAL_PHYSICAL_EVENT",
      `${planSrc}.canonical_event_groups (raw event_groups=${eventGroups})`,
    ),
  );
  stages.push(
    chain(
      "14 Tier1 primary reservations planned",
      canonicalGroups,
      Math.max(0, canonicalGroups - plan.tier1ReservationsPlanned),
      "NOT_TIER1_PRIMARY (skipped_non_tier1_event / no_executable_anchor / outside_horizon / cap)",
      `${planSrc}.tier1ReservationsPlanned`,
    ),
  );
  stages.push(
    chain(
      "17 fallback slot-fill reservations added",
      plan.tier1ReservationsPlanned + plan.fallbackSlotFillReservedCount,
      0,
      `FALLBACK_SLOT_FILL (tier2=${plan.fallbackTier2Reserved} tier3=${plan.fallbackTier3Reserved})`,
      `${planSrc}.fallbackSlotFillReservedCount`,
    ),
  );
  stages.push(
    chain(
      "18 final planned reservation rows",
      plan.reserved_count,
      0,
      "PLANNED_RESERVATIONS_TOTAL",
      `${planSrc}.reserved_count (targetLiveSlots=${plan.targetLiveSlots})`,
    ),
  );
  stages.push(
    chain(
      "19 actual RESERVED / 20 actual SKIPPED",
      input.reservedCount + input.skippedCount,
      input.skippedCount,
      "PERSISTED_RESERVATION_STATUS",
      "night_event_reservations (actual DB rows for plan)",
    ),
  );

  return stages;
}

/** Group-level rejection reasons: one rejection per strict identity bucket. */
const GROUP_LEVEL_REASONS: ReadonlySet<FrozenModelV2RejectionReason> = new Set<FrozenModelV2RejectionReason>([
  "UNSUPPORTED_MARKET",
  "ESPORTS_EXCLUDED",
  "SCORE_BELOW_65",
  "PRICE_BELOW_030",
  "OUTSIDE_120M",
  "DUPLICATE_EVENT_LOWER_RANK",
]);

/**
 * A rejection is row-level (pre-identity) when it carries no observationId —
 * the producer emits these for createdMs-null / future rows and identity
 * failures before a strict bucket exists. Group-level rejections always carry
 * a non-null observationId. SNAPSHOT_NOT_T90_COMPATIBLE appears in BOTH forms,
 * disambiguated purely by observationId presence (never by the reason string).
 */
export function isGroupLevelRejection(r: FrozenModelV2Rejection): boolean {
  if (GROUP_LEVEL_REASONS.has(r.reason)) return true;
  // Group-level SNAPSHOT_NOT_T90_COMPATIBLE carries an observationId; the
  // pre-identity form does not.
  return r.reason === "SNAPSHOT_NOT_T90_COMPATIBLE" && r.observationId !== null;
}

export function tallyRejections(
  rejections: readonly FrozenModelV2Rejection[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rejections) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}

/**
 * Strict identity groups (buckets) reconciliation: every bucket ends as
 * exactly one of accepted, a group-gate rejection, or a duplicate-event
 * rejection. Therefore:
 *   strictIdentityGroups === accepted + Σ(group-level rejections)
 * Returned so the caller/tests can assert TDD invariant #5.
 */
export function reconcileStrictIdentityGroups(result: FrozenModelV2ShadowResult): {
  strictIdentityGroups: number;
  accepted: number;
  groupLevelRejections: number;
  eligiblePreDedup: number;
  duplicateEventRejections: number;
} {
  const accepted = result.acceptedDecisions.length;
  const groupLevel = result.rejections.filter(isGroupLevelRejection);
  const duplicates = groupLevel.filter((r) => r.reason === "DUPLICATE_EVENT_LOWER_RANK").length;
  return {
    strictIdentityGroups: accepted + groupLevel.length,
    accepted,
    groupLevelRejections: groupLevel.length,
    eligiblePreDedup: result.eligibleCount,
    duplicateEventRejections: duplicates,
  };
}

/**
 * Contract A executable funnel from a frozen producer result. Row-level
 * pre-identity drops and group-level gate drops are reported in separate,
 * clearly-labelled contiguous chains so `input === dropped + output` holds
 * within each same-granularity segment (row-granularity, then group-granularity).
 */
export function buildContractAFunnel(result: FrozenModelV2ShadowResult, label: string): FunnelStage[] {
  const src = `produceFrozenModelV2ShadowDecisions[${label}]`;
  const byReason = tallyRejections(result.rejections);
  const rowLevel = result.rejections.filter((r) => !isGroupLevelRejection(r));
  const groupLevel = result.rejections.filter(isGroupLevelRejection);

  const rowLevelCount = rowLevel.length;
  const groupLevelCount = groupLevel.length;
  const recon = reconcileStrictIdentityGroups(result);

  const stages: FunnelStage[] = [];

  // Row-granularity chain: source rows -> survivors that formed strict buckets.
  stages.push(chain("A01 source rows", result.inputCount, 0, "SOURCE_ROWS", `${src}.inputCount`));
  stages.push(
    chain(
      "A02 after row-level pre-identity drops (T-90 / future / missing identity)",
      result.inputCount,
      rowLevelCount,
      "ROW_LEVEL_PRE_IDENTITY (SNAPSHOT_NOT_T90_COMPATIBLE/FUTURE_DATA_REJECTED/MISSING_*)",
      `${src}.rejections (observationId=null)`,
    ),
  );

  // Group-granularity chain: strict identity groups -> accepted one-per-event.
  stages.push(
    chain(
      "A03 strict identity groups (buckets)",
      recon.strictIdentityGroups,
      0,
      "STRICT_IDENTITY_GROUPS",
      `${src} reconciled = accepted + group-level rejections`,
    ),
  );
  stages.push(
    chain(
      "A04 after group-level gates (market/score/price/timing/esports)",
      recon.strictIdentityGroups,
      groupLevelCount - recon.duplicateEventRejections,
      "GROUP_GATES (UNSUPPORTED_MARKET/SCORE_BELOW_65/PRICE_BELOW_030/OUTSIDE_120M/ESPORTS_EXCLUDED/SNAPSHOT_NOT_T90)",
      `${src} group-level rejections`,
    ),
  );
  stages.push(
    chain(
      "A05 eligible pre-event-dedup",
      result.eligibleCount,
      recon.duplicateEventRejections,
      "DUPLICATE_EVENT_LOWER_RANK",
      `${src}.eligibleCount`,
    ),
  );
  stages.push(
    chain(
      "A06 accepted one-per-event decisions",
      result.acceptedDecisions.length,
      0,
      "ACCEPTED",
      `${src}.acceptedDecisions`,
    ),
  );

  // Attach the exact per-reason breakdown as extra zero-width stages so no
  // reason is ever hidden in an "other" bucket.
  for (const reason of Object.keys(byReason).sort()) {
    stages.push({
      stage: `A-reason ${reason}`,
      input: byReason[reason],
      dropped: byReason[reason],
      output: 0,
      reason,
      source: `${src}.rejections by reason`,
    });
  }

  return stages;
}

export interface QueueCounts {
  total: number;
  READY: number;
  CLAIMED: number;
  SENT: number;
  EXECUTED: number;
  FAILED: number;
}

export interface NightFunnelAuditResult {
  plan_id: string;
  planning_funnel: FunnelStage[];
  contract_a_at_plan_time: FunnelStage[];
  contract_a_forecast: FunnelStage[];
  queue: QueueCounts;
  /** True when every assembled stage balances input = dropped + output. */
  arithmetic_ok: boolean;
  // ── Attributable planning rejection evidence (stage 04b), surfaced flat for
  // the JSON summary so no reason is ever hidden behind a stage label alone.
  rejected_before_planning_by_reason: Record<string, number>;
  planning_shadow_reasons_already_counted_at_stage_03: Record<string, number>;
  dropped_by_formula_version_and_reason: Record<string, Record<string, number>>;
  market_policy_rejected_by_reason: Record<string, number>;
  fullmatch_rejected_by_reason: Record<string, number>;
  malformed_provider_sport_count: number;
  unsupported_provider_sport_count: number;
  rejected_rows_by_raw_provider_sport_and_reason: Record<string, Record<string, number>>;
  missing_fullmatch_fixtures: RawPlanningDiagnostics["missing_fullmatch_fixtures"];
  returned_candidate_count: number;
  builder_invocation_count: number;
  plan_fetch_candidates_call_count: number;
}

/**
 * Top-level pure assembly of all funnel sections for one plan. Self-asserts
 * the arithmetic invariant on every assembled section (throws
 * FunnelArithmeticError if any stage fails to balance) and returns a single
 * JSON-serializable result. Recomputes NOTHING about the model — it only
 * reshapes counts the production functions already produced.
 */
export function assembleNightFunnelAudit(input: {
  planId: string;
  raw: RawPlanningDiagnostics | null;
  plan: ReservationPlanDiagnostics;
  reservedCount: number;
  skippedCount: number;
  contractAAtPlanTime: FrozenModelV2ShadowResult;
  contractAForecast: FrozenModelV2ShadowResult;
  queueCounts: QueueCounts;
  /** Exact candidates.length returned by the SAME single builder invocation. */
  returnedCandidateCount: number;
  /** Evidence-backed count of buildFireModelCandidates calls (must be exactly 1). */
  builderInvocationCount: number;
  /** Evidence-backed count of buildReservationPlan's deps.fetchCandidates calls (must be exactly 1). */
  planFetchCandidatesCallCount: number;
}): NightFunnelAuditResult {
  const planning_funnel = buildPlanningFunnel({
    raw: input.raw,
    plan: input.plan,
    reservedCount: input.reservedCount,
    skippedCount: input.skippedCount,
    returnedCandidateCount: input.returnedCandidateCount,
    builderInvocationCount: input.builderInvocationCount,
    planFetchCandidatesCallCount: input.planFetchCandidatesCallCount,
  });
  const contract_a_at_plan_time = buildContractAFunnel(input.contractAAtPlanTime, "AT_PLAN_TIME");
  const contract_a_forecast = buildContractAFunnel(input.contractAForecast, "CURRENT_SOURCE_FORECAST");

  // Self-assert every section; throws loudly on any imbalance.
  assertStageArithmetic(planning_funnel);
  assertStageArithmetic(contract_a_at_plan_time);
  assertStageArithmetic(contract_a_forecast);

  // Self-assert the real planning chain has no silent gap between stages.
  // (Contract-A funnels are intentionally two separate same-granularity
  // segments -- see assertFunnelContinuity's doc comment -- so they are not
  // checked here.)
  assertFunnelContinuity(planning_funnel);

  // Re-derive the same attribution evidence surfaced in stage 04b for the
  // flat JSON summary. Pure/deterministic: if buildPlanningFunnel above did
  // not throw, this cannot throw either.
  const attribution = buildAttributablePlanningStage({
    raw: input.raw,
    returnedCandidateCount: input.returnedCandidateCount,
    builderInvocationCount: input.builderInvocationCount,
    planFetchCandidatesCallCount: input.planFetchCandidatesCallCount,
  });

  return {
    plan_id: input.planId,
    planning_funnel,
    contract_a_at_plan_time,
    contract_a_forecast,
    queue: input.queueCounts,
    arithmetic_ok: true,
    rejected_before_planning_by_reason: attribution.rejected_before_planning_by_reason,
    planning_shadow_reasons_already_counted_at_stage_03:
      attribution.planning_shadow_reasons_already_counted_at_stage_03,
    dropped_by_formula_version_and_reason: attribution.dropped_by_formula_version_and_reason,
    market_policy_rejected_by_reason: attribution.market_policy_rejected_by_reason,
    fullmatch_rejected_by_reason: attribution.fullmatch_rejected_by_reason,
    malformed_provider_sport_count: attribution.malformed_provider_sport_count,
    unsupported_provider_sport_count: attribution.unsupported_provider_sport_count,
    rejected_rows_by_raw_provider_sport_and_reason:
      attribution.rejected_rows_by_raw_provider_sport_and_reason,
    missing_fullmatch_fixtures: attribution.missing_fullmatch_fixtures,
    returned_candidate_count: attribution.returned_candidate_count,
    builder_invocation_count: attribution.builder_invocation_count,
    plan_fetch_candidates_call_count: attribution.plan_fetch_candidates_call_count,
  };
}
