// P2_MAKER_ACCOUNTING_AND_CONCURRENCY_CLOSURE_V1
//   node --import tsx --test tests/contur3/makerAccountingClosure.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordResultAndAuthorizeMaker,
  readExecutionAttempts,
  makerIdempotencyKey,
  normalizeMakerCallbackForAccounting,
  type MakerFallbackPort,
  type IrelandExecutionResult,
} from "../../lib/executor/makerFallbackAuthorization";
import {
  casWriteQueue,
  recordAttemptResultCas,
  claimMakerCommandCas,
  type QueueCasPort,
  type QueueCasRow,
} from "../../lib/executor/queueAttemptsCas";
import { handleOrderEventSubmission, type OrderEventDbPort, type StoredOrderEvent } from "../../lib/executor/executorCallbackContract";
import { buildEconomicTelemetry } from "../../lib/executor/economicTelemetry";
import { buildExecutionReconciliation } from "../../lib/executor/executionReconciliation";
import { buildMatchedExecutionLedgerRow } from "../../lib/executor/matchedExecutionLedgerRow";
import type { EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

const NOW = new Date("2026-10-01T18:00:00.000Z");
const IDEM = "idem_taker_1";
const MK = makerIdempotencyKey(IDEM);

function queueRow(over: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res1", plan_run_id: "plan1", rebalance_run_id: "rb1",
    match_family_key: "provider:polymarket:777:2026-10-01", event_title: "A v B", event_slug: "a-v-b",
    sport: "soccer", league: "x", game_start_iso: "2026-10-01T19:00:00.000Z",
    condition_id: "cond1", token_id: "tok1", side: "YES", market_slug: "m", market_title: "m",
    market_family: "MONEYLINE", score: 1, coverage: 1, tier: "TIER1", stake_usd: 2.5,
    preferred_entry_iso: "2026-10-01T17:00:00.000Z", latest_entry_iso: "2026-10-01T18:50:00.000Z",
    selection_rank: 1, selection_reason: null, status: "FAILED", order_key: "k", idempotency_key: IDEM,
    diagnostics: { max_entry_price: 0.54, physical_event_id: "provider:polymarket:777:2026-10-01", model_lineage_v1: { model_variant: "B", policy_version: "v9" } },
    ...over,
  };
}

/** In-memory Queue row behind the SAME CAS port the Supabase adapter implements. */
function memoryCas(initial: EventExecutionQueueRow, hooks: { beforeCas?: (n: number) => void } = {}) {
  const st = { row: structuredClone(initial) as EventExecutionQueueRow & { updated_at?: string }, version: 0, casCalls: 0 };
  st.row.updated_at = "v0";
  const port: QueueCasPort = {
    async read() {
      return { status: st.row.status, diagnostics: structuredClone(st.row.diagnostics), updated_at: st.row.updated_at ?? null } as QueueCasRow;
    },
    async compareAndSet(_id, expected, columns) {
      st.casCalls++;
      hooks.beforeCas?.(st.casCalls);
      if (st.row.updated_at !== expected) return null;
      if (columns.status !== undefined) st.row.status = columns.status as never;
      st.row.diagnostics = columns.diagnostics as Record<string, unknown>;
      st.row.updated_at = `v${++st.version}`;
      return { ...st.row };
    },
  };
  return { port, st };
}

function authPort(cas: ReturnType<typeof memoryCas>): MakerFallbackPort & { claims: number } {
  const p = {
    claims: 0,
    async loadQueueRowByIdempotencyKey(k: string) { return k === IDEM ? structuredClone(cas.st.row) : null; },
    async fetchBook() { return { bestBid: 0.48, bestAsk: 0.5, tickSize: 0.01 }; },
    async recordResult(id: string, slot: "taker_attempt_1" | "maker_fallback_1", r: IrelandExecutionResult) { await recordAttemptResultCas(cas.port, id, slot, r); },
    async claimMakerFallback(id: string, c: Parameters<MakerFallbackPort["claimMakerFallback"]>[1]) {
      const won = await claimMakerCommandCas(cas.port, id, c);
      if (won) p.claims++;
      return won;
    },
  };
  return p;
}

const takerZero = (over: Record<string, unknown> = {}) => ({
  idempotency_key: IDEM, condition_id: "cond1", token_id: "tok1", side: "YES",
  ireland_execution_result: { attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER", result_class: "PROVEN_ZERO_FILL_PRICE", requested_quantity: 5, filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true, ...over },
});

const makerCb = (result: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: MK, parent_idempotency_key: IDEM,
  attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES",
  stake_usd: 2.5, submitted_size: 5.1, submitted_price: 0.49, clob_order_id: "v-maker-1",
  ireland_execution_result: { attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER", venue_order_id: "v-maker-1", requested_quantity: 5.1, ...result },
  ...extra,
});

async function authorized() {
  const cas = memoryCas(queueRow());
  const port = authPort(cas);
  const out = await recordResultAndAuthorizeMaker(port, takerZero(), NOW);
  assert.equal(out.kind, "MAKER_AUTHORIZED");
  return { cas, port };
}

function fakeOrderPort(getQueue: () => EventExecutionQueueRow) {
  const events = new Map<string, StoredOrderEvent>();
  const calls = { statusUpdates: 0, inserts: 0 };
  const port: OrderEventDbPort = {
    async findQueueRowByIdempotencyKey(k) { const q = getQueue(); return q.idempotency_key === k ? structuredClone(q) : null; },
    async findOrderEventByIdempotencyKey(k) { return events.get(k) ?? null; },
    async findOrderEventByClobOrderId() { return null; },
    async updateQueueRowStatus() { calls.statusUpdates++; },
    async insertOrderEvent(raw) {
      calls.inserts++;
      const row: StoredOrderEvent = {
        id: "ev-maker-1", created_at: NOW.toISOString(), idempotency_key: raw.idempotency_key as string,
        condition_id: raw.condition_id as string, token_id: raw.token_id as string, side: raw.side as string, selected_side: null,
        market_slug: null, submitted_size: raw.submitted_size as number, submitted_price: raw.submitted_price as number, clob_order_id: raw.clob_order_id as string,
      };
      events.set(row.idempotency_key as string, row);
      return { ok: true, row };
    },
    async updateOrderEventProgression() { throw new Error("unexpected"); },
  };
  return { port, calls, events };
}

/** Full economic path on the parent identity, as the order-events route runs it. */
function economics(queue: EventExecutionQueueRow, raw: Record<string, unknown>, row: StoredOrderEvent) {
  const normalized = normalizeMakerCallbackForAccounting(raw);
  const view = { ...queue, idempotency_key: raw.idempotency_key as string };
  const ev = { ...row, making_amount: null, taking_amount: null, fee_usd: null };
  const telemetry = buildEconomicTelemetry({ queue: view as never, event: ev as never, raw: normalized });
  const reconciliation = buildExecutionReconciliation({ queue: view as never, event: ev as never, raw: normalized, telemetry });
  return { normalized, telemetry, reconciliation };
}

test("taker authoritative zero -> exactly one maker command", async () => {
  const { port } = await authorized();
  assert.equal(port.claims, 1);
});

test("maker callback without parent_idempotency_key fails closed: no mutation, no accounting, typed flag", async () => {
  const { cas, port } = await authorized();
  const before = JSON.stringify(cas.st.row.diagnostics);
  const raw = makerCb({ result_class: "FULL_FILL", filled_quantity: 5.1, average_fill_price: 0.49, terminal: true, economic_exposure_proven_zero: false });
  delete (raw as Record<string, unknown>).parent_idempotency_key;
  const out = await recordResultAndAuthorizeMaker(port, raw, NOW);
  assert.deepEqual(out, { kind: "MAKER_CALLBACK_REJECTED", reason: "PARENT_IDEMPOTENCY_KEY_REQUIRED" });
  assert.equal(JSON.stringify(cas.st.row.diagnostics), before);
  // the contract seam rejects it too, before any queue lookup or insert
  const f = fakeOrderPort(() => cas.st.row);
  const outcome = await handleOrderEventSubmission(f.port, raw);
  assert.equal(outcome.kind, "REJECTED_MAKER_PARENT_IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(f.calls.inserts, 0);
  // the maker key is never treated as a parent key
  const asParent = await handleOrderEventSubmission(f.port, { ...raw, parent_idempotency_key: MK });
  assert.equal(asParent.kind, "REJECTED_QUEUE_ROW_NOT_FOUND");
});

test("maker callback not matching the authorized command is rejected", async () => {
  const { cas, port } = await authorized();
  const wrongKey = await recordResultAndAuthorizeMaker(port, makerCb({ result_class: "PARTIAL_FILL", filled_quantity: 1 }, { idempotency_key: "forged" }), NOW);
  assert.deepEqual(wrongKey, { kind: "MAKER_CALLBACK_REJECTED", reason: "MAKER_NOT_AUTHORIZED_FOR_PARENT" });
  const wrongToken = await recordResultAndAuthorizeMaker(port, makerCb({ result_class: "PARTIAL_FILL", filled_quantity: 1 }, { token_id: "other" }), NOW);
  assert.deepEqual(wrongToken, { kind: "MAKER_CALLBACK_REJECTED", reason: "IDENTITY_MISMATCH" });
  const f = fakeOrderPort(() => cas.st.row);
  const unauth = await handleOrderEventSubmission(f.port, makerCb({ result_class: "PARTIAL_FILL", filled_quantity: 1 }, { idempotency_key: "forged" }));
  assert.equal(unauth.kind, "REJECTED_MAKER_NOT_AUTHORIZED");
});

test("maker FULL_FILL: order event persisted on maker key, parent status untouched, reconciliation + ledger see the actual fill", async () => {
  const { cas } = await authorized();
  const raw = makerCb({ result_class: "FULL_FILL", filled_quantity: 5.1, remaining_quantity: 0, average_fill_price: 0.48, terminal: true, economic_exposure_proven_zero: false });
  const f = fakeOrderPort(() => cas.st.row);
  const out = await handleOrderEventSubmission(f.port, normalizeMakerCallbackForAccounting(raw));
  assert.equal(out.kind, "INSERTED");
  assert.ok(out.kind === "INSERTED");
  assert.equal(out.row.idempotency_key, MK, "order event keeps the maker's own idempotency key");
  assert.equal(f.calls.statusUpdates, 0, "parent Queue status is not re-marked by a maker callback");
  assert.equal(out.queueMark.kind, "ALREADY_EXECUTED");

  const { normalized, telemetry, reconciliation } = economics(cas.st.row, raw, out.row);
  assert.equal(reconciliation.fill_status, "MATCHED_CONFIRMED");
  assert.equal(reconciliation.executed_shares, 5.1);
  assert.equal(reconciliation.actual_fill_price, 0.48, "actual fill price (not the 0.49 limit) preserved");
  assert.equal(reconciliation.executed_notional_usd, 2.448);
  assert.equal(reconciliation.idempotency_key, MK);
  assert.equal(reconciliation.queue_id, "q1");
  assert.equal(reconciliation.reservation_id, "res1");
  assert.equal(reconciliation.clob_order_id, "v-maker-1");
  assert.equal(telemetry.executed.executed_notional_usd.value, 2.448);
  assert.equal(telemetry.executed.executed_notional_usd.evidence_state, "KNOWN");
  assert.equal(telemetry.costs.fee_usd.value, null, "no fabricated fee");

  const ledger = buildMatchedExecutionLedgerRow({ id: out.row.id, raw_event_json: normalized, candidate_snapshot_json: null }, cas.st.row, reconciliation);
  assert.equal(ledger.id, "ev-maker-1");
  assert.equal(ledger.executed_stake, 2.448);
  assert.equal(ledger.exchange_order_id, "v-maker-1");
  assert.equal(ledger.condition_id, "cond1");
  assert.equal(ledger.token_id, "tok1");
  assert.equal(ledger.selected_side, "YES");
  assert.equal(ledger.model_variant, "B");
  const lineage = (ledger.raw_signal as { execution_attempt: Record<string, unknown> }).execution_attempt;
  assert.equal(lineage.attempt_id, "MAKER_FALLBACK_1");
  assert.equal(lineage.parent_idempotency_key, IDEM);
  assert.equal(lineage.physical_event_id, "provider:polymarket:777:2026-10-01");
  assert.equal(lineage.reservation_id, "res1");
});

test("maker PARTIAL_FILL: real exposure is accounted, no third attempt", async () => {
  const { cas, port } = await authorized();
  const raw = makerCb({ result_class: "PARTIAL_FILL", filled_quantity: 2, remaining_quantity: 3.1, average_fill_price: 0.49, terminal: false, economic_exposure_proven_zero: false });
  const f = fakeOrderPort(() => cas.st.row);
  const out = await handleOrderEventSubmission(f.port, normalizeMakerCallbackForAccounting(raw));
  assert.ok(out.kind === "INSERTED");
  const { reconciliation } = economics(cas.st.row, raw, out.row);
  assert.equal(reconciliation.fill_status, "MATCHED_CONFIRMED");
  assert.equal(reconciliation.executed_shares, 2);
  assert.equal(reconciliation.executed_notional_usd, 0.98);
  const rec = await recordResultAndAuthorizeMaker(port, raw, NOW);
  assert.equal(rec.kind, "RESULT_RECORDED_NO_FURTHER_ATTEMPT");
  // a later "zero" callback for either attempt can never create another command
  const again = await recordResultAndAuthorizeMaker(port, takerZero(), NOW);
  assert.notEqual(again.kind, "MAKER_AUTHORIZED");
  assert.equal(port.claims, 1);
});

for (const [name, result, extra] of [
  ["expired", { result_class: "PROVEN_ZERO_FILL_EXPIRED", filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true }, { order_status: "expired" }],
  ["cancelled", { result_class: "PROVEN_ZERO_FILL_NO_LIQUIDITY", filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true }, { order_status: "canceled" }],
  ["contradictory matched status", { result_class: "PROVEN_ZERO_FILL_EXPIRED", filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true }, { order_status: "matched", executed_size: 5.1, average_fill_price: 0.49 }],
] as const) {
  test(`maker zero-fill terminal (${name}) creates no ledger fill and no third attempt`, async () => {
    const { cas, port } = await authorized();
    const raw = makerCb(result, extra);
    const f = fakeOrderPort(() => cas.st.row);
    const out = await handleOrderEventSubmission(f.port, normalizeMakerCallbackForAccounting(raw));
    assert.ok(out.kind === "INSERTED");
    const { normalized, reconciliation } = economics(cas.st.row, raw, out.row);
    assert.notEqual(reconciliation.fill_status, "MATCHED_CONFIRMED");
    assert.ok(!reconciliation.executed_shares, "no executed shares");
    assert.equal(normalized.executed_size, undefined);
    assert.equal(await recordResultAndAuthorizeMaker(port, raw, NOW).then((o) => o.kind), "RESULT_RECORDED_NO_FURTHER_ATTEMPT");
    assert.equal(port.claims, 1);
  });
}

test("maker economics keep taker and maker identities distinct on one Final Identity", async () => {
  const { cas } = await authorized();
  const raw = makerCb({ result_class: "FULL_FILL", filled_quantity: 5.1, average_fill_price: 0.49, terminal: true, economic_exposure_proven_zero: false });
  const f = fakeOrderPort(() => cas.st.row);
  const out = await handleOrderEventSubmission(f.port, normalizeMakerCallbackForAccounting(raw));
  assert.ok(out.kind === "INSERTED");
  const { reconciliation } = economics(cas.st.row, raw, out.row);
  assert.notEqual(reconciliation.idempotency_key, IDEM);
  assert.equal(reconciliation.queue_id, cas.st.row.id);
  // coexistence: a maker can exist only after the taker proved filled_quantity=0 & zero exposure,
  // so a taker fill and a maker fill cannot both exist for one bet.
});

test("stale Queue status update cannot erase the maker command", async () => {
  const { cas } = await authorized();
  const stale = structuredClone(cas.st.row.diagnostics);
  delete stale.execution_attempts_v1; // snapshot a status writer took before authorization
  await casWriteQueue(cas.port, "q1", () => ({ status: "EXECUTED", diagnostics: { ...stale, clob_order_id: "t1" } }));
  const a = readExecutionAttempts(cas.st.row.diagnostics);
  assert.ok(a.maker_fallback_1?.command);
  assert.ok(a.taker_attempt_1?.result);
  assert.equal(cas.st.row.status, "EXECUTED");
  assert.equal(cas.st.row.diagnostics.clob_order_id, "t1");
});

test("stale Queue status update cannot erase the maker result", async () => {
  const { cas, port } = await authorized();
  const stale = structuredClone(cas.st.row.diagnostics);
  await recordResultAndAuthorizeMaker(port, makerCb({ result_class: "PARTIAL_FILL", filled_quantity: 2, average_fill_price: 0.49, terminal: false, economic_exposure_proven_zero: false }), NOW);
  await casWriteQueue(cas.port, "q1", () => ({ status: "EXPIRED", diagnostics: stale, extra: {} }));
  const a = readExecutionAttempts(cas.st.row.diagnostics);
  assert.equal(a.maker_fallback_1?.result?.filled_quantity, 2);
  assert.ok(a.maker_fallback_1?.command);
});

test("concurrent writer between read and CAS: retry converges and keeps everything", async () => {
  let injected = false;
  const base = memoryCas(queueRow());
  const racing = memoryCas(queueRow(), {
    beforeCas: () => {
      if (injected) return;
      injected = true;
      // a concurrent writer lands a status update first
      racing.st.row.status = "SENT" as never;
      racing.st.row.updated_at = "raced";
    },
  });
  void base;
  const port = authPort(racing);
  const out = await recordResultAndAuthorizeMaker(port, takerZero(), NOW);
  assert.equal(out.kind, "MAKER_AUTHORIZED");
  assert.ok(racing.st.casCalls >= 3, "lost a CAS, re-read, converged");
  assert.equal(racing.st.row.status, "SENT");
  assert.ok(readExecutionAttempts(racing.st.row.diagnostics).maker_fallback_1?.command);
});

test("two callbacks racing -> one coherent execution_attempts_v1, one command", async () => {
  const cas = memoryCas(queueRow());
  const port = authPort(cas);
  const outs = await Promise.all([
    recordResultAndAuthorizeMaker(port, takerZero(), NOW),
    recordResultAndAuthorizeMaker(port, takerZero(), NOW),
    recordResultAndAuthorizeMaker(port, takerZero({ result_class: "PROVEN_ZERO_FILL_EXPIRED" }), NOW),
  ]);
  assert.equal(port.claims, 1);
  assert.equal(outs.filter((o) => o.kind === "MAKER_AUTHORIZED").length, 1);
  const a = readExecutionAttempts(cas.st.row.diagnostics);
  assert.ok(a.taker_attempt_1?.result);
  assert.equal(a.maker_fallback_1?.command?.idempotency_key, MK);
});

test("prior taker fill + later false zero-proof -> maker blocked, fill preserved", async () => {
  const cas = memoryCas(queueRow());
  const port = authPort(cas);
  await recordResultAndAuthorizeMaker(port, takerZero({ result_class: "PARTIAL_FILL", filled_quantity: 2, economic_exposure_proven_zero: false }), NOW);
  const later = await recordResultAndAuthorizeMaker(port, takerZero(), NOW);
  assert.equal(later.kind, "MAKER_BLOCKED");
  assert.equal(port.claims, 0);
  assert.equal(readExecutionAttempts(cas.st.row.diagnostics).taker_attempt_1?.result?.filled_quantity, 2);
});

test("prior maker fill + later zero-proof -> maker exposure preserved (monotonic)", async () => {
  const { cas, port } = await authorized();
  await recordResultAndAuthorizeMaker(port, makerCb({ result_class: "PARTIAL_FILL", filled_quantity: 2, average_fill_price: 0.49, terminal: false, economic_exposure_proven_zero: false }), NOW);
  await recordResultAndAuthorizeMaker(port, makerCb({ result_class: "PROVEN_ZERO_FILL_EXPIRED", filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true }), NOW);
  const r = readExecutionAttempts(cas.st.row.diagnostics).maker_fallback_1?.result;
  assert.equal(r?.filled_quantity, 2);
  assert.equal(r?.result_class, "PARTIAL_FILL");
  // a larger/later fill still advances
  await recordResultAndAuthorizeMaker(port, makerCb({ result_class: "FULL_FILL", filled_quantity: 5.1, average_fill_price: 0.49, terminal: true, economic_exposure_proven_zero: false }), NOW);
  assert.equal(readExecutionAttempts(cas.st.row.diagnostics).maker_fallback_1?.result?.filled_quantity, 5.1);
});

test("maker price above the authorized limit is rejected at the order-event seam", async () => {
  const { cas } = await authorized();
  const f = fakeOrderPort(() => cas.st.row);
  const out = await handleOrderEventSubmission(f.port, makerCb({ result_class: "PARTIAL_FILL", filled_quantity: 1 }, { submitted_price: 0.5, submitted_size: 4 }));
  assert.deepEqual(out, { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "MAKER_PRICE_ABOVE_COMMAND_LIMIT" });
});

test("no MAKER_FALLBACK_2: command is single-slot and no result class re-authorizes", async () => {
  const { cas, port } = await authorized();
  for (const cls of ["PROVEN_ZERO_FILL_PRICE", "PROVEN_ZERO_FILL_EXPIRED", "PROVEN_REJECTED_BEFORE_SUBMISSION"]) {
    await recordResultAndAuthorizeMaker(port, makerCb({ result_class: cls, filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true }), NOW);
  }
  assert.equal(port.claims, 1);
  assert.equal(Object.keys(readExecutionAttempts(cas.st.row.diagnostics)).sort().join(), "maker_fallback_1,taker_attempt_1");
});

test("stale zero-proof snapshot cannot claim a maker after a racing fill was recorded", async () => {
  const cas = memoryCas(queueRow());
  const port = authPort(cas);
  // callback A evaluated zero-proof on a stale snapshot ...
  const staleRow = structuredClone(cas.st.row);
  // ... but callback B's fill is recorded first
  await recordAttemptResultCas(cas.port, "q1", "taker_attempt_1", {
    attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER", result_class: "PARTIAL_FILL", requested_quantity: 5, filled_quantity: 2,
    remaining_quantity: 3, average_fill_price: 0.5, venue_order_id: "v", terminal: false, economic_exposure_proven_zero: false, fee_usd: null, received_at_iso: NOW.toISOString(),
  });
  const built = await recordResultAndAuthorizeMaker(
    { ...port, loadQueueRowByIdempotencyKey: async () => staleRow, recordResult: async () => undefined },
    takerZero(),
    NOW,
  );
  assert.notEqual(built.kind, "MAKER_AUTHORIZED");
  assert.equal(readExecutionAttempts(cas.st.row.diagnostics).maker_fallback_1?.command, undefined);
});

test("MAKER_FALLBACK_2 (any other MAKER_* attempt id) is rejected everywhere", async () => {
  const { cas, port } = await authorized();
  const raw = makerCb({ result_class: "PARTIAL_FILL", filled_quantity: 1 }, { attempt_id: "MAKER_FALLBACK_2" });
  const out = await recordResultAndAuthorizeMaker(port, raw, NOW);
  assert.deepEqual(out, { kind: "MAKER_CALLBACK_REJECTED", reason: "UNKNOWN_ATTEMPT_ID" });
  const f = fakeOrderPort(() => cas.st.row);
  assert.equal((await handleOrderEventSubmission(f.port, raw)).kind, "REJECTED_MAKER_NOT_AUTHORIZED");
  assert.equal(f.calls.inserts, 0);
});

test("zero-fill maker strips amounts and any matched status", () => {
  const n = normalizeMakerCallbackForAccounting(makerCb(
    { result_class: "PROVEN_ZERO_FILL_EXPIRED", filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true },
    { status: "matched", taking_amount: 5.1, making_amount: 2.5 },
  ));
  assert.equal(n.taking_amount, undefined);
  assert.equal(n.making_amount, undefined);
  assert.equal(n.status, "unfilled");
});
