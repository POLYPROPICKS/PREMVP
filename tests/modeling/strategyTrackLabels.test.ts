import assert from "node:assert/strict";
import { test } from "node:test";

import { ALPHA_PROGRAMS, CONTROL_STRATEGIES, strategyDefinitionHash } from "../../lib/research/inplayPaperDecisions";
import { buildTrackRegistry, TRACK_DISPLAY_NAMES } from "../../lib/research/strategyTrackLabels";
import { MODEL_IDS } from "../../scripts/modeling/prospective-selection-shadow";
import { buildCeoRows, buildTenTrackRows, renderTenTrackMarkdown, type DecisionLine } from "../../scripts/modeling/forward-bet-ceo-report";

test("ten approved display names map one-to-one onto the canonical registries", () => {
  assert.deepEqual(Object.keys(TRACK_DISPLAY_NAMES), [...MODEL_IDS, ...CONTROL_STRATEGIES.map((s) => s.id), ...ALPHA_PROGRAMS.map((s) => s.id)]);
  assert.equal(TRACK_DISPLAY_NAMES.P50_52_SAFE, "Прематч · Цена 50–52¢");
  assert.equal(TRACK_DISPLAY_NAMES.TENNIS_P50_52_SAFE, "Прематч · Теннис 50–52¢");
  assert.equal(TRACK_DISPLAY_NAMES.CONTROL_PRICE_BUCKET_C, "Лайв · Контроль 35–44¢");
  assert.equal(TRACK_DISPLAY_NAMES.STATEWISE_PAYOFF_ARBITRAGE, "Alpha 2 · Арбитраж связанных рынков");
  assert.equal(buildTrackRegistry().length, 10);
});

test("labels do not touch strategies: ids, versions, BET permissions and definition hashes are frozen", () => {
  const frozen: Record<string, [string, boolean, string]> = {
    CONTROL_PRICE_BUCKET_A: ["v1", true, "18b6022314bff87aa67cc63abc601234682187f48183b4cf3cca0df2c6dcd0d1"],
    CONTROL_PRICE_BUCKET_B: ["v1", true, "5b2b0d726cbb2b12663f1a287a75a2c84bdfaf5ea62bba7ea1480679d410c99d"],
    CONTROL_PRICE_BUCKET_C: ["v1", true, "0d9bd1548ab02acbe4720356528d9b4210cce7b2fe6b6fd97c430319154cab4f"],
    VALUE_BACKED_TAIL_REPRICING: ["v0-facts-only", false, "1e90e61e815898dd62df7a63009e09d07909bfff2dc4cfcd20996054320eb49f"],
    STATEWISE_PAYOFF_ARBITRAGE: ["v0-facts-only", false, "9ae48d236a6ff99a36bca5a8e2232d1fca1cff6853cf43a340caf6b23ce1c348"],
  };
  for (const s of [...CONTROL_STRATEGIES, ...ALPHA_PROGRAMS]) assert.deepEqual([s.version, s.canEmitBet, strategyDefinitionHash(s)], frozen[s.id], s.id);
  assert.deepEqual([...MODEL_IDS], ["P50_52_SAFE", "PORTFOLIO_BROAD_SAFE", "QUALITY_FILL_A_SAFE", "QUALITY_FILL_D_SAFE", "TENNIS_P50_52_SAFE"]);
});

test("modes come from the registries: prematch engines, delayed-paper controls, facts-only alphas", () => {
  const byId = new Map(buildTrackRegistry().map((t) => [t.canonicalId, t]));
  for (const id of MODEL_IDS) assert.equal(byId.get(id)!.mode, "PREMATCH_FORWARD_BET_ENGINE");
  for (const id of ["CONTROL_PRICE_BUCKET_A", "CONTROL_PRICE_BUCKET_B", "CONTROL_PRICE_BUCKET_C"]) assert.deepEqual([byId.get(id)!.mode, byId.get(id)!.canEmitBet], ["LIVE_DELAYED_PAPER", true]);
  for (const id of ["VALUE_BACKED_TAIL_REPRICING", "STATEWISE_PAYOFF_ARBITRAGE"]) assert.deepEqual([byId.get(id)!.mode, byId.get(id)!.canEmitBet], ["FACTS_ONLY", false]);
});

test("ten-track report: delayed controls never pass as forward evidence, alphas stay facts-only, economics UNPROVEN", () => {
  const decisions: DecisionLine[] = [
    { strategy_id: "CONTROL_PRICE_BUCKET_A", status: "BET", provenance_class: "DELAYED_PAPER", entry_cost_authority: "FULL_STAKE_EXECUTABLE_BUY_VWAP", physical_event_id: "g1" },
    { strategy_id: "CONTROL_PRICE_BUCKET_A", status: "SKIP", provenance_class: "DELAYED_PAPER", entry_cost_authority: null, physical_event_id: "g2" },
  ];
  const rows = buildTenTrackRows(buildCeoRows([], []), decisions);
  assert.equal(rows.length, 10);
  const a = rows.find((r) => r.canonicalId === "CONTROL_PRICE_BUCKET_A")!;
  assert.deepEqual([a.independentGames, a.bet, a.verdict], [1, 1, "DELAYED_PAPER_ONLY_NOT_FORWARD_EVIDENCE"]);
  assert.match(a.timingProof, /DELAYED_PAPER: 1; LIVE_PROSPECTIVE: 0/);
  assert.equal(a.economics, "UNPROVEN/UNPROVEN/UNPROVEN");
  for (const id of ["VALUE_BACKED_TAIL_REPRICING", "STATEWISE_PAYOFF_ARBITRAGE"]) assert.equal(rows.find((r) => r.canonicalId === id)!.verdict, "FACTS_ONLY_NO_BET");
  const bad = buildTenTrackRows(buildCeoRows([], []), [{ strategy_id: "STATEWISE_PAYOFF_ARBITRAGE", status: "BET", provenance_class: null, entry_cost_authority: null, physical_event_id: "x" }]);
  assert.equal(bad.find((r) => r.canonicalId === "STATEWISE_PAYOFF_ARBITRAGE")!.verdict, "VIOLATION_ALPHA_BET_PRESENT");
  const md = renderTenTrackMarkdown(rows);
  assert.match(md, /Стратегия \| Independent games \| BET \| WIN–LOSS–VOID–UNKNOWN \| Timing proof \| Price proof \| Gross\/Fees\/Net ROI \| Confidence \| Verdict/);
  assert.match(md, /Прематч · Цена 50–52¢ \(`P50_52_SAFE`\)/);
});
