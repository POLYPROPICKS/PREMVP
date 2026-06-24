// lib/executor/eventExecutionQueue.ts
//
// Contur3 per-event REBALANCE → single-market execution queue.
//
// For each reserved event due for rebalance (T-70 .. T-3 before start), this loads
// all current markets for that one event, applies the executable policy (Tier1 only,
// no halftime, stake $7), selects exactly ONE best market, and writes one READY row
// into event_execution_queue. The reservation is then marked QUEUED (or SKIPPED).
//
// Process schedule: continuous 24/7 (canonical Railway cron: * * * * *).
// Business entry window: T-70m to T-3m enforced by isDueForRebalance() — NOT by cron.
//
// This module NEVER places orders and NEVER pulls a broad executable universe for
// Ireland — Ireland reads only the queue via /api/executor/queue.

import { createHash } from "crypto";
import { buildFireModelCandidates, type FireModelCandidate } from "./buildFireModelCandidates";
import { compareCandidateQuality } from "./nightPortfolioPlanner";
import {
  buildRebalanceRunId,
  isDueForRebalance,
  preferredEntryIso,
  latestEntryIso,
  REBALANCE_MINUTES_BEFORE_START,
  LATEST_ENTRY_MINUTES_BEFORE,
} from "./nightWindow";
import {
  EXECUTABLE_STAKE_USD,
  EXECUTABLE_TIER,
  type EventExecutionQueueRow,
  type NightEventReservationRow,
} from "./executorQueueTypes";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const PLAN_POOL = 200;

// Mirror of /api/executor/night-plan halftime block (P0E_BLOCK_HALFTIME_MARKETS_V1).
// IMPORTANT: detection must use only market IDENTITY fields (slug/title/key),
// never full JSON serialization or diagnostics metric fields (delta1hPp, price1hAgo, etc.).
const HALFTIME_MARKET_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;

// Corners block: O/U corners and total corners markets are not live-executable under current contract.
const CORNERS_MARKET_RE = /\bcorners?\b|total[\s_-]corners?|corners?[\s_-]total/i;

// Prop/exact-score block: player props, exact scorelines, goalscorer markets — not live-executable.
const PROP_MARKET_RE =
  /exact[\s_-]score|goalscorer|goal[\s_-]scorer|anytime[\s_-]scorer|first[\s_-]scorer|last[\s_-]scorer|\bplayer[\s_-]shot|\bplayer[\s_-]assist|\boutright\b/i;

function planTierLabel(c: FireModelCandidate): "TIER1" | "TIER2" | "TIER3" | "REJECTED" {
  if (c.strategy === "TIER1_CORE_STRICT_72_COV50") return "TIER1";
  if (c.strategy === "TIER2_SAFE_EXPAND_60_COV50") return "TIER2";
  if (c.strategy === "TIER3_MICRO_EXPAND_50_COV25") return "TIER3";
  return "REJECTED";
}

/**
 * Halftime detection using only market identity fields.
 * MUST NOT scan full row JSON or diagnostics metric fields.
 * Checks: market_slug, event_slug, match_family_key, diagnostics.marketTitle,
 * diagnostics.marketType, diagnostics.question, diagnostics.title.
 */
function isHalftime(c: FireModelCandidate): boolean {
  // Identity-only fields — never full JSON
  if (HALFTIME_MARKET_RE.test(c.market_slug ?? "")) return true;
  if (HALFTIME_MARKET_RE.test(c.event_slug ?? "")) return true;
  if (HALFTIME_MARKET_RE.test(c.match_family_key ?? "")) return true;
  // Diagnostics market-identity sub-fields only
  const diag = (c.diagnostics ?? {}) as Record<string, unknown>;
  const diagMarketTitle = typeof diag.marketTitle === "string" ? diag.marketTitle : "";
  const diagMarketType  = typeof diag.marketType === "string"  ? diag.marketType  : "";
  const diagQuestion    = typeof diag.question === "string"    ? diag.question    : "";
  const diagTitle       = typeof diag.title === "string"       ? diag.title       : "";
  return (
    HALFTIME_MARKET_RE.test(diagMarketTitle) ||
    HALFTIME_MARKET_RE.test(diagMarketType) ||
    HALFTIME_MARKET_RE.test(diagQuestion) ||
    HALFTIME_MARKET_RE.test(diagTitle)
  );
}

/**
 * Corners detection using only market identity fields.
 * Corners markets are NOT live-executable under current contract (full-match only).
 */
function isCorners(c: FireModelCandidate): boolean {
  if (CORNERS_MARKET_RE.test(c.market_slug ?? "")) return true;
  if (CORNERS_MARKET_RE.test(c.event_slug ?? "")) return true;
  if (CORNERS_MARKET_RE.test(c.match_family_key ?? "")) return true;
  const diag = (c.diagnostics ?? {}) as Record<string, unknown>;
  const diagMarketTitle = typeof diag.marketTitle === "string" ? diag.marketTitle : "";
  const diagQuestion    = typeof diag.question === "string"    ? diag.question    : "";
  return CORNERS_MARKET_RE.test(diagMarketTitle) || CORNERS_MARKET_RE.test(diagQuestion);
}

/**
 * Prop/exact-score detection using only market identity fields.
 * Goalscorer, exact score, player props, outrights — not live-executable.
 */
function isProp(c: FireModelCandidate): boolean {
  if (PROP_MARKET_RE.test(c.market_slug ?? "")) return true;
  if (PROP_MARKET_RE.test(c.event_slug ?? "")) return true;
  const diag = (c.diagnostics ?? {}) as Record<string, unknown>;
  const diagMarketTitle = typeof diag.marketTitle === "string" ? diag.marketTitle : "";
  const diagQuestion    = typeof diag.question === "string"    ? diag.question    : "";
  return PROP_MARKET_RE.test(diagMarketTitle) || PROP_MARKET_RE.test(diagQuestion);
}

/**
 * Executable filter for the SINGLE selected market (LOCKED policy):
 *   Tier1 only, live_eligible, not halftime, not corners,
 *   condition_id + token_id + side present.
 * Candidates are filtered BEFORE ranking so a high-score corners market
 * cannot outrank a lower-score core spread.
 */
function isExecutableMarket(c: FireModelCandidate): {
  executable: boolean;
  rejectReason: string | null;
} {
  if (planTierLabel(c) !== EXECUTABLE_TIER) return { executable: false, rejectReason: "NOT_TIER1" };
  if (!c.live_eligible) return { executable: false, rejectReason: c.live_rejection_reason ?? "NOT_LIVE_ELIGIBLE" };
  if (isHalftime(c)) return { executable: false, rejectReason: "HALFTIME_NOT_LIVE_EXECUTABLE" };
  if (isCorners(c)) return { executable: false, rejectReason: "CORNERS_NOT_LIVE_EXECUTABLE" };
  if (isProp(c)) return { executable: false, rejectReason: "PROP_NOT_LIVE_EXECUTABLE" };
  if (!c.condition_id) return { executable: false, rejectReason: "MISSING_CONDITION_ID" };
  if (!c.token_id) return { executable: false, rejectReason: "MISSING_TOKEN_ID" };
  if (!c.side) return { executable: false, rejectReason: "MISSING_SIDE" };
  return { executable: true, rejectReason: null };
}

function buildQueueRow(
  reservation: NightEventReservationRow,
  best: FireModelCandidate,
  rebalanceRunId: string
): EventExecutionQueueRow {
  const orderKey = `${best.condition_id}:${best.token_id}:${best.side}`;
  const idem = createHash("sha256")
    .update(`${reservation.plan_run_id}__${orderKey}`)
    .digest("hex")
    .slice(0, 32);
  return {
    reservation_id: reservation.id ?? null,
    plan_run_id: reservation.plan_run_id,
    rebalance_run_id: rebalanceRunId,
    match_family_key: reservation.match_family_key,
    event_title: reservation.event_title,
    event_slug: best.event_slug ?? reservation.event_slug,
    sport: best.inferred_sport,
    league: reservation.league,
    game_start_iso: best.diagnostics.game_start_iso,
    condition_id: best.condition_id,
    token_id: best.token_id,
    side: best.side,
    market_slug: best.market_slug,
    market_title: best.market_slug,
    market_family: best.market_family,
    score: best.diagnostics.score,
    coverage: best.diagnostics.coverage,
    tier: EXECUTABLE_TIER,
    stake_usd: EXECUTABLE_STAKE_USD,
    preferred_entry_iso: preferredEntryIso(new Date(best.diagnostics.game_start_iso).getTime()),
    latest_entry_iso: latestEntryIso(new Date(best.diagnostics.game_start_iso).getTime()),
    selection_rank: 1,
    selection_reason: `REBALANCE_SINGLE_BEST_MARKET: tier=${EXECUTABLE_TIER} score=${best.diagnostics.score} cov=${best.diagnostics.coverage}`,
    status: "READY",
    order_key: orderKey,
    idempotency_key: idem,
    diagnostics: {
      hours_to_start: best.diagnostics.hours_to_start_now,
      timing_bucket: best.timing_bucket,
      smart_money: best.diagnostics.smart_money,
      entry_price: best.diagnostics.entry_price,
      max_entry_price: best.max_entry_price,
      battle_trace_id: `contur3:${reservation.plan_run_id}:${reservation.match_family_key}:${best.condition_id}:${best.token_id}`,
    },
  };
}

export interface BlockedCandidateDiag {
  market_slug: string;
  event_slug: string | null;
  market_title: string;
  event_title: string | null;
  match_family_key: string;
  tier: string;
  score: number;
  condition_id_present: boolean;
  token_id_present: boolean;
  selected_token_id_present: boolean;
  side: string;
  selected_outcome: string | null;
  selectedOutcome: string | null;
  side_mapping_status: string;
  live_eligible: boolean;
  live_rejection_reason: string | null;
  activity_label_detected: boolean;
  identity_quality: string;
  identity_warning_codes: string[];
  is_halftime_market: boolean;
  stake_usd: number;
  game_start_iso: string;
  preferred_entry_iso: string | null;
  latest_entry_iso: string | null;
  block_flags: {
    not_tier1: boolean;
    missing_condition_id: boolean;
    missing_token_id: boolean;
    missing_side: boolean;
    missing_market_slug: boolean;
    side_mapping_unknown: boolean;
    not_live_eligible: boolean;
    halftime: boolean;
    missing_entry_window: boolean;
  };
}

function buildBlockedCandidateDiag(c: FireModelCandidate): BlockedCandidateDiag {
  const gameStartMs = c.diagnostics.game_start_iso
    ? new Date(c.diagnostics.game_start_iso).getTime()
    : NaN;
  const hasValidStart = Number.isFinite(gameStartMs);
  return {
    market_slug: c.market_slug,
    event_slug: c.event_slug,
    market_title: c.market_slug,
    event_title: null,
    match_family_key: c.match_family_key,
    tier: c.strategy,
    score: c.diagnostics.score,
    condition_id_present: Boolean(c.condition_id),
    token_id_present: Boolean(c.token_id),
    selected_token_id_present: Boolean(c.token_id),
    side: c.side,
    selected_outcome: c.selected_outcome,
    selectedOutcome: c.selected_outcome,
    side_mapping_status: c.side_mapping_status,
    live_eligible: c.live_eligible,
    live_rejection_reason: c.live_rejection_reason,
    activity_label_detected: c.activity_label_detected,
    identity_quality: c.identity_quality,
    identity_warning_codes: c.identity_warning_codes,
    is_halftime_market: isHalftime(c),
    stake_usd: c.stake_usd,
    game_start_iso: c.diagnostics.game_start_iso,
    preferred_entry_iso: hasValidStart ? preferredEntryIso(gameStartMs) : null,
    latest_entry_iso: hasValidStart ? latestEntryIso(gameStartMs) : null,
    block_flags: {
      not_tier1: planTierLabel(c) !== EXECUTABLE_TIER,
      missing_condition_id: !Boolean(c.condition_id),
      missing_token_id: !Boolean(c.token_id),
      missing_side: !Boolean(c.side),
      missing_market_slug: !Boolean(c.market_slug),
      side_mapping_unknown: c.side_mapping_status === "UNKNOWN_BLOCKED",
      not_live_eligible: !c.live_eligible,
      halftime: isHalftime(c),
      missing_entry_window: !c.diagnostics.game_start_iso,
    },
  };
}

export interface RebalanceOutcome {
  match_family_key: string;
  reservation_id: string | null;
  result: "QUEUED" | "SKIPPED" | "ALREADY_QUEUED";
  reason: string;
  queue_row?: EventExecutionQueueRow;
  blocked_candidates?: BlockedCandidateDiag[];
}

export interface NextDueReservation {
  match_family_key: string;
  game_start_iso: string;
  rebalance_starts_iso: string;
  rebalance_ends_iso: string;
  next_check_after_seconds: number;
  due_window_state: "BEFORE_WINDOW" | "IN_WINDOW" | "EXPIRED";
}

export interface RebalanceRunResult {
  rebalance_run_id: string;
  due_count: number;
  queued_count: number;
  skipped_count: number;
  already_queued_count: number;
  expired_count: number;
  future_valid_reservations_count: number;
  outcomes: RebalanceOutcome[];
  wrote: boolean;
  next_due_reservations: NextDueReservation[];
  next_check_after_seconds: number | null;
}

/**
 * Run the per-event rebalance. write=false → pure dry-run (no DB writes).
 * Loads the candidate universe once and selects one market per due reservation.
 */
export async function runEventRebalance(
  nowMs: number,
  opts: { write?: boolean } = {}
): Promise<RebalanceRunResult> {
  const write = opts.write === true;
  const rebalanceRunId = buildRebalanceRunId(nowMs);
  const { supabaseAdmin } = await import("@/lib/supabase/server");

  // Due reservations: active status + start within the rebalance window.
  const { data: reservationRows, error: resErr } = await supabaseAdmin
    .from("night_event_reservations")
    .select("*")
    .in("status", ["RESERVED", "REBALANCE_PENDING"]);
  if (resErr) throw new Error(`reservation due-query failed: ${resErr.message}`);

  const all = (reservationRows ?? []) as NightEventReservationRow[];
  const due = all.filter((r) => {
    const startMs = Date.parse(r.game_start_iso);
    return Number.isFinite(startMs) && isDueForRebalance(startMs, nowMs);
  });
  const expired = all.filter((r) => {
    const startMs = Date.parse(r.game_start_iso);
    const minutesToStart = (startMs - nowMs) / 60_000;
    return Number.isFinite(startMs) && minutesToStart <= LATEST_ENTRY_MINUTES_BEFORE;
  });
  const upcoming = all
    .filter((r) => {
      const startMs = Date.parse(r.game_start_iso);
      const minutesToStart = (startMs - nowMs) / 60_000;
      return Number.isFinite(startMs) && minutesToStart > REBALANCE_MINUTES_BEFORE_START;
    })
    .sort((a, b) => Date.parse(a.game_start_iso) - Date.parse(b.game_start_iso));
  const next_due_reservations: NextDueReservation[] = upcoming.slice(0, 3).map((r) => {
    const startMs = Date.parse(r.game_start_iso);
    const rebalanceStartsMs = startMs - REBALANCE_MINUTES_BEFORE_START * 60_000;
    const rebalanceEndsMs = startMs - LATEST_ENTRY_MINUTES_BEFORE * 60_000;
    return {
      match_family_key: r.match_family_key,
      game_start_iso: r.game_start_iso,
      rebalance_starts_iso: new Date(rebalanceStartsMs).toISOString(),
      rebalance_ends_iso: new Date(rebalanceEndsMs).toISOString(),
      next_check_after_seconds: Math.max(0, Math.ceil((rebalanceStartsMs - nowMs) / 1000)),
      due_window_state: "BEFORE_WINDOW" as const,
    };
  });
  const next_check_after_seconds: number | null =
    next_due_reservations.length > 0 ? next_due_reservations[0].next_check_after_seconds : null;

  const outcomes: RebalanceOutcome[] = [];

  if (write && expired.length > 0) {
    const expiredIds = expired.map((r) => r.id).filter((v): v is string => Boolean(v));
    if (expiredIds.length > 0) {
      await supabaseAdmin
        .from("night_event_reservations")
        .update({ status: "EXPIRED", selection_reason: "MISSED_REBALANCE_WINDOW" })
        .in("id", expiredIds);
    }
  }

  if (due.length === 0) {
    return {
      rebalance_run_id: rebalanceRunId,
      due_count: 0,
      queued_count: 0,
      skipped_count: 0,
      already_queued_count: 0,
      expired_count: expired.length,
      future_valid_reservations_count: upcoming.length,
      outcomes,
      wrote: write,
      next_due_reservations,
      next_check_after_seconds,
    };
  }

  // Existing READY/SENT queue rows so we never double-queue a reservation.
  const { data: existingQueue, error: qErr } = await supabaseAdmin
    .from("event_execution_queue")
    .select("reservation_id, status")
    .in("status", ["READY", "CLAIMED", "SENT"]);
  if (qErr) throw new Error(`queue existing-query failed: ${qErr.message}`);
  const alreadyQueued = new Set(
    ((existingQueue ?? []) as Array<{ reservation_id: string | null }>)
      .map((q) => q.reservation_id)
      .filter((v): v is string => Boolean(v))
  );

  // Load current markets once; group by event key.
  const { candidates: universe } = await buildFireModelCandidates(PLAN_POOL, "all", true);
  const marketsByKey = new Map<string, FireModelCandidate[]>();
  for (const c of universe) {
    const arr = marketsByKey.get(c.match_family_key) ?? [];
    arr.push(c);
    marketsByKey.set(c.match_family_key, arr);
  }

  let queued = 0;
  let skipped = 0;
  let already = 0;

  for (const reservation of due) {
    if (reservation.id && alreadyQueued.has(reservation.id)) {
      already += 1;
      outcomes.push({
        match_family_key: reservation.match_family_key,
        reservation_id: reservation.id ?? null,
        result: "ALREADY_QUEUED",
        reason: "READY_OR_SENT_QUEUE_ROW_EXISTS",
      });
      continue;
    }

    const eventCandidates = marketsByKey.get(reservation.match_family_key) ?? [];
    const tier1Candidates = eventCandidates.filter((c) => planTierLabel(c) === EXECUTABLE_TIER);
    const tier1WithCondToken = tier1Candidates.filter(
      (c) => Boolean(c.condition_id) && Boolean(c.token_id)
    );
    const tier1SideBlocked = tier1WithCondToken.filter(
      (c) =>
        !c.live_eligible &&
        (c.live_rejection_reason === "SIDE_MAPPING_UNKNOWN_BLOCKED" ||
          c.live_block_reason === "SIDE_MAPPING_UNKNOWN_BLOCKED")
    );
    const eventMarkets = eventCandidates.filter((c) => {
      const { executable, rejectReason } = isExecutableMarket(c);
      if (!executable) {
        console.log(
          `[contur3-rebalance] CANDIDATE_BLOCKED market=${c.market_slug ?? c.event_slug ?? "?"} reason=${rejectReason}`,
        );
      }
      return executable;
    }).sort(compareCandidateQuality);

    if (eventMarkets.length === 0) {
      const isSideMissingBlocker = tier1WithCondToken.length > 0 && tier1SideBlocked.length > 0;
      const skipReason = isSideMissingBlocker
        ? `NO_EXECUTABLE_TIER1_MARKET_AT_REBALANCE_SIDE_MISSING: candidate_count=${eventCandidates.length} tier1_count=${tier1Candidates.length} tier1_with_cond_token=${tier1WithCondToken.length} tier1_side_blocked=${tier1SideBlocked.length} examples=${tier1SideBlocked.slice(0, 2).map((c) => c.market_slug ?? c.event_slug ?? "?").join(",")}`
        : `NO_EXECUTABLE_TIER1_MARKET_AT_REBALANCE: candidate_count=${eventCandidates.length} tier1_count=${tier1Candidates.length}`;
      skipped += 1;
      if (write) {
        await supabaseAdmin
          .from("night_event_reservations")
          .update({ status: "SKIPPED", selection_reason: skipReason })
          .eq("id", reservation.id);
      }
      outcomes.push({
        match_family_key: reservation.match_family_key,
        reservation_id: reservation.id ?? null,
        result: "SKIPPED",
        reason: skipReason,
        blocked_candidates: eventCandidates.slice(0, 5).map(buildBlockedCandidateDiag),
      });
      continue;
    }

    const best = eventMarkets[0];
    const row = buildQueueRow(reservation, best, rebalanceRunId);

    if (write) {
      const { error: insErr } = await supabaseAdmin.from("event_execution_queue").insert(row);
      if (insErr) throw new Error(`queue insert failed (${reservation.match_family_key}): ${insErr.message}`);
      await supabaseAdmin
        .from("night_event_reservations")
        .update({ status: "QUEUED", selection_reason: row.selection_reason })
        .eq("id", reservation.id);
    }

    queued += 1;
    outcomes.push({
      match_family_key: reservation.match_family_key,
      reservation_id: reservation.id ?? null,
      result: "QUEUED",
      reason: row.selection_reason ?? "REBALANCE_SINGLE_BEST_MARKET",
      queue_row: row,
    });
  }

  return {
    rebalance_run_id: rebalanceRunId,
    due_count: due.length,
    queued_count: queued,
    skipped_count: skipped,
    already_queued_count: already,
    expired_count: expired.length,
    future_valid_reservations_count: upcoming.length,
    outcomes,
    wrote: write,
    next_due_reservations,
    next_check_after_seconds,
  };
}

/**
 * Persist rebalance diagnostics to filesystem under modeling/fire_runs/contur3-rebalance/.
 * Failure does NOT fail the business cron; it logs a warning and continues.
 */
export async function persistRebalanceDiagnostics(
  result: RebalanceRunResult,
  opts?: { context?: string }
): Promise<{ path: string | null; error: string | null }> {
  try {
    const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runIdSafe = result.rebalance_run_id.replace(/[^a-z0-9_-]/gi, "_");
    const filename = `${runIdSafe}_${timestamp}.json`;

    const dirPath = path.join(process.cwd(), "modeling", "fire_runs", "contur3-rebalance");
    await mkdir(dirPath, { recursive: true });

    const filePath = path.join(dirPath, filename);
    const payload = {
      generated_at: new Date().toISOString(),
      rebalance_run_id: result.rebalance_run_id,
      commit,
      context: opts?.context || "runEventRebalance",
      due_count: result.due_count,
      queued_count: result.queued_count,
      skipped_count: result.skipped_count,
      already_queued_count: result.already_queued_count,
      expired_count: result.expired_count,
      wrote: result.wrote,
      outcomes_summary: {
        total: result.outcomes.length,
        queued: result.outcomes.filter((o) => o.result === "QUEUED").length,
        skipped: result.outcomes.filter((o) => o.result === "SKIPPED").length,
        already_queued: result.outcomes.filter((o) => o.result === "ALREADY_QUEUED").length,
      },
      outcomes: result.outcomes.map((o) => ({
        match_family_key: o.match_family_key,
        result: o.result,
        reason: o.reason,
        queued_event: o.queue_row?.event_title ?? null,
        skipped_candidate_count: o.blocked_candidates?.length ?? 0,
      })),
      next_due_reservations: result.next_due_reservations.slice(0, 3),
      next_check_after_seconds: result.next_check_after_seconds,
    };

    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    return { path: filePath, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[persistRebalanceDiagnostics] Diagnostic write failed (non-fatal):", msg);
    return { path: null, error: msg };
  }
}
