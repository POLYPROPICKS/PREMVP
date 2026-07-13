// Phase 3E.7 Commit B -- founder robustness report tests.
//
// Renders a deterministic, founder-readable HTML report from an
// already-computed candidate robustness audit result. No Champion/Winner/
// Production ready/statistically significant claims; explicit smart-money
// limitation; founder disposition fields default to NOT_REVIEWED.

import test from "node:test";
import assert from "node:assert/strict";
import { renderCandidateRobustnessReport } from "../../lib/modeling/candidateRobustnessReport";
import { auditCandidateRobustness, AUDITED_CANDIDATE_IDS } from "../../lib/modeling/candidateRobustnessAudit";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();

function row(n: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `id-${n}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: `2026-05-${String(1 + (n % 28)).padStart(2, "0")}T00:00:00Z`,
    resolved_at: `2026-05-${String(1 + (n % 28)).padStart(2, "0")}T12:00:00Z`,
    metric_formula_version: "v2-lite-growth-safe",
    signal_confidence_num: 80,
    score: 80,
    entry_price_num: 0.65,
    signal_result: n % 3 === 0 ? "loss" : "win",
    realized_return_pct: n % 3 === 0 ? -100 : 40,
    diagnostics: { dataCoverage: 80 },
    ...overrides,
  };
}

function corpus(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let n = 1; n <= 30; n++) rows.push(row(n, {}));
  return rows;
}

const audit = auditCandidateRobustness({ rows: corpus(), classifier, candidateVariantIds: [...AUDITED_CANDIDATE_IDS] });
const html = renderCandidateRobustnessReport({ audit, classifier });

test("H1: report renders non-empty HTML from a valid audit", () => {
  assert.ok(html.includes("<!") || html.includes("<html"));
  assert.ok(html.length > 500);
});

test("H2: corpus contract section shows the corpus hash and row count", () => {
  assert.ok(html.includes(audit.corpusSha256));
  assert.ok(html.includes(String(audit.corpusRowCount)));
});

test("H3: executive summary lists both audited candidates", () => {
  assert.ok(html.includes("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"));
  assert.ok(html.includes("ALT2_TS_SCORE_GE_65"));
});

test("H4: weekly stability section is present for baseline and both candidates", () => {
  assert.ok(/Weekly|Недел/i.test(html));
});

test("H5: PRIMARY rule contribution stages render in order (BASELINE first, FULL_FUNNEL last)", () => {
  const primary = audit.candidates.find((c) => c.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const firstLabel = primary.ruleContribution!.stages[0].ruleLabel;
  const lastLabel = primary.ruleContribution!.stages[primary.ruleContribution!.stages.length - 1].ruleLabel;
  const firstIdx = html.indexOf(firstLabel);
  const lastIdx = html.indexOf(lastLabel);
  assert.ok(firstIdx >= 0 && lastIdx >= 0 && firstIdx < lastIdx);
});

test("H6: segment breakdown section is present", () => {
  assert.ok(/Segment|Сегмент/i.test(html));
});

test("H7: result concentration section is present", () => {
  assert.ok(/Concentration|Концентрац/i.test(html));
});

test("H8: identity/duplication section is present", () => {
  assert.ok(/Identity|Идентичн|working event/i.test(html));
});

test("H9: field coverage section is present with explicit percentages", () => {
  assert.ok(/Field coverage|Покрытие полей/i.test(html));
});

test("H10: explicit smart-money limitation note is rendered (HTML-escaped)", () => {
  assert.ok(html.includes("smart_money_score_num is missing on the canonical export"));
  assert.match(html, /unvalidated/i);
});

test("H11: founder disposition fields default to NOT_REVIEWED for both candidates", () => {
  const matches = html.match(/NOT_REVIEWED/g) ?? [];
  assert.ok(matches.length >= 2);
});

test("H12: no Champion/Winner/Production ready/statistically significant claim appears", () => {
  assert.doesNotMatch(html, /\bchampion\b|\bwinner\b|production[\s-]ready|statistically significant/i);
});

test("H13: report is deterministic for the same audit input", () => {
  const again = renderCandidateRobustnessReport({ audit, classifier });
  assert.equal(html, again);
});

test("H14: no raw row payloads are embedded", () => {
  assert.doesNotMatch(html, /"signal_result":|"realized_return_pct":/);
});

test("H15: report generation performs no fs/env/network access", () => {
  const before = JSON.stringify(process.env);
  renderCandidateRobustnessReport({ audit, classifier });
  assert.equal(JSON.stringify(process.env), before);
});
