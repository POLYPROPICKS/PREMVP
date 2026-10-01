// lib/executor/matchedExecutionLedgerRow.ts
//
// Pure projection of a MATCHED_CONFIRMED execution (taker OR maker attempt) into the
// bet_execution_ledger row. The ledger PK is the order-event PK, so a maker fill is its own
// row on the parent's Reservation / Final Identity and is never merged with a taker row.

import type { EventExecutionQueueRow } from "./executorQueueTypes";
import type { ExecutionReconciliationV1 } from "./executionReconciliation";

function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }
function num(v: unknown): number | null { return typeof v === "number" && isFinite(v) ? v : null; }

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
  const fill = raw.economic_telemetry_v1 && typeof raw.economic_telemetry_v1 === "object"
    ? raw.economic_telemetry_v1 as Record<string, unknown> : raw;
  const actualFee = fill.fee_source === "CLOB_TRADES" ? num(fill.fee_usd) : null;
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
    fill_price: num(fill.average_fill_price) ?? num(fill.actual_fill_price) ?? num(fill.filled_price),
    planned_stake: source.stake_usd,
    executed_stake: num(fill.executed_notional_usd),
    fee_paid_real: actualFee,
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
