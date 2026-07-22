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

const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && UUID_LIKE_RE.test(value);
}

/**
 * Resolves the safe generated_signal_pairs.id to stamp into
 * diagnostics.source_signal_id for the live-priority resolver. Prefers the
 * candidate's explicit generated_signal_pair_id (always the real row UUID
 * when populated). Falls back to signal_id ONLY if it happens to be
 * UUID-shaped -- signal_id is condition_id::token_id on the Contract A V1
 * path, never a row id, and must never be written into
 * diagnostics.source_signal_id. Returns null rather than a non-UUID value.
 */
export function resolveQueueSourceSignalId(candidate: Pick<FireModelCandidate, "generated_signal_pair_id" | "signal_id">): string | null {
  if (isUuidLike(candidate.generated_signal_pair_id)) return candidate.generated_signal_pair_id as string;
  if (isUuidLike(candidate.signal_id)) return candidate.signal_id;
  return null;
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
      source_signal_id: resolveQueueSourceSignalId(best),
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
  // Phase 1 canonical safety cap (opts.maxQueueWrites on the default
  // canonical branch only -- never applies to founderBattleBatch or
  // controlledLiveIntent, which are separate functions entirely).
  // max_queue_writes is null when no cap was supplied to this run.
  max_queue_writes: number | null;
  // Queue rows this run WOULD create, computed by the pure selection pass
  // before any DB write -- equal to queued_count whenever the cap did not
  // block the run (including all dry-run calls, which never write anyway).
  planned_queue_writes: number;
  // True exactly when max_queue_writes was set and planned_queue_writes
  // exceeded it. In write mode, a true value here means zero queue rows
  // were written this run (fail-closed, no partial writes).
  blocked_by_max_queue_writes: boolean;
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
 * Thrown by insertQueueRow when the database rejects the write with a
 * PostgreSQL unique_violation (23505) -- e.g. the controlled-live-intent
 * partial unique index on rebalance_run_id. Callers that need to react to a
 * real database-enforced conflict (as opposed to any other insert failure)
 * check `err instanceof QueueInsertConflictError` or `.code === "23505"`.
 */
export class QueueInsertConflictError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "QueueInsertConflictError";
    this.code = code;
  }
}

function isPostgresUniqueViolation(err: unknown): err is { code: string; message?: string } {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
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
      if (error) {
        // Preserve the PostgreSQL error code (23505 = unique_violation) so
        // callers -- specifically runControlledLiveIntent's conflict
        // recovery -- can distinguish a real database-enforced duplicate
        // rejection from any other insert failure. Normal-mode callers only
        // ever read .message, so this is purely additive.
        if ((error as { code?: string }).code === "23505") {
          throw new QueueInsertConflictError(`queue insert failed: ${error.message}`, "23505");
        }
        throw new Error(`queue insert failed: ${error.message}`);
      }
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
  opts: { write?: boolean; maxQueueWrites?: number | null } = {},
  deps: {
    repo?: RebalanceRepoPort;
    fetchCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
    fetchContractAFinalCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
  } = {}
): Promise<RebalanceRunResult> {
  const write = opts.write === true;
  const maxQueueWrites = typeof opts.maxQueueWrites === "number" ? opts.maxQueueWrites : null;
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
      max_queue_writes: maxQueueWrites,
      planned_queue_writes: 0,
      blocked_by_max_queue_writes: false,
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

  // Plan phase (pure -- no DB writes): resolve every due reservation's
  // outcome via the same selectQueueRowForDueReservation used previously,
  // so the total number of queue rows this run WOULD create is known
  // before any write happens. This is what makes maxQueueWrites
  // enforceable fail-closed instead of only after partial writes.
  type PlannedAction =
    | { kind: "ALREADY_QUEUED"; reservation: NightEventReservationRow }
    | { kind: "SKIPPED"; reservation: NightEventReservationRow; reason: string; blockedCandidates?: BlockedCandidateDiag[] }
    | { kind: "QUEUE"; reservation: NightEventReservationRow; row: EventExecutionQueueRow; reason: string };

  const plannedActions: PlannedAction[] = [];
  for (const reservation of due) {
    if (reservation.id && alreadyQueued.has(reservation.id)) {
      plannedActions.push({ kind: "ALREADY_QUEUED", reservation });
      continue;
    }
    const selection = selectQueueRowForDueReservation(reservation, marketsByKey, contractAFinalUniverse, rebalanceRunId);
    if (selection.outcome === "SKIPPED") {
      plannedActions.push({ kind: "SKIPPED", reservation, reason: selection.reason, blockedCandidates: selection.blockedCandidates });
    } else {
      plannedActions.push({ kind: "QUEUE", reservation, row: selection.queueRow!, reason: selection.reason });
    }
  }

  const plannedQueueWrites = plannedActions.filter((a) => a.kind === "QUEUE").length;
  const blockedByMaxQueueWrites = maxQueueWrites !== null && plannedQueueWrites > maxQueueWrites;

  if (write && blockedByMaxQueueWrites) {
    // Fail-closed: zero queue rows written, zero skip/queued reservation
    // marks written, this run. Never a partial write over the cap.
    return {
      rebalance_run_id: rebalanceRunId,
      active_reservations_count: all.length,
      due_count: due.length,
      queued_count: 0,
      skipped_count: 0,
      already_queued_count: 0,
      expired_count: expired.length,
      future_valid_reservations_count: upcoming.length,
      fail_due_reservations_not_queued: false,
      outcomes: [],
      reservation_classification,
      wrote: false,
      next_due_reservations,
      next_check_after_seconds,
      max_queue_writes: maxQueueWrites,
      planned_queue_writes: plannedQueueWrites,
      blocked_by_max_queue_writes: true,
    };
  }

  // Execute phase: replays the planned actions exactly (same order, same
  // conditionals) -- identical to the pre-cap single-pass loop whenever no
  // cap blocks the run.
  let queued = 0;
  let skipped = 0;
  let already = 0;

  for (const action of plannedActions) {
    if (action.kind === "ALREADY_QUEUED") {
      already += 1;
      outcomes.push({
        match_family_key: action.reservation.match_family_key,
        reservation_id: action.reservation.id ?? null,
        result: "ALREADY_QUEUED",
        reason: "READY_OR_SENT_QUEUE_ROW_EXISTS",
      });
      continue;
    }

    if (action.kind === "SKIPPED") {
      skipped += 1;
      if (write && action.reservation.id) {
        await repo.markReservationSkipped(action.reservation.id, action.reason);
      }
      outcomes.push({
        match_family_key: action.reservation.match_family_key,
        reservation_id: action.reservation.id ?? null,
        result: "SKIPPED",
        reason: action.reason,
        blocked_candidates: action.blockedCandidates,
      });
      continue;
    }

    const row = action.row;
    if (write) {
      try {
        await repo.insertQueueRow(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`queue insert failed (${action.reservation.match_family_key}): ${msg}`);
      }
      if (action.reservation.id) {
        await repo.markReservationQueued(action.reservation.id, row.selection_reason ?? "");
      }
    }

    queued += 1;
    outcomes.push({
      match_family_key: action.reservation.match_family_key,
      reservation_id: action.reservation.id ?? null,
      result: "QUEUED",
      reason: action.reason,
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
    max_queue_writes: maxQueueWrites,
    planned_queue_writes: plannedQueueWrites,
    // Only reachable here when NOT (write && blockedByMaxQueueWrites) -- so
    // a true value at this point means dry-run mode previewing a plan that
    // WOULD be blocked if run with write=true (no actual writes happened
    // either way, since write=false skips every repo call above).
    blocked_by_max_queue_writes: blockedByMaxQueueWrites,
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
      if (isPostgresUniqueViolation(err)) {
        // The database itself rejected a second controlled row (partial
        // unique index event_execution_queue_controlled_live_rebalance_run_uniq
        // on rebalance_run_id) -- this is the real exactly-one authority, not
        // just the app-level precheck. Do not try another reservation; do not
        // delete or mutate the winner. Re-read to surface it.
        const recheck = await repo.findQueueRowsByRebalanceRunId!(CONTROLLED_LIVE_TEST_ID);
        if (recheck.length === 1) {
          return {
            kind: "ALREADY_EXISTS",
            reason: "CONTROLLED_LIVE_INTENT_UNIQUE_VIOLATION_RECOVERED",
            wrote: false,
            queue_row: recheck[0],
            matching_row_count: 1,
          };
        }
        return {
          kind: "BLOCKED_VERIFICATION_FAILED",
          reason: `CONTROLLED_ROW_COUNT_MISMATCH_AFTER_CONFLICT: expected=1 actual=${recheck.length}`,
          wrote: false,
          matching_row_count: recheck.length,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "NO_SAFE_CANDIDATE", reason: `CONTROLLED_INSERT_FAILED: ${msg}`, wrote: false };
    }
    if (reservation.id) {
      await repo.markReservationQueued(reservation.id, controlledRow.selection_reason ?? "");
    }

    // Post-write recheck: an additional, non-authoritative sanity check --
    // the database's partial unique index on rebalance_run_id (see the 23505
    // handling above) is what actually enforces exactly-one across
    // concurrent/retried invocations. This recheck only guards against a
    // still-possible logic bug in this function itself.
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
  opts: { write?: boolean; maxQueueWrites?: number | null } = {},
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
        status: result.blocked_by_max_queue_writes
          ? "error"
          : result.due_count === 0
            ? "empty"
            : result.fail_due_reservations_not_queued
              ? "error"
              : "success",
        generatedCount: result.queued_count,
        rejectedCount: result.skipped_count,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        errorMessage: result.blocked_by_max_queue_writes
          ? "MAX_QUEUE_WRITES_EXCEEDED"
          : result.fail_due_reservations_not_queued
            ? "DUE_RESERVATIONS_NOT_QUEUED"
            : undefined,
        diagnostics: {
          rebalance_run_id: result.rebalance_run_id,
          due_count: result.due_count,
          already_queued_count: result.already_queued_count,
          expired_count: result.expired_count,
          max_queue_writes: result.max_queue_writes,
          planned_queue_writes: result.planned_queue_writes,
          blocked_by_max_queue_writes: result.blocked_by_max_queue_writes,
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

// ── Founder battle batch feeder ─────────────────────────────────────────────
//
// Founder-approved batch feeder: reads generated_signal_pairs directly (not
// buildFireModelCandidates/Contract A) and creates 2-4 fresh READY
// event_execution_queue rows, each capped at stake_usd=1, for Ireland's batch
// runner. This is deliberately a separate, narrower selection path from the
// scheduled rebalance -- it never touches Ireland executor code, never
// requires exactly one candidate, and fails closed unless both an explicit
// env gate and an explicit request param are set.

export const FOUNDER_BATTLE_BATCH_GATE_VALUE = "YES" as const;
export const FOUNDER_BATTLE_BATCH_DEFAULT_MAX = 4;
export const FOUNDER_BATTLE_BATCH_ABSOLUTE_MAX = 4;
// $1.00 nominal rounds to an effective marketable-BUY amount that can land
// slightly below the exchange's $1 minimum order size after price
// rounding (observed live: $0.9963, $0.9994 -- both ORDER_REJECTED). $1.10
// gives enough buffer that the effective amount never falls below $1.
export const FOUNDER_BATTLE_BATCH_STAKE_USD = 1.1 as const;
export const FOUNDER_BATTLE_BATCH_STAKE_USD_ENV_ALLOWED = ["1.1", "1.10"] as const;
export const FOUNDER_BATTLE_BATCH_RUN_ID_PREFIX = "founder-live-order-batch-";
// Price-cap execution-contract bounds: priceCap = clamp(entry_price_num + 0.10, 0.20, 0.75).
export const FOUNDER_BATTLE_BATCH_PRICE_CAP_BUFFER = 0.1;
export const FOUNDER_BATTLE_BATCH_PRICE_CAP_MIN = 0.2;
export const FOUNDER_BATTLE_BATCH_PRICE_CAP_MAX = 0.75;
// Statuses that mean "this market identity is already spoken for" -- a fresh
// batch row must never be created alongside one of these for the same
// condition_id/token_id/side, even if game_start_iso differs.
export const FOUNDER_BATTLE_BATCH_BLOCKING_STATUSES = ["READY", "CLAIMED", "SENT", "EXECUTED"] as const;

export interface RawSignalPairRow {
  id: string;
  event_slug: string | null;
  market_slug: string | null;
  condition_id: string | null;
  selected_outcome: string | null;
  selected_token_id: string | null;
  entry_price_num: number | null;
  signal_confidence_num: number | null;
  metric_formula_version: string | null;
  created_at: string;
  expires_at: string | null;
  diagnostics: Record<string, unknown> | null;
  signal_result: string | null;
  premium_signal: Record<string, unknown> | null;
  market_source: Record<string, unknown> | null;
}

// Placeholder strings observed in production that must never be preferred as
// a display title when a better human-readable source exists.
const GENERIC_BATTLE_BATCH_TITLES = new Set(["live market activity", "market activity", "live event", ""]);

function extractTitleFromJson(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const candidates = [obj.title, obj.eventTitle, obj.event_title, obj.marketTitle, obj.market_title, obj.question, obj.name];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return null;
}

/** Prose-like: long enough, not a known generic placeholder, and contains a
 * space -- distinguishes a real human-readable title from an opaque
 * kebab-case/ID-style slug (e.g. "mlb-lad-phi-2026-07-22" is never chosen as
 * a display title, even though it is technically non-generic). */
function isProseLikeTitle(text: string | null | undefined): text is string {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 5) return false;
  if (GENERIC_BATTLE_BATCH_TITLES.has(trimmed.toLowerCase())) return false;
  return / /.test(trimmed);
}

function normalizeBattleBatchDisplayTitle(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/\bvs\.(?=\s|$)/gi, "vs");
}

function normalizePhysicalEventKeyText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/\bvs\.?\b/g, "vs");
}

/** Strips a trailing market-qualifier suffix like ": O/U 8.5" or ": 1st Half O/U 0.5" -- everything from the first colon onward. */
function stripMarketSuffix(text: string): string {
  const idx = text.indexOf(":");
  return idx === -1 ? text : text.slice(0, idx);
}

/**
 * Deterministic physical-event identity key for founder battle batch dedupe
 * only (a small local helper -- deriveMatchFamilyKey in
 * buildFireModelCandidates.ts is not exported and operates on a different,
 * richer candidate pipeline; reusing it would require exporting internals of
 * an out-of-scope module for a narrower need). Priority:
 *   1. an explicit canonical key already present in diagnostics, if any
 *      upstream annotation provides one;
 *   2. the team-pair prefix (before any ": <market qualifier>" suffix) of
 *      event_slug or market_slug, when it is prose-like AND actually
 *      contains a "vs" team-pair pattern -- this is what makes
 *      "X vs Y: O/U 8.5" and "X vs Y: 1st Half O/U 0.5" collapse to the same
 *      physical event as bare "X vs Y";
 *   3. otherwise, a per-row fallback keyed on condition_id (never merged with
 *      anything else) -- a single-team/market-level title with no team-pair
 *      pattern (e.g. "Spread: Team (-2.5)") must never be guessed into
 *      sharing an event with an unrelated market.
 */
export function resolveBattleBatchPhysicalEventKey(row: RawSignalPairRow): string {
  const diag = row.diagnostics ?? {};
  const explicit =
    (typeof diag.matchFamilyKey === "string" && diag.matchFamilyKey.trim() !== "" ? diag.matchFamilyKey : null) ??
    (typeof diag.physicalEventKey === "string" && diag.physicalEventKey.trim() !== "" ? diag.physicalEventKey : null);
  if (explicit) return normalizePhysicalEventKeyText(explicit);

  for (const candidate of [row.event_slug, row.market_slug]) {
    if (!isProseLikeTitle(candidate)) continue;
    const prefix = stripMarketSuffix(candidate).trim();
    if (/\bvs\.?\b/i.test(prefix)) {
      return normalizePhysicalEventKeyText(prefix);
    }
  }

  return `condition:${row.condition_id ?? row.selected_token_id ?? "unknown"}`;
}

/**
 * Human-readable title resolution for founder battle batch rows, in priority
 * order: (1) event_slug when it is itself prose-like (some production rows
 * store a readable title there, not a kebab slug); (2) a title extracted from
 * premium_signal/market_source JSON blobs; (3) a title from diagnostics
 * (eventTitle/marketTitle); (4) market_slug, but only when it is not a known
 * generic placeholder like "Live market activity". Returns null (never the
 * generic placeholder itself) if nothing better is available.
 */
export function resolveFounderBattleBatchTitle(row: RawSignalPairRow): string | null {
  const candidates: Array<string | null | undefined> = [
    row.event_slug,
    extractTitleFromJson(row.premium_signal),
    extractTitleFromJson(row.market_source),
    typeof row.diagnostics?.eventTitle === "string" ? (row.diagnostics.eventTitle as string) : null,
    typeof row.diagnostics?.marketTitle === "string" ? (row.diagnostics.marketTitle as string) : null,
    row.market_slug,
  ];
  for (const candidate of candidates) {
    if (isProseLikeTitle(candidate)) return normalizeBattleBatchDisplayTitle(candidate);
  }
  return null;
}

export interface BattleBatchRepoPort {
  fetchSignalPairs(): Promise<RawSignalPairRow[]>;
  findBlockingQueueRowByIdentity(conditionId: string, tokenId: string, side: string): Promise<EventExecutionQueueRow[]>;
  findQueueRowByIdempotencyKey(key: string): Promise<EventExecutionQueueRow | null>;
  insertQueueRow(row: EventExecutionQueueRow): Promise<void>;
}

export function createSupabaseBattleBatchRepoPort(): BattleBatchRepoPort {
  return {
    async fetchSignalPairs() {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("generated_signal_pairs")
        .select(
          "id, event_slug, market_slug, condition_id, selected_outcome, selected_token_id, " +
          "entry_price_num, signal_confidence_num, metric_formula_version, created_at, expires_at, " +
          "diagnostics, signal_result, premium_signal, market_source"
        )
        .is("signal_result", null)
        .not("condition_id", "is", null)
        .not("selected_token_id", "is", null)
        .not("selected_outcome", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw new Error(`battle batch signal-pair fetch failed: ${error.message}`);
      return (data ?? []) as unknown as RawSignalPairRow[];
    },
    async findBlockingQueueRowByIdentity(conditionId, tokenId, side) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .select("*")
        .eq("condition_id", conditionId)
        .eq("token_id", tokenId)
        .eq("side", side)
        .in("status", FOUNDER_BATTLE_BATCH_BLOCKING_STATUSES as unknown as string[]);
      if (error) throw new Error(`battle batch identity-lookup failed: ${error.message}`);
      return (data ?? []) as unknown as EventExecutionQueueRow[];
    },
    async findQueueRowByIdempotencyKey(key) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .select("*")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (error) throw new Error(`battle batch idempotency-lookup failed: ${error.message}`);
      return (data as EventExecutionQueueRow | null) ?? null;
    },
    async insertQueueRow(row) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { error } = await supabaseAdmin.from("event_execution_queue").insert(row);
      if (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new QueueInsertConflictError(`battle batch queue insert failed: ${error.message}`, "23505");
        }
        throw new Error(`battle batch queue insert failed: ${error.message}`);
      }
    },
  };
}

export type FounderBattleBatchGateResult = { ok: true; max: number } | { ok: false; reason: string };

/**
 * Explicit founder-approved gate, fail closed otherwise. Requires
 * FOUNDER_BATTLE_BATCH_MODE=YES exactly. If FOUNDER_BATTLE_BATCH_STAKE_USD is
 * set, it must be exactly "1.1" or "1.10" (the fixed safe stake) -- any other
 * value, including anything larger, is treated as a misconfiguration and
 * blocked. The stake is never configurable above FOUNDER_BATTLE_BATCH_STAKE_USD.
 */
export function validateFounderBattleBatchGate(env: Record<string, string | undefined>): FounderBattleBatchGateResult {
  if (env.FOUNDER_BATTLE_BATCH_MODE !== FOUNDER_BATTLE_BATCH_GATE_VALUE) {
    return { ok: false, reason: "FOUNDER_BATTLE_BATCH_GATE_NOT_ENABLED" };
  }
  if (
    env.FOUNDER_BATTLE_BATCH_STAKE_USD !== undefined &&
    !(FOUNDER_BATTLE_BATCH_STAKE_USD_ENV_ALLOWED as readonly string[]).includes(env.FOUNDER_BATTLE_BATCH_STAKE_USD)
  ) {
    return { ok: false, reason: "FOUNDER_BATTLE_BATCH_STAKE_OVERRIDE_NOT_ALLOWED" };
  }
  const rawMax = parseInt(env.FOUNDER_BATTLE_BATCH_MAX ?? "", 10);
  const max =
    Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(rawMax, FOUNDER_BATTLE_BATCH_ABSOLUTE_MAX)
      : FOUNDER_BATTLE_BATCH_DEFAULT_MAX;
  return { ok: true, max };
}

function resolveBattleBatchGameStartIso(row: RawSignalPairRow): string | null {
  const diag = row.diagnostics ?? {};
  const fromDiag = typeof diag.gameStartIso === "string" ? diag.gameStartIso : null;
  if (fromDiag) return fromDiag;
  return typeof row.expires_at === "string" ? row.expires_at : null;
}

export interface BattleBatchCandidate {
  row: RawSignalPairRow;
  gameStartIso: string;
  conditionId: string;
  tokenId: string;
  side: string;
  entryPrice: number;
}

export interface BattleBatchExclusion {
  order_key: string | null;
  reason: string;
}

export interface BattleBatchSelectionResult {
  candidates: BattleBatchCandidate[];
  excluded: BattleBatchExclusion[];
}

/**
 * Pure selection (no DB I/O): filter, dedupe by (condition_id,
 * selected_token_id, selected_outcome), rank, and cap at max. Never requires
 * exactly one candidate -- returns however many (0 to max) survive. A missing
 * or non-finite entry_price_num is tracked as an explicit exclusion reason
 * (MISSING_ENTRY_PRICE_FOR_PRICE_CAP) since no safe price_cap can be derived
 * without a source price -- never silently defaulted to the price-cap ceiling.
 */
export function selectFounderBattleBatchCandidates(
  rows: RawSignalPairRow[],
  nowMs: number,
  max: number
): BattleBatchSelectionResult {
  const MIN_LEAD_MS = 10 * 60_000;
  const MAX_LEAD_MS = 14 * 60 * 60_000;

  const excluded: BattleBatchExclusion[] = [];
  const filtered: BattleBatchCandidate[] = [];
  for (const row of rows) {
    if (row.signal_result !== null && row.signal_result !== undefined) continue;
    if (!row.condition_id || !row.selected_token_id || !row.selected_outcome) continue;
    if (row.metric_formula_version != null && row.metric_formula_version !== "v2-lite-growth-safe") continue;
    if (typeof row.signal_confidence_num !== "number" || row.signal_confidence_num < 60) continue;

    if (typeof row.entry_price_num !== "number" || !Number.isFinite(row.entry_price_num)) {
      excluded.push({
        order_key: `${row.condition_id}:${row.selected_token_id}:${row.selected_outcome}`,
        reason: "MISSING_ENTRY_PRICE_FOR_PRICE_CAP",
      });
      continue;
    }
    if (row.entry_price_num < 0.2 || row.entry_price_num > 0.75) continue;

    const gameStartIso = resolveBattleBatchGameStartIso(row);
    if (!gameStartIso) continue;
    const gameStartMs = Date.parse(gameStartIso);
    if (!Number.isFinite(gameStartMs)) continue;
    const leadMs = gameStartMs - nowMs;
    if (leadMs < MIN_LEAD_MS || leadMs > MAX_LEAD_MS) continue;

    filtered.push({
      row,
      gameStartIso,
      conditionId: row.condition_id,
      tokenId: row.selected_token_id,
      side: row.selected_outcome,
      entryPrice: row.entry_price_num,
    });
  }

  const seen = new Set<string>();
  const deduped: BattleBatchCandidate[] = [];
  for (const c of filtered) {
    const key = `${c.conditionId}:${c.tokenId}:${c.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  deduped.sort((a, b) => {
    const startDiff = Date.parse(a.gameStartIso) - Date.parse(b.gameStartIso);
    if (startDiff !== 0) return startDiff;
    const confDiff = (b.row.signal_confidence_num ?? 0) - (a.row.signal_confidence_num ?? 0);
    if (confDiff !== 0) return confDiff;
    return Date.parse(b.row.created_at) - Date.parse(a.row.created_at);
  });

  // Physical-event dedupe: one row per unique physical event, ever -- keep
  // only the highest-ranked candidate (the list is already sorted above, so
  // the first occurrence of a given physical_event_key wins) and report every
  // lower-ranked same-event candidate as an explicit skip, never silently.
  const seenPhysicalEventKeys = new Set<string>();
  const physicalEventDeduped: BattleBatchCandidate[] = [];
  for (const c of deduped) {
    const physicalEventKey = resolveBattleBatchPhysicalEventKey(c.row);
    if (seenPhysicalEventKeys.has(physicalEventKey)) {
      excluded.push({
        order_key: `${c.conditionId}:${c.tokenId}:${c.side}`,
        reason: "SKIPPED_DUPLICATE_PHYSICAL_EVENT",
      });
      continue;
    }
    seenPhysicalEventKeys.add(physicalEventKey);
    physicalEventDeduped.push(c);
  }

  return { candidates: physicalEventDeduped.slice(0, max), excluded };
}

/** Deterministic price ceiling Ireland must never pay above: entry_price_num + buffer, clamped to [0.20, 0.75]. */
export function computeFounderBattleBatchPriceCap(entryPrice: number): number {
  return Math.min(
    FOUNDER_BATTLE_BATCH_PRICE_CAP_MAX,
    Math.max(FOUNDER_BATTLE_BATCH_PRICE_CAP_MIN, entryPrice + FOUNDER_BATTLE_BATCH_PRICE_CAP_BUFFER)
  );
}

/**
 * Pure row builder (no DB I/O). stake_usd is always the fixed constant, never
 * derived from the candidate. idempotency_key is salted with the batch run
 * timestamp (batchRunId) -- unlike a purely condition/token/side-derived key,
 * this means a later retry (a new invocation, e.g. after a prior row was
 * rejected by the exchange) computes a NEW idempotency_key rather than being blocked
 * by the earlier attempt's key. order_key remains condition:token:side only,
 * and duplicate protection against a still-active identity (READY/CLAIMED/
 * SENT/EXECUTED) is enforced separately by the orchestrator, not by this key.
 */
export function buildFounderBattleBatchQueueRow(
  candidate: BattleBatchCandidate,
  nowMs: number,
  batchIndex: number,
  batchRunId: string
): EventExecutionQueueRow {
  const { row, gameStartIso, conditionId, tokenId, side, entryPrice } = candidate;
  const gameStartMs = Date.parse(gameStartIso);
  const nowIso = new Date(nowMs).toISOString();
  const latestByGameStart = gameStartMs - 3 * 60_000;
  const latestByCap = nowMs + 90 * 60_000;
  const latestEntryMs = Math.min(latestByGameStart, latestByCap);
  const orderKey = `${conditionId}:${tokenId}:${side}`;
  const idempotencyKey = createHash("sha256").update(`${orderKey}:${batchRunId}`).digest("hex").slice(0, 32);
  const rebalanceRunId = `${FOUNDER_BATTLE_BATCH_RUN_ID_PREFIX}${batchRunId}-${batchIndex}`;
  const priceCap = computeFounderBattleBatchPriceCap(entryPrice);
  const displayTitle = resolveFounderBattleBatchTitle(row);

  return {
    reservation_id: null,
    plan_run_id: `founder-battle-batch:${new Date(nowMs).toISOString().slice(0, 10)}`,
    rebalance_run_id: rebalanceRunId,
    match_family_key: row.event_slug ?? `battle:${conditionId}`,
    event_title: displayTitle,
    event_slug: row.event_slug ?? null,
    sport: null,
    league: null,
    game_start_iso: gameStartIso,
    condition_id: conditionId,
    token_id: tokenId,
    side,
    market_slug: row.market_slug ?? null,
    market_title: displayTitle,
    market_family: null,
    score: row.signal_confidence_num ?? null,
    coverage: null,
    tier: "TIER1",
    stake_usd: FOUNDER_BATTLE_BATCH_STAKE_USD,
    preferred_entry_iso: nowIso,
    latest_entry_iso: new Date(latestEntryMs).toISOString(),
    selection_rank: batchIndex + 1,
    selection_reason: `FOUNDER_BATTLE_BATCH: rank=${batchIndex + 1} confidence=${row.signal_confidence_num} entry_price=${entryPrice}`,
    status: "READY",
    order_key: orderKey,
    idempotency_key: idempotencyKey,
    diagnostics: {
      founder_battle_batch: true,
      max_stake_usd: FOUNDER_BATTLE_BATCH_STAKE_USD,
      source_signal_id: row.id,
      gameStartIso,
      price_cap: priceCap,
      submitted_price: entryPrice,
      max_entry_price: priceCap,
    },
  };
}

export interface FounderBattleBatchResult {
  kind: "CREATED" | "BLOCKED_GATE_DISABLED" | "NO_SAFE_CANDIDATES";
  reason: string;
  wrote_count: number;
  skipped_count: number;
  created_rows: EventExecutionQueueRow[];
  skipped_reasons: Array<{ order_key: string; reason: string }>;
}

/**
 * Founder battle batch orchestration. write=false -> pure preview, zero writes.
 * Never requires exactly one candidate; creates 0-max rows depending on how
 * many survive selection and duplicate-protection.
 */
export async function runFounderBattleBatch(
  nowMs: number,
  env: Record<string, string | undefined>,
  opts: { write?: boolean } = {},
  deps: { repo?: BattleBatchRepoPort } = {}
): Promise<FounderBattleBatchResult> {
  const gate = validateFounderBattleBatchGate(env);
  if (!gate.ok) {
    return { kind: "BLOCKED_GATE_DISABLED", reason: gate.reason, wrote_count: 0, skipped_count: 0, created_rows: [], skipped_reasons: [] };
  }

  const write = opts.write === true;
  const repo = deps.repo ?? createSupabaseBattleBatchRepoPort();
  const rows = await repo.fetchSignalPairs();
  const { candidates, excluded } = selectFounderBattleBatchCandidates(rows, nowMs, gate.max);

  const skipped: Array<{ order_key: string; reason: string }> = excluded.map((e) => ({
    order_key: e.order_key ?? "",
    reason: e.reason,
  }));

  if (candidates.length === 0) {
    return {
      kind: "NO_SAFE_CANDIDATES",
      reason: "NO_ELIGIBLE_SIGNAL_PAIRS",
      wrote_count: 0,
      skipped_count: skipped.length,
      created_rows: [],
      skipped_reasons: skipped,
    };
  }

  // One batch run id shared by every row created in this invocation -- salts
  // idempotency_key so a later retry invocation (new nowMs) always computes a
  // fresh key, never blocked by an earlier attempt's (e.g. rejected) row.
  const batchRunId = new Date(nowMs).toISOString();
  const created: EventExecutionQueueRow[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const row = buildFounderBattleBatchQueueRow(candidate, nowMs, i, batchRunId);

    // Duplicate protection 1: same market identity already queued/executing.
    const blockingExisting = await repo.findBlockingQueueRowByIdentity(candidate.conditionId, candidate.tokenId, candidate.side);
    if (blockingExisting.length > 0) {
      skipped.push({ order_key: row.order_key ?? "", reason: "IDENTITY_ALREADY_QUEUED" });
      continue;
    }

    // Duplicate protection 2: deterministic idempotency_key already exists (any status).
    const existingByIdempotency = await repo.findQueueRowByIdempotencyKey(row.idempotency_key ?? "");
    if (existingByIdempotency) {
      skipped.push({ order_key: row.order_key ?? "", reason: "IDEMPOTENCY_KEY_ALREADY_EXISTS" });
      continue;
    }

    if (!write) {
      created.push(row);
      continue;
    }

    try {
      await repo.insertQueueRow(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ order_key: row.order_key ?? "", reason: `INSERT_FAILED: ${msg}` });
      continue;
    }
    created.push(row);
  }

  return {
    kind: "CREATED",
    reason: write ? "BATCH_WRITTEN" : "DRY_RUN_PREVIEW",
    wrote_count: write ? created.length : 0,
    skipped_count: skipped.length,
    created_rows: created,
    skipped_reasons: skipped,
  };
}
