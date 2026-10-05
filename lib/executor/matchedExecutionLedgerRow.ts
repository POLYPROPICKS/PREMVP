// lib/executor/matchedExecutionLedgerRow.ts
//
// Pure projection of a MATCHED_CONFIRMED execution (taker OR maker attempt) into the
// bet_execution_ledger row. The ledger PK is the order-event PK, so a maker fill is its own
// row on the parent's Reservation / Final Identity and is never merged with a taker row.

import type { EventExecutionQueueRow } from "./executorQueueTypes";
import type { ExecutionReconciliationV1 } from "./executionReconciliation";

function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }
function num(v: unknown): number | null { return typeof v === "number" && isFinite(v) ? v : null; }

export interface LedgerFillEconomics {
  fill_price: number | null;
  executed_stake: number | null;
  fee_paid_real: number | null;
}

/**
 * Authoritative ledger fill economics for a MATCHED_CONFIRMED reconciliation (a partial fill is a
 * MATCHED_CONFIRMED with its own executed notional). Fee is only ever a venue-REPORTED fee; an
 * unreported/unknown fee stays NULL and is never converted to zero.
 */
export function reconciliationLedgerEconomics(reconciliation: ExecutionReconciliationV1): LedgerFillEconomics {
  if (reconciliation.fill_status !== "MATCHED_CONFIRMED") return { fill_price: null, executed_stake: null, fee_paid_real: null };
  const notional = num(reconciliation.executed_notional_usd);
  const price = num(reconciliation.actual_fill_price);
  return {
    fill_price: price != null && price > 0 ? price : null,
    executed_stake: notional != null && notional > 0 ? notional : null,
    fee_paid_real: reconciliation.fee_status === "REPORTED" ? num(reconciliation.fee_usd) : null,
  };
}

export type LedgerFillRepairPlan =
  | { kind: "NOOP" }
  | { kind: "UPDATE"; patch: Partial<LedgerFillEconomics> }
  | { kind: "CONFLICT"; fields: string[] };

// bet_execution_ledger.executed_stake / fill_price / fee_paid_real are numeric(18,6). A stored value is
// therefore the authoritative value rounded to 6 decimals: both sides are normalized to that persisted
// scale (integer micro-units) and compared exactly. There is no money/price tolerance beyond the
// storage precision -- any difference of one persisted unit or more is a real disagreement.
export const LEDGER_NUMERIC_SCALE = 6 as const;
const LEDGER_UNIT = 10 ** LEDGER_NUMERIC_SCALE;

/** The value as numeric(18,6) would persist it, in integer micro-units (half away from zero, like Postgres). */
export function toLedgerUnits(value: number): number {
  // +1e-6 unit (1e-12 USD) only absorbs binary representation noise (e.g. 1.0000005 -> 1000000.4999999999).
  return Math.sign(value) * Math.round(Math.abs(value) * LEDGER_UNIT + 1e-6);
}

export function ledgerValuesEqual(existing: number, authoritative: number): boolean {
  return toLedgerUnits(existing) === toLedgerUnits(authoritative);
}

/**
 * Plans an idempotent repair of existing ledger fill facts from the authoritative reconciliation:
 * NULL + known fact -> populate; equal -> no-op; non-null conflicting -> CONFLICT (never overwritten).
 */
export function planLedgerFillRepair(
  ledger: Record<string, unknown>,
  reconciliation: ExecutionReconciliationV1,
): LedgerFillRepairPlan {
  const authority = reconciliationLedgerEconomics(reconciliation);
  const patch: Partial<LedgerFillEconomics> = {};
  const conflicts: string[] = [];
  for (const key of ["executed_stake", "fill_price", "fee_paid_real"] as const) {
    const known = authority[key];
    if (known == null) continue;
    const current = ledger[key];
    if (current == null) { patch[key] = known; continue; }
    const existing = Number(current);
    if (!isFinite(existing) || !ledgerValuesEqual(existing, known)) conflicts.push(key);
  }
  if (conflicts.length > 0) return { kind: "CONFLICT", fields: conflicts };
  return Object.keys(patch).length > 0 ? { kind: "UPDATE", patch } : { kind: "NOOP" };
}

export function buildMatchedExecutionLedgerRow(
  order: Record<string, unknown>,
  source: EventExecutionQueueRow,
  reconciliation: ExecutionReconciliationV1,
): Record<string, unknown> {
  const diagnostics = source.diagnostics ?? {};
  const lineage = diagnostics.model_lineage_v1 && typeof diagnostics.model_lineage_v1 === "object"
    ? diagnostics.model_lineage_v1 as Record<string, unknown> : {};
  const candidate = order.candidate_snapshot_json && typeof order.candidate_snapshot_json === "object"
    ? order.candidate_snapshot_json as Record<string, unknown> : {};
  const raw = order.raw_event_json && typeof order.raw_event_json === "object"
    ? order.raw_event_json as Record<string, unknown> : {};
  // Raw callback / telemetry is audit evidence only. Economic facts come from the canonical
  // ExecutionReconciliationV1: never requested/planned stake, submitted price or queue ceiling.
  const fill = raw.economic_telemetry_v1 && typeof raw.economic_telemetry_v1 === "object"
    ? raw.economic_telemetry_v1 as Record<string, unknown> : raw;
  const economics = reconciliationLedgerEconomics(reconciliation);
  return {
    id: reconciliation.order_event_id,
    policy_version: str(lineage.policy_version),
    model_name: str(lineage.model_name),
    model_variant: str(lineage.model_variant),
    model_role: str(lineage.model_role),
    signal_id: reconciliation.source_signal_pair_id ?? str(order.signal_id),
    event_id: reconciliation.provider_event_id,
    condition_id: reconciliation.condition_id,
    token_id: reconciliation.token_id,
    selected_side: reconciliation.side,
    sport: source.sport,
    league: source.league,
    event_title: source.event_title,
    market_title: source.market_title,
    market_family: source.market_family,
    game_start_iso: source.game_start_iso,
    signal_entry_price: num(candidate.entry_price) ?? num(diagnostics.entry_price),
    limit_price: num(order.submitted_price),
    fill_price: economics.fill_price,
    planned_stake: source.stake_usd,
    executed_stake: economics.executed_stake,
    fee_paid_real: economics.fee_paid_real,
    real_slippage_cost: null,
    bet_status: "FILLED",
    exchange_order_id: reconciliation.clob_order_id,
    filled_at: str(fill.filled_at),
    settled_at: null,
    result_side: null,
    gross_pnl: null,
    real_pnl: null,
    real_roi_on_stake: null,
    raw_signal: {
      candidate_snapshot_json: order.candidate_snapshot_json,
      queue_diagnostics: diagnostics,
      // Attempt lineage: a maker fill is a separate ledger row (PK = its own order event) on the
      // parent's Reservation / Final Identity; it is never merged into the taker row.
      execution_attempt: {
        attempt_id: str(raw.attempt_id),
        execution_mode: str(raw.execution_mode),
        parent_idempotency_key: str(raw.parent_idempotency_key),
        idempotency_key: reconciliation.idempotency_key,
        venue_order_id: reconciliation.clob_order_id,
        reservation_id: reconciliation.reservation_id,
        physical_event_id: str(diagnostics.physical_event_id) ?? source.match_family_key,
      },
    },
    raw_order: { executor_order_event: order },
  };
}
