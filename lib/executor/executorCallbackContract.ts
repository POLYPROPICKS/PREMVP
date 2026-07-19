// lib/executor/executorCallbackContract.ts
//
// Shared PREMVP <-> Ireland callback contract (P0 hardening).
//
// Pure orchestration logic only — no Supabase client import, no network, no
// side effects beyond the narrow DbPort interfaces below. Route handlers wire
// a real Supabase-backed port and call these functions; tests inject a fake
// in-memory port that faithfully reproduces PostgREST insert/unique-violation
// semantics, so the FULL request-handling logic (validation, cross-check,
// duplicate/conflict classification, idempotent no-op behavior) is exercised
// exactly as the routes exercise it in production — only the I/O boundary is
// swapped.
//
// Canonical join for cross-endpoint verification: idempotency_key, with a
// mandatory identity cross-check on condition_id/token_id/side. This module
// does NOT reference executor_order_events.queue_id — that column does not
// exist in the live schema (proven by a live 42703 error and a full
// information_schema column dump; queue_id was never an accepted Ireland
// request field, only a stale server-side insert attempt that has been
// removed at the route).

import { validateOrderEventAgainstQueueRow, type EventExecutionQueueRow, type OrderEventSubmission } from "./executorQueueTypes";

// ── shared status contract (single source of truth) ────────────────────────

export type QueueStatus =
  | "READY"
  | "CLAIMED"
  | "SENT"
  | "EXECUTED"
  | "SKIPPED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

/** Full backward-compatible persisted union — every status ever written by any source path. */
export const QUEUE_PERSISTED_STATUSES: readonly QueueStatus[] = [
  "READY",
  "CLAIMED",
  "SENT",
  "EXECUTED",
  "SKIPPED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
];

/** Narrower mutation subset accepted by POST /api/executor/queue/mark. */
export const QUEUE_MARK_ACCEPTED_STATUSES: readonly QueueStatus[] = [
  "CLAIMED",
  "EXECUTED",
  "SKIPPED",
  "FAILED",
  "EXPIRED",
];

/** Terminal statuses required by P0 — protected against silent downgrade. */
export const QUEUE_TERMINAL_STATUSES: readonly QueueStatus[] = ["EXECUTED"];

export function isQueueMarkAcceptedStatus(value: unknown): value is QueueStatus {
  return typeof value === "string" && (QUEUE_MARK_ACCEPTED_STATUSES as readonly string[]).includes(value);
}

export function isTerminalQueueStatus(status: string): boolean {
  return (QUEUE_TERMINAL_STATUSES as readonly string[]).includes(status);
}

// ── canonical order-event identity ──────────────────────────────────────────

/**
 * The fields that define "the same callback event" for duplicate/conflict
 * classification. Deliberately excludes server-generated timestamps,
 * database IDs, and logging-only metadata (executor_meta, raw_event_json,
 * transaction_hashes, cost/fee diagnostics) — those may legitimately vary
 * across retries of the identical economic event.
 */
export interface OrderEventCanonicalPayload {
  idempotency_key: string;
  condition_id: string | null;
  token_id: string;
  side: string | null;
  market_slug: string | null;
  submitted_size: number | null;
  submitted_price: number | null;
  clob_order_id: string | null;
}

export function projectCanonicalOrderEventPayload(record: Record<string, unknown>): OrderEventCanonicalPayload {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    idempotency_key: str(record.idempotency_key) ?? "",
    condition_id: str(record.condition_id),
    token_id: str(record.token_id) ?? "",
    side: str(record.side ?? record.selected_side),
    market_slug: str(record.market_slug),
    submitted_size: num(record.submitted_size),
    submitted_price: num(record.submitted_price),
    clob_order_id: str(record.clob_order_id),
  };
}

export function canonicalPayloadsEqual(a: OrderEventCanonicalPayload, b: OrderEventCanonicalPayload): boolean {
  return (
    a.idempotency_key === b.idempotency_key &&
    a.condition_id === b.condition_id &&
    a.token_id === b.token_id &&
    a.side === b.side &&
    a.market_slug === b.market_slug &&
    a.submitted_size === b.submitted_size &&
    a.submitted_price === b.submitted_price &&
    a.clob_order_id === b.clob_order_id
  );
}

// ── order-event submission orchestration ────────────────────────────────────

export interface StoredOrderEvent {
  id: string;
  created_at: string;
  idempotency_key: string | null;
  condition_id: string | null;
  token_id: string;
  side: string | null;
  selected_side: string | null;
  market_slug: string | null;
  submitted_size: number | null;
  submitted_price: number | null;
  clob_order_id: string | null;
}

function canonicalFromStoredEvent(row: StoredOrderEvent): OrderEventCanonicalPayload {
  return {
    idempotency_key: row.idempotency_key ?? "",
    condition_id: row.condition_id,
    token_id: row.token_id,
    side: row.side ?? row.selected_side,
    market_slug: row.market_slug,
    submitted_size: row.submitted_size,
    submitted_price: row.submitted_price,
    clob_order_id: row.clob_order_id,
  };
}

export type InsertOrderEventFailure =
  | { ok: false; code: "UNIQUE_VIOLATION_IDEMPOTENCY_KEY"; message: string }
  | { ok: false; code: "UNIQUE_VIOLATION_CLOB_ORDER_ID"; message: string }
  | { ok: false; code: "OTHER"; message: string };

export interface OrderEventDbPort {
  findQueueRowByIdempotencyKey(key: string): Promise<EventExecutionQueueRow | null>;
  findOrderEventByIdempotencyKey(key: string): Promise<StoredOrderEvent | null>;
  findOrderEventByClobOrderId(clobOrderId: string): Promise<StoredOrderEvent | null>;
  /** `queueRow` is the already-verified queue row, passed through so the
   * insert can source fixture/queue linkage fields (match_family_key,
   * reservation_id) from trusted server data rather than the untrusted
   * client payload — never from executor_order_events.queue_id, which does
   * not exist in the live schema. */
  insertOrderEvent(record: Record<string, unknown>, queueRow: EventExecutionQueueRow): Promise<{ ok: true; row: StoredOrderEvent } | InsertOrderEventFailure>;
}

export type OrderEventOutcome =
  | { kind: "INSERTED"; row: StoredOrderEvent }
  | { kind: "DUPLICATE"; row: StoredOrderEvent }
  | { kind: "CONFLICT_IDEMPOTENCY" }
  | { kind: "CONFLICT_CLOB_ORDER_ID" }
  | { kind: "REJECTED_MISSING_TOKEN_ID" }
  | { kind: "REJECTED_MISSING_IDEMPOTENCY_KEY" }
  | { kind: "REJECTED_QUEUE_ROW_NOT_FOUND" }
  | { kind: "REJECTED_QUEUE_POLICY_MISMATCH"; reason: string }
  | { kind: "DB_ERROR"; message: string };

/**
 * Full order-event submission orchestration: validate -> load the queue row
 * for cross-check -> pre-check for an existing idempotency_key row ->
 * classify duplicate vs conflict -> insert, re-reading the canonical row on a
 * concurrent unique-violation race rather than trusting the pre-check alone.
 * Never touches executor_order_events.queue_id (does not exist live).
 */
export async function handleOrderEventSubmission(
  port: OrderEventDbPort,
  raw: Record<string, unknown>,
): Promise<OrderEventOutcome> {
  const tokenId = typeof raw.token_id === "string" && raw.token_id.length > 0 ? raw.token_id : null;
  if (!tokenId) return { kind: "REJECTED_MISSING_TOKEN_ID" };

  const idempotencyKey = typeof raw.idempotency_key === "string" && raw.idempotency_key.length > 0 ? raw.idempotency_key : null;
  if (!idempotencyKey) return { kind: "REJECTED_MISSING_IDEMPOTENCY_KEY" };

  const queueRow = await port.findQueueRowByIdempotencyKey(idempotencyKey);
  if (!queueRow) return { kind: "REJECTED_QUEUE_ROW_NOT_FOUND" };

  const submission: OrderEventSubmission = {
    idempotency_key: idempotencyKey,
    token_id: tokenId,
    condition_id: typeof raw.condition_id === "string" ? raw.condition_id : null,
    side: typeof (raw.side ?? raw.selected_side) === "string" ? ((raw.side ?? raw.selected_side) as string) : null,
    market_slug: typeof raw.market_slug === "string" ? raw.market_slug : null,
    submitted_size: typeof (raw.submitted_size ?? raw.stake_usd) === "number" ? (raw.submitted_size ?? raw.stake_usd) as number : null,
    submitted_price: typeof raw.submitted_price === "number" ? raw.submitted_price : null,
  };
  const validation = validateOrderEventAgainstQueueRow(submission, queueRow);
  if (!validation.ok) return { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: validation.reason };

  const canonical = projectCanonicalOrderEventPayload(raw);

  const existingByIdempotency = await port.findOrderEventByIdempotencyKey(idempotencyKey);
  if (existingByIdempotency) {
    return canonicalPayloadsEqual(canonical, canonicalFromStoredEvent(existingByIdempotency))
      ? { kind: "DUPLICATE", row: existingByIdempotency }
      : { kind: "CONFLICT_IDEMPOTENCY" };
  }

  if (canonical.clob_order_id) {
    const existingByClob = await port.findOrderEventByClobOrderId(canonical.clob_order_id);
    if (existingByClob) return { kind: "CONFLICT_CLOB_ORDER_ID" };
  }

  const insertResult = await port.insertOrderEvent(raw, queueRow);
  if (insertResult.ok) return { kind: "INSERTED", row: insertResult.row };

  if (insertResult.code === "UNIQUE_VIOLATION_IDEMPOTENCY_KEY") {
    // Lost the race — re-read the canonical row a concurrent writer inserted.
    const canonicalRow = await port.findOrderEventByIdempotencyKey(idempotencyKey);
    if (!canonicalRow) return { kind: "DB_ERROR", message: "UNIQUE_VIOLATION_BUT_ROW_NOT_FOUND" };
    return canonicalPayloadsEqual(canonical, canonicalFromStoredEvent(canonicalRow))
      ? { kind: "DUPLICATE", row: canonicalRow }
      : { kind: "CONFLICT_IDEMPOTENCY" };
  }
  if (insertResult.code === "UNIQUE_VIOLATION_CLOB_ORDER_ID") return { kind: "CONFLICT_CLOB_ORDER_ID" };
  return { kind: "DB_ERROR", message: insertResult.message };
}

// ── queue-mark EXECUTED verification ────────────────────────────────────────

export interface QueueMarkRow {
  id: string;
  status: string;
  idempotency_key: string | null;
  condition_id: string | null;
  token_id: string | null;
  side: string | null;
  order_key: string | null;
  match_family_key: string | null;
  stake_usd: number | null;
  diagnostics: Record<string, unknown>;
}

export interface QueueMarkDbPort {
  findQueueRow(queueId: string): Promise<QueueMarkRow | null>;
  findOrderEventForIdentity(input: { idempotency_key: string; condition_id: string | null; token_id: string | null; side: string | null }): Promise<StoredOrderEvent | null>;
  updateQueueStatus(queueId: string, patch: { status: QueueStatus; diagnostics: Record<string, unknown> }): Promise<QueueMarkRow>;
}

export type QueueMarkOutcome =
  | { kind: "UPDATED"; row: QueueMarkRow }
  | { kind: "IDEMPOTENT_NO_OP"; row: QueueMarkRow }
  | { kind: "REJECTED_EXECUTED_REGRESSION"; row: QueueMarkRow }
  | { kind: "REJECTED_QUEUE_ROW_NOT_FOUND" }
  | { kind: "REJECTED_CONFIRMATION_REQUIRED" }
  | { kind: "REJECTED_MISSING_IDEMPOTENCY_KEY" }
  | { kind: "REJECTED_ORDER_EVENT_REQUIRED" };

/**
 * EXECUTED-specific verification: live_order_confirmed is treated as an
 * Ireland assertion, never sufficient by itself. The queue row's own
 * idempotency_key/condition_id/token_id/side must match a real stored
 * order-event before EXECUTED is permitted. Repeating an already-verified
 * EXECUTED mark is a true no-op — it does not call updateQueueStatus at all,
 * so no duplicate mark_history entry is ever created.
 */
export async function handleQueueMarkExecuted(
  port: QueueMarkDbPort,
  input: { queueId: string; liveOrderConfirmed: boolean; markHistoryEntry: Record<string, unknown> },
): Promise<QueueMarkOutcome> {
  const row = await port.findQueueRow(input.queueId);
  if (!row) return { kind: "REJECTED_QUEUE_ROW_NOT_FOUND" };

  if (row.status === "EXECUTED") {
    // Already verified previously — idempotent no-op, no new audit entry.
    return { kind: "IDEMPOTENT_NO_OP", row };
  }

  if (!input.liveOrderConfirmed) return { kind: "REJECTED_CONFIRMATION_REQUIRED" };

  const idempotencyKey = row.idempotency_key;
  if (!idempotencyKey) return { kind: "REJECTED_MISSING_IDEMPOTENCY_KEY" };

  const matchingEvent = await port.findOrderEventForIdentity({
    idempotency_key: idempotencyKey,
    condition_id: row.condition_id,
    token_id: row.token_id,
    side: row.side,
  });
  if (!matchingEvent) return { kind: "REJECTED_ORDER_EVENT_REQUIRED" };

  const prevDiag = row.diagnostics ?? {};
  const newDiag: Record<string, unknown> = {
    ...prevDiag,
    mark_history: [...(((prevDiag as Record<string, unknown>).mark_history as unknown[]) ?? []), input.markHistoryEntry],
  };
  const updated = await port.updateQueueStatus(input.queueId, { status: "EXECUTED", diagnostics: newDiag });
  return { kind: "UPDATED", row: updated };
}

/** Non-EXECUTED mutation guard: EXECUTED must never be overwritten by a non-EXECUTED status. */
export function rejectsExecutedRegression(currentStatus: string, requestedStatus: string): boolean {
  return currentStatus === "EXECUTED" && requestedStatus !== "EXECUTED";
}
