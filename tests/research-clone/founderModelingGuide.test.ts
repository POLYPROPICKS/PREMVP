import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { QUALITY_PORTFOLIOS } from "../../scripts/modeling/quality-fill-portfolio-test";
import { PORTFOLIOS } from "../../scripts/modeling/daily-portfolio-frontier";
import { QUALITY_FILL_A_SAFE_MIX_CONFIGS } from "../../scripts/modeling/tennis-safe-comparable-leaderboard";
import { ALPHA_PROGRAMS, CONTROL_STRATEGIES } from "../../lib/research/inplayPaperDecisions";
import { SOCCER_FAMILY as SOCCER } from "../../lib/modeling/research-engine/models";
import { SAFE_MODEL_IDS } from "../../lib/research/founderShadowMatches";
import { ALPHA_GUIDE, CONTROL_GUIDE, SAFE_MODEL_GUIDE, modelLabelRu } from "../../lib/research/founderModelingGuide";
import { AlphaGuide, ControlsGuide, LevelLadder, LiveGuide, SafeGuide } from "../../app/founder/modeling/ModelingGuide";
import FounderAccessRequired from "../../app/founder/modeling/FounderAccessRequired";

type Tier = (e: { entryPrice: number; sportFamily: string; scoreLevel: number | null }) => boolean;
const hit = (tier: Tier, entryPrice: number, sportFamily: string, scoreLevel: number | null = null) => tier({ entryPrice, sportFamily, scoreLevel });

test("Russian guide covers exactly the five canonical SAFE ids in order", () => {
  assert.deepEqual(SAFE_MODEL_GUIDE.map(m => m.id), [...SAFE_MODEL_IDS]);
  assert.equal(modelLabelRu("P50_52_SAFE"), "Базовая стратегия: цена 50–52 цента");
  assert.equal(modelLabelRu("UNKNOWN_ID"), "UNKNOWN_ID");
});

test("A and D tier text matches executable source predicates at boundaries", () => {
  const a = QUALITY_PORTFOLIOS.QUALITY_FILL_A as unknown as Tier[], d = QUALITY_PORTFOLIOS.QUALITY_FILL_D as unknown as Tier[];
  assert.equal(a.length, 3); assert.equal(d.length, 4);
  // A tier1 tennis [0.50,0.52)
  assert.ok(hit(a[0], 0.50, "tennis")); assert.ok(!hit(a[0], 0.52, "tennis")); assert.ok(!hit(a[0], 0.50, SOCCER));
  // tier2 soccer [0.50,0.54)
  assert.ok(hit(a[1], 0.50, SOCCER)); assert.ok(hit(a[1], 0.5399, SOCCER)); assert.ok(!hit(a[1], 0.54, SOCCER));
  // tier3 remaining [0.50,0.52)
  assert.ok(hit(a[2], 0.5199, "basketball")); assert.ok(!hit(a[2], 0.52, "basketball"));
  // D shares A's first three and adds soccer [0.54,0.60) last
  for (let i = 0; i < 3; i++) for (const [p, s] of [[0.5, "tennis"], [0.53, SOCCER], [0.51, "nba"], [0.55, SOCCER]] as const) assert.equal(hit(d[i], p, s), hit(a[i], p, s));
  assert.ok(hit(d[3], 0.54, SOCCER)); assert.ok(hit(d[3], 0.5999, SOCCER)); assert.ok(!hit(d[3], 0.60, SOCCER)); assert.ok(!hit(d[3], 0.55, "tennis"));
});

test("PORTFOLIO_BROAD priority tiers match the Russian description", () => {
  const broad = PORTFOLIOS.find(p => p.id === "PORTFOLIO_BROAD")!.tiers as unknown as Tier[];
  assert.equal(broad.length, 3);
  assert.ok(hit(broad[0], 0.51, "tennis")); assert.ok(hit(broad[0], 0.51, "nba", 63)); assert.ok(hit(broad[0], 0.51, "nba", 64.9));
  assert.ok(!hit(broad[0], 0.51, "nba", 65)); assert.ok(!hit(broad[0], 0.51, "nba", 62.9)); assert.ok(!hit(broad[0], 0.53, "tennis"));
  assert.ok(hit(broad[1], 0.50, "nba")); assert.ok(!hit(broad[1], 0.52, "nba"));
  assert.ok(hit(broad[2], 0.52, "nba")); assert.ok(hit(broad[2], 0.5399, "nba")); assert.ok(!hit(broad[2], 0.54, "nba"));
});

test("A live-mix text matches cap 30 config and D does not claim it", () => {
  assert.deepEqual(QUALITY_FILL_A_SAFE_MIX_CONFIGS[30], { cap: 30, footballFirstSlots: 20, tennisMaxWhenFootballSufficient: 7 });
  const a = SAFE_MODEL_GUIDE.find(m => m.id === "QUALITY_FILL_A_SAFE")!, d = SAFE_MODEL_GUIDE.find(m => m.id === "QUALITY_FILL_D_SAFE")!;
  assert.match(a.allocationRu, /20/); assert.match(a.allocationRu, /7/);
  assert.match(d.allocationRu, /НЕ то же самое/);
});

test("alpha programs are research-only, cannot emit bets, and carry honest states", () => {
  assert.ok(ALPHA_PROGRAMS.every(p => p.canEmitBet === false));
  assert.ok(ALPHA_GUIDE.every(a => a.canEmitBet === false));
  assert.equal(ALPHA_GUIDE.find(a => a.id === "VALUE_BACKED_TAIL_REPRICING")!.stateText, "NOT_READY");
  assert.equal(ALPHA_GUIDE.find(a => a.id === "STATEWISE_PAYOFF_ARBITRAGE")!.stateText, "SCOPED_NO_GO");
  assert.deepEqual(CONTROL_GUIDE.map(c => [c.id, c.range]), CONTROL_STRATEGIES.map(c => [c.id, c.range]));
});

test("rendered page sections are distinct, Russian and make no trading or ROI claim", () => {
  const html = [LevelLadder, SafeGuide, AlphaGuide, ControlsGuide, LiveGuide].map(C => renderToStaticMarkup(createElement(C))).join("\n");
  for (const must of ["Расширенный портфель", "Портфель A: приоритет футбола и тенниса", "Портфель D: расширенный футбольный диапазон", "Теннис: цена 50–52 цента",
    "Переоценка дешёвых исходов по ходу матча", "Структурный арбитраж связанных контрактов", "NOT_READY", "SCOPED_NO_GO", "canEmitBet=false", "selection-before-settlement", "cap 30",
    "Исполнимого права на покупку (BUY)", "Production LIVE", "Контроль A", "Контроль C"]) assert.ok(html.includes(must), must);
  assert.doesNotMatch(html, /ROI:\s*\d|P&amp;L:\s*[-+]?\d|гарантир|прибыльн/i);
});

test("access page explains the legitimate login without secrets, identities or configuration", () => {
  const html = renderToStaticMarkup(createElement(FounderAccessRequired));
  assert.match(html, /Нужен вход основателя/); assert.match(html, /Premium не равен доступу основателя/);
  assert.doesNotMatch(html, /token=|@|ENABLE_FOUNDER|FOUNDER_PREMIUM_PREVIEW_TOKEN|PPP_SESSION_SECRET|supabase|strategy_totals/i);
});
