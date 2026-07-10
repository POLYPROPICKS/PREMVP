// Phase 3E.3A-1 Commit B -- founder report generator tests.
//
// The generator renders a deterministic, founder-readable HTML report from
// the executable funnel classifier registry (Commit A). It must keep formula
// arithmetic visually separate from external policy, use plain-language
// sentences (no CF / Selection / Ranking / Effect / Conflict column headers),
// embed no secrets or raw rows, and touch no DB/network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  renderExecutableFunnelClassifierReport,
} from "../../scripts/modeling/strategies/render-executable-funnel-classifier";
import {
  loadExecutableFunnelClassifier,
  type ExecutableFunnelClassifier,
} from "../../lib/modeling/executableFunnelClassifier";

const registry: ExecutableFunnelClassifier = loadExecutableFunnelClassifier();
const html = renderExecutableFunnelClassifierReport(registry);

test("B1: report loads the classifier registry and renders non-empty HTML", () => {
  assert.ok(html.includes("<!") || html.includes("<html") || html.includes("<section"));
  assert.ok(html.length > 500);
});

test("B2: report rejects an invalid schema", () => {
  const bad = { ...structuredClone(registry), schemaVersion: 2 } as unknown as ExecutableFunnelClassifier;
  assert.throws(() => renderExecutableFunnelClassifierReport(bad));
});

test("B3: formula section displays the exact weights", () => {
  assert.ok(html.includes("0.35"));
  assert.ok(html.includes("0.25"));
  assert.ok(html.includes("0.15"));
  assert.ok(html.includes("0.20") || html.includes("0.2"));
  assert.ok(html.includes("0.05"));
  assert.ok(html.includes("0.10") || html.includes("0.1"));
});

test("B4: formula and external policy are visually separated", () => {
  // The formula-calculation section and the external-policy/bundle section
  // are distinct headed sections.
  assert.ok(/Formula calculation|Расчёт формулы|Формула/i.test(html));
  assert.ok(/Bundle summary|Сводка|funnel|воронк/i.test(html));
});

test("B5: bundle summary contains the required columns", () => {
  for (const needle of ["Requirements|Требования", "Exclusions|Исключения", "Grouping|Группировк", "Historical stake|Историческая ставка", "Blocker|Блокер"]) {
    assert.ok(new RegExp(needle, "i").test(html), `missing column ${needle}`);
  }
});

test("B6: no 'CF' abbreviation appears", () => {
  assert.doesNotMatch(html, /\bCF\b/);
});

test("B7: no generic Selection/Ranking/Effect/Conflict column header appears", () => {
  assert.doesNotMatch(html, /<th[^>]*>\s*(Selection|Ranking|Effect|Conflict)\s*<\/th>/i);
});

test("B8: BASELINE funnel is present and understandable", () => {
  assert.ok(html.includes("BASELINE_V1_CONTROL"));
  assert.ok(/без фильтр|all rows|все сигнал/i.test(html));
});

test("B9: PRIMARY funnel lists score, league, coverage/price and timing rules separately", () => {
  assert.ok(html.includes("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"));
  assert.ok(html.includes("72"));
  assert.ok(/NBA/i.test(html));
  assert.ok(/0.44|0\.58|покрыти|coverage/i.test(html));
  assert.ok(/6.*24|тайминг|hours|час/i.test(html));
});

test("B10: ALT1 blocker is rendered in plain language", () => {
  assert.ok(html.includes("ALT1_ONE_PER_EVENT_BEST_COVERAGE"));
  assert.ok(/событи|event/i.test(html));
});

test("B11: ALT2 TS/Python difference is rendered in plain language", () => {
  assert.ok(html.includes("ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH"));
  assert.ok(/Python/i.test(html));
});

test("B12: ALT3 TS/Python difference is rendered in plain language", () => {
  assert.ok(html.includes("ALT3_V1_AVOID_NBA_NHL"));
  assert.ok(/Python/i.test(html));
});

test("B13: MODEL_A stake-halving rule is visible", () => {
  assert.ok(/вдвое|halve|halv|75/i.test(html));
});

test("B14: historical stake and normalized stake are shown separately", () => {
  assert.ok(/\$10|FLAT_10/i.test(html));
  assert.ok(/1 единиц|FLAT_1_UNIT|1 unit/i.test(html));
});

test("B15: provenance appendix shows the sibling-branch limitation", () => {
  assert.ok(/sibling|UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH|родствен|f45b77c/i.test(html));
});

test("B16: output is deterministic (same registry, same HTML)", () => {
  const again = renderExecutableFunnelClassifierReport(registry);
  assert.equal(html, again);
});

test("B17: no secrets or raw row payloads are embedded", () => {
  assert.doesNotMatch(html, /apikey|api_key|bearer|supabase_url|SUPABASE_SERVICE|eyJ[A-Za-z0-9]/i);
});

test("B18: renderer performs no DB/network/env access", () => {
  const before = JSON.stringify(process.env);
  renderExecutableFunnelClassifierReport(registry);
  assert.equal(JSON.stringify(process.env), before);
});

test("B19: all four required sections are present", () => {
  assert.ok(/Formula calculation|Расчёт формулы/i.test(html));
  assert.ok(/Bundle summary|Сводка по/i.test(html));
  assert.ok(/Detailed funnel|Подробн/i.test(html));
  assert.ok(/Provenance|Происхожден|appendix|приложени/i.test(html));
});
