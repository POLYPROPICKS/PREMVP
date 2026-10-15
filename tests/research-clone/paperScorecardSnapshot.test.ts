import test from "node:test";
import assert from "node:assert/strict";
import { buildPaperSnapshot,mergePaperSnapshots } from "../../lib/research/paperScorecardSnapshot";
import { settlePositionBoxB, type DecisionRow, type FrozenBet } from "../../lib/research/inplayPaperSettlement";
import { paperRange } from "../../lib/research/founderPaperReader";
import { selectTargetDays, type ExistingReport } from "../../lib/research/inplayPaperSettlementCycle";
const from="2026-10-14T00:00:00.000Z",to="2026-10-15T00:00:00.000Z",read="2026-10-15T13:00:00.000Z";
function sample(id:string,strategy:string,event:string,sport:string,status="BET"):DecisionRow {
  return {decision_id:id,strategy_id:strategy,strategy_version:"v1",physical_event_id:event,status,provenance_class:"DELAYED_PAPER",admission_observed_at:"2026-10-14T09:00:00.000Z",provider_sport_family:sport,market_family:"MONEYLINE",market_scope:"FULL_GAME",frozen_db_at:"2026-10-14T09:05:00.000Z",created_at:"2026-10-14T09:05:00.000Z"};
}
function position(d:DecisionRow,winner=true) {
  const bet:FrozenBet={...d,market_family:d.market_family??null,condition_id:d.physical_event_id,token_id:winner?"win":"lose",side:null,entry_vwap:.4,entry_quantity:null,entry_notional_usd:null,observed_at:null,source_observation_id:null};
  return settlePositionBoxB(bet,{condition_id:d.physical_event_id,revision_no:1,outcome_status:"FINAL",winner_token_id:"win",market_token_ids:["win","lose"]},null,new Set([d.physical_event_id]));
}
test("durable snapshot reuses canonical economics, reconciles all four views and deduplicates portfolio matches",()=>{
  const a=sample("a","CONTROL_PRICE_BUCKET_A","same-game","tennis"),b=sample("b","CONTROL_PRICE_BUCKET_B","same-game","tennis"),c=sample("c","CONTROL_PRICE_BUCKET_A","other","soccer"),skip=sample("s","CONTROL_PRICE_BUCKET_A","skipped","soccer","SKIP");
  const snapshot=buildPaperSnapshot([a,b,c,skip],[position(a),position(b,false),position(c,false)],from,to,to);
  const r=mergePaperSnapshots([snapshot],from,"2026-10-16T00:00:00.000Z",read);
  assert.equal(r.independent_events,3);assert.equal(r.independent_bet_events,2);
  const total=r.strategy_totals.find(r=>r.strategy_id==="CONTROL_PRICE_BUCKET_A")!;
  assert.equal(total.bet,2);assert.equal(total.skip,1);assert.equal(total.gross_pnl_u,.5);assert.equal(total.gross_roi,.25);
  assert.equal(total.calendar_days,1);assert.equal(r.reconciliation,"PASS");
  assert.equal(r.strategy_totals.find(r=>r.strategy_id==="VALUE_BACKED_TAIL_REPRICING")!.quality,"NOT_READY");
  assert.equal(r.strategy_totals.find(r=>r.strategy_id==="STATEWISE_PAYOFF_ARBITRAGE")!.quality,"SCOPED_NO_GO");
  assert.doesNotMatch(JSON.stringify(r),/same-game|decision_id|event_keys|condition_id|token_id|supabase|project_id/);
});
test("missing outcome, wrong cohort, absent snapshots and invalid ranges fail closed",()=>{
  const d=sample("a","CONTROL_PRICE_BUCKET_A","same-game","tennis");
  assert.throws(()=>buildPaperSnapshot([d],[],from,to,to),/COHORT_MISMATCH/);
  assert.throws(()=>buildPaperSnapshot([d],[position(d)],to,"2026-10-16T00:00:00.000Z",read),/COHORT_MISMATCH/);
  assert.throws(()=>mergePaperSnapshots([],from,to,read),/REFRESH_REQUIRED/);
  for(const q of ["range=custom&from=2026-02-30&to=2026-03-02","range=custom&from=2024-01-01&to=2026-10-15","range=custom&from=2026-10-15&to=2026-10-14","range=bad"])
    assert.throws(()=>paperRange(new URLSearchParams(q),from,Date.parse(read)),/INVALID_RANGE/);
  assert.equal(paperRange(new URLSearchParams("range=7"),from,Date.parse(read)).from,"2026-10-09T00:00:00.000Z");
});
test("existing scheduler revisits summaries missing scorecard data without increasing run limits",()=>{
  const row:ExistingReport={utc_day:"2026-10-14",status:"FULLY_RESOLVED",settled_n:1,attempts_n:1,generated_at:to,first_generated_at:to,last_attempt_at:to,scorecard:null};
  assert.ok(selectTargetDays({nowMs:Date.parse(read),existing:[row]}).includes(row.utc_day));
  assert.ok(selectTargetDays({nowMs:Date.parse(read),existing:[row]}).length<=4);
});
