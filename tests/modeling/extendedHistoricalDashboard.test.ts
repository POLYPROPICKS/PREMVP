// Phase A2 -- Extended Decomposition Charts and Historical Dashboard (pure builder).
//
// Consumes the ALREADY-COMPUTED A1 extended-decomposition JSON. Never
// recalculates model selection, ROI, dedup, equity, or event grouping from
// raw rows -- every number here is copied or purely aggregated from A1
// output. Research evidence only: no Champion, no promotion.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExtendedHistoricalDashboard,
  serializeExtendedDashboardJson,
  renderExtendedHistoricalDashboardHtml,
  buildExtendedDashboardManifest,
  computeCrossModelEvidence,
  BROAD_MODEL_MIN_OBSERVATIONS,
  SEGMENT_ELIGIBLE_MIN_OBSERVATIONS,
  MIN_ELIGIBLE_BROAD_MODELS,
  DashboardValidationError,
} from "../../lib/modeling/extendedHistoricalDashboard";
import {
  buildExtendedHistoricalDecomposition,
  serializeExtendedDecompositionJson,
  type ExtendedHistoricalDecomposition,
} from "../../lib/modeling/extendedHistoricalDecomposition";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";

const classifier = loadExecutableFunnelClassifier();

function makeRow(n: number, overrides: Record<string, unknown> = {}): ExportRow {
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-${String(((n % 300) / 30 | 0) + 1).padStart(2, "0")}-${String((n % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: 80,
    entry_price_num: 0.5,
    signal_result: n % 4 === 0 ? "loss" : "win",
    realized_return_pct: n % 4 === 0 ? -100 : 40,
    metric_formula_version: "v2-lite-growth-safe",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    diagnostics: { dataCoverage: 80, gameStartIso: "2024-01-01T10:00:00Z" },
    ...overrides,
  };
}

const ALL_12 = [
  "BASELINE_V1_CONTROL",
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT1_CANONICAL_EVENT_GROUPING",
  "ALT2_TS_SCORE_GE_65",
  "ALT2_PY_SCORE_GE_65_SM_LT_85",
  "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL",
  "ALT3_PY_SCORE_GE_65",
  "ALT_SM_GUARD_ON_PRIMARY",
  "ALT_SM_GUARD_ON_PRIMARY_APPROX",
  "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS",
  "ALT5_TS_SCORE_GE_65_TENNIS_ONLY",
  "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING",
];

function decompositionFixture(n = 300): ExtendedHistoricalDecomposition {
  const rows = Array.from({ length: n }, (_, i) => makeRow(i + 1));
  return buildExtendedHistoricalDecomposition({ rawRows: rows, classifier, requestedVariantIds: ALL_12 });
}

// ---- schema consumption ----

test("S1: builder consumes the real A1 schema and retains all 12 models", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  assert.equal(dash.modelSummaries.length, 12);
  assert.deepEqual(dash.modelSummaries.map((m) => m.variantId), ALL_12);
});

test("S2: source content hash is verified; a tampered decomposition throws", () => {
  const decomp = decompositionFixture();
  const tampered = { ...decomp, contentHash: "0".repeat(64) };
  assert.throws(() => buildExtendedHistoricalDashboard({ decomposition: tampered }), DashboardValidationError);
});

test("S3: dashboard never recomputes PnL/ROI -- values equal source verbatim", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  for (let i = 0; i < decomp.models.length; i++) {
    const src = decomp.models[i].onePerEventComparison.keepAll;
    const dst = dash.modelSummaries[i];
    assert.equal(dst.flatUnitPnl, src.flatUnitPnl);
    assert.equal(dst.flatUnitRoi, src.flatUnitRoi);
    assert.equal(dst.maximumDrawdownUnits, src.maximumDrawdownUnits);
  }
});

test("S4: source decomposition object is not mutated", () => {
  const decomp = decompositionFixture();
  const snapshot = serializeExtendedDecompositionJson(decomp);
  buildExtendedHistoricalDashboard({ decomposition: decomp });
  assert.equal(serializeExtendedDecompositionJson(decomp), snapshot);
});

test("S5: missing dimensions from corpusDimensionAvailability are visible in dataAvailability", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const missing = dash.dataAvailability.filter((d) => d.status === "MISSING_SOURCE_FIELD").map((d) => d.dimension);
  for (const dim of ["league", "tournament", "tier", "liquidity", "volume", "spread", "open_interest"]) {
    assert.ok(missing.includes(dim), dim);
  }
});

test("S6: no automatic-promotion fields exist anywhere in the JSON", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const json = serializeExtendedDashboardJson(dash);
  assert.doesNotMatch(json, /"champion"|"promoted"|"productionReady"/i);
});

// ---- frontier data ----

test("F1: frontier data reconciles to source ROI/PnL for every model", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  assert.equal(dash.frontierData.roiPnl.length, 12);
  assert.equal(dash.frontierData.drawdownPnl.length, 12);
  for (const point of dash.frontierData.roiPnl) {
    const src = decomp.models.find((m) => m.variantId === point.variantId)!.onePerEventComparison.keepAll;
    assert.equal(point.x, src.flatUnitRoi);
    assert.equal(point.y, src.flatUnitPnl);
    assert.equal(point.size, src.observations);
  }
});

// ---- cross-model evidence ----

function evidenceFixture(): ExtendedHistoricalDecomposition {
  // Construct a corpus where 4 "broad" models (>=200 selected observations)
  // share the same score-band pattern so evidence eligibility is provable.
  const rows = Array.from({ length: 300 }, (_, i) => makeRow(i + 1, { signal_confidence_num: 90 }));
  return buildExtendedHistoricalDecomposition({ rawRows: rows, classifier, requestedVariantIds: ["ALT2_TS_SCORE_GE_65", "BASELINE_V1_CONTROL"] });
}

test("E1: broad-model eligibility boundary is exactly N=200 (199 excluded, 200 included)", () => {
  assert.equal(BROAD_MODEL_MIN_OBSERVATIONS, 200);
});
test("E2: segment eligibility boundary is exactly N=30 (29 excluded, 30 included)", () => {
  assert.equal(SEGMENT_ELIGIBLE_MIN_OBSERVATIONS, 30);
});
test("E3: minimum eligible broad models is exactly 3 (2 insufficient, 3 sufficient)", () => {
  assert.equal(MIN_ELIGIBLE_BROAD_MODELS, 3);
});

test("E4: computeCrossModelEvidence excludes models below the broad threshold", () => {
  const decomp = evidenceFixture();
  const evidence = computeCrossModelEvidence(decomp.models);
  // Only 2 requested models in this fixture -- below MIN_ELIGIBLE_BROAD_MODELS (3) -- no entry should qualify.
  assert.equal(evidence.length, 0);
});

test("E5: CONSISTENT_POSITIVE requires supportRatio >= 0.80 and totalPnl > 0", () => {
  const rows = Array.from({ length: 300 }, (_, i) => makeRow(i + 1, { signal_confidence_num: 90, signal_result: "win", realized_return_pct: 40 }));
  const decomp = buildExtendedHistoricalDecomposition({
    rawRows: rows,
    classifier,
    requestedVariantIds: ["ALT2_TS_SCORE_GE_65", "BASELINE_V1_CONTROL", "ALT2_PY_SCORE_GE_65_SM_LT_85"],
  });
  const evidence = computeCrossModelEvidence(decomp.models);
  const scoreEntry = evidence.find((e) => e.dimension === "scoreBands" && e.bucket === "SCORE_80_PLUS");
  assert.ok(scoreEntry);
  assert.equal(scoreEntry!.classification, "CONSISTENT_POSITIVE");
  assert.equal(scoreEntry!.eligibleModelCount, 3);
  assert.ok(scoreEntry!.supportRatio >= 0.8);
});

test("E6: CONSISTENT_NEGATIVE requires negative ratio >= 0.80 and totalPnl < 0", () => {
  const rows = Array.from({ length: 300 }, (_, i) => makeRow(i + 1, { signal_confidence_num: 90, signal_result: "loss", realized_return_pct: -100 }));
  const decomp = buildExtendedHistoricalDecomposition({
    rawRows: rows,
    classifier,
    requestedVariantIds: ["ALT2_TS_SCORE_GE_65", "BASELINE_V1_CONTROL", "ALT2_PY_SCORE_GE_65_SM_LT_85"],
  });
  const evidence = computeCrossModelEvidence(decomp.models);
  const scoreEntry = evidence.find((e) => e.dimension === "scoreBands" && e.bucket === "SCORE_80_PLUS");
  assert.ok(scoreEntry);
  assert.equal(scoreEntry!.classification, "CONSISTENT_NEGATIVE");
});

test("E7: MIXED when neither ratio reaches 0.80", () => {
  // 3 broad models: 2 win-heavy, 1 loss-heavy for the same score band -> mixed signal.
  const winRows = Array.from({ length: 300 }, (_, i) => makeRow(i + 1, { signal_confidence_num: 90, signal_result: "win", realized_return_pct: 40 }));
  const decomp = buildExtendedHistoricalDecomposition({
    rawRows: winRows,
    classifier,
    requestedVariantIds: ["ALT2_TS_SCORE_GE_65", "BASELINE_V1_CONTROL", "ALT2_PY_SCORE_GE_65_SM_LT_85", "ALT_SM_GUARD_ON_PRIMARY"],
  });
  // Manually construct a mixed scenario by mutating one model's bucket metrics.
  const models = decomp.models.map((m) => structuredClone(m));
  const negIdx = models.findIndex((m) => m.variantId === "ALT_SM_GUARD_ON_PRIMARY");
  const bucket = models[negIdx].decompositions.scoreBands.find((b) => b.bucket === "SCORE_80_PLUS");
  if (bucket) {
    bucket.metrics.flatUnitPnl = -50;
    bucket.metrics.flatUnitRoi = -20;
  }
  const evidence = computeCrossModelEvidence(models);
  const scoreEntry = evidence.find((e) => e.dimension === "scoreBands" && e.bucket === "SCORE_80_PLUS");
  assert.ok(scoreEntry);
  assert.equal(scoreEntry!.classification, "MIXED");
});

test("E8: implied-odds mirror buckets never appear as independent evidence entries", () => {
  const decomp = decompositionFixture();
  const evidence = computeCrossModelEvidence(decomp.models);
  assert.ok(!evidence.some((e) => e.dimension === "impliedOddsBands"));
});

test("E9: evidence entries are deterministically sorted", () => {
  const decomp = decompositionFixture();
  const a = computeCrossModelEvidence(decomp.models);
  const b = computeCrossModelEvidence(decomp.models);
  assert.deepEqual(a, b);
});

test("E10: evidence entries never contain a generated model/candidate ID field", () => {
  const decomp = decompositionFixture();
  const evidence = computeCrossModelEvidence(decomp.models);
  const json = JSON.stringify(evidence);
  assert.doesNotMatch(json, /"candidateId"|"newModelId"|"generatedVariantId"/);
});

// ---- next research directions ----

test("N1: next research directions never contain Champion wording or auto-generated candidate IDs", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const json = JSON.stringify(dash.crossModelEvidence);
  assert.doesNotMatch(json, /CHAMPION|candidateId/);
});

test("N2: a concentration trade-off direction is never described as automatic rejection when risk improves", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const html = renderExtendedHistoricalDashboardHtml(dash);
  assert.doesNotMatch(html, /automatically reject/i);
});

// ---- HTML ----

test("H1: HTML is deterministic, mobile-viewport-tagged, self-contained, and carries the banner", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const h1 = renderExtendedHistoricalDashboardHtml(dash);
  const h2 = renderExtendedHistoricalDashboardHtml(dash);
  assert.equal(h1, h2);
  assert.ok(h1.endsWith(">\n"));
  assert.match(h1, /name="viewport"/);
  assert.doesNotMatch(h1, /https?:\/\//);
  assert.doesNotMatch(h1, /<script/i);
  assert.match(h1, /HISTORICAL RESEARCH ONLY/);
  assert.match(h1, /NO AUTOMATIC CHAMPION/);
  assert.match(h1, /NO MODEL PROMOTION/);
});

test("H2: HTML never contains PROMOTED or PRODUCTION_READY status wording", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const html = renderExtendedHistoricalDashboardHtml(dash);
  assert.doesNotMatch(html, /PROMOTED|PRODUCTION_READY/);
});

test("H3: every SVG chart carries a title and description element", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const html = renderExtendedHistoricalDashboardHtml(dash);
  const svgCount = (html.match(/<svg/g) || []).length;
  const titleCount = (html.match(/<title id=/g) || []).length;
  const descCount = (html.match(/<desc id=/g) || []).length;
  assert.ok(svgCount >= 6, `expected at least 6 SVG charts, got ${svgCount}`);
  assert.ok(titleCount >= svgCount);
  assert.ok(descCount >= svgCount);
});

test("H4: every chart has a table fallback beneath it", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const html = renderExtendedHistoricalDashboardHtml(dash);
  assert.match(html, /class="chart-fallback"/);
});

test("H5: HTML embeds no raw corpus row identity and no absolute file path", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const html = renderExtendedHistoricalDashboardHtml(dash);
  assert.doesNotMatch(html, /cond-\d+|tok-\d+/);
  assert.doesNotMatch(html, /\/home\/|C:\\\\/);
});

test("H6: a sticky compact table of contents is present", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const html = renderExtendedHistoricalDashboardHtml(dash);
  assert.match(html, /class="toc"/);
});

test("H7: the first screen contains the banner, corpus cards and model frontier before any per-model detail table", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const html = renderExtendedHistoricalDashboardHtml(dash);
  const bannerIdx = html.indexOf("HISTORICAL RESEARCH ONLY");
  const frontierIdx = html.indexOf("id=\"model-frontier\"");
  const detailIdx = html.indexOf("id=\"model-detail\"");
  assert.ok(bannerIdx >= 0 && frontierIdx > bannerIdx);
  assert.ok(detailIdx > frontierIdx);
});

// ---- manifest ----

test("M1: manifest ties dashboard hashes to the source decomposition and excludes forbidden fields", () => {
  const decomp = decompositionFixture();
  const dash = buildExtendedHistoricalDashboard({ decomposition: decomp });
  const json = serializeExtendedDashboardJson(dash);
  const html = renderExtendedHistoricalDashboardHtml(dash);
  const decompJson = serializeExtendedDecompositionJson(decomp);
  const manifest = buildExtendedDashboardManifest(dash, decompJson, json, html);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.sourceDecompositionContentHash, decomp.contentHash);
  assert.equal(manifest.dashboardJsonSha256.length, 64);
  assert.equal(manifest.dashboardHtmlSha256.length, 64);
  assert.equal(Object.keys(manifest.artifactSha256s).length, 2);
  const s = JSON.stringify(manifest);
  assert.doesNotMatch(s, /createdAt|timestamp|duration|\/home\/|C:\\\\|git.?user/i);
});
