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

test("canonical telemetry promotes the same record with actual fill economics", () => {
  const prior = buildExecutionReconciliation({ queue, event, raw: acceptedOpen });
  const reconciliation = buildExecutionReconciliation({
    queue,
    event: { ...event, taking_amount: 6.75 },
    raw: { ...acceptedOpen, state: "matched", order_status: "matched", executed_size: 6.75, average_fill_price: 0.35 },
    prior,
  });

  assert.equal(reconciliation.reconciliation_key, prior.reconciliation_key);
  assert.equal(reconciliation.fill_status, "MATCHED_CONFIRMED");
  assert.equal(reconciliation.executed_shares, 6.75);
  assert.equal(reconciliation.actual_fill_price, 0.35);
  assert.equal(reconciliation.executed_notional_usd, 2.3625);
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
    raw: { ...acceptedOpen, order_status: "matched", executed_size: 6.75, average_fill_price: 0.35 },
  });
  const resolved = applyResolvedOutcomeToExecutionReconciliation(matched, {
    resolved_at: "2026-08-25T00:00:00.000Z",
    winning_outcome: "Yes",
    winning_token_id: "token-yes",
  });

  assert.equal(resolved.settlement_status, "RESOLVED_FEE_PENDING");
  assert.equal(resolved.result_status, "WON");
  assert.equal(resolved.gross_pnl_usd, 4.3875);
  assert.equal(resolved.net_pnl_usd, null);
});

test("an explicit zero fee produces reconciled net PnL", () => {
  const matched = buildExecutionReconciliation({
    queue,
    event: { ...event, fee_usd: 0 },
    raw: { ...acceptedOpen, order_status: "matched", executed_size: 6.75, average_fill_price: 0.35, fee_usd: 0 },
  });
  const resolved = applyResolvedOutcomeToExecutionReconciliation(matched, {
    resolved_at: "2026-08-25T00:00:00.000Z",
    winning_outcome: "Yes",
    winning_token_id: "token-yes",
  });

  assert.equal(resolved.settlement_status, "SETTLED_RECONCILED");
  assert.equal(resolved.fee_status, "REPORTED");
  assert.equal(resolved.fee_usd, 0);
  assert.equal(resolved.gross_pnl_usd, 4.3875);
  assert.equal(resolved.net_pnl_usd, 4.3875);
});

test("a later callback can advance filled quantity and cannot erase a reported fee with null", () => {
  const prior = buildExecutionReconciliation({
    queue,
    event: { ...event, fee_usd: 0.01 },
    raw: { ...acceptedOpen, order_status: "matched", executed_size: 3, average_fill_price: 0.35, fee_usd: 0.01 },
  });
  const next = buildExecutionReconciliation({
    queue,
    event: { ...event, fee_usd: 0.01 },
    raw: { ...acceptedOpen, order_status: "matched", executed_size: 6.75, average_fill_price: 0.35, fee_usd: null },
    prior,
  });

  assert.equal(next.executed_shares, 6.75);
  assert.equal(next.fee_usd, 0.01);
  assert.equal(next.fee_status, "REPORTED");
});

test("confirmed ECONOMIC_TELEMETRY_V1 is monotonic fill authority and preserves null fee evidence", () => {
  const prior = buildExecutionReconciliation({ queue, event, raw: acceptedOpen });
  const reconciliation = buildExecutionReconciliation({
    queue,
    event,
    raw: acceptedOpen,
    prior,
    telemetry: {
      version: "ECONOMIC_TELEMETRY_V1",
      identity: { queue_id: queue.id, reservation_id: queue.reservation_id, condition_id: queue.condition_id, token_id: queue.token_id, side: queue.side, idempotency_key: queue.idempotency_key, clob_order_id: event.clob_order_id },
      requested: { authorized_stake_ceiling_usd: 2.5, submitted_price: 0.37, requested_shares: 6.75, requested_notional_usd: 2.4975 },
      executed: { execution_status: "CONFIRMED", executed_shares: { value: 6.75, evidence_state: "KNOWN" }, average_fill_price: { value: 0.35, evidence_state: "KNOWN" }, executed_notional_usd: { value: 2.3625, evidence_state: "KNOWN" }, making_amount: { value: null, evidence_state: "NOT_YET_AVAILABLE" }, taking_amount: { value: null, evidence_state: "NOT_YET_AVAILABLE" } },
      costs: { fee_rate_bps: { value: 0, evidence_state: "KNOWN" }, fee_usd: { value: null, evidence_state: "NOT_RETURNED_BY_VENUE" }, fee_source: null, slippage_reference_price: { value: null, evidence_state: "NOT_YET_AVAILABLE" }, slippage_usd: { value: null, evidence_state: "NOT_YET_AVAILABLE" } },
      wallet: { lifecycle_point: "UNKNOWN", observed_at: null, collateral_balance_usd: { value: null, evidence_state: "NOT_YET_AVAILABLE" }, spendable_balance_usd: { value: null, evidence_state: "NOT_YET_AVAILABLE" }, allowance_usd: { value: null, evidence_state: "NOT_YET_AVAILABLE" } },
    },
  });

  assert.equal(reconciliation.fill_status, "MATCHED_CONFIRMED");
  assert.equal(reconciliation.actual_fill_price, 0.35);
  assert.equal(reconciliation.executed_notional_usd, 2.3625);
  assert.equal(reconciliation.fee_status, "NOT_REPORTED");
  const settled = applyResolvedOutcomeToExecutionReconciliation(reconciliation, { resolved_at: "2026-08-25T00:00:00.000Z", winning_outcome: "No", winning_token_id: "token-no" });
  assert.equal(settled.gross_pnl_usd, -2.3625);
  assert.equal(settled.net_pnl_usd, null);
  assert.equal(settled.settlement_status, "RESOLVED_FEE_PENDING");
});

test("source_signal_pair_id is carried as non-blocking lineage: presence/absence never gates reconciliation build", () => {
  const withSource = buildExecutionReconciliation({ queue, event, raw: acceptedOpen });
  assert.equal(withSource.source_signal_pair_id, "2dd087ba-bfdf-4c96-b5c6-3fc4a0005e7f");

  const queueWithoutLineage = { ...queue, diagnostics: {} };
  const withoutSource = buildExecutionReconciliation({
    queue: queueWithoutLineage,
    event,
    raw: { ...acceptedOpen, source_signal_pair_id: undefined, signal_pair_id: undefined },
  });
  assert.equal(withoutSource.source_signal_pair_id, null);
  assert.equal(withoutSource.settlement_status, "PENDING_FILL_CONFIRMATION");
});

test("callback identity conflicts fail closed before reconciliation mutation", () => {
  assert.throws(() => buildExecutionReconciliation({
    queue,
    event,
    raw: { ...acceptedOpen, queue_id: "another-queue" },
  }), /RECONCILIATION_IDENTITY_CONFLICT_QUEUE_ID/);
});

// PR #382 follow-up: CORRECT_ORDER_PROGRESSION_SEMANTICS_IN_PR_382_V1 --
// Ireland's terminal/fill callback for an already-accepted order sometimes
// reports the actual fill price/size under the SAME submitted_price/
// submitted_size field names it used for the originally requested price/size
// on the initial ORDER_PLACED callback. The stored order-event row's own
// submitted_price/submitted_size are never overwritten by that later
// callback (see app/api/executor/order-events/route.ts
// updateOrderEventProgression) -- `event` below models that preserved row,
// while `raw` models the callback exactly as Ireland sent it, still
// carrying 0.592/5 under those field names.
const requestedEvent = { ...event, submitted_price: 0.62, submitted_size: 5 };
const requestedQueue = { ...queue, stake_usd: 3.1 };

test("A/B: a terminal/fill progression reports the actual fill price/size separately from the preserved original request -- fill_status becomes MATCHED_CONFIRMED without relabelling the requested price", () => {
  const prior = buildExecutionReconciliation({
    queue: requestedQueue,
    event: requestedEvent,
    raw: { ...acceptedOpen, ...requestedEvent, stake_usd: 3.1 },
  });
  assert.equal(prior.submitted_price, 0.62);
  assert.equal(prior.requested_shares, 5);
  assert.equal(prior.fill_status, "ACCEPTED_OPEN");

  const progressed = buildExecutionReconciliation({
    queue: requestedQueue,
    event: requestedEvent,
    raw: { ...acceptedOpen, ...requestedEvent, order_status: "matched", submitted_price: 0.592, submitted_size: 5 },
    prior,
  });

  assert.equal(progressed.submitted_price, 0.62, "the preserved requested price is never relabelled as the actual fill price");
  assert.equal(progressed.requested_shares, 5);
  assert.equal(progressed.fill_status, "MATCHED_CONFIRMED");
  assert.equal(progressed.actual_fill_price, 0.592, "the actual fill price is captured separately");
  assert.equal(progressed.executed_shares, 5);
  assert.equal(progressed.executed_notional_usd, 2.96);
});

test("C: a terminal UNFILLED/EXPIRED progression is a real terminal-no-fill state, never ACCEPTED_OPEN or PENDING_FILL_CONFIRMATION, with zero executed shares/notional and no fabricated fill price", () => {
  for (const order_status of ["unfilled", "expired"]) {
    const prior = buildExecutionReconciliation({
      queue: requestedQueue,
      event: requestedEvent,
      raw: { ...acceptedOpen, ...requestedEvent, stake_usd: 3.1 },
    });
    const terminal = buildExecutionReconciliation({
      queue: requestedQueue,
      event: requestedEvent,
      raw: { ...acceptedOpen, ...requestedEvent, order_status },
      prior,
    });

    assert.equal(terminal.fill_status, "TERMINAL_NO_FILL", order_status);
    assert.notEqual(terminal.fill_status, "ACCEPTED_OPEN");
    assert.equal(terminal.settlement_status, "SETTLED_NO_FILL");
    assert.notEqual(terminal.settlement_status, "PENDING_FILL_CONFIRMATION");
    assert.equal(terminal.executed_shares, 0);
    assert.equal(terminal.executed_notional_usd, 0);
    assert.equal(terminal.actual_fill_price, null, "no fabricated fill price");
    assert.equal(terminal.submitted_price, 0.62, "the original request is untouched");
  }
});

test("C2: a terminal-no-fill callback never downgrades an already-confirmed fill -- the existing monotonic matched guard keeps it MATCHED_CONFIRMED with its executed facts intact", () => {
  const prior = buildExecutionReconciliation({
    queue: requestedQueue,
    event: requestedEvent,
    raw: { ...acceptedOpen, ...requestedEvent, order_status: "matched", submitted_price: 0.592, submitted_size: 5 },
  });
  assert.equal(prior.fill_status, "MATCHED_CONFIRMED");
  assert.equal(prior.executed_shares, 5);

  const afterLateUnfilled = buildExecutionReconciliation({
    queue: requestedQueue,
    event: requestedEvent,
    raw: { ...acceptedOpen, ...requestedEvent, order_status: "unfilled" },
    prior,
  });

  assert.equal(afterLateUnfilled.fill_status, "MATCHED_CONFIRMED", "a stray later unfilled signal must never erase a confirmed fill");
  assert.equal(afterLateUnfilled.executed_shares, 5);
  assert.equal(afterLateUnfilled.actual_fill_price, 0.592);
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
  assert.match(source, /reconcileExecutionLifecycle\(supabase, \{ writeMode, limit: 200 \}\)/);
});
