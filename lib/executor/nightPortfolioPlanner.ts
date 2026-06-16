// lib/executor/nightPortfolioPlanner.ts
//
// Night Portfolio Planner v0 (read-only, pure).
//
// Turns a FireModel candidate universe into a bankroll-aware Night Portfolio
// Plan for the daily 18:00–07:00 Europe/Minsk trading window. The planner does
// NOT place orders, write to the DB, or weaken any live safety guard — every
// hard-reject already enforced upstream in buildFireModelCandidates is honoured
// here, and additional planning-only guards are applied on top.
//
// Core invariants (must never regress):
//   - UNKNOWN scope is never a live slot (already pre-rejected upstream).
//   - Weak match_family_key is never a live slot.
//   - Football/WC No-side is never a live slot (already pre-rejected upstream).
//   - TIER3 is paper-only, never a live slot.
//   - At most ONE planned live slot per match_family_key (one event = one bet).
//   - Tier2 is a reduced-stake fallback only, never a raw quantity filler.
//   - Max bets is a CAP (25), not a target; never force to 15.

import type { FireModelCandidate } from "./buildFireModelCandidates";

export const NIGHT_PLAN_VERSION = "night-portfolio-plan-v0";
export const PLAN_TIMEZONE = "Europe/Minsk";
// Europe/Minsk is a fixed UTC+3 offset (no DST since 2011).
const MINSK_UTC_OFFSET_HOURS = 3;
const WINDOW_START_HOUR_MINSK = 18; // 18:00 Minsk
const WINDOW_END_HOUR_MINSK = 7; // 07:00 Minsk next day

export const TARGET_MIN_BETS_DEFAULT = 15;
export const TARGET_MAX_BETS_DEFAULT = 25;
export const STARTING_BANKROLL_USD = 300;

// T-45m is the preferred final rebalance / entry point before an event.
export const REBALANCE_MINUTES_BEFORE_EVENT = 45;
const EARLIEST_ENTRY_MINUTES_BEFORE = 60; // open entry window at T-60m
const LATEST_ENTRY_MINUTES_BEFORE = 5; // last safe entry at T-5m

// Tier2 fallback hard stake ceilings (bankroll-safe; no Kelly, no stake increase).
const TIER2_ABS_CAP_WITH_TIER1 = 5;
const TIER2_ABS_CAP_NO_TIER1 = 3;

export type PlanStatus =
  | "HEALTHY_TIER1_SUPPLY"
  | "TIER2_FALLBACK_NEEDED"
  | "SAFE_SUPPLY_SHORTAGE"
  | "NO_LIVE_PLAN";

type PlanTier = "TIER1" | "TIER2" | "TIER3" | "REJECTED";

export interface CandidatePreview {
  signal_id: string;
  market_slug: string;
  side: string;
  selected_outcome: string | null;
  strategy: string;
  tier: PlanTier;
  score: number;
  coverage: number;
  smart_money: number | null;
  entry_price: number;
  max_entry_price: number;
  timing_bucket: string;
  hours_to_start: number;
  live_eligible: boolean;
  live_rejection_reason: string | null;
}

export interface PlannedSlot {
  match_family_key: string;
  event_slug: string | null;
  event_title: string;
  strategic_scope: string;
  sport: string;
  tier: PlanTier;
  planned_stake_usd: number;
  stake_reason: string;
  tier2_reduced_stake_applied: boolean;
  candidate_count_inside_event: number;
  selected_candidate_preview: CandidatePreview;
  backup_candidate_preview: CandidatePreview | null;
  earliest_entry_iso: string | null;
  preferred_entry_iso: string | null;
  latest_entry_iso: string | null;
  rebalance_at_iso: string | null;
  rebalanced: false;
  one_position_per_event: true;
  timing_bucket: string;
  volume_at_entry_usd: number | null;
  score: number;
  coverage: number;
  smart_money: number | null;
  expected_net_value_proxy: number | null;
  no_go_reasons: string[];
}

export interface NightPortfolioPlan {
  plan_version: typeof NIGHT_PLAN_VERSION;
  timezone: typeof PLAN_TIMEZONE;
  window_start_iso: string;
  window_end_iso: string;
  planned_at_iso: string;
  target_min_bets: number;
  target_max_bets: number;
  starting_bankroll_usd: number;
  tier1_event_slots: number;
  tier2_fallback_slots: number;
  paper_only_slots: number;
  unsafe_rejected_count: number;
  planned_live_slots: number;
  slot_shortage_count: number;
  plan_status: PlanStatus;
  second_alert_required: boolean;
  rebalance_policy: {
    rebalance_minutes_before_event: number;
    one_position_per_event: true;
  };
  planned_slots: PlannedSlot[];
  top_rejected_reasons: Record<string, number>;
  diagnostics: Record<string, unknown>;
}

// ── Autonomy / control semantics ──────────────────────────────────────────────
//
// PRODUCTION CONTROL MODEL (locked):
//   - Founder does NOT approve the night plan. The email is informational +
//     emergency-override only.
//   - Ireland betting service auto-starts at 18:00 Minsk and runs the window.
//   - Founder may manually STOP Ireland after reading the email; no reaction is
//     required for normal operation.
// Bad plan_status NEVER flips founder_action_required to true — instead it raises
// a risk alert level while preserving autonomy.

export const ACTIVE_WINDOW_START_LOCAL = "18:00 Europe/Minsk";
export const ACTIVE_WINDOW_END_LOCAL = "07:00 Europe/Minsk";
export const NIGHT_PLAN_EMAIL_TIME_LOCAL = "17:00 Europe/Minsk";
export const SHORTAGE_ALERT_TIME_LOCAL = "17:45 Europe/Minsk";
// 18:00 → 07:00 Minsk = 13 hours = 46800 seconds.
export const IRELAND_RECOMMENDED_RUNTIME_SECONDS = 46800;

export const IRELAND_RUNTIME_CONTRACT = {
  autostart_time_local: ACTIVE_WINDOW_START_LOCAL,
  stop_time_local: ACTIVE_WINDOW_END_LOCAL,
  recommended_runtime_seconds: IRELAND_RECOMMENDED_RUNTIME_SECONDS,
  candidate_endpoint: "/api/executor/candidates",
  night_plan_endpoint: "/api/executor/night-plan",
  max_orders_is_cap_not_target: true,
  one_position_per_event: true,
  consume_only_live_eligible_candidates: true,
  do_not_wait_for_email_approval: true,
  operator_override_only: true,
} as const;

export type RiskAlertLevel = "NONE" | "WARNING" | "CRITICAL";

export interface NightPlanControlSemantics {
  founder_action_required: false;
  founder_action_mode: "override_only";
  default_runtime_behavior: "IRELAND_AUTOSTARTS_AT_18_00_MINSK";
  manual_stop_allowed: true;
  email_is_approval_gate: false;
  ireland_autostart_expected: true;
  active_window_start_local: typeof ACTIVE_WINDOW_START_LOCAL;
  active_window_end_local: typeof ACTIVE_WINDOW_END_LOCAL;
  night_plan_email_time_local: typeof NIGHT_PLAN_EMAIL_TIME_LOCAL;
  shortage_alert_time_local: typeof SHORTAGE_ALERT_TIME_LOCAL;
  risk_alert_level: RiskAlertLevel;
  recommended_founder_override: string;
}

/**
 * Derive the (autonomy-preserving) control semantics for a plan. founder_action_required
 * is ALWAYS false — a degraded plan only raises risk_alert_level and recommends (not
 * requires) a manual STOP.
 */
export function nightPlanControlSemantics(plan: NightPortfolioPlan): NightPlanControlSemantics {
  let risk: RiskAlertLevel = "NONE";
  let override = "NONE_REQUIRED";
  if (plan.plan_status === "NO_LIVE_PLAN" || plan.plan_status === "SAFE_SUPPLY_SHORTAGE") {
    risk = "CRITICAL";
    override = "STOP_IRELAND_IF_UNCOMFORTABLE";
  } else if (plan.second_alert_required) {
    risk = "WARNING";
    override = "STOP_IRELAND_IF_UNCOMFORTABLE";
  }
  return {
    founder_action_required: false,
    founder_action_mode: "override_only",
    default_runtime_behavior: "IRELAND_AUTOSTARTS_AT_18_00_MINSK",
    manual_stop_allowed: true,
    email_is_approval_gate: false,
    ireland_autostart_expected: true,
    active_window_start_local: ACTIVE_WINDOW_START_LOCAL,
    active_window_end_local: ACTIVE_WINDOW_END_LOCAL,
    night_plan_email_time_local: NIGHT_PLAN_EMAIL_TIME_LOCAL,
    shortage_alert_time_local: SHORTAGE_ALERT_TIME_LOCAL,
    risk_alert_level: risk,
    recommended_founder_override: override,
  };
}

// ── Email rendering (pure; shared by cron route + manual script) ───────────────

export function nightPlanEmailSubject(plan: NightPortfolioPlan): string {
  if (plan.second_alert_required) {
    return "ALERT: Low Tier1 Supply — Night Plan Needs Review";
  }
  return `PolyProPicks Night Plan — 18:00–07:00 Minsk — ${plan.planned_live_slots} planned`;
}

export function nightPlanEmailText(plan: NightPortfolioPlan, planTimeLabel = "17:00"): string {
  const L: string[] = [];
  L.push(`PolyProPicks Night Portfolio Plan (${planTimeLabel} Minsk)`);
  L.push(`Window: ${plan.window_start_iso} → ${plan.window_end_iso} (Europe/Minsk)`);
  L.push(`Planned at: ${plan.planned_at_iso}`);
  L.push("");
  L.push("CONTROL MODEL: Ireland AUTO-STARTS at 18:00 Minsk. This email is informational +");
  L.push("emergency-override only — NO approval required. Manually STOP Ireland only if you");
  L.push("dislike the plan below.");
  L.push("");
  L.push(`Plan status: ${plan.plan_status}`);
  L.push(`Starting bankroll: $${plan.starting_bankroll_usd}`);
  L.push(`Target range: ${plan.target_min_bets}–${plan.target_max_bets} bets (CAP, not target)`);
  L.push(`Tier1 event slots: ${plan.tier1_event_slots}`);
  L.push(`Tier2 fallback slots: ${plan.tier2_fallback_slots}`);
  L.push(`Planned LIVE slots: ${plan.planned_live_slots}`);
  L.push(`Paper-only slots: ${plan.paper_only_slots}`);
  L.push(`Unsafe rejected: ${plan.unsafe_rejected_count}`);
  L.push(`Slot shortage vs target_min: ${plan.slot_shortage_count}`);
  L.push("");
  L.push("NOTE: one real event = max one live position.");
  L.push("");
  if (plan.second_alert_required) {
    L.push("⚠️ CRITICAL: safe supply low.");
    L.push("Second alert will be sent at 17:45 Minsk unless plan improves.");
    L.push("Recommended (not required) override: STOP_IRELAND_IF_UNCOMFORTABLE.");
    L.push("");
  }
  L.push("Top 10 planned events:");
  if (plan.planned_slots.length === 0) {
    L.push("  (none)");
  } else {
    plan.planned_slots.slice(0, 10).forEach((s, i) => {
      L.push(
        `  ${i + 1}. [${s.tier}] ${s.event_title} (${s.strategic_scope}) ` +
          `$${s.planned_stake_usd} | ${s.timing_bucket} | rebalance ${s.rebalance_at_iso ?? "N/A"} | ` +
          `${s.candidate_count_inside_event} mkt(s) in event`
      );
    });
  }
  L.push("");
  L.push("Top rejected reasons:");
  const rejected = Object.entries(plan.top_rejected_reasons).sort((a, b) => b[1] - a[1]);
  if (rejected.length === 0) L.push("  (none)");
  else rejected.slice(0, 10).forEach(([r, n]) => L.push(`  ${r}: ${n}`));
  L.push("");
  L.push(`Second alert required (17:45 Minsk): ${plan.second_alert_required ? "YES" : "no"}`);
  return L.join("\n");
}

export interface BuildNightPlanOptions {
  nowMs: number;
  targetMin?: number;
  targetMax?: number;
}

// ── Timing helpers ──────────────────────────────────────────────────────────

function minskParts(ms: number): { y: number; mo: number; d: number; h: number } {
  // Shift into Minsk local time, then read UTC parts of the shifted instant.
  const shifted = new Date(ms + MINSK_UTC_OFFSET_HOURS * 3_600_000);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
  };
}

function minskWallToUtcMs(y: number, mo: number, d: number, h: number): number {
  // Wall-clock Minsk time → UTC epoch ms (subtract the +3 offset).
  return Date.UTC(y, mo, d, h, 0, 0) - MINSK_UTC_OFFSET_HOURS * 3_600_000;
}

/**
 * Resolve the active 18:00→07:00 Minsk window for a given instant.
 * - hour < 07         → window started yesterday 18:00, ends today 07:00.
 * - 07 <= hour < 18   → upcoming window today 18:00 → tomorrow 07:00.
 * - hour >= 18        → window today 18:00 → tomorrow 07:00.
 */
export function resolveNightWindow(nowMs: number): { startMs: number; endMs: number } {
  const { y, mo, d, h } = minskParts(nowMs);
  if (h < WINDOW_END_HOUR_MINSK) {
    const start = minskWallToUtcMs(y, mo, d - 1, WINDOW_START_HOUR_MINSK);
    const end = minskWallToUtcMs(y, mo, d, WINDOW_END_HOUR_MINSK);
    return { startMs: start, endMs: end };
  }
  const start = minskWallToUtcMs(y, mo, d, WINDOW_START_HOUR_MINSK);
  const end = minskWallToUtcMs(y, mo, d + 1, WINDOW_END_HOUR_MINSK);
  return { startMs: start, endMs: end };
}

function toIso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// ── Candidate classification ──────────────────────────────────────────────────

function planTierOf(c: FireModelCandidate): PlanTier {
  if (c.strategy === "TIER1_CORE_STRICT_72_COV50") return "TIER1";
  if (c.strategy === "TIER2_SAFE_EXPAND_60_COV50") return "TIER2";
  if (c.strategy === "TIER3_MICRO_EXPAND_50_COV25") return "TIER3";
  return "REJECTED";
}

function isWeakKey(c: FireModelCandidate): boolean {
  return (
    c.match_family_key_is_weak ||
    c.match_family_key_source === "condition_id_weak" ||
    c.match_family_key.startsWith("WEAK_MARKET_LEVEL_KEY:")
  );
}

/**
 * Planning-only safety classification. Returns the reason a candidate is NOT a
 * live slot, or null if it is a live-plannable candidate (Tier1/Tier2).
 * UNKNOWN / football No-side / missing-start are already pre-rejected upstream,
 * but we re-check defensively so the planner is safe with any universe.
 */
function planNoGoReason(c: FireModelCandidate): string | null {
  if (c.strategic_scope === "UNKNOWN") return "UNKNOWN_SCOPE_NOT_LIVE";
  if (c.identity_quality === "WEAK" || c.identity_quality === "INVALID") return "WEAK_IDENTITY_NOT_LIVE";
  if (isWeakKey(c)) return "WEAK_MATCH_FAMILY_KEY_NOT_LIVE";
  const isSoccer = c.strategic_scope === "WC" || c.strategic_scope === "SOCCER";
  if (isSoccer && (c.side ?? "").toLowerCase() === "no") return "FOOTBALL_NO_SIDE_NOT_LIVE";
  if (!c.diagnostics?.game_start_iso) return "MISSING_GAME_START_NOT_LIVE";
  const tier = planTierOf(c);
  if (tier === "TIER3") return "TIER3_PAPER_ONLY";
  if (tier === "REJECTED") return "TIER_NOT_LIVE_GRADE";
  return null;
}

function previewOf(c: FireModelCandidate): CandidatePreview {
  return {
    signal_id: c.signal_id,
    market_slug: c.market_slug,
    side: c.side,
    selected_outcome: c.selected_outcome,
    strategy: c.strategy,
    tier: planTierOf(c),
    score: c.diagnostics.score,
    coverage: c.diagnostics.coverage,
    smart_money: c.diagnostics.smart_money,
    entry_price: c.diagnostics.entry_price,
    max_entry_price: c.max_entry_price,
    timing_bucket: c.timing_bucket,
    hours_to_start: c.diagnostics.hours_to_start_now,
    live_eligible: c.live_eligible,
    live_rejection_reason: c.live_rejection_reason,
  };
}

// Expected-net-value proxy: a light, label-only heuristic combining edge proxy
// (score) and conviction (coverage / smart money). NOT a real EV — used only
// for ranking ties and operator visibility. Returns null when score missing.
function expectedNetValueProxy(c: FireModelCandidate): number | null {
  const score = c.diagnostics.score;
  if (typeof score !== "number") return null;
  const cov = typeof c.diagnostics.coverage === "number" ? c.diagnostics.coverage : 0;
  const sm = typeof c.diagnostics.smart_money === "number" ? c.diagnostics.smart_money : 0;
  const proxy = (score / 100) * (0.6 + 0.25 * (cov / 100) + 0.15 * (sm / 100));
  return Math.round(proxy * 1000) / 1000;
}

const TIER_RANK: Record<PlanTier, number> = { TIER1: 1, TIER2: 2, TIER3: 3, REJECTED: 4 };
const KEY_SOURCE_RANK: Record<string, number> = { event_slug: 0, condition_id_weak: 1 };

/**
 * Quality comparator inside an event (and for cross-event ranking).
 * Lower is better. Order: live_eligible → tier → score → coverage →
 * smart_money → EV proxy → timing → match_family_key_source.
 */
export function compareCandidateQuality(a: FireModelCandidate, b: FireModelCandidate): number {
  // live_eligible true first
  if (a.live_eligible !== b.live_eligible) return a.live_eligible ? -1 : 1;
  // tier1 > tier2 > tier3
  const tierDiff = TIER_RANK[planTierOf(a)] - TIER_RANK[planTierOf(b)];
  if (tierDiff !== 0) return tierDiff;
  // higher score
  if (b.diagnostics.score !== a.diagnostics.score) return b.diagnostics.score - a.diagnostics.score;
  // higher coverage
  if (b.diagnostics.coverage !== a.diagnostics.coverage) return b.diagnostics.coverage - a.diagnostics.coverage;
  // stronger smart money (null treated as 0)
  const smA = a.diagnostics.smart_money ?? 0;
  const smB = b.diagnostics.smart_money ?? 0;
  if (smB !== smA) return smB - smA;
  // higher EV proxy
  const evA = expectedNetValueProxy(a) ?? 0;
  const evB = expectedNetValueProxy(b) ?? 0;
  if (evB !== evA) return evB - evA;
  // sooner valid timing (closer to entry, but still future)
  if (a.diagnostics.hours_to_start_now !== b.diagnostics.hours_to_start_now) {
    return a.diagnostics.hours_to_start_now - b.diagnostics.hours_to_start_now;
  }
  // stronger match family key source
  return (
    (KEY_SOURCE_RANK[a.match_family_key_source] ?? 9) -
    (KEY_SOURCE_RANK[b.match_family_key_source] ?? 9)
  );
}

/**
 * T-45 event rebalance selector. Given all candidate markets for a single
 * match_family_key and the current time, return the single best LIVE candidate
 * for execution plus the next-ranked backup. All non-selected markets are
 * reported as SAME_EVENT_LOWER_RANKED_MARKET_BLOCKED.
 *
 * If the top candidate's entry price has moved beyond its max_entry_price, the
 * next valid backup is promoted; if none is valid, the event is skipped.
 */
export function selectBestCandidateForEventAtRebalance(
  candidatesForEvent: FireModelCandidate[],
  // nowMs reserved for future price-staleness checks; window already validated upstream.
  _nowMs: number
): {
  selected: FireModelCandidate | null;
  backup: FireModelCandidate | null;
  blocked: Array<{ signal_id: string; market_slug: string; reason: string }>;
  skip_reason: string | null;
} {
  const ranked = [...candidatesForEvent].sort(compareCandidateQuality);
  const blocked: Array<{ signal_id: string; market_slug: string; reason: string }> = [];

  let selected: FireModelCandidate | null = null;
  let backup: FireModelCandidate | null = null;

  for (const c of ranked) {
    const priceOk = c.diagnostics.entry_price <= c.max_entry_price;
    if (!selected) {
      if (priceOk) {
        selected = c;
      } else {
        blocked.push({
          signal_id: c.signal_id,
          market_slug: c.market_slug,
          reason: "ENTRY_PRICE_ABOVE_MAX_AT_REBALANCE",
        });
      }
      continue;
    }
    if (!backup && priceOk) {
      backup = c;
    }
    blocked.push({
      signal_id: c.signal_id,
      market_slug: c.market_slug,
      reason: "SAME_EVENT_LOWER_RANKED_MARKET_BLOCKED",
    });
  }

  return {
    selected,
    backup,
    blocked,
    skip_reason: selected ? null : "NO_VALID_CANDIDATE_AT_REBALANCE",
  };
}

// ── Stake rules ───────────────────────────────────────────────────────────────

function tier2ReducedStake(
  candidateStake: number,
  comparableTier1Stake: number | null
): { stake: number; reason: string } {
  if (comparableTier1Stake !== null && comparableTier1Stake > 0) {
    const stake = Math.min(candidateStake, comparableTier1Stake * 0.5, TIER2_ABS_CAP_WITH_TIER1);
    return {
      stake: Math.round(stake * 100) / 100,
      reason: `TIER2_FALLBACK_REDUCED: min(stake=${candidateStake}, 50%*tier1=${comparableTier1Stake * 0.5}, cap=${TIER2_ABS_CAP_WITH_TIER1})`,
    };
  }
  const stake = Math.min(candidateStake, TIER2_ABS_CAP_NO_TIER1);
  return {
    stake: Math.round(stake * 100) / 100,
    reason: `TIER2_FALLBACK_REDUCED_NO_TIER1_REF: min(stake=${candidateStake}, cap=${TIER2_ABS_CAP_NO_TIER1})`,
  };
}

// ── Event grouping ──────────────────────────────────────────────────────────

interface EventGroup {
  key: string;
  candidates: FireModelCandidate[]; // live-plannable only (Tier1/Tier2), ranked best-first
  best: FireModelCandidate;
  backup: FireModelCandidate | null;
  bestTier: PlanTier; // TIER1 or TIER2
  hasTier1: boolean;
  hasTier2: boolean;
}

function buildSlotFromGroup(
  group: EventGroup,
  forcedTier: PlanTier | null,
  comparableTier1Stake: number | null,
  nowMs: number
): PlannedSlot {
  // forcedTier lets the supply algorithm plan a Tier2 fallback even when a
  // Tier1 candidate also exists in the group (Tier1 reserved elsewhere). When
  // null, use the group's natural best.
  let chosen = group.best;
  let backup = group.backup;
  let tier = group.bestTier;

  if (forcedTier === "TIER2") {
    const t2 = group.candidates.find((c) => planTierOf(c) === "TIER2");
    if (t2) {
      chosen = t2;
      tier = "TIER2";
      backup = group.candidates.find((c) => c !== t2) ?? null;
    }
  }

  let plannedStake: number;
  let stakeReason: string;
  let tier2ReducedApplied = false;

  if (tier === "TIER1") {
    plannedStake = chosen.stake_usd;
    stakeReason = `TIER1_MODEL_STAKE: ${chosen.stake_usd}`;
  } else {
    const r = tier2ReducedStake(chosen.stake_usd, comparableTier1Stake);
    plannedStake = r.stake;
    stakeReason = r.reason;
    tier2ReducedApplied = true;
  }

  const startMs = chosen.diagnostics.game_start_iso
    ? new Date(chosen.diagnostics.game_start_iso).getTime()
    : NaN;
  const validStart = Number.isFinite(startMs);
  const eventTitle =
    chosen.event_slug ?? chosen.market_slug ?? chosen.match_family_key;

  // No-go reasons: any non-selected, non-backup market inside this event.
  const noGo: string[] = [];
  for (const c of group.candidates) {
    if (c === chosen || c === backup) continue;
    noGo.push(`${c.market_slug}: SAME_EVENT_LOWER_RANKED_MARKET_BLOCKED`);
  }

  return {
    match_family_key: group.key,
    event_slug: chosen.event_slug,
    event_title: eventTitle,
    strategic_scope: chosen.strategic_scope,
    sport: chosen.inferred_sport,
    tier,
    planned_stake_usd: plannedStake,
    stake_reason: stakeReason,
    tier2_reduced_stake_applied: tier2ReducedApplied,
    candidate_count_inside_event: group.candidates.length,
    selected_candidate_preview: previewOf(chosen),
    backup_candidate_preview: backup ? previewOf(backup) : null,
    earliest_entry_iso: validStart
      ? toIso(startMs - EARLIEST_ENTRY_MINUTES_BEFORE * 60_000)
      : null,
    preferred_entry_iso: validStart
      ? toIso(startMs - REBALANCE_MINUTES_BEFORE_EVENT * 60_000)
      : null,
    latest_entry_iso: validStart
      ? toIso(startMs - LATEST_ENTRY_MINUTES_BEFORE * 60_000)
      : null,
    rebalance_at_iso: validStart
      ? toIso(startMs - REBALANCE_MINUTES_BEFORE_EVENT * 60_000)
      : null,
    rebalanced: false,
    one_position_per_event: true,
    timing_bucket: chosen.timing_bucket,
    volume_at_entry_usd: null, // volume not present in candidate shape (v0)
    score: chosen.diagnostics.score,
    coverage: chosen.diagnostics.coverage,
    smart_money: chosen.diagnostics.smart_money,
    expected_net_value_proxy: expectedNetValueProxy(chosen),
    no_go_reasons: noGo,
  };
}

// ── Main planner ──────────────────────────────────────────────────────────────

export function buildNightPortfolioPlan(
  universe: FireModelCandidate[],
  opts: BuildNightPlanOptions
): NightPortfolioPlan {
  const nowMs = opts.nowMs;
  const targetMin = opts.targetMin ?? TARGET_MIN_BETS_DEFAULT;
  const targetMax = opts.targetMax ?? TARGET_MAX_BETS_DEFAULT;
  const { startMs, endMs } = resolveNightWindow(nowMs);

  const topRejectedReasons: Record<string, number> = {};
  let unsafeRejected = 0;
  let paperOnly = 0;

  // Version-level window and mapped counts for diagnostics.
  const windowCountsByVersion: Record<string, number> = {};
  const mappedCountsByVersion: Record<string, number> = {};
  for (const c of universe) {
    const ver = c.diagnostics.version ?? "unknown";
    windowCountsByVersion[ver] = (windowCountsByVersion[ver] ?? 0) + 1;
  }

  const livePlannable: FireModelCandidate[] = [];

  for (const c of universe) {
    const reason = planNoGoReason(c);
    if (reason === null) {
      livePlannable.push(c);
      const ver = c.diagnostics.version ?? "unknown";
      mappedCountsByVersion[ver] = (mappedCountsByVersion[ver] ?? 0) + 1;
      continue;
    }
    topRejectedReasons[reason] = (topRejectedReasons[reason] ?? 0) + 1;
    if (reason === "TIER3_PAPER_ONLY") paperOnly += 1;
    else unsafeRejected += 1;
  }

  // Group live-plannable candidates by match_family_key (one event = one slot).
  const groupMap = new Map<string, FireModelCandidate[]>();
  for (const c of livePlannable) {
    const arr = groupMap.get(c.match_family_key) ?? [];
    arr.push(c);
    groupMap.set(c.match_family_key, arr);
  }

  const groups: EventGroup[] = [];
  for (const [key, arr] of groupMap.entries()) {
    const ranked = [...arr].sort(compareCandidateQuality);
    const best = ranked[0];
    const backup = ranked[1] ?? null;
    groups.push({
      key,
      candidates: ranked,
      best,
      backup,
      bestTier: planTierOf(best),
      hasTier1: ranked.some((c) => planTierOf(c) === "TIER1"),
      hasTier2: ranked.some((c) => planTierOf(c) === "TIER2"),
    });
  }

  // Rank events by their best candidate's quality.
  groups.sort((a, b) => compareCandidateQuality(a.best, b.best));

  const tier1Groups = groups.filter((g) => g.bestTier === "TIER1");
  const tier2OnlyGroups = groups.filter((g) => g.bestTier === "TIER2");
  // Tier1-event count = events whose best provisional candidate is Tier1.
  const tier1EventSlots = tier1Groups.length;

  // Comparable Tier1 stake = median of Tier1 group best stakes (for Tier2 reduction).
  const tier1Stakes = tier1Groups.map((g) => g.best.stake_usd).sort((a, b) => a - b);
  const comparableTier1Stake =
    tier1Stakes.length > 0 ? tier1Stakes[Math.floor(tier1Stakes.length / 2)] : null;

  const plannedSlots: PlannedSlot[] = [];
  let plan_status: PlanStatus;

  if (tier1EventSlots >= targetMin) {
    // HEALTHY: plan Tier1 only, capped at targetMax by quality.
    for (const g of tier1Groups.slice(0, targetMax)) {
      plannedSlots.push(buildSlotFromGroup(g, "TIER1", comparableTier1Stake, nowMs));
    }
    plan_status = "HEALTHY_TIER1_SUPPLY";
  } else if (tier1EventSlots >= 8) {
    // TIER2_FALLBACK_NEEDED: reserve all Tier1, top up with safe Tier2 to targetMin.
    for (const g of tier1Groups) {
      plannedSlots.push(buildSlotFromGroup(g, "TIER1", comparableTier1Stake, nowMs));
    }
    for (const g of tier2OnlyGroups) {
      if (plannedSlots.length >= targetMin) break;
      plannedSlots.push(buildSlotFromGroup(g, "TIER2", comparableTier1Stake, nowMs));
    }
    plan_status = "TIER2_FALLBACK_NEEDED";
  } else if (tier1EventSlots > 0 || tier2OnlyGroups.length > 0) {
    // SAFE_SUPPLY_SHORTAGE: reserve Tier1, add only high-quality Tier2; never force.
    for (const g of tier1Groups) {
      plannedSlots.push(buildSlotFromGroup(g, "TIER1", comparableTier1Stake, nowMs));
    }
    for (const g of tier2OnlyGroups) {
      if (plannedSlots.length >= targetMax) break;
      plannedSlots.push(buildSlotFromGroup(g, "TIER2", comparableTier1Stake, nowMs));
    }
    plan_status = "SAFE_SUPPLY_SHORTAGE";
  } else {
    plan_status = "NO_LIVE_PLAN";
  }

  // Enforce the hard cap (max bets is a ceiling, never a target).
  const plannedFinal = plannedSlots.slice(0, targetMax);
  const plannedLiveSlots = plannedFinal.length;
  const tier1PlannedSlots = plannedFinal.filter((s) => s.tier === "TIER1").length;
  const tier2FallbackSlots = plannedFinal.filter((s) => s.tier === "TIER2").length;
  const slotShortage = Math.max(0, targetMin - plannedLiveSlots);

  // Second alert: low Tier1 OR below target OR a shortage/empty status.
  const second_alert_required =
    tier1EventSlots < 8 ||
    plannedLiveSlots < targetMin ||
    plan_status === "SAFE_SUPPLY_SHORTAGE" ||
    plan_status === "NO_LIVE_PLAN";

  return {
    plan_version: NIGHT_PLAN_VERSION,
    timezone: PLAN_TIMEZONE,
    window_start_iso: new Date(startMs).toISOString(),
    window_end_iso: new Date(endMs).toISOString(),
    planned_at_iso: new Date(nowMs).toISOString(),
    target_min_bets: targetMin,
    target_max_bets: targetMax,
    starting_bankroll_usd: STARTING_BANKROLL_USD,
    tier1_event_slots: tier1EventSlots,
    tier2_fallback_slots: tier2FallbackSlots,
    paper_only_slots: paperOnly,
    unsafe_rejected_count: unsafeRejected,
    planned_live_slots: plannedLiveSlots,
    slot_shortage_count: slotShortage,
    plan_status,
    second_alert_required,
    rebalance_policy: {
      rebalance_minutes_before_event: REBALANCE_MINUTES_BEFORE_EVENT,
      one_position_per_event: true,
    },
    planned_slots: plannedFinal,
    top_rejected_reasons: topRejectedReasons,
    diagnostics: {
      universe_size: universe.length,
      live_plannable_count: livePlannable.length,
      event_groups: groups.length,
      tier1_groups: tier1Groups.length,
      tier2_only_groups: tier2OnlyGroups.length,
      tier1_planned_slots: tier1PlannedSlots,
      comparable_tier1_stake_usd: comparableTier1Stake,
      total_planned_stake_usd:
        Math.round(plannedFinal.reduce((s, p) => s + p.planned_stake_usd, 0) * 100) / 100,
      window_counts_by_formula_version: windowCountsByVersion,
      mapped_counts_by_formula_version: mappedCountsByVersion,
    },
  };
}
