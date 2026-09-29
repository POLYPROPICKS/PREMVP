import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_B_ID, LIVE_B_STRATEGY, isLiveMltsOdds175200, isEntryPriceEquivalent, marketComposition, excludedClassEvents,
} from "../../scripts/modeling/football-live-safe-rebaseline";
import { STRATEGY_REGISTRY } from "../../scripts/modeling/football-strategy-registry";
import { composePriority } from "../../scripts/modeling/football-core-portfolio-composition";
import type { SelectedCandidate } from "../../scripts/modeling/daily-portfolio-frontier";
import type { StructuralCandidate } from "../../scripts/modeling/football-structural-authority";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

test("live-safe predicate: only moneyline/totals/spreads, odds [1.75, 2.00)", () => {
  for (const m of ["moneyline", "totals", "spreads"]) assert.equal(isLiveMltsOdds175200({ marketTypeRaw: m, entryPrice: 0.55 }), true, m);
  for (const m of ["total_corners", "soccer_exact_score", "btts", null]) assert.equal(isLiveMltsOdds175200({ marketTypeRaw: m, entryPrice: 0.55 }), false, String(m));
  assert.equal(isLiveMltsOdds175200({ marketTypeRaw: "moneyline", entryPrice: 0.5 }), false); // odds 2.00 excluded
  assert.equal(isLiveMltsOdds175200({ marketTypeRaw: "moneyline", entryPrice: 4 / 7 }), true); // odds 1.75 included
  assert.equal(isLiveMltsOdds175200({ marketTypeRaw: "moneyline", entryPrice: 0.58 }), false);
});

test("decimal-odds form equals entry-price form 0.50 < p <= 4/7", () => {
  for (let p = 0.4; p < 0.7; p += 0.0005) {
    assert.equal(isLiveMltsOdds175200({ marketTypeRaw: "moneyline", entryPrice: p }), isEntryPriceEquivalent(p), String(p));
  }
});

test("strategy def is stable, live-only scope, and old registry is untouched", () => {
  assert.equal(LIVE_B_STRATEGY.strategy_id, "FOOTBALL_LIVE_MLTS_ODDS_175_200");
  assert.equal(LIVE_B_ID, LIVE_B_STRATEGY.strategy_id);
  assert.deepEqual(LIVE_B_STRATEGY.market_scope, ["moneyline", "totals", "spreads"]);
  assert.equal(LIVE_B_STRATEGY.price_max, 4 / 7);
  assert.equal(STRATEGY_REGISTRY.length, 9);
  assert.ok(!STRATEGY_REGISTRY.some((d) => d.strategy_id === LIVE_B_ID));
});

let n = 0;
const pick = (ev: string, at: string, id?: string): SelectedCandidate => ({
  physicalEventKey: ev, decisionTimestamp: at, eventStart: "2026-09-30T00:00:00Z", leadTimeHours: 5, entryPrice: 0.55,
  sportFamily: "soccer", tier: 1, day: at.slice(0, 10), candidateIdentity: id ?? `c-${ev}::t${++n}::${at}`,
});
const struct = (s: SelectedCandidate, marketTypeRaw: string) => ({ candidateIdentity: s.candidateIdentity, marketTypeRaw }) as unknown as StructuralCandidate;

test("priority: primary claims event, fallback fills only unclaimed, no settlement input", () => {
  const p1 = pick("E1", "2026-09-10T01:00:00Z");
  const f1 = pick("E1", "2026-09-10T00:00:00Z"); // earlier but same event -> dropped
  const f2 = pick("E2", "2026-09-10T02:00:00Z");
  const c = composePriority([p1], [f1, f2]);
  assert.deepEqual(c.portfolio.map((x) => x.candidateIdentity), [p1.candidateIdentity, f2.candidateIdentity]);
  assert.equal(c.dropped.length, 1);
  assert.equal(new Set(c.portfolio.map((x) => x.physicalEventKey)).size, c.portfolio.length);
});

test("composition and excluded-class accounting are exact", () => {
  const a = pick("E1", "2026-09-10T01:00:00Z");
  const b = pick("E2", "2026-09-10T02:00:00Z");
  const c = pick("E3", "2026-09-10T03:00:00Z");
  const d = pick("E4", "2026-09-10T04:00:00Z");
  const structural = [struct(a, "moneyline"), struct(b, "total_corners"), struct(c, "total_corners"), struct(d, "weird_market")];
  const settle = new Map<string, CorpusLabel>([[a.candidateIdentity, "WIN"], [b.candidateIdentity, "WIN"], [c.candidateIdentity, "OPEN"], [d.candidateIdentity, "LOSS"]]);
  const comp = marketComposition([a, b, c, d], structural, settle);
  assert.equal(comp.MONEYLINE.SELECTED_N, 1);
  assert.equal(comp.TOTAL_CORNERS.SELECTED_N, 2);
  assert.equal(comp.TOTAL_CORNERS.SETTLED_N, 1);
  assert.equal(comp.TOTAL_CORNERS.OPEN_N, 1);
  assert.equal(comp.OTHER_STRUCTURED.SELECTED_N, 1);
  const ex = excludedClassEvents([a, b, c, d], [a], structural, settle, "TOTAL_CORNERS");
  assert.equal(ex.SELECTED_EVENT_N, 2);
  assert.equal(ex.WINNING_SELECTED_IDENTITY_N, 1);
  assert.equal(ex.OPEN_N, 1);
  assert.equal(ex.NOT_CLAIMED_BY_LIVE_B_N, 2);
});
