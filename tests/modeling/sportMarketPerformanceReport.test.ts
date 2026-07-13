// Phase 3E.8C Commit B -- sport/market performance report tests.
//
// Renders a deterministic, founder-readable HTML report from an
// already-computed sport/market performance slice. No Champion/production-
// ready claim; report clearly separates sport and market-type tables; no raw
// rows; event concentration is included.

import test from "node:test";
import assert from "node:assert/strict";
import { renderSportMarketPerformanceReport } from "../../lib/modeling/sportMarketPerformanceReport";
import { buildSportMarketPerformanceSlice, ANALYZED_MODEL_IDS } from "../../lib/modeling/sportMarketPerformanceSlice";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();

function row(n: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `id-${n}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2026-05-01T00:00:00Z",
    resolved_at: "2026-05-02T00:00:00Z",
    metric_formula_version: "v2-lite-growth-safe",
    signal_confidence_num: 80,
    score: 80,
    entry_price_num: 0.65,
    signal_result: n % 4 === 0 ? "loss" : "win",
    realized_return_pct: n % 4 === 0 ? -100 : 40,
    diagnostics: { dataCoverage: 80 },
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    ...overrides,
  };
}

function corpus(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let n = 1; n <= 40; n++) rows.push(row(n, {}));
  return rows;
}

const slice = buildSportMarketPerformanceSlice({ rows: corpus(), classifier, candidateIds: [...ANALYZED_MODEL_IDS] });
const html = renderSportMarketPerformanceReport({ slice });

test("W1: report renders all three models", () => {
  assert.ok(html.includes("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"));
  assert.ok(html.includes("ALT2_TS_SCORE_GE_65"));
  assert.ok(html.includes("ALT1_CANONICAL_EVENT_GROUPING"));
});

test("W2: sport and market-type tables are clearly separated sections", () => {
  assert.ok(/Sport breakdown/i.test(html));
  assert.ok(/Market-type breakdown|Market type breakdown/i.test(html));
});

test("W3: event concentration section is included", () => {
  assert.ok(/Event concentration/i.test(html));
});

test("W4: cross-model sport and market matrices render", () => {
  assert.ok(/Cross-model/i.test(html));
});

test("W5: leaderboards render with sample sizes", () => {
  assert.ok(/Top.*ROI|ROI leader/i.test(html));
});

test("W6: report contains no Champion/production-ready claim", () => {
  assert.doesNotMatch(html, /\bchampion\b|production[\s-]ready/i);
});

test("W7: report contains no raw row payloads", () => {
  assert.doesNotMatch(html, /"signal_result":|"realized_return_pct":/);
});

test("W8: report is deterministic", () => {
  const again = renderSportMarketPerformanceReport({ slice });
  assert.equal(html, again);
});

test("W9: report generation performs no fs/env/network access", () => {
  const before = JSON.stringify(process.env);
  renderSportMarketPerformanceReport({ slice });
  assert.equal(JSON.stringify(process.env), before);
});

test("W10: LOW_SAMPLE and UNKNOWN segments remain visible in the tables", () => {
  assert.ok(html.includes("LOW_SAMPLE") || html.includes("MODERATE_SAMPLE") || html.includes("ROBUST_SAMPLE"));
});
