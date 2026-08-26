/**
 * ECONOMIC_TELEMETRY_V1 is the canonical, append-in-place economic record on
 * executor_order_events.executor_meta.  It deliberately models unavailable
 * venue facts as evidence states: a null numeric value never means zero.
 */
export const ECONOMIC_TELEMETRY_VERSION = "ECONOMIC_TELEMETRY_V1" as const;

export type EconomicEvidenceState = "KNOWN" | "NOT_RETURNED_BY_VENUE" | "NOT_YET_AVAILABLE" | "NOT_APPLICABLE";
export type WalletLifecyclePoint = "PRE_SUBMIT" | "POST_SUBMIT" | "CURRENT_SNAPSHOT" | "UNKNOWN";

export interface EconomicObservation {
  value: number | null;
  evidence_state: EconomicEvidenceState;
}

export interface EconomicTelemetryV1 {
  version: typeof ECONOMIC_TELEMETRY_VERSION;
  identity: { queue_id: string; reservation_id: string | null; condition_id: string; token_id: string; side: string; idempotency_key: string; clob_order_id: string };
  requested: { authorized_stake_ceiling_usd: number; submitted_price: number; requested_shares: number; requested_notional_usd: number };
  executed: { execution_status: string | null; executed_shares: EconomicObservation; average_fill_price: EconomicObservation; executed_notional_usd: EconomicObservation; making_amount: EconomicObservation; taking_amount: EconomicObservation };
  costs: { fee_rate_bps: EconomicObservation; fee_usd: EconomicObservation; fee_source: string | null; slippage_reference_price: EconomicObservation; slippage_usd: EconomicObservation };
  wallet: { lifecycle_point: WalletLifecyclePoint; observed_at: string | null; collateral_balance_usd: EconomicObservation; spendable_balance_usd: EconomicObservation; allowance_usd: EconomicObservation };
}

export interface EconomicTelemetryQueue {
  id?: string; reservation_id: string | null; condition_id: string; token_id: string; side: string; idempotency_key: string | null; stake_usd: number;
}
export interface EconomicTelemetryEvent { idempotency_key: string | null; clob_order_id: string | null; submitted_price: number | null; submitted_size: number | null; }

function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function str(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function round(value: number): number { return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000; }
function state(value: number | null, supplied: unknown): EconomicEvidenceState {
  if (value !== null) return "KNOWN";
  return supplied === "NOT_RETURNED_BY_VENUE" || supplied === "NOT_APPLICABLE" || supplied === "NOT_YET_AVAILABLE" ? supplied : "NOT_YET_AVAILABLE";
}
function observation(value: unknown, suppliedState: unknown, prior?: EconomicObservation): EconomicObservation {
  const next = finite(value);
  if (next !== null) return { value: next, evidence_state: "KNOWN" };
  if (prior?.evidence_state === "KNOWN") return prior;
  return { value: null, evidence_state: state(null, suppliedState) };
}
function requireString(value: unknown, field: string): string { const result = str(value); if (!result) throw new Error(`ECONOMIC_TELEMETRY_MISSING_${field}`); return result; }
function telemetryInput(raw: Record<string, unknown>): Record<string, unknown> {
  const nested = raw.economic_telemetry_v1;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : raw;
}
function assertSameIdentity(previous: EconomicTelemetryV1, next: EconomicTelemetryV1): void {
  for (const key of ["queue_id", "reservation_id", "condition_id", "token_id", "side", "idempotency_key", "clob_order_id"] as const) {
    if (previous.identity[key] !== next.identity[key]) throw new Error(`ECONOMIC_TELEMETRY_IDENTITY_CONFLICT_${key.toUpperCase()}`);
  }
}

export function buildEconomicTelemetry(input: { queue: EconomicTelemetryQueue; event: EconomicTelemetryEvent; raw: Record<string, unknown>; prior?: EconomicTelemetryV1 }): EconomicTelemetryV1 {
  const { queue, event, raw, prior } = input;
  const payload = telemetryInput(raw);
  const submittedPrice = finite(event.submitted_price ?? raw.submitted_price);
  if (submittedPrice == null || submittedPrice <= 0) throw new Error("ECONOMIC_TELEMETRY_MISSING_SUBMITTED_PRICE");
  let requestedShares = finite(event.submitted_size ?? raw.submitted_size);
  // Callbacks that predate the explicit submitted_size field carry only the
  // authorized stake and the submitted price; requested shares is then exactly
  // reconstructible as stake_usd / submitted_price, not invented data.
  if (requestedShares == null && Number.isFinite(queue.stake_usd) && queue.stake_usd > 0) {
    requestedShares = queue.stake_usd / submittedPrice;
  }
  if (requestedShares == null || requestedShares <= 0) throw new Error("ECONOMIC_TELEMETRY_MISSING_REQUESTED_SHARES");
  const identity = {
    queue_id: requireString(queue.id, "QUEUE_ID"), reservation_id: queue.reservation_id,
    condition_id: requireString(queue.condition_id, "CONDITION_ID"), token_id: requireString(queue.token_id, "TOKEN_ID"), side: requireString(queue.side, "SIDE"),
    idempotency_key: requireString(queue.idempotency_key ?? event.idempotency_key, "IDEMPOTENCY_KEY"), clob_order_id: requireString(event.clob_order_id ?? raw.clob_order_id, "CLOB_ORDER_ID"),
  };
  const executedShares = observation(payload.executed_shares ?? payload.executed_size ?? payload.filled_size, payload.executed_shares_evidence_state, prior?.executed.executed_shares);
  const averageFillPrice = observation(payload.average_fill_price ?? payload.actual_fill_price ?? payload.filled_price, payload.average_fill_price_evidence_state, prior?.executed.average_fill_price);
  const calculatedNotional = executedShares.value != null && averageFillPrice.value != null ? round(executedShares.value * averageFillPrice.value) : null;
  const venueNotional = observation(payload.executed_notional_usd, payload.executed_notional_usd_evidence_state, prior?.executed.executed_notional_usd);
  if (calculatedNotional != null && venueNotional.value != null && calculatedNotional !== venueNotional.value) {
    throw new Error("ECONOMIC_TELEMETRY_EXECUTED_NOTIONAL_MISMATCH");
  }
  const lifecycleCandidate = str(payload.wallet_observation_lifecycle_point) ?? "UNKNOWN";
  const lifecycle: WalletLifecyclePoint = ["PRE_SUBMIT", "POST_SUBMIT", "CURRENT_SNAPSHOT", "UNKNOWN"].includes(lifecycleCandidate) ? lifecycleCandidate as WalletLifecyclePoint : "UNKNOWN";
  // Historical labels require an explicit capture attestation. A current read defaults
  // to CURRENT_SNAPSHOT and can never be silently relabelled as order-time evidence.
  if ((lifecycle === "PRE_SUBMIT" || lifecycle === "POST_SUBMIT") && payload.wallet_capture_evidence !== `CAPTURED_AT_${lifecycle}`) throw new Error("ECONOMIC_TELEMETRY_WALLET_LIFECYCLE_UNPROVEN");
  const next: EconomicTelemetryV1 = {
    version: ECONOMIC_TELEMETRY_VERSION, identity,
    requested: { authorized_stake_ceiling_usd: queue.stake_usd, submitted_price: submittedPrice, requested_shares: requestedShares, requested_notional_usd: round(submittedPrice * requestedShares) },
    executed: { execution_status: str(payload.execution_status ?? payload.order_status ?? payload.status) ?? prior?.executed.execution_status ?? null, executed_shares: executedShares, average_fill_price: averageFillPrice, executed_notional_usd: calculatedNotional != null ? { value: calculatedNotional, evidence_state: "KNOWN" } : venueNotional, making_amount: observation(payload.making_amount, payload.making_amount_evidence_state, prior?.executed.making_amount), taking_amount: observation(payload.taking_amount, payload.taking_amount_evidence_state, prior?.executed.taking_amount) },
    costs: { fee_rate_bps: observation(payload.fee_rate_bps, payload.fee_rate_bps_evidence_state, prior?.costs.fee_rate_bps), fee_usd: observation(payload.fee_usd, payload.fee_usd_evidence_state, prior?.costs.fee_usd), fee_source: str(payload.fee_source) ?? prior?.costs.fee_source ?? null, slippage_reference_price: observation(payload.slippage_reference_price, payload.slippage_reference_price_evidence_state, prior?.costs.slippage_reference_price), slippage_usd: observation(payload.slippage_usd, payload.slippage_usd_evidence_state, prior?.costs.slippage_usd) },
    wallet: { lifecycle_point: lifecycle === "UNKNOWN" && prior?.wallet.lifecycle_point ? prior.wallet.lifecycle_point : lifecycle, observed_at: str(payload.wallet_observed_at) ?? prior?.wallet.observed_at ?? null, collateral_balance_usd: observation(payload.collateral_balance_usd, payload.collateral_balance_usd_evidence_state, prior?.wallet.collateral_balance_usd), spendable_balance_usd: observation(payload.spendable_balance_usd, payload.spendable_balance_usd_evidence_state, prior?.wallet.spendable_balance_usd), allowance_usd: observation(payload.allowance_usd, payload.allowance_usd_evidence_state, prior?.wallet.allowance_usd) },
  };
  if (prior) assertSameIdentity(prior, next);
  return next;
}

export function readEconomicTelemetry(meta: unknown): EconomicTelemetryV1 | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>).economic_telemetry_v1;
  return value && typeof value === "object" && !Array.isArray(value) && (value as { version?: unknown }).version === ECONOMIC_TELEMETRY_VERSION ? value as EconomicTelemetryV1 : null;
}
export function readPersistedEconomicTelemetry(meta: unknown): EconomicTelemetryV1 {
  const telemetry = readEconomicTelemetry(meta);
  if (!telemetry) throw new Error("ECONOMIC_TELEMETRY_PERSISTED_RECORD_MISSING");
  return telemetry;
}
export function mergeEconomicTelemetryMeta(existing: Record<string, unknown> | null | undefined, telemetry: EconomicTelemetryV1): Record<string, unknown> { return { ...(existing ?? {}), economic_telemetry_v1: telemetry }; }
