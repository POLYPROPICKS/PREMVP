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
  formatMinskUtc,
  REBALANCE_MINUTES_BEFORE_START,
  PREFERRED_ENTRY_MINUTES_BEFORE,
  LATEST_ENTRY_MINUTES_BEFORE,
  type NightWindow,
} from "./nightWindow";
import type { NightEventReservationRow } from "./executorQueueTypes";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const PLAN_POOL = 200;

// Market-level terms that may appear in event_slug / match_family_key from Polymarket.
// A key containing any of these is a prop/market line, not an event reservation key.
const MARKET_LEVEL_KEY_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|halftime[\s-]result|\bo\/u\b|over[\s/]under|total\s+corners|\bcorners\b|total\s+goals|\bspread\b|\bmoneyline\b|exact\s+score|player\s+prop|goalscorer/i;

const HALFTIME_MARKET_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;

// Anchor guards — applied at reservation selection to prevent forbidden live-market anchors.
// Only identity fields are inspected (market_slug, event_slug, match_family_key, diagnostics.marketTitle).
// Telemetry fields (price1hAgo, delta1hPp, etc.) are never checked here.
const CORNERS_ANCHOR_RE = /\bcorners?\b|total[\s_-]corners?|corners?[\s_-]total/i;

const PROP_ANCHOR_RE =
  /exact[\s_-]score|goalscorer|goal[\s_-]scorer|anytime[\s_-]scorer|first[\s_-]scorer|last[\s_-]scorer|\bplayer[\s_-]prop|\boutright\b/i;

function isHalftimeMarket(c: FireModelCandidate): boolean {
  return (
    HALFTIME_MARKET_RE.test(c.market_slug ?? "") ||
    HALFTIME_MARKET_RE.test(c.event_slug ?? "") ||
    HALFTIME_MARKET_RE.test(c.match_family_key ?? "")
  );
}

function isCornersAnchorMarket(c: FireModelCandidate): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagTitle: string = (c as any).diagnostics?.marketTitle ?? "";
  return (
    CORNERS_ANCHOR_RE.test(c.market_slug ?? "") ||
    CORNERS_ANCHOR_RE.test(c.event_slug ?? "") ||
    CORNERS_ANCHOR_RE.test(c.match_family_key ?? "") ||
    CORNERS_ANCHOR_RE.test(diagTitle)
  );
}

function isPropAnchorMarket(c: FireModelCandidate): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagTitle: string = (c as any).diagnostics?.marketTitle ?? "";
  return (
    PROP_ANCHOR_RE.test(c.market_slug ?? "") ||
    PROP_ANCHOR_RE.test(c.event_slug ?? "") ||
    PROP_ANCHOR_RE.test(c.match_family_key ?? "") ||
    PROP_ANCHOR_RE.test(diagTitle)
  );
}

/**
 * True when the candidate is a forbidden live-market anchor.
 * Forbidden: halftime/1H, corners, exact score, goalscorer, props, outrights.
 * Allowed: full-match winner/moneyline, spread, full-match total goals.
 */
function isForbiddenAnchorMarket(c: FireModelCandidate): boolean {
  return isHalftimeMarket(c) || isCornersAnchorMarket(c) || isPropAnchorMarket(c);
}

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

/**
 * True when the candidate's key or slug is a market-level prop line, not an event identifier.
 * These must never become reservation keys — they are deferred to the rebalance market-selection.
 */
function isMarketLevelKey(c: FireModelCandidate): boolean {
  return (
    MARKET_LEVEL_KEY_RE.test(c.match_family_key) ||
    MARKET_LEVEL_KEY_RE.test(c.event_slug ?? "") ||
    MARKET_LEVEL_KEY_RE.test(c.market_slug ?? "")
  );
}

/**
 * Derive a clean human-readable event title from the canonical reservation key.
 * For pair:* keys, builds "<team a> vs <team b>" from the slug.
 * Falls back to stripping market-level suffixes from the candidate's own slug.
 */
const MARKET_LEVEL_SUFFIX_RE =
  /\s*[-:]\s*(halftime\s+result|half[\s-]time\s+result|first[\s-]half|1st[\s-]half|o\/u[\s\d.]*|over\/under[\s\d.]*|total\s+corners|total\s+goals|\bspread\b|\bmoneyline\b|exact\s+score|goalscorer)\s*$/i;

function cleanReservationEventTitle(candidate: FireModelCandidate, canonicalKey: string): string {
  // Derive title from pair:<team-a>-vs-<team-b>:<date>
  const pairMatch = canonicalKey.match(/^pair:(.+):\d{4}-\d{2}-\d{2}$/);
  if (pairMatch) {
    const teamsPart = pairMatch[1];
    const vsIdx = teamsPart.indexOf("-vs-");
    if (vsIdx !== -1) {
      const teamA = teamsPart.slice(0, vsIdx).replace(/-/g, " ");
      const teamB = teamsPart.slice(vsIdx + 4).replace(/-/g, " ");
      return `${teamA} vs ${teamB}`;
    }
  }
  // Fallback: strip market-level suffixes from candidate slug
  const raw = candidate.event_slug ?? candidate.market_slug ?? canonicalKey;
  return raw.replace(MARKET_LEVEL_SUFFIX_RE, "").trim();
}

/**
 * Attempt to derive a canonical event group key for a market-level candidate.
 * Returns the canonical_event_key if it is clean (pair:* or fifwc-* prefix, no market-level text).
 * Returns null when no safe canonical key can be derived — caller should skip.
 */
function normalizedEventKey(c: FireModelCandidate): string | null {
  const ck = c.canonical_event_key;
  if (!ck) return null;
  if (MARKET_LEVEL_KEY_RE.test(ck)) return null;
  // Accept pair:* or fifwc-* as canonical
  if (ck.startsWith("pair:") || ck.startsWith("fifwc-")) return ck;
  return null;
}

export interface ReservationPlan {
  plan_run_id: string;
  plan_date_minsk: string;
  window: NightWindow;
  reservations: NightEventReservationRow[];
  diagnostics: {
    universe_size: number;
    event_groups: number;
    canonical_event_groups: number;
    reserved_count: number;
    by_sport: Record<string, number>;
    by_tier: Record<string, number>;
    skipped_outside_horizon: number;
    skipped_weak_key: number;
    skipped_non_tier1_event: number;
    skipped_no_executable_anchor: number;
    market_level_keys_skipped: number;
    market_level_keys_normalized: number;
    // Horizon/WC floor diagnostics exposed after build.
    horizon_end_iso: string;
    window_end_iso: string;
    reserved_wc_or_soccer_count: number;
    skipped_by_horizon_count: number;
    skipped_by_cap_count: number;
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
  let skippedNoExecutableAnchor = 0;
  let marketLevelKeysSkipped = 0;
  let marketLevelKeysNormalized = 0;

  // Group by canonical event-level key.
  // Market-level candidates (halftime, o/u, corners, etc.) are either normalized into
  // their parent event group (if canonical_event_key is a clean pair:* key) or skipped.
  const groups = new Map<string, FireModelCandidate[]>();
  for (const c of universe) {
    if (isWeakEventKey(c)) {
      skippedWeakKey += 1;
      continue;
    }
    if (isMarketLevelKey(c)) {
      const ck = normalizedEventKey(c);
      if (ck) {
        // Normalize into the canonical event group (counted but still grouped).
        marketLevelKeysNormalized += 1;
        const arr = groups.get(ck) ?? [];
        arr.push(c);
        groups.set(ck, arr);
      } else {
        marketLevelKeysSkipped += 1;
      }
      continue;
    }
    const arr = groups.get(c.match_family_key) ?? [];
    arr.push(c);
    groups.set(c.match_family_key, arr);
  }

  const reservations: NightEventReservationRow[] = [];
  const rankable: Array<{ best: FireModelCandidate; group: FireModelCandidate[]; groupKey: string }> = [];

  for (const [groupKey, arr] of groups.entries()) {
    const ranked = [...arr].sort(compareCandidateQuality);
    // Filter to executable anchors only: halftime/corners/props/exact-score/goalscorer
    // are forbidden as reservation anchors. NEVER fall back to a forbidden market.
    const executableAnchorRanked = ranked.filter((c) => !isForbiddenAnchorMarket(c));
    if (executableAnchorRanked.length === 0) {
      skippedNoExecutableAnchor += 1;
      continue;
    }
    const best = executableAnchorRanked[0];
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
    rankable.push({ best, group: ranked, groupKey });
  }

  // Cross-event ranking by best-candidate quality.
  rankable.sort((a, b) => compareCandidateQuality(a.best, b.best));

  rankable.forEach(({ best, group, groupKey }, idx) => {
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
      event_title: cleanReservationEventTitle(best, groupKey),
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
        battle_trace_id: `contur3:${planRunId}:${best.match_family_key}:unknown:unknown`,
      },
    });
  });

  const reservedWcOrSoccerBuild = reservations.filter(
    (r) => r.strategic_scope === "WC" || r.strategic_scope === "SOCCER"
  ).length;

  return {
    plan_run_id: planRunId,
    plan_date_minsk: window.planDateMinsk,
    window,
    reservations,
    diagnostics: {
      universe_size: universe.length,
      event_groups: groups.size,
      canonical_event_groups: groups.size,
      reserved_count: reservations.length,
      by_sport: bySport,
      by_tier: byTier,
      skipped_outside_horizon: skippedOutsideHorizon,
      skipped_weak_key: skippedWeakKey,
      skipped_non_tier1_event: skippedNonTier1,
      skipped_no_executable_anchor: skippedNoExecutableAnchor,
      market_level_keys_skipped: marketLevelKeysSkipped,
      market_level_keys_normalized: marketLevelKeysNormalized,
      horizon_end_iso: window.horizonEndIso,
      window_end_iso: window.endIso,
      reserved_wc_or_soccer_count: reservedWcOrSoccerBuild,
      skipped_by_horizon_count: skippedOutsideHorizon,
      skipped_by_cap_count: 0,
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
    .select("*")
    .eq("plan_run_id", plan.plan_run_id)
    .order("reservation_rank", { ascending: true });
  if (readErr) throw new Error(`reservation read failed: ${readErr.message}`);

  if ((existing?.length ?? 0) > 0 && !opts.force) {
    return {
      plan_run_id: plan.plan_run_id,
      already_exists: true,
      written_count: 0,
      reserved_count: existing!.length,
      reservations: existing as unknown as NightEventReservationRow[],
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

/**
 * Persist reservation plan diagnostics to filesystem under modeling/fire_runs/contur3-reservations/.
 * Failure does NOT fail the business cron; it logs a warning and continues.
 */
export async function persistReservationPlanDiagnostics(
  plan: ReservationPlan,
  opts?: { context?: string }
): Promise<{ path: string | null; error: string | null }> {
  try {
    const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runIdSafe = plan.plan_run_id.replace(/[^a-z0-9_-]/gi, "_");
    const filename = `${runIdSafe}_${timestamp}.json`;

    const dirPath = path.join(process.cwd(), "modeling", "fire_runs", "contur3-reservations");
    await mkdir(dirPath, { recursive: true });

    const filePath = path.join(dirPath, filename);
    const payload = {
      generated_at: new Date().toISOString(),
      plan_run_id: plan.plan_run_id,
      plan_date_minsk: plan.plan_date_minsk,
      commit,
      context: opts?.context || "persistReservationPlan",
      diagnostics: plan.diagnostics,
      reservation_count: plan.reservations.length,
      reserved_events: plan.reservations.map((r) => ({
        rank: r.reservation_rank,
        event_title: r.event_title,
        match_family_key: r.match_family_key,
        sport: r.sport,
        tier: r.event_tier,
        score: r.event_score,
      })),
    };

    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    return { path: filePath, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[persistReservationPlanDiagnostics] Diagnostic write failed (non-fatal):", msg);
    return { path: null, error: msg };
  }
}

// ── Founder email (rendered from frozen reservations, NOT stateless slots) ──────

function reservationRebalanceIso(gameStartIso: string): string {
  const ms = Date.parse(gameStartIso);
  if (!Number.isFinite(ms)) return gameStartIso;
  return new Date(ms - REBALANCE_MINUTES_BEFORE_START * 60_000).toISOString();
}

function reservationExecWindowIso(gameStartIso: string): { from: string; to: string } {
  const ms = Date.parse(gameStartIso);
  if (!Number.isFinite(ms)) return { from: gameStartIso, to: gameStartIso };
  return {
    from: new Date(ms - PREFERRED_ENTRY_MINUTES_BEFORE * 60_000).toISOString(),
    to: new Date(ms - LATEST_ENTRY_MINUTES_BEFORE * 60_000).toISOString(),
  };
}

export function nightReservationEmail(
  planRunId: string,
  reservations: NightEventReservationRow[]
): { subject: string; text: string } {
  const L: string[] = [];
  const windowStart = reservations[0]?.window_start_iso ?? null;
  const windowEnd = reservations[0]?.window_end_iso ?? null;
  L.push(`PolyProPicks Night Portfolio Plan (frozen reservations)`);
  L.push(`plan_run_id: ${planRunId}`);
  if (windowStart && windowEnd) {
    L.push(`Window: ${formatMinskUtc(windowStart)} -> ${formatMinskUtc(windowEnd)}`);
  }
  L.push(`Reserved events: ${reservations.length}`);
  L.push("");
  L.push("CONTROL MODEL: Ireland AUTO-STARTS at 18:00 Minsk. This email is informational +");
  L.push("emergency-override only - NO approval required. Market selection per event happens");
  L.push("later at T-60/T-30 rebalance; Ireland reads only the execution queue.");
  L.push("");
  if (reservations.length === 0) {
    L.push("(no events reserved for tonight)");
  } else {
    L.push("Reserved events (event-level; one market chosen later per event):");
    reservations.forEach((r) => {
      const ew = reservationExecWindowIso(r.game_start_iso);
      L.push(
        `  #${r.reservation_rank} [${r.event_tier}] ${r.event_title} ` +
          `(${r.strategic_scope}/${r.sport ?? "?"})`
      );
      L.push(`      start:     ${formatMinskUtc(r.game_start_iso)}`);
      L.push(`      rebalance: ${formatMinskUtc(reservationRebalanceIso(r.game_start_iso))}`);
      L.push(`      exec win:  ${formatMinskUtc(ew.from)} -> ${formatMinskUtc(ew.to)}`);
    });
  }
  L.push("");
  L.push("NOTE: one reserved event = at most one live position after rebalance.");
  const subject = `PolyProPicks Night Plan — ${reservations.length} events reserved — ${planRunId}`;
  return { subject, text: L.join("\n") };
}

/**
 * Ensure a frozen plan exists for the current run, then return its reservations.
 * Used by the email path so the email always reflects persisted reservations.
 */
export async function ensureAndLoadReservations(
  nowMs: number,
  opts: { allowCreate?: boolean } = {}
): Promise<{ planRunId: string; reservations: NightEventReservationRow[]; created: boolean }> {
  const planRunId = buildPlanRunId(nowMs);
  let reservations = await loadReservations(planRunId);
  let created = false;
  if (reservations.length === 0 && opts.allowCreate) {
    const plan = await buildReservationPlan(nowMs);
    await persistReservationPlan(plan, { force: false });
    reservations = await loadReservations(planRunId);
    created = true;
  }
  return { planRunId, reservations, created };
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

// ── Plan health diagnostics ────────────────────────────────────────────────

// Minimum overnight battle WC/soccer event floor. If fewer are reserved than this
// threshold and the plan has rows, needs_rebuild is set to true so founders see the signal.
const BATTLE_WC_MIN_FLOOR = 2;

export interface PlanHealth {
  has_rows: boolean;
  total_count: number;
  reserved_count: number;
  queued_count: number;
  skipped_count: number;
  expired_count: number;
  bad_market_level_count: number;
  active_future_count: number;
  earliest_game_start_iso: string | null;
  latest_game_start_iso: string | null;
  is_expired_only: boolean;
  needs_rebuild: boolean;
  rebuild_allowed: boolean;
  // Horizon diagnostics — populated from resolveNightWindow at status-read time.
  window_end_iso: string;
  horizon_end_iso: string;
  // WC/soccer floor diagnostics.
  reserved_wc_or_soccer_count: number;
  // eligible_wc_or_soccer_count = reserved count when loaded from DB (no rebuild);
  // it equals the actual eligible count only during a fresh build run.
  eligible_wc_or_soccer_count: number;
  wc_floor_below_minimum: boolean;
  // skipped_by_horizon_count and skipped_by_cap_count are only available during a
  // fresh buildReservationPlan run; 0 when loaded from existing DB rows.
  skipped_by_horizon_count: number;
  skipped_by_cap_count: number;
}

/**
 * Read existing plan rows from DB and compute health diagnostics.
 * Pure read — no writes. Returns zero-counts when the plan does not exist yet.
 */
export async function loadPlanStatus(planRunId: string, nowMs: number): Promise<PlanHealth> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("night_event_reservations")
    .select("*")
    .eq("plan_run_id", planRunId)
    .order("reservation_rank", { ascending: true });
  if (error) throw new Error(`loadPlanStatus: ${error.message}`);

  const rows = (data ?? []) as NightEventReservationRow[];
  const total = rows.length;

  const statusBuckets: Record<string, number> = {};
  for (const r of rows) statusBuckets[r.status] = (statusBuckets[r.status] ?? 0) + 1;

  const reservedCount = statusBuckets["RESERVED"] ?? 0;
  const rebalancePendingCount = statusBuckets["REBALANCE_PENDING"] ?? 0;
  const queuedCount = statusBuckets["QUEUED"] ?? 0;
  const skippedCount = (statusBuckets["SKIPPED"] ?? 0) + (statusBuckets["CANCELLED"] ?? 0);
  const expiredCount = statusBuckets["EXPIRED"] ?? 0;

  const ACTIVE_STATUSES = new Set(["RESERVED", "REBALANCE_PENDING", "QUEUED"]);
  const activeFutureRows = rows.filter(
    (r) => ACTIVE_STATUSES.has(r.status) && !!r.game_start_iso && Date.parse(r.game_start_iso) > nowMs
  );
  const activeFutureCount = activeFutureRows.length;

  // Post-hoc check: rows whose match_family_key looks like a market-level prop line.
  const badMarketLevelCount = rows.filter((r) => MARKET_LEVEL_KEY_RE.test(r.match_family_key)).length;

  const gameStartTimes = rows
    .map((r) => r.game_start_iso)
    .filter((s): s is string => !!s)
    .sort();

  const isExpiredOnly = total > 0 && activeFutureCount === 0;

  // WC/soccer floor: count active reservations with WC or SOCCER strategic_scope.
  const reservedWcOrSoccer = rows.filter(
    (r) =>
      ACTIVE_STATUSES.has(r.status) &&
      (r.strategic_scope === "WC" || r.strategic_scope === "SOCCER")
  ).length;
  const wcFloorBelowMinimum = total > 0 && reservedWcOrSoccer < BATTLE_WC_MIN_FLOOR;

  // needs_rebuild: expired-only, bad market keys, or WC floor below minimum battle threshold.
  const needsRebuild = isExpiredOnly || badMarketLevelCount > 0 || wcFloorBelowMinimum;

  // Horizon bounds computed from current window (read-time, not build-time).
  const nightWindow = resolveNightWindow(nowMs);

  return {
    has_rows: total > 0,
    total_count: total,
    reserved_count: reservedCount + rebalancePendingCount,
    queued_count: queuedCount,
    skipped_count: skippedCount,
    expired_count: expiredCount,
    bad_market_level_count: badMarketLevelCount,
    active_future_count: activeFutureCount,
    earliest_game_start_iso: gameStartTimes[0] ?? null,
    latest_game_start_iso: gameStartTimes[gameStartTimes.length - 1] ?? null,
    is_expired_only: isExpiredOnly,
    needs_rebuild: needsRebuild,
    rebuild_allowed: true,
    window_end_iso: nightWindow.endIso,
    horizon_end_iso: nightWindow.horizonEndIso,
    reserved_wc_or_soccer_count: reservedWcOrSoccer,
    eligible_wc_or_soccer_count: reservedWcOrSoccer,
    wc_floor_below_minimum: wcFloorBelowMinimum,
    skipped_by_horizon_count: 0,
    skipped_by_cap_count: 0,
  };
}

export interface ForceRebuildResult {
  plan_run_id: string;
  deleted_queue_count: number;
  deleted_reservation_count: number;
  plan: ReservationPlan;
  persist: PersistReservationsResult;
  plan_health: PlanHealth;
}

/**
 * CEO-approved force rebuild for the current plan_run_id.
 * Deletes event_execution_queue rows AND night_event_reservations rows for this plan,
 * then rebuilds fresh from the current universe.
 * Only touches the two Contur3 tables for the current plan_run_id.
 */
export async function executeForceRebuild(nowMs: number): Promise<ForceRebuildResult> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const planRunId = buildPlanRunId(nowMs);

  // 1. Delete event_execution_queue rows for this plan_run_id.
  const { data: deletedQueue, error: queueErr } = await supabaseAdmin
    .from("event_execution_queue")
    .delete()
    .eq("plan_run_id", planRunId)
    .select("id");
  if (queueErr) throw new Error(`forceRebuild queue delete: ${queueErr.message}`);
  const deletedQueueCount = deletedQueue?.length ?? 0;

  // 2. Delete night_event_reservations rows for this plan_run_id.
  const { data: deletedRes, error: resErr } = await supabaseAdmin
    .from("night_event_reservations")
    .delete()
    .eq("plan_run_id", planRunId)
    .select("id");
  if (resErr) throw new Error(`forceRebuild reservation delete: ${resErr.message}`);
  const deletedResCount = deletedRes?.length ?? 0;

  // 3. Rebuild from current universe.
  const plan = await buildReservationPlan(nowMs);
  const persist = await persistReservationPlan(plan, { force: false });

  // 4. Read back health of the new plan.
  const planHealth = await loadPlanStatus(planRunId, nowMs);

  return {
    plan_run_id: planRunId,
    deleted_queue_count: deletedQueueCount,
    deleted_reservation_count: deletedResCount,
    plan,
    persist,
    plan_health: planHealth,
  };
}
