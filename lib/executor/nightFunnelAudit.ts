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
  /** Proof the audit used one builder candidate set (must be exactly 1). */
  candidateInvocationCount: number;
}

export interface PlanningAttributionResult {
  stage: FunnelStage;
  /** One zero-width "P-reason <CODE>" stage per named rejection reason. */
  reasonStages: FunnelStage[];
  rejected_before_planning_by_reason: Record<string, number>;
  dropped_by_formula_version_and_reason: Record<string, Record<string, number>>;
  market_policy_rejected_by_reason: Record<string, number>;
  fullmatch_rejected_by_reason: Record<string, number>;
  malformed_provider_sport_count: number;
  unsupported_provider_sport_count: number;
  rejected_rows_by_raw_provider_sport_and_reason: Record<string, Record<string, number>>;
  missing_fullmatch_fixtures: RawPlanningDiagnostics["missing_fullmatch_fixtures"];
  returned_candidate_count: number;
  candidate_invocation_count: number;
}

/**
 * Stage 04b: source-admitted rows -> planning candidates. The builder
 * (buildFireModelCandidates, planningMode) evaluates exactly
 * `raw.total_db_rows` merged/deduped source-admitted rows; every one either
 * becomes a returned candidate or is dropped through the single
 * `rejectReason(reason)` call site, which fans that same per-row drop into
 * `rejected_before_planning_by_reason` (the authoritative total) plus
 * dimensional breakdowns of the identical count (formula-version,
 * raw-provider-sport, full-match subset). Those breakdowns are NOT additional
 * drops and must never be summed alongside the authoritative map.
 *
 * `input === dropped + output` always holds by construction (dropped is
 * derived), so it proves nothing on its own. The real check is that the named
 * reason totals reconcile exactly with `dropped` -- when they don't, this is
 * either an unattributed collapse or a contradiction, and the audit must fail
 * closed rather than report a number that cannot be explained.
 */
export function buildAttributablePlanningStage(
  input: PlanningAttributionInput,
): PlanningAttributionResult {
  const { raw, returnedCandidateCount, candidateInvocationCount } = input;
  const src = "buildFireModelCandidates(CONTRACT_A_PLANNING_V1)/RawPlanningDiagnostics";
  const stageName = "04b source-admitted rows -> planning candidates";

  const inputCount = raw?.total_db_rows ?? 0;
  const dropped = inputCount - returnedCandidateCount;

  if (dropped < 0) {
    throw new PlanningAttributionError(
      `stage "${stageName}": returned_candidate_count=${returnedCandidateCount} exceeds total_db_rows=${inputCount}`,
    );
  }

  const byReason = raw?.rejected_before_planning_by_reason ?? {};
  const namedSum = Object.values(byReason).reduce((a, b) => a + b, 0);

  if (namedSum !== dropped) {
    throw new PlanningAttributionError(
      `stage "${stageName}": named rejection reasons sum to ${namedSum} but dropped=${dropped} ` +
        `(input=${inputCount}, output=${returnedCandidateCount}); rejected_before_planning_by_reason does not reconcile`,
    );
  }

  if (candidateInvocationCount !== 1) {
    throw new PlanningAttributionError(
      `stage "${stageName}": candidate_invocation_count=${candidateInvocationCount}, expected exactly 1 ` +
        `(audit must use one builder candidate set, never a second database candidate load)`,
    );
  }

  const stage: FunnelStage = {
    stage: stageName,
    input: inputCount,
    dropped,
    output: returnedCandidateCount,
    reason: "REJECTED_BEFORE_PLANNING (see P-reason breakdown)",
    source: `${src}.{total_db_rows,rejected_before_planning_by_reason}`,
  };

  const reasonStages: FunnelStage[] = Object.keys(byReason)
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
    dropped_by_formula_version_and_reason: raw?.dropped_by_formula_version_and_reason ?? {},
    market_policy_rejected_by_reason: raw?.market_policy_rejected_by_reason ?? {},
    fullmatch_rejected_by_reason: raw?.fullmatch_rejected_by_reason ?? {},
    malformed_provider_sport_count: raw?.malformed_provider_sport_count ?? 0,
    unsupported_provider_sport_count: raw?.unsupported_provider_sport_count ?? 0,
    rejected_rows_by_raw_provider_sport_and_reason:
      raw?.rejected_rows_by_raw_provider_sport_and_reason ?? {},
    missing_fullmatch_fixtures: raw?.missing_fullmatch_fixtures ?? [],
    returned_candidate_count: returnedCandidateCount,
    candidate_invocation_count: candidateInvocationCount,
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
  /** Proof the audit used one builder candidate set (must be exactly 1). */
  candidateInvocationCount: number;
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
      candidateInvocationCount: input.candidateInvocationCount,
    });
    stages.push(attribution.stage);
    stages.push(...attribution.reasonStages);
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
  dropped_by_formula_version_and_reason: Record<string, Record<string, number>>;
  market_policy_rejected_by_reason: Record<string, number>;
  fullmatch_rejected_by_reason: Record<string, number>;
  malformed_provider_sport_count: number;
  unsupported_provider_sport_count: number;
  rejected_rows_by_raw_provider_sport_and_reason: Record<string, Record<string, number>>;
  missing_fullmatch_fixtures: RawPlanningDiagnostics["missing_fullmatch_fixtures"];
  returned_candidate_count: number;
  candidate_invocation_count: number;
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
  /** Proof the audit used one builder candidate set (must be exactly 1). */
  candidateInvocationCount: number;
}): NightFunnelAuditResult {
  const planning_funnel = buildPlanningFunnel({
    raw: input.raw,
    plan: input.plan,
    reservedCount: input.reservedCount,
    skippedCount: input.skippedCount,
    returnedCandidateCount: input.returnedCandidateCount,
    candidateInvocationCount: input.candidateInvocationCount,
  });
  const contract_a_at_plan_time = buildContractAFunnel(input.contractAAtPlanTime, "AT_PLAN_TIME");
  const contract_a_forecast = buildContractAFunnel(input.contractAForecast, "CURRENT_SOURCE_FORECAST");

  // Self-assert every section; throws loudly on any imbalance.
  assertStageArithmetic(planning_funnel);
  assertStageArithmetic(contract_a_at_plan_time);
  assertStageArithmetic(contract_a_forecast);

  // Re-derive the same attribution evidence surfaced in stage 04b for the
  // flat JSON summary. Pure/deterministic: if buildPlanningFunnel above did
  // not throw, this cannot throw either.
  const attribution = buildAttributablePlanningStage({
    raw: input.raw,
    returnedCandidateCount: input.returnedCandidateCount,
    candidateInvocationCount: input.candidateInvocationCount,
  });

  return {
    plan_id: input.planId,
    planning_funnel,
    contract_a_at_plan_time,
    contract_a_forecast,
    queue: input.queueCounts,
    arithmetic_ok: true,
    rejected_before_planning_by_reason: attribution.rejected_before_planning_by_reason,
    dropped_by_formula_version_and_reason: attribution.dropped_by_formula_version_and_reason,
    market_policy_rejected_by_reason: attribution.market_policy_rejected_by_reason,
    fullmatch_rejected_by_reason: attribution.fullmatch_rejected_by_reason,
    malformed_provider_sport_count: attribution.malformed_provider_sport_count,
    unsupported_provider_sport_count: attribution.unsupported_provider_sport_count,
    rejected_rows_by_raw_provider_sport_and_reason:
      attribution.rejected_rows_by_raw_provider_sport_and_reason,
    missing_fullmatch_fixtures: attribution.missing_fullmatch_fixtures,
    returned_candidate_count: attribution.returned_candidate_count,
    candidate_invocation_count: attribution.candidate_invocation_count,
  };
}
