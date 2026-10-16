import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET as assets } from "../../app/founder/modeling/assets/[...path]/route";
import { GET as scorecard } from "../../app/api/founder/modeling/research/scorecard/route";
import { GET as shadowMatches } from "../../app/api/founder/modeling/research/shadow-matches/route";
import { GET as liveApi } from "../../app/api/founder/modeling/live/route";
import { GET as shadowApi } from "../../app/api/founder/modeling/shadow/route";
import ModelingPage from "../../app/founder/modeling/page";

// Issue #550: /founder/modeling is a permanent PUBLIC read-only dashboard. Every request here is anonymous
// (no cookie, no token, no session secret configured).
const SENSITIVE = /spendable|collateral|allowance|nbnldzfsxffztsfrrxqy|productionProjectRef|"wallet"|service_role|ppp_session|PPP_SESSION_SECRET/i;
const ASSET_FILES = ["MODELING_DASHBOARD.html", "MODELING_DAILY_DATA.js", "CAPITAL_MODELING_DATA.js", "FORWARD_SHADOW_DATA.js", "LIVE_RUNTIME_DATA.js", "CURRENT_MODELING_AUTHORITY.js"];
const asset = (path: string[]) => assets(new NextRequest("https://example.test/founder/modeling/assets/" + path.join("/")), { params: Promise.resolve({ path }) });

test("page renders anonymously with the three sections and no access wall", () => {
  delete process.env.PPP_SESSION_SECRET; delete process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW;
  const html = renderToStaticMarkup(createElement(ModelingPage));
  for (const must of ["1. SAFE-модели", "2. Виртуальные контроли A/B/C", "3. Production LIVE", "/founder/modeling/assets/MODELING_DASHBOARD.html"]) assert.ok(html.includes(must), must);
  assert.doesNotMatch(html, /Нужен вход основателя|Founder-сессии/);
});

test("all allowlisted assets are served anonymously and cacheably without cookies", async () => {
  for (const file of ASSET_FILES) {
    const res = await asset([file]);
    assert.equal(res.status, 200, file);
    assert.doesNotMatch(res.headers.get("cache-control")!, /private/);
    assert.equal(res.headers.get("vary"), null);
    assert.doesNotMatch(await res.text(), file === "MODELING_DASHBOARD.html" ? /spendableUsd\.toFixed|nbnldzfsxffztsfrrxqy/ : SENSITIVE, file);
  }
});

test("LIVE asset keeps aggregates but never wallet balances or the production project ref", async () => {
  const text = await (await asset(["LIVE_RUNTIME_DATA.js"])).text();
  assert.doesNotMatch(text, SENSITIVE);
  assert.match(text, /AGGREGATE_ONLY_V1/);
  assert.match(text, /"clobOrderN": 17/);
});

test("forbidden and traversal paths stay 404", async () => {
  for (const path of [["package.json"], ["..", "package.json"], ["%2e%2e", ".env"], ["constructor"], ["__proto__"], ["toString"], ["MODELING_DASHBOARD.html", "x"], [".env"], []]) {
    assert.equal((await asset(path)).status, 404, path.join("/"));
  }
});

test("research and telemetry APIs answer anonymously (data or an honest unavailable state, never an auth 404)", async () => {
  const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEARCH_SUPABASE_URL", "RESEARCH_SUPABASE_SERVICE_ROLE_KEY"];
  const saved = keys.map(k => process.env[k]); keys.forEach(k => delete process.env[k]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  try {
    for (const [handler, url] of [[scorecard, "research/scorecard"], [shadowMatches, "research/shadow-matches"], [liveApi, "live"], [shadowApi, "shadow"]] as const) {
      const res = await (handler as (r: NextRequest) => Promise<Response>)(new NextRequest("https://example.test/api/founder/modeling/" + url));
      const text = await res.text();
      assert.notEqual(res.status, 404, url);
      assert.doesNotMatch(text, /"not_found"/);
      assert.doesNotMatch(text, SENSITIVE, url);
      assert.doesNotMatch(res.headers.get("cache-control")!, /private/);
      if (res.status !== 200) assert.match(res.headers.get("cache-control")!, /no-store/);
    }
  } finally {
    globalThis.fetch = realFetch;
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});
