// lib/executor/makerFallbackAuthorization.ts
//
// P2_PREMVP_SAFE_TAKER_TO_MAKER_AUTHORIZATION_V1
//
// SINGLE_MAKER_PREGAME_CONTRACT_V1: ONE maker attempt per physical event. One reserved
// physical event may carry TAKER_ATTEMPT_1 and, ONLY on authoritative Ireland proof of
// ZERO economic exposure of that TAKER attempt, exactly one MAKER_FALLBACK_1 on the SAME
// immutable Final Identity. It is a second execution attempt for the SAME economic bet,
// never a second market decision and never a second exposure slot. There is no
// MAKER_FALLBACK_2, and a primary MAKER_FIRST row NEVER authorizes a fallback: a MAKER_FIRST
// zero-fill is terminal for the event. Silence is never zero exposure.
//
// The lineage lives on the parent (taker) Queue row at
// diagnostics.execution_attempts_v1 -- no new table, no new Queue row (the Queue's
// (condition_id, token_id, side, plan_run_id) uniqueness and one-position-per-event
// rules stay intact).

import { createHash } from "node:crypto";
import {
  MAKER_PREGAME_CUTOFF_SECONDS,
  PRIMARY_MAKER_ATTEMPT_ID,
  QUEUE_MAX_ENTRY_PRICE,
  extractMaxStakeUsd,
  floorShares,
  readT10FrozenContract,
  t10FrozenExecutionMode,
  type EventExecutionQueueRow,
} from "./executorQueueTypes";
import { FOUNDER_TOTALS_OVER_LIVE_OFF, isFounderLiveOffTotalsOver, isObservationOnlyMoneyFamily } from "./liveMoneyFamilyAuthority";

export const EXECUTION_ATTEMPTS_KEY = "execution_attempts_v1" as const;
export const TAKER_ATTEMPT_1 = "TAKER_ATTEMPT_1" as const;
export const MAKER_FALLBACK_1 = "MAKER_FALLBACK_1" as const;
/** Primary maker attempt of a frozen T10 MAKER_FIRST Queue row. Never a fallback parent. */
export const MAKER_FIRST = PRIMARY_MAKER_ATTEMPT_ID;
export type AttemptId = typeof TAKER_ATTEMPT_1 | typeof MAKER_FALLBACK_1 | typeof MAKER_FIRST;
export type ExecutionMode = "TAKER" | "MAKER" | "MAKER_FIRST";
/** Released Ireland result envelope key; its `outcome` is the authoritative classification. */
export const EXECUTION_RESULT_V1_KEY = "execution_result_v1" as const;

export const IRELAND_RESULT_CLASSES = [
  "FULL_FILL",
  "PARTIAL_FILL",
  "PARTIAL_FILL_CANCELLED",
  "PARTIAL_FILL_EXPIRED",
  "PROVEN_ZERO_FILL_PRICE",
  "PROVEN_ZERO_FILL_NO_LIQUIDITY",
  "PROVEN_ZERO_FILL_CANCELLED",
  "PROVEN_ZERO_FILL_EXPIRED",
  "PROVEN_REJECTED_BEFORE_SUBMISSION",
  "UNKNOWN_AFTER_SUBMISSION",
  "UNKNOWN_TRANSPORT",
] as const;
export type IrelandResultClass = (typeof IRELAND_RESULT_CLASSES)[number];

/** Result classes that can ever carry proof of zero exposure. Everything else is blocked. */
const ZERO_PROOF_CLASSES: ReadonlySet<IrelandResultClass> = new Set([
  "PROVEN_ZERO_FILL_PRICE",
  "PROVEN_ZERO_FILL_NO_LIQUIDITY",
  "PROVEN_ZERO_FILL_CANCELLED",
  "PROVEN_ZERO_FILL_EXPIRED",
  "PROVEN_REJECTED_BEFORE_SUBMISSION",
]);
/** Classes whose venue facts may carry a positive fill. */
export const FILL_RESULT_CLASSES: ReadonlySet<IrelandResultClass> = new Set([
  "FULL_FILL",
  "PARTIAL_FILL",
  "PARTIAL_FILL_CANCELLED",
  "PARTIAL_FILL_EXPIRED",
]);
/** Classes that are terminal by their released definition (used only when `terminal` is not reported). */
const TERMINAL_RESULT_CLASSES: ReadonlySet<IrelandResultClass> = new Set([
  "FULL_FILL",
  "PARTIAL_FILL_CANCELLED",
  "PARTIAL_FILL_EXPIRED",
  ...ZERO_PROOF_CLASSES,
]);

export interface IrelandExecutionResult {
  attempt_id: AttemptId | null;
  execution_mode: ExecutionMode | null;
  result_class: IrelandResultClass;
  requested_quantity: number | null;
  filled_quantity: number | null;
  remaining_quantity: number | null;
  average_fill_price: number | null;
  venue_order_id: string | null;
  terminal: boolean | null;
  economic_exposure_proven_zero: boolean | null;
  fee_usd: number | null;
  received_at_iso: string;
}

function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function nonEmptyStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function strictBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function objectOrNull(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Reads the released Ireland execution-result semantics off a callback payload:
 * execution_result_v1.outcome (released contract), else the legacy
 * ireland_execution_result / top-level result_class. Returns null when the callback carries
 * no recognisable class: absence is never mapped to any class, never to zero exposure.
 * Only venue-reported scalars are read; fill facts are never derived from the plan. When the
 * released envelope omits `terminal` / `economic_exposure_proven_zero`, they follow from the
 * outcome's released definition (UNKNOWN_* and PARTIAL_FILL stay unresolved, fills never zero).
 */
export function readIrelandExecutionResult(raw: Record<string, unknown>, nowIso: string): IrelandExecutionResult | null {
  const v1 = objectOrNull(raw[EXECUTION_RESULT_V1_KEY]);
  const src: Record<string, unknown> = v1 ?? objectOrNull(raw.ireland_execution_result) ?? raw;
  const cls = nonEmptyStr(v1 ? v1.outcome : src.result_class);
  if (!cls || !(IRELAND_RESULT_CLASSES as readonly string[]).includes(cls)) return null;
  const resultClass = cls as IrelandResultClass;
  const attempt = nonEmptyStr(src.attempt_id ?? raw.attempt_id);
  const mode = nonEmptyStr(src.execution_mode ?? raw.execution_mode);
  const reportedTerminal = strictBool(src.terminal);
  const reportedZero = strictBool(src.economic_exposure_proven_zero);
  const outcomeOnly = v1 !== null;
  return {
    attempt_id: attempt === TAKER_ATTEMPT_1 || attempt === MAKER_FALLBACK_1 || attempt === MAKER_FIRST ? attempt : null,
    execution_mode: mode === "TAKER" || mode === "MAKER" || mode === "MAKER_FIRST" ? mode : null,
    result_class: resultClass,
    requested_quantity: finiteNum(src.requested_quantity),
    filled_quantity: finiteNum(src.filled_quantity),
    remaining_quantity: finiteNum(src.remaining_quantity),
    average_fill_price: finiteNum(src.average_fill_price),
    venue_order_id: nonEmptyStr(src.venue_order_id),
    terminal: reportedTerminal ?? (outcomeOnly && TERMINAL_RESULT_CLASSES.has(resultClass) ? true : null),
    economic_exposure_proven_zero: reportedZero ?? (!outcomeOnly ? null
      : ZERO_PROOF_CLASSES.has(resultClass) ? true : FILL_RESULT_CLASSES.has(resultClass) ? false : null),
    fee_usd: finiteNum(src.fee_usd),
    received_at_iso: nowIso,
  };
}

// ── lineage on the parent (taker) Queue row ───────────────────────────────

export interface MakerFallbackCommand {
  attempt_id: typeof MAKER_FALLBACK_1;
  execution_mode: "MAKER";
  execution_side: "BUY";
  status: "AUTHORIZED";
  /** The only fallback parent: TAKER_ATTEMPT_1 (a MAKER_FIRST row is never a fallback parent). */
  parent_attempt_id: typeof TAKER_ATTEMPT_1;
  parent_queue_id: string;
  parent_idempotency_key: string;
  idempotency_key: string;
  physical_event_id: string;
  reservation_id: string;
  condition_id: string;
  token_id: string;
  side: string;
  market_family: string | null;
  strategy_variant: string | null;
  strategy_version: string | null;
  stake_usd: number;
  max_stake_usd: number;
  quantity: number;
  limit_price: number;
  price_cap: number;
  deadline_iso: string;
  authorized_at_iso: string;
}

export interface ExecutionAttemptsV1 {
  taker_attempt_1?: { result?: IrelandExecutionResult };
  maker_fallback_1?: { command?: MakerFallbackCommand; result?: IrelandExecutionResult };
  /** Primary maker of a frozen T10 MAKER_FIRST row. Recorded only; it never authorizes MAKER_FALLBACK_1. */
  maker_first?: { result?: IrelandExecutionResult };
}
export type AttemptResultSlot = "taker_attempt_1" | "maker_fallback_1" | "maker_first";

export function readExecutionAttempts(diagnostics: Record<string, unknown> | null | undefined): ExecutionAttemptsV1 {
  const v = diagnostics?.[EXECUTION_ATTEMPTS_KEY];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as ExecutionAttemptsV1) : {};
}

export function makerIdempotencyKey(parentIdempotencyKey: string): string {
  return createHash("sha256").update(`${parentIdempotencyKey}__${MAKER_FALLBACK_1}`).digest("hex").slice(0, 32);
}

// ── pure authorization predicate ──────────────────────────────────────────

export type MakerBlockReason =
  | "RESULT_MISSING"
  | "ATTEMPT_NOT_TAKER_ATTEMPT_1"
  | "MODE_NOT_TAKER"
  | "RESULT_CLASS_CANNOT_PROVE_ZERO"
  | "RESULT_NOT_TERMINAL"
  | "FILLED_QUANTITY_NOT_ZERO"
  | "ZERO_EXPOSURE_NOT_PROVEN"
  | "MAKER_ALREADY_AUTHORIZED"
  | "QUEUE_ROW_NOT_AUTHORITATIVE"
  | "FINAL_IDENTITY_INVALID"
  | "IDENTITY_MISMATCH"
  | "DEADLINE_PASSED"
  | "PRIMARY_MAKER_ROW_NO_FALLBACK"
  | "LIVE_MONEY_FAMILY_NOT_AUTHORIZED"
  | typeof FOUNDER_TOTALS_OVER_LIVE_OFF;

export interface MakerEligibilityInput {
  result: IrelandExecutionResult | null;
  queue: EventExecutionQueueRow;
  /** Callback identity, when the callback reported it; must match the Queue row. */
  reported?: { condition_id?: string | null; token_id?: string | null; side?: string | null };
  nowMs: number;
}

export interface MakerEligibility {
  eligible: boolean;
  reasons: MakerBlockReason[];
  deadline_iso: string | null;
}

/**
 * The MAKER_FALLBACK_1 deadline is the single canonical pre-kickoff cutoff: physical event start - 60 s
 * (SINGLE_MAKER_PREGAME_CONTRACT_V1), never past the Queue latest-entry instant. No resting BUY maker may
 * survive kickoff. Null when either instant is unparseable (fails closed).
 */
export function makerDeadlineIso(queue: Pick<EventExecutionQueueRow, "latest_entry_iso" | "game_start_iso">): string | null {
  const latest = Date.parse(queue.latest_entry_iso);
  const start = Date.parse(queue.game_start_iso);
  if (!Number.isFinite(latest) || !Number.isFinite(start)) return null;
  return new Date(Math.min(latest, start - MAKER_PREGAME_CUTOFF_SECONDS * 1000)).toISOString();
}

export function evaluateMakerEligibility(input: MakerEligibilityInput): MakerEligibility {
  const { result, queue, reported, nowMs } = input;
  const reasons: MakerBlockReason[] = [];
  const deadline = makerDeadlineIso(queue);

  // The ONLY parent of MAKER_FALLBACK_1 is TAKER_ATTEMPT_1. A frozen MAKER_FIRST row (or an unreadable
  // frozen mode) never authorizes a fallback: its zero-fill is terminal for the event.
  const frozenMode = t10FrozenExecutionMode(queue.diagnostics);
  if (!result) {
    reasons.push("RESULT_MISSING");
  } else {
    if (result.attempt_id !== TAKER_ATTEMPT_1) reasons.push("ATTEMPT_NOT_TAKER_ATTEMPT_1");
    if (result.execution_mode !== "TAKER") reasons.push("MODE_NOT_TAKER");
    if (!ZERO_PROOF_CLASSES.has(result.result_class)) reasons.push("RESULT_CLASS_CANNOT_PROVE_ZERO");
    if (result.terminal !== true) reasons.push("RESULT_NOT_TERMINAL");
    // Outcome-only released results may omit filled_quantity; a REPORTED quantity must be exactly 0.
    if (result.filled_quantity !== null && result.filled_quantity !== 0) reasons.push("FILLED_QUANTITY_NOT_ZERO");
    if (result.economic_exposure_proven_zero !== true) reasons.push("ZERO_EXPOSURE_NOT_PROVEN");
  }

  if (readExecutionAttempts(queue.diagnostics).maker_fallback_1?.command) reasons.push("MAKER_ALREADY_AUTHORIZED");
  if (!queue.id || queue.status === "READY" || queue.status === "CANCELLED" || queue.status === "EXPIRED") {
    reasons.push("QUEUE_ROW_NOT_AUTHORITATIVE");
  }

  const d = queue.diagnostics ?? {};
  if (!queue.reservation_id || !queue.condition_id || !queue.token_id || !queue.side || !nonEmptyStr(d.physical_event_id ?? queue.match_family_key) || !queue.idempotency_key) {
    reasons.push("FINAL_IDENTITY_INVALID");
  }
  if (
    reported &&
    ((reported.condition_id != null && reported.condition_id !== queue.condition_id) ||
      (reported.token_id != null && reported.token_id !== queue.token_id) ||
      (reported.side != null && reported.side !== queue.side))
  ) {
    reasons.push("IDENTITY_MISMATCH");
  }

  if (deadline === null || nowMs >= Date.parse(deadline)) reasons.push("DEADLINE_PASSED");
  if (frozenMode === "INVALID" || frozenMode === "MAKER_FIRST") reasons.push("PRIMARY_MAKER_ROW_NO_FALLBACK");
  // LIVE_MONEY_FAMILY_AUTHORITY_V1: a non-live family (SPREADS) never opens fallback exposure.
  if (isObservationOnlyMoneyFamily(queue.market_family)) reasons.push("LIVE_MONEY_FAMILY_NOT_AUTHORIZED");
  // FOUNDER_TOTALS_OVER_LIVE_OFF_2026_10_10: a TOTALS Over parent never opens a NEW fallback order.
  if (isFounderLiveOffTotalsOver(queue.market_family, queue.side)) reasons.push(FOUNDER_TOTALS_OVER_LIVE_OFF);

  return { eligible: reasons.length === 0, reasons, deadline_iso: deadline };
}

// ── maker price authority ─────────────────────────────────────────────────

export type MakerPriceResult =
  | { ok: true; limit_price: number }
  | { ok: false; reason: "BOOK_INCOMPLETE" | "TICK_UNKNOWN" | "NOT_BELOW_ASK" | "ABOVE_PRICE_CAP" | "NOT_REPRESENTABLE" };

const ticksOf = (price: number, tick: number) => Math.round(price / tick);

/**
 * BUY maker price = best_bid + one valid tick, strictly below the current best ask
 * (post-only compatible) and never above the Queue price cap / global ceiling.
 */
export function deriveMakerLimitPrice(input: {
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number | null;
  priceCap: number | null;
}): MakerPriceResult {
  const { bestBid, bestAsk, tickSize, priceCap } = input;
  if (bestBid === null || bestAsk === null || !(bestBid > 0)) return { ok: false, reason: "BOOK_INCOMPLETE" };
  if (tickSize === null || !(tickSize > 0) || tickSize >= 1) return { ok: false, reason: "TICK_UNKNOWN" };
  const price = Math.round((bestBid + tickSize) * 1e8) / 1e8;
  // On-tick check (guards against off-tick books / float drift).
  if (Math.abs(price / tickSize - ticksOf(price, tickSize)) > 1e-6) return { ok: false, reason: "NOT_REPRESENTABLE" };
  if (!(price < 1) || !(price > 0)) return { ok: false, reason: "NOT_REPRESENTABLE" };
  if (!(price < bestAsk)) return { ok: false, reason: "NOT_BELOW_ASK" };
  if (priceCap === null || !Number.isFinite(priceCap) || price > priceCap || price > QUEUE_MAX_ENTRY_PRICE) {
    return { ok: false, reason: "ABOVE_PRICE_CAP" };
  }
  return { ok: true, limit_price: price };
}

type MakerPriceFailure = Extract<MakerPriceResult, { ok: false }>["reason"];
export type T10FallbackPriceFailure =
  | "T10_CONTRACT_INVALID"
  | "T10_BOOK_INCOMPLETE"
  | "T10_TICK_CHANGED"
  | "T10_MAKER_LIMIT_INVALID"
  | "MINIMUM_ORDER_SIZE_UNKNOWN"
  | "BELOW_MINIMUM_ORDER_SIZE";
export type BuildCommandResult =
  | { ok: true; command: MakerFallbackCommand }
  | { ok: false; reason: MakerPriceFailure | T10FallbackPriceFailure | "STAKE_UNREPRESENTABLE" | "PRICE_CAP_MISSING" | "PRIMARY_MAKER_ROW_NO_FALLBACK" };

/**
 * The frozen T10 policy MAKER formula (identical to t10EconomicActivation.makerLimitPrice, kept
 * local so the callback path does not load the decision module): on-tick, strictly below ask.
 */
export function t10MakerLimitPrice(pBuyMax: number, ask: number, tick: number, cap: number): number | null {
  if (![pBuyMax, ask, tick, cap].every((v) => Number.isFinite(v)) || !(tick > 0) || tick >= 1) return null;
  const limit = Math.round(Math.floor(Math.min(pBuyMax, ask - tick, cap) / tick + 1e-9) * tick * 1e6) / 1e6;
  return limit > 0 && limit < ask - 1e-9 && limit <= cap + 1e-9 ? limit : null;
}

/**
 * T10 economic-policy rows only: MAKER_FALLBACK_1 price authority is the frozen P_BUY_MAX, never
 * bestBid + tick. limit = floor_to_tick(min(P_BUY_MAX, current ask - tick, parent Queue cap, QUEUE_MAX_ENTRY_PRICE))
 * on the SAME token, and the stake-derived size must meet the authoritative minimum order.
 * The stake is never increased and the quantity never inflated to reach the minimum.
 */
export function deriveT10FallbackLimit(input: {
  queue: EventExecutionQueueRow;
  book: { bestAsk: number | null; tickSize: number | null; minimumOrderSize?: number | null };
  priceCap: number;
  stakeUsd: number;
}): { ok: true; limit_price: number; quantity: number } | { ok: false; reason: T10FallbackPriceFailure } {
  const frozen = readT10FrozenContract(input.queue);
  // Frozen P_BUY_MAX authority of a TAKER_FIRST parent; a MAKER_FIRST row is never a fallback parent.
  if (!frozen.ok || frozen.contract.execution_mode !== "TAKER_FIRST") {
    return { ok: false, reason: "T10_CONTRACT_INVALID" };
  }
  const { bestAsk, tickSize } = input.book;
  if (bestAsk === null || !(bestAsk > 0) || tickSize === null || !(tickSize > 0) || tickSize >= 1) {
    return { ok: false, reason: "T10_BOOK_INCOMPLETE" };
  }
  if (Math.abs(tickSize - frozen.contract.tick_size) > 1e-9) return { ok: false, reason: "T10_TICK_CHANGED" };
  const limit = t10MakerLimitPrice(frozen.contract.p_buy_max, bestAsk, tickSize, Math.min(input.priceCap, QUEUE_MAX_ENTRY_PRICE));
  if (limit === null || limit > frozen.contract.p_buy_max + 1e-9) return { ok: false, reason: "T10_MAKER_LIMIT_INVALID" };
  const liveMin = input.book.minimumOrderSize;
  if (liveMin !== undefined && liveMin !== null && !(Number.isFinite(liveMin) && liveMin > 0)) {
    return { ok: false, reason: "MINIMUM_ORDER_SIZE_UNKNOWN" };
  }
  const minimum = Math.max(frozen.contract.minimum_order_size, liveMin ?? 0);
  // The parent's frozen authorized stake (incl. any venue-minimum headroom) is inherited, never raised.
  const quantity = floorShares(input.stakeUsd / limit);
  if (quantity + 1e-9 < minimum) return { ok: false, reason: "BELOW_MINIMUM_ORDER_SIZE" };
  return { ok: true, limit_price: limit, quantity };
}

/**
 * Builds the explicit MAKER_FALLBACK_1 instruction. Identity and stake are copied verbatim
 * from the parent Queue row; nothing is re-selected and the stake is never increased.
 */
export function buildMakerFallbackCommand(input: {
  queue: EventExecutionQueueRow;
  book: { bestBid: number | null; bestAsk: number | null; tickSize: number | null; minimumOrderSize?: number | null };
  deadlineIso: string;
  nowIso: string;
}): BuildCommandResult {
  const { queue, book, deadlineIso, nowIso } = input;
  const d = queue.diagnostics ?? {};
  const rawCap = d.max_entry_price;
  const priceCap = typeof rawCap === "number" && Number.isFinite(rawCap) ? rawCap : null;
  if (priceCap === null) return { ok: false, reason: "PRICE_CAP_MISSING" };
  if (t10FrozenExecutionMode(d) === "MAKER_FIRST") return { ok: false, reason: "PRIMARY_MAKER_ROW_NO_FALLBACK" };
  const maxStake = extractMaxStakeUsd(d, queue.stake_usd);
  const stake = queue.stake_usd; // never above the original authorized stake

  let price: { limit_price: number };
  let quantity: number;
  if (t10FrozenExecutionMode(d) !== null) {
    // T10 economic-policy row: frozen P_BUY_MAX discipline (no standalone bestBid + tick authority).
    const t10 = deriveT10FallbackLimit({ queue, book, priceCap, stakeUsd: stake });
    if (!t10.ok) return { ok: false, reason: t10.reason };
    price = { limit_price: t10.limit_price };
    quantity = t10.quantity;
  } else {
    const legacy = deriveMakerLimitPrice({ bestBid: book.bestBid, bestAsk: book.bestAsk, tickSize: book.tickSize, priceCap });
    if (!legacy.ok) return { ok: false, reason: legacy.reason };
    price = legacy;
    quantity = Math.floor((stake / price.limit_price) * 100) / 100;
  }
  if (!(quantity > 0) || quantity * price.limit_price > Math.min(stake, maxStake) + 1e-6) {
    return { ok: false, reason: "STAKE_UNREPRESENTABLE" };
  }
  const lineage = d.model_lineage_v1 && typeof d.model_lineage_v1 === "object" ? (d.model_lineage_v1 as Record<string, unknown>) : {};
  return {
    ok: true,
    command: {
      attempt_id: MAKER_FALLBACK_1,
      execution_mode: "MAKER",
      execution_side: "BUY",
      status: "AUTHORIZED",
      parent_attempt_id: TAKER_ATTEMPT_1,
      parent_queue_id: queue.id as string,
      parent_idempotency_key: queue.idempotency_key as string,
      idempotency_key: makerIdempotencyKey(queue.idempotency_key as string),
      physical_event_id: ((d.physical_event_id as string | undefined) || queue.match_family_key) as string,
      reservation_id: queue.reservation_id as string,
      condition_id: queue.condition_id,
      token_id: queue.token_id,
      side: queue.side,
      market_family: queue.market_family,
      strategy_variant: nonEmptyStr(lineage.model_variant),
      strategy_version: nonEmptyStr(lineage.policy_version),
      stake_usd: stake,
      max_stake_usd: maxStake,
      quantity,
      limit_price: price.limit_price,
      price_cap: priceCap,
      deadline_iso: deadlineIso,
      authorized_at_iso: nowIso,
    },
  };
}

// ── orchestration (port-based; the route supplies Supabase adapters) ──────

export interface MakerFallbackPort {
  loadQueueRowByIdempotencyKey(key: string): Promise<EventExecutionQueueRow | null>;
  fetchBook(tokenId: string): Promise<{ bestBid: number | null; bestAsk: number | null; tickSize: number | null; minimumOrderSize?: number | null } | null>;
  /** Persist a result under diagnostics.execution_attempts_v1.<slot>.result (last write wins, never authorizes). */
  recordResult(queueId: string, slot: AttemptResultSlot, result: IrelandExecutionResult): Promise<void>;
  /**
   * Atomic compare-and-set: writes maker_fallback_1.command only if none exists yet.
   * Returns true for the single winner; false for every replay / concurrent loser.
   */
  claimMakerFallback(queueId: string, command: MakerFallbackCommand): Promise<boolean>;
}

export type MakerAuthorizationOutcome =
  | { kind: "NO_RESULT" }
  | { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT"; slot: AttemptResultSlot }
  | { kind: "MAKER_AUTHORIZED"; command: MakerFallbackCommand }
  | { kind: "MAKER_ALREADY_AUTHORIZED"; command: MakerFallbackCommand | null }
  | { kind: "MAKER_BLOCKED"; reasons: string[] }
  /** A maker-attempt callback that cannot bind to its authorized parent: no mutation, no accounting. */
  | { kind: "MAKER_CALLBACK_REJECTED"; reason: "UNKNOWN_ATTEMPT_ID" | "PARENT_IDEMPOTENCY_KEY_REQUIRED" | "PARENT_QUEUE_ROW_NOT_FOUND" | "MAKER_NOT_AUTHORIZED_FOR_PARENT" | "IDENTITY_MISMATCH" | PrimaryMakerRejectReason };

/** Reasons a primary MAKER_FIRST callback is rejected before any mutation or accounting. */
export type PrimaryMakerRejectReason =
  | "PRIMARY_MAKER_ATTEMPT_IDENTITY_INVALID"
  | "PRIMARY_MAKER_IDEMPOTENCY_KEY_REQUIRED"
  | "PRIMARY_MAKER_QUEUE_ROW_NOT_FOUND"
  | "PRIMARY_MAKER_NOT_FROZEN_ON_QUEUE_ROW"
  | "PRIMARY_MAKER_FROZEN_CONTRACT_INVALID"
  | "PRIMARY_MAKER_IDENTITY_MISMATCH"
  | "PRIMARY_MAKER_PRICE_ABOVE_FROZEN_LIMIT"
  | "PRIMARY_MAKER_QUANTITY_ABOVE_FROZEN_SHARES";

/** Contract flag surfaced to Ireland: maker callbacks MUST carry parent_idempotency_key. */
export const IRELAND_PARENT_IDEMPOTENCY_KEY_REQUIRED = true as const;

function attemptSources(raw: Record<string, unknown>): Record<string, unknown>[] {
  return [raw, objectOrNull(raw.ireland_execution_result) ?? {}, objectOrNull(raw[EXECUTION_RESULT_V1_KEY]) ?? {}];
}

/** True for any callback that claims the PRIMARY maker attempt (attempt id or mode MAKER_FIRST). */
export function isPrimaryMakerCallback(raw: Record<string, unknown>): boolean {
  return attemptSources(raw).some((s) => s.attempt_id === MAKER_FIRST || s.execution_mode === MAKER_FIRST);
}

/**
 * True for any callback that claims the MAKER FALLBACK attempt (by attempt id or execution mode).
 * A primary MAKER_FIRST callback is never a fallback and is handled by its own path.
 */
export function isMakerAttemptCallback(raw: Record<string, unknown>): boolean {
  if (isPrimaryMakerCallback(raw)) return false;
  const isMakerId = (v: unknown) => typeof v === "string" && v.startsWith("MAKER_");
  return attemptSources(raw).some((s) => isMakerId(s.attempt_id) || s.execution_mode === "MAKER");
}

/** The only maker attempt identity that exists. Any other MAKER_* id (e.g. MAKER_FALLBACK_2) is rejected. */
export function makerAttemptIdIsValid(raw: Record<string, unknown>): boolean {
  return attemptSources(raw).every((s) => s.attempt_id === undefined || s.attempt_id === null || s.attempt_id === MAKER_FALLBACK_1);
}

/**
 * Validates a primary MAKER_FIRST callback against its OWN Queue row: the row must have frozen
 * execution_mode=MAKER_FIRST, every reported attempt id / mode must be exactly MAKER_FIRST, the
 * exact identity must match, and reported price / quantity may never exceed the frozen maker
 * limit / shares. Returns the row on success. Pure apart from the row load.
 */
export async function validatePrimaryMakerCallback(
  load: (key: string) => Promise<EventExecutionQueueRow | null>,
  raw: Record<string, unknown>,
): Promise<{ ok: true; queue: EventExecutionQueueRow } | { ok: false; reason: PrimaryMakerRejectReason }> {
  const fail = (reason: PrimaryMakerRejectReason) => ({ ok: false as const, reason });
  for (const s of attemptSources(raw)) {
    if (s.attempt_id !== undefined && s.attempt_id !== null && s.attempt_id !== MAKER_FIRST) return fail("PRIMARY_MAKER_ATTEMPT_IDENTITY_INVALID");
    if (s.execution_mode !== undefined && s.execution_mode !== null && s.execution_mode !== MAKER_FIRST) return fail("PRIMARY_MAKER_ATTEMPT_IDENTITY_INVALID");
  }
  if (!attemptSources(raw).some((s) => s.attempt_id === MAKER_FIRST)) return fail("PRIMARY_MAKER_ATTEMPT_IDENTITY_INVALID");
  const key = nonEmptyStr(raw.idempotency_key);
  if (!key) return fail("PRIMARY_MAKER_IDEMPOTENCY_KEY_REQUIRED");
  const queue = await load(key);
  if (!queue || !queue.id) return fail("PRIMARY_MAKER_QUEUE_ROW_NOT_FOUND");
  if (t10FrozenExecutionMode(queue.diagnostics) !== "MAKER_FIRST") return fail("PRIMARY_MAKER_NOT_FROZEN_ON_QUEUE_ROW");
  const frozen = readT10FrozenContract(queue);
  if (!frozen.ok || !frozen.contract.maker) return fail("PRIMARY_MAKER_FROZEN_CONTRACT_INVALID");
  const side = raw.side ?? raw.selected_side;
  if (raw.condition_id !== queue.condition_id || raw.token_id !== queue.token_id || side !== queue.side) {
    return fail("PRIMARY_MAKER_IDENTITY_MISMATCH");
  }
  const { maker_limit_price: limit, maker_shares: shares } = frozen.contract.maker;
  const reportedNumbers = (keys: string[]) => attemptSources(raw).flatMap((s) => keys.map((k) => finiteNum(s[k]) ?? finiteNum(Number(s[k] ?? NaN))))
    .filter((n): n is number => n !== null);
  if (reportedNumbers(["submitted_price", "limit_price", "maker_limit_price"]).some((p) => p > limit + 1e-9)) {
    return fail("PRIMARY_MAKER_PRICE_ABOVE_FROZEN_LIMIT");
  }
  if (reportedNumbers(["submitted_size", "requested_quantity", "maker_shares"]).some((q) => q > shares + 1e-9)) {
    return fail("PRIMARY_MAKER_QUANTITY_ABOVE_FROZEN_SHARES");
  }
  return { ok: true, queue };
}

/**
 * THE canonical terminal proven-ZERO predicate (released Ireland execution_result_v1 semantics).
 * True only for a PROVEN_ZERO_* / PROVEN_REJECTED_BEFORE_SUBMISSION class that is terminal with
 * economic_exposure_proven_zero === true (reported, or derived from a released outcome-only envelope).
 * filled_quantity may be absent (outcome-only result: the class itself proves zero), but a reported
 * quantity must be exactly 0. Partial / positive / UNKNOWN_* / non-terminal / unproven never qualify.
 * Used by order-event progression, reconciliation, fallback authorization and the exposure guard.
 */
export function isTerminalProvenZeroResult(r: IrelandExecutionResult | null | undefined): boolean {
  return !!r
    && ZERO_PROOF_CLASSES.has(r.result_class)
    && r.terminal === true
    && r.economic_exposure_proven_zero === true
    && (r.filled_quantity === null || r.filled_quantity === 0);
}

/** Backward-compatible name for {@link isTerminalProvenZeroResult}. */
export const isZeroProofResult = isTerminalProvenZeroResult;

/** Terminal proven ZERO read straight off a callback payload (null-safe; absence is never zero). */
export function callbackIsTerminalProvenZero(raw: Record<string, unknown>): boolean {
  return isTerminalProvenZeroResult(readIrelandExecutionResult(raw, ""));
}

/** The released Ireland class proving the order never reached the venue (no submission, hence no price). */
export const PRE_SUBMISSION_ZERO_CLASS = "PROVEN_REJECTED_BEFORE_SUBMISSION" as const;

// Any of these on a callback is venue evidence that an order existed or filled -- never a pre-submission result.
const PRE_SUBMISSION_FORBIDDEN_VENUE_ID_KEYS = ["clob_order_id", "venue_order_id", "order_id", "order_hash"] as const;
const PRE_SUBMISSION_FORBIDDEN_FILL_KEYS = [
  "executed_size", "filled_size", "executed_shares", "filled_price", "average_fill_price", "actual_fill_price",
  "executed_notional_usd", "making_amount", "taking_amount",
] as const;
// Statuses that assert a fill or a live resting order. Everything else is free-form executor wording and is not
// evidence by itself (the venue-id / fill-fact / transaction checks above carry the exposure proof).
const PRE_SUBMISSION_FORBIDDEN_STATUSES: ReadonlySet<string> = new Set([
  "matched", "filled", "fully_filled", "partially_filled", "partial", "live",
]);

function isAbsentOrZeroFact(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "number") return v === 0;
  if (typeof v === "string") return v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) === 0);
  return false;
}

/**
 * The EXACT authoritative pre-submission proven ZERO (released Ireland PROVEN_REJECTED_BEFORE_SUBMISSION).
 * The order never reached the venue, so the callback legitimately carries no submitted price. True ONLY when ALL hold:
 *   - the reported result class is exactly PROVEN_REJECTED_BEFORE_SUBMISSION (no other class is ever eligible);
 *   - terminal === true AND economic_exposure_proven_zero === true AND a REPORTED filled_quantity of exactly 0;
 *   - no venue order id anywhere on the payload or its result envelopes, no fill fact other than zero, no
 *     transaction hash, and no fill / live-order status word.
 * It is deliberately narrower than callbackIsTerminalProvenZero: PROVEN_ZERO_* classes, partial / positive /
 * UNKNOWN_* results, an unreported quantity and anything carrying venue evidence all return false, so they keep
 * failing closed on the existing authoritative-economics requirements (including a submitted price).
 */
export function isProvenRejectedBeforeSubmissionZero(raw: Record<string, unknown>): boolean {
  const result = readIrelandExecutionResult(raw, "");
  if (!result || result.result_class !== PRE_SUBMISSION_ZERO_CLASS) return false;
  if (result.terminal !== true || result.economic_exposure_proven_zero !== true || result.filled_quantity !== 0) return false;
  if (!isTerminalProvenZeroResult(result) || result.venue_order_id !== null) return false;
  for (const source of attemptSources(raw)) {
    for (const k of PRE_SUBMISSION_FORBIDDEN_VENUE_ID_KEYS) if (nonEmptyStr(source[k]) !== null) return false;
    for (const k of PRE_SUBMISSION_FORBIDDEN_FILL_KEYS) if (!isAbsentOrZeroFact(source[k])) return false;
  }
  const hashes = raw.transaction_hashes;
  if (hashes !== undefined && hashes !== null && !(Array.isArray(hashes) && hashes.length === 0)) return false;
  const status = String(raw.order_status ?? raw.status ?? raw.state ?? "").toLowerCase();
  return !PRE_SUBMISSION_FORBIDDEN_STATUSES.has(status);
}

/**
 * Whether the Queue row's own recorded facts are consistent with a pre-submission zero for THIS attempt: no
 * recorded result of the attempt's slot may show exposure (a recorded non-zero / unknown result wins over a
 * later zero claim), and a primary attempt's row must not already be EXECUTED / SENT (an accepted or sent venue
 * order exists). Used together with isProvenRejectedBeforeSubmissionZero before the submitted-price waiver applies.
 */
export function preSubmissionZeroConsistentWithQueueRow(
  queue: Pick<EventExecutionQueueRow, "status" | "diagnostics">,
  attempt: "PRIMARY" | "FALLBACK",
): boolean {
  const attempts = readExecutionAttempts(queue.diagnostics);
  const slot = attempt === "FALLBACK" ? attempts.maker_fallback_1 : attempts[primaryAttemptSlot(queue)];
  if (slot?.result !== undefined && !isTerminalProvenZeroResult(slot.result)) return false;
  if (attempt === "PRIMARY" && (queue.status === "EXECUTED" || queue.status === "SENT")) return false;
  return true;
}

/** The slot holding the row's primary attempt result (the parent of MAKER_FALLBACK_1). */
export function primaryAttemptSlot(queue: { diagnostics?: Record<string, unknown> | null }): "taker_attempt_1" | "maker_first" {
  return t10FrozenExecutionMode(queue.diagnostics) === "MAKER_FIRST" ? "maker_first" : "taker_attempt_1";
}

/**
 * Monotonic result merge: a recorded positive fill is never replaced by a result reporting a
 * smaller (e.g. zero / unknown) filled quantity. Returns the object to keep.
 */
export function mergeAttemptResult(
  prior: IrelandExecutionResult | undefined,
  next: IrelandExecutionResult,
): IrelandExecutionResult {
  if (prior && (prior.filled_quantity ?? 0) > 0 && (next.filled_quantity ?? 0) < (prior.filled_quantity ?? 0)) return prior;
  // An ambiguous transport result carries no new fact: it never rewrites (duplicate) nor replaces (late/stale) any
  // result already recorded. Only a later TERMINAL / venue-evidenced result upgrades it.
  if (prior && isAmbiguousTransportResult(next)) return prior;
  return next;
}

// ── UNKNOWN_TRANSPORT_CALLBACK_RECEIVER_V1 ────────────────────────────────

/** Queue diagnostics key of the typed NEEDS_RECONCILIATION marker (no new status / enum / migration). */
export const NEEDS_RECONCILIATION_KEY = "needs_reconciliation_v1" as const;
export const NEEDS_RECONCILIATION_STATE = "NEEDS_RECONCILIATION" as const;

/**
 * The typed ambiguous-transport result: UNKNOWN_TRANSPORT, explicitly NON-terminal, exposure neither proven zero
 * nor positive (null), no reported fill. It is NOT a fill and NOT a proven zero -- nothing is inferred from the
 * missing fields. Every other result (UNKNOWN_AFTER_SUBMISSION, any terminal, any reported quantity) is false.
 */
export function isAmbiguousTransportResult(r: IrelandExecutionResult | null | undefined): boolean {
  return !!r
    && r.result_class === "UNKNOWN_TRANSPORT"
    && r.terminal === false
    && r.economic_exposure_proven_zero === null
    && r.filled_quantity === null;
}

/**
 * The EXACT narrow ambiguous-transport callback shape (execution_mode=TAKER, attempt_id=TAKER_ATTEMPT_1,
 * result_class=UNKNOWN_TRANSPORT, terminal=false, economic_exposure_proven_zero null, filled_quantity null,
 * venue_order_id absent). It is deliberately narrower than "an UNKNOWN_* class": a MAKER / MAKER_FIRST attempt,
 * UNKNOWN_AFTER_SUBMISSION, any terminal or fill result, and any payload carrying venue evidence (an order id, a
 * fill fact other than zero, a transaction hash, a fill / live status word) all return false and keep failing
 * closed on the submitted-price requirement.
 */
export function isUnknownTransportNeedsReconciliationCallback(raw: Record<string, unknown>): boolean {
  const result = readIrelandExecutionResult(raw, "");
  if (!isAmbiguousTransportResult(result) || !result) return false;
  if (result.attempt_id !== TAKER_ATTEMPT_1 || result.execution_mode !== "TAKER" || result.venue_order_id !== null) return false;
  for (const source of attemptSources(raw)) {
    if (source.attempt_id != null && source.attempt_id !== TAKER_ATTEMPT_1) return false;
    if (source.execution_mode != null && source.execution_mode !== "TAKER") return false;
    // A reported quantity in ANY source (not only the one the result was read from) contradicts "no reported fill".
    if (source.filled_quantity != null) return false;
    for (const k of PRE_SUBMISSION_FORBIDDEN_VENUE_ID_KEYS) if (nonEmptyStr(source[k]) !== null) return false;
    for (const k of PRE_SUBMISSION_FORBIDDEN_FILL_KEYS) if (!isAbsentOrZeroFact(source[k])) return false;
  }
  const hashes = raw.transaction_hashes;
  if (hashes !== undefined && hashes !== null && !(Array.isArray(hashes) && hashes.length === 0)) return false;
  // Nested raw CLOB response evidence (order id / fill amounts) makes the callback NOT ambiguous: it is judged by the
  // ordinary price-required path, so no venue fact is silently discarded by the marker-only receiver.
  const nestedEvents = objectOrNull(raw.raw_event_json);
  for (const nested of [objectOrNull(raw.raw_response), objectOrNull(nestedEvents?.raw_response)]) {
    if (!nested) continue;
    for (const k of ["orderID", "orderId", "order_id", "orderHash", "order_hash", "clob_order_id", "venue_order_id"]) {
      if (nonEmptyStr(nested[k]) !== null) return false;
    }
    for (const k of ["makingAmount", "takingAmount", "making_amount", "taking_amount", "filled_quantity", "executed_size"]) {
      if (!isAbsentOrZeroFact(nested[k])) return false;
    }
  }
  const status = String(raw.order_status ?? raw.status ?? raw.state ?? "").toLowerCase();
  return !PRE_SUBMISSION_FORBIDDEN_STATUSES.has(status);
}

/**
 * Whether the Queue row's own recorded facts allow accepting an ambiguous-transport callback: the row must still be
 * CLAIMED (a resolved EXECUTED / FAILED / SENT / EXPIRED row is never touched) and the TAKER_ATTEMPT_1 slot may hold
 * nothing or the same ambiguous result -- a recorded terminal / venue-evidenced result always wins.
 */
export function unknownTransportConsistentWithQueueRow(queue: Pick<EventExecutionQueueRow, "status" | "diagnostics">): boolean {
  if (queue.status !== "CLAIMED") return false;
  const recorded = readExecutionAttempts(queue.diagnostics).taker_attempt_1?.result;
  return recorded === undefined || isAmbiguousTransportResult(recorded);
}

/**
 * True while a Queue row carries the unresolved NEEDS_RECONCILIATION marker (the stale-claim sweep must preserve it).
 * The marker stops being "unresolved" once the taker slot records a terminal PROVEN ZERO (no exposure exists, so
 * nothing is hidden by the ordinary lease handling; any authorized fallback command is preserved by the CAS). A
 * recorded fill / partial / unknown-after-submission result keeps the row preserved: exposure is never silently expired.
 */
export function hasUnresolvedNeedsReconciliation(diagnostics: Record<string, unknown> | null | undefined): boolean {
  const marker = objectOrNull(diagnostics?.[NEEDS_RECONCILIATION_KEY]);
  if (marker === null || marker.state !== NEEDS_RECONCILIATION_STATE) return false;
  return !isTerminalProvenZeroResult(readExecutionAttempts(diagnostics).taker_attempt_1?.result);
}

export async function recordResultAndAuthorizeMaker(
  port: MakerFallbackPort,
  raw: Record<string, unknown>,
  now: Date,
): Promise<MakerAuthorizationOutcome> {
  const nowIso = now.toISOString();
  if (isPrimaryMakerCallback(raw)) {
    // PRIMARY maker of a frozen MAKER_FIRST row: record the released outcome on its own slot.
    // It NEVER authorizes MAKER_FALLBACK_1 (a MAKER_FIRST zero-fill is terminal for the event: exposure 0,
    // no second maker) and is never re-labelled as a TAKER attempt.
    const checked = await validatePrimaryMakerCallback((k) => port.loadQueueRowByIdempotencyKey(k), raw);
    if (!checked.ok) return { kind: "MAKER_CALLBACK_REJECTED", reason: checked.reason };
    const primaryResult = readIrelandExecutionResult(raw, nowIso);
    if (!primaryResult) return { kind: "NO_RESULT" };
    await port.recordResult(checked.queue.id as string, "maker_first", primaryResult);
    return { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_first" };
  }
  const isMaker = isMakerAttemptCallback(raw);

  if (isMaker) {
    if (!makerAttemptIdIsValid(raw)) return { kind: "MAKER_CALLBACK_REJECTED", reason: "UNKNOWN_ATTEMPT_ID" };
    // The parent Queue row is the economic identity authority: the maker's own
    // idempotency_key is never treated as a parent key.
    const makerParentKey = nonEmptyStr(raw.parent_idempotency_key);
    if (!makerParentKey) return { kind: "MAKER_CALLBACK_REJECTED", reason: "PARENT_IDEMPOTENCY_KEY_REQUIRED" };
    const parent = await port.loadQueueRowByIdempotencyKey(makerParentKey);
    if (!parent || !parent.id) return { kind: "MAKER_CALLBACK_REJECTED", reason: "PARENT_QUEUE_ROW_NOT_FOUND" };
    const command = readExecutionAttempts(parent.diagnostics).maker_fallback_1?.command;
    if (!command || command.idempotency_key !== nonEmptyStr(raw.idempotency_key) || command.parent_idempotency_key !== makerParentKey) {
      return { kind: "MAKER_CALLBACK_REJECTED", reason: "MAKER_NOT_AUTHORIZED_FOR_PARENT" };
    }
    for (const [reported, authorized] of [[raw.condition_id, command.condition_id], [raw.token_id, command.token_id], [raw.side, command.side]] as const) {
      if (reported != null && reported !== authorized) return { kind: "MAKER_CALLBACK_REJECTED", reason: "IDENTITY_MISMATCH" };
    }
    const makerResult = readIrelandExecutionResult(raw, nowIso);
    if (!makerResult) return { kind: "NO_RESULT" };
    // MAKER is terminal for fallback authorization: record only (monotonic), never a third attempt.
    await port.recordResult(parent.id, "maker_fallback_1", makerResult);
    return { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_fallback_1" };
  }

  const result = readIrelandExecutionResult(raw, nowIso);
  if (!result) return { kind: "NO_RESULT" };

  const parentKey = nonEmptyStr(raw.idempotency_key);
  if (!parentKey) return { kind: "MAKER_BLOCKED", reasons: ["MISSING_IDEMPOTENCY_KEY"] };
  const queue = await port.loadQueueRowByIdempotencyKey(parentKey);
  if (!queue || !queue.id) return { kind: "MAKER_BLOCKED", reasons: ["QUEUE_ROW_NOT_FOUND"] };
  // A non-primary callback on a frozen MAKER_FIRST row is never a TAKER_ATTEMPT_1 result:
  // nothing is recorded and no fallback can follow (no MAKER_FIRST -> TAKER downgrade).
  const frozenMode = t10FrozenExecutionMode(queue.diagnostics);
  if (frozenMode === "MAKER_FIRST" || frozenMode === "INVALID") {
    return { kind: "MAKER_BLOCKED", reasons: ["PRIMARY_MAKER_ROW_NO_FALLBACK"] };
  }

  // A recorded taker result that shows exposure (or is unresolved) is never overwritten by a
  // later callback, and never lets a later zero-proof authorize a maker. The ONE exception is the typed
  // ambiguous transport result (UNKNOWN_TRANSPORT, non-terminal, exposure unknown): it asserts nothing, so a later
  // terminal fill / partial fill (exposure preserved, no fallback) or terminal proven zero (the single
  // MAKER_FALLBACK_1 under the existing TAKER-zero contract) upgrades it exactly once, idempotently (CAS).
  const prior = readExecutionAttempts(queue.diagnostics).taker_attempt_1?.result;
  if (prior && !isAmbiguousTransportResult(prior) && ((prior.filled_quantity !== null && prior.filled_quantity !== 0) || !ZERO_PROOF_CLASSES.has(prior.result_class))) {
    return { kind: "MAKER_BLOCKED", reasons: ["PRIOR_TAKER_RESULT_SHOWS_EXPOSURE_OR_UNRESOLVED"] };
  }

  await port.recordResult(queue.id, "taker_attempt_1", result);
  return authorizeFallback(port, queue, result, raw, now, parentKey);
}

/**
 * Single-winner MAKER_FALLBACK_1 authorization for a TAKER_ATTEMPT_1 terminal proven-zero result
 * (never MAKER_FIRST). Same Queue row, same reservation / condition / token / side,
 * same stake, frozen price authority, pre-kickoff deadline (event start - 60 s). A replay returns the already-claimed command, never a second.
 */
async function authorizeFallback(
  port: MakerFallbackPort,
  queue: EventExecutionQueueRow,
  result: IrelandExecutionResult,
  raw: Record<string, unknown>,
  now: Date,
  parentKey: string,
): Promise<MakerAuthorizationOutcome> {
  const nowIso = now.toISOString();
  if (!queue.id) return { kind: "MAKER_BLOCKED", reasons: ["QUEUE_ROW_NOT_FOUND"] };
  const existing = readExecutionAttempts(queue.diagnostics).maker_fallback_1?.command ?? null;
  if (existing) return { kind: "MAKER_ALREADY_AUTHORIZED", command: existing };

  const verdict = evaluateMakerEligibility({
    result,
    queue,
    reported: {
      condition_id: nonEmptyStr(raw.condition_id),
      token_id: nonEmptyStr(raw.token_id),
      side: nonEmptyStr(raw.side),
    },
    nowMs: now.getTime(),
  });
  if (!verdict.eligible || !verdict.deadline_iso) return { kind: "MAKER_BLOCKED", reasons: verdict.reasons };

  const book = await port.fetchBook(queue.token_id);
  if (!book) return { kind: "MAKER_BLOCKED", reasons: ["BOOK_UNAVAILABLE"] };
  const built = buildMakerFallbackCommand({ queue, book, deadlineIso: verdict.deadline_iso, nowIso });
  if (!built.ok) return { kind: "MAKER_BLOCKED", reasons: [built.reason] };

  const won = await port.claimMakerFallback(queue.id, built.command);
  if (!won) {
    const fresh = await port.loadQueueRowByIdempotencyKey(parentKey);
    return { kind: "MAKER_ALREADY_AUTHORIZED", command: readExecutionAttempts(fresh?.diagnostics).maker_fallback_1?.command ?? null };
  }
  return { kind: "MAKER_AUTHORIZED", command: built.command };
}

/**
 * Outcomes after which a terminal proven-ZERO callback must NOT be acknowledged: the fallback was
 * neither published nor deterministically refused (infrastructure error, book unavailable).
 * Deterministic policy blocks (deadline, below minimum, exposure, lost CAS race, ...) are final.
 */
const RETRYABLE_FALLBACK_BLOCKS: ReadonlySet<string> = new Set(["AUTHORIZATION_ERROR", "BOOK_UNAVAILABLE"]);
export function fallbackPublicationRetryable(outcome: MakerAuthorizationOutcome): boolean {
  return outcome.kind === "MAKER_BLOCKED" && outcome.reasons.some((r) => RETRYABLE_FALLBACK_BLOCKS.has(r));
}

// ── executor-facing Queue contract ────────────────────────────────────────

/**
 * The MAKER_FALLBACK_1 commands surfaced on GET /api/executor/queue (`maker_fallback_commands`):
 * an authorized command with no recorded fallback result, strictly before its stated deadline.
 * The command is returned verbatim from the parent Queue row -- no second Queue row exists.
 * SINGLE_MAKER_PREGAME_CONTRACT_V1 defense in depth for commands authorized BEFORE this contract: only a
 * TAKER_ATTEMPT_1 parent may carry a fallback maker, and when the row's physical start is supplied the surfaced
 * deadline never exceeds start - 60 s (the command is returned with the capped deadline), so no resting BUY maker
 * can survive kickoff even from a pre-contract command (whose deadline was latest_entry = start + 3 min).
 */
export function selectExecutorMakerFallbackCommands(
  rows: readonly { diagnostics: Record<string, unknown> | null; game_start_iso?: string | null }[],
  nowMs: number,
): MakerFallbackCommand[] {
  const out: MakerFallbackCommand[] = [];
  for (const r of rows) {
    const m = readExecutionAttempts(r.diagnostics).maker_fallback_1;
    const c = m?.command;
    if (!c || m.result) continue;
    if (c.parent_attempt_id !== TAKER_ATTEMPT_1) continue;
    // Handoff defense in depth: a command authorized for a non-live family is never surfaced to the executor.
    if (isObservationOnlyMoneyFamily(c.market_family)) continue;
    if (isFounderLiveOffTotalsOver(c.market_family, c.side)) continue;
    const start = typeof r.game_start_iso === "string" ? Date.parse(r.game_start_iso) : null;
    if (start !== null && !Number.isFinite(start)) continue;
    const stated = Date.parse(c.deadline_iso);
    const deadline = start === null ? stated : Math.min(stated, start - MAKER_PREGAME_CUTOFF_SECONDS * 1000);
    if (!(deadline > nowMs)) continue;
    out.push(deadline === stated ? c : { ...c, deadline_iso: new Date(deadline).toISOString() });
  }
  return out;
}

// ── accounting normalization (maker callbacks) ────────────────────────────

const FILL_FACT_KEYS = [
  "executed_size", "filled_size", "executed_shares", "average_fill_price",
  "actual_fill_price", "filled_price", "executed_notional_usd",
] as const;

function round8(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

/**
 * Maps Ireland's maker execution-result scalars onto the field names the existing economic
 * telemetry / reconciliation / ledger path already consumes. Only ACTUAL reported facts are
 * mapped (filled_quantity, average_fill_price, venue_order_id, fee_usd if reported); nothing is
 * derived from planned stake. A result that proves no fill removes any fill-implying fields so a
 * zero-fill maker can never become a ledger fill. Non-maker callbacks are returned untouched.
 */
export function normalizeMakerCallbackForAccounting(raw: Record<string, unknown>): Record<string, unknown> {
  if (!isMakerAttemptCallback(raw) && !isPrimaryMakerCallback(raw)) return raw;
  const result = readIrelandExecutionResult(raw, "");
  const out: Record<string, unknown> = { ...raw };
  if (!result) return out;
  if (!nonEmptyStr(out.clob_order_id) && result.venue_order_id) out.clob_order_id = result.venue_order_id;

  const filled = result.filled_quantity;
  const price = result.average_fill_price;
  const isFillClass = FILL_RESULT_CLASSES.has(result.result_class);
  if (isFillClass && filled !== null && filled > 0 && price !== null && price > 0 && result.venue_order_id) {
    out.executed_shares = filled;
    out.executed_size = filled;
    out.average_fill_price = price;
    out.executed_notional_usd = round8(filled * price);
    out.execution_status = "CONFIRMED";
    if (result.fee_usd !== null) out.fee_usd = result.fee_usd;
  } else if (!isFillClass || filled === 0) {
    for (const k of FILL_FACT_KEYS) delete out[k];
    delete out.making_amount;
    delete out.taking_amount;
    for (const f of ["order_status", "status"] as const) {
      const st = String(out[f] ?? "").toLowerCase();
      if (st === "matched" || st === "filled" || st === "fully_filled") out[f] = "unfilled";
    }
  }
  return out;
}
