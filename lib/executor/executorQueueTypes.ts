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

// Executable policy constants (LOCKED — Tier1 only, $2.50 maximum stake, no halftime).
// Stake is $2.50 for new Queue instructions: the Founder-authorized fixed
// amount that clears the observed venue minimum-order-size at a $0.50 price.
// Existing Queue rows retain their already-persisted stake.
export const EXECUTABLE_TIER = "TIER1" as const;
export const EXECUTABLE_STAKE_USD = 2.5 as const;
export const QUEUE_SCHEMA_VERSION = "executor-queue-v1" as const;
export const QUEUE_EXECUTION_MODE = "NIGHT_LIVE_EXECUTION" as const;
export const QUEUE_SOURCE = "event_execution_queue" as const;

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
  const providerEventId = extractProviderEventId(row.diagnostics ?? {});
  const signalPairId = extractSignalPairId(row.diagnostics ?? {});
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
    event_start_iso:
      (typeof row.diagnostics?.event_start_iso === "string" && row.diagnostics.event_start_iso) ||
      row.game_start_iso,
    entry_state: entryState,
    selection_rank: row.selection_rank,
    status: row.status,
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
