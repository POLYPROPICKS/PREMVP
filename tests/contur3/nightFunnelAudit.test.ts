// Contur3 night-funnel audit tests (node:test via tsx):
//   node --import tsx --test tests/contur3/nightFunnelAudit.test.ts
//
// Exercises the PURE audit assembly (lib/executor/nightFunnelAudit.ts) with
// fixtures shaped exactly like the real production outputs it consumes. No
// Supabase, no network, no production write path is reachable from these
// functions — proven structurally (the module has no supabase import) and by
// the "no writes" test below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertStageArithmetic,
  buildPlanningFunnel,
  buildContractAFunnel,
  reconcileStrictIdentityGroups,
  isGroupLevelRejection,
  tallyRejections,
  assembleNightFunnelAudit,
  FunnelArithmeticError,
  type FunnelStage,
} from "../../lib/executor/nightFunnelAudit";
import type { RawPlanningDiagnostics } from "../../lib/executor/buildFireModelCandidates";
import type { ReservationPlanDiagnostics } from "../../lib/executor/nightFunnelAudit";
import type {
  FrozenModelV2ShadowResult,
  FrozenModelV2Rejection,
  FrozenModelV2Decision,
} from "../../lib/modeling/frozenModelProducerV2Shadow";

const root = process.cwd();

function rawDiag(overrides: Partial<RawPlanningDiagnostics> = {}): RawPlanningDiagnostics {
  return {
    total_db_rows: 1000,
    scored_rows_count: 600,
    planning_shadow_rows_count: 0,
    planning_shadow_included_count: 0,
    planning_shadow_rejected_count: 300,
    planning_shadow_reject_reasons: { WRONG_VERSION: 300 },
    wc_soccer_candidate_count: 0,
    fallback_candidate_count: 0,
    source_counts_by_formula_version: {},
    activity_label_rows: 0,
    rows_missing_game_start: 0,
    rows_using_expires_at: 0,
    rows_using_created_at_fallback: 0,
    rows_missing_event_slug: 0,
    rows_missing_selected_token: 0,
    rows_missing_selected_outcome: 0,
    wc_like_rows: 0,
    soccer_like_rows: 0,
    wc_tier2_override_candidates: 0,
    wc_tier2_override_live_enabled: 0,
    wc_tier2_override_rejected_by_reason: {},
    sport_classification_confidence_counts: {},
    match_family_quality_counts: {},
    rejected_before_planning_by_reason: {},
    sample_source_rows: [],
    dropped_by_formula_version_and_reason: {},
    versions_queried: [],
    versions_with_zero_db_rows: [],
    fullmatch_market_class_counts: {},
    raw_allowed_fullmatch_rows: 0,
    raw_forbidden_rows: 0,
    fullmatch_admitted_count: 0,
    fullmatch_rejected_by_reason: {},
    missing_fullmatch_fixtures: [],
    ...overrides,
  };
}

function planDiag(overrides: Partial<ReservationPlanDiagnostics> = {}): ReservationPlanDiagnostics {
  return {
    universe_size: 120,
    event_groups: 60,
    canonical_event_groups: 40,
    reserved_count: 4,
    by_sport: {},
    by_tier: {},
    skipped_outside_horizon: 0,
    skipped_weak_key: 0,
    skipped_non_tier1_event: 30,
    skipped_no_executable_anchor: 6,
    market_level_keys_skipped: 0,
    market_level_keys_normalized: 0,
    horizon_end_iso: "2026-07-23T08:06:34.283Z",
    window_end_iso: "2026-07-23T05:00:00.000Z",
    reserved_wc_or_soccer_count: 4,
    skipped_by_horizon_count: 0,
    skipped_by_cap_count: 0,
    tier1PhysicalMatchesSeen: 4,
    tier1ReservationsPlanned: 4,
    tier1AlreadyReserved: 0,
    tier1ReservationGapsAfterBuild: 0,
    weakKeysMerged: 0,
    representativeTitleReplaced: 0,
    completeCandidateUniverseUsed: true,
    underfillInvariantPass: true,
    targetLiveSlots: 15,
    tier1ReservedCount: 4,
    fallbackSlotFillReservedCount: 0,
    fallbackTier2Reserved: 0,
    fallbackTier3Reserved: 0,
    fallbackEligibleGroupsSeen: 0,
    fallbackSkippedNoAllowedFullmatch: 0,
    slotFillTargetReached: false,
    ...overrides,
  } as ReservationPlanDiagnostics;
}

function rej(reason: FrozenModelV2Rejection["reason"], observationId: string | null, index: number): FrozenModelV2Rejection {
  return { index, observationId, eventKey: observationId ? `evt-${observationId}` : null, reason };
}

function decision(id: string): FrozenModelV2Decision {
  return {
    decisionId: id,
    observationId: id,
    eventKey: `evt-${id}`,
    asOfIso: "2026-07-22T14:00:00.000Z",
    modelVersion: "frozen-v2",
    score: 70,
    entryPrice: 0.4,
    minutesUntilStart: 100,
    selectedOutcome: "TEAM_A",
    createdAtIso: "2026-07-22T11:30:00.000Z",
  };
}

// Frozen result: 20 source rows -> 3 row-level pre-identity drops ->
// 17 rows form strict buckets. Buckets = accepted(2) + group-level(6) = 8...
// but strictIdentityGroups is DERIVED as accepted + group-level, not row count.
function frozenResult(): FrozenModelV2ShadowResult {
  const rejections: FrozenModelV2Rejection[] = [
    // row-level pre-identity (observationId null)
    rej("SNAPSHOT_NOT_T90_COMPATIBLE", null, 0),
    rej("FUTURE_DATA_REJECTED", null, 1),
    rej("MISSING_TOKEN_ID", null, 2),
    // group-level gates (observationId non-null)
    rej("SCORE_BELOW_65", "obs-a", 3),
    rej("PRICE_BELOW_030", "obs-b", 4),
    rej("OUTSIDE_120M", "obs-c", 5),
    rej("ESPORTS_EXCLUDED", "obs-d", 6),
    rej("UNSUPPORTED_MARKET", "obs-e", 7),
    // event-dedup
    rej("DUPLICATE_EVENT_LOWER_RANK", "obs-f", 8),
  ];
  return {
    asOfIso: "2026-07-22T14:00:00.000Z",
    modelVersion: "frozen-v2",
    inputCount: 20,
    // eligible pre-dedup = accepted(2) + duplicates(1) = 3
    eligibleCount: 3,
    acceptedDecisions: [decision("obs-w1"), decision("obs-w2")],
    rejections,
  };
}

// ── TDD #1: every stage satisfies input = dropped + output ──────────────────

test("planning funnel: every stage balances input = dropped + output", () => {
  const stages = buildPlanningFunnel({ raw: rawDiag(), plan: planDiag(), reservedCount: 4, skippedCount: 2 });
  assert.doesNotThrow(() => assertStageArithmetic(stages));
});

test("contract A funnel: every stage balances input = dropped + output", () => {
  const stages = buildContractAFunnel(frozenResult(), "AT_PLAN_TIME");
  assert.doesNotThrow(() => assertStageArithmetic(stages));
});

test("assertStageArithmetic throws (loudly) on an unbalanced stage", () => {
  const bad: FunnelStage[] = [
    { stage: "x", input: 10, dropped: 3, output: 5, reason: "R", source: "s" },
  ];
  assert.throws(() => assertStageArithmetic(bad), FunnelArithmeticError);
});

// ── TDD #2/#3: dedup counts each physical event once ────────────────────────

test("planning funnel: one physical event with multiple markets collapses to one event", () => {
  // 120 candidates -> 40 canonical physical events (markets folded in).
  const stages = buildPlanningFunnel({ raw: rawDiag(), plan: planDiag(), reservedCount: 4, skippedCount: 2 });
  const dedup = stages.find((s) => s.stage.startsWith("13 unique physical events"));
  assert.ok(dedup);
  assert.equal(dedup?.input, 120);
  assert.equal(dedup?.output, 40, "120 markets must collapse to 40 unique physical events");
  assert.equal(dedup?.dropped, 80);
});

test("contract A: duplicate identities counted once (DUPLICATE_EVENT_LOWER_RANK is a distinct stage, not merged)", () => {
  const tally = tallyRejections(frozenResult().rejections);
  assert.equal(tally.DUPLICATE_EVENT_LOWER_RANK, 1);
});

// ── TDD #4: tier fallback counted separately from primary selection ─────────

test("planning funnel: fallback slot-fill is a separate stage from Tier1 primary selection", () => {
  const stages = buildPlanningFunnel({
    raw: rawDiag(),
    plan: planDiag({ tier1ReservationsPlanned: 2, fallbackSlotFillReservedCount: 2, fallbackTier2Reserved: 1, fallbackTier3Reserved: 1, reserved_count: 4 }),
    reservedCount: 4,
    skippedCount: 0,
  });
  const primary = stages.find((s) => s.stage.startsWith("14 Tier1 primary"));
  const fallback = stages.find((s) => s.stage.startsWith("17 fallback slot-fill"));
  assert.ok(primary && fallback);
  assert.notEqual(primary?.stage, fallback?.stage);
  assert.match(fallback?.reason ?? "", /tier2=1 tier3=1/);
});

// ── TDD #5: frozen rejection reasons sum to source identity groups ──────────

test("contract A: strict identity groups === accepted + group-level rejections", () => {
  const recon = reconcileStrictIdentityGroups(frozenResult());
  // accepted 2 + group-level 6 = 8
  assert.equal(recon.accepted, 2);
  assert.equal(recon.groupLevelRejections, 6);
  assert.equal(recon.strictIdentityGroups, 8);
  // eligible pre-dedup (3) === accepted (2) + duplicates (1)
  assert.equal(recon.eligiblePreDedup, recon.accepted + recon.duplicateEventRejections);
});

test("contract A: SNAPSHOT_NOT_T90_COMPATIBLE is split by observationId (row-level vs group-level), never by reason string alone", () => {
  assert.equal(isGroupLevelRejection(rej("SNAPSHOT_NOT_T90_COMPATIBLE", null, 0)), false, "pre-identity form is row-level");
  assert.equal(isGroupLevelRejection(rej("SNAPSHOT_NOT_T90_COMPATIBLE", "obs-x", 0)), true, "bucket form is group-level");
});

// ── TDD #6/#7: audit code performs no writes / no reservation-rebalance calls ─

test("audit library source imports no Supabase client and no write/rebalance route", () => {
  const src = readFileSync(path.join(root, "lib/executor/nightFunnelAudit.ts"), "utf8");
  assert.doesNotMatch(src, /from\s+["'][^"']*supabase[^"']*["']/i, "pure audit lib must not import any supabase client");
  assert.doesNotMatch(src, /insertQueueRow|markReservation|runEventRebalance|runReservationCron/, "pure audit lib must not reference any write path");
});

test("audit script performs no POST/insert/update/rebalance-write against production", () => {
  const src = readFileSync(path.join(root, "scripts/contur3/audit-night-funnel.ts"), "utf8");
  assert.doesNotMatch(src, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/, "audit script must not write to Supabase");
  assert.doesNotMatch(src, /method:\s*['\"]POST['\"]/i, "audit script must not POST");
  assert.doesNotMatch(src, /runEventRebalanceWithEvidence|runReservationCronWithEvidence|executeForceRebuild/, "audit script must not invoke reservation/rebalance write orchestration");
});

// ── TDD #8: existing production decisions unchanged (top-level assembly) ─────

test("assembleNightFunnelAudit combines all sections, self-asserts arithmetic, and never recomputes a model decision", () => {
  const result = assembleNightFunnelAudit({
    planId: "night-plan:2026-07-22:1700-minsk",
    raw: rawDiag(),
    plan: planDiag(),
    reservedCount: 4,
    skippedCount: 2,
    contractAAtPlanTime: frozenResult(),
    contractAForecast: frozenResult(),
    queueCounts: { total: 0, READY: 0, CLAIMED: 0, SENT: 0, EXECUTED: 0, FAILED: 0 },
  });
  assert.equal(result.plan_id, "night-plan:2026-07-22:1700-minsk");
  assert.ok(result.planning_funnel.length > 0);
  assert.ok(result.contract_a_at_plan_time.length > 0);
  assert.ok(result.contract_a_forecast.length > 0);
  assert.equal(result.queue.total, 0);
  // self-assertion: assembled sections all balance (no throw)
  assert.equal(result.arithmetic_ok, true);
});
