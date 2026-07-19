// lib/executor/executorQueueTypes.ts
//
// Shared types for the Contur3 canonical night pipeline:
//   night_event_reservations  → event-level frozen plan (written ~17:00 Minsk)
//   event_execution_queue      → per-event single-market selection (written at rebalance)
//
// Pure types only — no DB client, no side effects.

import type { QueueStatus } from "./executorCallbackContract";
export type { QueueStatus };

export type ReservationStatus =
  | "RESERVED"
  | "REBALANCE_PENDING"
  | "QUEUED"
  | "SKIPPED"
  | "EXPIRED"
  | "CANCELLED";

// Executable policy constants (LOCKED — Tier1 only, $7 stake, no halftime).
export const EXECUTABLE_TIER = "TIER1" as const;
export const EXECUTABLE_STAKE_USD = 7 as const;
export const QUEUE_SCHEMA_VERSION = "executor-queue-v1" as const;
export const QUEUE_EXECUTION_MODE = "NIGHT_LIVE_EXECUTION" as const;
export const QUEUE_SOURCE = "event_execution_queue" as const;

export interface NightEventReservationRow {
  id?: string;
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
  order_key: string;
  idempotency_key: string | null;
  plan_run_id: string;
  rebalance_run_id: string;
  reservation_id: string | null;
  match_family_key: string;
  event_slug: string | null;
  event_id: string | null;
  event_title: string | null;
  sport: string | null;
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
  max_stake_usd: number;
  // PREMVP-computed price ceiling. Consumer may fill at this price or better (lower),
  // never above it. Both names carry the same value — max_entry_price is the model
  // term, price_cap is the consumer-facing alias.
  max_entry_price: number | null;
  price_cap: number | null;
  preferred_entry_iso: string;
  latest_entry_iso: string;
  game_start_iso: string;
  // PENDING_WINDOW: preferred_entry_iso still in the future; IN_WINDOW: ready to enter now.
  entry_state: "IN_WINDOW" | "PENDING_WINDOW";
  selection_rank: number;
  is_executable: true;
}

function extractMaxEntryPrice(diagnostics: Record<string, unknown>): number | null {
  const v = diagnostics.max_entry_price;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Pure row → consumer-candidate projection (no DB, no side effects) so it can be
 * unit-tested and shared between /api/executor/queue and any future consumer route.
 * MVP treats the recommended stake as the hard max: max_stake_usd === stake_usd.
 */
export function mapQueueRowToIrelandCandidate(
  row: EventExecutionQueueRow,
  nowMs: number
): IrelandQueueCandidate {
  const preferredMs = Date.parse(row.preferred_entry_iso);
  const entryState: IrelandQueueCandidate["entry_state"] =
    Number.isFinite(preferredMs) && preferredMs <= nowMs ? "IN_WINDOW" : "PENDING_WINDOW";
  const maxEntryPrice = extractMaxEntryPrice(row.diagnostics ?? {});
  return {
    candidate_id: row.id ?? `${row.plan_run_id}:${row.match_family_key}`,
    order_key: row.order_key ?? `${row.condition_id}:${row.token_id}:${row.side}`,
    idempotency_key: row.idempotency_key ?? null,
    plan_run_id: row.plan_run_id,
    rebalance_run_id: row.rebalance_run_id,
    reservation_id: row.reservation_id ?? null,
    match_family_key: row.match_family_key,
    event_slug: row.event_slug,
    event_id: row.event_slug,
    event_title: row.event_title,
    sport: row.sport ?? null,
    condition_id: row.condition_id,
    token_id: row.token_id,
    side: row.side,
    market_slug: row.market_slug,
    market_title: row.market_title ?? null,
    market_family: row.market_family,
    score: row.score,
    coverage: row.coverage,
    tier: row.tier,
    stake_usd: row.stake_usd,
    max_stake_usd: row.stake_usd,
    max_entry_price: maxEntryPrice,
    price_cap: maxEntryPrice,
    preferred_entry_iso: row.preferred_entry_iso,
    latest_entry_iso: row.latest_entry_iso,
    game_start_iso: row.game_start_iso,
    entry_state: entryState,
    selection_rank: row.selection_rank,
    is_executable: true,
  };
}

// ---------------------------------------------------------------------------
// Order-event validation — PREMVP as source of truth for stake/price/identity.
// Pure, no DB/network — the caller (order-events route) fetches the queue row
// and passes it in here for comparison against the consumer's claimed submission.
// ---------------------------------------------------------------------------

export interface OrderEventSubmission {
  idempotency_key: string | null;
  token_id: string | null;
  condition_id: string | null;
  side: string | null;
  market_slug: string | null;
  submitted_size: number | null;
  submitted_price: number | null;
}

export type OrderEventValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Enforces the founder-approved execution-boundary policy:
 *   - identity (token_id/condition_id/side/market_slug) must match the queue row;
 *     if the queue row has a value for a field, the submission must report it too
 *   - submitted stake is mandatory, must be finite/positive, and <= queue row
 *     stake_usd (consumer may spend less, never more)
 *   - queue row must carry a max_entry_price to validate against (no cap = no
 *     safe execution boundary, so validation fails closed)
 *   - submitted price is mandatory, must be finite/positive, and <= queue row
 *     max_entry_price (consumer may get a better price, never pay above the cap)
 * Missing/unreported fields are treated as fail-safe rejections, not silent passes.
 */
export function validateOrderEventAgainstQueueRow(
  submitted: OrderEventSubmission,
  queueRow: EventExecutionQueueRow
): OrderEventValidationResult {
  if (submitted.token_id !== queueRow.token_id) {
    return { ok: false, reason: "TOKEN_ID_MISMATCH" };
  }
  if (queueRow.condition_id !== null && submitted.condition_id !== queueRow.condition_id) {
    return { ok: false, reason: "CONDITION_ID_MISMATCH" };
  }
  if (queueRow.side !== null && submitted.side !== queueRow.side) {
    return { ok: false, reason: "SIDE_MISMATCH" };
  }
  if (queueRow.market_slug !== null && submitted.market_slug !== queueRow.market_slug) {
    return { ok: false, reason: "MARKET_SLUG_MISMATCH" };
  }
  if (
    submitted.submitted_size === null ||
    !Number.isFinite(submitted.submitted_size) ||
    submitted.submitted_size <= 0
  ) {
    return { ok: false, reason: "MISSING_SUBMITTED_SIZE" };
  }
  if (submitted.submitted_size > queueRow.stake_usd) {
    return { ok: false, reason: "STAKE_EXCEEDS_QUEUE_MAX" };
  }
  const maxEntryPrice = extractMaxEntryPrice(queueRow.diagnostics ?? {});
  if (maxEntryPrice === null) {
    return { ok: false, reason: "QUEUE_MAX_ENTRY_PRICE_MISSING" };
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
  return { ok: true };
}
