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
 *  2. Stage 04b arithmetic (only the deduped post-shadow-admission universe):
 *       sourceAdmittedDeduped === postAdmissionDropped + returnedCandidateCount
 *     where sourceAdmittedDeduped = totalDbRows - shadowDropped and
 *     postAdmissionDropped = authoritativeDropped - shadowDropped.
 *     `raw.scored_rows_count` is a RAW pre-dedup query count -- it can
 *     legitimately differ from totalDbRows - shadowDropped in either
 *     direction (merged/duplicate rows in the scoring query) -- so it is
 *     NEVER used as the chained stage input, only surfaced informationally
 *     inside this stage's `source` field. Using it as chained input (as
 *     before) either silently truncates the real pipeline input or throws on
 *     production rows where the raw scored count doesn't match the deduped
 *     admitted universe.
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

  if (!raw) {
    throw new PlanningAttributionError(
      `stage "${stageName}": raw planning diagnostics are null -- cannot attribute planning admission without raw diagnostics (fail closed)`,
    );
  }

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

  // Deduped post-shadow-admission universe -- NEVER raw.scored_rows_count,
  // which is a raw pre-dedup query count and can differ from this value in
  // either direction. See the function doc comment above.
  const sourceAdmittedDeduped = totalDbRows - shadowDropped;
  const postAdmissionDropped = authoritativeDropped - shadowDropped;

  if (postAdmissionDropped < 0) {
    throw new PlanningAttributionError(
      `stage "${stageName}": post_admission_dropped=${postAdmissionDropped} is negative ` +
        `(authoritative_dropped=${authoritativeDropped}, shadow_dropped=${shadowDropped})`,
    );
  }

  // 3. Stage 04b arithmetic on the deduped post-shadow-admission universe only.
  if (sourceAdmittedDeduped !== postAdmissionDropped + returnedCandidateCount) {
    throw new PlanningAttributionError(
      `stage "${stageName}": source_admitted_deduped=${sourceAdmittedDeduped} (total_db_rows-planning_shadow_rejected_count) ` +
        `!== post_admission_dropped=${postAdmissionDropped} + returned_candidate_count=${returnedCandidateCount} ` +
        `(raw.scored_rows_count=${raw.scored_rows_count} is informational only, not used in this check)`,
    );
  }

  const stage: FunnelStage = {
    stage: stageName,
    input: sourceAdmittedDeduped,
    dropped: postAdmissionDropped,
    output: returnedCandidateCount,
    reason: "REJECTED_AFTER_SOURCE_ADMISSION (see P-reason breakdown)",
    source: `${src}.{total_db_rows,planning_shadow_rejected_count,rejected_before_planning_by_reason} (scored_rows_count=${raw.scored_rows_count} informational only)`,
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
    // Deduped post-shadow-admission universe = total_db_rows - shadowRejected.
    // `scored_rows_count` is a raw pre-dedup query count -- it is NEVER used
    // in this chained stage; it is surfaced only as an informational value
    // in `source` below so it stays visible without truncating or inflating
    // the real pipeline input (see buildAttributablePlanningStage doc).
    stages.push(
      chain(
        "04 rows after source-admission (scored universe)",
        totalDb - shadowRejected,
        0,
        "SOURCE_ADMITTED_DEDUPED",
        `${src}.total_db_rows - planning_shadow_rejected_count (scored_rows_count=${scored} informational only, not chained)`,
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

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC_EXACT_ANCHOR_EVIDENCE_PACKET_V1
//
// A single-anchor, read-only lineage packet for the Daily Roadmap Optimizer.
// It eliminates the Optimizer denominator-contamination failure class: a second
// natural anchor from the SAME day is structurally unable to enter the current
// cohort denominator, because every stage is isolated by the ONE deterministically
// selected plan_run_id and, downstream, only by idempotency keys owned by that
// plan's own queue rows.
//
// Like the rest of this module it is pure (no DB, no network) and recomputes NO
// model / scoring / admission / reservation / rebalance / queue decision. It only
// (1) selects one anchor deterministically from candidate plan_run_ids and
// (2) reshapes exact-identifier lineage counts already produced elsewhere,
// carrying UNIT / SOURCE_STAGE / INPUT_DENOMINATOR / OUTPUT_DENOMINATOR /
// LINEAGE_KEY on every reported count and keeping unproven downstream evidence
// explicitly UNKNOWN/absent rather than fabricating a zero.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical natural night-plan anchor id: `night-plan:YYYY-MM-DD:HHMM-<tz>`. */
export const NATURAL_NIGHT_ANCHOR_RE =
  /^night-plan:(\d{4}-\d{2}-\d{2}):(\d{2})(\d{2})-([a-z0-9]+)$/;

export interface ParsedNaturalAnchor {
  plan_run_id: string;
  /** Calendar date component, `YYYY-MM-DD`. */
  date: string;
  /** Wall-clock component, `HHMM`. */
  time: string;
  timezone: string;
  /** `${date} ${time}` — lexicographic order is chronological order (tz-agnostic). */
  sort_key: string;
}

export function parseNaturalAnchor(planRunId: string): ParsedNaturalAnchor | null {
  const m = NATURAL_NIGHT_ANCHOR_RE.exec(planRunId);
  if (!m) return null;
  const [, date, hh, mm, timezone] = m;
  return { plan_run_id: planRunId, date, time: `${hh}${mm}`, timezone, sort_key: `${date} ${hh}${mm}` };
}

export class AnchorResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorResolutionError";
  }
}

/**
 * Thrown when a row that does NOT belong to the selected plan_run_id (or a
 * downstream row whose lineage key is not owned by the selected plan's queue
 * rows) reaches the packet assembler. Cross-anchor contamination must fail
 * closed here — never be silently counted into the cohort denominator.
 */
export class AnchorContaminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorContaminationError";
  }
}

export interface NaturalAnchorResolution {
  /** The evidence cutoff the resolution was performed against (ISO), or null. */
  evidence_cutoff_iso: string | null;
  /** The single deterministically selected latest expected natural anchor. */
  selected: ParsedNaturalAnchor;
  /**
   * Other EXPECTED natural anchors sharing the selected anchor's calendar date
   * that were NOT selected — direct proof that a second same-day anchor is
   * visible to the resolver yet excluded from the cohort.
   */
  same_day_excluded: ParsedNaturalAnchor[];
  /** Every expected natural anchor considered (date <= cutoff), sorted ascending. */
  expected_natural_anchors: ParsedNaturalAnchor[];
  /** Candidate ids ignored because they are not canonical natural anchors. */
  non_natural_ignored: string[];
  /** Natural-anchor ids dropped because their date is after the evidence cutoff. */
  future_anchors_excluded: string[];
}

/**
 * Deterministically select the single latest expected natural anchor from a set
 * of candidate plan_run_ids.
 *
 *  - Non-canonical ids are ignored (surfaced in `non_natural_ignored`).
 *  - When `cutoffIso` is given, anchors dated after the cutoff's UTC date are
 *    "not yet expected" and are excluded (surfaced in `future_anchors_excluded`).
 *  - The selected anchor is the maximum by `${date} ${time}`; the ordering is a
 *    total order, and any residual ambiguity (two ids with an identical sort key)
 *    fails closed rather than picking arbitrarily.
 *
 * No current date, production count, or specific wall-clock value is hard-coded.
 */
export function resolveLatestExpectedNaturalAnchor(
  candidatePlanRunIds: readonly string[],
  opts: { cutoffIso?: string | null } = {},
): NaturalAnchorResolution {
  const cutoffIso = opts.cutoffIso ?? null;
  let cutoffDate: string | null = null;
  if (cutoffIso != null) {
    const ms = Date.parse(cutoffIso);
    if (!Number.isFinite(ms)) {
      throw new AnchorResolutionError(`INVALID_CUTOFF_ISO: ${cutoffIso}`);
    }
    cutoffDate = new Date(ms).toISOString().slice(0, 10);
  }

  const nonNatural: string[] = [];
  const future: string[] = [];
  const parsed: ParsedNaturalAnchor[] = [];
  const seen = new Set<string>();

  for (const id of candidatePlanRunIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = parseNaturalAnchor(id);
    if (!p) {
      nonNatural.push(id);
      continue;
    }
    if (cutoffDate != null && p.date > cutoffDate) {
      future.push(id);
      continue;
    }
    parsed.push(p);
  }

  if (parsed.length === 0) {
    throw new AnchorResolutionError(
      `NO_EXPECTED_NATURAL_ANCHOR: ${candidatePlanRunIds.length} candidate(s) — ` +
        `${nonNatural.length} non-natural, ${future.length} after cutoff`,
    );
  }

  parsed.sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));
  const selected = parsed[parsed.length - 1];

  const topPeers = parsed.filter((p) => p.sort_key === selected.sort_key);
  if (topPeers.length > 1) {
    throw new AnchorResolutionError(
      `AMBIGUOUS_LATEST_ANCHOR: ${topPeers.map((p) => p.plan_run_id).join(", ")}`,
    );
  }

  const same_day_excluded = parsed.filter(
    (p) => p.date === selected.date && p.plan_run_id !== selected.plan_run_id,
  );

  return {
    evidence_cutoff_iso: cutoffIso,
    selected,
    same_day_excluded,
    expected_natural_anchors: parsed,
    non_natural_ignored: nonNatural,
    future_anchors_excluded: future,
  };
}

/** Discriminant of `executor_order_events.executor_meta.reconciliation_v1`
 *  (source of truth: lib/executor/executionReconciliation.ts —
 *  EXECUTION_RECONCILIATION_VERSION). Duplicated as a literal only to keep this
 *  pure module free of a runtime import; it is a stable schema discriminant. */
const RECONCILIATION_V1_DISCRIMINANT = "EXECUTION_RECONCILIATION_V1" as const;

export type EvidenceUnit =
  | "instant"
  | "plan_run_id"
  | "reservation_rows"
  | "queue_rows"
  | "idempotency_keys"
  | "order_event_rows"
  | "settlement_rows";

export type EvidenceStatus = "EXACT" | "UNKNOWN" | "ABSENT";

/**
 * One reported lineage count with its full provenance. `value === null` means
 * UNKNOWN — the count could not be exhaustively established from exact lineage
 * identifiers and MUST NOT be read as zero.
 */
export interface CountedEvidence {
  value: number | null;
  unit: EvidenceUnit;
  source_stage: string;
  input_denominator: number | null;
  output_denominator: number | null;
  lineage_key: string;
  status: EvidenceStatus;
  by_status: Record<string, number> | null;
}

export interface ExactAnchorEvidencePacket {
  packet_version: "DETERMINISTIC_EXACT_ANCHOR_EVIDENCE_PACKET_V1";
  evidence_cutoff_iso: string | null;
  latest_expected_natural_anchor: string;
  same_day_excluded_anchors: string[];
  plan_run_id: string;
  reservation_lineage: CountedEvidence;
  queue_lineage: CountedEvidence;
  downstream_execution_lineage: CountedEvidence;
  settlement_lineage: CountedEvidence;
  /** First stage transition where exact-lineage evidence stops (or null when fully resolved). */
  unresolved_transition: string | null;
  lineage_keys: {
    reservation: "night_event_reservations.plan_run_id";
    queue: "event_execution_queue.plan_run_id";
    order_event: "executor_order_events.idempotency_key";
    settlement: "executor_order_events.executor_meta.reconciliation_v1.clob_order_id";
  };
  isolation_proof: {
    /** Distinct plan_run_ids seen in the reservation rows — must be exactly [plan_run_id]. */
    reservation_plan_run_ids: string[];
    /** Distinct plan_run_ids seen in the queue rows — must be exactly [plan_run_id]. */
    queue_plan_run_ids: string[];
    order_event_idempotency_key_source: "SELECTED_PLAN_QUEUE_ROWS";
    /** Downstream rows presented but rejected because their lineage key is foreign to the selected plan. */
    foreign_rows_rejected: number;
  };
  read_only: true;
}

export interface PacketReservationRow {
  plan_run_id: string;
  status: string;
}
export interface PacketQueueRow {
  plan_run_id: string;
  status: string;
  idempotency_key: string | null;
  reservation_id: string | null;
}
export interface PacketOrderEventRow {
  idempotency_key: string | null;
  order_status?: string | null;
  success?: boolean | null;
  clob_order_id?: string | null;
  executor_meta?: unknown;
}

export interface ExactAnchorPacketInput {
  anchor: NaturalAnchorResolution;
  /** `night_event_reservations` rows already fetched for the selected plan_run_id. */
  reservations: readonly PacketReservationRow[];
  /** `event_execution_queue` rows already fetched for the selected plan_run_id. */
  queueRows: readonly PacketQueueRow[];
  /**
   * `executor_order_events` rows already fetched by exact `idempotency_key IN
   * (<selected plan queue keys>)`, or `null` when downstream order evidence
   * could not be exhaustively established for the selected lineage (e.g. a queue
   * row carries a null idempotency_key, so the key set is not exhaustive).
   */
  orderEvents: readonly PacketOrderEventRow[] | null;
}

const RESERVED_LIKE_STATUSES = new Set(["RESERVED", "QUEUED", "REBALANCE_PENDING"]);

function tallyBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function hasReconciliationV1(meta: unknown): boolean {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const value = (meta as Record<string, unknown>).reconciliation_v1;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).version === RECONCILIATION_V1_DISCRIMINANT;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Assemble the frozen, read-only single-anchor evidence packet from rows that
 * were ALREADY fetched read-only by the caller. Structural isolation is enforced
 * here and fails closed:
 *
 *  - every reservation row and every queue row MUST carry the selected
 *    plan_run_id (a foreign-anchor row throws AnchorContaminationError);
 *  - downstream order events are attributed ONLY through idempotency keys owned
 *    by the selected plan's queue rows — an order event whose key is foreign is
 *    rejected (counted in `foreign_rows_rejected`), never added to the denominator;
 *  - when the queue key set is not exhaustive (or `orderEvents` is null), the
 *    downstream and settlement lineage stay UNKNOWN (value null), never zero.
 */
export function assembleExactAnchorEvidencePacket(
  input: ExactAnchorPacketInput,
): ExactAnchorEvidencePacket {
  const selectedId = input.anchor.selected.plan_run_id;

  // ── Isolation: reservations ────────────────────────────────────────────────
  const foreignReservations = input.reservations.filter((r) => r.plan_run_id !== selectedId);
  if (foreignReservations.length > 0) {
    throw new AnchorContaminationError(
      `reservation rows for a foreign plan_run_id reached the packet: ` +
        `${distinct(foreignReservations.map((r) => r.plan_run_id)).join(", ")} (selected ${selectedId})`,
    );
  }
  const reservationPlanRunIds = distinct(input.reservations.map((r) => r.plan_run_id));

  // ── Isolation: queue ──────────────────────────────────────────────────────
  const foreignQueue = input.queueRows.filter((q) => q.plan_run_id !== selectedId);
  if (foreignQueue.length > 0) {
    throw new AnchorContaminationError(
      `queue rows for a foreign plan_run_id reached the packet: ` +
        `${distinct(foreignQueue.map((q) => q.plan_run_id)).join(", ")} (selected ${selectedId})`,
    );
  }
  const queuePlanRunIds = distinct(input.queueRows.map((q) => q.plan_run_id));

  let foreignRowsRejected = foreignReservations.length + foreignQueue.length;

  const reservation_lineage: CountedEvidence = {
    value: input.reservations.length,
    unit: "reservation_rows",
    source_stage: "RESERVATION (night_event_reservations)",
    input_denominator: input.reservations.length,
    output_denominator: input.reservations.filter((r) => RESERVED_LIKE_STATUSES.has(r.status)).length,
    lineage_key: `night_event_reservations.plan_run_id=${selectedId}`,
    status: "EXACT",
    by_status: tallyBy(input.reservations, (r) => r.status),
  };

  const distinctQueueReservationIds = distinct(
    input.queueRows.map((q) => q.reservation_id).filter((v): v is string => v != null),
  );
  const queue_lineage: CountedEvidence = {
    value: input.queueRows.length,
    unit: "queue_rows",
    source_stage: "QUEUE (event_execution_queue)",
    input_denominator: distinctQueueReservationIds.length,
    output_denominator: input.queueRows.length,
    lineage_key: `event_execution_queue.plan_run_id=${selectedId}`,
    status: "EXACT",
    by_status: tallyBy(input.queueRows, (q) => q.status),
  };

  // ── Downstream execution / order lineage ──────────────────────────────────
  const queueKeys = input.queueRows
    .map((q) => q.idempotency_key)
    .filter((v): v is string => v != null);
  const selectedKeySet = new Set(queueKeys);
  const queueKeySetIsExhaustive =
    input.queueRows.every((q) => q.idempotency_key != null);

  let unresolvedTransition: string | null = null;
  let downstream_execution_lineage: CountedEvidence;
  let settlement_lineage: CountedEvidence;

  if (input.queueRows.length === 0) {
    // Nothing was queued for this anchor: downstream absence is exhaustively
    // proven zero by the exact plan_run_id filter.
    downstream_execution_lineage = {
      value: 0,
      unit: "order_event_rows",
      source_stage: "EXECUTION (executor_order_events via queue idempotency_key)",
      input_denominator: 0,
      output_denominator: 0,
      lineage_key: "executor_order_events.idempotency_key ∈ {} (no queue rows)",
      status: "ABSENT",
      by_status: {},
    };
    settlement_lineage = {
      value: 0,
      unit: "settlement_rows",
      source_stage: "SETTLEMENT (executor_order_events.executor_meta.reconciliation_v1)",
      input_denominator: 0,
      output_denominator: 0,
      lineage_key: "reconciliation_v1 ∈ {} (no order events)",
      status: "ABSENT",
      by_status: {},
    };
  } else if (input.orderEvents == null || !queueKeySetIsExhaustive) {
    unresolvedTransition = "QUEUE→ORDER_EVENT";
    downstream_execution_lineage = {
      value: null,
      unit: "order_event_rows",
      source_stage: "EXECUTION (executor_order_events via queue idempotency_key)",
      input_denominator: input.queueRows.length,
      output_denominator: null,
      lineage_key: "executor_order_events.idempotency_key (queue key set not exhaustive)",
      status: "UNKNOWN",
      by_status: null,
    };
    settlement_lineage = {
      value: null,
      unit: "settlement_rows",
      source_stage: "SETTLEMENT (executor_order_events.executor_meta.reconciliation_v1)",
      input_denominator: null,
      output_denominator: null,
      lineage_key: "reconciliation_v1 (downstream order lineage is UNKNOWN)",
      status: "UNKNOWN",
      by_status: null,
    };
  } else {
    const matched: PacketOrderEventRow[] = [];
    for (const ev of input.orderEvents) {
      if (ev.idempotency_key != null && selectedKeySet.has(ev.idempotency_key)) {
        matched.push(ev);
      } else {
        foreignRowsRejected += 1;
      }
    }
    downstream_execution_lineage = {
      value: matched.length,
      unit: "order_event_rows",
      source_stage: "EXECUTION (executor_order_events via queue idempotency_key)",
      input_denominator: selectedKeySet.size,
      output_denominator: matched.length,
      lineage_key: `executor_order_events.idempotency_key ∈ selected-plan queue keys (${selectedKeySet.size})`,
      status: "EXACT",
      by_status: tallyBy(matched, (ev) => String(ev.order_status ?? "UNKNOWN")),
    };

    const withReconciliation = matched.filter((ev) => hasReconciliationV1(ev.executor_meta));
    const settlementExhaustive = withReconciliation.length === matched.length;
    if (!settlementExhaustive) unresolvedTransition = "ORDER_EVENT→SETTLEMENT";
    settlement_lineage = {
      value: withReconciliation.length,
      unit: "settlement_rows",
      source_stage: "SETTLEMENT (executor_order_events.executor_meta.reconciliation_v1)",
      input_denominator: matched.length,
      output_denominator: withReconciliation.length,
      lineage_key: "executor_order_events.executor_meta.reconciliation_v1.clob_order_id",
      status: matched.length === 0 ? "ABSENT" : settlementExhaustive ? "EXACT" : "UNKNOWN",
      by_status:
        matched.length === 0
          ? {}
          : {
              ATTRIBUTED: withReconciliation.length,
              UNATTRIBUTED: matched.length - withReconciliation.length,
            },
    };
  }

  const packet: ExactAnchorEvidencePacket = {
    packet_version: "DETERMINISTIC_EXACT_ANCHOR_EVIDENCE_PACKET_V1",
    evidence_cutoff_iso: input.anchor.evidence_cutoff_iso,
    latest_expected_natural_anchor: selectedId,
    same_day_excluded_anchors: input.anchor.same_day_excluded.map((p) => p.plan_run_id),
    plan_run_id: selectedId,
    reservation_lineage,
    queue_lineage,
    downstream_execution_lineage,
    settlement_lineage,
    unresolved_transition: unresolvedTransition,
    lineage_keys: {
      reservation: "night_event_reservations.plan_run_id",
      queue: "event_execution_queue.plan_run_id",
      order_event: "executor_order_events.idempotency_key",
      settlement: "executor_order_events.executor_meta.reconciliation_v1.clob_order_id",
    },
    isolation_proof: {
      reservation_plan_run_ids: reservationPlanRunIds,
      queue_plan_run_ids: queuePlanRunIds,
      order_event_idempotency_key_source: "SELECTED_PLAN_QUEUE_ROWS",
      foreign_rows_rejected: foreignRowsRejected,
    },
    read_only: true,
  };

  return deepFreeze(packet);
}
