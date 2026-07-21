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
import type { FireModelCandidate } from "./buildFireModelCandidates";
import { compareCandidateQuality } from "./nightPortfolioPlanner";
import { FROZEN_MODEL_V2_VERSION } from "@/lib/modeling/frozenModelProducerV2Shadow";
import {
  buildRebalanceRunId,
  isDueForRebalance,
  preferredEntryIso,
  latestEntryIso,
  REBALANCE_MINUTES_BEFORE_START,
  LATEST_ENTRY_MINUTES_BEFORE,
} from "./nightWindow";
import {
  EXECUTABLE_TIER,
  type EventExecutionQueueRow,
  type NightEventReservationRow,
} from "./executorQueueTypes";
import {
  createSupabaseSchedulerJobEvidencePort,
  sanitizeSchedulerErrorMessage,
  type SchedulerJobEvidencePort,
} from "./schedulerJobEvidence";
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
  if (!Number.isFinite(c.stake_usd) || c.stake_usd <= 0) {
    return { executable: false, rejectReason: "INVALID_STAKE_USD" };
  }
  return { executable: true, rejectReason: null };
}

// Exported (pure, no DB) so the stake/price propagation policy can be unit-tested
// directly: the queue row must carry the candidate's OWN computed stake_usd —
// never a hardcoded fallback constant.
export function buildQueueRow(
  reservation: NightEventReservationRow,
  best: FireModelCandidate,
  rebalanceRunId: string
): EventExecutionQueueRow {
  const orderKey = `${best.condition_id}:${best.token_id}:${best.side}`;
  const idem = createHash("sha256")
    .update(`${reservation.plan_run_id}__${orderKey}`)
    .digest("hex")
    .slice(0, 32);
  const reservationSelectorId = (reservation.diagnostics ?? {}).selector_id;
  const isContractA = typeof reservationSelectorId === "string" && reservationSelectorId.trim() !== "";
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
    // PREMVP source of truth: use the candidate's own computed stake (never the
    // legacy hardcoded constant). isExecutableMarket() already rejects any
    // candidate with a non-positive/non-finite stake before it can reach here.
    stake_usd: best.stake_usd,
    preferred_entry_iso: preferredEntryIso(new Date(best.diagnostics.game_start_iso).getTime()),
    latest_entry_iso: latestEntryIso(new Date(best.diagnostics.game_start_iso).getTime()),
    selection_rank: 1,
    selection_reason: isContractA
      ? `CONTRACT_A_AUTHORITATIVE_MARKET: selector=${reservationSelectorId}`
      : `REBALANCE_SINGLE_BEST_MARKET: tier=${EXECUTABLE_TIER} score=${best.diagnostics.score} cov=${best.diagnostics.coverage}`,
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
      ...(isContractA
        ? {
            selector_id: reservationSelectorId,
            authoritative_condition_id: (reservation.diagnostics ?? {}).authoritative_condition_id,
            authoritative_token_id: (reservation.diagnostics ?? {}).authoritative_token_id,
            authoritative_side: (reservation.diagnostics ?? {}).authoritative_side,
            authoritative_observation_id: (reservation.diagnostics ?? {}).authoritative_observation_id,
            authoritative_event_key: (reservation.diagnostics ?? {}).authoritative_event_key,
          }
        : {}),
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

/**
 * Per-reservation classification so a due_count=0 run still explains WHY each
 * active reservation is not due. This satisfies the non-negotiable invariant:
 * "due_count=0 is not enough — it must print why each active reservation is not due."
 */
export interface ReservationClassification {
  match_family_key: string;
  event_title: string | null;
  game_start_iso: string;
  status: string;
  // Exact reason an active reservation is or is not selectable by the due filter.
  state:
    | "DUE_NOW"
    | "NOT_DUE_YET"
    | "EXPIRED"
    | "INVALID_START";
  seconds_until_due: number | null; // seconds until rebalance window opens (>=0 when NOT_DUE_YET)
  rebalance_starts_iso: string | null;
  rebalance_ends_iso: string | null;
}

export interface RebalanceRunResult {
  rebalance_run_id: string;
  active_reservations_count: number;
  due_count: number;
  queued_count: number;
  skipped_count: number;
  already_queued_count: number;
  expired_count: number;
  future_valid_reservations_count: number;
  // True when reservations were due but none reached the queue — a hard battle failure.
  fail_due_reservations_not_queued: boolean;
  outcomes: RebalanceOutcome[];
  // Full per-active-reservation reason table (every RESERVED/REBALANCE_PENDING row).
  reservation_classification: ReservationClassification[];
  wrote: boolean;
  next_due_reservations: NextDueReservation[];
  next_check_after_seconds: number | null;
}

/** Classify every active reservation against the due window — pure, no DB. */
function classifyReservations(
  all: NightEventReservationRow[],
  nowMs: number
): ReservationClassification[] {
  return all
    .map((r) => {
      const startMs = Date.parse(r.game_start_iso);
      if (!Number.isFinite(startMs)) {
        return {
          match_family_key: r.match_family_key,
          event_title: r.event_title ?? null,
          game_start_iso: r.game_start_iso,
          status: r.status,
          state: "INVALID_START" as const,
          seconds_until_due: null,
          rebalance_starts_iso: null,
          rebalance_ends_iso: null,
        };
      }
      const rebalanceStartsMs = startMs - REBALANCE_MINUTES_BEFORE_START * 60_000;
      const rebalanceEndsMs = startMs - LATEST_ENTRY_MINUTES_BEFORE * 60_000;
      const minutesToStart = (startMs - nowMs) / 60_000;
      let state: ReservationClassification["state"];
      if (minutesToStart <= LATEST_ENTRY_MINUTES_BEFORE) state = "EXPIRED";
      else if (minutesToStart <= REBALANCE_MINUTES_BEFORE_START) state = "DUE_NOW";
      else state = "NOT_DUE_YET";
      return {
        match_family_key: r.match_family_key,
        event_title: r.event_title ?? null,
        game_start_iso: r.game_start_iso,
        status: r.status,
        state,
        seconds_until_due:
          state === "NOT_DUE_YET" ? Math.max(0, Math.ceil((rebalanceStartsMs - nowMs) / 1000)) : 0,
        rebalance_starts_iso: new Date(rebalanceStartsMs).toISOString(),
        rebalance_ends_iso: new Date(rebalanceEndsMs).toISOString(),
      };
    })
    .sort((a, b) => Date.parse(a.game_start_iso) - Date.parse(b.game_start_iso));
}

/**
 * Injectable persistence/read boundary for the rebalance loop. The real
 * implementation (createSupabaseRebalanceRepoPort) reproduces the exact
 * reservation/queue reads and writes runEventRebalance always made; tests
 * inject an in-memory fake instead of a live Supabase connection.
 */
export interface RebalanceRepoPort {
  loadActiveReservations(): Promise<NightEventReservationRow[]>;
  loadQueuedReservationIds(): Promise<Set<string>>;
  markReservationsExpired(ids: string[]): Promise<void>;
  markReservationSkipped(id: string, reason: string): Promise<void>;
  insertQueueRow(row: EventExecutionQueueRow): Promise<void>;
  markReservationQueued(id: string, reason: string): Promise<void>;
  // Optional so existing normal-mode repo fakes (constructed before this method
  // existed) keep compiling unchanged. Required in practice by the controlled
  // one-shot live-intent seam, which throws if it is absent (see
  // runControlledLiveIntent) rather than silently skipping duplicate-safety.
  findQueueRowsByRebalanceRunId?(rebalanceRunId: string): Promise<EventExecutionQueueRow[]>;
}

export function createSupabaseRebalanceRepoPort(): RebalanceRepoPort {
  return {
    async loadActiveReservations() {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("night_event_reservations")
        .select("*")
        .in("status", ["RESERVED", "REBALANCE_PENDING"]);
      if (error) throw new Error(`reservation due-query failed: ${error.message}`);
      return (data ?? []) as unknown as NightEventReservationRow[];
    },
    async loadQueuedReservationIds() {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .select("reservation_id, status")
        .in("status", ["READY", "CLAIMED", "SENT"]);
      if (error) throw new Error(`queue existing-query failed: ${error.message}`);
      return new Set(
        ((data ?? []) as Array<{ reservation_id: string | null }>)
          .map((q) => q.reservation_id)
          .filter((v): v is string => Boolean(v))
      );
    },
    async markReservationsExpired(ids) {
      if (ids.length === 0) return;
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      await supabaseAdmin
        .from("night_event_reservations")
        .update({ status: "EXPIRED", selection_reason: "MISSED_REBALANCE_WINDOW" })
        .in("id", ids);
    },
    async markReservationSkipped(id, reason) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      await supabaseAdmin
        .from("night_event_reservations")
        .update({ status: "SKIPPED", selection_reason: reason })
        .eq("id", id);
    },
    async insertQueueRow(row) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { error } = await supabaseAdmin.from("event_execution_queue").insert(row);
      if (error) throw new Error(`queue insert failed: ${error.message}`);
    },
    async markReservationQueued(id, reason) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      await supabaseAdmin
        .from("night_event_reservations")
        .update({ status: "QUEUED", selection_reason: reason })
        .eq("id", id);
    },
    async findQueueRowsByRebalanceRunId(rebalanceRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .select("*")
        .eq("rebalance_run_id", rebalanceRunId);
      if (error) throw new Error(`controlled live intent lookup failed: ${error.message}`);
      return (data ?? []) as unknown as EventExecutionQueueRow[];
    },
  };
}

export interface DueReservationSelection {
  outcome: "QUEUED" | "SKIPPED";
  reason: string;
  queueRow: EventExecutionQueueRow | null;
  blockedCandidates?: BlockedCandidateDiag[];
}

/**
 * Pure per-reservation market selection (no DB reads/writes). Extracted from
 * the rebalance loop so the exact same authoritative-candidate-lock logic
 * backs both the normal scheduled rebalance (runEventRebalance) and the
 * controlled one-row live-intent seam (runControlledLiveIntent) -- there is
 * only ever one queue builder / one selection path.
 */
function selectQueueRowForDueReservation(
  reservation: NightEventReservationRow,
  marketsByKey: Map<string, FireModelCandidate[]>,
  contractAFinalUniverse: FireModelCandidate[],
  rebalanceRunId: string
): DueReservationSelection {
  const eventCandidates = marketsByKey.get(reservation.match_family_key) ?? [];

  // Contract A authoritative reservation (CONTRACT_A_V1 selector mode):
  // the exact winning market was already decided upstream and its
  // immutable identity was persisted into reservation.diagnostics.
  // compareCandidateQuality must NEVER substitute a different
  // condition_id/token_id/side here -- locate the exact authoritative
  // candidate only, and fail closed (no READY row, no alternate market)
  // if it is missing or no longer executable.
  const reservationDiag = reservation.diagnostics ?? {};
  const reservationSelectorId = reservationDiag.selector_id;
  const isPlanningReservation = reservationDiag.contract_a_stage === "PLANNING" && reservationSelectorId === "CONTRACT_A_PLANNING_V1";
  const isLegacyAuthoritativeReservation = reservationSelectorId === FROZEN_MODEL_V2_VERSION;
  if (isPlanningReservation || isLegacyAuthoritativeReservation) {
    const authoritativeUniverse = isPlanningReservation ? contractAFinalUniverse : eventCandidates;
    const finalForEvent = isPlanningReservation
      ? authoritativeUniverse.find((c) =>
          c.match_family_key === reservation.match_family_key ||
          (Boolean(reservation.event_slug) && c.event_slug === reservation.event_slug)
        ) ?? null
      : null;
    const authConditionId = isPlanningReservation ? finalForEvent?.condition_id : reservationDiag.authoritative_condition_id;
    const authTokenId = isPlanningReservation ? finalForEvent?.token_id : reservationDiag.authoritative_token_id;
    const authSide = isPlanningReservation ? finalForEvent?.side : reservationDiag.authoritative_side;
    const identityComplete =
      typeof authConditionId === "string" &&
      authConditionId.trim() !== "" &&
      typeof authTokenId === "string" &&
      authTokenId.trim() !== "" &&
      typeof authSide === "string" &&
      authSide.trim() !== "";

    const authoritativeCandidate = isPlanningReservation
      ? finalForEvent
      : identityComplete
      ? eventCandidates.find(
          (c) => c.condition_id === authConditionId && c.token_id === authTokenId && c.side === authSide
        ) ?? null
      : null;

    const executableCheck = authoritativeCandidate ? isExecutableMarket(authoritativeCandidate) : null;

    if (!identityComplete || authoritativeCandidate === null || !executableCheck!.executable) {
      const failReason = !identityComplete
        ? "CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE"
        : authoritativeCandidate === null
          ? "CONTRACT_A_AUTHORITATIVE_MARKET_NOT_FOUND"
          : `CONTRACT_A_AUTHORITATIVE_MARKET_NOT_EXECUTABLE: ${executableCheck!.rejectReason}`;
      console.log(
        `[contur3-rebalance] CONTRACT_A_FAIL_CLOSED selector=${reservationSelectorId} ` +
          `event=${reservation.match_family_key} observation=${reservationDiag.authoritative_observation_id ?? "unknown"} reason=${failReason}`
      );
      return {
        outcome: "SKIPPED",
        reason: failReason,
        queueRow: null,
        blockedCandidates: eventCandidates.slice(0, 5).map(buildBlockedCandidateDiag),
      };
    }

    const authoritativeReservation = isPlanningReservation
      ? { ...reservation, diagnostics: { ...reservationDiag, selector_id: FROZEN_MODEL_V2_VERSION, contract_a_stage: "FINAL_AUTHORITATIVE", authoritative_condition_id: authConditionId, authoritative_token_id: authTokenId, authoritative_side: authSide, authoritative_observation_id: authoritativeCandidate.diagnostics.authoritative_observation_id, authoritative_event_key: authoritativeCandidate.diagnostics.authoritative_event_key } }
      : reservation;
    const row = buildQueueRow(authoritativeReservation, authoritativeCandidate, rebalanceRunId);
    return {
      outcome: "QUEUED",
      reason: row.selection_reason ?? "CONTRACT_A_AUTHORITATIVE_MARKET",
      queueRow: row,
    };
  }

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
    return {
      outcome: "SKIPPED",
      reason: skipReason,
      queueRow: null,
      blockedCandidates: eventCandidates.slice(0, 5).map(buildBlockedCandidateDiag),
    };
  }

  const best = eventMarkets[0];
  const row = buildQueueRow(reservation, best, rebalanceRunId);
  return {
    outcome: "QUEUED",
    reason: row.selection_reason ?? "REBALANCE_SINGLE_BEST_MARKET",
    queueRow: row,
  };
}

/**
 * Run the per-event rebalance. write=false → pure dry-run (no DB writes).
 * Loads the candidate universe once and selects one market per due reservation.
 */
export async function runEventRebalance(
  nowMs: number,
  opts: { write?: boolean } = {},
  deps: {
    repo?: RebalanceRepoPort;
    fetchCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
    fetchContractAFinalCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
  } = {}
): Promise<RebalanceRunResult> {
  const write = opts.write === true;
  const rebalanceRunId = buildRebalanceRunId(nowMs);
  const repo = deps.repo ?? createSupabaseRebalanceRepoPort();
  const fetchCandidates =
    deps.fetchCandidates ??
    (async () => {
      const { buildFireModelCandidates } = await import("./buildFireModelCandidates");
      return buildFireModelCandidates(PLAN_POOL, "all", true);
    });
  const fetchContractAFinalCandidates =
    deps.fetchContractAFinalCandidates ??
    (async () => {
      const { buildFireModelCandidates } = await import("./buildFireModelCandidates");
      return buildFireModelCandidates(PLAN_POOL, "all", true, undefined, "CONTRACT_A_V1");
    });

  // Due reservations: active status + start within the rebalance window.
  const all = await repo.loadActiveReservations();
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
  const reservation_classification = classifyReservations(all, nowMs);
  const next_due_reservations: NextDueReservation[] = upcoming.slice(0, 10).map((r) => {
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
      await repo.markReservationsExpired(expiredIds);
    }
  }

  if (due.length === 0) {
    return {
      rebalance_run_id: rebalanceRunId,
      active_reservations_count: all.length,
      due_count: 0,
      queued_count: 0,
      skipped_count: 0,
      already_queued_count: 0,
      expired_count: expired.length,
      future_valid_reservations_count: upcoming.length,
      fail_due_reservations_not_queued: false,
      outcomes,
      reservation_classification,
      wrote: write,
      next_due_reservations,
      next_check_after_seconds,
    };
  }

  // Existing READY/SENT queue rows so we never double-queue a reservation.
  const alreadyQueued = await repo.loadQueuedReservationIds();

  // Load current markets once; Contract A planning reservations additionally
  // resolve their final authoritative decision at the due-event boundary.
  const { candidates: universe } = await fetchCandidates();
  const hasContractAPlanning = due.some((r) => r.diagnostics?.contract_a_stage === "PLANNING");
  const contractAFinalUniverse = hasContractAPlanning ? (await fetchContractAFinalCandidates()).candidates : [];
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

    const selection = selectQueueRowForDueReservation(reservation, marketsByKey, contractAFinalUniverse, rebalanceRunId);

    if (selection.outcome === "SKIPPED") {
      skipped += 1;
      if (write && reservation.id) {
        await repo.markReservationSkipped(reservation.id, selection.reason);
      }
      outcomes.push({
        match_family_key: reservation.match_family_key,
        reservation_id: reservation.id ?? null,
        result: "SKIPPED",
        reason: selection.reason,
        blocked_candidates: selection.blockedCandidates,
      });
      continue;
    }

    const row = selection.queueRow!;
    if (write) {
      try {
        await repo.insertQueueRow(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`queue insert failed (${reservation.match_family_key}): ${msg}`);
      }
      if (reservation.id) {
        await repo.markReservationQueued(reservation.id, row.selection_reason ?? "");
      }
    }

    queued += 1;
    outcomes.push({
      match_family_key: reservation.match_family_key,
      reservation_id: reservation.id ?? null,
      result: "QUEUED",
      reason: selection.reason,
      queue_row: row,
    });
  }

  // Hard failure: reservations were due but none reached the queue and none were
  // already queued. SKIPPED rows carry an exact reason; zero queued+already with a
  // positive due count means the queue stage silently produced nothing.
  const fail_due_reservations_not_queued = due.length > 0 && queued === 0 && already === 0;

  return {
    rebalance_run_id: rebalanceRunId,
    active_reservations_count: all.length,
    due_count: due.length,
    queued_count: queued,
    skipped_count: skipped,
    already_queued_count: already,
    expired_count: expired.length,
    future_valid_reservations_count: upcoming.length,
    fail_due_reservations_not_queued,
    outcomes,
    reservation_classification,
    wrote: write,
    next_due_reservations,
    next_check_after_seconds,
  };
}

// ── Controlled one-shot live-intent seam ────────────────────────────────────
//
// Adds exactly one narrow, fail-closed mode for creating a single controlled
// production READY queue row for a fixed, pre-authorized founder test id.
// It reuses the same due-reservation loading and authoritative-candidate
// selection (selectQueueRowForDueReservation / buildQueueRow) as the normal
// scheduled rebalance above -- it can never accept a caller-supplied market
// identity, stake, or idempotency key, and it writes at most one row.

export const CONTROLLED_LIVE_TEST_ID = "founder-live-order-20260721-001" as const;
export const CONTROLLED_LIVE_STAKE_CAP_USD = 1 as const;
export const CONTROLLED_LIVE_MAX_QUEUE_WRITES = 1 as const;
export const CONTROLLED_LIVE_PROVENANCE = "CONTROLLED_ONE_DOLLAR_TEST_V1" as const;

export type ControlledLiveIntentValidation = { ok: true } | { ok: false; reason: string };

/**
 * Rejects anything other than the exact fixed controlled test id. There is no
 * generic arbitrary-test API here -- only this one pre-authorized value is
 * ever accepted.
 */
export function validateControlledLiveIntentRequest(requestedTestId: unknown): ControlledLiveIntentValidation {
  if (requestedTestId !== CONTROLLED_LIVE_TEST_ID) {
    return { ok: false, reason: "CONTROLLED_LIVE_INTENT_ID_MISMATCH" };
  }
  return { ok: true };
}

/**
 * Applies the controlled-mode overrides to an already-selected queue row:
 * stake is capped (never raised above CONTROLLED_LIVE_STAKE_CAP_USD),
 * rebalance_run_id carries the fixed test id as a durable correlation
 * marker, and diagnostics gets an additive provenance flag. condition_id,
 * token_id, side, and idempotency_key are never touched.
 */
export function applyControlledLiveIntentOverrides(row: EventExecutionQueueRow): EventExecutionQueueRow {
  return {
    ...row,
    rebalance_run_id: CONTROLLED_LIVE_TEST_ID,
    stake_usd: Math.min(row.stake_usd, CONTROLLED_LIVE_STAKE_CAP_USD),
    diagnostics: {
      ...row.diagnostics,
      controlled_live_intent: true,
      controlled_test_id: CONTROLLED_LIVE_TEST_ID,
      controlled_provenance: CONTROLLED_LIVE_PROVENANCE,
    },
  };
}

export interface ControlledLiveIntentResult {
  kind:
    | "CREATED"
    | "ALREADY_EXISTS"
    | "NO_SAFE_CANDIDATE"
    | "BLOCKED_INVALID_REQUEST"
    | "BLOCKED_VERIFICATION_FAILED";
  reason: string;
  wrote: boolean;
  queue_row?: EventExecutionQueueRow;
  matching_row_count?: number;
}

/**
 * Controlled one-shot live-intent seam. write=false → pure preview, zero writes.
 */
export async function runControlledLiveIntent(
  nowMs: number,
  requestedTestId: unknown,
  opts: { write?: boolean } = {},
  deps: {
    repo?: RebalanceRepoPort;
    fetchCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
    fetchContractAFinalCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
  } = {}
): Promise<ControlledLiveIntentResult> {
  const validation = validateControlledLiveIntentRequest(requestedTestId);
  if (!validation.ok) {
    return { kind: "BLOCKED_INVALID_REQUEST", reason: validation.reason, wrote: false };
  }

  const write = opts.write === true;
  const repo = deps.repo ?? createSupabaseRebalanceRepoPort();
  const fetchCandidates =
    deps.fetchCandidates ??
    (async () => {
      const { buildFireModelCandidates } = await import("./buildFireModelCandidates");
      return buildFireModelCandidates(PLAN_POOL, "all", true);
    });
  const fetchContractAFinalCandidates =
    deps.fetchContractAFinalCandidates ??
    (async () => {
      const { buildFireModelCandidates } = await import("./buildFireModelCandidates");
      return buildFireModelCandidates(PLAN_POOL, "all", true, undefined, "CONTRACT_A_V1");
    });

  if (!repo.findQueueRowsByRebalanceRunId) {
    throw new Error(
      "RebalanceRepoPort.findQueueRowsByRebalanceRunId is required for controlled live-intent duplicate-safety checks"
    );
  }

  const existing = await repo.findQueueRowsByRebalanceRunId(CONTROLLED_LIVE_TEST_ID);
  if (existing.length > 0) {
    return {
      kind: "ALREADY_EXISTS",
      reason: "CONTROLLED_LIVE_INTENT_ROW_ALREADY_EXISTS",
      wrote: false,
      queue_row: existing[0],
      matching_row_count: existing.length,
    };
  }

  const all = await repo.loadActiveReservations();
  const due = all
    .filter((r) => {
      const startMs = Date.parse(r.game_start_iso);
      return Number.isFinite(startMs) && isDueForRebalance(startMs, nowMs);
    })
    .sort((a, b) => Date.parse(a.game_start_iso) - Date.parse(b.game_start_iso));

  if (due.length === 0) {
    return { kind: "NO_SAFE_CANDIDATE", reason: "NO_DUE_RESERVATION", wrote: false };
  }

  const alreadyQueued = await repo.loadQueuedReservationIds();
  const { candidates: universe } = await fetchCandidates();
  const hasContractAPlanning = due.some((r) => r.diagnostics?.contract_a_stage === "PLANNING");
  const contractAFinalUniverse = hasContractAPlanning ? (await fetchContractAFinalCandidates()).candidates : [];
  const marketsByKey = new Map<string, FireModelCandidate[]>();
  for (const c of universe) {
    const arr = marketsByKey.get(c.match_family_key) ?? [];
    arr.push(c);
    marketsByKey.set(c.match_family_key, arr);
  }

  const rebalanceRunId = buildRebalanceRunId(nowMs);

  for (const reservation of due) {
    if (reservation.id && alreadyQueued.has(reservation.id)) continue;
    const selection = selectQueueRowForDueReservation(reservation, marketsByKey, contractAFinalUniverse, rebalanceRunId);
    if (selection.outcome !== "QUEUED" || !selection.queueRow) continue;

    const controlledRow = applyControlledLiveIntentOverrides(selection.queueRow);

    if (!write) {
      return { kind: "CREATED", reason: "DRY_RUN_PREVIEW", wrote: false, queue_row: controlledRow };
    }

    try {
      await repo.insertQueueRow(controlledRow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "NO_SAFE_CANDIDATE", reason: `CONTROLLED_INSERT_FAILED: ${msg}`, wrote: false };
    }
    if (reservation.id) {
      await repo.markReservationQueued(reservation.id, controlledRow.selection_reason ?? "");
    }

    // Post-write recheck: this is not a global transactional guarantee -- it
    // is a best-effort verification against the same repo read path used for
    // the pre-write duplicate check. Real cross-request exactly-once safety
    // for a given reservation/market still comes from the existing DB unique
    // constraints on event_execution_queue (condition_id, token_id, side,
    // plan_run_id) and (reservation_id, selection_rank).
    const verify = await repo.findQueueRowsByRebalanceRunId(CONTROLLED_LIVE_TEST_ID);
    if (verify.length !== CONTROLLED_LIVE_MAX_QUEUE_WRITES) {
      return {
        kind: "BLOCKED_VERIFICATION_FAILED",
        reason: `CONTROLLED_ROW_COUNT_MISMATCH: expected=${CONTROLLED_LIVE_MAX_QUEUE_WRITES} actual=${verify.length}`,
        wrote: true,
        matching_row_count: verify.length,
      };
    }

    return {
      kind: "CREATED",
      reason: controlledRow.selection_reason ?? "CONTROLLED_LIVE_INTENT_QUEUED",
      wrote: true,
      queue_row: verify[0],
      matching_row_count: verify.length,
    };
  }

  return { kind: "NO_SAFE_CANDIDATE", reason: "NO_EXECUTABLE_CANDIDATE_FOR_ANY_DUE_RESERVATION", wrote: false };
}

/**
 * Full rebalance cron orchestration: run the rebalance and record job_runs
 * evidence for write-mode invocations (success and failure). Dry-run
 * (write=false) invocations record no job evidence — they are a preview,
 * not an execution, and perform zero DB writes of any kind, including
 * job_runs. This is the entry point app/api/cron/event-rebalance/route.ts calls.
 */
export async function runEventRebalanceWithEvidence(
  nowMs: number,
  opts: { write?: boolean } = {},
  deps: {
    repo?: RebalanceRepoPort;
    fetchCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
    jobEvidence?: SchedulerJobEvidencePort;
  } = {}
): Promise<RebalanceRunResult> {
  const write = opts.write === true;
  const jobEvidence = deps.jobEvidence ?? createSupabaseSchedulerJobEvidencePort();
  const startedAt = new Date().toISOString();
  try {
    const result = await runEventRebalance(nowMs, opts, {
      repo: deps.repo,
      fetchCandidates: deps.fetchCandidates,
    });
    if (write) {
      const finishedAt = new Date().toISOString();
      await jobEvidence.writeJobRun({
        source: "event-rebalance",
        formulaVersion: "rebalance-v1",
        startedAt,
        finishedAt,
        status:
          result.due_count === 0 ? "empty" : result.fail_due_reservations_not_queued ? "error" : "success",
        generatedCount: result.queued_count,
        rejectedCount: result.skipped_count,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        errorMessage: result.fail_due_reservations_not_queued ? "DUE_RESERVATIONS_NOT_QUEUED" : undefined,
        diagnostics: {
          rebalance_run_id: result.rebalance_run_id,
          due_count: result.due_count,
          already_queued_count: result.already_queued_count,
          expired_count: result.expired_count,
        },
      });
    }
    return result;
  } catch (err) {
    if (write) {
      const finishedAt = new Date().toISOString();
      const msg = err instanceof Error ? err.message : "Unknown error";
      await jobEvidence.writeJobRun({
        source: "event-rebalance",
        formulaVersion: "rebalance-v1",
        startedAt,
        finishedAt,
        status: "error",
        generatedCount: 0,
        rejectedCount: 0,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        errorMessage: sanitizeSchedulerErrorMessage(msg),
      });
    }
    throw err;
  }
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
      active_reservations_count: result.active_reservations_count,
      due_count: result.due_count,
      queued_count: result.queued_count,
      skipped_count: result.skipped_count,
      already_queued_count: result.already_queued_count,
      expired_count: result.expired_count,
      future_valid_reservations_count: result.future_valid_reservations_count,
      fail_due_reservations_not_queued: result.fail_due_reservations_not_queued,
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
      next_due_reservations: result.next_due_reservations.slice(0, 10),
      next_check_after_seconds: result.next_check_after_seconds,
      // Full per-active-reservation reason table — answers "why due_count=0".
      reservation_classification: result.reservation_classification,
    };

    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    return { path: filePath, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[persistRebalanceDiagnostics] Diagnostic write failed (non-fatal):", msg);
    return { path: null, error: msg };
  }
}
