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
//   QUEUE_MAX_ENTRY_PRICE     max_entry_price may never exceed 0.54
//                             (NARROW_FOOTBALL_MONEY_POLICY_V1, 2026-09-24 --
//                             lowered from 0.62 to align the executable price
//                             ceiling with the ~1.85-2.00 implied-odds /
//                             0.50-0.54 share-price money band; a worse live
//                             ask fails closed rather than widening the cap).
// PREMVP stays the authority; a value above either bound is rejected (fail
// closed), never silently clamped. Existing Queue rows keep their
// already-persisted stake. This contract authorizes the envelope only -- it
// does not decide when a consumer may actually spend above the default.
export const QUEUE_DEFAULT_STAKE_USD = 2.5 as const;
export const QUEUE_MAX_STAKE_USD = 4.0 as const;
export const QUEUE_MAX_ENTRY_PRICE = 0.54 as const;
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
};

const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const onTick = (price: number, tick: number) => Math.abs(price / tick - Math.round(price / tick)) <= 1e-6;

/**
 * Strict read of the frozen T10 contract scalars on a Queue row. Every authority the money path
 * depends on must be present and self-consistent with the row; anything else is a reason string.
 */
export function readT10FrozenContract(
  row: Pick<EventExecutionQueueRow, "condition_id" | "token_id" | "side" | "stake_usd" | "latest_entry_iso" | "diagnostics">
): { ok: true; contract: T10FrozenContractScalars } | { ok: false; reason: string } {
  const mode = t10FrozenExecutionMode(row.diagnostics);
  if (mode === null) return { ok: false, reason: "T10_CONTRACT_ABSENT" };
  if (mode === "INVALID") return { ok: false, reason: "T10_EXECUTION_MODE_INVALID" };
  const c = row.diagnostics[T10_ECONOMIC_ACTION_DIAGNOSTICS_KEY] as Record<string, unknown>;
  if (c.condition_id !== row.condition_id || c.token_id !== row.token_id || c.side !== row.side) {
    return { ok: false, reason: "T10_CONTRACT_IDENTITY_MISMATCH" };
  }
  if (c.stake_usd !== row.stake_usd || !finitePos(row.stake_usd) || row.stake_usd > QUEUE_DEFAULT_STAKE_USD) {
    return { ok: false, reason: "T10_CONTRACT_STAKE_MISMATCH" };
  }
  if (c.latest_entry_iso !== row.latest_entry_iso) return { ok: false, reason: "T10_CONTRACT_DEADLINE_MISMATCH" };
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
  if (mode === "MAKER_FIRST") {
    const m = c.maker as Record<string, unknown> | null | undefined;
    const limit = m?.maker_limit_price;
    const shares = m?.maker_shares;
    if (c.taker !== null && c.taker !== undefined) return { ok: false, reason: "T10_MAKER_CONTRACT_CARRIES_TAKER" };
    if (!finitePos(limit) || limit > c.p_buy_max + 1e-9 || limit > QUEUE_MAX_ENTRY_PRICE || !onTick(limit, c.tick_size)) {
      return { ok: false, reason: "T10_MAKER_LIMIT_INVALID" };
    }
    if (!finitePos(shares) || shares * limit > row.stake_usd + 1e-9) return { ok: false, reason: "T10_MAKER_SHARES_INVALID" };
    if (shares + 1e-9 < c.minimum_order_size) return { ok: false, reason: "T10_MAKER_BELOW_MINIMUM_ORDER_SIZE" };
    if (row.diagnostics.max_entry_price !== limit) return { ok: false, reason: "T10_MAKER_PRICE_CAP_MISMATCH" };
    maker = { maker_limit_price: limit, maker_shares: shares };
  }
  return {
    ok: true,
    contract: {
      execution_mode: mode, p_buy_max: c.p_buy_max, tick_size: c.tick_size, minimum_order_size: c.minimum_order_size,
      price_authority_version: c.price_authority_version, price_authority_observation_id: c.price_authority_observation_id,
      execution_policy_version: c.execution_policy_version, economic_policy_version: c.economic_policy_version, maker,
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
  if (frozenMode === "INVALID") throw new QueueWireContractError("T10_EXECUTION_MODE_INVALID", row.id ?? null);
  if (frozenMode === "MAKER_FIRST") {
    const frozen = readT10FrozenContract(row);
    if (!frozen.ok || !frozen.contract.maker) {
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
 */
export function validateOrderEventAgainstQueueRow(
  submitted: OrderEventSubmission,
  queueRow: EventExecutionQueueRow
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
