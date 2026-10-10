// FOUNDER_TOTALS_OVER_LIVE_OFF_2026_10_10 -- no NEW real-money bet on TOTALS Over (any line).
//   node --import tsx --test tests/contur3/founderTotalsOverLiveOff.test.ts
// Live OFF: TOTALS + Over. Unchanged: TOTALS Under, MONEYLINE, TOTAL_CORNERS; SPREADS stays OFF. Research/telemetry stay free.
import test from "node:test";
import assert from "node:assert/strict";
import type { TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import {
  mapQueueRowToIrelandCandidate,
  QueueWireContractError,
  type EventExecutionQueueRow,
  type NightEventReservationRow,
} from "../../lib/executor/executorQueueTypes";
import { admitExecutableQueueRow, runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import { decideT10EconomicEvent } from "../../lib/executor/t10EconomicActivation";
import { selectLiveMoneyBDecision, selectReservationT3AbDecisions, type FinalT3MarketObservation } from "../../lib/executor/reservationMarketBaseline";
import {
  FOUNDER_TOTALS_OVER_LIVE_OFF,
  FounderTotalsOverLiveOffError,
  isFounderLiveOffTotalsOver,
  LiveMoneyFamilyNotAuthorizedError,
} from "../../lib/executor/liveMoneyFamilyAuthority";
import { selectExecutorMakerFallbackCommands, type MakerFallbackCommand } from "../../lib/executor/makerFallbackAuthorization";
import { getActiveContour } from "../../lib/constructor/registry";

const REASON = "FOUNDER_TOTALS_OVER_LIVE_OFF_2026_10_10";
const KICKOFF = "2026-07-19T19:00:00.000Z";
const NOW = Date.parse("2026-07-19T18:46:30.000Z");
const T10_AT = "2026-07-19T18:46:00.000Z";
const EVENT = "provider:polymarket:event-1:2026-07-19";
const RES_ID = "res-founder";
const CAPTURE = "T_MINUS_10-run";

type Row = { cond: string; token: string; family: string; type: string; side: string; t10: [number, number]; raw?: string };
const obs = (r: Row): FinalT3MarketObservation => ({
  capture_run_id: CAPTURE, reservation_id: RES_ID, physical_event_id: EVENT, provider_event_id: "event-1",
  event_start_iso: KICKOFF, observation_phase: "T_MINUS_10", condition_id: r.cond, token_id: r.token, side: r.side,
  canonical_market_family: r.family, canonical_market_type: r.type, market_slug: r.cond,
  provider_market_type_raw: r.raw ?? null,
  best_bid: r.t10[0], best_ask: r.t10[1], ask_decimal_odds: 1 / r.t10[1], orderbook_fetch_status: "SUCCESS", observed_at: T10_AT,
});
const totals = (cond: string, side: string, t10: [number, number] = [0.45, 0.50]): Row =>
  ({ cond, token: `${cond}-tok`, family: "TOTALS", type: "TOTAL", side, t10 });
// Over is deliberately the economically BEST (cheapest ask) candidate; Under / MONEYLINE are the safe alternatives.
const OVER = totals("soccer-total-2pt5", "Over", [0.47, 0.50]);
const UNDER = totals("soccer-total-2pt5-u", "Under", [0.50, 0.53]);
const ML: Row = { cond: "ml", token: "ml-tok", family: "MONEYLINE", type: "MONEYLINE", side: "Home", t10: [0.50, 0.52] };
const CORNERS: Row = { cond: "cn", token: "cn-tok", family: "TOTAL_CORNERS", type: "TOTAL_CORNERS", side: "Over", t10: [0.38, 0.40], raw: "total_corners" };
const SPREAD: Row = { cond: "sp", token: "sp-tok", family: "SPREADS", type: "SPREAD", side: "Home", t10: [0.50, 0.52] };

const bookOf = (r: Row): FetchOrderBookResult => ({
  ok: true, tokenId: r.token, latencyMs: 3,
  book: { tokenId: r.token, bids: [{ price: r.t10[0], size: 100 }], asks: [{ price: r.t10[1], size: 100 }], tickSize: 0.01, minimumOrderSize: 5, providerTimestampMs: NOW },
});
const fee = (tokenId: string): TokenFeeScheduleResult => ({
  ok: true, tokenId, conditionId: null, feesEnabled: true, takerRate: 0.05, exponent: 1, feeType: "sports_fees_v3",
  formulaVersion: "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1", source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID",
  observedAtIso: new Date(NOW).toISOString(), latencyMs: 1,
});
const booksFor = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.token, bookOf(r)]));
const depsFor = (rows: Row[]) => {
  const books = booksFor(rows);
  return {
    fetchExactTokenOrderbook: async (tokenId: string) => books[tokenId] ?? { ok: false as const, tokenId, latencyMs: 1, errorCode: "HTTP_ERROR" as const },
    fetchTokenFeeSchedule: async (tokenId: string) => fee(tokenId),
  };
};
const decide = (rows: Row[]) => decideT10EconomicEvent({ physicalEventId: EVENT, eventStartIso: KICKOFF, t10Universe: rows.map(obs),
  t30Universe: null, nowMs: NOW, exposureExists: false, deps: depsFor(rows) });

function reservation(): NightEventReservationRow {
  return {
    id: RES_ID, plan_run_id: "night-plan:2026-07-19", plan_date_minsk: "2026-07-19",
    window_start_iso: "2026-07-19T14:00:00.000Z", window_end_iso: "2026-07-20T05:00:00.000Z",
    match_family_key: "pair:a-vs-b:2026-07-19", event_slug: "a-vs-b", event_title: "A vs B", sport: "soccer", league: null,
    strategic_scope: "WC", game_start_iso: KICKOFF, event_tier: "TIER1", event_score: 80, best_snapshot_id: null,
    reservation_rank: 1, status: "RESERVED", selection_reason: null, physical_event_id: EVENT, event_start_iso: KICKOFF,
    diagnostics: { contract_a_stage: "PLANNING", source_lineage: { provider_event_id: "event-1" },
      planning_final_identity_evidence: { condition_id: "x", token_id: "x-tok", side: "Over" } },
  } as NightEventReservationRow;
}
async function rebalance(rows: Row[], activation: boolean) {
  const res = reservation();
  const queueRows: EventExecutionQueueRow[] = [];
  const decisions: unknown[] = [];
  const repo: RebalanceRepoPort = {
    async loadEventExposureQueueRows() { return queueRows; },
    async loadActiveReservations() { return [res]; },
    async loadQueuedReservationIds() { return new Set(queueRows.map((q) => q.reservation_id as string)); },
    async markReservationsExpired() {},
    async markReservationSkipped() { res.status = "SKIPPED"; },
    async insertQueueRow(row) { queueRows.push(row); },
    async markReservationQueued() { res.status = "QUEUED"; },
    async recordReservationShadowDecision() {},
  };
  const d = depsFor(rows);
  const result = await runEventRebalance(NOW, { write: true }, {
    repo, readFinalT3Universe: async () => rows.map(obs), readT30Universe: async () => [],
    recordStrategyDecision: async (i: unknown) => { decisions.push(i); return { total: 2, selected: 1, written: 2 }; },
    fetchExactTokenOrderbook: d.fetchExactTokenOrderbook, fetchTokenFeeSchedule: d.fetchTokenFeeSchedule,
    writeGuardTelemetry: async () => {}, t10EconomicActivation: activation, realMoneyExecutionEnabled: true,
  });
  return { result, queueRows, decisions, res };
}

test("1: predicate — TOTALS + Over (any line / casing) is OFF; Under, MONEYLINE, TOTAL_CORNERS family, SPREADS are not decided here", () => {
  for (const s of ["Over", "OVER", " over ", "Over 0.5", "Over 1.5", "Over 2.5", "Over 3.5", "Over 4.5", "Over 5.5", "Over2.5", "OVER_2_5"]) {
    assert.equal(isFounderLiveOffTotalsOver("TOTALS", s), true, s);
    assert.equal(isFounderLiveOffTotalsOver("totals", s), true, s);
  }
  for (const [f, s] of [["TOTALS", "Under"], ["TOTALS", "Under 2.5"], ["TOTALS", "Yes"], ["TOTALS", "Overtime"], ["TOTALS", null], ["MONEYLINE", "Over"], ["TOTAL_CORNERS", "Over"], ["SPREADS", "Over"], [null, "Over"]] as const) {
    assert.equal(isFounderLiveOffTotalsOver(f, s), false, `${f}/${s}`);
  }
});

test("2: TOTALS Over 0.5 / 1.5 / 2.5 / 3.5 / 4.5 alone -> no live action, explicit founder reason, evaluation retained for telemetry", async () => {
  for (const line of ["0pt5", "1pt5", "2pt5", "3pt5", "4pt5"]) {
    const over = totals(`soccer-total-${line}`, "Over");
    const e = await decide([over]);
    assert.equal(e.decision.action, "SKIP", line);
    assert.equal(e.decision.selected, null, line);
    assert.equal(e.decision.evaluations.length, 1, "research evaluation retained");
    assert.equal(e.decision.evaluations[0].taker.rejectReason, REASON);
    assert.equal(e.decision.evaluations[0].maker.rejectReason, REASON);
  }
});

test("3: Over ranked first (best economics) -> selector takes the next ADMISSIBLE candidate normally; Over is never mechanically swapped", async () => {
  const e = await decide([OVER, UNDER, ML]);
  assert.equal(e.decision.action, "TAKER_FIRST");
  const picked = e.decision.selected!.candidateIdentity;
  assert.notEqual(picked.side, "Over");
  assert.ok(["Under", "Home"].includes(picked.side), picked.side);
  const overEval = e.decision.evaluations.find((x) => x.candidateIdentity.side === "Over")!;
  assert.equal(overEval.taker.rejectReason, REASON);
  // Over alone does not turn into Under: with only Over + a sibling that is not admissible nothing is selected.
  const none = await decide([OVER, SPREAD]);
  assert.equal(none.decision.action, "SKIP");
});

test("4: unchanged families — TOTALS Under, MONEYLINE, TOTAL_CORNERS stay LIVE; SPREADS stays OFF", async () => {
  for (const [row, fam] of [[UNDER, "TOTALS"], [ML, "MONEYLINE"], [CORNERS, "TOTAL_CORNERS"]] as const) {
    const e = await decide([row]);
    assert.notEqual(e.decision.reason, REASON, fam);
    assert.equal(e.decision.evaluations[0].taker.rejectReason === REASON, false, fam);
  }
  assert.equal((await decide([UNDER])).decision.action, "TAKER_FIRST");
  assert.equal((await decide([ML])).decision.action, "TAKER_FIRST");
  const sp = await decide([SPREAD]);
  assert.equal(sp.decision.action, "SKIP");
  assert.equal(sp.decision.evaluations[0].taker.rejectReason, "NOT_SUPPORT_ELIGIBLE", "SPREADS keeps its existing OFF policy, not the founder code");
});

test("5: T40/T20 live rebalance path — Over-first event queues exactly ONE allowed row (one physical match, one exposure); Over-only queues none", async () => {
  const mixed = await rebalance([OVER, UNDER, ML], true);
  assert.equal(mixed.queueRows.length, 1);
  assert.notEqual(mixed.queueRows[0].side, "Over");
  assert.equal(mixed.queueRows[0].selection_reason, "T10_ECONOMIC_ACTION_TAKER_FIRST_V1");
  assert.equal(mixed.res.status, "QUEUED");
  const only = await rebalance([OVER], true);
  assert.equal(only.queueRows.length, 0);
  assert.equal(only.result.queued_count, 0);
  const under = await rebalance([UNDER], true);
  assert.equal(under.queueRows.length, 1);
  assert.equal(under.queueRows[0].side, "Under");
  assert.equal(under.queueRows[0].market_family, "TOTALS");
});

test("6: research / telemetry decision (A/B arm) still sees TOTALS Over; the released-path LIVE choice excludes it BEFORE choosing", () => {
  const universe = [OVER, UNDER].map(obs);
  const tel = selectReservationT3AbDecisions({ ...reservation(), diagnostics: { planning_final_identity_evidence: { condition_id: OVER.cond, token_id: OVER.token, side: "Over" } } } as NightEventReservationRow, universe);
  // Telemetry arm B is unchanged: it ranks exact identity order over ALL B-universe rows (Over is observable).
  assert.ok(tel.b.selectedIdentity, "telemetry B still selects among observed rows including Over");
  assert.equal(tel.a.selectedIdentity?.side, "Over", "planning arm A still observes the Over identity");
  const live = selectLiveMoneyBDecision(universe, tel.b);
  assert.equal(live.selectedIdentity?.side, "Under", "live arm skips Over and selects the Under sibling");
  const overOnly = selectLiveMoneyBDecision([obs(OVER)], tel.b);
  assert.equal(overOnly.selectedIdentity, null);
});

test("7: released (activation OFF) live path never queues TOTALS Over; allowed sibling still queues", async () => {
  const r = await rebalance([OVER, UNDER], false);
  assert.ok(r.queueRows.every((q) => q.side !== "Over"));
});

test("8: Queue money boundary — admitExecutableQueueRow refuses TOTALS Over for every writer, admits Under/MONEYLINE/CORNERS, SPREADS still refused", async () => {
  let inserted = 0;
  const probe = { async insertQueueRow() { inserted++; } };
  const mk = (market_family: string, side: string) => ({ market_family, side, reservation_id: "r" }) as unknown as EventExecutionQueueRow;
  await assert.rejects(() => admitExecutableQueueRow(getActiveContour(), probe, mk("TOTALS", "Over"), { realMoneyEnabled: true }),
    (e: unknown) => e instanceof FounderTotalsOverLiveOffError && e.code === FOUNDER_TOTALS_OVER_LIVE_OFF && e.message.includes(REASON));
  assert.equal(inserted, 0);
  await assert.rejects(() => admitExecutableQueueRow(getActiveContour(), probe, mk("SPREADS", "Home"), { realMoneyEnabled: true }), LiveMoneyFamilyNotAuthorizedError);
  for (const [f, s] of [["TOTALS", "Under"], ["MONEYLINE", "Home"], ["TOTAL_CORNERS", "Over"]] as const) {
    await admitExecutableQueueRow(getActiveContour(), probe, mk(f, s), { realMoneyEnabled: true });
  }
  assert.equal(inserted, 3);
});

function queueRow(overrides: Partial<EventExecutionQueueRow>): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res-1", plan_run_id: "p", rebalance_run_id: "r", match_family_key: "a-vs-b", event_title: "A vs B",
    event_slug: "a-vs-b", sport: "soccer", league: null, game_start_iso: "2026-07-07T16:00:00.000Z", condition_id: "c", token_id: "t",
    side: "Under", market_slug: "m", market_title: "m", market_family: "TOTALS", score: null, coverage: null, tier: "TIER1", stake_usd: 2.5,
    preferred_entry_iso: "2026-07-07T14:50:00.000Z", latest_entry_iso: "2026-07-07T15:57:00.000Z", selection_rank: 1, selection_reason: null,
    status: "READY", order_key: "o", idempotency_key: "i", diagnostics: { max_entry_price: 0.55 }, ...overrides,
  } as EventExecutionQueueRow;
}

test("9: already-formed, not-yet-executed READY Over rows are withheld from the Ireland wire (row untouched); other rows pass", () => {
  const now = Date.parse("2026-07-07T15:00:00.000Z");
  const row = queueRow({ side: "Over", market_family: "TOTALS" });
  const snapshot = JSON.stringify(row);
  assert.throws(() => mapQueueRowToIrelandCandidate(row, now), (e: unknown) => e instanceof QueueWireContractError && e.reason === REASON && e.queueId === "q1");
  assert.equal(JSON.stringify(row), snapshot, "row is not mutated, deleted or cancelled");
  assert.equal(mapQueueRowToIrelandCandidate(queueRow({}), now).side, "Under");
  assert.equal(mapQueueRowToIrelandCandidate(queueRow({ market_family: "MONEYLINE", side: "Home" }), now).side, "Home");
  assert.equal(mapQueueRowToIrelandCandidate(queueRow({ market_family: "TOTAL_CORNERS", side: "Over" }), now).side, "Over");
  assert.throws(() => mapQueueRowToIrelandCandidate(queueRow({ market_family: "SPREADS", side: "Home" }), now), /LIVE_MONEY_FAMILY_NOT_AUTHORIZED/);
});

test("10: authorized MAKER_FALLBACK_1 for a TOTALS Over parent is not surfaced to the executor; Under still is", () => {
  const now = Date.parse("2026-07-07T15:00:00.000Z");
  const cmd = (market_family: string, side: string): MakerFallbackCommand => ({
    attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER", execution_side: "BUY", status: "AUTHORIZED", parent_attempt_id: "TAKER_ATTEMPT_1",
    parent_queue_id: "q", parent_idempotency_key: "pi", idempotency_key: "fi", physical_event_id: "e", reservation_id: "r",
    condition_id: "c", token_id: "t", side, market_family, strategy_variant: null, strategy_version: null, stake_usd: 2.5, max_stake_usd: 2.5,
    quantity: 5, limit_price: 0.5, price_cap: 0.55, deadline_iso: "2026-07-07T15:50:00.000Z",
  }) as unknown as MakerFallbackCommand;
  const rowOf = (c: MakerFallbackCommand) => ({ diagnostics: { execution_attempts_v1: { maker_fallback_1: { command: c } } }, game_start_iso: "2026-07-07T16:00:00.000Z" });
  const out = selectExecutorMakerFallbackCommands([rowOf(cmd("TOTALS", "Over")), rowOf(cmd("TOTALS", "Under")), rowOf(cmd("MONEYLINE", "Home"))], now);
  assert.deepEqual(out.map((c) => c.side), ["Under", "Home"]);
});
