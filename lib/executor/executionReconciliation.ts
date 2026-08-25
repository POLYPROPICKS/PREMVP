/**
 * Canonical execution-reconciliation state stored inside
 * executor_order_events.executor_meta.reconciliation_v1.
 *
 * executor_order_events is already unique on idempotency_key and
 * clob_order_id, so keeping reconciliation on that row preserves one
 * economic authority. The dormant bet_execution_ledger table is deliberately
 * not used: current PREMVP source has no producer/consumer contract for it.
 */

import type { EconomicTelemetryV1 } from "./economicTelemetry";

export const EXECUTION_RECONCILIATION_VERSION = "EXECUTION_RECONCILIATION_V1" as const;

export type FillStatus = "ACCEPTED_OPEN" | "MATCHED_CONFIRMED";
export type SettlementStatus =
  | "PENDING_FILL_CONFIRMATION"
  | "PENDING_MARKET_RESOLUTION"
  | "RESOLVED_AWAITING_FILL_CONFIRMATION"
  | "RESOLVED_FEE_PENDING"
  | "SETTLED_RECONCILED";
export type FeeStatus = "PENDING_FILL_CONFIRMATION" | "NOT_REPORTED" | "REPORTED";
export type ResultStatus = "PENDING" | "WON" | "LOST";

export interface ExecutionReconciliationV1 {
  version: typeof EXECUTION_RECONCILIATION_VERSION;
  reconciliation_key: string;
  queue_id: string;
  reservation_id: string | null;
  source_signal_pair_id: string | null;
  provider_event_id: string | null;
  order_event_id: string;
  condition_id: string;
  token_id: string;
  side: string;
  idempotency_key: string;
  clob_order_id: string;
  submitted_price: number;
  requested_shares: number;
  requested_notional_usd: number;
  authorized_stake_ceiling_usd: number;
  fill_status: FillStatus;
  executed_shares: number | null;
  actual_fill_price: number | null;
  executed_notional_usd: number | null;
  settlement_status: SettlementStatus;
  result_status: ResultStatus;
  resolved_at: string | null;
  winning_outcome: string | null;
  winning_token_id: string | null;
  fee_status: FeeStatus;
  fee_usd: number | null;
  gross_pnl_usd: number | null;
  net_pnl_usd: number | null;
}

export interface ReconciliationQueueRow {
  id?: string;
  reservation_id: string | null;
  condition_id: string;
  token_id: string;
  side: string;
  idempotency_key: string | null;
  stake_usd: number;
  diagnostics: Record<string, unknown>;
}

export interface ReconciliationOrderEvent {
  id: string;
  created_at: string;
  condition_id: string | null;
  token_id: string;
  side: string | null;
  selected_side?: string | null;
  idempotency_key: string | null;
  clob_order_id: string | null;
  submitted_price: number | null;
  submitted_size: number | null;
  making_amount?: number | null;
  taking_amount?: number | null;
  fee_usd?: number | null;
}

export interface ResolvedExecutionOutcome {
  resolved_at: string;
  winning_outcome: string | null;
  winning_token_id: string | null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

function sourceSignalPairId(diagnostics: Record<string, unknown>): string | null {
  const direct = diagnostics.selected_signal_pair_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const lineage = diagnostics.source_lineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) return null;
  const nested = (lineage as Record<string, unknown>).generated_signal_pair_id;
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

function isMatched(raw: Record<string, unknown>, prior?: ExecutionReconciliationV1): boolean {
  if (prior?.fill_status === "MATCHED_CONFIRMED") return true;
  const status = String(raw.order_status ?? raw.status ?? raw.state ?? "").toLowerCase();
  return status === "matched" || status === "filled" || status === "fully_filled";
}

function explicitExecutedShares(
  raw: Record<string, unknown>,
  event: ReconciliationOrderEvent,
  matched: boolean,
  prior?: ExecutionReconciliationV1,
): number | null {
  const explicit =
    finiteNumber(raw.executed_size) ??
    finiteNumber(raw.filled_size) ??
    finiteNumber(raw.taking_amount) ??
    finiteNumber(event.taking_amount);
  if (explicit != null && explicit > 0) return explicit;
  if (prior?.executed_shares != null) return prior.executed_shares;
  // A terminal matched/filled callback confirms its submitted quantity. An
  // accepted_open callback does not: requested shares must never be relabelled
  // as executed merely because the venue accepted the order.
  if (matched) return finiteNumber(raw.submitted_size) ?? event.submitted_size;
  return null;
}

function explicitFee(
  raw: Record<string, unknown>,
  event: ReconciliationOrderEvent,
  prior?: ExecutionReconciliationV1,
): number | null {
  const reported = finiteNumber(raw.fee_usd);
  if (reported != null) return reported;
  if (event.fee_usd != null) return event.fee_usd;
  return prior?.fee_usd ?? null;
}

function providerEventId(diagnostics: Record<string, unknown>): string | null {
  const direct = diagnostics.provider_event_id ?? diagnostics.providerEventId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const lineage = diagnostics.source_lineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) return null;
  const nested = (lineage as Record<string, unknown>).provider_event_id ?? (lineage as Record<string, unknown>).providerEventId;
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

function requireSameIdentity(expected: string | null, actual: unknown, field: string): void {
  if (actual == null || actual === "") return;
  if (typeof actual !== "string" || actual !== expected) {
    throw new Error(`RECONCILIATION_IDENTITY_CONFLICT_${field}`);
  }
}

function assertTelemetryIdentity(
  telemetry: EconomicTelemetryV1,
  identity: Pick<ExecutionReconciliationV1, "queue_id" | "reservation_id" | "condition_id" | "token_id" | "side" | "idempotency_key" | "clob_order_id">,
): void {
  for (const key of ["queue_id", "reservation_id", "condition_id", "token_id", "side", "idempotency_key", "clob_order_id"] as const) {
    if (telemetry.identity[key] !== identity[key]) throw new Error(`RECONCILIATION_TELEMETRY_IDENTITY_CONFLICT_${key.toUpperCase()}`);
  }
}

function assertPriorIdentity(prior: ExecutionReconciliationV1, next: ExecutionReconciliationV1): void {
  for (const key of ["queue_id", "source_signal_pair_id", "provider_event_id", "condition_id", "token_id", "side", "idempotency_key", "clob_order_id", "order_event_id"] as const) {
    if (prior[key] !== next[key]) throw new Error(`RECONCILIATION_IDENTITY_CONFLICT_${key.toUpperCase()}`);
  }
}

function isConfirmedTelemetry(telemetry: EconomicTelemetryV1 | undefined): telemetry is EconomicTelemetryV1 {
  if (!telemetry || telemetry.executed.execution_status?.toUpperCase() !== "CONFIRMED") return false;
  const { executed_shares, average_fill_price, executed_notional_usd } = telemetry.executed;
  return executed_shares.evidence_state === "KNOWN" && executed_shares.value != null && executed_shares.value > 0 &&
    average_fill_price.evidence_state === "KNOWN" && average_fill_price.value != null && average_fill_price.value > 0 &&
    executed_notional_usd.evidence_state === "KNOWN" && executed_notional_usd.value != null && executed_notional_usd.value > 0;
}

/**
 * Advances an already-persisted reconciliation from its canonical telemetry
 * without re-reading Queue or order-event inputs. This is used by bounded
 * lifecycle recovery so an existing ACCEPTED_OPEN row can become filled even
 * when no further executor callback arrives.
 */
export function advanceExecutionReconciliationFromTelemetry(
  prior: ExecutionReconciliationV1,
  telemetry: EconomicTelemetryV1 | null | undefined,
): ExecutionReconciliationV1 {
  if (!telemetry) return prior;
  assertTelemetryIdentity(telemetry, prior);
  if (!isConfirmedTelemetry(telemetry)) return prior;
  const executedShares = telemetry.executed.executed_shares.value!;
  const actualFillPrice = telemetry.executed.average_fill_price.value!;
  const executedNotional = telemetry.executed.executed_notional_usd.value!;
  if (prior.executed_shares != null && executedShares < prior.executed_shares) {
    throw new Error("RECONCILIATION_TELEMETRY_FILL_DOWNGRADE");
  }
  const calculatedNotional = roundMoney(executedShares * actualFillPrice);
  if (calculatedNotional !== executedNotional) throw new Error("RECONCILIATION_TELEMETRY_EXECUTED_NOTIONAL_MISMATCH");
  const feeUsd = telemetry.costs.fee_usd.evidence_state === "KNOWN"
    ? telemetry.costs.fee_usd.value
    : prior.fee_usd;
  const next: ExecutionReconciliationV1 = {
    ...prior,
    fill_status: "MATCHED_CONFIRMED",
    executed_shares: executedShares,
    actual_fill_price: actualFillPrice,
    executed_notional_usd: executedNotional,
    settlement_status: prior.resolved_at ? prior.settlement_status : "PENDING_MARKET_RESOLUTION",
    fee_status: feeUsd == null ? "NOT_REPORTED" : "REPORTED",
    fee_usd: feeUsd,
  };
  if (next.resolved_at) {
    return applyResolvedOutcomeToExecutionReconciliation(next, {
      resolved_at: next.resolved_at,
      winning_outcome: next.winning_outcome,
      winning_token_id: next.winning_token_id,
    });
  }
  return next;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`RECONCILIATION_MISSING_${field}`);
  return value;
}

export function buildExecutionReconciliation(input: {
  queue: ReconciliationQueueRow;
  event: ReconciliationOrderEvent;
  raw: Record<string, unknown>;
  prior?: ExecutionReconciliationV1;
  telemetry?: EconomicTelemetryV1;
}): ExecutionReconciliationV1 {
  const { queue, event, raw, prior, telemetry } = input;
  const queueId = requireString(queue.id, "QUEUE_ID");
  const idempotencyKey = requireString(queue.idempotency_key, "IDEMPOTENCY_KEY");
  const clobOrderId = requireString(event.clob_order_id, "CLOB_ORDER_ID");
  const conditionId = requireString(queue.condition_id, "CONDITION_ID");
  const tokenId = requireString(queue.token_id, "TOKEN_ID");
  const side = requireString(queue.side, "SIDE");
  const submittedPrice = finiteNumber(event.submitted_price ?? raw.submitted_price);
  const requestedShares = finiteNumber(event.submitted_size ?? raw.submitted_size);
  if (submittedPrice == null || submittedPrice <= 0) throw new Error("RECONCILIATION_MISSING_SUBMITTED_PRICE");
  if (requestedShares == null || requestedShares <= 0) throw new Error("RECONCILIATION_MISSING_SUBMITTED_SIZE");

  requireSameIdentity(conditionId, event.condition_id, "CONDITION_ID");
  requireSameIdentity(tokenId, event.token_id, "TOKEN_ID");
  requireSameIdentity(side, event.side ?? event.selected_side, "SIDE");
  requireSameIdentity(idempotencyKey, event.idempotency_key, "IDEMPOTENCY_KEY");
  requireSameIdentity(queueId, raw.queue_id, "QUEUE_ID");
  requireSameIdentity(queue.reservation_id, raw.reservation_id, "RESERVATION_ID");
  requireSameIdentity(sourceSignalPairId(queue.diagnostics ?? {}), raw.source_signal_pair_id ?? raw.signal_pair_id, "SOURCE_SIGNAL_PAIR_ID");
  requireSameIdentity(conditionId, raw.condition_id, "CONDITION_ID");
  requireSameIdentity(tokenId, raw.token_id, "TOKEN_ID");
  requireSameIdentity(side, raw.side, "SIDE");
  requireSameIdentity(side, raw.selected_side, "SIDE");
  requireSameIdentity(idempotencyKey, raw.idempotency_key, "IDEMPOTENCY_KEY");
  requireSameIdentity(clobOrderId, raw.clob_order_id, "CLOB_ORDER_ID");

  if (isConfirmedTelemetry(telemetry) && prior?.executed_shares != null && telemetry.executed.executed_shares.value! < prior.executed_shares) {
    throw new Error("RECONCILIATION_TELEMETRY_FILL_DOWNGRADE");
  }
  const matched = isConfirmedTelemetry(telemetry) || isMatched(raw, prior);
  const legacyActualFillPrice = finiteNumber(raw.average_fill_price) ?? finiteNumber(raw.actual_fill_price) ?? finiteNumber(raw.filled_price);
  const executedShares = isConfirmedTelemetry(telemetry)
    ? Math.max(prior?.executed_shares ?? 0, telemetry.executed.executed_shares.value!)
    : explicitExecutedShares(raw, event, matched, prior);
  const actualFillPrice = isConfirmedTelemetry(telemetry)
    ? telemetry.executed.average_fill_price.value!
    : legacyActualFillPrice ?? prior?.actual_fill_price ?? null;
  const executedNotional = isConfirmedTelemetry(telemetry)
    ? telemetry.executed.executed_notional_usd.value!
    : executedShares != null && actualFillPrice != null ? roundMoney(executedShares * actualFillPrice) : null;
  const feeUsd = telemetry
    ? telemetry.costs.fee_usd.evidence_state === "KNOWN" ? telemetry.costs.fee_usd.value : prior?.fee_usd ?? null
    : explicitFee(raw, event, prior);
  const feeStatus: FeeStatus = !matched
    ? "PENDING_FILL_CONFIRMATION"
    : feeUsd == null
      ? "NOT_REPORTED"
      : "REPORTED";

  const base: ExecutionReconciliationV1 = {
    version: EXECUTION_RECONCILIATION_VERSION,
    reconciliation_key: idempotencyKey,
    queue_id: queueId,
    reservation_id: queue.reservation_id,
    source_signal_pair_id: sourceSignalPairId(queue.diagnostics ?? {}),
    provider_event_id: providerEventId(queue.diagnostics ?? {}),
    order_event_id: event.id,
    condition_id: conditionId,
    token_id: tokenId,
    side,
    idempotency_key: idempotencyKey,
    clob_order_id: clobOrderId,
    submitted_price: submittedPrice,
    requested_shares: requestedShares,
    requested_notional_usd: roundMoney(submittedPrice * requestedShares),
    authorized_stake_ceiling_usd: queue.stake_usd,
    fill_status: matched ? "MATCHED_CONFIRMED" : "ACCEPTED_OPEN",
    executed_shares: executedShares,
    actual_fill_price: actualFillPrice,
    executed_notional_usd: executedNotional,
    settlement_status: matched ? "PENDING_MARKET_RESOLUTION" : "PENDING_FILL_CONFIRMATION",
    result_status: prior?.result_status ?? "PENDING",
    resolved_at: prior?.resolved_at ?? null,
    winning_outcome: prior?.winning_outcome ?? null,
    winning_token_id: prior?.winning_token_id ?? null,
    fee_status: feeStatus,
    fee_usd: feeUsd,
    gross_pnl_usd: prior?.gross_pnl_usd ?? null,
    net_pnl_usd: prior?.net_pnl_usd ?? null,
  };

  if (telemetry) assertTelemetryIdentity(telemetry, base);
  if (prior) assertPriorIdentity(prior, base);

  if (base.resolved_at) {
    return applyResolvedOutcomeToExecutionReconciliation(base, {
      resolved_at: base.resolved_at,
      winning_outcome: base.winning_outcome,
      winning_token_id: base.winning_token_id,
    });
  }
  return base;
}

export function applyResolvedOutcomeToExecutionReconciliation(
  prior: ExecutionReconciliationV1,
  resolution: ResolvedExecutionOutcome,
): ExecutionReconciliationV1 {
  const base = {
    ...prior,
    resolved_at: resolution.resolved_at,
    winning_outcome: resolution.winning_outcome,
    winning_token_id: resolution.winning_token_id,
  };

  if (prior.fill_status !== "MATCHED_CONFIRMED" || prior.executed_shares == null || prior.executed_notional_usd == null) {
    return {
      ...base,
      settlement_status: "RESOLVED_AWAITING_FILL_CONFIRMATION",
      result_status: "PENDING",
      gross_pnl_usd: null,
      net_pnl_usd: null,
    };
  }

  const won = resolution.winning_token_id === prior.token_id;
  const grossPnl = won
    ? prior.executed_shares - prior.executed_notional_usd
    : -prior.executed_notional_usd;
  const roundedGross = roundMoney(grossPnl);
  const hasFee = prior.fee_status === "REPORTED" && prior.fee_usd != null;
  return {
    ...base,
    settlement_status: hasFee ? "SETTLED_RECONCILED" : "RESOLVED_FEE_PENDING",
    result_status: won ? "WON" : "LOST",
    gross_pnl_usd: roundedGross,
    net_pnl_usd: hasFee ? roundMoney(roundedGross - prior.fee_usd!) : null,
  };
}

export function mergeExecutionReconciliationMeta(
  existingMeta: Record<string, unknown> | null | undefined,
  reconciliation: ExecutionReconciliationV1,
): Record<string, unknown> {
  return { ...(existingMeta ?? {}), reconciliation_v1: reconciliation };
}

export function readExecutionReconciliation(
  meta: unknown,
): ExecutionReconciliationV1 | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>).reconciliation_v1;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<ExecutionReconciliationV1>;
  return record.version === EXECUTION_RECONCILIATION_VERSION
    ? (record as ExecutionReconciliationV1)
    : null;
}
