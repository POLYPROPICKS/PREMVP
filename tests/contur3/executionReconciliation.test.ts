import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyResolvedOutcomeToExecutionReconciliation,
  buildExecutionReconciliation,
  mergeExecutionReconciliationMeta,
} from "../../lib/executor/executionReconciliation";

const queue = {
  id: "30943442-944a-4315-890b-dd8d155ed1fc",
  reservation_id: "90043370-2df4-4fd2-b304-577db36d7666",
  condition_id: "0xcondition",
  token_id: "token-yes",
  side: "Yes",
  idempotency_key: "c6daa3b33974e7dea01f300ff67e80ab",
  stake_usd: 2.5,
  diagnostics: {
    selected_signal_pair_id: "2dd087ba-bfdf-4c96-b5c6-3fc4a0005e7f",
  },
};

const event = {
  id: "a4aefc93-edfd-4967-8564-6077c8f00a24",
  created_at: "2026-08-24T19:41:06.110721+00:00",
  condition_id: "0xcondition",
  token_id: "token-yes",
  side: "Yes",
  idempotency_key: "c6daa3b33974e7dea01f300ff67e80ab",
  clob_order_id: "0xclob",
  submitted_price: 0.37,
  submitted_size: 6.75,
  making_amount: null,
  taking_amount: null,
  fee_usd: null,
};

const acceptedOpen = {
  queue_id: queue.id,
  reservation_id: queue.reservation_id,
  state: "accepted_open",
  event_type: "accepted",
  ...event,
  stake_usd: 2.5,
};

test("accepted-open callback creates exact lineage and explicit pending economics", () => {
  const reconciliation = buildExecutionReconciliation({ queue, event, raw: acceptedOpen });

  assert.equal(reconciliation.queue_id, queue.id);
  assert.equal(reconciliation.reservation_id, queue.reservation_id);
  assert.equal(reconciliation.condition_id, queue.condition_id);
  assert.equal(reconciliation.token_id, queue.token_id);
  assert.equal(reconciliation.side, queue.side);
  assert.equal(reconciliation.idempotency_key, queue.idempotency_key);
  assert.equal(reconciliation.clob_order_id, event.clob_order_id);
  assert.equal(reconciliation.order_event_id, event.id);
  assert.equal(reconciliation.requested_shares, 6.75);
  assert.equal(reconciliation.requested_notional_usd, 2.4975);
  assert.equal(reconciliation.authorized_stake_ceiling_usd, 2.5);
  assert.equal(reconciliation.executed_shares, null);
  assert.equal(reconciliation.executed_notional_usd, null);
  assert.equal(reconciliation.fill_status, "ACCEPTED_OPEN");
  assert.equal(reconciliation.settlement_status, "PENDING_FILL_CONFIRMATION");
  assert.equal(reconciliation.fee_status, "PENDING_FILL_CONFIRMATION");
  assert.equal(reconciliation.fee_usd, null);
  assert.equal(reconciliation.gross_pnl_usd, null);
  assert.equal(reconciliation.net_pnl_usd, null);
});

test("a matched callback promotes the same record without creating new economics", () => {
  const prior = buildExecutionReconciliation({ queue, event, raw: acceptedOpen });
  const reconciliation = buildExecutionReconciliation({
    queue,
    event: { ...event, taking_amount: 6.75 },
    raw: { ...acceptedOpen, state: "matched", order_status: "matched", executed_size: 6.75 },
    prior,
  });

  assert.equal(reconciliation.reconciliation_key, prior.reconciliation_key);
  assert.equal(reconciliation.fill_status, "MATCHED_CONFIRMED");
  assert.equal(reconciliation.executed_shares, 6.75);
  assert.equal(reconciliation.executed_notional_usd, 2.4975);
  assert.equal(reconciliation.settlement_status, "PENDING_MARKET_RESOLUTION");
  assert.equal(reconciliation.fee_status, "NOT_REPORTED");
});

test("market resolution never invents a fill for an accepted-open order", () => {
  const prior = buildExecutionReconciliation({ queue, event, raw: acceptedOpen });
  const resolved = applyResolvedOutcomeToExecutionReconciliation(prior, {
    resolved_at: "2026-08-25T00:00:00.000Z",
    winning_outcome: "No",
    winning_token_id: "token-no",
  });

  assert.equal(resolved.settlement_status, "RESOLVED_AWAITING_FILL_CONFIRMATION");
  assert.equal(resolved.gross_pnl_usd, null);
  assert.equal(resolved.net_pnl_usd, null);
});

test("matched quantity resolves gross PnL but waits for an unreported fee", () => {
  const matched = buildExecutionReconciliation({
    queue,
    event,
    raw: { ...acceptedOpen, order_status: "matched", executed_size: 6.75 },
  });
  const resolved = applyResolvedOutcomeToExecutionReconciliation(matched, {
    resolved_at: "2026-08-25T00:00:00.000Z",
    winning_outcome: "Yes",
    winning_token_id: "token-yes",
  });

  assert.equal(resolved.settlement_status, "RESOLVED_FEE_PENDING");
  assert.equal(resolved.result_status, "WON");
  assert.equal(resolved.gross_pnl_usd, 4.2525);
  assert.equal(resolved.net_pnl_usd, null);
});

test("an explicit zero fee produces reconciled net PnL", () => {
  const matched = buildExecutionReconciliation({
    queue,
    event: { ...event, fee_usd: 0 },
    raw: { ...acceptedOpen, order_status: "matched", executed_size: 6.75, fee_usd: 0 },
  });
  const resolved = applyResolvedOutcomeToExecutionReconciliation(matched, {
    resolved_at: "2026-08-25T00:00:00.000Z",
    winning_outcome: "Yes",
    winning_token_id: "token-yes",
  });

  assert.equal(resolved.settlement_status, "SETTLED_RECONCILED");
  assert.equal(resolved.fee_status, "REPORTED");
  assert.equal(resolved.fee_usd, 0);
  assert.equal(resolved.gross_pnl_usd, 4.2525);
  assert.equal(resolved.net_pnl_usd, 4.2525);
});

test("a later callback can advance filled quantity and cannot erase a reported fee with null", () => {
  const prior = buildExecutionReconciliation({
    queue,
    event: { ...event, fee_usd: 0.01 },
    raw: { ...acceptedOpen, order_status: "matched", executed_size: 3, fee_usd: 0.01 },
  });
  const next = buildExecutionReconciliation({
    queue,
    event: { ...event, fee_usd: 0.01 },
    raw: { ...acceptedOpen, order_status: "matched", executed_size: 6.75, fee_usd: null },
    prior,
  });

  assert.equal(next.executed_shares, 6.75);
  assert.equal(next.fee_usd, 0.01);
  assert.equal(next.fee_status, "REPORTED");
});

test("metadata merge preserves unrelated executor metadata and is deterministic", () => {
  const reconciliation = buildExecutionReconciliation({ queue, event, raw: acceptedOpen });
  const first = mergeExecutionReconciliationMeta({ host: "ireland" }, reconciliation);
  const second = mergeExecutionReconciliationMeta(first, reconciliation);

  assert.equal(second.host, "ireland");
  assert.deepEqual(second, first);
});

test("accepted and duplicate callbacks both invoke canonical economic telemetry persistence", () => {
  const source = readFileSync(path.join(process.cwd(), "app/api/executor/order-events/route.ts"), "utf8");
  assert.match(source, /outcome\.kind === "INSERTED" \|\| outcome\.kind === "DUPLICATE"/);
  assert.match(source, /persistEconomicTelemetry\(raw, outcome\.row\.id\)/);
  assert.match(source, /\.eq\("idempotency_key", telemetry\.identity\.idempotency_key\)/);
  assert.match(source, /\.eq\("clob_order_id", telemetry\.identity\.clob_order_id\)/);
});

test("the existing resolver path owns the automatic settlement sweep", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/resolve-signals.ts"), "utf8");
  assert.match(source, /await reconcilePendingExecutionSettlements\(supabase, WRITE_MODE\)/);
  assert.match(source, /EXECUTION_RECONCILIATION_SUMMARY/);
  assert.match(source, /readExecutionReconciliation\(row\.executor_meta\)/);
});
