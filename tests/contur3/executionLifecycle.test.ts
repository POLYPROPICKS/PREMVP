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
import { planLedgerFillRepair } from "../../lib/executor/matchedExecutionLedgerRow";
import type { ExecutionReconciliationV1 } from "../../lib/executor/executionReconciliation";
import {
  reconcileExecutionLifecycle,
  reconcileExecutionLifecycleWithPort,
  lifecycleCandidateWindow,
  type ExecutionLifecycleDbPort,
} from "../../lib/executor/executionLifecycle";

test("bounded lifecycle windows rotate across pending candidates", () => {
  assert.deepEqual([0, 1, 2, 3].map((step) => lifecycleCandidateWindow(39, 15, step * 600_000)), [
    { from: 0, to: 14 }, { from: 15, to: 29 }, { from: 30, to: 38 }, { from: 0, to: 14 },
  ]);
  assert.equal(lifecycleCandidateWindow(0, 15, 0), null);
});

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
function makePort(metaByEvent: Record<string, Record<string, unknown>>): ExecutionLifecycleDbPort & { eventWrites: number; writes: Record<string, unknown>[]; lastLoadOptions: { eventIds?: string[]; limit: number } | null } {
  const port = {
    eventWrites: 0,
    writes: [] as Record<string, unknown>[],
    lastLoadOptions: null as { eventIds?: string[]; limit: number } | null,
    async loadEvents(options: { eventIds?: string[]; limit: number }) {
      port.lastLoadOptions = options;
      const { eventIds } = options;
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

test("normal lifecycle discovers a non-hardcoded matched execution in a bounded pass", async () => {
  const currentId = "2f106759-8a05-44d1-8bc0-6544da0e5d9c";
  const port = makePort({ [currentId]: { reconciliation_v1: confirmedFillReconciliation() } });
  const resolver = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });
  const first = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, resolver });
  assert.deepEqual(port.lastLoadOptions, { eventIds: undefined, limit: 20 });
  assert.equal(first.updated, 1);
  assert.equal((port.writes[0].reconciliation_v1 as Record<string, unknown>).settlement_status, "RESOLVED_FEE_PENDING");
  const second = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, resolver });
  assert.equal(second.updated, 0);
  assert.equal(port.eventWrites, 1);
});

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

// ── Financial closure: lifecycle repairs / mirrors ledger economics (in-memory ledger port) ──

type LedgerRow = Record<string, unknown>;

/** In-memory ledger keyed by order-event id (the ledger PK); mirrors the Supabase port's plan/guard semantics. */
function makeLedgerPort(metaByEvent: Record<string, Record<string, unknown>>, ledger: Record<string, LedgerRow>) {
  const base = makePort(metaByEvent);
  const port = Object.assign(base, {
    fillWrites: 0,
    async mirrorLedgerFill(id: string, rec: ExecutionReconciliationV1) {
      const row = ledger[id];
      if (!row) return "MISSING" as const;
      const plan = planLedgerFillRepair(row, rec);
      if (plan.kind === "UPDATE") { Object.assign(row, plan.patch); port.fillWrites++; return "UPDATED" as const; }
      return plan.kind;
    },
    async mirrorLedgerSettlement(id: string, rec: ExecutionReconciliationV1) {
      const row = ledger[id];
      if (!row || (rec.result_status !== "WON" && rec.result_status !== "LOST") || !rec.resolved_at || rec.gross_pnl_usd == null) return;
      const feeReported = rec.fee_status === "REPORTED" && rec.fee_usd != null;
      const realPnl = feeReported ? rec.net_pnl_usd : null;
      const stake = Number(row.executed_stake ?? rec.executed_notional_usd);
      Object.assign(row, {
        bet_status: rec.result_status, settled_at: rec.resolved_at, gross_pnl: rec.gross_pnl_usd,
        ...(feeReported ? { fee_paid_real: rec.fee_usd } : {}),
        real_pnl: realPnl, real_roi_on_stake: realPnl != null && stake > 0 ? realPnl / stake * 100 : null,
      });
    },
  });
  return port;
}

const emptyFillLedger = () => ({ id: eventId, bet_status: "FILLED", executed_stake: null, fill_price: null, fee_paid_real: null, settled_at: null, gross_pnl: null, real_pnl: null, real_roi_on_stake: null });
const unresolved = async () => ({ resolverState: "active_unresolved" as const, candidateWinningOutcome: null, candidateWinningTokenId: null });
const yesWins = async () => ({ resolverState: "resolved_candidate" as const, candidateWinningOutcome: "Yes", candidateWinningTokenId: "token-yes" });

test("lifecycle repairs an existing FILLED ledger row's fill economics before market resolution", async () => {
  const ledger = { [eventId]: emptyFillLedger() };
  const port = makeLedgerPort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } }, ledger);
  const summary = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: unresolved });
  assert.equal(summary.unresolved, 1);
  assert.equal(ledger[eventId].executed_stake, 2.3625);
  assert.equal(ledger[eventId].fill_price, 0.35);
  assert.equal(ledger[eventId].fee_paid_real, null, "unreported fee stays NULL, never zero");
  assert.equal(ledger[eventId].bet_status, "FILLED");
  assert.equal(ledger[eventId].settled_at, null, "no settlement without market resolution");
});

test("lifecycle repair is idempotent and creates no duplicate ledger rows", async () => {
  const ledger = { [eventId]: emptyFillLedger() };
  const port = makeLedgerPort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } }, ledger);
  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: unresolved });
  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: unresolved });
  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: yesWins });
  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: yesWins });
  assert.equal(port.fillWrites, 1, "fill facts are written exactly once");
  assert.deepEqual(Object.keys(ledger), [eventId]);
  assert.equal(ledger[eventId].executed_stake, 2.3625, "stake is never double-counted");
});

test("WON/LOST with unreported fee: gross PnL + settled_at known, real_pnl and fee stay NULL", async () => {
  const ledger = { [eventId]: emptyFillLedger() };
  const port = makeLedgerPort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } }, ledger);
  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: yesWins });
  assert.equal(ledger[eventId].bet_status, "WON");
  assert.ok(ledger[eventId].settled_at);
  assert.equal(ledger[eventId].gross_pnl, 4.3875);
  assert.equal(ledger[eventId].real_pnl, null);
  assert.equal(ledger[eventId].real_roi_on_stake, null);
  assert.equal(ledger[eventId].fee_paid_real, null);
  assert.equal(ledger[eventId].executed_stake, 2.3625);
});

test("WON with reported fee: fee, net PnL and ROI populate correctly", async () => {
  const ledger = { [eventId]: emptyFillLedger() };
  const port = makeLedgerPort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation({ fee_status: "REPORTED", fee_usd: 0.01 }) } }, ledger);
  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: yesWins });
  assert.equal(ledger[eventId].fee_paid_real, 0.01);
  assert.equal(ledger[eventId].real_pnl, 4.3775);
  assert.equal(ledger[eventId].real_roi_on_stake, 4.3775 / 2.3625 * 100);
});

test("settlement pass never regresses a known fee to NULL when the fee is not reported", async () => {
  const ledger = { [eventId]: { ...emptyFillLedger(), executed_stake: 2.3625, fill_price: 0.35, fee_paid_real: 0.01 } };
  const port = makeLedgerPort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } }, ledger);
  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: yesWins });
  assert.equal(ledger[eventId].fee_paid_real, 0.01);
});

test("partial fill: lifecycle repairs ledger with actual executed notional, not requested stake", async () => {
  const ledger = { [eventId]: emptyFillLedger() };
  const partial = confirmedFillReconciliation({ executed_shares: 2, actual_fill_price: 0.49, executed_notional_usd: 0.98 });
  const port = makeLedgerPort({ [eventId]: { reconciliation_v1: partial } }, ledger);
  await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: unresolved });
  assert.equal(ledger[eventId].executed_stake, 0.98);
  assert.equal(ledger[eventId].fill_price, 0.49);
});

test("conflicting non-null ledger economic fact fails closed: counted conflict, no overwrite, no settlement mirror", async () => {
  const ledger = { [eventId]: { ...emptyFillLedger(), executed_stake: 2.5 } };
  const port = makeLedgerPort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } }, ledger);
  const summary = await reconcileExecutionLifecycleWithPort(port, { writeMode: true, eventIds: [eventId], resolver: yesWins });
  assert.equal(summary.conflicts, 1);
  assert.equal(ledger[eventId].executed_stake, 2.5, "conflicting stake is never overwritten");
  assert.equal(ledger[eventId].fill_price, null);
  assert.equal(ledger[eventId].gross_pnl, null, "ledger settlement is not mirrored over conflicting money facts");
});

test("dry-run never writes the ledger", async () => {
  const ledger = { [eventId]: emptyFillLedger() };
  const port = makeLedgerPort({ [eventId]: { reconciliation_v1: confirmedFillReconciliation() } }, ledger);
  await reconcileExecutionLifecycleWithPort(port, { writeMode: false, eventIds: [eventId], resolver: yesWins });
  assert.equal(ledger[eventId].executed_stake, null);
  assert.equal(port.fillWrites, 0);
});

test("Supabase-backed lifecycle port repairs the ledger via a NULL-guarded update on the order-event PK", async () => {
  const meta = { reconciliation_v1: confirmedFillReconciliation() };
  const ledgerRow: LedgerRow = { id: eventId, executed_stake: null, fill_price: null, fee_paid_real: null, raw_order: {} };
  const updates: { patch: Record<string, unknown>; nullGuards: string[]; id: unknown }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = {
    from(table: string) {
      if (table === "executor_order_events") {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "not", "in"]) q[m] = () => q;
        q.limit = async () => ({ data: [{ id: eventId, executor_meta: meta }], error: null });
        return q;
      }
      assert.equal(table, "bet_execution_ledger");
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...ledgerRow }, error: null }) }) }),
        update(patch: Record<string, unknown>) {
          const call = { patch, nullGuards: [] as string[], id: null as unknown };
          const chain: Record<string, unknown> = {
            eq: (_c: string, v: unknown) => { call.id = v; return chain; },
            is: (c: string, v: unknown) => { assert.equal(v, null); call.nullGuards.push(c); return chain; },
            select: async () => { updates.push(call); Object.assign(ledgerRow, patch); return { data: [{ id: call.id }], error: null }; },
          };
          return chain;
        },
      };
    },
  };
  // Hermetic: the default provider resolver is stubbed at the network edge (market stays unresolved).
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ active: true, closed: false }]), { status: 200 })) as typeof fetch;
  let summary;
  try { summary = await reconcileExecutionLifecycle(supabase, { writeMode: true, eventIds: [eventId] }); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(summary.conflicts, 0);
  assert.equal(updates.length >= 1, true);
  const fill = updates[0];
  assert.equal(fill.id, eventId);
  assert.deepEqual(fill.patch, { executed_stake: 2.3625, fill_price: 0.35 });
  assert.deepEqual(fill.nullGuards.sort(), ["executed_stake", "fill_price"]);
});

test("Supabase-backed fill repair that matches zero rows (concurrent writer) is not reported as an update", async () => {
  const meta = { reconciliation_v1: confirmedFillReconciliation() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = {
    from(table: string) {
      if (table === "executor_order_events") {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "not", "in"]) q[m] = () => q;
        q.limit = async () => ({ data: [{ id: eventId, executor_meta: meta }], error: null });
        return q;
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: eventId, executed_stake: null, fill_price: null, fee_paid_real: null }, error: null }) }) }),
        update: () => { const c: Record<string, unknown> = {}; c.eq = () => c; c.is = () => c; c.select = async () => ({ data: [], error: null }); return c; },
      };
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ active: true, closed: false }]), { status: 200 })) as typeof fetch;
  try {
    const summary = await reconcileExecutionLifecycle(supabase, { writeMode: true, eventIds: [eventId] });
    assert.equal(summary.conflicts, 0);
  } finally { globalThis.fetch = realFetch; }
});
