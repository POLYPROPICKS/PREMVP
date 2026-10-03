// PREMVP_TERMINAL_ZERO_TO_FALLBACK_CONTRACT_V2
//   node --import tsx --test tests/contur3/terminalZeroToFallback.test.ts
//
// Whole transition, on ONE frozen T10 MAKER_FIRST Queue row:
//   accepted primary MAKER_FIRST order
//   -> released outcome-only terminal-zero callback (no numeric filled_quantity)
//   -> same immutable order identity -> progression ACK (no 409)
//   -> zero-fill reconciliation (TERMINAL_NO_FILL / SETTLED_NO_FILL, nothing fabricated)
//   -> exactly one same-token MAKER_FALLBACK_1 authorization (idempotent)
//   -> executor-facing Queue `maker_fallback_commands` shape
//   -> the fallback's own callback binds to the same Queue row.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callbackIsTerminalProvenZero,
  isTerminalProvenZeroResult,
  normalizeMakerCallbackForAccounting,
  readExecutionAttempts,
  readIrelandExecutionResult,
  recordResultAndAuthorizeMaker,
  selectExecutorMakerFallbackCommands,
  type MakerFallbackCommand,
  type MakerFallbackPort,
} from "../../lib/executor/makerFallbackAuthorization";
import { claimMakerCommandCas, type QueueCasPort, type QueueCasRow } from "../../lib/executor/queueAttemptsCas";
import { handleOrderEventSubmission, type OrderEventDbPort, type StoredOrderEvent } from "../../lib/executor/executorCallbackContract";
import { buildEconomicTelemetry } from "../../lib/executor/economicTelemetry";
import { buildExecutionReconciliation } from "../../lib/executor/executionReconciliation";
import { eventExposureNotProvenZero } from "../../lib/executor/eventExecutionQueue";
import { QUEUE_MAX_ENTRY_PRICE, type EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

const NOW = new Date("2026-10-03T19:56:20.000Z");
const IDEM = "idem_mf_1";
const EVENT = "provider:polymarket:991:2026-10-03";
const LATEST = "2026-10-03T20:40:00.000Z";
const KICKOFF = "2026-10-03T21:00:00.000Z";

function frozenMakerFirst(over: Record<string, unknown> = {}) {
  return {
    execution_policy_version: "T10_ECONOMIC_ACTION_EXECUTION_V1", economic_policy_version: "T10_ECONOMIC_ACTION_POLICY_V1",
    execution_mode: "MAKER_FIRST", price_authority_version: "T30_EXACT_BID_ANCHOR_V1", price_authority_observation_id: "obs1",
    p_buy_max: 0.5, reference_status: "STRONG", physical_event_id: EVENT, condition_id: "cond1", token_id: "tok1", side: "YES",
    market_family: "TOTALS", stake_usd: 2.5, hard_price_cap: 0.54, latest_entry_iso: LATEST,
    tick_size: 0.01, minimum_order_size: 5, spread_telemetry: 0.02, activation_switch: "T10_ECONOMIC_ACTION_ACTIVATION",
    taker: null, maker: { maker_limit_price: 0.5, maker_shares: 5 }, ...over,
  };
}

function makerFirstRow(over: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res1", plan_run_id: "plan1", rebalance_run_id: "rb1", match_family_key: EVENT,
    event_title: "A v B", event_slug: "a-v-b", sport: "soccer", league: "x", game_start_iso: KICKOFF,
    condition_id: "cond1", token_id: "tok1", side: "YES", market_slug: "m", market_title: "m", market_family: "TOTALS",
    score: null, coverage: null, tier: "TIER1", stake_usd: 2.5, preferred_entry_iso: "2026-10-03T19:40:00.000Z",
    latest_entry_iso: LATEST, selection_rank: 1, selection_reason: null, status: "EXECUTED",
    order_key: "k", idempotency_key: IDEM,
    diagnostics: { physical_event_id: EVENT, max_entry_price: 0.5, max_stake_usd: 4, t10_economic_action_v1: frozenMakerFirst() },
    ...over,
  } as EventExecutionQueueRow;
}

/** The accepted (HTTP 200) original primary-maker submit callback. */
const accepted = (extra: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES",
  stake_usd: 2.5, submitted_size: 5, submitted_price: 0.5, clob_order_id: "v-1", order_status: "live", ...extra,
});

/**
 * The released terminal callback: outcome-only execution_result_v1 (no filled_quantity / terminal /
 * economic_exposure_proven_zero scalars -- those follow from the released outcome definition).
 */
const terminal = (v1: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  ...accepted({ order_status: "CANCELLED", stake_usd: 2.4, ...extra }),
  execution_result_v1: { attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST", outcome: "PROVEN_ZERO_FILL_CANCELLED", venue_order_id: "v-1", ...v1 },
});

// ── ports ──────────────────────────────────────────────────────────────────

function world(row: EventExecutionQueueRow = makerFirstRow(), book = { bestBid: 0.3, bestAsk: 0.53, tickSize: 0.01 } as { bestBid: number | null; bestAsk: number | null; tickSize: number | null; minimumOrderSize?: number | null }) {
  const st = { row, events: new Map<string, StoredOrderEvent & { raw: Record<string, unknown> }>(), claims: 0, inserts: 0, statuses: [] as string[] };
  const maker: MakerFallbackPort = {
    async loadQueueRowByIdempotencyKey(k) { return k === IDEM ? structuredClone(st.row) : null; },
    async fetchBook() { return book; },
    async recordResult(_id, slot, result) {
      const a = readExecutionAttempts(st.row.diagnostics);
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, [slot]: { ...(a[slot] ?? {}), result } } } };
    },
    async claimMakerFallback(_id, command) {
      const a = readExecutionAttempts(st.row.diagnostics);
      if (a.maker_fallback_1?.command) return false;
      st.claims++;
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, maker_fallback_1: { command } } } };
      return true;
    },
  };
  const orders: OrderEventDbPort = {
    async findQueueRowByIdempotencyKey(k) { return k === IDEM ? structuredClone(st.row) : null; },
    async findOrderEventByIdempotencyKey(k) { return [...st.events.values()].find((e) => e.idempotency_key === k) ?? null; },
    async findOrderEventByClobOrderId(c) { return [...st.events.values()].find((e) => e.clob_order_id === c) ?? null; },
    async updateQueueRowStatus(_id, patch) { st.statuses.push(patch.status); st.row = { ...st.row, status: patch.status as never }; },
    async insertOrderEvent(raw) {
      st.inserts++;
      const ev = { id: `e${st.inserts}`, created_at: NOW.toISOString(), idempotency_key: raw.idempotency_key as string,
        condition_id: raw.condition_id as string, token_id: raw.token_id as string, side: raw.side as string, selected_side: null,
        market_slug: null, submitted_size: raw.submitted_size as number, submitted_price: raw.submitted_price as number,
        clob_order_id: raw.clob_order_id as string, raw };
      st.events.set(ev.id, ev);
      return { ok: true, row: ev };
    },
    async updateOrderEventProgression(id, raw) {
      // Mirrors the route: identity + request facts are never overwritten.
      const prev = st.events.get(id)!;
      const next = { ...prev, raw };
      st.events.set(id, next);
      return next;
    },
  };
  return { st, maker, orders };
}

/** The route's callback pipeline: maker authorization, then accounting on the order-event path. */
async function deliver(w: ReturnType<typeof world>, raw: Record<string, unknown>) {
  const auth = await recordResultAndAuthorizeMaker(w.maker, raw, NOW);
  if (auth.kind === "MAKER_CALLBACK_REJECTED") return { auth, order: null };
  const order = await handleOrderEventSubmission(w.orders, normalizeMakerCallbackForAccounting(raw));
  return { auth, order };
}

async function acceptedWorld(row?: EventExecutionQueueRow, book?: Parameters<typeof world>[1]) {
  const w = world(row ?? makerFirstRow({ status: "READY" }), book);
  const first = await deliver(w, accepted());
  assert.equal(first.order?.kind, "INSERTED");
  return w;
}

// ── 1. canonical predicate ──────────────────────────────────────────────────

test("canonical terminal-zero predicate: released outcome-only PROVEN_ZERO_* qualifies; partial / positive / UNKNOWN / non-terminal never do", () => {
  const r = (v1: Record<string, unknown>) => readIrelandExecutionResult({ execution_result_v1: { outcome: "PROVEN_ZERO_FILL_CANCELLED", ...v1 } }, "");
  assert.equal(isTerminalProvenZeroResult(r({})), true, "outcome-only: terminal + zero exposure follow from the released class");
  assert.equal(isTerminalProvenZeroResult(r({ filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true })), true);
  for (const o of ["PROVEN_ZERO_FILL_EXPIRED", "PROVEN_ZERO_FILL_PRICE", "PROVEN_ZERO_FILL_NO_LIQUIDITY", "PROVEN_REJECTED_BEFORE_SUBMISSION"]) {
    assert.equal(isTerminalProvenZeroResult(r({ outcome: o })), true, o);
  }
  for (const [name, v1] of [
    ["reported positive quantity", { filled_quantity: 1 }],
    ["exposure explicitly unproven", { economic_exposure_proven_zero: false }],
    ["explicitly non-terminal", { terminal: false }],
    ["UNKNOWN_AFTER_SUBMISSION", { outcome: "UNKNOWN_AFTER_SUBMISSION" }],
    ["UNKNOWN_AFTER_SUBMISSION claiming zero", { outcome: "UNKNOWN_AFTER_SUBMISSION", filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true }],
    ["UNKNOWN_TRANSPORT", { outcome: "UNKNOWN_TRANSPORT" }],
    ["PARTIAL_FILL_CANCELLED", { outcome: "PARTIAL_FILL_CANCELLED", filled_quantity: 2 }],
    ["PARTIAL_FILL non-terminal", { outcome: "PARTIAL_FILL" }],
    ["FULL_FILL", { outcome: "FULL_FILL", filled_quantity: 5 }],
  ] as const) {
    assert.equal(isTerminalProvenZeroResult(r(v1)), false, name);
  }
  assert.equal(callbackIsTerminalProvenZero({ order_status: "CANCELLED" }), false, "bare CANCELLED is never zero proof");
  // A legacy envelope must REPORT the zero-exposure proof; it is never derived for it.
  assert.equal(callbackIsTerminalProvenZero({ ireland_execution_result: { result_class: "PROVEN_ZERO_FILL_CANCELLED", terminal: true } }), false);
});

// ── 2. transition 1: terminal callback -> ACK -> reconciliation -> fallback command ─────

test("T1: outcome-only terminal-zero callback on the accepted MAKER_FIRST order -> PROGRESSED on the same row, one fallback authorized", async () => {
  const w = await acceptedWorld();
  const before = structuredClone([...w.st.events.values()][0]);
  const { auth, order } = await deliver(w, terminal());

  // Progression ACK, never IDEMPOTENCY_CONFLICT / MANUAL_INTERVENTION.
  assert.equal(order?.kind, "PROGRESSED");
  assert.equal(w.st.events.size, 1, "no duplicate order-event row");
  const ev = [...w.st.events.values()][0];
  assert.equal(ev.id, before.id);
  for (const k of ["idempotency_key", "clob_order_id", "condition_id", "token_id", "side", "submitted_price", "submitted_size"] as const) {
    assert.equal(ev[k], before[k], `immutable ${k}`);
  }
  if (order?.kind === "PROGRESSED") assert.equal(order.queueMark.kind, "ALREADY_EXECUTED", "Queue never downgraded");

  // Exactly one same-token MAKER_FALLBACK_1.
  assert.equal(auth.kind, "MAKER_AUTHORIZED");
  assert.equal(w.st.claims, 1);
  const cmd = (auth as { command: MakerFallbackCommand }).command;
  assert.equal(cmd.attempt_id, "MAKER_FALLBACK_1");
  assert.equal(cmd.parent_attempt_id, "MAKER_FIRST");
  assert.equal(cmd.parent_queue_id, "q1");
  assert.equal(cmd.parent_idempotency_key, IDEM);
  assert.equal(cmd.reservation_id, "res1");
  assert.equal(cmd.condition_id, "cond1");
  assert.equal(cmd.token_id, "tok1");
  assert.equal(cmd.side, "YES");
  assert.equal(cmd.physical_event_id, EVENT);
  assert.equal(cmd.stake_usd, 2.5, "stake unchanged");
  assert.ok(cmd.limit_price <= 0.5 + 1e-9, "never above frozen P_BUY_MAX / Queue cap");
  assert.ok(cmd.limit_price <= QUEUE_MAX_ENTRY_PRICE && QUEUE_MAX_ENTRY_PRICE === 0.54, "hard cap 0.54");
  assert.ok(cmd.quantity * cmd.limit_price <= 2.5 + 1e-9);
  assert.equal(cmd.deadline_iso, LATEST);
  assert.equal(w.st.row.status, "EXECUTED", "no second Queue row, status untouched");
});

test("T1: terminal-zero reconciliation is TERMINAL_NO_FILL / SETTLED_NO_FILL with nothing fabricated", async () => {
  const w = await acceptedWorld();
  const raw = normalizeMakerCallbackForAccounting(terminal());
  const { order } = await deliver(w, terminal());
  assert.equal(order?.kind, "PROGRESSED");
  if (order?.kind !== "PROGRESSED") return;
  const queue = w.st.row;
  const ev = { ...order.row, making_amount: null, taking_amount: null, fee_usd: null };
  const telemetry = buildEconomicTelemetry({ queue: queue as never, event: ev as never, raw });
  const rec = buildExecutionReconciliation({ queue: queue as never, event: ev as never, raw, telemetry });
  assert.equal(rec.fill_status, "TERMINAL_NO_FILL", "no longer ACCEPTED_OPEN");
  assert.equal(rec.settlement_status, "SETTLED_NO_FILL", "no longer PENDING_FILL_CONFIRMATION");
  assert.equal(rec.executed_shares, 0);
  assert.equal(rec.executed_notional_usd, 0);
  assert.equal(rec.actual_fill_price, null, "no fabricated fill price");
  assert.equal(rec.fee_usd, null, "no fabricated fee");
  assert.equal(rec.submitted_price, 0.5, "original request facts preserved");
  assert.equal(rec.requested_shares, 5);
  // Zero economic exposure: the event-level guard sees the primary as proven zero, while the
  // pending fallback command still holds the event's single exposure slot.
  const recordedOnly = { ...queue, diagnostics: { ...queue.diagnostics, execution_attempts_v1: { maker_first: readExecutionAttempts(queue.diagnostics).maker_first } } };
  assert.equal(eventExposureNotProvenZero([recordedOnly as EventExecutionQueueRow]), false);
  assert.equal(eventExposureNotProvenZero([queue]), true, "authorized fallback without result = exposure held");
});

// ── 3. idempotency ──────────────────────────────────────────────────────────

test("duplicate terminal-zero callback cannot create a second authorization (sequential and concurrent)", async () => {
  const w = await acceptedWorld();
  const first = await deliver(w, terminal());
  const again = await deliver(w, terminal());
  assert.equal(first.auth.kind, "MAKER_AUTHORIZED");
  assert.equal(again.auth.kind, "MAKER_ALREADY_AUTHORIZED");
  assert.deepEqual((again.auth as { command: MakerFallbackCommand }).command, (first.auth as { command: MakerFallbackCommand }).command);
  assert.ok(again.order?.kind === "PROGRESSED" || again.order?.kind === "DUPLICATE", again.order?.kind);
  assert.equal(w.st.events.size, 1);

  const c = await acceptedWorld();
  const outs = await Promise.all([1, 2, 3].map(() => recordResultAndAuthorizeMaker(c.maker, terminal(), NOW)));
  assert.equal(outs.filter((o) => o.kind === "MAKER_AUTHORIZED").length, 1);
  assert.equal(c.st.claims, 1);
});

test("CAS claim re-verifies the FRESH maker_first slot: a contradictory fill stops the claim", async () => {
  const zero = readIrelandExecutionResult(terminal(), NOW.toISOString())!;
  const fill = readIrelandExecutionResult(terminal({ outcome: "PARTIAL_FILL_CANCELLED", filled_quantity: 2 }), NOW.toISOString())!;
  const port = (slotResult: unknown): QueueCasPort & { row: QueueCasRow } => {
    const p = {
      row: { status: "EXECUTED", updated_at: "t0", diagnostics: { ...makerFirstRow().diagnostics, execution_attempts_v1: { maker_first: { result: slotResult } } } } as QueueCasRow,
      async read() { return structuredClone(p.row); },
      async compareAndSet(_id: string, _u: string | null, cols: Record<string, unknown>) { p.row = { ...p.row, ...(cols as object) } as QueueCasRow; return p.row as unknown as Record<string, unknown>; },
    };
    return p;
  };
  const cmd = { attempt_id: "MAKER_FALLBACK_1" } as MakerFallbackCommand;
  assert.equal(await claimMakerCommandCas(port(zero), "q1", cmd), true);
  assert.equal(await claimMakerCommandCas(port(fill), "q1", cmd), false);
  const once = port(zero);
  assert.equal(await claimMakerCommandCas(once, "q1", cmd), true);
  assert.equal(await claimMakerCommandCas(once, "q1", cmd), false, "single winner");
});

// ── 4. transition 2: fallback command -> executor-facing Queue response ────

test("T2: the authorized command is surfaced verbatim in the executor Queue `maker_fallback_commands` contract until its result or deadline", async () => {
  const w = await acceptedWorld();
  const { auth } = await deliver(w, terminal());
  const cmd = (auth as { command: MakerFallbackCommand }).command;
  const surfaced = selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], NOW.getTime());
  assert.deepEqual(surfaced, [cmd]);
  assert.deepEqual(Object.keys(surfaced[0]).sort(), [
    "attempt_id", "authorized_at_iso", "condition_id", "deadline_iso", "execution_mode", "execution_side", "idempotency_key",
    "limit_price", "market_family", "max_stake_usd", "parent_attempt_id", "parent_idempotency_key", "parent_queue_id",
    "physical_event_id", "price_cap", "quantity", "reservation_id", "side", "stake_usd", "status", "strategy_variant",
    "strategy_version", "token_id",
  ]);
  assert.equal(surfaced[0].execution_mode, "MAKER");
  assert.equal(surfaced[0].execution_side, "BUY");
  assert.equal(surfaced[0].status, "AUTHORIZED");
  assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], Date.parse(LATEST)).length, 0, "not after deadline");

  // T3: the fallback's own callback binds to the SAME Queue row (no second row) and records its result.
  const fb = {
    event_type: "ORDER_RESULT", attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER", idempotency_key: cmd.idempotency_key,
    parent_idempotency_key: IDEM, queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES",
    stake_usd: 2.5, submitted_size: cmd.quantity, submitted_price: cmd.limit_price, clob_order_id: "v-2", order_status: "live",
  };
  const fbOut = await deliver(w, fb);
  assert.equal(fbOut.order?.kind, "INSERTED", JSON.stringify(fbOut.order));
  if (fbOut.order?.kind === "INSERTED") assert.equal(fbOut.order.queueMark.kind, "ALREADY_EXECUTED");
  assert.equal(w.st.events.size, 2, "the fallback is its own order event on the same Queue identity");
  const fbZero = await deliver(w, { ...fb, order_status: "CANCELLED", execution_result_v1: { attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER", outcome: "PROVEN_ZERO_FILL_EXPIRED", venue_order_id: "v-2" } });
  assert.deepEqual(fbOut.auth.kind, "NO_RESULT");
  assert.deepEqual(fbZero.auth, { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_fallback_1" }, "never a MAKER_FALLBACK_2");
  assert.equal(w.st.claims, 1);
  assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], NOW.getTime()).length, 0, "consumed once a result exists");
  // The fallback above the authorized command limit is refused.
  const over = await handleOrderEventSubmission(w.orders, { ...fb, idempotency_key: cmd.idempotency_key, clob_order_id: "v-3", submitted_price: cmd.limit_price + 0.01 });
  assert.equal(over.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
});

// ── 5. regressions ──────────────────────────────────────────────────────────

const blocked: Array<[string, Record<string, unknown>]> = [
  ["bare CANCELLED (no result envelope)", { ...accepted({ order_status: "CANCELLED", stake_usd: 2.4 }) }],
  ["unproven zero (exposure flag false)", terminal({ economic_exposure_proven_zero: false })],
  ["zero class but non-terminal", terminal({ terminal: false })],
  ["UNKNOWN_AFTER_SUBMISSION", terminal({ outcome: "UNKNOWN_AFTER_SUBMISSION" })],
  ["UNKNOWN_AFTER_SUBMISSION claiming zero", terminal({ outcome: "UNKNOWN_AFTER_SUBMISSION", filled_quantity: 0, terminal: true, economic_exposure_proven_zero: true })],
  ["partial fill", terminal({ outcome: "PARTIAL_FILL_CANCELLED", filled_quantity: 2, average_fill_price: 0.5 })],
  ["positive fill", terminal({ outcome: "FULL_FILL", filled_quantity: 5, average_fill_price: 0.5 })],
  ["zero class with positive reported quantity", terminal({ filled_quantity: 1 })],
];

for (const [name, raw] of blocked) {
  test(`regression (${name}): no fallback authorization, no zero reconciliation`, async () => {
    const w = await acceptedWorld();
    const { auth } = await deliver(w, raw);
    assert.notEqual(auth.kind, "MAKER_AUTHORIZED");
    assert.notEqual(auth.kind, "MAKER_ALREADY_AUTHORIZED");
    assert.equal(w.st.claims, 0);
    assert.equal(readExecutionAttempts(w.st.row.diagnostics).maker_fallback_1, undefined);
    assert.equal(callbackIsTerminalProvenZero(normalizeMakerCallbackForAccounting(raw)), false);
    assert.equal(w.st.events.size, 1, "never a second order-event row");
  });
}

test("regression (bare CANCELLED): stays a strict idempotency conflict on the order-event path", async () => {
  const w = await acceptedWorld();
  const { order } = await deliver(w, accepted({ order_status: "CANCELLED", stake_usd: 2.4, submitted_size: 4 }));
  assert.equal(order?.kind, "CONFLICT_IDEMPOTENCY");
});

test("regression (wrong identity): rejected before any mutation or authorization", async () => {
  for (const extra of [{ token_id: "tok2" }, { condition_id: "cond2" }, { side: "NO" }]) {
    const w = await acceptedWorld();
    const { auth, order } = await deliver(w, terminal({}, extra));
    assert.deepEqual(auth, { kind: "MAKER_CALLBACK_REJECTED", reason: "PRIMARY_MAKER_IDENTITY_MISMATCH" }, JSON.stringify(extra));
    assert.equal(order, null);
    assert.equal(w.st.claims, 0);
  }
  // Same Queue identity but a different venue order id is never a progression of the accepted order.
  const w = await acceptedWorld();
  const out = await handleOrderEventSubmission(w.orders, normalizeMakerCallbackForAccounting(terminal({ venue_order_id: "v-OTHER" }, { clob_order_id: "v-OTHER" })));
  assert.equal(out.kind, "CONFLICT_IDEMPOTENCY");
  assert.equal(w.st.events.size, 1);
});

test("regression (expired deadline): terminal zero is ACKed and reconciled, but no fallback after the entry deadline", async () => {
  const early = "2026-10-03T19:50:00.000Z";
  const row = makerFirstRow({ status: "READY", latest_entry_iso: early });
  row.diagnostics = { ...row.diagnostics, t10_economic_action_v1: frozenMakerFirst({ latest_entry_iso: early }) };
  const w = await acceptedWorld(row);
  const { auth, order } = await deliver(w, terminal());
  assert.equal(order?.kind, "PROGRESSED", "ACK does not depend on the deadline");
  assert.equal(auth.kind, "MAKER_BLOCKED");
  assert.ok((auth as { reasons: string[] }).reasons.includes("DEADLINE_PASSED"));
  assert.equal(w.st.claims, 0);
});

test("regression: a recorded positive primary fill is never overridden by a later zero claim", async () => {
  const w = await acceptedWorld();
  await deliver(w, terminal({ outcome: "PARTIAL_FILL_CANCELLED", filled_quantity: 2, average_fill_price: 0.5 }));
  const { auth } = await deliver(w, terminal());
  assert.equal(auth.kind, "MAKER_BLOCKED");
  assert.equal(w.st.claims, 0);
});

test("regression: economics unchanged -- book that would require exceeding P_BUY_MAX / stake / minimum fails closed", async () => {
  // ask - tick binds lower -> price 0.45, quantity floor(2.5/0.45)=5.55 >= min 5: still authorized, stake unchanged.
  const lower = await acceptedWorld(undefined, { bestBid: 0.3, bestAsk: 0.46, tickSize: 0.01 });
  const ok = await deliver(lower, terminal());
  assert.equal(ok.auth.kind, "MAKER_AUTHORIZED");
  assert.equal((ok.auth as { command: MakerFallbackCommand }).command.limit_price, 0.45);
  assert.equal((ok.auth as { command: MakerFallbackCommand }).command.stake_usd, 2.5);
  // Tick changed vs frozen contract -> blocked (no re-pricing authority).
  const tick = await acceptedWorld(undefined, { bestBid: 0.3, bestAsk: 0.53, tickSize: 0.001 });
  assert.deepEqual((await deliver(tick, terminal())).auth, { kind: "MAKER_BLOCKED", reasons: ["T10_TICK_CHANGED"] });
  // Live minimum above stake-derived size -> blocked, quantity never inflated.
  const min = await acceptedWorld(undefined, { bestBid: 0.3, bestAsk: 0.53, tickSize: 0.01, minimumOrderSize: 6 });
  assert.deepEqual((await deliver(min, terminal())).auth, { kind: "MAKER_BLOCKED", reasons: ["BELOW_MINIMUM_ORDER_SIZE"] });
});
