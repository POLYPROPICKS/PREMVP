import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileExecutionLifecycleWithPort,
  type ExecutionLifecycleDbPort,
} from "../../lib/executor/executionLifecycle";

const eventId = "a4aefc93-edfd-4967-8564-6077c8f00a24";
const sourceId = "2dd087ba-bfdf-4c96-b5c6-3fc4a0005e7f";

function reconciliation() {
  return {
    version: "EXECUTION_RECONCILIATION_V1" as const,
    reconciliation_key: "idem-1", queue_id: "queue-1", reservation_id: "reservation-1", source_signal_pair_id: sourceId, provider_event_id: null,
    order_event_id: eventId, condition_id: "condition-1", token_id: "token-yes", side: "Yes", idempotency_key: "idem-1", clob_order_id: "clob-1",
    submitted_price: 0.37, requested_shares: 6.75, requested_notional_usd: 2.4975, authorized_stake_ceiling_usd: 2.5,
    fill_status: "ACCEPTED_OPEN" as const, executed_shares: null, actual_fill_price: null, executed_notional_usd: null,
    settlement_status: "PENDING_FILL_CONFIRMATION" as const, result_status: "PENDING" as const, resolved_at: null, winning_outcome: null, winning_token_id: null,
    fee_status: "PENDING_FILL_CONFIRMATION" as const, fee_usd: null, gross_pnl_usd: null, net_pnl_usd: null,
  };
}

function telemetry() {
  return {
    version: "ECONOMIC_TELEMETRY_V1" as const,
    identity: { queue_id: "queue-1", reservation_id: "reservation-1", condition_id: "condition-1", token_id: "token-yes", side: "Yes", idempotency_key: "idem-1", clob_order_id: "clob-1" },
    requested: { authorized_stake_ceiling_usd: 2.5, submitted_price: 0.37, requested_shares: 6.75, requested_notional_usd: 2.4975 },
    executed: { execution_status: "CONFIRMED", executed_shares: { value: 6.75, evidence_state: "KNOWN" as const }, average_fill_price: { value: 0.35, evidence_state: "KNOWN" as const }, executed_notional_usd: { value: 2.3625, evidence_state: "KNOWN" as const }, making_amount: { value: null, evidence_state: "NOT_YET_AVAILABLE" as const }, taking_amount: { value: null, evidence_state: "NOT_YET_AVAILABLE" as const } },
    costs: { fee_rate_bps: { value: 0, evidence_state: "KNOWN" as const }, fee_usd: { value: null, evidence_state: "NOT_RETURNED_BY_VENUE" as const }, fee_source: null, slippage_reference_price: { value: null, evidence_state: "NOT_YET_AVAILABLE" as const }, slippage_usd: { value: null, evidence_state: "NOT_YET_AVAILABLE" as const } },
    wallet: { lifecycle_point: "UNKNOWN" as const, observed_at: null, collateral_balance_usd: { value: null, evidence_state: "NOT_YET_AVAILABLE" as const }, spendable_balance_usd: { value: null, evidence_state: "NOT_YET_AVAILABLE" as const }, allowance_usd: { value: null, evidence_state: "NOT_YET_AVAILABLE" as const } },
  };
}

test("one bounded lifecycle pass advances telemetry, resolves only its exact source, and settles the same event", async () => {
  let storedMeta: Record<string, unknown> = { reconciliation_v1: reconciliation(), economic_telemetry_v1: telemetry() };
  let sourceWrites = 0;
  let eventWrites = 0;
  let resolvedAt: string | null = null;
  const port: ExecutionLifecycleDbPort = {
    async loadEvents() { return [{ id: eventId, executor_meta: storedMeta }]; },
    async loadSource(id) {
      assert.equal(id, sourceId);
      return { id: sourceId, condition_id: "condition-1", selected_token_id: "token-yes", selected_outcome: "Yes", diagnostics: {}, resolved_at: null, signal_result: null, winning_outcome: null, entry_price_num: 0.37 };
    },
    async persistSourceResolution(input) {
      sourceWrites++;
      assert.deepEqual(input.identity, { id: sourceId, condition_id: "condition-1", selected_token_id: "token-yes", selected_outcome: "Yes" });
      assert.equal(input.signal_result, "won");
      resolvedAt = input.resolved_at;
    },
    async persistEvent(input) {
      eventWrites++;
      assert.equal(input.id, eventId);
      assert.equal(input.idempotency_key, "idem-1");
      assert.equal(input.clob_order_id, "clob-1");
      storedMeta = input.executor_meta;
    },
  };
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, signalResult: "won" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes", realizedReturnPct: 185.71 });

  const first = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  const settled = storedMeta.reconciliation_v1 as Record<string, unknown>;
  assert.equal(first.updated, 1);
  assert.equal(sourceWrites, 1);
  assert.equal(eventWrites, 1);
  assert.equal(settled.fill_status, "MATCHED_CONFIRMED");
  assert.equal(settled.executed_notional_usd, 2.3625);
  assert.equal(settled.gross_pnl_usd, 4.3875);
  assert.equal(settled.settlement_status, "RESOLVED_FEE_PENDING");
  assert.equal(settled.net_pnl_usd, null);

  const second = await reconcileExecutionLifecycleWithPort({
    ...port,
    async loadSource() { return { id: sourceId, condition_id: "condition-1", selected_token_id: "token-yes", selected_outcome: "Yes", diagnostics: {}, resolved_at: resolvedAt, signal_result: "won", winning_outcome: "Yes", entry_price_num: 0.37 }; },
  }, { writeMode: true, eventIds: [eventId], resolver });
  assert.equal(second.updated, 0);
  assert.equal(sourceWrites, 1, "duplicate observation does not write source again");
  assert.equal(eventWrites, 1, "duplicate observation does not write event again");
});

test("identity conflicts fail closed and dry-run reports a would-update without writes", async () => {
  let writes = 0;
  const port: ExecutionLifecycleDbPort = {
    async loadEvents() { return [{ id: eventId, executor_meta: { reconciliation_v1: reconciliation(), economic_telemetry_v1: telemetry() } }]; },
    async loadSource() { return { id: sourceId, condition_id: "condition-1", selected_token_id: "token-no", selected_outcome: "No", diagnostics: {}, resolved_at: null, signal_result: null, winning_outcome: null, entry_price_num: 0.37 }; },
    async persistSourceResolution() { writes++; },
    async persistEvent() { writes++; },
  };
  const conflict = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId] });
  assert.equal(conflict.conflicts, 1);
  assert.equal(writes, 0);

  const dryRun = await reconcileExecutionLifecycleWithPort({
    ...port,
    async loadSource() { return { id: sourceId, condition_id: "condition-1", selected_token_id: "token-yes", selected_outcome: "Yes", diagnostics: {}, resolved_at: null, signal_result: null, winning_outcome: null, entry_price_num: 0.37 }; },
  }, { writeMode: false, eventIds: [eventId], resolver: async () => ({ resolverState: "active_unresolved" as const, signalResult: null, candidateWinningOutcome: null, candidateWinningTokenId: null, realizedReturnPct: null }) });
  assert.equal(dryRun.would_update, 1);
  assert.equal(writes, 0);
});
