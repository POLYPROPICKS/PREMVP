// FINANCIAL CLOSURE: ledger fill economics come from ExecutionReconciliationV1
//   node --import tsx --test tests/contur3/matchedExecutionLedgerRow.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMatchedExecutionLedgerRow,
  planLedgerFillRepair,
  reconciliationLedgerEconomics,
} from "../../lib/executor/matchedExecutionLedgerRow";
import type { ExecutionReconciliationV1 } from "../../lib/executor/executionReconciliation";
import type { EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

function rec(overrides: Partial<ExecutionReconciliationV1> = {}): ExecutionReconciliationV1 {
  return {
    version: "EXECUTION_RECONCILIATION_V1", reconciliation_key: "idem-1", queue_id: "queue-1", reservation_id: "res-1",
    source_signal_pair_id: null, provider_event_id: "prov-1", order_event_id: "ev-1", condition_id: "cond-1", token_id: "tok-1", side: "Yes",
    idempotency_key: "idem-1", clob_order_id: "clob-1", submitted_price: 0.37, requested_shares: 6.75, requested_notional_usd: 2.4975,
    authorized_stake_ceiling_usd: 2.5, fill_status: "MATCHED_CONFIRMED", executed_shares: 6.75, actual_fill_price: 0.35, executed_notional_usd: 2.3625,
    settlement_status: "PENDING_MARKET_RESOLUTION", result_status: "PENDING", resolved_at: null, winning_outcome: null, winning_token_id: null,
    fee_status: "NOT_REPORTED", fee_usd: null, gross_pnl_usd: null, net_pnl_usd: null,
    ...overrides,
  } as ExecutionReconciliationV1;
}

const queue = { stake_usd: 2.5, diagnostics: {}, sport: "soccer", league: "x", event_title: "e", market_title: "m", market_family: "moneyline", game_start_iso: null, match_family_key: null } as unknown as EventExecutionQueueRow;

function build(reconciliation: ExecutionReconciliationV1, raw: Record<string, unknown> = {}) {
  return buildMatchedExecutionLedgerRow({ id: "ev-1", submitted_price: 0.37, raw_event_json: raw, candidate_snapshot_json: null }, queue, reconciliation);
}

test("reconciliation executed notional / fill price are the ledger authority (callback carries none)", () => {
  const row = build(rec());
  assert.equal(row.executed_stake, 2.3625);
  assert.equal(row.fill_price, 0.35);
  assert.equal(row.planned_stake, 2.5, "planned stake stays planning evidence only");
  assert.equal(row.fee_paid_real, null);
});

test("raw callback never overrides reconciliation economics", () => {
  const row = build(rec(), { economic_telemetry_v1: { executed_notional_usd: 9.99, average_fill_price: 0.9, fee_usd: 0.5, fee_source: "CLOB_TRADES" } });
  assert.equal(row.executed_stake, 2.3625);
  assert.equal(row.fill_price, 0.35);
  assert.equal(row.fee_paid_real, null);
});

test("reported fee populates fee_paid_real; NOT_REPORTED / non-finite never becomes zero", () => {
  assert.equal(build(rec({ fee_status: "REPORTED", fee_usd: 0.01 })).fee_paid_real, 0.01);
  assert.equal(build(rec({ fee_status: "NOT_REPORTED", fee_usd: null })).fee_paid_real, null);
  assert.equal(build(rec({ fee_status: "PENDING_FILL_CONFIRMATION" })).fee_paid_real, null);
  assert.equal(build(rec({ fee_status: "REPORTED", fee_usd: Number.NaN })).fee_paid_real, null);
});

test("partial fill uses actual executed notional, not requested/planned stake", () => {
  const row = build(rec({ executed_shares: 2, actual_fill_price: 0.49, executed_notional_usd: 0.98 }));
  assert.equal(row.executed_stake, 0.98);
  assert.equal(row.fill_price, 0.49);
  assert.equal(row.planned_stake, 2.5);
});

test("non-matched reconciliation yields no economic facts", () => {
  assert.deepEqual(reconciliationLedgerEconomics(rec({ fill_status: "ACCEPTED_OPEN", executed_notional_usd: null, actual_fill_price: null })),
    { fill_price: null, executed_stake: null, fee_paid_real: null });
});

test("repair plan: NULL ledger + known fact populates; fee only when reported", () => {
  const plan = planLedgerFillRepair({ executed_stake: null, fill_price: null, fee_paid_real: null }, rec());
  assert.deepEqual(plan, { kind: "UPDATE", patch: { executed_stake: 2.3625, fill_price: 0.35 } });
  const withFee = planLedgerFillRepair({ executed_stake: null, fill_price: null, fee_paid_real: null }, rec({ fee_status: "REPORTED", fee_usd: 0.01 }));
  assert.deepEqual(withFee, { kind: "UPDATE", patch: { executed_stake: 2.3625, fill_price: 0.35, fee_paid_real: 0.01 } });
});

test("repair plan: equal facts (incl. numeric strings) are an idempotent no-op", () => {
  assert.deepEqual(planLedgerFillRepair({ executed_stake: "2.3625", fill_price: 0.35, fee_paid_real: null }, rec()), { kind: "NOOP" });
});

test("repair plan: conflicting non-null ledger fact fails closed, never overwritten", () => {
  assert.deepEqual(planLedgerFillRepair({ executed_stake: 2.5, fill_price: null, fee_paid_real: null }, rec()), { kind: "CONFLICT", fields: ["executed_stake"] });
  assert.deepEqual(planLedgerFillRepair({ executed_stake: 2.3625, fill_price: 0.35, fee_paid_real: 0.5 }, rec({ fee_status: "REPORTED", fee_usd: 0.01 })), { kind: "CONFLICT", fields: ["fee_paid_real"] });
});

test("repair plan: unreported fee keeps a null fee null and a known ledger fee untouched", () => {
  assert.deepEqual(planLedgerFillRepair({ executed_stake: 2.3625, fill_price: 0.35, fee_paid_real: null }, rec()), { kind: "NOOP" });
  assert.deepEqual(planLedgerFillRepair({ executed_stake: 2.3625, fill_price: 0.35, fee_paid_real: 0.01 }, rec()), { kind: "NOOP" });
});
