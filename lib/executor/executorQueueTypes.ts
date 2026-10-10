// lib/executor/executorQueueTypes.ts
//
// Shared types for the Contur3 canonical night pipeline:
//   night_event_reservations  → event-level frozen plan (written ~17:00 Minsk)
//   event_execution_queue      → per-event single-market selection (written at rebalance)
//
// Pure types only — no DB client, no side effects.

import type { QueueStatus } from "./executorCallbackContract";
import { FOUNDER_TOTALS_OVER_LIVE_OFF, isFounderLiveOffTotalsOver, isObservationOnlyMoneyFamily } from "./liveMoneyFamilyAuthority";
export type { QueueStatus };

export type ReservationStatus =
  | "RESERVED"
  | "REBALANCE_PENDING"
  | "QUEUED"
  | "SKIPPED"
  | "EXPIRED"
  | "CANCELLED";

// Executable policy constants (LOCKED — Tier1 only, no halftime).
// Founder-authorized Queue money envelope, RESTORE_DEFAULT_250_SEPARATE_MAX_400_CONTRACT_V1
// (2026-09-22, corrects the accidental "$4 every bet" regression from the
// 2026-09-21 envelope change, which collapsed the ordinary stake into the
// exceptional ceiling by defining EXECUTABLE_STAKE_USD === QUEUE_MAX_STAKE_USD):
//   QUEUE_DEFAULT_STAKE_USD   the ORDINARY stake written to every normal Queue
//                             row's stake_usd. $2.50, not $4.00.
//   QUEUE_MAX_STAKE_USD       the exceptional hard ceiling ($4.00), reserved
//                             for a venue-minimum-size headroom problem. Never
//                             the ordinary stake, never equal to stake_usd by
//                             construction. Persisted separately, per Queue
//                             row, as diagnostics.max_stake_usd.
//   QUEUE_MAX_ENTRY_PRICE     max_entry_price may never exceed 0.555
//                             (LIVE_BETTING_RECOVERY_FINAL_HOTFIX_V2, Founder
//                             decision 2026-10-06 -- moved from 0.54, which
//                             itself was lowered from 0.62 by
//                             NARROW_FOOTBALL_MONEY_POLICY_V1, 2026-09-24).
//                             This is the SINGLE canonical money-path hard
//                             cap: TAKER proves raw executable VWAP <= cap AND
//                             fee-inclusive effective cost <= cap; MAKER and
//                             MAKER_FALLBACK_1 limits are <= cap on a valid
//                             tick. The support odds bands are NOT part of it
//                             and are unchanged; a worse live ask still fails
//                             closed rather than widening the cap.
// PREMVP stays the authority; a value above either bound is rejected (fail
// closed), never silently clamped. Existing Queue rows keep their
// already-persisted stake. This contract authorizes the envelope only -- it
// does not decide when a consumer may actually spend above the default.
export const QUEUE_DEFAULT_STAKE_USD = 2.5 as const;
export const QUEUE_MAX_STAKE_USD = 4.0 as const;
export const QUEUE_MAX_ENTRY_PRICE = 0.555 as const;
export const EXECUTABLE_TIER = "TIER1" as const;

// ALIGN_B2_LIVE_ORDERBOOK_GUARD_WITH_EXISTING_EXECUTION_POLICY_V1 — the ONE
// canonical live max-spread authority. Every live execution path (the
// candidate policy built by buildFireModelCandidates.ts and the B2 final
// live-orderbook guard in eventExecutionQueue.ts) must read this single
// constant -- never a second, path-local spread ceiling.
export const LIVE_EXECUTION_MAX_SPREAD = 0.03 as const;
/** The ordinary stake written to every normal Queue row -- never the exceptional ceiling. */
export const EXECUTABLE_STAKE_USD = QUEUE_DEFAULT_STAKE_USD;
export const QUEUE_SCHEMA_VERSION = "executor-queue-v1" as const;
export const QUEUE_EXECUTION_MODE = "NIGHT_LIVE_EXECUTION" as const;
export const QUEUE_SOURCE = "event_execution_queue" as const;

// SINGLE_MAKER_PREGAME_CONTRACT_V1 -- ONE maker attempt per physical event, resting until the last safe PRE-KICKOFF cutoff.
//   latest_entry (= fallback_deadline)   event_start + 3 minutes (nightWindow.latestEntryIso; no entry at/after it)
//   maker cancel_by (MAKER_FIRST and the TAKER-proven-zero MAKER_FALLBACK_1)
//                                        event_start - 60 s (a FIXED safety margin from the physical event start; no
//                                        resting BUY maker survives kickoff)
//   Queue creation target                ~T-20 (T-22..T-18), so the single MAKER rests ~19 minutes
// A MAKER_FIRST zero-fill is terminal for the event: there is NO MAKER_FALLBACK_1 after MAKER_FIRST, so no fallback
// reserve is needed between cancel_by and latest_entry. IRELAND_REQUIRED_FALLBACK_RESERVE_SECONDS is retained ONLY as
// the already-released wire value of `required_min_remaining_seconds`; it is no longer a window constraint.
export const IRELAND_REQUIRED_FALLBACK_RESERVE_SECONDS = 580 as const;
/** The single canonical pre-kickoff cutoff (seconds before the physical event start) for every resting maker. */
export const MAKER_PREGAME_CUTOFF_SECONDS = 60 as const; // T-1:00
export const PRIMARY_MAKER_CANCEL_BEFORE_START_SECONDS = MAKER_PREGAME_CUTOFF_SECONDS;
/** Already-frozen MAKER_FIRST rows (created before SINGLE_MAKER_PREGAME_CONTRACT_V1) carry cancel_by = T-12:40; strictly earlier = safe. */
export const LEGACY_PRIMARY_MAKER_CANCEL_BEFORE_START_SECONDS = 760 as const;
/** Ireland's released pre-claim minimum remaining time to primary_maker_cancel_by (Ireland-owned; informational here). */
export const IRELAND_PRECLAIM_MIN_REMAINING_SECONDS = 180 as const;

export type PrimaryMakerTiming = {
  primary_maker_cancel_by_iso: string;
  fallback_deadline_iso: string;
  required_min_remaining_seconds: number;
};

/**
 * Pure derivation from the physical event start (cancel_by = start - 60 s) and the Queue latest_entry.
 * Null when either is unparseable or when cancel_by would fall after latest_entry (fails closed).
 */
export function primaryMakerTiming(eventStartIso: string, latestEntryIso: string): PrimaryMakerTiming | null {
  const start = Date.parse(eventStartIso);
  const deadline = Date.parse(latestEntryIso);
  if (!Number.isFinite(start) || !Number.isFinite(deadline)) return null;
  const cancelBy = start - PRIMARY_MAKER_CANCEL_BEFORE_START_SECONDS * 1000;
  if (deadline < cancelBy) return null;
  return {
    primary_maker_cancel_by_iso: new Date(cancelBy).toISOString(),
    fallback_deadline_iso: new Date(deadline).toISOString(),
    required_min_remaining_seconds: IRELAND_REQUIRED_FALLBACK_RESERVE_SECONDS,
  };
}

// LIVE_EXECUTION_FINAL_ACTIVATION_V1 -- adaptive minimum-order headroom. Every evaluation starts at
// QUEUE_DEFAULT_STAKE_USD. ONLY when the venue minimum order size is the sole blocker may the stake be
// raised to the SMALLEST cent amount that satisfies it, never above QUEUE_MAX_STAKE_USD.
export const STAKE_ADJUSTMENT_REASON_MIN_ORDER = "VENUE_MINIMUM_ORDER_SIZE" as const;

export type StakeAuthorization = {
  base_stake_usd: number;
  authorized_stake_usd: number;
  max_stake_usd: number;
  stake_adjustment_reason: typeof STAKE_ADJUSTMENT_REASON_MIN_ORDER | null;
  minimum_order_size: number;
  /** The MAXIMUM authoritative requirement used for authorization (TAKER: max of the two fields below). */
  required_minimum_notional_usd: number | null;
  /** TAKER only: minimum order quantity walked on the CURRENT ask ladder at <= price_limit. */
  current_book_required_minimum_notional_usd?: number | null;
  /** TAKER only: ceilCent(ceilShares(minimum_order_size) x taker price_limit) -- the Ireland execution-envelope minimum. */
  execution_envelope_required_minimum_notional_usd?: number | null;
};

/** Venue quantity precision (shares, 0.01). Floor/ceil are float-safe at the boundary. */
export const floorShares = (v: number) => Math.floor(v * 100 + 1e-6) / 100;
export const ceilShares = (v: number) => Math.ceil(v * 100 - 1e-6) / 100;
/** Smallest cent stake covering a USD notional. */
export const ceilCentUsd = (v: number) => Math.ceil(Math.round(v * 1e6) / 1e4 - 1e-6) / 100;

export type QueueMoneyEnvelopeViolation =
  | "QUEUE_STAKE_ABOVE_ENVELOPE"
  | "QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING";

/**
 * Pure fail-closed check of a Queue instruction's OWN row-level stake_usd
 * (the ordinary $2.50 default, not the $4.00 diagnostics ceiling) against the
 * Founder-authorized money envelope. Returns a specific reason, or null when
 * within bounds. A missing/non-finite max_entry_price is not judged here
 * (callers already fail closed on it separately).
 */
export function queueMoneyEnvelopeViolation(
  stakeUsd: number,
  maxEntryPrice: number | null
): QueueMoneyEnvelopeViolation | null {
  if (!Number.isFinite(stakeUsd) || stakeUsd > QUEUE_MAX_STAKE_USD) return "QUEUE_STAKE_ABOVE_ENVELOPE";
  if (maxEntryPrice !== null && Number.isFinite(maxEntryPrice) && maxEntryPrice > QUEUE_MAX_ENTRY_PRICE) {
    return "QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING";
  }
  return null;
}

/**
 * The hard authorized maximum stake for ONE Queue row: diagnostics.max_stake_usd
 * when present and finite, otherwise the row's own stake_usd. Backward
 * compatible with historical rows written before this contract, which never
 * carried diagnostics.max_stake_usd at all -- such a row's effective max stake
 * remains exactly its historical stake_usd, never silently promoted to $4.
 */
export function extractMaxStakeUsd(
  diagnostics: Record<string, unknown>,
  fallbackStakeUsd: number
): number {
  const v = diagnostics.max_stake_usd;
  return typeof v === "number" && Number.isFinite(v) ? v : fallbackStakeUsd;
}

export interface NightEventReservationRow {
  id?: string;
  // Live Contour 6 canonical occurrence identity. Legacy persisted rows may
  // omit these fields; every new Reservation write validates both before insert.
  physical_event_id?: string | null;
  event_start_iso?: string | null;
  plan_run_id: string;
  plan_date_minsk: string; // YYYY-MM-DD (Minsk)
  reserved_at?: string;
  window_start_iso: string;
  window_end_iso: string;
  match_family_key: string;
  event_slug: string | null;
  event_title: string | null;
  sport: string | null;
  league: string | null;
  strategic_scope: string | null;
  game_start_iso: string;
  event_tier: string | null;
  event_score: number | null;
  best_snapshot_id: string | null;
  reservation_rank: number | null;
  status: ReservationStatus;
  selection_reason: string | null;
  diagnostics: Record<string, unknown>;
}

export interface EventExecutionQueueRow {
  id?: string;
  reservation_id: string | null;
  plan_run_id: string;
  rebalance_run_id: string;
  queued_at?: string;
  match_family_key: string;
  event_title: string | null;
  event_slug: string | null;
  sport: string | null;
  league: string | null;
  game_start_iso: string;
  condition_id: string;
  token_id: string;
  side: string;
  market_slug: string | null;
  market_title: string | null;
  market_family: string | null;
  score: number | null;
  coverage: number | null;
  tier: string;
  stake_usd: number;
  preferred_entry_iso: string;
  latest_entry_iso: string;
  selection_rank: number;
  selection_reason: string | null;
  status: QueueStatus;
  order_key: string | null;
  idempotency_key: string | null;
  diagnostics: Record<string, unknown>;
}

// Ireland-facing candidate projection (mirrors /api/executor/night-plan candidate shape).
export interface IrelandQueueCandidate {
  candidate_id: string;
  /** Canonical persisted event_execution_queue.id for consumer acknowledgement. */
  queue_id: string;
  /**
   * Authoritative event_execution_queue.id (the persisted row's own primary
   * key), exposed verbatim under its own name rather than only inside the
   * candidate_id/queue_id fallback composite. Null only when the row
   * genuinely has no persisted id yet -- never synthesized. queue_id above
   * and queue_row_id here currently carry the same value for a persisted
   * row; queue_row_id is the strict, non-fallback form.
   */
  queue_row_id: string | null;
  order_key: string;
  idempotency_key: string | null;
  plan_run_id: string;
  rebalance_run_id: string;
  reservation_id: string | null;
  /**
   * Authoritative signal-pair lineage id (generated_signal_pairs.id) that
   * selected this exact market at rebalance time. Sourced verbatim from
   * diagnostics.selected_signal_pair_id (falling back to
   * diagnostics.source_lineage.generated_signal_pair_id, the same lineage
   * value under its Reservation-stage key) -- never derived from title/slug.
   * Null when the row predates this lineage stamp.
   */
  signal_pair_id: string | null;
  model_lineage_v1: Record<string, unknown> | null;
  match_family_key: string;
  /** Canonical alias for legacy match_family_key occurrence storage. */
  physical_event_id: string | null;
  /** Provider event identity preserved from immutable persisted lineage. */
  provider_event_id: string | null;
  event_slug: string | null;
  event_id: string | null;
  event_title: string | null;
  sport: string | null;
  condition_id: string;
  token_id: string;
  /**
   * Outcome selector (e.g. "YES"/"NO" or a team name) identifying which
   * token_id was chosen. This is NOT a CLOB order action -- see
   * execution_side below. Preserved verbatim for backward compatibility:
   * PREMVP's own order-event cross-check (validateOrderEventAgainstQueueRow)
   * matches a consumer's callback against this exact value.
   */
  side: string;
  /**
   * Canonical CLOB order action (BUY/SELL) Ireland's execution adapter
   * consumes. This queue is entry-only: nothing in the Contur3 pipeline
   * (buildFireModelCandidates / nightPortfolioPlanner / eventExecutionQueue)
   * ever constructs an exit/sell order, and token_id already disambiguates
   * the exact outcome being acquired -- so the order action is mechanically
   * always "BUY", never guessed from a title or the outcome selector above.
   */
  execution_side: "BUY";
  /**
   * Explicit attempt identity of the initial Queue instruction (never inferred by Ireland).
   * A frozen T10 MAKER_FIRST row is emitted as MAKER_FIRST / MAKER_FIRST with the primary-maker
   * fields below; every other row is TAKER / TAKER_ATTEMPT_1 (unchanged wire).
   */
  execution_mode: "TAKER" | "MAKER_FIRST";
  attempt_id: "TAKER_ATTEMPT_1" | "MAKER_FIRST";
  market_slug: string | null;
  market_title: string | null;
  market_family: string | null;
  score: number | null;
  coverage: number | null;
  tier: string;
  stake_usd: number;
  max_stake_usd: number;
  // PREMVP-computed price ceiling. Consumer may fill at this price or better (lower),
  // never above it. Both names carry the same value — max_entry_price is the model
  // term, price_cap is the consumer-facing alias.
  max_entry_price: number | null;
  price_cap: number | null;
  preferred_entry_iso: string;
  latest_entry_iso: string;
  game_start_iso: string;
  /** Canonical alias for legacy game_start_iso occurrence storage. */
  event_start_iso: string;
  // PENDING_WINDOW: preferred_entry_iso still in the future; IN_WINDOW: ready to enter now.
  entry_state: "IN_WINDOW" | "PENDING_WINDOW";
  selection_rank: number;
  status: QueueStatus;
  is_executable: true;
  // ── present ONLY on a frozen T10 MAKER_FIRST row (released Ireland primary-maker contract) ──
  maker_limit_price?: number;
  maker_shares?: number;
  requested_quantity?: number;
  tick_size?: number;
  minimum_order_size?: number;
  p_buy_max?: number;
  price_authority_version?: string;
  price_authority_observation_id?: string;
  execution_policy_version?: string;
  economic_policy_version?: string;
  /** Released Ireland timing contract: primary must be cancelled by this instant. */
  primary_maker_cancel_by_iso?: string;
  /** = latest_entry_iso; MAKER_FALLBACK_1 never runs past it. */
  fallback_deadline_iso?: string;
  /** Released wire value (580); no longer a window constraint -- there is no fallback after MAKER_FIRST. */
  required_min_remaining_seconds?: number;
}

/**
 * A MAKER_FIRST primary may be handed to Ireland only strictly before its primary_maker_cancel_by_iso.
 * Non-MAKER_FIRST candidates are unaffected. A MAKER_FIRST candidate without timing never qualifies.
 */
export function primaryMakerSubmissionOpen(c: Pick<IrelandQueueCandidate, "execution_mode" | "primary_maker_cancel_by_iso">, nowMs: number): boolean {
  if (c.execution_mode !== "MAKER_FIRST") return true;
  const cancelBy = typeof c.primary_maker_cancel_by_iso === "string" ? Date.parse(c.primary_maker_cancel_by_iso) : NaN;
  return Number.isFinite(cancelBy) && nowMs < cancelBy;
}

// ── T10 frozen execution contract (diagnostics.t10_economic_action_v1) ──────

export const T10_ECONOMIC_ACTION_DIAGNOSTICS_KEY = "t10_economic_action_v1" as const;
export const PRIMARY_MAKER_ATTEMPT_ID = "MAKER_FIRST" as const;

/**
 * Frozen execution mode of a Queue row. null = not a T10 economic-policy row (legacy wire);
 * "INVALID" = a T10 contract is present but its mode is unrecognised (always fails closed).
 */
export function t10FrozenExecutionMode(
  diagnostics: Record<string, unknown> | null | undefined
): "TAKER_FIRST" | "MAKER_FIRST" | "INVALID" | null {
  const c = diagnostics?.[T10_ECONOMIC_ACTION_DIAGNOSTICS_KEY];
  if (c === undefined || c === null) return null;
  if (typeof c !== "object" || Array.isArray(c)) return "INVALID";
  const mode = (c as Record<string, unknown>).execution_mode;
  return mode === "TAKER_FIRST" || mode === "MAKER_FIRST" ? mode : "INVALID";
}

export type T10FrozenContractScalars = {
  execution_mode: "TAKER_FIRST" | "MAKER_FIRST";
  p_buy_max: number;
  tick_size: number;
  minimum_order_size: number;
  price_authority_version: string;
  price_authority_observation_id: string;
  execution_policy_version: string;
  economic_policy_version: string;
  maker: { maker_limit_price: number; maker_shares: number } | null;
  /** MAKER_FIRST only: the released Ireland primary-maker timing contract. */
  timing: PrimaryMakerTiming | null;
};

const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const onTick = (price: number, tick: number) => Math.abs(price / tick - Math.round(price / tick)) <= 1e-6;

/**
 * Strict read of the frozen T10 contract scalars on a Queue row. Every authority the money path
 * depends on must be present and self-consistent with the row; anything else is a reason string.
 */
export function readT10FrozenContract(
  row: Pick<EventExecutionQueueRow, "condition_id" | "token_id" | "side" | "stake_usd" | "latest_entry_iso" | "game_start_iso" | "diagnostics">
): { ok: true; contract: T10FrozenContractScalars } | { ok: false; reason: string } {
  const mode = t10FrozenExecutionMode(row.diagnostics);
  if (mode === null) return { ok: false, reason: "T10_CONTRACT_ABSENT" };
  if (mode === "INVALID") return { ok: false, reason: "T10_EXECUTION_MODE_INVALID" };
  const c = row.diagnostics[T10_ECONOMIC_ACTION_DIAGNOSTICS_KEY] as Record<string, unknown>;
  if (c.condition_id !== row.condition_id || c.token_id !== row.token_id || c.side !== row.side) {
    return { ok: false, reason: "T10_CONTRACT_IDENTITY_MISMATCH" };
  }
  if (c.stake_usd !== row.stake_usd || !finitePos(row.stake_usd) || row.stake_usd > QUEUE_MAX_STAKE_USD) {
    return { ok: false, reason: "T10_CONTRACT_STAKE_MISMATCH" };
  }
  // A stake above the ordinary $2.50 is valid ONLY with venue-minimum headroom evidence (never silent).
  const sa = c.stake_authorization as Record<string, unknown> | null | undefined;
  if (sa !== undefined && sa !== null && sa.authorized_stake_usd !== row.stake_usd) {
    return { ok: false, reason: "T10_CONTRACT_STAKE_MISMATCH" };
  }
  const adjusted = row.stake_usd > QUEUE_DEFAULT_STAKE_USD + 1e-9;
  if (!adjusted && sa && sa.stake_adjustment_reason !== null && sa.stake_adjustment_reason !== undefined) {
    return { ok: false, reason: "T10_CONTRACT_STAKE_HEADROOM_EVIDENCE_INVALID" };
  }
  if (adjusted) {
    const required = sa?.required_minimum_notional_usd;
    if (!sa || sa.stake_adjustment_reason !== STAKE_ADJUSTMENT_REASON_MIN_ORDER ||
        sa.base_stake_usd !== QUEUE_DEFAULT_STAKE_USD || sa.max_stake_usd !== QUEUE_MAX_STAKE_USD ||
        row.diagnostics.max_stake_usd !== QUEUE_MAX_STAKE_USD ||
        !finitePos(sa.minimum_order_size) || sa.minimum_order_size !== c.minimum_order_size ||
        !finitePos(required) || !(required > QUEUE_DEFAULT_STAKE_USD + 1e-9) ||
        Math.abs(ceilCentUsd(required) - row.stake_usd) > 1e-9) {
      return { ok: false, reason: "T10_CONTRACT_STAKE_HEADROOM_EVIDENCE_INVALID" };
    }
  }
  // Instant equality: the timestamptz column is read back as "+00:00", the frozen value as "Z".
  const frozenDeadline = typeof c.latest_entry_iso === "string" ? Date.parse(c.latest_entry_iso) : NaN;
  if (!Number.isFinite(frozenDeadline) || frozenDeadline !== Date.parse(row.latest_entry_iso)) {
    return { ok: false, reason: "T10_CONTRACT_DEADLINE_MISMATCH" };
  }
  if (!finitePos(c.p_buy_max) || c.p_buy_max > QUEUE_MAX_ENTRY_PRICE) return { ok: false, reason: "T10_P_BUY_MAX_INVALID" };
  if (!finitePos(c.tick_size) || c.tick_size >= 1) return { ok: false, reason: "T10_TICK_SIZE_INVALID" };
  if (!finitePos(c.minimum_order_size)) return { ok: false, reason: "T10_MINIMUM_ORDER_SIZE_UNKNOWN" };
  if (!nonEmpty(c.price_authority_version) || !nonEmpty(c.price_authority_observation_id)) {
    return { ok: false, reason: "T10_PRICE_AUTHORITY_LINEAGE_MISSING" };
  }
  if (!nonEmpty(c.execution_policy_version) || !nonEmpty(c.economic_policy_version)) {
    return { ok: false, reason: "T10_POLICY_VERSION_MISSING" };
  }
  let maker: T10FrozenContractScalars["maker"] = null;
  let timing: PrimaryMakerTiming | null = null;
  if (mode === "MAKER_FIRST") {
    const m = c.maker as Record<string, unknown> | null | undefined;
    const limit = m?.maker_limit_price;
    const shares = m?.maker_shares;
    if (c.taker !== null && c.taker !== undefined) return { ok: false, reason: "T10_MAKER_CONTRACT_CARRIES_TAKER" };
    if (!finitePos(limit) || limit > c.p_buy_max + 1e-9 || limit > QUEUE_MAX_ENTRY_PRICE || !onTick(limit, c.tick_size)) {
      return { ok: false, reason: "T10_MAKER_LIMIT_INVALID" };
    }
    if (!finitePos(shares) || shares * limit > row.stake_usd + 1e-6) return { ok: false, reason: "T10_MAKER_SHARES_INVALID" };
    if (shares + 1e-9 < c.minimum_order_size) return { ok: false, reason: "T10_MAKER_BELOW_MINIMUM_ORDER_SIZE" };
    if (row.diagnostics.max_entry_price !== limit) return { ok: false, reason: "T10_MAKER_PRICE_CAP_MISMATCH" };
    if (adjusted) {
      // Headroom is legitimate only if $2.50 could NOT reach the minimum at this exact limit, and the
      // evidence is exactly the minimum quantity at this limit.
      const required = (c.stake_authorization as Record<string, number>).required_minimum_notional_usd;
      if (floorShares(QUEUE_DEFAULT_STAKE_USD / limit) + 1e-9 >= c.minimum_order_size ||
          Math.abs(required - ceilShares(c.minimum_order_size) * limit) > 1e-6) {
        return { ok: false, reason: "T10_CONTRACT_STAKE_HEADROOM_EVIDENCE_INVALID" };
      }
    }
    maker = { maker_limit_price: limit, maker_shares: shares };
    const required = c.required_min_remaining_seconds;
    const fallbackMs = typeof c.fallback_deadline_iso === "string" ? Date.parse(c.fallback_deadline_iso) : NaN;
    const cancelMs = typeof c.primary_maker_cancel_by_iso === "string" ? Date.parse(c.primary_maker_cancel_by_iso) : NaN;
    const startMs = Date.parse(row.game_start_iso);
    // fallback_deadline is the Queue latest_entry; primary_maker_cancel_by is the FIXED event_start - 60 s
    // (SINGLE_MAKER_PREGAME_CONTRACT_V1). A row frozen before this contract carries the earlier T-12:40 cancel_by:
    // it keeps validating (strictly earlier = safe). No reserve window is enforced -- there is no fallback after
    // MAKER_FIRST; the released required_min_remaining_seconds integer floor is kept for wire compatibility.
    if (!Number.isFinite(startMs) || !Number.isFinite(fallbackMs) || !Number.isFinite(cancelMs) ||
        typeof required !== "number" || !Number.isInteger(required) || required < IRELAND_REQUIRED_FALLBACK_RESERVE_SECONDS ||
        fallbackMs !== Date.parse(row.latest_entry_iso) ||
        (cancelMs !== startMs - PRIMARY_MAKER_CANCEL_BEFORE_START_SECONDS * 1000 &&
          cancelMs !== startMs - LEGACY_PRIMARY_MAKER_CANCEL_BEFORE_START_SECONDS * 1000) ||
        fallbackMs < cancelMs) {
      return { ok: false, reason: "T10_MAKER_TIMING_CONTRACT_INVALID" };
    }
    timing = {
      primary_maker_cancel_by_iso: new Date(cancelMs).toISOString(),
      fallback_deadline_iso: new Date(fallbackMs).toISOString(),
      required_min_remaining_seconds: required,
    };
  }
  return {
    ok: true,
    contract: {
      execution_mode: mode, p_buy_max: c.p_buy_max, tick_size: c.tick_size, minimum_order_size: c.minimum_order_size,
      price_authority_version: c.price_authority_version, price_authority_observation_id: c.price_authority_observation_id,
      execution_policy_version: c.execution_policy_version, economic_policy_version: c.economic_policy_version, maker, timing,
    },
  };
}

/** A frozen MAKER_FIRST row whose primary-maker contract is malformed. Never mapped to TAKER. */
export class QueueWireContractError extends Error {
  constructor(readonly reason: string, readonly queueId: string | null) {
    super(`QUEUE_WIRE_CONTRACT_INVALID:${reason}`);
    this.name = "QueueWireContractError";
  }
}

function extractMaxEntryPrice(diagnostics: Record<string, unknown>): number | null {
  const v = diagnostics.max_entry_price;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractProviderEventId(diagnostics: Record<string, unknown>): string | null {
  const direct = diagnostics.provider_event_id;
  if (typeof direct === "string" && direct) return direct;

  const sourceLineage = diagnostics.source_lineage;
  if (sourceLineage && typeof sourceLineage === "object") {
    const providerEventId = (sourceLineage as Record<string, unknown>).provider_event_id;
    if (typeof providerEventId === "string" && providerEventId) return providerEventId;
  }

  const finalIdentity = diagnostics.contract_a_final_identity;
  if (finalIdentity && typeof finalIdentity === "object") {
    const lineage = (finalIdentity as Record<string, unknown>).source_lineage;
    if (lineage && typeof lineage === "object") {
      const providerEventId = (lineage as Record<string, unknown>).provider_event_id;
      if (typeof providerEventId === "string" && providerEventId) return providerEventId;
    }
  }

  // Legacy persisted Queue rows may predate the explicit lineage field, but
  // still carry the canonical immutable provider occurrence identity. This is
  // a structured identity parse, never a reconstruction from display text.
  const physicalEventId = diagnostics.physical_event_id;
  const physicalMatch = typeof physicalEventId === "string"
    ? /^provider:polymarket:([^:]+):\d{4}-\d{2}-\d{2}$/.exec(physicalEventId)
    : null;
  if (physicalMatch?.[1]) return physicalMatch[1];

  return null;
}

/** Reads the authoritative signal-pair lineage id off a queue row's diagnostics (never derived, never defaulted). */
function extractSignalPairId(diagnostics: Record<string, unknown>): string | null {
  const direct = diagnostics.selected_signal_pair_id;
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  const lineage = diagnostics.source_lineage as Record<string, unknown> | undefined;
  const fromLineage = lineage?.generated_signal_pair_id;
  return typeof fromLineage === "string" && fromLineage.trim() !== "" ? fromLineage : null;
}

/**
 * Pure row → consumer-candidate projection (no DB, no side effects) so it can be
 * unit-tested and shared between /api/executor/queue and any future consumer route.
 * max_stake_usd is the row's own diagnostics.max_stake_usd exceptional ceiling
 * when present, otherwise its historical stake_usd (RESTORE_DEFAULT_250_SEPARATE_
 * MAX_400_CONTRACT_V1) -- it is deliberately NOT always equal to stake_usd.
 */
export function mapQueueRowToIrelandCandidate(
  row: EventExecutionQueueRow,
  nowMs: number
): IrelandQueueCandidate {
  const preferredMs = Date.parse(row.preferred_entry_iso);
  const entryState: IrelandQueueCandidate["entry_state"] =
    Number.isFinite(preferredMs) && preferredMs <= nowMs ? "IN_WINDOW" : "PENDING_WINDOW";
  const maxEntryPrice = extractMaxEntryPrice(row.diagnostics ?? {});
  const providerEventId = extractProviderEventId(row.diagnostics ?? {});
  const signalPairId = extractSignalPairId(row.diagnostics ?? {});
  // Primary MAKER_FIRST: emitted explicitly or not at all (throws) -- never falls through to TAKER.
  const frozenMode = t10FrozenExecutionMode(row.diagnostics);
  let primaryMaker: Partial<IrelandQueueCandidate> | null = null;
  // LIVE_MONEY_FAMILY_AUTHORITY_V1: executor handoff never carries a non-live family (SPREADS), even on a pre-existing READY row.
  if (isObservationOnlyMoneyFamily(row.market_family)) throw new QueueWireContractError("LIVE_MONEY_FAMILY_NOT_AUTHORIZED", row.id ?? null);
  // FOUNDER_TOTALS_OVER_LIVE_OFF_2026_10_10: a pre-existing, not-yet-executed READY TOTALS Over row is withheld from Ireland
  // (per-row wire rejection; the row, any fill, position and settlement are left untouched).
  if (isFounderLiveOffTotalsOver(row.market_family, row.side)) throw new QueueWireContractError(FOUNDER_TOTALS_OVER_LIVE_OFF, row.id ?? null);
  if (frozenMode === "INVALID") throw new QueueWireContractError("T10_EXECUTION_MODE_INVALID", row.id ?? null);
  if (frozenMode === "MAKER_FIRST") {
    const frozen = readT10FrozenContract(row);
    if (!frozen.ok || !frozen.contract.maker || !frozen.contract.timing) {
      throw new QueueWireContractError(frozen.ok ? "T10_MAKER_CONTRACT_MISSING" : frozen.reason, row.id ?? null);
    }
    const c = frozen.contract;
    primaryMaker = {
      execution_mode: "MAKER_FIRST",
      attempt_id: PRIMARY_MAKER_ATTEMPT_ID,
      maker_limit_price: c.maker!.maker_limit_price,
      maker_shares: c.maker!.maker_shares,
      requested_quantity: c.maker!.maker_shares,
      tick_size: c.tick_size,
      minimum_order_size: c.minimum_order_size,
      p_buy_max: c.p_buy_max,
      price_authority_version: c.price_authority_version,
      price_authority_observation_id: c.price_authority_observation_id,
      execution_policy_version: c.execution_policy_version,
      economic_policy_version: c.economic_policy_version,
      max_entry_price: c.maker!.maker_limit_price,
      price_cap: c.maker!.maker_limit_price,
      primary_maker_cancel_by_iso: c.timing!.primary_maker_cancel_by_iso,
      fallback_deadline_iso: c.timing!.fallback_deadline_iso,
      required_min_remaining_seconds: c.timing!.required_min_remaining_seconds,
    };
  }
  return {
    candidate_id: row.id ?? `${row.plan_run_id}:${row.match_family_key}`,
    queue_id: row.id ?? `${row.plan_run_id}:${row.match_family_key}`,
    queue_row_id: row.id ?? null,
    order_key: row.order_key ?? `${row.condition_id}:${row.token_id}:${row.side}`,
    idempotency_key: row.idempotency_key ?? null,
    plan_run_id: row.plan_run_id,
    rebalance_run_id: row.rebalance_run_id,
    reservation_id: row.reservation_id ?? null,
    signal_pair_id: signalPairId,
    model_lineage_v1: row.diagnostics?.model_lineage_v1 && typeof row.diagnostics.model_lineage_v1 === "object"
      ? row.diagnostics.model_lineage_v1 as Record<string, unknown>
      : null,
    match_family_key: row.match_family_key,
    physical_event_id:
      (typeof row.diagnostics?.physical_event_id === "string" && row.diagnostics.physical_event_id) ||
      row.match_family_key ||
      null,
    provider_event_id: providerEventId,
    event_slug: row.event_slug,
    event_id: row.event_slug,
    event_title: row.event_title,
    sport: row.sport ?? null,
    condition_id: row.condition_id,
    token_id: row.token_id,
    side: row.side,
    execution_side: "BUY",
    execution_mode: "TAKER",
    attempt_id: "TAKER_ATTEMPT_1",
    market_slug: row.market_slug,
    market_title: row.market_title ?? null,
    market_family: row.market_family,
    score: row.score,
    coverage: row.coverage,
    tier: row.tier,
    stake_usd: row.stake_usd,
    max_stake_usd: extractMaxStakeUsd(row.diagnostics ?? {}, row.stake_usd),
    max_entry_price: maxEntryPrice,
    price_cap: maxEntryPrice,
    preferred_entry_iso: row.preferred_entry_iso,
    latest_entry_iso: row.latest_entry_iso,
    game_start_iso: row.game_start_iso,
    event_start_iso:
      (typeof row.diagnostics?.event_start_iso === "string" && row.diagnostics.event_start_iso) ||
      row.game_start_iso,
    entry_state: entryState,
    selection_rank: row.selection_rank,
    status: row.status,
    is_executable: true,
    ...(primaryMaker ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Order-event validation — PREMVP as source of truth for stake/price/identity.
// Pure, no DB/network — the caller (order-events route) fetches the queue row
// and passes it in here for comparison against the consumer's claimed submission.
// ---------------------------------------------------------------------------

export interface OrderEventSubmission {
  queue_id: string | null;
  reservation_id: string | null;
  idempotency_key: string | null;
  token_id: string | null;
  condition_id: string | null;
  side: string | null;
  market_slug: string | null;
  stake_usd: number | null;
  submitted_size: number | null;
  submitted_price: number | null;
}

export type OrderEventValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Enforces the founder-approved execution-boundary policy:
 *   - canonical execution invariants (token_id/condition_id/side) must match the queue row;
 *     display text such as market_slug is never identity or an admission gate;
 *     if the queue row has a value for a field, the submission must report it too
 *   - the effective max stake for this row is diagnostics.max_stake_usd when
 *     present (the exceptional headroom ceiling), otherwise the row's own
 *     stake_usd (RESTORE_DEFAULT_250_SEPARATE_MAX_400_CONTRACT_V1) -- a
 *     historical row without diagnostics.max_stake_usd is never silently
 *     promoted to $4
 *   - callback stake_usd is a USD allocation ceiling and must be finite,
 *     positive, and <= the row's effective max stake
 *   - submitted_size is shares; actual USD notional is submitted_price ×
 *     submitted_size and must be <= the row's effective max stake
 *   - queue row must carry a max_entry_price to validate against (no cap = no
 *     safe execution boundary, so validation fails closed)
 *   - submitted price is mandatory, must be finite/positive, and <= queue row
 *     max_entry_price (consumer may get a better price, never pay above the cap)
 * Missing/unreported fields are treated as fail-safe rejections, not silent passes.
 *
 * The ONE exception (options.preSubmissionProvenZero) is a callback the caller has already proven to be the
 * exact authoritative PROVEN_REJECTED_BEFORE_SUBMISSION terminal zero (isProvenRejectedBeforeSubmissionZero plus
 * a consistent Queue row): nothing reached the venue, so there is no submitted price to bound. It waives ONLY the
 * ABSENCE of submitted_price -- a price that is present is validated exactly as before, and every identity,
 * stake and Queue-envelope check above still applies.
 *
 * The SECOND (and only other) exception (options.unknownTransportAmbiguous) is the exact typed
 * UNKNOWN_TRANSPORT_NEEDS_RECONCILIATION shape the caller has already proven (isUnknownTransportNeedsReconciliationCallback
 * plus a CLAIMED Queue row with no resolved result): an ambiguous transport outcome has no confirmed submitted price,
 * and it is neither a fill nor a proven zero. Same rule: only the ABSENCE of submitted_price is waived; every
 * identity / stake / size / envelope check above still applies and a present price is validated exactly as before.
 */
export function validateOrderEventAgainstQueueRow(
  submitted: OrderEventSubmission,
  queueRow: EventExecutionQueueRow,
  options: { preSubmissionProvenZero?: boolean; unknownTransportAmbiguous?: boolean } = {}
): OrderEventValidationResult {
  if (!queueRow.id || submitted.queue_id !== queueRow.id) {
    return { ok: false, reason: "QUEUE_ID_MISMATCH" };
  }
  if (submitted.reservation_id !== queueRow.reservation_id) {
    return { ok: false, reason: "RESERVATION_ID_MISMATCH" };
  }
  if (submitted.token_id !== queueRow.token_id) {
    return { ok: false, reason: "TOKEN_ID_MISMATCH" };
  }
  if (queueRow.condition_id !== null && submitted.condition_id !== queueRow.condition_id) {
    return { ok: false, reason: "CONDITION_ID_MISMATCH" };
  }
  if (queueRow.side !== null && submitted.side !== queueRow.side) {
    return { ok: false, reason: "SIDE_MISMATCH" };
  }
  if (submitted.stake_usd === null || !Number.isFinite(submitted.stake_usd) || submitted.stake_usd <= 0) {
    return { ok: false, reason: "MISSING_STAKE_USD" };
  }
  const effectiveMaxStakeUsd = extractMaxStakeUsd(queueRow.diagnostics ?? {}, queueRow.stake_usd);
  if (!Number.isFinite(effectiveMaxStakeUsd) || effectiveMaxStakeUsd > QUEUE_MAX_STAKE_USD) {
    return { ok: false, reason: "QUEUE_STAKE_ABOVE_ENVELOPE" };
  }
  if (submitted.stake_usd > effectiveMaxStakeUsd) {
    return { ok: false, reason: "STAKE_EXCEEDS_QUEUE_MAX" };
  }
  if (
    submitted.submitted_size === null ||
    !Number.isFinite(submitted.submitted_size) ||
    submitted.submitted_size <= 0
  ) {
    return { ok: false, reason: "MISSING_SUBMITTED_SIZE" };
  }
  const maxEntryPrice = extractMaxEntryPrice(queueRow.diagnostics ?? {});
  if (maxEntryPrice === null) {
    return { ok: false, reason: "QUEUE_MAX_ENTRY_PRICE_MISSING" };
  }
  if (maxEntryPrice > QUEUE_MAX_ENTRY_PRICE) {
    return { ok: false, reason: "QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING" };
  }
  if (submitted.submitted_price === null && options.preSubmissionProvenZero === true) {
    // Proven rejected before submission: no order existed, so there is no price and no notional to bound.
    return { ok: true };
  }
  if (submitted.submitted_price === null && options.unknownTransportAmbiguous === true) {
    // Ambiguous transport: the venue outcome is unknown, so there is no confirmed price to bound (and none is inferred).
    return { ok: true };
  }
  if (
    submitted.submitted_price === null ||
    !Number.isFinite(submitted.submitted_price) ||
    submitted.submitted_price <= 0
  ) {
    return { ok: false, reason: "MISSING_SUBMITTED_PRICE" };
  }
  if (submitted.submitted_price > maxEntryPrice) {
    return { ok: false, reason: "PRICE_EXCEEDS_QUEUE_MAX" };
  }
  if (submitted.submitted_price * submitted.submitted_size > effectiveMaxStakeUsd) {
    return { ok: false, reason: "ORDER_NOTIONAL_EXCEEDS_QUEUE_MAX" };
  }
  return { ok: true };
}
