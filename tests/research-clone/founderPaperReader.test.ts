import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFounderPaper } from "../../lib/research/founderPaperReader";
import { buildPaperSnapshot } from "../../lib/research/paperScorecardSnapshot";
import type { DecisionRow } from "../../lib/research/inplayPaperSettlement";
import { NextRequest } from "next/server";
import { signPremiumSession } from "../../lib/auth/premiumSession";
import { GET } from "../../app/api/founder/modeling/research/scorecard/route";

const now=Date.parse("2026-10-15T19:00:00.000Z");
const from="2026-10-15T00:00:00.000Z",to="2026-10-16T00:00:00.000Z";
const decision:DecisionRow={decision_id:"synthetic-skip",strategy_id:"CONTROL_PRICE_BUCKET_A",strategy_version:"v1",
  physical_event_id:"synthetic-game",status:"SKIP",provenance_class:"DELAYED_PAPER",
  admission_observed_at:"2026-10-15T09:00:00.000Z",created_at:"2026-10-15T09:01:00.000Z"};
const snapshot=buildPaperSnapshot([decision],[],from,to,new Date(now).toISOString());
const report=(patch:Record<string,unknown>={})=>({utc_day:"2026-10-15",generated_at:new Date(now).toISOString(),
  status:"INCOMPLETE",last_attempt_status:"SUCCESS",scorecard:snapshot,...patch});

function fakeDb(reports:ReturnType<typeof report>[],counts={total:1,bet:0,waiting:0}) {
  return {from(table:string) {
    let head=false,status:string|undefined;
    const q={
      select(_columns:string,opts?:{head?:boolean}) {head=!!opts?.head;return q;},
      eq(column:string,value:string) {if(column==="status")status=value;return q;},
      gte() {return q;},lt() {return q;},lte() {return q;},order() {return q;},limit() {return q;},
      then(resolve:(value:unknown)=>unknown,reject:(reason:unknown)=>unknown) {
        const result=table==="research_inplay_paper_settlement_reports"?{data:reports,error:null}:
          head?{data:null,error:null,count:status==="BET"?counts.bet:status==="WAITING"?counts.waiting:counts.total}:
            {data:[{admission_observed_at:decision.admission_observed_at}],error:null};
        return Promise.resolve(result).then(resolve,reject);
      },
    };
    return q;
  }} as unknown as SupabaseClient;
}

test("reader fails closed for absent summaries, failed reports, wrong versions and missing decision days",async()=>{
  for(const reports of [[],[report({scorecard:null})],[report({status:"FAILED"})],
    [report({scorecard:{...snapshot,version:"OLD"}})]])
    await assert.rejects(readFounderPaper(fakeDb(reports),new URLSearchParams(),now),/REPORT_REFRESH_REQUIRED/);
  // An omitted day containing decisions is caught by the exact cohort count, not calendar-day padding.
  await assert.rejects(readFounderPaper(fakeDb([report()],{total:2,bet:0,waiting:0}),new URLSearchParams(),now),/REPORT_COHORT_BEHIND_DECISIONS/);
  for(const counts of [{total:1,bet:1,waiting:0},{total:1,bet:0,waiting:1}])
    await assert.rejects(readFounderPaper(fakeDb([report()],counts),new URLSearchParams(),now),/REPORT_COHORT_BEHIND_DECISIONS/);
});

test("reader reports stale attempts and incomplete current UTC day without fabricating outcomes",async()=>{
  const current=await readFounderPaper(fakeDb([report()]),new URLSearchParams(),now);
  assert.equal(current.freshness,"CURRENT");assert.equal(current.reconciliation,"PASS");
  assert.equal(current.cacheStatus,"bypassed");assert.equal(current.independent_events,1);
  const a=current.strategy_totals.find(r=>r.strategy_id==="CONTROL_PRICE_BUCKET_A")!;
  assert.deepEqual(a.incomplete_days,["2026-10-15"]);
  assert.deepEqual([a.bet,a.skip,a.win,a.loss,a.pending,a.net_pnl,a.net_roi],[0,1,0,0,0,null,null]);
  for(const patch of [{generated_at:new Date(now-3*3_600_000).toISOString()},
    {last_attempt_status:"FAILED"},{last_attempt_status:"REGRESSION_REFUSED"}]) {
    const stale=await readFounderPaper(fakeDb([report(patch)]),new URLSearchParams(),now);
    assert.equal(stale.freshness,"STALE");assert.equal(stale.reconciliation,"PASS");
  }
  assert.doesNotMatch(JSON.stringify(current),/synthetic-game|synthetic-skip|decision_id|service_role|supabase/);
});

test("authenticated API returns private uncached refresh errors and sanitized incomplete-day statistics",async()=>{
  const names=["PPP_SESSION_SECRET","ENABLE_FOUNDER_PREMIUM_PREVIEW","SUPABASE_CLONE_URL","SUPABASE_CLONE_SERVICE_ROLE_KEY"] as const;
  const saved=names.map(name=>process.env[name]),originalFetch=globalThis.fetch;
  try {
    process.env.PPP_SESSION_SECRET="synthetic-scorecard-secret-at-least-32-characters";
    process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW="true";
    process.env.SUPABASE_CLONE_URL="https://nppznoujvnyjargjkmnv.supabase.co";
    process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY="synthetic-key-never-sent-to-a-server";
    const issuedAt=Date.now(),at=new Date(issuedAt).toISOString(),day=at.slice(0,10);
    const fromDay=`${day}T00:00:00.000Z`,toDay=new Date(Date.parse(fromDay)+86_400_000).toISOString();
    const d={...decision,admission_observed_at:fromDay,created_at:fromDay};
    const live=buildPaperSnapshot([d],[],fromDay,toDay,at);
    const token=signPremiumSession({checkoutSessionId:"founder_preview_internal",email:null,activePlan:"preview",issuedAt,accessUntil:new Date(issuedAt+86_400_000).toISOString()});
    for(const mode of ["missing","behind","stale","current"] as const) {
      globalThis.fetch=async(input,init)=>{
        const url=new URL(String(input));
        assert.equal(url.hostname,"nppznoujvnyjargjkmnv.supabase.co");
        if(init?.method==="HEAD") {
          const count=url.searchParams.has("status")?0:mode==="behind"?2:1;
          return new Response(null,{headers:{"content-range":`*/${count}`}});
        }
        const data=url.pathname.endsWith("research_inplay_paper_decisions")?[{admission_observed_at:fromDay}]:
          [{utc_day:day,generated_at:at,status:"INCOMPLETE",last_attempt_status:mode==="stale"?"FAILED":"SUCCESS",scorecard:mode==="missing"?null:live}];
        return new Response(JSON.stringify(data),{headers:{"content-type":"application/json"}});
      };
      const response=await GET(new NextRequest("https://example.test/api/founder/modeling/research/scorecard",{headers:{cookie:`ppp_session=${token}`}}));
      assert.equal(response.status,mode==="missing"||mode==="behind"?503:200);
      assert.match(response.headers.get("cache-control")!,/private, no-store/);
      assert.equal(response.headers.get("vary"),"Cookie");
      const body=await response.json();
      assert.equal(body.cacheStatus,"bypassed");
      if(mode==="missing")assert.equal(body.error,"REPORT_REFRESH_REQUIRED");
      else if(mode==="behind")assert.equal(body.error,"REPORT_COHORT_BEHIND_DECISIONS");
      else {assert.equal(body.freshness,mode==="stale"?"STALE":"CURRENT");assert.equal(body.reconciliation,"PASS");}
      assert.doesNotMatch(JSON.stringify(body),/synthetic-key|synthetic-game|synthetic-skip|decision_id|service_role|supabase/);
    }
  } finally {
    globalThis.fetch=originalFetch;
    names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});
  }
});
