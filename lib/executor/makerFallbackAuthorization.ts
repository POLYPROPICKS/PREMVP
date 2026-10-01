// lib/executor/makerFallbackAuthorization.ts
//
// P2_PREMVP_SAFE_TAKER_TO_MAKER_AUTHORIZATION_V1
//
// One reserved physical event may carry TAKER_ATTEMPT_1 and, ONLY on authoritative
// Ireland proof of ZERO economic exposure, exactly one MAKER_FALLBACK_1 on the SAME
// immutable Final Identity. It is a second execution attempt for the SAME economic bet,
// never a second market decision and never a second exposure slot. There is no
// MAKER_FALLBACK_2. Silence is never zero exposure.
//
// The lineage lives on the parent (taker) Queue row at
// diagnostics.execution_attempts_v1 -- no new table, no new Queue row (the Queue's
// (condition_id, token_id, side, plan_run_id) uniqueness and one-position-per-event
// rules stay intact).

import { createHash } from "node:crypto";
import { QUEUE_MAX_ENTRY_PRICE, extractMaxStakeUsd, type EventExecutionQueueRow } from "./executorQueueTypes";

export const EXECUTION_ATTEMPTS_KEY = "execution_attempts_v1" as const;
export const TAKER_ATTEMPT_1 = "TAKER_ATTEMPT_1" as const;
export const MAKER_FALLBACK_1 = "MAKER_FALLBACK_1" as const;
export type AttemptId = typeof TAKER_ATTEMPT_1 | typeof MAKER_FALLBACK_1;
export type ExecutionMode = "TAKER" | "MAKER";

export const IRELAND_RESULT_CLASSES = [
  "FULL_FILL",
  "PARTIAL_FILL",
  "PROVEN_ZERO_FILL_PRICE",
  "PROVEN_ZERO_FILL_NO_LIQUIDITY",
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
  "PROVEN_ZERO_FILL_EXPIRED",
  "PROVEN_REJECTED_BEFORE_SUBMISSION",
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

/**
 * Reads the released Ireland execution-result semantics off a callback payload.
 * Returns null when the callback carries no (recognisable) result class: absence
 * is never mapped to any class, and in particular never to zero exposure.
 */
export function readIrelandExecutionResult(raw: Record<string, unknown>, nowIso: string): IrelandExecutionResult | null {
  const nested = raw.ireland_execution_result;
  const src: Record<string, unknown> =
    nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : raw;
  const cls = nonEmptyStr(src.result_class);
  if (!cls || !(IRELAND_RESULT_CLASSES as readonly string[]).includes(cls)) return null;
  const attempt = nonEmptyStr(src.attempt_id ?? raw.attempt_id);
  const mode = nonEmptyStr(src.execution_mode ?? raw.execution_mode);
  return {
    attempt_id: attempt === TAKER_ATTEMPT_1 || attempt === MAKER_FALLBACK_1 ? attempt : null,
    execution_mode: mode === "TAKER" || mode === "MAKER" ? mode : null,
    result_class: cls as IrelandResultClass,
    requested_quantity: finiteNum(src.requested_quantity),
    filled_quantity: finiteNum(src.filled_quantity),
    remaining_quantity: finiteNum(src.remaining_quantity),
    average_fill_price: finiteNum(src.average_fill_price),
    venue_order_id: nonEmptyStr(src.venue_order_id),
    terminal: strictBool(src.terminal),
    economic_exposure_proven_zero: strictBool(src.economic_exposure_proven_zero),
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
}

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
  | "DEADLINE_PASSED";

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

/** The earlier of the Queue latest-entry deadline and kickoff. Null when unparseable (fails closed). */
export function makerDeadlineIso(queue: Pick<EventExecutionQueueRow, "latest_entry_iso" | "game_start_iso">): string | null {
  const a = Date.parse(queue.latest_entry_iso);
  const b = Date.parse(queue.game_start_iso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return new Date(Math.min(a, b)).toISOString();
}

export function evaluateMakerEligibility(input: MakerEligibilityInput): MakerEligibility {
  const { result, queue, reported, nowMs } = input;
  const reasons: MakerBlockReason[] = [];
  const deadline = makerDeadlineIso(queue);

  if (!result) {
    reasons.push("RESULT_MISSING");
  } else {
    if (result.attempt_id !== TAKER_ATTEMPT_1) reasons.push("ATTEMPT_NOT_TAKER_ATTEMPT_1");
    if (result.execution_mode !== "TAKER") reasons.push("MODE_NOT_TAKER");
    if (!ZERO_PROOF_CLASSES.has(result.result_class)) reasons.push("RESULT_CLASS_CANNOT_PROVE_ZERO");
    if (result.terminal !== true) reasons.push("RESULT_NOT_TERMINAL");
    if (result.filled_quantity !== 0) reasons.push("FILLED_QUANTITY_NOT_ZERO");
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
export type BuildCommandResult =
  | { ok: true; command: MakerFallbackCommand }
  | { ok: false; reason: MakerPriceFailure | "STAKE_UNREPRESENTABLE" | "PRICE_CAP_MISSING" };

/**
 * Builds the explicit MAKER_FALLBACK_1 instruction. Identity and stake are copied verbatim
 * from the parent Queue row; nothing is re-selected and the stake is never increased.
 */
export function buildMakerFallbackCommand(input: {
  queue: EventExecutionQueueRow;
  book: { bestBid: number | null; bestAsk: number | null; tickSize: number | null };
  deadlineIso: string;
  nowIso: string;
}): BuildCommandResult {
  const { queue, book, deadlineIso, nowIso } = input;
  const d = queue.diagnostics ?? {};
  const rawCap = d.max_entry_price;
  const priceCap = typeof rawCap === "number" && Number.isFinite(rawCap) ? rawCap : null;
  if (priceCap === null) return { ok: false, reason: "PRICE_CAP_MISSING" };
  const price = deriveMakerLimitPrice({ bestBid: book.bestBid, bestAsk: book.bestAsk, tickSize: book.tickSize, priceCap });
  if (!price.ok) return { ok: false, reason: price.reason };

  const maxStake = extractMaxStakeUsd(d, queue.stake_usd);
  const stake = queue.stake_usd; // never above the original authorized stake
  const quantity = Math.floor((stake / price.limit_price) * 100) / 100;
  if (!(quantity > 0) || quantity * price.limit_price > Math.min(stake, maxStake) + 1e-9) {
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
  fetchBook(tokenId: string): Promise<{ bestBid: number | null; bestAsk: number | null; tickSize: number | null } | null>;
  /** Persist a result under diagnostics.execution_attempts_v1.<slot>.result (last write wins, never authorizes). */
  recordResult(queueId: string, slot: "taker_attempt_1" | "maker_fallback_1", result: IrelandExecutionResult): Promise<void>;
  /**
   * Atomic compare-and-set: writes maker_fallback_1.command only if none exists yet.
   * Returns true for the single winner; false for every replay / concurrent loser.
   */
  claimMakerFallback(queueId: string, command: MakerFallbackCommand): Promise<boolean>;
}

export type MakerAuthorizationOutcome =
  | { kind: "NO_RESULT" }
  | { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT"; slot: "taker_attempt_1" | "maker_fallback_1" }
  | { kind: "MAKER_AUTHORIZED"; command: MakerFallbackCommand }
  | { kind: "MAKER_ALREADY_AUTHORIZED"; command: MakerFallbackCommand | null }
  | { kind: "MAKER_BLOCKED"; reasons: string[] };

export async function recordResultAndAuthorizeMaker(
  port: MakerFallbackPort,
  raw: Record<string, unknown>,
  now: Date,
): Promise<MakerAuthorizationOutcome> {
  const nowIso = now.toISOString();
  const result = readIrelandExecutionResult(raw, nowIso);
  if (!result) return { kind: "NO_RESULT" };

  // Maker callbacks identify their own attempt; they key to the parent Queue row.
  const parentKey = nonEmptyStr(raw.parent_idempotency_key) ?? nonEmptyStr(raw.idempotency_key);
  if (!parentKey) return { kind: "MAKER_BLOCKED", reasons: ["MISSING_IDEMPOTENCY_KEY"] };
  const queue = await port.loadQueueRowByIdempotencyKey(parentKey);
  if (!queue || !queue.id) return { kind: "MAKER_BLOCKED", reasons: ["QUEUE_ROW_NOT_FOUND"] };

  // MAKER is terminal for fallback authorization: record only, never a third attempt.
  if (result.attempt_id === MAKER_FALLBACK_1 || result.execution_mode === "MAKER") {
    await port.recordResult(queue.id, "maker_fallback_1", result);
    return { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_fallback_1" };
  }

  // A recorded taker result that shows exposure (or is unresolved) is never overwritten by a
  // later callback, and never lets a later zero-proof authorize a maker.
  const prior = readExecutionAttempts(queue.diagnostics).taker_attempt_1?.result;
  if (prior && (prior.filled_quantity !== 0 || !ZERO_PROOF_CLASSES.has(prior.result_class))) {
    return { kind: "MAKER_BLOCKED", reasons: ["PRIOR_TAKER_RESULT_SHOWS_EXPOSURE_OR_UNRESOLVED"] };
  }

  await port.recordResult(queue.id, "taker_attempt_1", result);

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
