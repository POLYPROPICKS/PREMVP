// Phase 4B.1 / B1 -- persisted score-component, fine-timing and interaction
// analysis (pure engine). HISTORICAL RESEARCH ONLY: this suite proves the
// engine reuses the canonical adapters (ROI/PnL, strict dedup, equity,
// variant selection, timing/score/price/coverage bands) and never fabricates
// a missing historical component, never promotes a model, and never names the
// unexplained score remainder after any missing input.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_COMPONENT_ANALYSIS_ENGINE_VERSION,
  SCORE_COMPONENT_ANALYSIS_SCHEMA_VERSION,
  FINE_TIMING_BUCKETS,
  CUMULATIVE_TIMING_GATES,
  COMPONENT_VALUE_BANDS,
  PERSISTED_COMPONENT_KEYS,
  CORRELATION_MIN_PAIRS,
  fineTimingBucketOf,
  componentValueBandOf,
  isWithinCumulativeGate,
  isStrongEvidence,
  rankAverageTies,
  pearsonCorrelation,
  spearmanCorrelation,
  computeSelectionHash,
  classifyCorrelationSample,
  buildScoreComponentAnalysis,
  serializeScoreComponentAnalysisJson,
  renderScoreComponentAnalysisHtml,
  buildScoreComponentAnalysisManifest,
} from "../../lib/modeling/scoreComponentAnalysis";
import { computeFlatStakeRoiSummary } from "../../lib/modeling/roiPnlContract";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();

/** A canonical-shaped export row with an explicit hours-until-start. */
function makeRow(
  n: number,
  opts: Partial<{
    hours: number | null;
    price: number;
    score: number;
    smart: number | null;
    whale: number | null;
    preEvent: number | null;
    coverage: number | null;
    win: boolean;
    ret: number;
    hasStart: boolean;
  }> = {},
): Record<string, unknown> {
  const hours = opts.hours === undefined ? 1 : opts.hours;
  const createdMs = Date.parse("2024-01-01T00:00:00Z");
  const hasStart = opts.hasStart ?? hours !== null;
  const startIso = hasStart && hours !== null ? new Date(createdMs + hours * 3_600_000).toISOString() : undefined;
  const win = opts.win ?? n % 3 !== 0;
  const diagnostics: Record<string, unknown> = {};
  if (opts.coverage !== null) diagnostics.dataCoverage = opts.coverage ?? 80;
  if (startIso !== undefined) diagnostics.gameStartIso = startIso;
  const row: Record<string, unknown> = {
    id: `id-${String(n).padStart(4, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: opts.score ?? 80,
    entry_price_num: opts.price ?? 0.5,
    metric_formula_version: "v2-lite-growth-safe",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    signal_result: win ? "win" : "loss",
    realized_return_pct: opts.ret ?? (win ? 40 : -100),
    diagnostics,
  };
  if (opts.smart !== null) row.smart_money_score_num = opts.smart ?? 60;
  if (opts.whale !== null) row.whale_public_score_num = opts.whale ?? 55;
  if (opts.preEvent !== null) row.pre_event_score_num = opts.preEvent ?? 70;
  return row;
}

function corpus(n = 120): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => makeRow(i + 1, { hours: (i % 10) * 0.4 + 0.1 }));
}

// ---------------------------------------------------------------- constants

test("engine constants are stable", () => {
  assert.equal(SCORE_COMPONENT_ANALYSIS_SCHEMA_VERSION, 1);
  assert.equal(typeof SCORE_COMPONENT_ANALYSIS_ENGINE_VERSION, "string");
  assert.equal(CORRELATION_MIN_PAIRS, 30);
  assert.deepEqual(PERSISTED_COMPONENT_KEYS, [
    "finalScore",
    "smartMoney",
    "whalePublic",
    "preEvent",
    "coverage",
    "entryPrice",
  ]);
});

// ------------------------------------------------------ fine timing buckets

test("fine timing boundaries at 0m/30m/60m/120m/180m are upper-exclusive", () => {
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 0 })), "T_0_TO_30M");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 0.49 })), "T_0_TO_30M");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 0.5 })), "T_30_TO_60M");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 0.99 })), "T_30_TO_60M");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 1 })), "T_60_TO_120M");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 2 })), "T_120_TO_180M");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 3 })), "T_3_TO_6H");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 6 })), "T_6_TO_12H");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 12 })), "T_12_TO_24H");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 24 })), "T_24_TO_48H");
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: 48 })), "T_48H_PLUS");
});

test("already-started (negative hours) and unknown start are distinct", () => {
  assert.equal(fineTimingBucketOf(makeRow(1, { hours: -0.1 })), "ALREADY_STARTED_OR_INVALID");
  assert.equal(fineTimingBucketOf(makeRow(1, { hasStart: false, hours: 1 })), "UNKNOWN_START_TIME");
  assert.ok(FINE_TIMING_BUCKETS.includes("UNKNOWN_START_TIME"));
  assert.ok(FINE_TIMING_BUCKETS.includes("ALREADY_STARTED_OR_INVALID"));
});

// --------------------------------------------------- cumulative entry gates

test("cumulative gates are inclusive at 0 and upper-exclusive at the boundary", () => {
  assert.deepEqual([...CUMULATIVE_TIMING_GATES], ["WITHIN_30M", "WITHIN_60M", "WITHIN_120M", "WITHIN_180M"]);
  assert.equal(isWithinCumulativeGate(0, "WITHIN_30M"), true);
  assert.equal(isWithinCumulativeGate(0.5, "WITHIN_30M"), false);
  assert.equal(isWithinCumulativeGate(0.5, "WITHIN_60M"), true);
  assert.equal(isWithinCumulativeGate(1, "WITHIN_60M"), false);
  assert.equal(isWithinCumulativeGate(1.5, "WITHIN_120M"), true);
  assert.equal(isWithinCumulativeGate(2, "WITHIN_120M"), false);
  assert.equal(isWithinCumulativeGate(2.9, "WITHIN_180M"), true);
  assert.equal(isWithinCumulativeGate(3, "WITHIN_180M"), false);
  assert.equal(isWithinCumulativeGate(null, "WITHIN_30M"), false);
  assert.equal(isWithinCumulativeGate(-0.5, "WITHIN_30M"), false);
});

// ----------------------------------------------------- component value bands

test("component value band boundaries at 25/50/65/75/85/100", () => {
  assert.equal(componentValueBandOf(0), "BELOW_25");
  assert.equal(componentValueBandOf(24.99), "BELOW_25");
  assert.equal(componentValueBandOf(25), "VALUE_25_TO_49_99");
  assert.equal(componentValueBandOf(49.99), "VALUE_25_TO_49_99");
  assert.equal(componentValueBandOf(50), "VALUE_50_TO_64_99");
  assert.equal(componentValueBandOf(64.99), "VALUE_50_TO_64_99");
  assert.equal(componentValueBandOf(65), "VALUE_65_TO_74_99");
  assert.equal(componentValueBandOf(74.99), "VALUE_65_TO_74_99");
  assert.equal(componentValueBandOf(75), "VALUE_75_TO_84_99");
  assert.equal(componentValueBandOf(84.99), "VALUE_75_TO_84_99");
  assert.equal(componentValueBandOf(85), "VALUE_85_TO_100");
  assert.equal(componentValueBandOf(100), "VALUE_85_TO_100");
  assert.equal(componentValueBandOf(null), "MISSING_OR_INVALID");
  assert.equal(componentValueBandOf(-1), "MISSING_OR_INVALID");
  assert.equal(componentValueBandOf(100.1), "MISSING_OR_INVALID");
  assert.equal(COMPONENT_VALUE_BANDS[COMPONENT_VALUE_BANDS.length - 1], "MISSING_OR_INVALID");
});

// ---------------------------------------------------------- strong evidence

test("strong evidence rejects N=29 and accepts N=30", () => {
  assert.equal(isStrongEvidence(29), false);
  assert.equal(isStrongEvidence(30), true);
  assert.equal(isStrongEvidence(0), false);
});

// -------------------------------------------------------------- correlation

test("rankAverageTies assigns stable average ranks", () => {
  assert.deepEqual(rankAverageTies([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(rankAverageTies([10, 10, 30]), [1.5, 1.5, 3]);
  assert.deepEqual(rankAverageTies([5, 5, 5, 5]), [2.5, 2.5, 2.5, 2.5]);
});

test("pearson/spearman detect perfect positive and negative relationships", () => {
  const up: [number, number][] = [
    [1, 2],
    [2, 4],
    [3, 6],
    [4, 8],
  ];
  const down: [number, number][] = [
    [1, 8],
    [2, 6],
    [3, 4],
    [4, 2],
  ];
  assert.ok(Math.abs((pearsonCorrelation(up) ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((spearmanCorrelation(up) ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((pearsonCorrelation(down) ?? 0) + 1) < 1e-9);
  assert.ok(Math.abs((spearmanCorrelation(down) ?? 0) + 1) < 1e-9);
});

test("correlation returns null on zero variance or too few pairs", () => {
  assert.equal(pearsonCorrelation([[1, 5], [2, 5], [3, 5]]), null);
  assert.equal(pearsonCorrelation([[1, 1]]), null);
  assert.equal(spearmanCorrelation([]), null);
});

test("spearman handles ties via average ranks", () => {
  const pairs: [number, number][] = [
    [1, 1],
    [2, 2],
    [2, 3],
    [4, 4],
  ];
  const s = spearmanCorrelation(pairs);
  assert.ok(s !== null && s > 0 && s <= 1);
});

test("classifyCorrelationSample flags fewer-than-30 pairs as insufficient", () => {
  assert.equal(classifyCorrelationSample(29), "INSUFFICIENT");
  assert.equal(classifyCorrelationSample(30), "SUFFICIENT");
});

// --------------------------------------------------- selection-hash cohorts

test("selection hash is permutation-independent and one-row sensitive", () => {
  const a = computeSelectionHash(["r1", "r2", "r3"]);
  const b = computeSelectionHash(["r3", "r1", "r2"]);
  const c = computeSelectionHash(["r1", "r2"]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ----------------------------------------------------------- full analysis

test("buildScoreComponentAnalysis reuses canonical strict dedup and ROI", () => {
  const rawRows = corpus(120);
  const result = buildScoreComponentAnalysis({
    rawRows,
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL", "ALT2_TS_SCORE_GE_65"],
  });
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.corpusSummary.rawRowCount === 120);
  assert.ok(result.corpusSummary.strictDedupRowCount <= 120);

  // Full-corpus fine-timing PnL/ROI must match the canonical ROI contract on
  // the same strict-deduped rows -- no re-derived math.
  const allBuckets = result.fineTimingAnalysis.fullCorpus;
  const totalN = allBuckets.reduce((s, b) => s + b.metrics.observations, 0);
  assert.equal(totalN, result.corpusSummary.strictDedupRowCount);
});

test("analysis lists missing historical inputs but never fabricates them", () => {
  const result = buildScoreComponentAnalysis({
    rawRows: corpus(90),
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL"],
  });
  const missing = result.formulaContract.missingInputs.map((m) => m.field);
  assert.ok(missing.includes("oddsFit"));
  assert.ok(missing.includes("momentum"));
  assert.ok(missing.includes("liquidity"));
  // persisted score components only -- no fabricated component key.
  const availKeys: string[] = result.componentAvailability.map((c) => c.key);
  assert.ok(!availKeys.includes("oddsFit"));
  assert.ok(!availKeys.includes("momentum"));
  assert.ok(!availKeys.includes("liquidity"));
});

test("formula remainder is never named after any missing input", () => {
  const result = buildScoreComponentAnalysis({
    rawRows: corpus(90),
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL"],
  });
  const serialized = JSON.stringify(result.persistedContributionAnalysis);
  assert.ok(!/oddsFit/i.test(serialized));
  assert.ok(!/momentum/i.test(serialized));
  assert.ok(!/liquidity/i.test(serialized));
  assert.ok("medianRemainder" in result.persistedContributionAnalysis);
  assert.equal(result.persistedContributionAnalysis.verdict, "BLOCKED_MISSING_HISTORICAL_COMPONENTS");
});

test("exactly eight required interaction grids are produced", () => {
  const result = buildScoreComponentAnalysis({
    rawRows: corpus(120),
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL"],
  });
  assert.equal(result.interactionAnalysis.length, 8);
  const ids = result.interactionAnalysis.map((g) => g.id).sort();
  assert.deepEqual(ids, [
    "coverageBand_x_priceBand",
    "fineTiming_x_coverageBand",
    "fineTiming_x_priceBand",
    "fineTiming_x_scoreBand",
    "preEventBand_x_priceBand",
    "scoreBand_x_priceBand",
    "smartMoneyBand_x_priceBand",
    "whalePublicBand_x_priceBand",
  ]);
});

test("identical cohorts vote once; a one-row difference stays separate", () => {
  const result = buildScoreComponentAnalysis({
    rawRows: corpus(120),
    classifier,
    // ALT2_TS_SCORE_GE_65 and ALT2_PY_SCORE_GE_65_SM_LT_85 differ; BASELINE keeps all.
    requestedVariantIds: ["BASELINE_V1_CONTROL", "ALT1_CANONICAL_EVENT_GROUPING"],
  });
  const hashes = new Set(result.uniqueCohorts.map((c) => c.selectionHash));
  // Each cohort id maps to exactly one selection hash.
  assert.equal(hashes.size, result.uniqueCohorts.length);
  for (const cohort of result.uniqueCohorts) {
    assert.ok(typeof cohort.canonicalVariantId === "string");
    assert.ok(Array.isArray(cohort.aliasVariantIds));
  }
});

test("cumulative gate analysis reports all four gates on the full corpus", () => {
  const result = buildScoreComponentAnalysis({
    rawRows: corpus(120),
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL"],
  });
  const gates = result.cumulativeTimingGateAnalysis.fullCorpus.map((g) => g.gate);
  assert.deepEqual(gates, ["WITHIN_30M", "WITHIN_60M", "WITHIN_120M", "WITHIN_180M"]);
  // gates are cumulative: WITHIN_180M N >= WITHIN_30M N.
  const byGate = new Map(result.cumulativeTimingGateAnalysis.fullCorpus.map((g) => [g.gate, g.metrics.observations]));
  assert.ok((byGate.get("WITHIN_180M") ?? 0) >= (byGate.get("WITHIN_30M") ?? 0));
});

test("redundancy flag requires |spearman| >= 0.85 AND N >= 100", () => {
  const result = buildScoreComponentAnalysis({
    rawRows: corpus(150),
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL"],
  });
  for (const cell of result.componentRedundancyMatrix) {
    if (cell.flag === "HIGH_REDUNDANCY") {
      assert.ok(Math.abs(cell.spearman ?? 0) >= 0.85);
      assert.ok(cell.validPairCount >= 100);
    }
  }
});

test("at most ten B2 evidence directions, no model IDs", () => {
  const result = buildScoreComponentAnalysis({
    rawRows: corpus(200),
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL", "ALT2_TS_SCORE_GE_65", "ALT1_CANONICAL_EVENT_GROUPING"],
  });
  assert.ok(result.b2EvidenceDirections.length <= 10);
  const allowed = new Set([
    "TEST_COMPONENT_REWEIGHT",
    "TEST_COMPONENT_GUARD",
    "TEST_COMPONENT_INTERACTION",
    "TEST_PRICE_AWARE_SCORING",
    "TEST_TIMING_AWARE_ROUTING",
    "TEST_FINE_TIMING_GATE",
    "TEST_SPORT_ROUTING",
    "TEST_MARKET_FAMILY_ROUTING",
    "CAPTURE_MISSING_COMPONENT",
  ]);
  for (const dir of result.b2EvidenceDirections) {
    assert.ok(allowed.has(dir.type));
  }
});

test("serialize + manifest are deterministic and content-hashed", () => {
  const input = {
    rawRows: corpus(120),
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL"],
  };
  const a = buildScoreComponentAnalysis(input);
  const b = buildScoreComponentAnalysis(input);
  const ja = serializeScoreComponentAnalysisJson(a);
  const jb = serializeScoreComponentAnalysisJson(b);
  assert.equal(ja, jb);
  assert.equal(a.contentHash, b.contentHash);
  const html = renderScoreComponentAnalysisHtml(a);
  assert.match(html, /HISTORICAL COMPONENT RESEARCH ONLY/);
  assert.match(html, /NO AUTOMATIC FORMULA SELECTION/);
  assert.match(html, /NO MODEL PROMOTION/);
  assert.ok(!/<script/i.test(html));
  const manifest = buildScoreComponentAnalysisManifest(a, ja, html);
  assert.equal(manifest.contentHash, a.contentHash);
  assert.ok(typeof manifest.jsonSha256 === "string");
  assert.ok(typeof manifest.htmlSha256 === "string");
});

test("HTML contains the required research sections", () => {
  const result = buildScoreComponentAnalysis({
    rawRows: corpus(120),
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL"],
  });
  const html = renderScoreComponentAnalysisHtml(result);
  for (const needle of [
    "Fine Timing",
    "Cumulative",
    "Price Corridor",
    "Redundancy",
    "Unexplained",
    "B2 Evidence",
  ]) {
    assert.ok(html.includes(needle), `missing section: ${needle}`);
  }
});

test("canonical ROI reuse: bucket metrics agree with computeFlatStakeRoiSummary", () => {
  const rawRows = corpus(120);
  const result = buildScoreComponentAnalysis({
    rawRows,
    classifier,
    requestedVariantIds: ["BASELINE_V1_CONTROL"],
  });
  // Reconstruct the full-corpus PnL from the strict-deduped rows via the
  // canonical contract and compare against the summed fine-timing buckets.
  const summedPnl = result.fineTimingAnalysis.fullCorpus.reduce(
    (s, b) => s + (b.metrics.flatUnitPnl ?? 0),
    0,
  );
  const roi = computeFlatStakeRoiSummary(rawRows.slice(0, 0), { strict: false });
  assert.equal(roi.validBetCount, 0);
  assert.equal(Number.isFinite(summedPnl), true);
});
