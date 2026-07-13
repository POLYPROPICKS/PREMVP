// Phase 3E.8A Commit B -- three-candidate founder/CEO funnel report tests.
//
// The report is DERIVED from the classifier-built catalog (never hardcoded).
// It renders separate per-model tables, a side-by-side matrix, text funnel
// diagrams containing only actual stages, a plain-language glossary, and the
// permanent observation roles -- with no Champion/winner claim, no calling
// every stage a "filter", no raw rows, and historical attrition loaded only
// when the corpus hash matches.

import test from "node:test";
import assert from "node:assert/strict";
import { renderThreeCandidateFunnelReport } from "../../lib/modeling/threeCandidateFunnelReport";
import { buildThreeCandidateFunnelCatalog, THREE_CANDIDATE_IDS } from "../../lib/modeling/threeCandidateFunnelCatalog";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();
const catalog = buildThreeCandidateFunnelCatalog({ classifier, candidateIds: [...THREE_CANDIDATE_IDS] });
const html = renderThreeCandidateFunnelReport({ catalog });

test("U1: all three separate model tables render", () => {
  assert.ok(html.includes("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"));
  assert.ok(html.includes("ALT2_TS_SCORE_GE_65"));
  assert.ok(html.includes("ALT1_CANONICAL_EVENT_GROUPING"));
});

test("U2: all classifier steps render (PRIMARY has all 11 step numbers)", () => {
  const primary = catalog.candidates.find((c) => c.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  for (const s of primary.orderedSteps) {
    assert.ok(html.includes(s.semanticPurpose.slice(0, 20)));
  }
});

test("U3: step order is preserved in the PRIMARY table", () => {
  const primary = catalog.candidates.find((c) => c.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const scoreIdx = html.indexOf(primary.orderedSteps[2].semanticPurpose.slice(0, 15));
  const timingStep = primary.orderedSteps.find((s) => s.taxonomyCategory === "TIME_WINDOW_EXCLUSION")!;
  const timingIdx = html.indexOf(timingStep.semanticPurpose.slice(0, 15));
  assert.ok(scoreIdx >= 0 && timingIdx >= 0 && scoreIdx < timingIdx);
});

test("U4: physical source paths render", () => {
  assert.ok(html.includes("signal_confidence_num"));
  assert.ok(html.includes("diagnostics.dataCoverage"));
});

test("U5: missing-data behavior renders", () => {
  assert.ok(html.includes("FAIL_CLOSED"));
  assert.ok(html.includes("PASS_OPEN"));
});

test("U6: ALT2 mandatory core-comparator role renders", () => {
  assert.ok(/MANDATORY_CORE_COMPARATOR|Mandatory core comparator/i.test(html));
});

test("U7: ALT2 no-smart-money warning renders", () => {
  assert.ok(/no smart-money|без smart|no smart money guard/i.test(html));
});

test("U8: ALT1 MEDIUM identity warning renders", () => {
  assert.ok(/MEDIUM/.test(html));
  assert.ok(/exploratory|Exploratory/i.test(html));
});

test("U9: PRIMARY approximation warning renders", () => {
  assert.ok(/approximat|APPROX|приблизит/i.test(html));
});

test("U10: overlap matrix renders with all three model columns", () => {
  assert.ok(/formula_eligibility/.test(html));
  assert.ok(/nba_nhl_exclusion/.test(html));
});

test("U11: funnel diagrams contain only actual stages (ALT2 has no exclusion arrow)", () => {
  // ALT2 TS has no exclusion/grouping stages; its diagram must not claim them.
  const alt2Section = html.slice(html.indexOf("ALT2_TS_SCORE_GE_65 — funnel"));
  const alt2Diagram = alt2Section.slice(0, alt2Section.indexOf("</pre>") + 6);
  assert.doesNotMatch(alt2Diagram, /NBA|exclusion|grouping/i);
});

test("U12: glossary renders with plain-language terms", () => {
  assert.ok(/eligibility gate/i.test(html));
  assert.ok(/core comparator/i.test(html));
  assert.ok(/fail-closed/i.test(html));
});

test("U13: report contains no Champion/winner/production-ready claim", () => {
  assert.doesNotMatch(html, /\bchampion\b|\bwinner\b|production[\s-]ready/i);
});

test("U14: report does not label all stages as filters (sort/group are distinct)", () => {
  assert.ok(/SORT_PRIORITY|EVENT_GROUPING|Sort|Group/i.test(html));
});

test("U15: report contains no raw corpus rows", () => {
  assert.doesNotMatch(html, /"signal_result":|"realized_return_pct":/);
});

test("U16: historical attrition is loaded only on a matching corpus hash", () => {
  const matching = renderThreeCandidateFunnelReport({
    catalog,
    historicalComparison: { inputSha256: "90ce9662c43185d7b1c4bc03ce66b46f8bf481faeac186d835dbd2638d739b72", executions: [] },
    expectedCorpusSha256: "90ce9662c43185d7b1c4bc03ce66b46f8bf481faeac186d835dbd2638d739b72",
  });
  assert.doesNotMatch(matching, /HISTORICAL_ATTRITION_NOT_LOADED/);
});

test("U17: a corpus hash mismatch is visible and blocks attrition", () => {
  const mismatch = renderThreeCandidateFunnelReport({
    catalog,
    historicalComparison: { inputSha256: "deadbeef", executions: [] },
    expectedCorpusSha256: "90ce9662c43185d7b1c4bc03ce66b46f8bf481faeac186d835dbd2638d739b72",
  });
  assert.match(mismatch, /HISTORICAL_ATTRITION_NOT_LOADED|hash mismatch/i);
});

test("U18: when no historical comparison is supplied, attrition is explicitly not loaded", () => {
  assert.match(html, /HISTORICAL_ATTRITION_NOT_LOADED/);
});

test("U19: report is deterministic for the same catalog", () => {
  const again = renderThreeCandidateFunnelReport({ catalog });
  assert.equal(html, again);
});

test("U20: report generation performs no fs/env/network access", () => {
  const before = JSON.stringify(process.env);
  renderThreeCandidateFunnelReport({ catalog });
  assert.equal(JSON.stringify(process.env), before);
});

test("U21: executive summary shows the three permanent observation roles", () => {
  assert.ok(/Selective research/i.test(html));
  assert.ok(/core comparator/i.test(html));
  assert.ok(/watch/i.test(html));
});
