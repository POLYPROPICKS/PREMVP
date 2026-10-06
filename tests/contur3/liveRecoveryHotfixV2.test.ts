// LIVE_BETTING_RECOVERY_FINAL_HOTFIX_V2 -- focused regression set (founder list 1-10).
//   node --experimental-test-module-mocks --import tsx --test tests/contur3/liveRecoveryHotfixV2.test.ts
//
//   A/B  pre-submission proven-zero callback (no submitted_price) -> 200, terminal zero persisted, exactly one
//        MAKER_FALLBACK_1, parent never left CLAIMED until lease expiry; everything else stays fail-closed
//   C    single canonical hard cap 0.555 (TAKER raw VWAP AND fee-inclusive cost; MAKER on tick; fallback inherits)
//   D    primary_maker_cancel_by = event start - 12m40s (fixed), latest_entry = event start + 3m, Queue at ~T-20
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import {
  callbackIsTerminalProvenZero,
  deriveT10FallbackLimit,
  evaluateMakerEligibility,
  isProvenRejectedBeforeSubmissionZero,
  mergeAttemptResult,
  normalizeMakerCallbackForAccounting,
  readExecutionAttempts,
  readIrelandExecutionResult,
  recordResultAndAuthorizeMaker,
  selectExecutorMakerFallbackCommands,
  type MakerFallbackCommand,
  type MakerFallbackPort,
} from "../../lib/executor/makerFallbackAuthorization";
import { handleOrderEventSubmission, type OrderEventDbPort, type StoredOrderEvent } from "../../lib/executor/executorCallbackContract";
import {
  IRELAND_PRECLAIM_MIN_REMAINING_SECONDS,
  IRELAND_REQUIRED_FALLBACK_RESERVE_SECONDS,
  QUEUE_MAX_ENTRY_PRICE,
  primaryMakerTiming,
  readT10FrozenContract,
  validateOrderEventAgainstQueueRow,
  type EventExecutionQueueRow,
} from "../../lib/executor/executorQueueTypes";
import { reconcileStaleClaims, type StaleClaimRow } from "../../lib/executor/staleQueueClaims";
import { classifyReservationMarketPhase } from "../../lib/executor/reservationMarketBaseline";
import { isDueForRebalance, latestEntryIso } from "../../lib/executor/nightWindow";
import { classifyActiveReservationDue } from "../../lib/executor/reservationRebalanceContract.mjs";
import {
  decideT10EconomicEvent,
  reverifySelectedAction,
  takerPriceLimit,
  walkTakerFill,
} from "../../lib/executor/t10EconomicActivation";
import { evaluateMakerPlacement } from "../../lib/executor/t10EconomicActionPolicy";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import type { TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";
import type { FinalT3MarketObservation } from "../../lib/executor/reservationMarketBaseline";

// ── shared fixtures: one physical event, kickoff 11:00Z (14:00 Minsk) ─────────────────────────────────────
const KICKOFF = "2026-10-06T11:00:00.000Z";
const KICKOFF_MS = Date.parse(KICKOFF);
const LATEST = "2026-10-06T11:03:00.000Z";                       // event start + 3 minutes
const CANCEL_BY = "2026-10-06T10:47:20.000Z";                    // event start - 12m40s
const T20 = KICKOFF_MS - 20 * 60_000;                           // Queue / economic-action target
const CALLBACK_AT = new Date("2026-10-06T10:45:30.000Z");        // Ireland pre-claim refusal: 110 s left before cancel_by (< 180 s)
const IDEM = "idem_hotfix_v2";
const EVENT = "provider:polymarket:chi2-1:2026-10-06";

function frozenMakerFirst(over: Record<string, unknown> = {}) {
  return {
    execution_policy_version: "T10_ECONOMIC_ACTION_EXECUTION_V1", economic_policy_version: "T10_ECONOMIC_ACTION_POLICY_V1",
    execution_mode: "MAKER_FIRST", price_authority_version: "T10_CURRENT_BOOK_EXECUTION_AUTHORITY_V1", price_authority_observation_id: "obs1",
    p_buy_max: 0.5, reference_status: "STRONG", physical_event_id: EVENT, condition_id: "cond1", token_id: "tok1", side: "YES",
    market_family: "TOTALS", stake_usd: 2.5, hard_price_cap: QUEUE_MAX_ENTRY_PRICE, latest_entry_iso: LATEST,
    tick_size: 0.01, minimum_order_size: 5, spread_telemetry: 0.02, activation_switch: "T10_ECONOMIC_ACTION_ACTIVATION",
    taker: null, maker: { maker_limit_price: 0.5, maker_shares: 5 },
    ...primaryMakerTiming(KICKOFF, LATEST),
    ...over,
  };
}
function frozenTakerFirst(over: Record<string, unknown> = {}) {
  return {
    ...frozenMakerFirst(), execution_mode: "TAKER_FIRST", p_buy_max: QUEUE_MAX_ENTRY_PRICE, maker: null, taker: { price_limit: 0.5 },
    primary_maker_cancel_by_iso: undefined, fallback_deadline_iso: undefined, required_min_remaining_seconds: undefined, ...over,
  };
}
function queueRow(mode: "MAKER_FIRST" | "TAKER_FIRST", over: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res1", plan_run_id: "plan1", rebalance_run_id: "rb1", match_family_key: EVENT,
    event_title: "A v B", event_slug: "a-v-b", sport: "soccer", league: "x", game_start_iso: KICKOFF,
    condition_id: "cond1", token_id: "tok1", side: "YES", market_slug: "m", market_title: "m", market_family: "TOTALS",
    score: null, coverage: null, tier: "TIER1", stake_usd: 2.5, preferred_entry_iso: "2026-10-06T10:15:00.000Z",
    latest_entry_iso: LATEST, selection_rank: 1, selection_reason: null, status: "CLAIMED",
    order_key: "k", idempotency_key: IDEM,
    diagnostics: {
      physical_event_id: EVENT, max_entry_price: 0.5, max_stake_usd: 4,
      t10_economic_action_v1: mode === "MAKER_FIRST" ? frozenMakerFirst() : frozenTakerFirst(),
    },
    ...over,
  } as EventExecutionQueueRow;
}

/**
 * The real overnight callback shape: result_class=PROVEN_REJECTED_BEFORE_SUBMISSION, terminal=true,
 * economic_exposure_proven_zero=true, filled_quantity=0, venue_order_id=null, submitted_price ABSENT.
 */
const overnight = (attempt: "MAKER_FIRST" | "TAKER_ATTEMPT_1" = "MAKER_FIRST", extra: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: attempt, execution_mode: attempt === "MAKER_FIRST" ? "MAKER_FIRST" : "TAKER",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5,
  result_class: "PROVEN_REJECTED_BEFORE_SUBMISSION", terminal: true, economic_exposure_proven_zero: true,
  filled_quantity: 0, venue_order_id: null, success: false, order_status: "REJECTED", error_message: "PRECLAIM_MIN_REMAINING_SECONDS",
  ...extra,
});
/** The same facts in the released execution_result_v1 envelope. */
const overnightV1 = (attempt: "MAKER_FIRST" | "TAKER_ATTEMPT_1" = "MAKER_FIRST", v1: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: attempt, execution_mode: attempt === "MAKER_FIRST" ? "MAKER_FIRST" : "TAKER",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5,
  execution_result_v1: { attempt_id: attempt, execution_mode: attempt === "MAKER_FIRST" ? "MAKER_FIRST" : "TAKER",
    outcome: "PROVEN_REJECTED_BEFORE_SUBMISSION", terminal: true, economic_exposure_proven_zero: true, filled_quantity: 0, venue_order_id: null, ...v1 },
});

// ── in-memory world mirroring the route pipeline (authorization first, then order-event accounting) ───────

function world(row: EventExecutionQueueRow) {
  const st = { row, events: new Map<string, StoredOrderEvent & { raw: Record<string, unknown> }>(), claims: 0, statusWrites: [] as string[] };
  const book = { bestBid: 0.3, bestAsk: 0.53, tickSize: 0.01 };
  const maker: MakerFallbackPort = {
    async loadQueueRowByIdempotencyKey(k) { return k === IDEM ? structuredClone(st.row) : null; },
    async fetchBook() { return book; },
    async recordResult(_id, slot, result) {
      const a = readExecutionAttempts(st.row.diagnostics);
      const merged = mergeAttemptResult(a[slot]?.result, result);        // mirrors recordAttemptResultCas (monotonic)
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, [slot]: { ...(a[slot] ?? {}), result: merged } } } };
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
    async updateQueueRowStatus(_id, patch) {
      st.statusWrites.push(patch.status);
      // Mirrors casWriteQueue: execution_attempts_v1 is always taken from the FRESH row.
      const attempts = st.row.diagnostics.execution_attempts_v1;
      st.row = { ...st.row, status: patch.status as never, diagnostics: { ...patch.diagnostics, ...(attempts ? { execution_attempts_v1: attempts } : {}) } };
    },
    async insertOrderEvent(raw) {
      const n = st.events.size + 1;
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      const ev = { id: `e${n}`, created_at: CALLBACK_AT.toISOString(), idempotency_key: raw.idempotency_key as string,
        condition_id: raw.condition_id as string, token_id: raw.token_id as string, side: raw.side as string, selected_side: null,
        market_slug: null, submitted_size: num(raw.submitted_size), submitted_price: num(raw.submitted_price),
        clob_order_id: (raw.clob_order_id as string | undefined) ?? null, raw };
      st.events.set(ev.id, ev);
      return { ok: true as const, row: ev };
    },
    async updateOrderEventProgression(id, raw) { const next = { ...st.events.get(id)!, raw }; st.events.set(id, next); return next; },
  };
  return { st, maker, orders };
}
/** The route's callback pipeline. */
async function deliver(w: ReturnType<typeof world>, raw: Record<string, unknown>, now: Date = CALLBACK_AT) {
  const auth = await recordResultAndAuthorizeMaker(w.maker, raw, now);
  if (auth.kind === "MAKER_CALLBACK_REJECTED") return { auth, order: null };
  const order = await handleOrderEventSubmission(w.orders, normalizeMakerCallbackForAccounting(raw), {
    callbackProvedPreSubmissionZero: isProvenRejectedBeforeSubmissionZero(raw),
  });
  return { auth, order };
}

// ═══ A. pre-submission proven zero ══════════════════════════════════════════════════════════════════════

test("1: the overnight callback (no submitted_price) is accepted, terminal zero persisted, exactly one fallback authorized (legacy and v1 envelopes)", async () => {
  for (const [name, raw] of [["top-level result_class", overnight()], ["execution_result_v1", overnightV1()]] as const) {
    assert.equal(isProvenRejectedBeforeSubmissionZero(raw), true, name);
    const w = world(queueRow("MAKER_FIRST"));
    const { auth, order } = await deliver(w, raw);
    assert.equal(order?.kind, "INSERTED", `${name}: ${JSON.stringify(order)}`);            // the route maps INSERTED -> HTTP 200
    assert.equal(auth.kind, "MAKER_AUTHORIZED", name);
    assert.equal(w.st.claims, 1, "exactly one MAKER_FALLBACK_1");
    // canonical terminal zero persisted on the primary slot
    const slot = readExecutionAttempts(w.st.row.diagnostics).maker_first?.result;
    assert.equal(slot?.result_class, "PROVEN_REJECTED_BEFORE_SUBMISSION");
    assert.equal(slot?.terminal, true);
    assert.equal(slot?.economic_exposure_proven_zero, true);
    assert.equal(slot?.filled_quantity, 0);
    // the fallback is the SAME economic bet: identity, stake and parent lineage
    const cmd = (auth as { command: MakerFallbackCommand }).command;
    assert.deepEqual([cmd.attempt_id, cmd.parent_attempt_id, cmd.token_id, cmd.condition_id, cmd.side, cmd.stake_usd],
      ["MAKER_FALLBACK_1", "MAKER_FIRST", "tok1", "cond1", "YES", 2.5]);
    assert.equal(cmd.deadline_iso, LATEST, "fallback deadline = latest_entry = event start + 3m");
    // one immutable order event, no venue order, no submitted price fabricated
    assert.equal(w.st.events.size, 1);
    const ev = [...w.st.events.values()][0];
    assert.equal(ev.clob_order_id, null);
    assert.equal(ev.submitted_price, null);
  }
});

test("1b: the same shape on a TAKER_ATTEMPT_1 parent is accepted and authorizes exactly one fallback", async () => {
  const w = world(queueRow("TAKER_FIRST"));
  const { auth, order } = await deliver(w, overnightV1("TAKER_ATTEMPT_1"));
  assert.equal(order?.kind, "INSERTED", JSON.stringify(order));
  assert.equal(auth.kind, "MAKER_AUTHORIZED");
  assert.equal(readExecutionAttempts(w.st.row.diagnostics).taker_attempt_1?.result?.result_class, "PROVEN_REJECTED_BEFORE_SUBMISSION");
  assert.equal(w.st.claims, 1);
});

test("B: the claim black hole is closed -- the parent is terminal at once, never left CLAIMED to be expired as CLAIM_LEASE_EXPIRED_NO_ORDER_EVENT", async () => {
  const w = world(queueRow("MAKER_FIRST"));
  assert.equal(w.st.row.status, "CLAIMED");
  const { auth, order } = await deliver(w, overnight());
  assert.equal(auth.kind, "MAKER_AUTHORIZED");
  assert.equal(order?.kind, "INSERTED");
  if (order?.kind === "INSERTED") assert.equal(order.queueMark.kind, "FAILED", "terminal no-exposure mark on the parent attempt");
  assert.equal(w.st.row.status, "FAILED");
  assert.equal(w.st.row.diagnostics.queue_mark_result, "PRE_SUBMISSION_PROVEN_ZERO");
  assert.ok(readExecutionAttempts(w.st.row.diagnostics).maker_fallback_1?.command, "the fallback command survives the status write (CAS keeps attempts)");

  // The stale-claim sweep at/after latest_entry can no longer touch it ...
  const expired: string[] = [];
  const swept = await reconcileStaleClaims({
    async loadExpiredClaims() { return [{ id: "q1", status: w.st.row.status, latest_entry_iso: LATEST, idempotency_key: IDEM, condition_id: "cond1", token_id: "tok1", side: "YES", diagnostics: w.st.row.diagnostics } as StaleClaimRow]; },
    async hasMatchingOrderEvent() { return w.st.events.size > 0; },
    async expireClaim(row) { expired.push(row.id); return true; },
  }, "2026-10-06T11:03:30.000Z", true);
  assert.deepEqual(expired, []);
  assert.equal(swept.expired_count, 0);
  // ... and the fallback is consumable immediately (same instant, no status gate).
  const cmds = selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], CALLBACK_AT.getTime());
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].attempt_id, "MAKER_FALLBACK_1");
});

test("2: a duplicate callback is idempotent -- same row, no second event, no second fallback, status not rewritten", async () => {
  const w = world(queueRow("MAKER_FIRST"));
  const first = await deliver(w, overnight());
  const writesAfterFirst = w.st.statusWrites.length;
  const again = await deliver(w, overnight());
  assert.equal(first.auth.kind, "MAKER_AUTHORIZED");
  assert.equal(again.auth.kind, "MAKER_ALREADY_AUTHORIZED");
  assert.deepEqual((again.auth as { command: MakerFallbackCommand }).command, (first.auth as { command: MakerFallbackCommand }).command);
  assert.equal(again.order?.kind, "DUPLICATE");
  if (again.order?.kind === "DUPLICATE") assert.equal(again.order.queueMark.kind, "ALREADY_FAILED");
  assert.equal(w.st.events.size, 1);
  assert.equal(w.st.claims, 1);
  assert.equal(w.st.statusWrites.length, writesAfterFirst, "no second status write");
  // concurrent duplicates still produce exactly one authorization
  const c = world(queueRow("MAKER_FIRST"));
  const outs = await Promise.all([1, 2, 3].map(() => recordResultAndAuthorizeMaker(c.maker, overnight(), CALLBACK_AT)));
  assert.equal(outs.filter((o) => o.kind === "MAKER_AUTHORIZED").length, 1);
  assert.equal(c.st.claims, 1);
});

const failClosed: Array<[string, Record<string, unknown>]> = [
  ["PROVEN_ZERO_FILL_CANCELLED (another zero class) without a price", overnight("MAKER_FIRST", { result_class: "PROVEN_ZERO_FILL_CANCELLED" })],
  ["PROVEN_ZERO_FILL_EXPIRED without a price", overnight("MAKER_FIRST", { result_class: "PROVEN_ZERO_FILL_EXPIRED" })],
  ["partial fill", overnight("MAKER_FIRST", { result_class: "PARTIAL_FILL_CANCELLED", filled_quantity: 2, economic_exposure_proven_zero: false })],
  ["positive fill", overnight("MAKER_FIRST", { result_class: "FULL_FILL", filled_quantity: 5, economic_exposure_proven_zero: false })],
  ["UNKNOWN_AFTER_SUBMISSION", overnight("MAKER_FIRST", { result_class: "UNKNOWN_AFTER_SUBMISSION", terminal: null, economic_exposure_proven_zero: null, filled_quantity: null })],
  ["UNKNOWN_AFTER_SUBMISSION claiming zero", overnight("MAKER_FIRST", { result_class: "UNKNOWN_AFTER_SUBMISSION" })],
  ["UNKNOWN_TRANSPORT", overnight("MAKER_FIRST", { result_class: "UNKNOWN_TRANSPORT", terminal: null, economic_exposure_proven_zero: null, filled_quantity: null })],
  ["pre-submission class with a positive reported quantity", overnight("MAKER_FIRST", { filled_quantity: 1 })],
  ["pre-submission class, exposure not proven zero", overnight("MAKER_FIRST", { economic_exposure_proven_zero: false })],
  ["pre-submission class, not terminal", overnight("MAKER_FIRST", { terminal: false })],
  ["pre-submission class, quantity not reported", overnight("MAKER_FIRST", { filled_quantity: undefined })],
  ["pre-submission class carrying a venue order id", overnight("MAKER_FIRST", { venue_order_id: "v-1" })],
  ["pre-submission class carrying a clob_order_id", overnight("MAKER_FIRST", { clob_order_id: "v-1" })],
  ["pre-submission class carrying a fill fact", overnight("MAKER_FIRST", { executed_size: 2 })],
  ["pre-submission class carrying a taking_amount", overnight("MAKER_FIRST", { taking_amount: 1.2 })],
  ["pre-submission class carrying transaction hashes", overnight("MAKER_FIRST", { transaction_hashes: ["0xabc"] })],
  ["pre-submission class reporting matched", overnight("MAKER_FIRST", { order_status: "matched" })],
  ["bare REJECTED with no result envelope", { ...overnight(), result_class: undefined, terminal: undefined, economic_exposure_proven_zero: undefined, filled_quantity: undefined }],
];
for (const [name, raw] of failClosed) {
  test(`3 fail-closed (${name}): without submitted_price -> MISSING_SUBMITTED_PRICE (not acknowledged), nothing persisted, parent untouched`, async () => {
    assert.equal(isProvenRejectedBeforeSubmissionZero(raw), false);
    const w = world(queueRow("MAKER_FIRST"));
    const { order } = await deliver(w, raw);
    assert.deepEqual(order, { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "MISSING_SUBMITTED_PRICE" });
    assert.equal(w.st.events.size, 0, "nothing persisted as an order event");
    assert.equal(w.st.row.status, "CLAIMED", "the parent is untouched");
    // Exposure that is partial / positive / unknown / unproven never authorizes a fallback (unchanged).
    if (!callbackIsTerminalProvenZero(raw)) assert.equal(w.st.claims, 0, "no fallback from a non-zero / unproven result");
  });
}

test("3b: the waiver covers ONLY an absent price -- a present price is validated exactly as before, and an inconsistent Queue row never gets it", async () => {
  const base = queueRow("MAKER_FIRST");
  const sub = { queue_id: "q1", reservation_id: "res1", idempotency_key: IDEM, token_id: "tok1", condition_id: "cond1", side: "YES", market_slug: null,
    stake_usd: 2.5, submitted_size: 5, submitted_price: null as number | null };
  assert.deepEqual(validateOrderEventAgainstQueueRow(sub, base), { ok: false, reason: "MISSING_SUBMITTED_PRICE" }, "no waiver by default");
  assert.deepEqual(validateOrderEventAgainstQueueRow(sub, base, { preSubmissionProvenZero: true }), { ok: true });
  assert.deepEqual(validateOrderEventAgainstQueueRow({ ...sub, submitted_price: 0.6 }, base, { preSubmissionProvenZero: true }), { ok: false, reason: "PRICE_EXCEEDS_QUEUE_MAX" });
  assert.deepEqual(validateOrderEventAgainstQueueRow({ ...sub, submitted_price: 0 }, base, { preSubmissionProvenZero: true }), { ok: false, reason: "MISSING_SUBMITTED_PRICE" });
  assert.deepEqual(validateOrderEventAgainstQueueRow({ ...sub, token_id: "other" }, base, { preSubmissionProvenZero: true }), { ok: false, reason: "TOKEN_ID_MISMATCH" });
  assert.deepEqual(validateOrderEventAgainstQueueRow({ ...sub, stake_usd: null }, base, { preSubmissionProvenZero: true }), { ok: false, reason: "MISSING_STAKE_USD" });
  // an already-EXECUTED / SENT parent (an accepted venue order exists) never accepts a pre-submission claim
  for (const status of ["EXECUTED", "SENT"] as const) {
    const w = world(queueRow("MAKER_FIRST", { status }));
    const { order } = await deliver(w, overnight());
    assert.deepEqual(order, { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "MISSING_SUBMITTED_PRICE" }, status);
    assert.equal(w.st.events.size, 0);
  }
  // a recorded positive fill on the primary slot wins over a later "pre-submission" claim
  const filled = world(queueRow("MAKER_FIRST"));
  await recordResultAndAuthorizeMaker(filled.maker, { ...overnight(), result_class: "PARTIAL_FILL_CANCELLED", filled_quantity: 2, economic_exposure_proven_zero: false, venue_order_id: "v-9", clob_order_id: "v-9" }, CALLBACK_AT);
  const late = await deliver(filled, overnight());
  assert.equal(late.auth.kind, "MAKER_BLOCKED");
  assert.deepEqual(late.order, { kind: "REJECTED_QUEUE_POLICY_MISMATCH", reason: "MISSING_SUBMITTED_PRICE" });
  assert.equal(filled.st.claims, 0);
});

test("3c: an accepted order's later terminal zero keeps its price requirement and the pre-submission class cannot overwrite an accepted order", async () => {
  // A normal accepted order (clob id + price) followed by a PROVEN_ZERO_FILL_CANCELLED progression is unchanged.
  const w = world(queueRow("MAKER_FIRST", { status: "READY" }));
  const accepted = { event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST", queue_id: "q1",
    reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5, submitted_size: 5, submitted_price: 0.5, clob_order_id: "v-1", order_status: "live" };
  assert.equal((await deliver(w, accepted)).order?.kind, "INSERTED");
  const zero = { ...accepted, order_status: "CANCELLED", execution_result_v1: { attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST", outcome: "PROVEN_ZERO_FILL_CANCELLED", venue_order_id: "v-1" } };
  const progressed = await deliver(w, zero);
  assert.equal(progressed.order?.kind, "PROGRESSED");
  assert.equal(progressed.auth.kind, "MAKER_AUTHORIZED");
  // The pre-submission class arriving AFTER an accepted order is contradictory and conflicts / is refused.
  const contradiction = await deliver(world(w.st.row), overnight());
  assert.notEqual(contradiction.order?.kind, "INSERTED");
});

test("7: the fallback attempt's own pre-submission zero is accepted without a price, consumes the command, never touches the parent, never creates MAKER_FALLBACK_2", async () => {
  const w = world(queueRow("MAKER_FIRST"));
  const first = await deliver(w, overnight());
  const cmd = (first.auth as { command: MakerFallbackCommand }).command;
  const parentStatus = w.st.row.status;
  const fb = { event_type: "ORDER_RESULT", idempotency_key: cmd.idempotency_key, parent_idempotency_key: IDEM, attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER",
    queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES", stake_usd: 2.5,
    result_class: "PROVEN_REJECTED_BEFORE_SUBMISSION", terminal: true, economic_exposure_proven_zero: true, filled_quantity: 0, venue_order_id: null };
  const out = await deliver(w, fb);
  assert.equal(out.auth.kind, "RESULT_RECORDED_NO_FURTHER_ATTEMPT");
  assert.equal(out.order?.kind, "INSERTED", JSON.stringify(out.order));
  assert.equal(w.st.row.status, parentStatus, "the parent row's status belongs to its own attempt");
  assert.equal(w.st.claims, 1, "never a second fallback");
  assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], CALLBACK_AT.getTime()).length, 0, "command consumed once a result exists");
});

// ═══ C. hard cap 0.555 ═════════════════════════════════════════════════════════════════════════════════

const feeSchedule = (tokenId: string): TokenFeeScheduleResult => ({
  ok: true, tokenId, conditionId: null, feesEnabled: true, takerRate: 0.05, exponent: 1, feeType: "sports_fees_v3",
  formulaVersion: "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1", source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID", observedAtIso: new Date(T20).toISOString(), latencyMs: 1,
});
const bookOf = (tokenId: string, bids: Array<[number, number]>, asks: Array<[number, number]>, min = 5, tick = 0.01): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 2,
  book: { tokenId, bids: bids.map(([price, size]) => ({ price, size })), asks: asks.map(([price, size]) => ({ price, size })), tickSize: tick, minimumOrderSize: min, providerTimestampMs: T20 },
});
const obs = (family: string, type: string): FinalT3MarketObservation => ({
  capture_run_id: "t10-run", reservation_id: "res1", physical_event_id: EVENT, provider_event_id: "chi2-1", event_start_iso: KICKOFF,
  observation_phase: "T_MINUS_10", condition_id: "c-x", token_id: "x-token", side: "Yes", canonical_market_family: family, canonical_market_type: type,
  market_slug: "x", best_bid: 0.5, best_ask: 0.54, ask_decimal_odds: 1 / 0.54, orderbook_fetch_status: "SUCCESS", observed_at: new Date(T20 - 20_000).toISOString(),
});
async function decide(book: FetchOrderBookResult, o: { now?: number; family?: string; type?: string } = {}) {
  const deps = { fetchExactTokenOrderbook: async () => book, fetchTokenFeeSchedule: async (t: string) => feeSchedule(t) };
  const event = await decideT10EconomicEvent({ physicalEventId: EVENT, eventStartIso: KICKOFF,
    t10Universe: [obs(o.family ?? "MONEYLINE", o.type ?? "MONEYLINE")], t30Universe: null, nowMs: o.now ?? T20, exposureExists: false, deps });
  return { event, fetch: deps.fetchExactTokenOrderbook };
}

test("7/8: effective cost .542455 (ask .53) and .552420 (ask .54) pass the 0.555 cap -- raw VWAP AND fee-inclusive cost are both <= cap", async () => {
  assert.equal(QUEUE_MAX_ENTRY_PRICE, 0.555);
  for (const [ask, effective] of [[0.53, 0.542455], [0.54, 0.55242]] as const) {
    assert.ok(Math.abs(ask * (1 + 0.05 * (1 - ask)) - effective) < 1e-9, `closed form at ${ask}`);
    const walk = walkTakerFill([{ price: ask, sizeShares: 100 }], 2.5, 0.54, 0.05);
    assert.equal(walk.filled, true);
    assert.ok(walk.rawVwap! <= QUEUE_MAX_ENTRY_PRICE && walk.effectiveCost! <= QUEUE_MAX_ENTRY_PRICE, `walk at ${ask}`);
    // through the real decision + the mechanical re-verification (every other guard passing)
    const { event, fetch } = await decide(bookOf("x-token", [[ask - 0.02, 100]], [[ask, 100]], 4));
    assert.equal(event.decision.action, "TAKER_FIRST", `ask ${ask}`);
    const guard = await reverifySelectedAction({ event, nowMs: T20, exposureExists: false, fetchExactTokenOrderbook: fetch });
    assert.equal(guard.ok, true, `ask ${ask}: ${guard.ok ? "" : guard.reason}`);
    if (guard.ok) {
      assert.equal(guard.contract.hard_price_cap, 0.555);
      assert.equal(guard.contract.p_buy_max, 0.555);
      assert.ok(guard.contract.taker!.authorized_raw_vwap <= 0.555 && guard.contract.taker!.authorized_effective_cost <= 0.555);
    }
  }
  // above the cap after fees (ask .55 -> .5623): no TAKER
  assert.equal(takerPriceLimit(0.555, 0.05, 0.01, 0.555), 0.54);
  const { event: tooHigh } = await decide(bookOf("x-token", [[0.5, 100]], [[0.55, 100]], 4));
  assert.notEqual(tooHigh.decision.action, "TAKER_FIRST");
});

test("C: MAKER limit <= 0.555 on a valid tick (floors to .55 at tick .01); MAKER_FALLBACK_1 inherits the parent cap", () => {
  assert.equal(evaluateMakerPlacement(0.56, 0.57, 0.01, QUEUE_MAX_ENTRY_PRICE).limit, 0.55);
  assert.equal(evaluateMakerPlacement(0.56, 0.58, 0.001, QUEUE_MAX_ENTRY_PRICE).limit, 0.555, "a finer tick can land exactly on the cap");
  // MAKER_FIRST parent at the cap: 5 shares x 0.55 = $2.75 venue-minimum headroom (authorized, evidenced, <= $4.00).
  const headroom = { base_stake_usd: 2.5, authorized_stake_usd: 2.75, max_stake_usd: 4, stake_adjustment_reason: "VENUE_MINIMUM_ORDER_SIZE", minimum_order_size: 5, required_minimum_notional_usd: 2.75 };
  const parent = queueRow("MAKER_FIRST", { status: "EXECUTED", stake_usd: 2.75 });
  parent.diagnostics = { ...parent.diagnostics, max_entry_price: 0.55, max_stake_usd: 4,
    t10_economic_action_v1: frozenMakerFirst({ p_buy_max: 0.55, stake_usd: 2.75, stake_authorization: headroom, maker: { maker_limit_price: 0.55, maker_shares: 5 } }) };
  assert.equal(readT10FrozenContract(parent).ok, true);
  const fb = deriveT10FallbackLimit({ queue: parent, book: { bestAsk: 0.7, tickSize: 0.01, minimumOrderSize: 5 }, priceCap: 0.55, stakeUsd: 2.75 });
  assert.equal(fb.ok && fb.limit_price, 0.55, "a far ask can never lift the fallback above the parent cap");
  const looser = deriveT10FallbackLimit({ queue: parent, book: { bestAsk: 0.7, tickSize: 0.01, minimumOrderSize: 5 }, priceCap: 0.6, stakeUsd: 2.75 });
  assert.ok(looser.ok && looser.limit_price <= QUEUE_MAX_ENTRY_PRICE, "even a looser parent cap is clamped to the canonical cap");
  // TAKER_FIRST parent: frozen ceiling 0.555 (the hard cap) but its own price cap is the fee-inclusive taker limit 0.54 -> the fallback inherits 0.54.
  const takerParent = queueRow("TAKER_FIRST", { status: "EXECUTED" });
  takerParent.diagnostics = { ...takerParent.diagnostics, max_entry_price: 0.54, t10_economic_action_v1: frozenTakerFirst({ minimum_order_size: 4, taker: { price_limit: 0.54 } }) };
  const inherited = deriveT10FallbackLimit({ queue: takerParent, book: { bestAsk: 0.7, tickSize: 0.01, minimumOrderSize: 4 }, priceCap: 0.54, stakeUsd: 2.5 });
  assert.equal(inherited.ok && inherited.limit_price, 0.54, "fallback inherits the canonical parent cap, never the book");
  // the strict reader refuses a frozen ceiling above the canonical cap
  assert.equal(readT10FrozenContract({ ...parent, diagnostics: { ...parent.diagnostics, t10_economic_action_v1: frozenMakerFirst({ p_buy_max: 0.56 }) } }).ok, false);
});

test("9: adaptive venue-minimum headroom is unchanged -- 0.53 x 5 = $2.65 stays valid (TAKER and MAKER), never above $4.00", async () => {
  // TAKER at ask .53 with min 5: $2.50 buys 4.72 < 5 -> smallest sufficient cent stake $2.65
  const { event, fetch } = await decide(bookOf("x-token", [[0.51, 100]], [[0.53, 100]], 5));
  assert.equal(event.decision.action, "TAKER_FIRST");
  const taker = await reverifySelectedAction({ event, nowMs: T20, exposureExists: false, fetchExactTokenOrderbook: fetch });
  assert.equal(taker.ok && taker.contract.stake_usd, 2.65);
  assert.equal(taker.ok && taker.contract.stake_authorization.stake_adjustment_reason, "VENUE_MINIMUM_ORDER_SIZE");
  // MAKER at bid .53 (ask .56 is above the taker limit): 5 shares x .53
  const { event: me, fetch: mf } = await decide(bookOf("x-token", [[0.53, 100]], [[0.56, 100]], 5));
  assert.equal(me.decision.action, "MAKER_FIRST");
  const maker = await reverifySelectedAction({ event: me, nowMs: T20, exposureExists: false, fetchExactTokenOrderbook: mf });
  assert.equal(maker.ok && maker.contract.stake_usd, 2.65);
  assert.equal(maker.ok && maker.contract.stake_authorization.max_stake_usd, 4);
  // 0.54 x 5 = $2.70 and 0.52 x 5 = $2.60 (the other known-valid examples)
  for (const [price, stake] of [[0.52, 2.6], [0.54, 2.7]] as const) {
    const { event: e, fetch: f } = await decide(bookOf("x-token", [[price, 100]], [[0.56, 100]], 5));
    const g = await reverifySelectedAction({ event: e, nowMs: T20, exposureExists: false, fetchExactTokenOrderbook: f });
    assert.equal(g.ok && g.contract.stake_usd, stake, `${price} x 5`);
  }
});

// ═══ D. timing ══════════════════════════════════════════════════════════════════════════════════════════

test("4: a Queue created at T-20 has cancel_by = T-12:40 -> ~440 s primary window, above Ireland's 180 s pre-claim minimum; reserve >= 580 s is validated, not derived", async () => {
  const timing = primaryMakerTiming(KICKOFF, LATEST)!;
  assert.equal(timing.primary_maker_cancel_by_iso, CANCEL_BY);
  assert.equal(timing.fallback_deadline_iso, LATEST);
  assert.equal(timing.required_min_remaining_seconds, IRELAND_REQUIRED_FALLBACK_RESERVE_SECONDS);
  const primaryWindowSeconds = (Date.parse(timing.primary_maker_cancel_by_iso) - T20) / 1000;
  assert.equal(primaryWindowSeconds, 440);
  assert.ok(primaryWindowSeconds > IRELAND_PRECLAIM_MIN_REMAINING_SECONDS);
  const reserve = (Date.parse(timing.fallback_deadline_iso) - Date.parse(timing.primary_maker_cancel_by_iso)) / 1000;
  assert.equal(reserve, 940);
  assert.ok(reserve >= IRELAND_REQUIRED_FALLBACK_RESERVE_SECONDS);
  // cancel_by is NOT derived from latest_entry any more
  assert.equal(primaryMakerTiming(KICKOFF, "2026-10-06T11:10:00.000Z")!.primary_maker_cancel_by_iso, CANCEL_BY);
  // a deadline that leaves less than the reserve floor is refused (fails closed), as is garbage
  assert.equal(primaryMakerTiming(KICKOFF, "2026-10-06T10:56:00.000Z"), null);
  assert.equal(primaryMakerTiming("garbage", LATEST), null);
  assert.equal(primaryMakerTiming(KICKOFF, "garbage"), null);

  // The real decision at exactly T-20 freezes that contract (MAKER_FIRST: ask above the taker limit, a valid bid).
  const { event, fetch } = await decide(bookOf("x-token", [[0.53, 100]], [[0.56, 100]], 5));
  assert.equal(event.decision.action, "MAKER_FIRST");
  const g = await reverifySelectedAction({ event, nowMs: T20, exposureExists: false, fetchExactTokenOrderbook: fetch });
  assert.equal(g.ok, true);
  if (g.ok) {
    assert.equal(g.contract.primary_maker_cancel_by_iso, CANCEL_BY);
    assert.equal(g.contract.fallback_deadline_iso, LATEST);
    assert.equal(g.contract.latest_entry_iso, LATEST);
    assert.equal(g.contract.required_min_remaining_seconds, 580);
    assert.equal((Date.parse(g.contract.primary_maker_cancel_by_iso!) - T20) / 1000, 440);
    assert.equal(g.contract.t30_telemetry_v1.LIVE_AUTHORITY, false, "T30 stays telemetry only");
  }
  // The T-20 instant is the first Queue instant: the Final Rebalance source window opens exactly there.
  assert.equal(classifyReservationMarketPhase(KICKOFF, T20), "T_MINUS_10");
  assert.equal(classifyReservationMarketPhase(KICKOFF, T20 - 1_000), "T_MINUS_30");
  assert.equal(classifyReservationMarketPhase(KICKOFF, KICKOFF_MS - 18 * 60_000), "T_MINUS_10", "the T-22..T-18 scheduling band");
});

test("D: frozen-contract timing is validated against the FIXED cancel_by and the reserve floor; rows frozen before the release keep validating", () => {
  const ok = queueRow("MAKER_FIRST");
  assert.equal(readT10FrozenContract(ok).ok, true);
  // legacy regime: latest_entry = start - 3m, cancel_by = latest - 580 s = start - 12m40s (same numeric cancel_by), reserve exactly 580 s
  const legacyLatest = "2026-10-06T10:57:00.000Z";
  const legacy = queueRow("MAKER_FIRST", { latest_entry_iso: legacyLatest });
  legacy.diagnostics = { ...legacy.diagnostics, t10_economic_action_v1: frozenMakerFirst({ latest_entry_iso: legacyLatest, fallback_deadline_iso: legacyLatest, primary_maker_cancel_by_iso: CANCEL_BY }) };
  assert.equal(readT10FrozenContract(legacy).ok, true, "pre-release rows are not stranded");
  const broken = (patch: Record<string, unknown>) => readT10FrozenContract({ ...ok, diagnostics: { ...ok.diagnostics, t10_economic_action_v1: { ...(ok.diagnostics.t10_economic_action_v1 as object), ...patch } } });
  assert.equal(broken({ primary_maker_cancel_by_iso: "2026-10-06T10:50:00.000Z" }).ok, false, "cancel_by must be event start - 12m40s");
  assert.equal(broken({ primary_maker_cancel_by_iso: "2026-10-06T10:40:00.000Z" }).ok, false);
  assert.equal(broken({ fallback_deadline_iso: "2026-10-06T11:05:00.000Z" }).ok, false, "fallback deadline = latest_entry");
  assert.equal(broken({ required_min_remaining_seconds: 579 }).ok, false, "reserve floor 580 s");
  assert.equal(broken({ required_min_remaining_seconds: 941 }).ok, false, "a required reserve above the actual window is refused");
  assert.equal(broken({ required_min_remaining_seconds: 580.5 }).ok, false);
  assert.equal(broken({ primary_maker_cancel_by_iso: undefined }).ok, false);
});

test("5/6: latest entry = event start + 3m -- T+2:59 is eligible everywhere, T+3:00 and later is rejected everywhere", async () => {
  assert.equal(latestEntryIso(KICKOFF_MS), LATEST);
  const before = KICKOFF_MS + 179_000;
  const at = KICKOFF_MS + 180_000;
  // rebalance due window / reservation lifecycle
  assert.equal(isDueForRebalance(KICKOFF_MS, before), true);
  assert.equal(isDueForRebalance(KICKOFF_MS, at), false);
  assert.equal(classifyActiveReservationDue({ game_start_iso: KICKOFF }, before).state, "DUE_NOW");
  assert.equal(classifyActiveReservationDue({ game_start_iso: KICKOFF }, at).state, "EXPIRED");
  // economic decision + mechanical guard (TAKER_FIRST is the mode that can still start after kickoff)
  const book = bookOf("x-token", [[0.51, 100]], [[0.53, 100]], 4);
  const { event: okEvent, fetch } = await decide(book, { now: before });
  assert.equal(okEvent.decision.action, "TAKER_FIRST");
  const okGuard = await reverifySelectedAction({ event: okEvent, nowMs: before, exposureExists: false, fetchExactTokenOrderbook: fetch });
  assert.equal(okGuard.ok, true, okGuard.ok ? "" : okGuard.reason);
  const { event: lateEvent } = await decide(book, { now: at });
  assert.equal(lateEvent.decision.action, "SKIP");
  assert.equal(lateEvent.decision.reason, "EVENT_AFTER_LATEST_ENTRY");
  const lateGuard = await reverifySelectedAction({ event: okEvent, nowMs: at, exposureExists: false, fetchExactTokenOrderbook: fetch });
  assert.equal(!lateGuard.ok && lateGuard.reason, "T10_ECON_GUARD_AFTER_LATEST_ENTRY");
  // a MAKER_FIRST can never start at/after cancel_by (T-12:40), long before latest_entry
  const { event: makerEvent, fetch: mf } = await decide(bookOf("x-token", [[0.53, 100]], [[0.56, 100]], 5));
  const afterCancel = await reverifySelectedAction({ event: makerEvent, nowMs: Date.parse(CANCEL_BY), exposureExists: false, fetchExactTokenOrderbook: mf });
  assert.match(!afterCancel.ok ? afterCancel.reason : "", /T10_ECON_GUARD_AFTER_PRIMARY_MAKER_CANCEL_BY/);
  // fallback authorization: same deadline
  const result = readIrelandExecutionResult({ ...overnight(), idempotency_key: IDEM }, "")!;
  const row = queueRow("MAKER_FIRST");
  assert.equal(evaluateMakerEligibility({ result, queue: row, nowMs: before }).eligible, true);
  const atDeadline = evaluateMakerEligibility({ result, queue: row, nowMs: at });
  assert.equal(atDeadline.eligible, false);
  assert.ok(atDeadline.reasons.includes("DEADLINE_PASSED"));
  // executor-facing command list: visible until (excluding) the deadline
  const w = world(queueRow("MAKER_FIRST"));
  const { auth } = await deliver(w, overnight());
  assert.equal(auth.kind, "MAKER_AUTHORIZED");
  assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], before).length, 1);
  assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], at).length, 0);
});

test("T30 stays telemetry only: no live decision input reads it (frozen contract flags it LIVE_AUTHORITY=false)", async () => {
  const { event, fetch } = await decide(bookOf("x-token", [[0.51, 100]], [[0.53, 100]], 4));
  const g = await reverifySelectedAction({ event, nowMs: T20, exposureExists: false, fetchExactTokenOrderbook: fetch });
  assert.equal(g.ok && g.contract.t30_telemetry_v1.LIVE_AUTHORITY, false);
  assert.equal(callbackIsTerminalProvenZero(overnight()), true);
});

// ═══ Route level: the REAL POST /api/executor/order-events handler -> HTTP 200 ═══════════════════════════

const SECRET = "hotfix-v2-secret";
process.env.EXECUTOR_CANDIDATES_SECRET = SECRET;

type Row = Record<string, unknown>;
const dbQueue: Row[] = [];
const dbEvents: Row[] = [];
function table(rows: Row[]) {
  return () => {
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const eqs: Array<[string, unknown]> = [];
    const run = (): Row[] => {
      const match = (r: Row) => eqs.every(([k, v]) => (v === null ? r[k] == null : r[k] === v));
      if (op === "insert") { const row = { id: `evt-${rows.length + 1}`, created_at: CALLBACK_AT.toISOString(), ...payload }; rows.push(row); return [row]; }
      if (op === "update") { const hit = rows.filter(match); for (const r of hit) Object.assign(r, payload); return hit; }
      return rows.filter(match);
    };
    const q: Record<string, unknown> = {
      select() { return q; },
      insert(p: Row) { op = "insert"; payload = p; return q; },
      update(p: Row) { op = "update"; payload = p; return q; },
      eq(k: string, v: unknown) { eqs.push([k, v]); return q; },
      is(k: string, v: unknown) { eqs.push([k, v]); return q; },
      async maybeSingle() { return { data: run()[0] ?? null, error: null }; },
      async single() { const r = run()[0]; return r ? { data: r, error: null } : { data: null, error: { message: "row not found" } }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: run(), error: null }).then(resolve); },
    };
    return q;
  };
}
mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(name: string) {
        if (name === "event_execution_queue") return table(dbQueue)();
        if (name === "executor_order_events") return table(dbEvents)();
        throw new Error(`unexpected table: ${name}`);
      },
    },
  },
});
mock.module("@/lib/liquidity/polymarketClient", {
  namedExports: {
    fetchOrderBook: async (tokenId: string) => ({ ok: true, tokenId, latencyMs: 1,
      book: { tokenId, bids: [{ price: 0.3, size: 100 }], asks: [{ price: 0.53, size: 100 }], raw: { tick_size: "0.01" } } }),
  },
});
const post = (body: Record<string, unknown>): NextRequest => new Request("http://localhost/api/executor/order-events", {
  method: "POST", headers: { "content-type": "application/json", "x-executor-secret": SECRET }, body: JSON.stringify(body),
}) as unknown as NextRequest;

test("1 (route): the overnight callback returns HTTP 200 end to end, persists the terminal zero, authorizes exactly one fallback; a duplicate is 200 + idempotent", async () => {
  dbQueue.length = 0; dbEvents.length = 0;
  dbQueue.push({ ...queueRow("MAKER_FIRST") });
  const { POST } = await import("../../app/api/executor/order-events/route");

  const first = await POST(post(overnight()));
  const firstBody = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  assert.equal(firstBody.success, true);
  assert.equal(firstBody.duplicate, false);
  assert.equal(firstBody.maker_fallback.kind, "MAKER_AUTHORIZED");
  assert.equal(firstBody.maker_fallback.command.attempt_id, "MAKER_FALLBACK_1");
  assert.equal(firstBody.queue_mark.kind, "FAILED");
  assert.equal(firstBody.economic_telemetry, null, "no accounting row is fabricated for a callback that never reached the venue");
  assert.equal(dbEvents.length, 1);
  const row = dbQueue[0] as unknown as EventExecutionQueueRow;
  assert.equal(row.status, "FAILED", "not left CLAIMED");
  const a = readExecutionAttempts(row.diagnostics);
  assert.equal(a.maker_first?.result?.result_class, "PROVEN_REJECTED_BEFORE_SUBMISSION");
  const command = a.maker_fallback_1?.command;
  assert.ok(command);

  const dup = await POST(post(overnight()));
  const dupBody = await dup.json();
  assert.equal(dup.status, 200, JSON.stringify(dupBody));
  assert.equal(dupBody.duplicate, true);
  assert.equal(dupBody.maker_fallback.kind, "MAKER_ALREADY_AUTHORIZED");
  assert.equal(dbEvents.length, 1);
  assert.deepEqual(readExecutionAttempts((dbQueue[0] as unknown as EventExecutionQueueRow).diagnostics).maker_fallback_1?.command, command, "still exactly one fallback");

  // partial / positive / UNKNOWN without a price stay a 409 at the route
  for (const [name, raw] of failClosed.slice(0, 6)) {
    dbQueue.length = 0; dbEvents.length = 0;
    dbQueue.push({ ...queueRow("MAKER_FIRST") });
    const res = await POST(post(raw));
    assert.equal(res.status, 409, name);
    assert.equal((await res.json()).reason, "MISSING_SUBMITTED_PRICE", name);
    assert.equal(dbEvents.length, 0, name);
  }
});
