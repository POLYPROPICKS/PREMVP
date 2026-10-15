import test from "node:test";
import assert from "node:assert/strict";
import {buildPerformanceScorecard,scorecardSql,type Cell,type ScorecardInput} from "../../lib/research/inplayPerformanceScorecard";

const cell=(changes:Partial<Cell>={}):Cell=>({strategy_id:"CONTROL_PRICE_BUCKET_A",strategy_version:"v1",status:"BET",sport:"tennis",market_family:"MONEYLINE",market_scope:"FULL_GAME",market_type:"MONEYLINE",day:"2026-10-14",condition_id:"c",token_id:"winner",entry_vwap:0.5,provenance_class:"DELAYED_PAPER",db_clock:false,event_start_iso:"2026-10-14T01:00:00Z",condition_events:1,box:{condition_id:"c",revision_no:1,outcome_status:"FINAL",winner_token_id:"winner",market_token_ids:["winner","loser"]},n:2,...changes});
function input(cells:Cell[]):ScorecardInput {
  const event_counts=([ [1,1],[0,1],[1,0],[0,0] ]).flatMap(([gs,gm])=>{
    const groups=new Map<string,Cell[]>();for(const c of cells){const k=JSON.stringify([c.strategy_id,c.strategy_version,gs?null:c.sport,gm?null:c.market_family]);const rows=groups.get(k)??[];rows.push(c);groups.set(k,rows);}
    return [...groups.values()].map(g=>({...g[0],gs,gm,events:g.reduce((n,c)=>n+c.n,0),bet_events:g.filter(c=>c.status==="BET").reduce((n,c)=>n+c.n,0)}));
  });
  return {scope:"RESEARCH_PAPER",from:"2026-10-10T00:00:00Z",to:"2026-10-15T13:00:00Z",read_at:"2026-10-15T13:00:00Z",first_admission:"2026-10-14T01:00:00Z",last_admission:"2026-10-14T01:00:00Z",last_created_at:"2026-10-14T02:00:00Z",independent_events:3,independent_bet_events:3,cells,event_counts};
}
test("weighted settlement reconciles all dimensions and excludes pending stakes from ROI",()=>{
  const r=buildPerformanceScorecard(input([cell(),cell({sport:"soccer",token_id:"loser",n:1}),cell({box:null,n:1})]));
  const a=r.strategy_totals[0];assert.equal(a.bet,4);assert.equal(a.win,2);assert.equal(a.loss,1);assert.equal(a.pending,1);assert.equal(a.gross_pnl_u,1);assert.equal(a.gross_roi,0.333333);assert.equal(a.net_pnl,null);
  assert.equal(r.reconciliation,"PASS");assert.equal(r.strategy_totals.find(x=>x.strategy_id==="VALUE_BACKED_TAIL_REPRICING")?.quality,"NOT_READY");
  assert.equal(a.authorities.UNRESOLVED,1);assert.equal(a.historical_bet,4);
});
test("same-day six-hour check, conflict, exact token, VOID and ambiguous event identity retain canonical semantics",()=>{
  const current=cell({day:"2026-10-15",event_start_iso:"2026-10-15T12:00:00Z",n:1,db_clock:true});
  assert.equal(buildPerformanceScorecard(input([current])).strategy_totals[0].pending,1);
  const conflict=cell({day:"2026-10-15",box:{...cell().box!,outcome_status:"CONFLICT"},n:1});
  assert.equal(buildPerformanceScorecard(input([conflict])).strategy_totals[0].unresolved_reasons.BOX_B_CONFLICT,1);
  for(const c of [cell({token_id:"unrelated"}),cell({condition_events:2})])assert.equal(buildPerformanceScorecard(input([c])).strategy_totals[0].pending,2);
  const v=buildPerformanceScorecard(input([cell({box:{...cell().box!,outcome_status:"VOID"}})])).strategy_totals[0];assert.equal(v.void,2);assert.equal(v.gross_roi,0);
});
test("future alpha authority rows populate automatically and missing event evidence fails closed",()=>{
  const x=input([cell({strategy_id:"STATEWISE_PAYOFF_ARBITRAGE",strategy_version:"future-v1"})]);
  assert.equal(buildPerformanceScorecard(x).strategy_totals.find(r=>r.strategy_id==="STATEWISE_PAYOFF_ARBITRAGE")?.bet,2);
  x.event_counts=[];assert.throws(()=>buildPerformanceScorecard(x),/EVENT_COUNTS_MISSING/);
});
test("SQL bounds and clone identity reject invalid input",()=>{
  assert.throws(()=>scorecardSql("2026-10-10';drop table x;--","2026-10-16T00:00:00Z"),/INVALID_WINDOW/);
  const x=input([cell()]);x.scope="production";assert.throws(()=>buildPerformanceScorecard(x),/NOT_RESEARCH_CLONE/);
});
test("future live results preserve separate provenance economics and dynamic quality",()=>{
  const total=buildPerformanceScorecard(input([cell(),cell({provenance_class:"LIVE_PROSPECTIVE",db_clock:true,token_id:"loser",n:1})])).strategy_totals[0];
  assert.equal(total.quality,"MIXED_PROVENANCE; PROSPECTIVE_PROFITABILITY_UNPROVEN");
  assert.equal(total.by_provenance.DELAYED_PAPER.gross_pnl_u,2);
  assert.equal(total.by_provenance.LIVE_PROSPECTIVE.gross_pnl_u,-1);
  assert.equal(total.live_prospective_bet,1);assert.equal(total.historical_bet,2);
});
