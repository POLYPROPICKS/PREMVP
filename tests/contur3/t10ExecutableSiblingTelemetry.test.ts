// T10_EXECUTABLE_SIBLING_TELEMETRY_V1 — focused semantics + one full-path fixture
// (Reservation -> T10 capture -> every supported sibling -> ordinary-$2.50 evidence from the CURRENT T10 book).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  T10_EXECUTABLE_TELEMETRY_KEYS,
  T10_EXECUTABLE_TELEMETRY_NEW_COLUMNS,
  T10_EXECUTABLE_TELEMETRY_VERSION,
  T30_PASSIVE_EXECUTABLE_TELEMETRY_VERSION,
  captureReservationMarketObservation,
  classifyReservationMarketPhase,
  executableTelemetryFailureColumns,
  isMissingTelemetryColumnError,
  withoutNewTelemetryColumns,
  selectReservationT3AbDecisions,
  strategyRowsForMarketObservations,
  type ReservationMarketPhase,
} from "../../lib/executor/reservationMarketBaseline";
import {
  FEE_FETCH_TOTAL_BUDGET_MS,
  buildExecutableSiblingColumns,
  fetchFeeSchedulesBounded,
  summarizeExecutableSiblingTelemetry,
} from "../../lib/executor/t10ExecutableSiblingTelemetry";
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "../../lib/executor/executorQueueTypes";
import { TAKER_FEE_FORMULA_VERSION, type TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import {
  FIXTURE_PHYSICAL_ID, FIXTURE_START_ISO, fixtureReservation, ownEventMarkets, siblingEventMarkets, universeFromRows,
} from "./helpers/t10SameGameFixture";

type Row = Record<string, unknown>;
const identity = (tokenId: string, conditionId = "c", side = "Yes") => ({ conditionId, tokenId, side });
const feeOk = (tokenId: string, takerRate: number, conditionId: string | null = "c", feesEnabled = true): TokenFeeScheduleResult => ({
  ok: true, tokenId, conditionId, feesEnabled, takerRate, exponent: 1, feeType: "sports_fees_v2",
  formulaVersion: TAKER_FEE_FORMULA_VERSION, source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID", observedAtIso: "2026-07-19T18:50:00.000Z", latencyMs: 1,
});
const feeFail = (tokenId: string, errorCode: string): TokenFeeScheduleResult => ({ ok: false, tokenId, errorCode, latencyMs: 1 });
const book = (tokenId: string, asks: Array<[number, number]>, extra: { minimumOrderSize?: number | null; tickSize?: number | null } = {}): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 1,
  book: { tokenId, bids: [{ price: 0.4, size: 100 }], asks: asks.map(([price, size]) => ({ price, size })), ...extra },
});
const build = (result: FetchOrderBookResult | null | undefined, fee: TokenFeeScheduleResult | null) =>
  buildExecutableSiblingColumns({ token: identity("t"), result, fee });

// ── A. ordinary $2.50 stake, hard-cap walk, honest-unknown semantics ───────────────────────────────

test("benchmark is the ORDINARY $2.50 stake at the 0.54 hard cap (never the $4 headroom)", () => {
  assert.equal(QUEUE_DEFAULT_STAKE_USD, 2.5);
  const c = build(book("t", [[0.5, 100]], { minimumOrderSize: 5 }), feeOk("t", 0.03));
  assert.equal(c.requested_stake_usd, 2.5);
  assert.equal(c.execution_price_cap, QUEUE_MAX_ENTRY_PRICE);
  assert.equal(c.executable_telemetry_version, T10_EXECUTABLE_TELEMETRY_VERSION);
});

test("EXECUTABLE: full stake fillable, min size met; VWAP, shares, depth, fee and effective cost are authoritative", () => {
  const c = build(book("t", [[0.5, 100]], { minimumOrderSize: 5 }), feeOk("t", 0.03));
  assert.equal(c.executable_full_stake, true);
  assert.equal(c.executable_full_stake_state, "EXECUTABLE");
  assert.equal(c.full_stake_executable_vwap, 0.5);
  assert.equal(c.full_stake_shares, 5);
  assert.equal(c.full_stake_worst_ask_price, 0.5);
  assert.equal(c.ask_depth_relevant_usd, 50);
  assert.equal(c.taker_fee_state, "KNOWN");
  assert.equal(c.taker_fee_rate, 0.03);
  assert.equal(c.taker_fee_usd, 0.0375); // ceil_1e-5(5 * 0.03 * 0.5 * 0.5)
  assert.equal(c.taker_effective_cost_per_share, 0.5075); // (2.5 + 0.0375) / 5
  assert.equal(c.taker_fee_formula_version, TAKER_FEE_FORMULA_VERSION);
  assert.equal(c.taker_fee_reason, null);
});

test("multi-level ladder: VWAP, worst level and per-level fee come from the same canonical walk", () => {
  const c = build(book("t", [[0.5, 2], [0.53, 50]], { minimumOrderSize: 4 }), feeOk("t", 0.03));
  const shares = 2 + 1.5 / 0.53; // 4.83 shares: above a 4-share venue minimum (it would be blocked at 5)
  assert.equal(c.executable_full_stake_state, "EXECUTABLE");
  assert.ok(Math.abs(Number(c.full_stake_shares) - Math.round(shares * 1e6) / 1e6) < 1e-9);
  assert.ok(Math.abs(Number(c.full_stake_executable_vwap) - 2.5 / shares) < 1e-6);
  assert.equal(c.full_stake_worst_ask_price, 0.53);
  assert.ok(Math.abs(Number(c.taker_fee_usd) - (Math.ceil(2 * 0.03 * 0.5 * 0.5 * 1e5) / 1e5 + Math.ceil((1.5 / 0.53) * 0.03 * 0.53 * 0.47 * 1e5 - 1e-9) / 1e5)) < 2e-5);
});

test("minimum order size: $2.50 buys fewer shares than the venue minimum -> explicit NOT_EXECUTABLE, no headroom, numbers kept", () => {
  const c = build(book("t", [[0.54, 100]], { minimumOrderSize: 5 }), feeOk("t", 0.03));
  assert.equal(c.executable_full_stake, false);
  assert.equal(c.executable_full_stake_state, "NOT_EXECUTABLE_MIN_ORDER_SIZE");
  assert.ok(Number(c.full_stake_shares) < 5, "4.6296 shares at 0.54");
  assert.equal(c.requested_stake_usd, 2.5, "the stake is NOT raised to reach the minimum");
  assert.equal(c.full_stake_executable_vwap, 0.54);
  assert.equal(c.taker_fee_state, "KNOWN");
});

test("depth: asks only above the cap, or too thin below it, is NOT_EXECUTABLE_DEPTH_AT_CAP with measured depth (0 is a measurement)", () => {
  const above = build(book("t", [[0.7, 100]], { minimumOrderSize: 5 }), feeOk("t", 0.03));
  assert.equal(above.executable_full_stake, false);
  assert.equal(above.executable_full_stake_state, "NOT_EXECUTABLE_DEPTH_AT_CAP");
  assert.equal(above.ask_depth_relevant_usd, 0);
  assert.equal(above.full_stake_executable_vwap, null);
  assert.equal(above.full_stake_shares, null);
  assert.equal(above.taker_fee_usd, null, "no fill -> no fee number");
  const thin = build(book("t", [[0.53, 2], [0.56, 100]], { minimumOrderSize: 5 }), feeOk("t", 0.03));
  assert.equal(thin.executable_full_stake_state, "NOT_EXECUTABLE_DEPTH_AT_CAP");
  assert.equal(thin.ask_depth_relevant_usd, 1.06);
  const empty = build(book("t", [], { minimumOrderSize: 5 }), feeOk("t", 0.03));
  assert.equal(empty.executable_full_stake_state, "NOT_EXECUTABLE_DEPTH_AT_CAP");
  assert.equal(empty.ask_depth_relevant_usd, 0);
});

test("unknown book: executability, depth, VWAP and shares stay NULL — never 0, never guessed", () => {
  for (const result of [
    { ok: false, tokenId: "t", latencyMs: 9, errorCode: "TIMEOUT" } as FetchOrderBookResult,
    book("other-token", [[0.5, 100]], { minimumOrderSize: 5 }), // token mismatch is not this sibling's book
    null,
    undefined,
  ]) {
    const c = build(result, feeOk("t", 0.03));
    assert.equal(c.executable_full_stake, null);
    assert.equal(c.executable_full_stake_state, "UNKNOWN_BOOK_UNAVAILABLE");
    for (const key of ["ask_depth_relevant_usd", "full_stake_executable_vwap", "full_stake_shares", "full_stake_worst_ask_price", "taker_fee_usd", "taker_effective_cost_per_share"]) {
      assert.equal(c[key], null, key);
    }
    assert.equal(c.taker_fee_state, "KNOWN", "the fee schedule is independent of the book");
  }
});

test("unknown minimum order size: fillable but undecidable -> executable NULL, never assumed satisfied", () => {
  for (const extra of [{}, { minimumOrderSize: null }, { minimumOrderSize: 0 }]) {
    const c = build(book("t", [[0.5, 100]], extra), feeOk("t", 0.03));
    assert.equal(c.executable_full_stake, null);
    assert.equal(c.executable_full_stake_state, "UNKNOWN_MIN_ORDER_SIZE");
    assert.equal(c.full_stake_executable_vwap, 0.5, "measured numbers are still recorded");
  }
});

test("fee UNKNOWN is never fee=0: typed reason, every fee-inclusive number NULL, executability unaffected", () => {
  const c = build(book("t", [[0.5, 100]], { minimumOrderSize: 5 }), feeFail("t", "FEE_MARKET_NOT_FOUND"));
  assert.equal(c.taker_fee_state, "UNKNOWN");
  assert.equal(c.taker_fee_reason, "FEE_MARKET_NOT_FOUND");
  for (const key of ["taker_fee_rate", "taker_fee_usd", "taker_effective_cost_per_share", "taker_fee_formula_version"]) assert.equal(c[key], null, key);
  assert.equal(c.executable_full_stake, true, "venue executability does not depend on the fee");
  assert.equal(c.full_stake_executable_vwap, 0.5);
  assert.equal(build(book("t", [[0.5, 100]], { minimumOrderSize: 5 }), null).taker_fee_reason, "FEE_NOT_ATTEMPTED");
});

test("provider-stated feesEnabled=false is an authoritative KNOWN zero (the only way a fee is 0)", () => {
  const c = build(book("t", [[0.5, 100]], { minimumOrderSize: 5 }), feeOk("t", 0, "c", false));
  assert.equal(c.taker_fee_state, "KNOWN");
  assert.equal(c.taker_fee_rate, 0);
  assert.equal(c.taker_fee_usd, 0);
  assert.equal(c.taker_effective_cost_per_share, 0.5);
});

test("every built and failure row carries the identical key set (homogeneous bulk upsert)", () => {
  const keys = [...T10_EXECUTABLE_TELEMETRY_KEYS].sort();
  const shapes = [
    build(book("t", [[0.5, 100]], { minimumOrderSize: 5 }), feeOk("t", 0.03)),
    build(null, null), build(book("t", [], {}), feeFail("t", "X")), executableTelemetryFailureColumns("TELEMETRY_COMPUTE_FAILED"),
  ];
  for (const shape of shapes) assert.deepEqual(Object.keys(shape).sort(), keys);
  const failed = executableTelemetryFailureColumns("TELEMETRY_MODULE_UNAVAILABLE");
  assert.equal(failed.executable_full_stake_state, "UNKNOWN_TELEMETRY_COMPUTE_FAILED");
  assert.equal(failed.executable_full_stake, null);
  assert.equal(failed.taker_fee_state, "UNKNOWN");
  assert.equal(failed.taker_fee_usd, null);
});

// ── B. bounded fee fetch ────────────────────────────────────────────────────────────────────────

test("fee schedule is fetched once per MARKET and reused for the sibling token only when conditionId matches", async () => {
  const calls: string[] = [];
  const tokens = [
    { tokenId: "a1", conditionId: "ca" }, { tokenId: "a2", conditionId: "ca" },
    { tokenId: "b1", conditionId: "cb" }, { tokenId: "b2", conditionId: "cb" },
  ];
  const out = await fetchFeeSchedulesBounded(tokens, {
    fetchFee: async (tokenId) => { calls.push(tokenId); return feeOk(tokenId, 0.03, tokenId.startsWith("a") ? "ca" : "WRONG"); },
  });
  assert.deepEqual(calls.sort(), ["a1", "b1", "b2"], "ca reused for a2; cb answered with a foreign conditionId, so b2 is fetched itself");
  assert.equal(out.size, 4);
  assert.equal(out.get("a2")?.tokenId, "a2");
  const a2 = out.get("a2");
  assert.ok(a2?.ok);
  assert.equal(a2.conditionId, "ca");
});

test("a failed market lookup is carried to its sibling with the same typed reason, not retried; a throwing fetcher never rejects", async () => {
  let calls = 0;
  const out = await fetchFeeSchedulesBounded([{ tokenId: "a1", conditionId: "ca" }, { tokenId: "a2", conditionId: "ca" }], {
    fetchFee: async () => { calls++; throw new Error("boom"); },
  });
  assert.equal(calls, 1, "an unhealthy provider is asked once per market");
  assert.deepEqual([...out.values()].map((v) => v.ok || v.errorCode), ["FEE_FETCH_THREW", "FEE_FETCH_THREW"]);
  assert.deepEqual([...out.values()].map((v) => v.tokenId), ["a1", "a2"]);
});

test("a total wall-clock budget bounds live latency: unreached markets are typed FEE_BUDGET_EXCEEDED", async () => {
  let clock = 0;
  const calls: string[] = [];
  const tokens = ["a", "b", "c", "d"].map((c) => ({ tokenId: `${c}1`, conditionId: c }));
  const out = await fetchFeeSchedulesBounded(tokens, {
    concurrency: 1, totalBudgetMs: 1_000, nowMs: () => clock,
    fetchFee: async (tokenId, o) => { calls.push(tokenId); assert.ok(o.timeoutMs <= 1_000); clock += 600; return feeOk(tokenId, 0.03, tokenId[0]); },
  });
  assert.deepEqual(calls, ["a1", "b1"]);
  assert.deepEqual([...out.entries()].map(([k, v]) => [k, v.ok || v.errorCode]), [["a1", true], ["b1", true], ["c1", "FEE_BUDGET_EXCEEDED"], ["d1", "FEE_BUDGET_EXCEEDED"]]);
  assert.ok(FEE_FETCH_TOTAL_BUDGET_MS <= 5_000);
});

// ── C. T30 is NOT a telemetry input (T30_MONEY_GATE_REMOVAL_V1) ───────────────────────────────

test("NO T30 AUTHORITY: no T30-derived column or input exists; executability depends on the CURRENT T10 book only", () => {
  const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const moduleCode = stripComments(readFileSync("lib/executor/t10ExecutableSiblingTelemetry.ts", "utf8"));
  assert.doesNotMatch(moduleCode, /t30|P_BUY_MAX|pBuyMax|p_buy_max/i, "the telemetry module reads and computes nothing T30-derived");
  assert.equal((T10_EXECUTABLE_TELEMETRY_KEYS as readonly string[]).some((key) => /buy_max|t30/i.test(key)), false);
  const migration = readFileSync("supabase/migrations/20261005090000_t10_executable_sibling_telemetry_v1.sql", "utf8");
  assert.doesNotMatch(migration.replace(/--.*$/gm, ""), /buy_max|t30/i, "the migration adds no T30-derived column");
  const c = build(book("t", [[0.5, 100]], { minimumOrderSize: 5 }), feeOk("t", 0.03));
  assert.equal(c.executable_full_stake, true, "the same CURRENT book yields the same verdict with no T30 input of any kind");
  assert.deepEqual(Object.keys(c).sort(), [...T10_EXECUTABLE_TELEMETRY_KEYS].sort());
});

// ── D. full path: Reservation -> T10 capture -> ALL supported siblings ───────────────────

const FEE_BY_CONDITION: Record<string, TokenFeeScheduleResult | ((t: string) => TokenFeeScheduleResult)> = {
  "c-ml": (t) => feeOk(t, 0.03, "c-ml"),
  "c-sp": (t) => feeFail(t, "FEE_HTTP_500"),
  "c-tot": (t) => feeOk(t, 0.03, "c-tot"),
  "c-tc": (t) => feeOk(t, 0, "c-tc", false),
};
const CONDITION_OF: Record<string, string> = {
  "t-ml-home": "c-ml", "t-ml-away": "c-ml", "t-sp-a": "c-sp", "t-sp-b": "c-sp",
  "t-tot-over": "c-tot", "t-tot-under": "c-tot", "t-tc-yes": "c-tc", "t-tc-no": "c-tc",
};
const T10_BOOKS: Record<string, FetchOrderBookResult> = {
  "t-ml-home": book("t-ml-home", [[0.5, 100]], { minimumOrderSize: 5, tickSize: 0.01 }), // EXECUTABLE
  "t-ml-away": book("t-ml-away", [[0.3, 100]], { minimumOrderSize: 5, tickSize: 0.01 }), // EXECUTABLE
  "t-sp-a": book("t-sp-a", [[0.54, 100]], { minimumOrderSize: 5, tickSize: 0.01 }), // min-size blocked
  "t-sp-b": book("t-sp-b", [[0.7, 100]], { minimumOrderSize: 5, tickSize: 0.01 }), // above cap
  "t-tot-over": book("t-tot-over", [[0.53, 2], [0.56, 100]], { minimumOrderSize: 5, tickSize: 0.01 }), // thin under the 0.555 cap
  "t-tot-under": { ok: false, tokenId: "t-tot-under", latencyMs: 5, errorCode: "TIMEOUT" }, // book failed
  "t-tc-yes": book("t-tc-yes", [[0.45, 2], [0.5, 50]], { tickSize: 0.01 }), // min size unknown
  // EXECUTABLE, feesEnabled=false. NB: at $2.50 a 5-share minimum is only met at a VWAP <= 0.50 (2.50 / 0.52 = 4.81 shares).
  "t-tc-no": book("t-tc-no", [[0.45, 100]], { minimumOrderSize: 5, tickSize: 0.01 }),
};

async function captureT10(deps: Partial<Parameters<typeof captureReservationMarketObservation>[2]> & { phase?: ReservationMarketPhase } = {}) {
  const { phase = "T_MINUS_10", ...rest } = deps;
  const snapshot: { run: Row; rows: Row[]; strategies: Row[] } = { run: {}, rows: [], strategies: [] };
  await captureReservationMarketObservation(fixtureReservation(), phase, {
    observedAt: new Date(Date.parse(FIXTURE_START_ISO) - 10 * 60_000).toISOString(),
    alreadyCaptured: async () => false,
    readExactEvent: async () => ownEventMarkets(), readGameEvents: async () => siblingEventMarkets(),
    fetchBooks: async (ids) => ids.map((id) => T10_BOOKS[id]),
    write: async (run, rows, strategies = []) => { snapshot.run = run; snapshot.rows = rows; snapshot.strategies = strategies; },
    ...rest,
  });
  return snapshot;
}

test("FULL PATH: every supported T10 sibling gets exactly one telemetry row with ordinary-$2.50 evidence or a typed reason", async () => {
  const feeCalls: string[] = [];
  const snap = await captureT10({
    fetchFeeSchedule: async (tokenId) => {
      feeCalls.push(tokenId);
      const entry = FEE_BY_CONDITION[CONDITION_OF[tokenId]];
      return typeof entry === "function" ? entry(tokenId) : entry;
    },
  });
  assert.equal(snap.run.capture_status, "COMPLETE");
  assert.equal(snap.run.capture_complete, true);
  assert.equal(snap.run.market_tokens_expected_n, 8, "supported siblings: 4 supported markets x 2 tokens of ONE physical event");
  assert.equal(snap.rows.length, 8);
  assert.equal(feeCalls.length, 4, "one fee schedule per market, not per token");

  const byToken = new Map(snap.rows.map((r) => [String(r.token_id), r]));
  const expected: Record<string, [state: string, executable: boolean | null, feeState: string]> = {
    "t-ml-home": ["EXECUTABLE", true, "KNOWN"],
    "t-ml-away": ["EXECUTABLE", true, "KNOWN"],
    "t-sp-a": ["NOT_EXECUTABLE_MIN_ORDER_SIZE", false, "UNKNOWN"],
    "t-sp-b": ["NOT_EXECUTABLE_DEPTH_AT_CAP", false, "UNKNOWN"],
    "t-tot-over": ["NOT_EXECUTABLE_DEPTH_AT_CAP", false, "KNOWN"],
    "t-tot-under": ["UNKNOWN_BOOK_UNAVAILABLE", null, "KNOWN"],
    "t-tc-yes": ["UNKNOWN_MIN_ORDER_SIZE", null, "KNOWN"],
    "t-tc-no": ["EXECUTABLE", true, "KNOWN"],
  };
  for (const [token, [state, executable, feeState]] of Object.entries(expected)) {
    const row = byToken.get(token);
    assert.ok(row, `${token} must not be silently dropped`);
    assert.equal(row.executable_telemetry_version, T10_EXECUTABLE_TELEMETRY_VERSION, token);
    assert.equal(row.executable_full_stake_state, state, token);
    assert.equal(row.executable_full_stake, executable, token);
    assert.equal(row.taker_fee_state, feeState, token);
    assert.equal(row.requested_stake_usd, 2.5, token);
    assert.equal(row.execution_price_cap, 0.555, token);
    // exact lineage + support family/type + timestamp are the existing canonical columns of the same row
    for (const key of ["capture_run_id", "reservation_id", "physical_event_id", "condition_id", "token_id", "side", "canonical_market_family", "canonical_market_type", "observed_at"]) {
      assert.ok(row[key], `${token}.${key}`);
    }
    assert.equal(row.physical_event_id, FIXTURE_PHYSICAL_ID);
  }
  // measured values the aggregates rest on
  assert.equal(byToken.get("t-ml-home")?.taker_effective_cost_per_share, 0.5075);
  assert.equal(byToken.get("t-tc-no")?.taker_fee_usd, 0, "provider-stated feesEnabled=false");
  assert.equal(byToken.get("t-sp-a")?.taker_fee_reason, "FEE_HTTP_500");
  assert.equal(byToken.get("t-sp-a")?.taker_fee_usd, null);
  assert.equal(byToken.get("t-tot-under")?.ask_depth_relevant_usd, null);
  assert.equal(byToken.get("t-tot-over")?.ask_depth_relevant_usd, 1.06);
  assert.equal(byToken.get("t-tc-yes")?.full_stake_worst_ask_price, 0.5);
  // the book-derived columns of the same row are untouched
  assert.equal(byToken.get("t-ml-home")?.best_ask, 0.5);
  assert.equal(byToken.get("t-tot-under")?.orderbook_fetch_status, "FAILED");

  const summary = summarizeExecutableSiblingTelemetry(snap.rows as never, Number(snap.run.market_tokens_expected_n));
  assert.deepEqual(summary, {
    supported_siblings_n: 8,
    telemetry_rows_n: 8,
    orderbook_success_n: 7,
    full_stake_executable_n: 3,
    minimum_size_blocked_n: 1,
    depth_blocked_n: 2,
    unknown_compute_n: 2,
    fee_known_n: 6,
    fee_unknown_n: 2,
    state_counts: {
      EXECUTABLE: 3, NOT_EXECUTABLE_MIN_ORDER_SIZE: 1, NOT_EXECUTABLE_DEPTH_AT_CAP: 2, UNKNOWN_BOOK_UNAVAILABLE: 1, UNKNOWN_MIN_ORDER_SIZE: 1,
    },
    physical_events_n: 1,
    physical_events_with_executable_sibling_n: 1,
    physical_events_with_min_size_blocked_sibling_n: 1,
    physical_events_all_fee_known_n: 0,
    coverage_complete: true,
  });
  assert.equal(summary.telemetry_rows_n, summary.supported_siblings_n);
});

test("coverage proof is not self-fulfilling: a missing sibling row makes coverage incomplete", async () => {
  const snap = await captureT10({ fetchFeeSchedule: async (t) => feeFail(t, "FEE_TEST_OFFLINE") });
  const dropped = snap.rows.slice(1);
  const summary = summarizeExecutableSiblingTelemetry(dropped as never, Number(snap.run.market_tokens_expected_n));
  assert.equal(summary.telemetry_rows_n, 7);
  assert.equal(summary.coverage_complete, false);
  const untelemetered = summarizeExecutableSiblingTelemetry(snap.rows.map((r) => ({ ...r, executable_telemetry_version: null })) as never, 8);
  assert.equal(untelemetered.coverage_complete, false, "historical rows without the version never count as telemetry");
});

test("FAILURE ISOLATION: a dead fee API never fails or alter the capture; every sibling is typed UNKNOWN", async () => {
  const healthy = await captureT10({ fetchFeeSchedule: async (t) => feeFail(t, "FEE_TEST_OFFLINE") });
  const broken = await captureT10({ fetchFeeSchedule: async () => { throw new Error("gamma down"); } });
  for (const field of ["capture_status", "capture_complete", "market_tokens_expected_n", "market_tokens_observed_n", "orderbooks_success_n", "orderbooks_failed_n", "failure_reason"]) {
    assert.deepEqual(broken.run[field], healthy.run[field], field);
  }
  assert.equal(broken.run.capture_status, "COMPLETE");
  assert.equal(broken.rows.length, 8);
  for (const row of broken.rows) {
    assert.equal(row.taker_fee_state, "UNKNOWN");
    assert.equal(row.taker_fee_reason, "FEE_FETCH_THREW");
    assert.equal(row.taker_fee_usd, null);
  }
  // a synchronous throw from an injected reader is isolated as well
  const syncThrow = await captureT10({ fetchFeeSchedule: (() => { throw new Error("sync"); }) as never });
  assert.equal(syncThrow.run.capture_status, "COMPLETE");
  assert.equal(syncThrow.rows.length, 8);
});

test("T30 PASSIVE: T_MINUS_30 rows carry book-only executable scalars; fee is typed UNKNOWN; zero fee fetches, zero extra book fetches, zero extra rows", async () => {
  let feeFetches = 0;
  let bookFetches = 0;
  const snap = await captureT10({
    phase: "T_MINUS_30",
    fetchFeeSchedule: async (t) => { feeFetches++; return feeFail(t, "X"); },
    fetchBooks: async (ids) => { bookFetches++; return ids.map((id) => T10_BOOKS[id]); },
  });
  assert.equal(feeFetches, 0, "no fee request on T30");
  assert.equal(bookFetches, 1, "exactly the one existing bulk book fetch");
  assert.equal(snap.rows.length, 8, "no extra rows: one row per supported token");
  assert.equal(snap.strategies.length, 24, "no extra strategy rows (3 NOT_EVALUATED placeholders per token)");
  assert.equal(T30_PASSIVE_EXECUTABLE_TELEMETRY_VERSION, "T30_PASSIVE_EXECUTABLE_BOOK_V1");
  assert.notEqual(T30_PASSIVE_EXECUTABLE_TELEMETRY_VERSION, T10_EXECUTABLE_TELEMETRY_VERSION);
  const byToken = new Map(snap.rows.map((r) => [String(r.token_id), r]));
  for (const row of snap.rows) {
    for (const key of T10_EXECUTABLE_TELEMETRY_KEYS) assert.equal(key in row, true, `${key} present (homogeneous key set)`);
    assert.equal(row.executable_telemetry_version, T30_PASSIVE_EXECUTABLE_TELEMETRY_VERSION);
    assert.equal(row.requested_stake_usd, QUEUE_DEFAULT_STAKE_USD);
    assert.equal(row.execution_price_cap, QUEUE_MAX_ENTRY_PRICE);
    assert.equal(row.taker_fee_state, "UNKNOWN");
    assert.equal(row.taker_fee_reason, "FEE_NOT_ATTEMPTED_PASSIVE_RESEARCH");
    for (const k of ["taker_fee_rate", "taker_fee_usd", "taker_effective_cost_per_share", "taker_fee_formula_version"]) assert.equal(row[k], null, k);
  }
  // exact requested stake: 2.5 / 0.5 = 5 shares at VWAP 0.5, from the already-fetched book
  const home = byToken.get("t-ml-home")!;
  assert.equal(home.executable_full_stake, true);
  assert.equal(home.executable_full_stake_state, "EXECUTABLE");
  assert.equal(home.full_stake_executable_vwap, 0.5);
  assert.equal(home.full_stake_shares, 5);
  assert.equal(home.full_stake_worst_ask_price, 0.5);
  assert.equal(home.ask_depth_relevant_usd, 50);
  // insufficient depth: executable=false, never a fabricated VWAP
  const thin = byToken.get("t-tot-over")!;
  assert.equal(thin.executable_full_stake, false);
  assert.equal(thin.executable_full_stake_state, "NOT_EXECUTABLE_DEPTH_AT_CAP");
  assert.equal(thin.full_stake_executable_vwap, null);
  assert.equal(thin.full_stake_shares, null);
  // failed book: typed unknown, still NULL numbers
  const failed = byToken.get("t-tot-under")!;
  assert.equal(failed.executable_full_stake_state, "UNKNOWN_BOOK_UNAVAILABLE");
  assert.equal(failed.executable_full_stake, null);
  assert.equal(failed.full_stake_executable_vwap, null);
});

test("T30 PASSIVE: T10 stays fee-inclusive V1 and unchanged; no T_MINUS_3 phase is classified", async () => {
  const t10 = await captureT10({ fetchFeeSchedule: async (t) => feeOk(t, 0.03, CONDITION_OF[t]) });
  const home = t10.rows.find((r) => r.token_id === "t-ml-home")!;
  assert.equal(home.executable_telemetry_version, T10_EXECUTABLE_TELEMETRY_VERSION);
  assert.equal(home.taker_fee_state, "KNOWN");
  assert.equal(home.taker_fee_usd, 0.0375);
  assert.equal(home.taker_effective_cost_per_share, 0.5075);
  const start = Date.parse(FIXTURE_START_ISO);
  for (const m of [3, 5, 8]) assert.equal(classifyReservationMarketPhase(FIXTURE_START_ISO, start - m * 60_000), null);
  assert.equal(classifyReservationMarketPhase(FIXTURE_START_ISO, start - 30 * 60_000), "T_MINUS_30");
  assert.equal(classifyReservationMarketPhase(FIXTURE_START_ISO, start - 10 * 60_000), "T_MINUS_10");
});

test("NO MONEY-PATH CHANGE: telemetry columns cannot influence the A/B selection or the persisted universe", async () => {
  const snap = await captureT10({ fetchFeeSchedule: async (t) => feeOk(t, 0.03, CONDITION_OF[t]) });
  const stripped = snap.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !(T10_EXECUTABLE_TELEMETRY_KEYS as readonly string[]).includes(k) || k === "ask_depth_relevant_usd")));
  const reservation = fixtureReservation();
  const withTelemetry = selectReservationT3AbDecisions(reservation, universeFromRows(snap.rows));
  const withoutTelemetry = selectReservationT3AbDecisions(reservation, universeFromRows(stripped));
  assert.deepEqual(withTelemetry, withoutTelemetry);
  // the pre-existing columns the live T10 universe reader selects are byte-identical in meaning
  const t30Like = await captureT10({ phase: "T_MINUS_30" });
  for (const [a, b] of snap.rows.map((r, i) => [r, t30Like.rows[i]] as const)) {
    for (const key of ["condition_id", "token_id", "side", "canonical_market_family", "canonical_market_type", "best_bid", "best_ask", "ask_decimal_odds", "orderbook_fetch_status", "spread_abs"]) {
      assert.deepEqual(a[key], b[key], key);
    }
  }
});

test("strategy rows stay NOT_EVALUATED; S1 simply mirrors the measured ask depth the row now carries", async () => {
  const snap = await captureT10({ fetchFeeSchedule: async (t) => feeFail(t, "X") });
  const strategies = strategyRowsForMarketObservations(snap.rows);
  assert.deepEqual([...new Set(strategies.map((s) => s.evaluation_state))], ["NOT_EVALUATED"]);
  assert.equal(snap.strategies.length, 24);
  const s1 = snap.strategies.filter((s) => s.strategy_variant === "S1_TAKER_HOLD");
  const home = snap.rows.find((r) => r.token_id === "t-ml-home");
  assert.equal(s1.find((s) => s.market_observation_id === home?.id)?.executable_depth_usd, 50);
});

test("HARD DEADLINE: a hung fee API cannot stall the capture; every sibling is typed UNKNOWN", async () => {
  const started = Date.now();
  const snap = await captureT10({
    telemetryDeadlineMs: { fee: 40 },
    fetchFeeSchedule: () => new Promise(() => {}),
  });
  assert.ok(Date.now() - started < 3_000, "capture returned on the deadline, not on the hung dependency");
  assert.equal(snap.run.capture_status, "COMPLETE");
  assert.equal(snap.rows.length, 8);
  for (const row of snap.rows) {
    assert.equal(row.taker_fee_state, "UNKNOWN");
    assert.equal(row.taker_fee_reason, "FEE_LEG_UNAVAILABLE");
    assert.equal(row.executable_telemetry_version, T10_EXECUTABLE_TELEMETRY_VERSION);
  }
  assert.ok(snap.rows.some((r) => r.executable_full_stake === true), "book-derived evidence is unaffected by the dead legs");
});

// ── D2. schema-not-migrated safety net (telemetry must never take the live T10 source down) ─────────

test("isMissingTelemetryColumnError matches ONLY a missing-column error that names a NEW telemetry column", () => {
  const msg = (column: string) => `Could not find the '${column}' column of 'reservation_market_observations' in the schema cache`;
  assert.equal(isMissingTelemetryColumnError({ code: "PGRST204", message: msg("executable_telemetry_version") }), true);
  assert.equal(isMissingTelemetryColumnError({ code: "42703", message: 'column "taker_fee_usd" of relation "reservation_market_observations" does not exist' }), true);
  assert.equal(isMissingTelemetryColumnError({ code: "PGRST204", message: msg("best_bid") }), false, "a missing PRE-EXISTING column is a real defect, not a migration gap");
  assert.equal(isMissingTelemetryColumnError({ code: "PGRST204", message: msg("requested_stake_usd") }), false, "reused columns already exist");
  assert.equal(isMissingTelemetryColumnError({ code: "23505", message: "executable_telemetry_version duplicate" }), false);
  assert.equal(isMissingTelemetryColumnError({ code: "PGRST204" }), false);
  assert.equal(isMissingTelemetryColumnError(null), false);
  assert.equal(T10_EXECUTABLE_TELEMETRY_NEW_COLUMNS.length, 11);
  const stripped = withoutNewTelemetryColumns({ id: "x", best_bid: 0.4, requested_stake_usd: 2.5, executable_full_stake: true, taker_fee_usd: 0.1 });
  assert.deepEqual(stripped, { id: "x", best_bid: 0.4, requested_stake_usd: 2.5 });
});

type WriteLog = { table: string; rows: Row[]; accepted: boolean };
function fakeWriterClient(opts: { failWith?: { code: string; message: string } }) {
  const writes: WriteLog[] = [];
  let finalized = 0;
  const chain = (data: Row[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "gt", "order"]) c[m] = () => c;
    c.limit = () => Promise.resolve({ data, error: null });
    return c;
  };
  const client = {
    from(table: string) {
      return {
        upsert(rows: Row | Row[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          const hasNew = list.some((r) => "executable_telemetry_version" in r);
          const reject = table === "reservation_market_observations" && hasNew && opts.failWith;
          writes.push({ table, rows: list, accepted: !reject });
          return Promise.resolve({ error: reject ? opts.failWith : null });
        },
        select() {
          return chain(writes.filter((w) => w.table === "reservation_market_observations" && w.accepted).flatMap((w) => w.rows));
        },
        update() {
          const c: Record<string, unknown> = {};
          c.eq = () => c;
          c.then = (resolve: (v: unknown) => unknown) => { finalized++; return resolve({ error: null }); };
          return c;
        },
      };
    },
  };
  return { client, writes, finalized: () => finalized };
}

async function captureThroughDefaultWriter(fake: ReturnType<typeof fakeWriterClient>) {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    await captureReservationMarketObservation(fixtureReservation(), "T_MINUS_10", {
      observedAt: new Date(Date.parse(FIXTURE_START_ISO) - 10 * 60_000).toISOString(),
      alreadyCaptured: async () => false,
      readExactEvent: async () => ownEventMarkets(), readGameEvents: async () => siblingEventMarkets(),
      fetchBooks: async (ids) => ids.map((id) => T10_BOOKS[id]),
      fetchFeeSchedule: async (t) => feeFail(t, "FEE_TEST_OFFLINE"),
      getClient: (async () => fake.client) as never,
    });
  } finally { console.error = original; }
  return logged;
}

test("DEPLOY-ORDER SAFETY: an un-migrated schema still writes every sibling row (without the 11 new columns) and finalizes the run", async () => {
  const fake = fakeWriterClient({ failWith: { code: "PGRST204", message: "Could not find the 'executable_telemetry_version' column of 'reservation_market_observations' in the schema cache" } });
  const logged = await captureThroughDefaultWriter(fake);
  const attempts = fake.writes.filter((w) => w.table === "reservation_market_observations");
  assert.deepEqual(attempts.map((a) => a.accepted), [false, true], "first attempt rejected by the old schema, second (stripped) accepted");
  assert.equal(attempts[1].rows.length, 8, "no sibling is dropped");
  for (const row of attempts[1].rows) {
    for (const column of T10_EXECUTABLE_TELEMETRY_NEW_COLUMNS) assert.equal(column in row, false, `${column} stripped`);
    assert.equal(row.requested_stake_usd, 2.5, "pre-existing reused columns are kept");
    assert.ok(row.best_ask !== undefined && row.condition_id && row.token_id, "the live T10 universe columns are intact");
  }
  assert.equal(fake.finalized(), 1, "the run is finalized, so the live T10 source stays readable");
  assert.ok(fake.writes.some((w) => w.table === "reservation_strategy_observations"), "strategy rows still written");
  assert.ok(logged.some((line) => line.includes("T10_TELEMETRY_COLUMNS_UNAVAILABLE")), "the gap is loud, never silent");
  const gap = summarizeExecutableSiblingTelemetry(attempts[1].rows as never, 8);
  assert.equal(gap.telemetry_rows_n, 0);
  assert.equal(gap.coverage_complete, false, "the gap is measurable in the denominator proof");
});

test("a migrated schema writes the telemetry columns in ONE attempt and logs nothing", async () => {
  const fake = fakeWriterClient({});
  const logged = await captureThroughDefaultWriter(fake);
  const attempts = fake.writes.filter((w) => w.table === "reservation_market_observations");
  assert.deepEqual(attempts.map((a) => a.accepted), [true]);
  assert.ok(attempts[0].rows.every((r) => r.executable_telemetry_version === T10_EXECUTABLE_TELEMETRY_VERSION));
  assert.deepEqual(logged, []);
});

test("any OTHER observation write error still fails the capture (the safety net is not a catch-all)", async () => {
  for (const failWith of [
    { code: "PGRST204", message: "Could not find the 'best_bid' column of 'reservation_market_observations' in the schema cache" },
    { code: "23505", message: "duplicate key value violates unique constraint" },
  ]) {
    const fake = fakeWriterClient({ failWith });
    await assert.rejects(captureThroughDefaultWriter(fake), /BASELINE_OBSERVATION_WRITE_FAILED/);
    assert.equal(fake.writes.filter((w) => w.table === "reservation_market_observations").length, 1, "no stripped retry for a non-migration error");
    assert.equal(fake.finalized(), 0);
  }
});

// ── E. schema / durability companions ──────────────────────────────────────────────────────────

const REUSED_EXISTING_COLUMNS = ["requested_stake_usd", "execution_price_cap", "ask_depth_relevant_usd", "full_stake_executable_vwap"];
const NEW_COLUMNS = (T10_EXECUTABLE_TELEMETRY_KEYS as readonly string[]).filter((k) => !REUSED_EXISTING_COLUMNS.includes(k));

test("migration is additive-only, adds exactly the new columns, and passes the release pipeline's own SQL guard", async () => {
  const file = "supabase/migrations/20261005090000_t10_executable_sibling_telemetry_v1.sql";
  const sql = readFileSync(file, "utf8");
  for (const column of NEW_COLUMNS) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `), column);
  for (const column of REUSED_EXISTING_COLUMNS) assert.doesNotMatch(sql, new RegExp(`ADD COLUMN[^;]*${column} `), `${column} already exists and is reused`);
  assert.doesNotMatch(sql, /CREATE TABLE|DROP |UPDATE |DELETE |TRUNCATE|CHECK\s*\(/i, "no new table, no destructive SQL, no CHECK that could fail the capture write");
  const release = await import("../../scripts/control-plane/lib/premvp-application-migration-release.mjs");
  assert.equal(release.readAndValidateMigration(process.cwd(), {
    mode: release.MIGRATION_MODE, migration_files: [file], safety_class: "ADDITIVE_COMPATIBLE",
    direct_raw_mutation: false, rollback_strategy: "COMPATIBILITY_RETAINED",
  }), file);
});
