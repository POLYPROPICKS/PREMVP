// FOUNDER_TOTALS_OVER_LIVE_OFF_2026_10_10 -- no NEW real-money bet on TOTALS Over (any line).
//   node --import tsx --test tests/contur3/founderTotalsOverLiveOff.test.ts
// Superseded by MONEYLINE-only LIVE on 2026-10-15; historical predicate remains tested.
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
  FOUNDER_MONEYLINE_ONLY_LIVE,
  FOUNDER_TOTALS_OVER_LIVE_OFF,
  FounderTotalsOverLiveOffError,
  isFounderLiveOffTotalsOver,
  LiveMoneyFamilyNotAuthorizedError,
} from "../../lib/executor/liveMoneyFamilyAuthority";
import { evaluateMakerEligibility, selectExecutorMakerFallbackCommands, type MakerFallbackCommand } from "../../lib/executor/makerFallbackAuthorization";
import { getActiveContour } from "../../lib/constructor/registry";

const REASON = FOUNDER_MONEYLINE_ONLY_LIVE;
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

function queueRow(overrides: Partial<EventExecutionQueueRow>): EventExecutionQueueRow {
  return {
    id: "q1", reservation_id: "res-1", plan_run_id: "p", rebalance_run_id: "r", match_family_key: "a-vs-b", event_title: "A vs B",
    event_slug: "a-vs-b", sport: "soccer", league: null, game_start_iso: "2026-07-07T16:00:00.000Z", condition_id: "c", token_id: "t",
    side: "Under", market_slug: "m", market_title: "m", market_family: "TOTALS", score: null, coverage: null, tier: "TIER1", stake_usd: 2.5,
    preferred_entry_iso: "2026-07-07T14:50:00.000Z", latest_entry_iso: "2026-07-07T15:57:00.000Z", selection_rank: 1, selection_reason: null,
    status: "READY", order_key: "o", idempotency_key: "i", diagnostics: { max_entry_price: 0.55 }, ...overrides,
  } as EventExecutionQueueRow;
}


test("MONEYLINE Yes/No stay LIVE; prohibited families retain rejection evaluations", async () => {
 for(const side of ['Yes','No']) { const e=await decide([{...ML,side}]); assert.equal(e.decision.action,'TAKER_FIRST'); assert.equal(e.decision.selected!.candidateIdentity.side,side); }
 for(const row of [UNDER,OVER,CORNERS,SPREAD,{...ML,family:'UNKNOWN'},{...ML,family:''}, ...['0.5','1.5','2.5','3.5','4.5','8.5'].flatMap(line=>[totals('u'+line,'Under '+line),totals('o'+line,'Over '+line)])]) {
  const e=await decide([row]); assert.equal(e.decision.action,'SKIP'); assert.equal(e.decision.selected,null); assert.equal(e.decision.evaluations.length,1); assert.equal(e.decision.evaluations[0].taker.rejectReason,REASON); assert.equal(e.decision.evaluations[0].maker.rejectReason,REASON);
 }
});
test("Under first cannot starve MONEYLINE in T10; Under-only skips",async()=>{
 const under={...UNDER,t10:[0.44,0.46] as [number,number]}; const e=await decide([under,ML]);
 assert.equal(e.decision.selected!.candidateIdentity.tokenId,ML.token);
 assert.equal(e.decision.evaluations.find(x=>x.candidateIdentity.tokenId===under.token)!.taker.rejectReason,REASON);
 assert.equal((await decide([under])).decision.action,'SKIP');
});
test("released B filters before ranking; A/B research retains Under selection",()=>{
 const under={...UNDER,t10:[0.44,0.46] as [number,number]}; const universe=[under,ML].map(obs);
 const tel=selectReservationT3AbDecisions({...reservation(),diagnostics:{planning_final_identity_evidence:{condition_id:under.cond,token_id:under.token,side:under.side}}} as NightEventReservationRow,universe);
 assert.equal(tel.a.selectedIdentity?.tokenId,under.token); assert.equal(tel.b.selectedIdentity?.tokenId,ML.token);
 const underOnly=selectReservationT3AbDecisions(reservation(),[obs(UNDER)]); assert.equal(underOnly.b.selectedIdentity?.tokenId,UNDER.token);
 assert.equal(selectLiveMoneyBDecision(universe,tel.b).selectedIdentity?.tokenId,ML.token);
 assert.equal(selectLiveMoneyBDecision([obs(under)],tel.b).selectedIdentity,null);
});
test("activation ON/OFF both queue MONEYLINE and skip Under-only, with research recorder active",async()=>{
 for(const active of [true,false]) {
  const mixed=await rebalance([UNDER,OVER,ML,CORNERS,SPREAD],active); assert.equal(mixed.queueRows.length,1,String(active)); assert.equal(mixed.queueRows[0].market_family,'MONEYLINE'); assert.equal(mixed.queueRows[0].token_id,ML.token);
  const only=await rebalance([UNDER],active); assert.equal(only.queueRows.length,0); assert.equal(only.result.queued_count,0); assert.ok(mixed.decisions.length>0);
 }
});
test("Queue admission and persisted READY handoff fail closed without mutation",async()=>{
 let inserted=0; const repo={async insertQueueRow(){inserted++;}}; const now=Date.parse('2026-07-07T15:00:00.000Z');
 for(const family of ['TOTALS','SPREADS','TOTAL_CORNERS','UNKNOWN','',null,undefined]) {
  for(const side of ['Under','Over']) {
   const row=queueRow({market_family:family,side} as Partial<EventExecutionQueueRow>); const before=JSON.stringify(row);
   await assert.rejects(()=>admitExecutableQueueRow(getActiveContour(),repo,row,{realMoneyEnabled:true}),(e:unknown)=>e instanceof LiveMoneyFamilyNotAuthorizedError&&e.code===REASON);
   assert.throws(()=>mapQueueRowToIrelandCandidate(row,now),(e:unknown)=>e instanceof QueueWireContractError&&e.reason===REASON); assert.equal(JSON.stringify(row),before);
  }
 }
 assert.equal(inserted,0);
 for(const side of ['Yes','No']) { const row=queueRow({market_family:'MONEYLINE',side}); await admitExecutableQueueRow(getActiveContour(),repo,row,{realMoneyEnabled:true}); assert.equal(mapQueueRowToIrelandCandidate(row,now).side,side); }
 assert.equal(inserted,2);
});
test("10: authorized MAKER_FALLBACK_1 for a TOTALS Over parent is not surfaced to the executor; only MONEYLINE is", () => {
  const now = Date.parse("2026-07-07T15:00:00.000Z");
  const cmd = (market_family: string, side: string): MakerFallbackCommand => ({
    attempt_id: "MAKER_FALLBACK_1", execution_mode: "MAKER", execution_side: "BUY", status: "AUTHORIZED", parent_attempt_id: "TAKER_ATTEMPT_1",
    parent_queue_id: "q", parent_idempotency_key: "pi", idempotency_key: "fi", physical_event_id: "e", reservation_id: "r",
    condition_id: "c", token_id: "t", side, market_family, strategy_variant: null, strategy_version: null, stake_usd: 2.5, max_stake_usd: 2.5,
    quantity: 5, limit_price: 0.5, price_cap: 0.55, deadline_iso: "2026-07-07T15:50:00.000Z",
  }) as unknown as MakerFallbackCommand;
  const rowOf = (c: MakerFallbackCommand) => ({ diagnostics: { execution_attempts_v1: { maker_fallback_1: { command: c } } }, game_start_iso: "2026-07-07T16:00:00.000Z" });
  const out = selectExecutorMakerFallbackCommands([rowOf(cmd("TOTALS", "Over")), rowOf(cmd("TOTALS", "Under")), rowOf(cmd("MONEYLINE", "Home"))], now);
  assert.deepEqual(out.map((c) => c.side), ["Home"]);
});

test("fallback authorization rejects every non-MONEYLINE family even after a prior parent attempt",()=>{
 for(const family of ['TOTALS','SPREADS','TOTAL_CORNERS','UNKNOWN','',null,undefined]) {
  const queue=queueRow({market_family:family} as Partial<EventExecutionQueueRow>);
  const e=evaluateMakerEligibility({queue,result:null,nowMs:Date.parse('2026-07-07T15:00:00.000Z')});
  assert.equal(e.eligible,false); assert.ok(e.reasons.includes(REASON));
 }
});
