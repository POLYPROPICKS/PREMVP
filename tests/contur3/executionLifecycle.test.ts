// B6: SETTLEMENT FINANCIAL TAIL IS GSP-FREE
//   node --import tsx --test tests/contur3/executionLifecycle.test.ts
//
// Business result under test: execution-reconciliation lifecycle settlement
// resolves entirely from ExecutionReconciliationV1 + provider market
// resolution. generated_signal_pairs is never read and never written by
// this path -- source_signal_pair_id (if present on the reconciliation) is
// carried as historical lineage only and never gates or backs settlement.

import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileExecutionLifecycleWithPort,
  type ExecutionLifecycleDbPort,
} from "../../lib/executor/executionLifecycle";

const eventId = "a4aefc93-edfd-4967-8564-6077c8f00a24";
const sourceId = "2dd087ba-bfdf-4c96-b5c6-3fc4a0005e7f";

function reconciliation(overrides: Record<string, unknown> = {}) {
  return {
    version: "EXECUTION_RECONCILIATION_V1" as const,
    reconciliation_key: "idem-1", queue_id: "queue-1", reservation_id: "reservation-1", source_signal_pair_id: sourceId, provider_event_id: null,
    order_event_id: eventId, condition_id: "condition-1", token_id: "token-yes", side: "Yes", idempotency_key: "idem-1", clob_order_id: "clob-1",
    submitted_price: 0.37, requested_shares: 6.75, requested_notional_usd: 2.4975, authorized_stake_ceiling_usd: 2.5,
    fill_status: "ACCEPTED_OPEN" as const, executed_shares: null, actual_fill_price: null, executed_notional_usd: null,
    settlement_status: "PENDING_FILL_CONFIRMATION" as const, result_status: "PENDING" as const, resolved_at: null, winning_outcome: null, winning_token_id: null,
    fee_status: "PENDING_FILL_CONFIRMATION" as const, fee_usd: null, gross_pnl_usd: null, net_pnl_usd: null,
    ...overrides,
  };
}

function confirmedFillReconciliation(overrides: Record<string, unknown> = {}) {
  return reconciliation({
    fill_status: "MATCHED_CONFIRMED",
    executed_shares: 6.75,
    actual_fill_price: 0.35,
    executed_notional_usd: 2.3625,
    settlement_status: "PENDING_MARKET_RESOLUTION",
    fee_status: "NOT_REPORTED",
    ...overrides,
  });
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

/** Fails the test outright if the port is ever asked to touch generated_signal_pairs. */
function makePort(metaByEvent: Record<string, Record<string, unknown>>): ExecutionLifecycleDbPort & { eventWrites: number; writes: Record<string, unknown>[] } {
  const port = {
    eventWrites: 0,
    writes: [] as Record<string, unknown>[],
    async loadEvents({ eventIds }: { eventIds?: string[] }) {
      const ids = eventIds ?? Object.keys(metaByEvent);
      return ids.map((id) => ({ id, executor_meta: metaByEvent[id] }));
    },
    async persistEvent(input: { id: string; idempotency_key: string; clob_order_id: string; executor_meta: Record<string, unknown> }) {
      port.eventWrites++;
      port.writes.push(input.executor_meta);
      metaByEvent[input.id] = input.executor_meta;
    },
  };
  return port;
}

// ── A: source_signal_pair_id present -- GSP is never a live read/write dependency ──

test("A: source_signal_pair_id present -- lifecycle settles purely from reconciliation + provider resolution, with zero GSP access (no loadSource/persistSourceResolution on the port)", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: reconciliation(), economic_telemetry_v1: telemetry() } });
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });

  const summary = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  const settled = port.writes[0].reconciliation_v1 as Record<string, unknown>;

  assert.equal(summary.updated, 1);
  assert.equal(port.eventWrites, 1);
  assert.equal("loadSource" in port, false, "the port contract exposes no generated_signal_pairs read method");
  assert.equal("persistSourceResolution" in port, false, "the port contract exposes no generated_signal_pairs write method");
  assert.equal(settled.fill_status, "MATCHED_CONFIRMED");
  assert.equal(settled.executed_notional_usd, 2.3625);
  assert.equal(settled.gross_pnl_usd, 4.3875);
  assert.equal(settled.settlement_status, "RESOLVED_FEE_PENDING");
  assert.equal(settled.net_pnl_usd, null);
  assert.equal(settled.source_signal_pair_id, sourceId, "lineage id is preserved but was never read back from a source table");
});

// ── B: source_signal_pair_id absent -- lifecycle still progresses via reconciliation + provider resolution ──

test("B: source_signal_pair_id absent -- lifecycle still settles using reconciliation identity + provider resolution alone", async () => {
  const noLineage = confirmedFillReconciliation({ source_signal_pair_id: null });
  const port = makePort({ [eventId]: { reconciliation_v1: noLineage } });
  const resolver = async (input: { conditionId: string }) => {
    assert.equal(input.conditionId, "condition-1");
    return { resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" };
  };

  const summary = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  const settled = port.writes[0].reconciliation_v1 as Record<string, unknown>;

  assert.equal(summary.updated, 1);
  assert.equal(settled.result_status, "WON");
  assert.equal(settled.settlement_status, "RESOLVED_FEE_PENDING");
});

// ── C: unresolved provider market remains pending with zero GSP access ──

test("C: unresolved provider market -- stays pending, no settlement mutation, zero GSP access", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } });
  const resolver = async () => ({ resolverState: "active_unresolved" as const, candidateWinningOutcome: null, candidateWinningTokenId: null });

  const summary = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });

  assert.equal(summary.unresolved, 1);
  assert.equal(summary.updated, 0);
  assert.equal(port.eventWrites, 0);
});

// ── D / E: resolved winning vs opposing token ──

test("D: resolved winning token -- result_status = WON", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } });
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });

  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  const settled = port.writes[0].reconciliation_v1 as Record<string, unknown>;
  assert.equal(settled.result_status, "WON");
});

test("E: resolved opposing token -- result_status = LOST", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } });
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "No", candidateWinningTokenId: "token-no" });

  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  const settled = port.writes[0].reconciliation_v1 as Record<string, unknown>;
  assert.equal(settled.result_status, "LOST");
  assert.equal(settled.gross_pnl_usd, -2.3625);
});

// ── F: resolution before confirmed fill ──

test("F: resolution before confirmed fill -- RESOLVED_AWAITING_FILL_CONFIRMATION, no fabricated PnL", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: reconciliation() } }); // ACCEPTED_OPEN, no telemetry
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });

  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  const settled = port.writes[0].reconciliation_v1 as Record<string, unknown>;

  assert.equal(settled.settlement_status, "RESOLVED_AWAITING_FILL_CONFIRMATION");
  assert.equal(settled.result_status, "PENDING");
  assert.equal(settled.gross_pnl_usd, null);
  assert.equal(settled.net_pnl_usd, null);
});

// ── G: confirmed fill + resolved market + reported fee -- existing gross/net PnL math unchanged ──

test("G: confirmed fill + resolved market + reported fee -- gross_pnl_usd and net_pnl_usd math unchanged", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation({ fee_status: "REPORTED", fee_usd: 0.01 }) } });
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });

  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  const settled = port.writes[0].reconciliation_v1 as Record<string, unknown>;

  assert.equal(settled.gross_pnl_usd, 4.3875);
  assert.equal(settled.settlement_status, "SETTLED_RECONCILED");
  assert.equal(settled.net_pnl_usd, 4.3775);
});

// ── H: confirmed fill + resolved market + missing fee -- RESOLVED_FEE_PENDING, no estimate ──

test("H: confirmed fill + resolved market + missing fee -- RESOLVED_FEE_PENDING, net_pnl_usd stays null", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } }); // fee_status NOT_REPORTED
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });

  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  const settled = port.writes[0].reconciliation_v1 as Record<string, unknown>;

  assert.equal(settled.settlement_status, "RESOLVED_FEE_PENDING");
  assert.equal(settled.net_pnl_usd, null, "fee is never invented or estimated");
});

// ── I: ambiguous/invalid provider resolution fails closed ──

test("I: closed market with no single 0.99+ outcome (ambiguous) -- fails closed as unresolved, never settles", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } });
  const resolver = async () => ({ resolverState: "closed_unknown" as const, candidateWinningOutcome: null, candidateWinningTokenId: null });

  const summary = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });

  assert.equal(summary.unresolved, 1);
  assert.equal(port.eventWrites, 0);
});

test("I: a contradicting re-resolution (different winning token than already recorded) fails closed as a conflict", async () => {
  const alreadyResolved = confirmedFillReconciliation({
    settlement_status: "RESOLVED_FEE_PENDING",
    resolved_at: "2026-08-25T00:00:00.000Z",
    winning_outcome: "Yes",
    winning_token_id: "token-yes",
    result_status: "WON",
    gross_pnl_usd: 4.3875,
  });
  const port = makePort({ [eventId]: { reconciliation_v1: alreadyResolved } });
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "No", candidateWinningTokenId: "token-no" });

  const summary = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });

  assert.equal(summary.conflicts, 1);
  assert.equal(port.eventWrites, 0);
});

// ── J: no source-resolution persistence call remains reachable ──

test("J: the port contract exposes exactly loadEvents/persistEvent -- no source-resolution persistence surface remains reachable", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } });
  assert.deepEqual(Object.keys(port).filter((k) => typeof (port as unknown as Record<string, unknown>)[k] === "function").sort(), ["loadEvents", "persistEvent"]);
});

test("a second pass over an already-settled event is a no-op: no further writes, no re-invented mutation", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation({ fee_status: "REPORTED", fee_usd: 0.01 }) } });
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });

  const first = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  assert.equal(first.updated, 1);
  assert.equal(port.eventWrites, 1);

  const second = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver });
  assert.equal(second.updated, 0, "an identical re-resolution against an already-settled event produces no further write");
  assert.equal(port.eventWrites, 1, "duplicate observation does not write the event again");
});

test("dry-run reports a would-update without writes", async () => {
  const port = makePort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } });
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });

  const dryRun = await reconcileExecutionLifecycleWithPort(port, { writeMode: false, eventIds: [eventId], resolver });
  assert.equal(dryRun.would_update, 1);
  assert.equal(port.eventWrites, 0);
});
