import test from "node:test";
import assert from "node:assert/strict";
import { signPremiumSession } from "../../lib/auth/premiumSession";
import { isFounderModelingSession } from "../../lib/auth/founderModeling";
import { NextRequest } from "next/server";
import { GET as assets } from "../../app/founder/modeling/assets/[...path]/route";
import { GET as scorecard } from "../../app/api/founder/modeling/research/scorecard/route";

const now = Date.now();
const payload = {checkoutSessionId:"founder_preview_internal",email:null,activePlan:"preview",accessUntil:new Date(now+86_400_000).toISOString(),issuedAt:now};
test("only signed unexpired Founder Preview sessions within 24h authorize modeling",()=>{
  const secret=process.env.PPP_SESSION_SECRET,flag=process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW;
  try {
    process.env.PPP_SESSION_SECRET="synthetic-test-secret-at-least-32-characters";
    process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW="true";
    assert.equal(isFounderModelingSession(signPremiumSession(payload),now),true);
    for(const token of [undefined,"invalid",signPremiumSession({...payload,checkoutSessionId:"ordinary-premium"}),signPremiumSession({...payload,accessUntil:null}),signPremiumSession({...payload,accessUntil:new Date(now-1).toISOString()}),signPremiumSession({...payload,issuedAt:now-86_400_001}),signPremiumSession({...payload,issuedAt:now+1000}),signPremiumSession({...payload,accessUntil:new Date(now+86_400_001).toISOString()}),signPremiumSession(payload)+"zz"])
      assert.equal(isFounderModelingSession(token,now),false);
    const token=signPremiumSession(payload);
    process.env.PPP_SESSION_SECRET="different-synthetic-test-secret-32-chars";
    assert.equal(isFounderModelingSession(token,now),false);
    process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW="false";
    assert.equal(isFounderModelingSession(token,now),false);
  } finally { if(secret===undefined)delete process.env.PPP_SESSION_SECRET;else process.env.PPP_SESSION_SECRET=secret;if(flag===undefined)delete process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW;else process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW=flag; }
});

test("assets and API deny absent, expired and ordinary Premium sessions before any data read",async()=>{
  process.env.PPP_SESSION_SECRET="synthetic-test-secret-at-least-32-characters";
  process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW="true";
  for(const token of [undefined,signPremiumSession({...payload,checkoutSessionId:"customer"}),signPremiumSession({...payload,accessUntil:new Date(now-1).toISOString()})]) {
    const headers=token?{cookie:`ppp_session=${token}`} : undefined;
    const req=new NextRequest("https://example.test/api/founder/modeling/research/scorecard",{headers});
    for(const response of [await assets(req,{params:Promise.resolve({path:["MODELING_DASHBOARD.html"]})}),await scorecard(req)]) {
      assert.equal(response.status,404);assert.match(response.headers.get("cache-control")!,/private, no-store/);
      assert.equal(response.headers.get("vary"),"Cookie");
      assert.doesNotMatch(await response.text(),/strategy_totals|decision_id|service_role|supabase/);
    }
  }
  const req=new NextRequest("https://example.test/founder/modeling/assets/MODELING_DASHBOARD.html",{headers:{cookie:`ppp_session=${signPremiumSession(payload)}`}});
  const response=await assets(req,{params:Promise.resolve({path:["MODELING_DASHBOARD.html"]})});
  assert.equal(response.status,200);assert.match(await response.text(),/MODELING|Modeling/);
});
