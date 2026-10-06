// P2_PREMVP_SAFE_TAKER_TO_MAKER_AUTHORIZATION_V1
//   node --import tsx --test tests/contur3/makerFallbackAuthorization.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordResultAndAuthorizeMaker,
  readExecutionAttempts,
  makerIdempotencyKey,
  makerDeadlineIso,
  deriveMakerLimitPrice,
  type MakerFallbackPort,
  type MakerFallbackCommand,
  type IrelandExecutionResult,
} from "../../lib/executor/makerFallbackAuthorization";
import { mapQueueRowToIrelandCandidate, type EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

const NOW = new Date("2026-10-01T18:00:00.000Z");
const IDEM = "idem_taker_1";

function queueRow(over: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res1", plan_run_id: "plan1", rebalance_run_id: "rb1",
    match_family_key: "provider:polymarket:777:2026-10-01", event_title: "A v B", event_slug: "a-v-b",
    sport: "soccer", league: "x", game_start_iso: "2026-10-01T19:00:00.000Z",
    condition_id: "cond1", token_id: "tok1", side: "YES", market_slug: "m", market_title: "m",
    market_family: "MONEYLINE", score: 1, coverage: 1, tier: "TIER1", stake_usd: 2.5,
    preferred_entry_iso: "2026-10-01T17:00:00.000Z", latest_entry_iso: "2026-10-01T18:50:00.000Z",
    selection_rank: 1, selection_reason: null, status: "SENT", order_key: "k", idempotency_key: IDEM,
    diagnostics: { max_entry_price: 0.54, physical_event_id: "provider:polymarket:777:2026-10-01", model_lineage_v1: { model_variant: "B", policy_version: "v9" } },
    ...over,
  };
}

function fakePort(row: EventExecutionQueueRow, book = { bestBid: 0.48, bestAsk: 0.5, tickSize: 0.01 as number | null }) {
  const state = { row, claims: 0, results: [] as string[] };
  const port: MakerFallbackPort = {
    async loadQueueRowByIdempotencyKey(k) { return k === IDEM ? structuredClone(state.row) : null; },
    async fetchBook() { return book; },
    async recordResult(_id, slot, result) {
      state.results.push(slot);
      const a = readExecutionAttempts(state.row.diagnostics);
      state.row = { ...state.row, diagnostics: { ...state.row.diagnostics, execution_attempts_v1: { ...a, [slot]: { ...(a[slot] ?? {}), result } } } };
    },
    async claimMakerFallback(_id, command: MakerFallbackCommand) {
      // atomic CAS: synchronous check+set, like the DB compare-and-set
      const a = readExecutionAttempts(state.row.diagnostics);
      if (a.maker_fallback_1?.command) return false;
      state.claims++;
      state.row = { ...state.row, diagnostics: { ...state.row.diagnostics, execution_attempts_v1: { ...a, maker_fallback_1: { ...(a.maker_fallback_1 ?? {}), command } } } };
      return true;
    },
  };
  return { port, state };
}

const zero = (over: Record<string, unknown> = {}) => ({
  idempotency_key: IDEM, condition_id: "cond1", token_id: "tok1", side: "YES",
  ireland_execution_result: {
    attempt_id: "TAKER_ATTEMPT_1", execution_mode: "TAKER", result_class: "PROVEN_ZERO_FILL_PRICE",
    requested_quantity: 5, filled_quantity: 0, remaining_quantity: 5, terminal: true,
    economic_exposure_proven_zero: true, venue_order_id: "v1", ...over,
  },
});

async function run(raw: Record<string, unknown>, row = queueRow(), now = NOW) {
  const f = fakePort(row);
  const out = await recordResultAndAuthorizeMaker(f.port, raw, now);
  return { out, ...f };
}

for (const [name, over] of [
  ["FULL_FILL", { result_class: "FULL_FILL", filled_quantity: 5, remaining_quantity: 0, economic_exposure_proven_zero: false }],
  ["PARTIAL_FILL", { result_class: "PARTIAL_FILL", filled_quantity: 2, economic_exposure_proven_zero: false }],
  ["PARTIAL_FILL even if lying zero flag", { result_class: "PARTIAL_FILL", filled_quantity: 2 }],
  ["UNKNOWN_AFTER_SUBMISSION", { result_class: "UNKNOWN_AFTER_SUBMISSION", filled_quantity: null, economic_exposure_proven_zero: null }],
  ["UNKNOWN_TRANSPORT", { result_class: "UNKNOWN_TRANSPORT", filled_quantity: null, economic_exposure_proven_zero: null }],
  ["UNKNOWN claiming zero", { result_class: "UNKNOWN_AFTER_SUBMISSION", filled_quantity: 0 }],
  ["zero exposure null", { economic_exposure_proven_zero: null }],
  ["zero exposure false", { economic_exposure_proven_zero: false }],
  ["filled_quantity reported positive on a zero class", { filled_quantity: 0.5 }],
  ["nonterminal/open", { terminal: false }],
  ["terminal missing", { terminal: null }],
] as const) {
  test(`BLOCK maker: ${name}`, async () => {
    const { out, state } = await run(zero(over));
    assert.equal(out.kind, "MAKER_BLOCKED");
    assert.equal(state.claims, 0);
  });
}

test("BLOCK maker: missing callback/result is never zero", async () => {
  const { out, state } = await run({ idempotency_key: IDEM, order_status: "unfilled" });
  assert.equal(out.kind, "NO_RESULT");
  assert.equal(state.claims, 0);
});

test("BLOCK maker: expired deadline; the deadline is the single pre-kickoff cutoff (event start - 60 s), never at/after kickoff", async () => {
  const { out } = await run(zero(), queueRow(), new Date("2026-10-01T18:51:00.000Z"));
  assert.equal(out.kind, "MAKER_BLOCKED");
  const row = queueRow({ latest_entry_iso: "2026-10-01T19:03:00.000Z" });   // kickoff 19:00 + 3m
  assert.equal(makerDeadlineIso(row), "2026-10-01T18:59:00.000Z", "event start - 60 s");
  const lastSecond = await run(zero(), row, new Date("2026-10-01T18:58:59.000Z"));
  assert.equal(lastSecond.out.kind, "MAKER_AUTHORIZED", "T-1:01 is still eligible");
  assert.equal((lastSecond.out as { command: { deadline_iso: string } }).command.deadline_iso, "2026-10-01T18:59:00.000Z");
  for (const at of ["2026-10-01T18:59:00.000Z", "2026-10-01T19:00:00.000Z", "2026-10-01T19:01:00.000Z", "2026-10-01T19:02:59.000Z"]) {
    const late = await run(zero(), row, new Date(at));
    assert.equal(late.out.kind, "MAKER_BLOCKED", `${at}: no resting maker at/after the cutoff or kickoff`);
    assert.ok((late.out as { reasons: string[] }).reasons.includes("DEADLINE_PASSED"));
  }
  // Fails closed on an unparseable kickoff / latest_entry.
  assert.equal(makerDeadlineIso({ ...row, game_start_iso: "garbage" }), null);
  assert.equal(makerDeadlineIso({ ...row, latest_entry_iso: "garbage" }), null);
});

test("BLOCK maker: identity mismatch and maker-mode/attempt confusion", async () => {
  assert.equal((await run({ ...zero(), token_id: "other" })).out.kind, "MAKER_BLOCKED");
  assert.equal((await run(zero({ attempt_id: null }))).out.kind, "MAKER_BLOCKED");
});

test("AUTHORIZE: authoritative terminal zero -> exactly one MAKER_FALLBACK_1 on same identity", async () => {
  const { out, state } = await run(zero());
  assert.equal(out.kind, "MAKER_AUTHORIZED");
  assert.ok(out.kind === "MAKER_AUTHORIZED");
  const c = out.command;
  assert.equal(c.attempt_id, "MAKER_FALLBACK_1");
  assert.equal(c.execution_mode, "MAKER");
  assert.equal(c.physical_event_id, "provider:polymarket:777:2026-10-01");
  assert.equal(c.reservation_id, "res1");
  assert.equal(c.condition_id, "cond1");
  assert.equal(c.token_id, "tok1");
  assert.equal(c.side, "YES");
  assert.equal(c.market_family, "MONEYLINE");
  assert.equal(c.strategy_variant, "B");
  assert.equal(c.parent_attempt_id, "TAKER_ATTEMPT_1");
  assert.equal(c.limit_price, 0.49); // best_bid + 1 tick, strictly below ask 0.50
  assert.ok(c.limit_price < 0.5);
  assert.ok(c.quantity * c.limit_price <= 2.5 + 1e-9, "stake never increased");
  assert.equal(c.stake_usd, 2.5);
  assert.equal(c.deadline_iso, "2026-10-01T18:50:00.000Z");
  assert.equal(state.claims, 1);
});

test("AUTHORIZE: pre-submission reject with proven zero", async () => {
  const { out } = await run(zero({ result_class: "PROVEN_REJECTED_BEFORE_SUBMISSION", venue_order_id: null }));
  assert.equal(out.kind, "MAKER_AUTHORIZED");
});

for (const cls of ["PROVEN_ZERO_FILL_NO_LIQUIDITY", "PROVEN_ZERO_FILL_EXPIRED"]) {
  test(`AUTHORIZE: ${cls}`, async () => {
    assert.equal((await run(zero({ result_class: cls }))).out.kind, "MAKER_AUTHORIZED");
  });
}

test("replayed zero result -> still exactly one maker instruction", async () => {
  const f = fakePort(queueRow());
  const a = await recordResultAndAuthorizeMaker(f.port, zero(), NOW);
  const b = await recordResultAndAuthorizeMaker(f.port, zero(), NOW);
  assert.equal(a.kind, "MAKER_AUTHORIZED");
  assert.equal(b.kind, "MAKER_ALREADY_AUTHORIZED");
  assert.equal(f.state.claims, 1);
});

test("concurrent authorization -> exactly one maker instruction", async () => {
  const f = fakePort(queueRow());
  const outs = await Promise.all(Array.from({ length: 8 }, () => recordResultAndAuthorizeMaker(f.port, zero(), NOW)));
  assert.equal(f.state.claims, 1);
  assert.equal(outs.filter((o) => o.kind === "MAKER_AUTHORIZED").length, 1);
});

test("passive price unsafe / non-representable -> no maker", async () => {
  assert.deepEqual(deriveMakerLimitPrice({ bestBid: 0.49, bestAsk: 0.5, tickSize: 0.01, priceCap: 0.54 }), { ok: false, reason: "NOT_BELOW_ASK" });
  assert.equal(deriveMakerLimitPrice({ bestBid: 0.48, bestAsk: 0.5, tickSize: null, priceCap: 0.54 }).ok, false);
  assert.equal(deriveMakerLimitPrice({ bestBid: null, bestAsk: 0.5, tickSize: 0.01, priceCap: 0.54 }).ok, false);
  assert.equal(deriveMakerLimitPrice({ bestBid: 0.54, bestAsk: 0.6, tickSize: 0.01, priceCap: 0.54 }).ok, false); // above cap
  const locked = fakePort(queueRow(), { bestBid: 0.49, bestAsk: 0.5, tickSize: 0.01 });
  const out = await recordResultAndAuthorizeMaker(locked.port, zero(), NOW);
  assert.equal(out.kind, "MAKER_BLOCKED");
  assert.equal(locked.state.claims, 0);
});

test("a recorded taker fill is never overwritten nor lets a later zero-proof authorize maker", async () => {
  const f = fakePort(queueRow());
  const partial = await recordResultAndAuthorizeMaker(f.port, zero({ result_class: "PARTIAL_FILL", filled_quantity: 2, economic_exposure_proven_zero: false }), NOW);
  assert.equal(partial.kind, "MAKER_BLOCKED");
  const later = await recordResultAndAuthorizeMaker(f.port, zero(), NOW);
  assert.equal(later.kind, "MAKER_BLOCKED");
  assert.equal(f.state.claims, 0);
  assert.equal(readExecutionAttempts(f.state.row.diagnostics).taker_attempt_1?.result?.result_class, "PARTIAL_FILL");
});

test("maker results never authorize a third attempt (no MAKER_FALLBACK_2)", async () => {
  for (const cls of ["PARTIAL_FILL", "FULL_FILL", "PROVEN_ZERO_FILL_EXPIRED", "PROVEN_ZERO_FILL_NO_LIQUIDITY", "UNKNOWN_AFTER_SUBMISSION"]) {
    const f = fakePort(queueRow());
    await recordResultAndAuthorizeMaker(f.port, zero(), NOW);
    const out = await recordResultAndAuthorizeMaker(f.port, {
      idempotency_key: makerIdempotencyKey(IDEM), parent_idempotency_key: IDEM,
      ireland_execution_result: { attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER", result_class: cls, filled_quantity: cls === "PARTIAL_FILL" ? 1 : 0, terminal: true, economic_exposure_proven_zero: true },
    }, NOW);
    assert.equal(out.kind, "RESULT_RECORDED_NO_FURTHER_ATTEMPT");
    assert.equal(f.state.claims, 1);
  }
});

test("taker candidate projection stays explicit TAKER_ATTEMPT_1", () => {
  const c = mapQueueRowToIrelandCandidate(queueRow({ status: "READY" }), NOW.getTime());
  assert.equal(c.execution_mode, "TAKER");
  assert.equal(c.attempt_id, "TAKER_ATTEMPT_1");
  assert.equal(c.stake_usd, 2.5);
  assert.equal(c.price_cap, 0.54);
});

test("BUSINESS TRACE", async () => {
  const f = fakePort(queueRow({ status: "READY" }));
  const trace: string[] = [];
  const cand = mapQueueRowToIrelandCandidate(f.state.row, NOW.getTime());
  trace.push(`Reservation ${cand.reservation_id} -> Final Identity ${cand.physical_event_id} ${cand.condition_id}/${cand.token_id}/${cand.side}`);
  trace.push(`TAKER command ${cand.execution_mode}/${cand.attempt_id} stake=${cand.stake_usd} cap=${cand.price_cap}`);
  f.state.row = { ...f.state.row, status: "SENT" };
  const z = await recordResultAndAuthorizeMaker(f.port, zero(), NOW);
  assert.ok(z.kind === "MAKER_AUTHORIZED");
  trace.push(`Ireland PROVEN_ZERO_FILL_PRICE -> MAKER_AUTHORIZED=YES limit=${z.command.limit_price} qty=${z.command.quantity} deadline=${z.command.deadline_iso}`);
  trace.push(`MAKER command ${z.command.execution_mode}/${z.command.attempt_id} ${z.command.physical_event_id} ${z.command.condition_id}/${z.command.token_id}/${z.command.side}`);
  const m = await recordResultAndAuthorizeMaker(f.port, { idempotency_key: "mk", parent_idempotency_key: IDEM, ireland_execution_result: { attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER", result_class: "PARTIAL_FILL", filled_quantity: 1, terminal: true, economic_exposure_proven_zero: false } }, NOW);
  trace.push(`Ireland MAKER result -> ${m.kind}`);
  const b = await run(zero({ result_class: "PARTIAL_FILL", filled_quantity: 2, economic_exposure_proven_zero: false }));
  trace.push(`BLOCKED: TAKER PARTIAL_FILL -> MAKER_AUTHORIZED=${b.out.kind === "MAKER_AUTHORIZED" ? "YES" : "NO"}`);
  const u = await run(zero({ result_class: "UNKNOWN_AFTER_SUBMISSION", filled_quantity: null, economic_exposure_proven_zero: null }));
  trace.push(`BLOCKED: TAKER UNKNOWN_AFTER_SUBMISSION -> MAKER_AUTHORIZED=${u.out.kind === "MAKER_AUTHORIZED" ? "YES" : "NO"}`);
  console.log(trace.join("\n"));
  assert.equal(f.state.claims, 1, "one physical event, one maker slot");
});

// PREMVP_TERMINAL_ZERO_TO_FALLBACK_CONTRACT_V2: a proven-zero class that is terminal with explicit
// zero-exposure proof needs no numeric filled_quantity (released outcome-only semantics).
test("ALLOW maker: zero class + terminal + exposure proven zero, filled_quantity absent", async () => {
  const { out, state } = await run(zero({ filled_quantity: null }));
  assert.equal(out.kind, "MAKER_AUTHORIZED");
  assert.equal(state.claims, 1);
});
