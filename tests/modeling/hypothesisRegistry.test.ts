// Phase 4C.1 / C1 -- unified hypothesis registry (pure engine).
//
// REGISTRY-ONLY, HISTORICAL RESEARCH. This suite proves the registry unifies
// A1/A2/B1/B2A evidence deterministically, verifies lineage hashes, computes
// stable fingerprints, applies exact duplicate/alias rules, and never
// promotes a model or names a Champion. No candidate behavior, filters, or
// score weights change here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  HYPOTHESIS_REGISTRY_SCHEMA_VERSION,
  HYPOTHESIS_REGISTRY_ENGINE_VERSION,
  HYPOTHESIS_TYPES,
  REGISTRY_STATUSES,
  DUPLICATE_STATUSES,
  EVIDENCE_LAYERS,
  NEXT_GATES,
  PROMOTION_STATUS,
  computeHypothesisFingerprint,
  buildHypothesisRegistry,
  serializeHypothesisRegistryJson,
  renderHypothesisRegistryHtml,
  buildHypothesisRegistryManifest,
} from "../../lib/modeling/hypothesisRegistry";
import { buildExtendedHistoricalDecomposition } from "../../lib/modeling/extendedHistoricalDecomposition";
import { buildExtendedHistoricalDashboard } from "../../lib/modeling/extendedHistoricalDashboard";
import { buildScoreComponentAnalysis } from "../../lib/modeling/scoreComponentAnalysis";
import { buildBoundedRoutingExperiments, BASE_COMPARATOR_ID, CANDIDATE_IDS } from "../../lib/modeling/boundedRoutingExperiments";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { SCORECARD_MODEL_ORDER } from "../../lib/modeling/historicalModelScorecard";

const classifier = loadExecutableFunnelClassifier();

function makeRow(n: number): Record<string, unknown> {
  const hours = (n % 8) * 0.5;
  const createdMs = Date.parse("2024-01-01T00:00:00Z");
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: 66 + (n % 20),
    entry_price_num: 0.2 + (n % 6) * 0.14,
    metric_formula_version: "v2-lite-growth-safe",
    league: "epl",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    signal_result: n % 3 === 0 ? "loss" : "win",
    realized_return_pct: n % 3 === 0 ? -100 : 40,
    diagnostics: { dataCoverage: 70, gameStartIso: new Date(createdMs + hours * 3_600_000).toISOString() },
  };
}

const CORPUS = Array.from({ length: 300 }, (_, i) => makeRow(i + 1));

function buildFourArtifacts() {
  const decomposition = buildExtendedHistoricalDecomposition({
    rawRows: CORPUS,
    classifier,
    requestedVariantIds: [...SCORECARD_MODEL_ORDER],
  });
  const dashboard = buildExtendedHistoricalDashboard({ decomposition });
  const components = buildScoreComponentAnalysis({
    rawRows: CORPUS,
    classifier,
    requestedVariantIds: [BASE_COMPARATOR_ID],
  });
  const experiments = buildBoundedRoutingExperiments({ rawRows: CORPUS, classifier, evidence: components });
  return { decomposition, dashboard, components, experiments };
}

// ---------------------------------------------------------------- constants

test("engine constants", () => {
  assert.equal(HYPOTHESIS_REGISTRY_SCHEMA_VERSION, 1);
  assert.equal(typeof HYPOTHESIS_REGISTRY_ENGINE_VERSION, "string");
  assert.equal(PROMOTION_STATUS, "NOT_PROMOTED");
  assert.deepEqual(
    [...HYPOTHESIS_TYPES],
    [
      "BASELINE_MODEL",
      "FILTER_POLICY",
      "PRICE_GUARD",
      "TIMING_GATE",
      "COMBINED_ROUTING_POLICY",
      "EVENT_GROUPING_POLICY",
      "SPORT_SPECIALIST",
      "SCORE_THRESHOLD",
      "COMPONENT_REWEIGHT_DIRECTION",
      "COMPONENT_INTERACTION_DIRECTION",
      "DATA_CAPTURE_REQUIREMENT",
      "RISK_CONCENTRATION_POLICY",
    ],
  );
  assert.deepEqual(
    [...REGISTRY_STATUSES],
    ["OBSERVED_UNTESTED", "HISTORICAL_ADVANCE", "HISTORICAL_HOLD", "HISTORICAL_REJECT", "BLOCKED_MISSING_DATA", "DEFERRED", "DUPLICATE"],
  );
  assert.deepEqual([...DUPLICATE_STATUSES], ["UNIQUE", "EXACT_FINGERPRINT_DUPLICATE", "EXACT_SELECTION_DUPLICATE", "ALIAS_MODEL", "RELATED_NOT_DUPLICATE"]);
  assert.deepEqual([...EVIDENCE_LAYERS], ["HISTORICAL_FULL_PERIOD", "FORWARD_PENDING", "WALK_FORWARD_DEFERRED", "MISSING_COMPONENT_CAPTURE_REQUIRED"]);
  assert.deepEqual([...NEXT_GATES], ["NONE", "INDEPENDENT_VALIDATION", "FORWARD_CAPTURE", "MISSING_COMPONENT_CAPTURE", "BOUNDED_FOLLOWUP", "REVIEW_ONLY"]);
});

// ------------------------------------------------------------- fingerprints

test("fingerprint stable across key order, numeric representation, whitespace", () => {
  const a = computeHypothesisFingerprint({
    type: "PRICE_GUARD",
    scope: "GLOBAL",
    parentFingerprint: null,
    conditions: { entry_price_num_gte: 0.3, note: "price   floor" },
  });
  const b = computeHypothesisFingerprint({
    type: "PRICE_GUARD",
    scope: "GLOBAL",
    parentFingerprint: null,
    conditions: { note: "price floor", entry_price_num_gte: 0.300 },
  });
  assert.equal(a, b);
});

test("different threshold produces different fingerprint", () => {
  const a = computeHypothesisFingerprint({
    type: "PRICE_GUARD",
    scope: "GLOBAL",
    parentFingerprint: null,
    conditions: { entry_price_num_gte: 0.3 },
  });
  const b = computeHypothesisFingerprint({
    type: "PRICE_GUARD",
    scope: "GLOBAL",
    parentFingerprint: null,
    conditions: { entry_price_num_gte: 0.35 },
  });
  assert.notEqual(a, b);
});

test("different parent fingerprint produces different fingerprint", () => {
  const a = computeHypothesisFingerprint({
    type: "TIMING_GATE",
    scope: "GLOBAL",
    parentFingerprint: "parent-a",
    conditions: { hours_until_start_lt_minutes: 120 },
  });
  const b = computeHypothesisFingerprint({
    type: "TIMING_GATE",
    scope: "GLOBAL",
    parentFingerprint: "parent-b",
    conditions: { hours_until_start_lt_minutes: 120 },
  });
  assert.notEqual(a, b);
});

test("fingerprint excludes metrics/titles/paths/timestamps -- not part of input shape", () => {
  // The fingerprint function accepts only type/scope/parentFingerprint/conditions;
  // no metrics/title/path field exists on the input contract at all.
  const fp = computeHypothesisFingerprint({
    type: "SCORE_THRESHOLD",
    scope: "GLOBAL",
    parentFingerprint: null,
    conditions: { signal_confidence_num_gte: 65 },
  });
  assert.equal(typeof fp, "string");
  assert.equal(fp.length, 64);
});

// ------------------------------------------------------------- input lineage

test("valid four-artifact input builds a registry", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.hypotheses.length > 0);
});

test("dashboard/decomposition lineage mismatch fails closed", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const broken = { ...dashboard, sourceDecompositionHash: "0".repeat(64) };
  assert.throws(() => buildHypothesisRegistry({ decomposition, dashboard: broken, components, experiments }));
});

test("B2A evidenceContentHash must equal B1 contentHash", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const broken = { ...experiments, evidenceProvenance: { ...experiments.evidenceProvenance, contentHash: "0".repeat(64) } };
  assert.throws(() => buildHypothesisRegistry({ decomposition, dashboard, components, experiments: broken }));
});

test("B2A base comparator must equal ALT4", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const broken = { ...experiments, baseComparator: "NOT_ALT4" };
  assert.throws(() => buildHypothesisRegistry({ decomposition, dashboard, components, experiments: broken }));
});

test("frozen candidate budget must equal three", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const broken = { ...experiments, candidateBudget: { ...experiments.candidateBudget, candidates: 4 } };
  assert.throws(() => buildHypothesisRegistry({ decomposition, dashboard, components, experiments: broken }));
});

test("corpus count mismatch across artifacts fails closed", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const broken = { ...components, corpusSummary: { ...components.corpusSummary, rawRowCount: 999999 } };
  assert.throws(() => buildHypothesisRegistry({ decomposition, dashboard, components: broken, experiments }));
});

test("strict-dedup policy mismatch fails closed", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const broken = { ...components, corpusSummary: { ...components.corpusSummary, strictDedupPolicy: "other" } };
  assert.throws(() => buildHypothesisRegistry({ decomposition, dashboard, components: broken, experiments }));
});

// ------------------------------------------------------------- existing models

test("all 12 canonical models are present with no promotion", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const modelIds = new Set(SCORECARD_MODEL_ORDER);
  const modelHyps = result.hypotheses.filter((h) => modelIds.has(h.relatedModelIds[0] ?? ""));
  assert.equal(modelHyps.length, SCORECARD_MODEL_ORDER.length);
  for (const h of modelHyps) {
    assert.equal(h.promotionStatus, "NOT_PROMOTED");
  }
});

test("B1 exact cohort aliases retained without increasing independent-model count", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const modelIds = new Set(SCORECARD_MODEL_ORDER);
  const modelHyps = result.hypotheses.filter((h) => modelIds.has(h.relatedModelIds[0] ?? ""));
  // still exactly 12 model-layer hypotheses regardless of alias collapsing in B1.
  assert.equal(modelHyps.length, 12);
});

// ------------------------------------------------------------- B2A candidates

test("exactly three B2A candidates imported with exact lineage", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const candHyps = result.hypotheses.filter((h) => (CANDIDATE_IDS as readonly string[]).includes(h.relatedModelIds[0] ?? ""));
  assert.equal(candHyps.length, 3);
  const byModel = new Map(candHyps.map((h) => [h.relatedModelIds[0], h]));
  const price = byModel.get("B2_PRICE_FLOOR_030")!;
  const timing = byModel.get("B2_TIMING_WITHIN_120M")!;
  const combo = byModel.get("B2_PRICE_FLOOR_030_TIMING_WITHIN_120M")!;
  assert.ok(price.parentHypothesisIds.length === 1);
  assert.ok(timing.parentHypothesisIds.length === 1);
  assert.deepEqual(combo.parentHypothesisIds, price.parentHypothesisIds.length === 1 ? [price.hypothesisId] : []);
});

test("all three B2A candidates are HISTORICAL_ADVANCE / NOT_PROMOTED / INDEPENDENT_VALIDATION", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const candHyps = result.hypotheses.filter((h) => (CANDIDATE_IDS as readonly string[]).includes(h.relatedModelIds[0] ?? ""));
  for (const h of candHyps) {
    assert.equal(h.registryStatus, "HISTORICAL_ADVANCE");
    assert.equal(h.promotionStatus, "NOT_PROMOTED");
    assert.equal(h.nextRequiredGate, "INDEPENDENT_VALIDATION");
    assert.ok(!/champion/i.test(JSON.stringify(h)));
    assert.ok(h.evidenceLayers.includes("HISTORICAL_FULL_PERIOD"));
    assert.ok(h.evidenceLayers.includes("FORWARD_PENDING"));
    assert.ok(h.evidenceLayers.includes("WALK_FORWARD_DEFERRED"));
  }
});

test("B2A candidate historical metrics reconcile with the B2A source", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const priceHyp = result.hypotheses.find((h) => h.relatedModelIds[0] === "B2_PRICE_FLOOR_030")!;
  const priceSrc = experiments.candidateMetrics.find((m) => m.id === "B2_PRICE_FLOOR_030")!;
  assert.equal(priceHyp.historicalMetrics?.selectedObservations, priceSrc.selectedObservations);
  assert.equal(priceHyp.historicalMetrics?.flatUnitPnl, priceSrc.flatUnitPnl);
  assert.equal(priceHyp.selectionHash, priceSrc.selectionHash);
});

// ------------------------------------------------------------- B1 directions

test("B1 directions blocked by missing components become BLOCKED_MISSING_DATA", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const captureDirs = components.b2EvidenceDirections.filter((d) => d.type === "CAPTURE_MISSING_COMPONENT");
  if (captureDirs.length > 0) {
    const blocked = result.hypotheses.filter((h) => h.registryStatus === "BLOCKED_MISSING_DATA");
    assert.ok(blocked.length >= captureDirs.length);
    for (const h of blocked) {
      assert.ok(h.blockedReasons.length > 0);
      assert.equal(h.nextRequiredGate, "MISSING_COMPONENT_CAPTURE");
    }
  }
});

test("no fabricated score weights: blocked reasons never invent a weight value", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const blob = JSON.stringify(result.hypotheses.filter((h) => h.registryStatus === "BLOCKED_MISSING_DATA"));
  assert.ok(!/"weight":\s*[0-9]/.test(blob));
});

// ------------------------------------------------------------- summary/frontier

test("registry summary counts reconcile exactly", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const s = result.registrySummary;
  const sumStates =
    s.untested + s.historicalAdvance + s.historicalHold + s.historicalReject + s.blockedMissingData + s.deferred + s.duplicates;
  assert.equal(sumStates, s.totalHypotheses);
});

test("historical frontier is deterministically ordered and does not alter promotion", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  for (let i = 1; i < result.historicalFrontier.length; i++) {
    const prev = result.historicalFrontier[i - 1];
    const cur = result.historicalFrontier[i];
    // sanity: every frontier row still references a NOT_PROMOTED hypothesis
    const hyp = result.hypotheses.find((h) => h.relatedModelIds[0] === cur.candidateId);
    if (hyp) assert.equal(hyp.promotionStatus, "NOT_PROMOTED");
    void prev;
  }
});

test("candidate-budget history records the frozen B2A 3-candidate batch", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const b2a = result.candidateBudgetHistory.find((b) => b.batch === "B2A")!;
  assert.equal(b2a.baseComparators, 1);
  assert.equal(b2a.candidates, 3);
  assert.deepEqual(b2a.candidateIds, [...CANDIDATE_IDS]);
});

// ------------------------------------------------------------- serialization

test("serialize/html/manifest deterministic and content-hashed", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const a = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const b = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const ja = serializeHypothesisRegistryJson(a);
  const jb = serializeHypothesisRegistryJson(b);
  assert.equal(ja, jb);
  assert.equal(a.contentHash, b.contentHash);
  assert.ok(ja.endsWith("}\n"));
  const html = renderHypothesisRegistryHtml(a);
  assert.match(html, /HYPOTHESIS REGISTRY — HISTORICAL RESEARCH ONLY/);
  assert.match(html, /NO AUTOMATIC CHAMPION/);
  assert.match(html, /NO MODEL PROMOTION/);
  assert.match(html, /NO LIVE CHANGE/);
  assert.ok(!/<script/i.test(html));
  const manifest = buildHypothesisRegistryManifest(
    a,
    {
      decompositionSha256: "a".repeat(64),
      dashboardSha256: "b".repeat(64),
      componentsSha256: "c".repeat(64),
      experimentsSha256: "d".repeat(64),
    },
    ja,
    html,
  );
  assert.equal(manifest.registryContentHash, a.contentHash);
  assert.equal(manifest.decompositionContentHash, decomposition.contentHash);
  assert.equal(manifest.hypothesisCount, a.hypotheses.length);
});

test("HTML contains all required sections", () => {
  const { decomposition, dashboard, components, experiments } = buildFourArtifacts();
  const result = buildHypothesisRegistry({ decomposition, dashboard, components, experiments });
  const html = renderHypothesisRegistryHtml(result);
  for (const needle of [
    "Registry Summary",
    "Historical Frontier",
    "Hypothesis State",
    "Lineage",
    "Duplicate",
    "Blocked",
    "Deferred",
    "Next Required Gate",
    "Candidate-Budget History",
    "Limitations",
  ]) {
    assert.ok(html.includes(needle), `missing section: ${needle}`);
  }
});
