// SINGLE_MAKER_PREGAME_CONTRACT_V1 -- focused regression set (founder list A-G).
//   node --import tsx --test tests/contur3/singleMakerPregameContract.test.ts
//
//   TAKER_FIRST > MAKER_FIRST > SKIP over all supported siblings of ONE physical event.
//   A  no valid TAKER among siblings -> exactly one MAKER_FIRST
//   B  MAKER_FIRST full fill -> no fallback, position held
//   C  MAKER_FIRST zero fill -> terminal cancel, NO MAKER_FALLBACK_1, event closed (exposure 0)
//   D  TAKER_ATTEMPT_1 proven rejected before submission -> exactly one MAKER_FALLBACK_1
//   E  TAKER-fallback maker zero fill -> no second fallback
//   F  maker cancel_by = event_start_iso - 60 s
//   G  no resting maker survives kickoff
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMakerEligibility,
  makerDeadlineIso,
  readExecutionAttempts,
  readIrelandExecutionResult,
  recordResultAndAuthorizeMaker,
  selectExecutorMakerFallbackCommands,
  type MakerFallbackCommand,
  type MakerFallbackPort,
} from "../../lib/executor/makerFallbackAuthorization";
import {
  MAKER_PREGAME_CUTOFF_SECONDS,
  primaryMakerSubmissionOpen,
  primaryMakerTiming,
  readT10FrozenContract,
  type EventExecutionQueueRow,
} from "../../lib/executor/executorQueueTypes";
import { eventExposureNotProvenZero } from "../../lib/executor/eventExecutionQueue";
import { decideT10EconomicEvent, reverifySelectedAction } from "../../lib/executor/t10EconomicActivation";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import type { TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";
import type { FinalT3MarketObservation } from "../../lib/executor/reservationMarketBaseline";

const KICKOFF = "2026-10-06T11:00:00.000Z";
const KICKOFF_MS = Date.parse(KICKOFF);
const LATEST = "2026-10-06T11:03:00.000Z";
const CUTOFF = "2026-10-06T10:59:00.000Z";                       // event start - 60 s
const CUTOFF_MS = Date.parse(CUTOFF);
const T20 = KICKOFF_MS - 20 * 60_000;
const IDEM = "idem_single_maker";
const EVENT = "provider:polymarket:single-maker:2026-10-06";

// ── economic decision over sibling markets (A + TAKER priority) ───────────────────────────────────────────

const feeSchedule = (tokenId: string): TokenFeeScheduleResult => ({
  ok: true, tokenId, conditionId: null, feesEnabled: true, takerRate: 0.05, exponent: 1, feeType: "sports_fees_v3",
  formulaVersion: "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1", source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID", observedAtIso: new Date(T20).toISOString(), latencyMs: 1,
});
const bookOf = (tokenId: string, bids: Array<[number, number]>, asks: Array<[number, number]>, min = 5, tick = 0.01): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 2,
  book: { tokenId, bids: bids.map(([price, size]) => ({ price, size })), asks: asks.map(([price, size]) => ({ price, size })), tickSize: tick, minimumOrderSize: min, providerTimestampMs: T20 },
});
const sibling = (token: string): FinalT3MarketObservation => ({
  capture_run_id: "t10-run", reservation_id: "res1", physical_event_id: EVENT, provider_event_id: "single-maker", event_start_iso: KICKOFF,
  observation_phase: "T_MINUS_10", condition_id: `c-${token}`, token_id: token, side: "Yes", canonical_market_family: "MONEYLINE", canonical_market_type: "MONEYLINE",
  market_slug: token, best_bid: 0.5, best_ask: 0.54, ask_decimal_odds: 1 / 0.54, orderbook_fetch_status: "SUCCESS", observed_at: new Date(T20 - 20_000).toISOString(),
});
async function decide(books: Record<string, FetchOrderBookResult>) {
  const deps = { fetchExactTokenOrderbook: async (t: string) => books[t], fetchTokenFeeSchedule: async (t: string) => feeSchedule(t) };
  return decideT10EconomicEvent({
    physicalEventId: EVENT, eventStartIso: KICKOFF, t10Universe: Object.keys(books).map(sibling), t30Universe: null, nowMs: T20, exposureExists: false, deps,
  });
}
// maker-only book: ask .56 is above the taker limit, a valid bid .53 exists. taker-valid book: ask .53.
const MAKER_ONLY = (t: string) => bookOf(t, [[0.53, 100]], [[0.56, 100]], 5);
const TAKER_VALID = (t: string) => bookOf(t, [[0.51, 100]], [[0.53, 100]], 4);

test("A: no valid TAKER among the supported siblings -> exactly ONE MAKER_FIRST", async () => {
  const event = await decide({ "tok-a": MAKER_ONLY("tok-a"), "tok-b": MAKER_ONLY("tok-b") });
  assert.equal(event.decision.action, "MAKER_FIRST");
  assert.ok(event.decision.selected, "exactly one selected maker candidate");
});

test("TAKER priority: any valid TAKER sibling wins over a MAKER sibling", async () => {
  const event = await decide({ "tok-a": MAKER_ONLY("tok-a"), "tok-b": TAKER_VALID("tok-b") });
  assert.equal(event.decision.action, "TAKER_FIRST");
  assert.equal(event.decision.selected?.candidateIdentity.tokenId, "tok-b");
});

test("A: a MAKER_FIRST frozen at T-20 carries cancel_by = event start - 60 s (rests ~19 minutes)", async () => {
  const event = await decide({ "tok-a": MAKER_ONLY("tok-a") });
  const g = await reverifySelectedAction({ event, nowMs: T20, exposureExists: false, fetchExactTokenOrderbook: async (t) => MAKER_ONLY(t) });
  assert.equal(g.ok, true);
  if (!g.ok) return;
  assert.equal(g.contract.primary_maker_cancel_by_iso, CUTOFF);
  assert.equal((Date.parse(g.contract.primary_maker_cancel_by_iso!) - T20) / 1000, 19 * 60);
});

// ── Queue-row fixtures ──────────────────────────────────────────────────────────────────────────────────────

function frozenMakerFirst() {
  return {
    execution_policy_version: "T10_ECONOMIC_ACTION_EXECUTION_V1", economic_policy_version: "T10_ECONOMIC_ACTION_POLICY_V1",
    execution_mode: "MAKER_FIRST", price_authority_version: "T10_CURRENT_BOOK_EXECUTION_AUTHORITY_V1", price_authority_observation_id: "obs1",
    p_buy_max: 0.5, reference_status: "STRONG", physical_event_id: EVENT, condition_id: "cond1", token_id: "tok1", side: "YES",
    market_family: "TOTALS", stake_usd: 2.5, hard_price_cap: 0.555, latest_entry_iso: LATEST,
    tick_size: 0.01, minimum_order_size: 5, spread_telemetry: 0.02, activation_switch: "T10_ECONOMIC_ACTION_ACTIVATION",
    taker: null, maker: { maker_limit_price: 0.5, maker_shares: 5 }, ...primaryMakerTiming(KICKOFF, LATEST),
  };
}
const frozenTakerFirst = () => ({
  ...frozenMakerFirst(), execution_mode: "TAKER_FIRST", p_buy_max: 0.555, maker: null, taker: { price_limit: 0.5 },
  primary_maker_cancel_by_iso: undefined, fallback_deadline_iso: undefined, required_min_remaining_seconds: undefined,
});
function queueRow(mode: "MAKER_FIRST" | "TAKER_FIRST", over: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res1", plan_run_id: "plan1", rebalance_run_id: "rb1", match_family_key: EVENT,
    event_title: "A v B", event_slug: "a-v-b", sport: "soccer", league: "x", game_start_iso: KICKOFF,
    condition_id: "cond1", token_id: "tok1", side: "YES", market_slug: "m", market_title: "m", market_family: "TOTALS",
    score: null, coverage: null, tier: "TIER1", stake_usd: 2.5, preferred_entry_iso: "2026-10-06T10:15:00.000Z",
    latest_entry_iso: LATEST, selection_rank: 1, selection_reason: null, status: "EXECUTED",
    order_key: "k", idempotency_key: IDEM,
    diagnostics: { physical_event_id: EVENT, max_entry_price: 0.5, max_stake_usd: 4,
      t10_economic_action_v1: mode === "MAKER_FIRST" ? frozenMakerFirst() : frozenTakerFirst() },
    ...over,
  } as EventExecutionQueueRow;
}
function world(row: EventExecutionQueueRow) {
  const st = { row, claims: 0 };
  const port: MakerFallbackPort = {
    async loadQueueRowByIdempotencyKey(k) { return k === IDEM ? structuredClone(st.row) : null; },
    async fetchBook() { return { bestBid: 0.3, bestAsk: 0.53, tickSize: 0.01 }; },
    async recordResult(_id, slot, result) {
      const a = readExecutionAttempts(st.row.diagnostics);
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, [slot]: { ...(a[slot] ?? {}), result } } } };
    },
    async claimMakerFallback(_id, command: MakerFallbackCommand) {
      const a = readExecutionAttempts(st.row.diagnostics);
      if (a.maker_fallback_1?.command) return false;
      st.claims++;
      st.row = { ...st.row, diagnostics: { ...st.row.diagnostics, execution_attempts_v1: { ...a, maker_fallback_1: { command } } } };
      return true;
    },
  };
  return { st, port };
}
const NOW = new Date(T20 + 60_000);
const makerFirstResult = (outcome: string, v1: Record<string, unknown> = {}) => ({
  event_type: "ORDER_RESULT", idempotency_key: IDEM, attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST",
  queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES",
  execution_result_v1: { attempt_id: "MAKER_FIRST", execution_mode: "MAKER_FIRST", outcome, venue_order_id: "v-1", requested_quantity: 5, ...v1 },
});
const takerResult = (outcome: string, v1: Record<string, unknown> = {}) => ({
  idempotency_key: IDEM, condition_id: "cond1", token_id: "tok1", side: "YES",
  execution_result_v1: { attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER", outcome, requested_quantity: 5, ...v1 },
});

test("B: MAKER_FIRST full fill -> no fallback, the acquired shares are held (exposure stays)", async () => {
  const w = world(queueRow("MAKER_FIRST"));
  const out = await recordResultAndAuthorizeMaker(w.port, makerFirstResult("FULL_FILL", { filled_quantity: 5, average_fill_price: 0.5 }), NOW);
  assert.deepEqual(out, { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_first" });
  assert.equal(w.st.claims, 0);
  assert.equal(readExecutionAttempts(w.st.row.diagnostics).maker_fallback_1, undefined);
  assert.equal(eventExposureNotProvenZero([w.st.row]), true, "a filled position is exposure: no new selection for the event");
});

test("C: MAKER_FIRST zero fill (every proven-zero class) -> terminal cancel, NO MAKER_FALLBACK_1, exposure = 0, event closed", async () => {
  for (const outcome of ["PROVEN_ZERO_FILL_CANCELLED", "PROVEN_ZERO_FILL_EXPIRED", "PROVEN_ZERO_FILL_PRICE", "PROVEN_ZERO_FILL_NO_LIQUIDITY", "PROVEN_REJECTED_BEFORE_SUBMISSION"]) {
    const w = world(queueRow("MAKER_FIRST"));
    const out = await recordResultAndAuthorizeMaker(w.port, makerFirstResult(outcome, { filled_quantity: 0 }), NOW);
    assert.deepEqual(out, { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_first" }, outcome);
    assert.equal(w.st.claims, 0, outcome);
    const a = readExecutionAttempts(w.st.row.diagnostics);
    assert.equal(a.maker_fallback_1, undefined, outcome);
    assert.equal(a.maker_first?.result?.economic_exposure_proven_zero, true, `${outcome}: exposure = 0`);
    assert.equal(a.maker_first?.result?.terminal, true);
    assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], NOW.getTime()).length, 0, outcome);
    assert.equal(eventExposureNotProvenZero([w.st.row]), true, `${outcome}: the event is closed -- never re-selected, never a second maker`);
  }
});

test("C: a MAKER_FIRST row is never an eligible fallback parent (predicate level)", () => {
  const result = readIrelandExecutionResult(makerFirstResult("PROVEN_ZERO_FILL_CANCELLED", { filled_quantity: 0 }), NOW.toISOString());
  const verdict = evaluateMakerEligibility({ result, queue: queueRow("MAKER_FIRST"), nowMs: NOW.getTime() });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.reasons.includes("PRIMARY_MAKER_ROW_NO_FALLBACK"));
});

test("D: TAKER_ATTEMPT_1 proven rejected before submission -> exposure zero -> exactly ONE MAKER_FALLBACK_1 (same bet, T-1:00 cutoff)", async () => {
  const w = world(queueRow("TAKER_FIRST"));
  const raw = takerResult("PROVEN_REJECTED_BEFORE_SUBMISSION", { terminal: true, economic_exposure_proven_zero: true, filled_quantity: 0, venue_order_id: null });
  const out = await recordResultAndAuthorizeMaker(w.port, raw, NOW);
  assert.equal(out.kind, "MAKER_AUTHORIZED");
  const cmd = (out as { command: MakerFallbackCommand }).command;
  assert.deepEqual([cmd.attempt_id, cmd.parent_attempt_id, cmd.token_id, cmd.condition_id, cmd.side, cmd.stake_usd],
    ["MAKER_FALLBACK_1", "TAKER_ATTEMPT_1", "tok1", "cond1", "YES", 2.5]);
  assert.equal(cmd.deadline_iso, CUTOFF, "the fallback maker shares the single pre-kickoff cutoff");
  const dup = await recordResultAndAuthorizeMaker(w.port, raw, NOW);
  assert.equal(dup.kind, "MAKER_ALREADY_AUTHORIZED");
  assert.equal(w.st.claims, 1, "exactly one fallback");
});

test("E: the TAKER-fallback maker's zero fill -> cancel -> NO second fallback (no MAKER_FALLBACK_2), event closed", async () => {
  const w = world(queueRow("TAKER_FIRST"));
  const first = await recordResultAndAuthorizeMaker(w.port,
    takerResult("PROVEN_REJECTED_BEFORE_SUBMISSION", { terminal: true, economic_exposure_proven_zero: true, filled_quantity: 0, venue_order_id: null }), NOW);
  const cmd = (first as { command: MakerFallbackCommand }).command;
  const fb = (attempt: string, outcome: string) => ({
    event_type: "ORDER_RESULT", idempotency_key: cmd.idempotency_key, parent_idempotency_key: IDEM, attempt_id: attempt, execution_mode: "MAKER",
    queue_id: "q1", reservation_id: "res1", condition_id: "cond1", token_id: "tok1", side: "YES",
    execution_result_v1: { attempt_id: attempt, execution_mode: "MAKER", outcome, venue_order_id: "v-2", filled_quantity: 0 },
  });
  const zero = await recordResultAndAuthorizeMaker(w.port, fb("MAKER_FALLBACK_1", "PROVEN_ZERO_FILL_EXPIRED"), new Date(CUTOFF_MS - 1_000));
  assert.deepEqual(zero, { kind: "RESULT_RECORDED_NO_FURTHER_ATTEMPT", slot: "maker_fallback_1" });
  assert.equal(w.st.claims, 1, "never a second fallback");
  const second = await recordResultAndAuthorizeMaker(w.port, fb("MAKER_FALLBACK_2", "PROVEN_ZERO_FILL_EXPIRED"), NOW);
  assert.deepEqual(second, { kind: "MAKER_CALLBACK_REJECTED", reason: "UNKNOWN_ATTEMPT_ID" });
  assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], NOW.getTime()).length, 0, "command consumed");
  assert.equal(eventExposureNotProvenZero([w.st.row]), true, "the single maker attempt is consumed: the event is closed");
});

test("F: maker cancel_by = event_start_iso - 60 s (MAKER_FIRST wire + frozen contract + fallback deadline)", () => {
  assert.equal(MAKER_PREGAME_CUTOFF_SECONDS, 60);
  const timing = primaryMakerTiming(KICKOFF, LATEST)!;
  assert.equal(timing.primary_maker_cancel_by_iso, CUTOFF);
  assert.equal(KICKOFF_MS - Date.parse(timing.primary_maker_cancel_by_iso), 60_000);
  assert.equal(readT10FrozenContract(queueRow("MAKER_FIRST")).ok, true);
  assert.equal(makerDeadlineIso(queueRow("TAKER_FIRST")), CUTOFF);
  // Independent of latest_entry.
  assert.equal(primaryMakerTiming(KICKOFF, "2026-10-06T11:10:00.000Z")!.primary_maker_cancel_by_iso, CUTOFF);
});

test("G: no resting maker survives kickoff -- MAKER_FIRST submission, fallback authorization and fallback command all close at T-1:00", async () => {
  const wire = { execution_mode: "MAKER_FIRST" as const, primary_maker_cancel_by_iso: CUTOFF };
  assert.equal(primaryMakerSubmissionOpen(wire, CUTOFF_MS - 1), true);
  for (const nowMs of [CUTOFF_MS, KICKOFF_MS - 1, KICKOFF_MS, KICKOFF_MS + 60_000, Date.parse(LATEST)]) {
    assert.equal(primaryMakerSubmissionOpen(wire, nowMs), false, `MAKER_FIRST submission closed @${nowMs}`);
  }
  // A frozen contract whose cancel_by reaches kickoff is invalid (cannot be handed to Ireland).
  const late = queueRow("MAKER_FIRST");
  late.diagnostics = { ...late.diagnostics, t10_economic_action_v1: { ...frozenMakerFirst(), primary_maker_cancel_by_iso: KICKOFF } };
  assert.equal(readT10FrozenContract(late).ok, false);
  // Fallback authorization + the executor-facing command list: nothing at/after the cutoff.
  const parent = queueRow("TAKER_FIRST");
  const taker = takerResult("PROVEN_ZERO_FILL_PRICE", { terminal: true, economic_exposure_proven_zero: true, filled_quantity: 0 });
  for (const nowMs of [CUTOFF_MS, KICKOFF_MS, KICKOFF_MS + 120_000]) {
    const w = world(parent);
    const out = await recordResultAndAuthorizeMaker(w.port, taker, new Date(nowMs));
    assert.equal(out.kind, "MAKER_BLOCKED", `@${nowMs}`);
    assert.ok((out as { reasons: string[] }).reasons.includes("DEADLINE_PASSED"));
    assert.equal(w.st.claims, 0);
  }
  const w = world(parent);
  const authorized = await recordResultAndAuthorizeMaker(w.port, taker, new Date(CUTOFF_MS - 1_000));
  assert.equal(authorized.kind, "MAKER_AUTHORIZED");
  assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], CUTOFF_MS - 1).length, 1);
  for (const nowMs of [CUTOFF_MS, KICKOFF_MS, KICKOFF_MS + 1_000]) {
    assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: w.st.row.diagnostics }], nowMs).length, 0, `fallback command withdrawn @${nowMs}`);
  }
});

test("G (legacy commands): a pre-contract command never surfaces from a MAKER_FIRST parent, and is capped at event start - 60 s", async () => {
  const w = world(queueRow("TAKER_FIRST"));
  const out = await recordResultAndAuthorizeMaker(w.port,
    takerResult("PROVEN_REJECTED_BEFORE_SUBMISSION", { terminal: true, economic_exposure_proven_zero: true, filled_quantity: 0, venue_order_id: null }), NOW);
  const cmd = (out as { command: MakerFallbackCommand }).command;
  const attempts = (command: unknown) => ({ execution_attempts_v1: { maker_fallback_1: { command } } });
  // a command authorized under the old contract: deadline = latest_entry (start + 3 min)
  const legacy = { ...cmd, deadline_iso: LATEST };
  const row = { diagnostics: attempts(legacy), game_start_iso: KICKOFF };
  const listed = selectExecutorMakerFallbackCommands([row], CUTOFF_MS - 1_000);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].deadline_iso, CUTOFF, "surfaced deadline is capped at the pre-kickoff cutoff");
  for (const nowMs of [CUTOFF_MS, KICKOFF_MS, KICKOFF_MS + 60_000]) {
    assert.equal(selectExecutorMakerFallbackCommands([row], nowMs).length, 0, `no resting maker @${nowMs}`);
  }
  // a command with a MAKER_FIRST parent (old contract) is never surfaced
  const mfParent = { diagnostics: attempts({ ...legacy, parent_attempt_id: "MAKER_FIRST" }), game_start_iso: KICKOFF };
  assert.equal(selectExecutorMakerFallbackCommands([mfParent], CUTOFF_MS - 1_000).length, 0);
  // an unparseable start fails closed; an absent start keeps the stored deadline (new commands already carry the cutoff)
  assert.equal(selectExecutorMakerFallbackCommands([{ ...row, game_start_iso: "garbage" }], CUTOFF_MS - 1_000).length, 0);
  assert.equal(selectExecutorMakerFallbackCommands([{ diagnostics: attempts(cmd) }], CUTOFF_MS - 1_000)[0].deadline_iso, CUTOFF);
});
