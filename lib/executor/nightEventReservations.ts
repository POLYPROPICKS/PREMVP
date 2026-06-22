// lib/executor/nightEventReservations.ts
//
// Contur3 EVENT-FIRST night reservation planner.
//
// Around 17:00 Minsk this builds the frozen Night Portfolio Plan: it selects
// EVENTS/MATCHES (never individual markets) within the canonical 17:00→08:00
// operational window / ~18h horizon, and persists one row per event into
// night_event_reservations under a deterministic plan_run_id.
//
// It does NOT write the execution queue — per-event market selection happens later
// in eventExecutionQueue.ts at T-60/T-30 rebalance.
//
// Read input only via buildFireModelCandidates (raw universe). No 6h hardcoded
// eligibility: horizon is governed by nightWindow.ts.

import { buildFireModelCandidates, type FireModelCandidate } from "./buildFireModelCandidates";
import { compareCandidateQuality } from "./nightPortfolioPlanner";
import {
  resolveNightWindow,
  buildPlanRunId,
  isWithinHorizon,
  type NightWindow,
} from "./nightWindow";
import type { NightEventReservationRow } from "./executorQueueTypes";

const PLAN_POOL = 200;

function eventTierOf(c: FireModelCandidate): "TIER1" | "TIER2" | "TIER3" | "REJECTED" {
  if (c.strategy === "TIER1_CORE_STRICT_72_COV50") return "TIER1";
  if (c.strategy === "TIER2_SAFE_EXPAND_60_COV50") return "TIER2";
  if (c.strategy === "TIER3_MICRO_EXPAND_50_COV25") return "TIER3";
  return "REJECTED";
}

function isWeakEventKey(c: FireModelCandidate): boolean {
  return (
    c.match_family_key_is_weak ||
    c.match_family_key_source === "condition_id_weak" ||
    c.match_family_key.startsWith("WEAK_MARKET_LEVEL_KEY:") ||
    c.match_family_key.startsWith("WEAK_SINGLE_TEAM_SPREAD:") ||
    c.match_family_key.startsWith("WEAK_SINGLE_TEAM_MATCH_WINNER:")
  );
}

export interface ReservationPlan {
  plan_run_id: string;
  plan_date_minsk: string;
  window: NightWindow;
  reservations: NightEventReservationRow[];
  diagnostics: {
    universe_size: number;
    event_groups: number;
    reserved_count: number;
    by_sport: Record<string, number>;
    by_tier: Record<string, number>;
    skipped_outside_horizon: number;
    skipped_weak_key: number;
    skipped_non_tier1_event: number;
  };
}

/**
 * Build the frozen event reservation plan (PURE — no DB writes).
 * Reserves an event when its best candidate is a Tier1 event opportunity within horizon.
 * Market-level halftime/side filtering is deliberately deferred to rebalance.
 */
export async function buildReservationPlan(nowMs: number): Promise<ReservationPlan> {
  const window = resolveNightWindow(nowMs);
  const planRunId = buildPlanRunId(nowMs);
  const { candidates: universe } = await buildFireModelCandidates(PLAN_POOL, "all", true);

  const bySport: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let skippedOutsideHorizon = 0;
  let skippedWeakKey = 0;
  let skippedNonTier1 = 0;

  // Group by event-level match_family_key.
  const groups = new Map<string, FireModelCandidate[]>();
  for (const c of universe) {
    if (isWeakEventKey(c)) {
      skippedWeakKey += 1;
      continue;
    }
    const arr = groups.get(c.match_family_key) ?? [];
    arr.push(c);
    groups.set(c.match_family_key, arr);
  }

  const reservations: NightEventReservationRow[] = [];
  const rankable: Array<{ best: FireModelCandidate; group: FireModelCandidate[] }> = [];

  for (const [, arr] of groups.entries()) {
    const ranked = [...arr].sort(compareCandidateQuality);
    const best = ranked[0];
    const startMs = best.diagnostics.game_start_iso
      ? new Date(best.diagnostics.game_start_iso).getTime()
      : NaN;
    if (!Number.isFinite(startMs) || !isWithinHorizon(startMs, window, nowMs)) {
      skippedOutsideHorizon += 1;
      continue;
    }
    // Event-level eligibility: best candidate must be a Tier1 event opportunity.
    if (eventTierOf(best) !== "TIER1") {
      skippedNonTier1 += 1;
      continue;
    }
    rankable.push({ best, group: ranked });
  }

  // Cross-event ranking by best-candidate quality.
  rankable.sort((a, b) => compareCandidateQuality(a.best, b.best));

  rankable.forEach(({ best, group }, idx) => {
    const tier = eventTierOf(best);
    bySport[best.inferred_sport] = (bySport[best.inferred_sport] ?? 0) + 1;
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    reservations.push({
      plan_run_id: planRunId,
      plan_date_minsk: window.planDateMinsk,
      window_start_iso: window.startIso,
      window_end_iso: window.endIso,
      match_family_key: best.match_family_key,
      event_slug: best.event_slug,
      event_title: best.event_slug ?? best.market_slug ?? best.match_family_key,
      sport: best.inferred_sport,
      league: null,
      strategic_scope: best.strategic_scope,
      game_start_iso: best.diagnostics.game_start_iso,
      event_tier: tier,
      event_score: best.diagnostics.score,
      best_snapshot_id: best.signal_id,
      reservation_rank: idx + 1,
      status: "RESERVED",
      selection_reason: `EVENT_FIRST_TIER1_OPPORTUNITY: score=${best.diagnostics.score} cov=${best.diagnostics.coverage} markets_in_event=${group.length}`,
      diagnostics: {
        markets_in_event: group.length,
        scope_confidence: best.sport_classification_confidence,
        timing_bucket: best.timing_bucket,
        hours_to_start: best.diagnostics.hours_to_start_now,
      },
    });
  });

  return {
    plan_run_id: planRunId,
    plan_date_minsk: window.planDateMinsk,
    window,
    reservations,
    diagnostics: {
      universe_size: universe.length,
      event_groups: groups.size,
      reserved_count: reservations.length,
      by_sport: bySport,
      by_tier: byTier,
      skipped_outside_horizon: skippedOutsideHorizon,
      skipped_weak_key: skippedWeakKey,
      skipped_non_tier1_event: skippedNonTier1,
    },
  };
}

export interface PersistReservationsResult {
  plan_run_id: string;
  already_exists: boolean;
  written_count: number;
  reserved_count: number;
  reservations: NightEventReservationRow[];
  diagnostics: ReservationPlan["diagnostics"];
}

/**
 * Persist a reservation plan idempotently. If the plan_run_id already has rows and
 * force is false, the existing frozen plan is returned untouched.
 */
export async function persistReservationPlan(
  plan: ReservationPlan,
  opts: { force?: boolean } = {}
): Promise<PersistReservationsResult> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");

  const { data: existing, error: readErr } = await supabaseAdmin
    .from("night_event_reservations")
    .select("id, match_family_key")
    .eq("plan_run_id", plan.plan_run_id);
  if (readErr) throw new Error(`reservation read failed: ${readErr.message}`);

  if ((existing?.length ?? 0) > 0 && !opts.force) {
    return {
      plan_run_id: plan.plan_run_id,
      already_exists: true,
      written_count: 0,
      reserved_count: existing!.length,
      reservations: plan.reservations,
      diagnostics: plan.diagnostics,
    };
  }

  if ((existing?.length ?? 0) > 0 && opts.force) {
    const { error: delErr } = await supabaseAdmin
      .from("night_event_reservations")
      .delete()
      .eq("plan_run_id", plan.plan_run_id);
    if (delErr) throw new Error(`reservation force-delete failed: ${delErr.message}`);
  }

  if (plan.reservations.length === 0) {
    return {
      plan_run_id: plan.plan_run_id,
      already_exists: false,
      written_count: 0,
      reserved_count: 0,
      reservations: [],
      diagnostics: plan.diagnostics,
    };
  }

  const { error: insErr } = await supabaseAdmin
    .from("night_event_reservations")
    .insert(plan.reservations);
  if (insErr) throw new Error(`reservation insert failed: ${insErr.message}`);

  return {
    plan_run_id: plan.plan_run_id,
    already_exists: false,
    written_count: plan.reservations.length,
    reserved_count: plan.reservations.length,
    reservations: plan.reservations,
    diagnostics: plan.diagnostics,
  };
}

/** Read frozen reservations for a plan_run_id, rank-ordered. */
export async function loadReservations(planRunId: string): Promise<NightEventReservationRow[]> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("night_event_reservations")
    .select("*")
    .eq("plan_run_id", planRunId)
    .order("reservation_rank", { ascending: true });
  if (error) throw new Error(`reservation load failed: ${error.message}`);
  return (data ?? []) as NightEventReservationRow[];
}
