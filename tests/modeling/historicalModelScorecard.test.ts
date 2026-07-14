// Phase 3E.6 -- Historical Model Run Visual Scorecard (pure builder + HTML).
//
// Deterministic scorecard over the ALREADY-COMPUTED historical comparison
// artifact (and optional manifest / performance slice). No fs/env/network,
// no forward rows, no re-derived ROI/dedup: it renders what the canonical
// historical comparison engine produced and fails closed on inconsistency.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoricalModelScorecard,
  serializeScorecardJson,
  renderHistoricalModelScorecardHtml,
  buildScorecardManifest,
  buildHistoricalModelScorecardArtifacts,
  ScorecardValidationError,
  SCORECARD_GENERATOR_VERSION,
} from "../../lib/modeling/historicalModelScorecard";
import {
  LOCKED_EXECUTION_SET,
  BASELINE_VARIANT_ID,
  COMPARISON_ENGINE_VERSION,
  type ComparisonResult,
  type VariantExecution,
  type VariantMetrics,
} from "../../lib/modeling/historicalFunnelComparison";
import type { ComparisonWithHash } from "../../lib/modeling/historicalFunnelScorecard";

const CORPUS_HASH = "a".repeat(64);
const CLASSIFIER_HASH = "b".repeat(64);

function metrics(overrides: Partial<VariantMetrics> = {}): VariantMetrics {
  const outputRows = overrides.outputRows ?? 300;
  const wins = overrides.wins ?? 170;
  const losses = overrides.losses ?? 120;
  const pnl = overrides.flatUnitPnl ?? 25;
  return {
    inputRows: 1850,
    outputRows,
    retentionRate: outputRows / 1850,
    removedRows: 1850 - outputRows,
    wins,
    losses,
    voidOrExcludedResultRows: outputRows - wins - losses,
    winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
    flatUnitPnl: pnl,
    flatUnitRoi: outputRows > 0 ? (pnl / outputRows) * 100 : null,
    firstResolvedAt: "2026-01-02T00:00:00.000Z",
    lastResolvedAt: "2026-07-10T00:00:00.000Z",
    coveredCalendarDays: 190,
    signalsPerCoveredDay: outputRows / 190,
    uniqueConditionTokenPairs: outputRows,
    uniqueMarkets: outputRows,
    workingEventGroups: overrides.workingEventGroups ?? Math.max(1, Math.floor(outputRows / 2)),
    maximumSignalsPerWorkingEvent: overrides.maximumSignalsPerWorkingEvent ?? 3,
    equity: overrides.equity ?? {
      endingPnl: pnl,
      peakPnl: pnl + 8,
      maximumDrawdownUnits: 12,
      maximumDrawdownPctOfPeak: 30,
      longestWinningStreak: 6,
      longestLosingStreak: 4,
    },
    ...overrides,
  };
}

function executed(variantId: string, m: VariantMetrics = metrics()): VariantExecution {
  return {
    variantId,
    evaluationStatus: "EXECUTED",
    classifierRunStatus: "RUNNABLE",
    metrics: m,
    limitationFlags: [],
    historicalStakePolicy: null,
    normalizedStakePolicy: null,
    blocker: null,
  };
}

function blocked(variantId: string): VariantExecution {
  return {
    variantId,
    evaluationStatus: "BLOCKED_MISSING_FIELD",
    classifierRunStatus: "BLOCKED_MISSING_FIELD",
    limitationFlags: ["missing event_key"],
    historicalStakePolicy: null,
    normalizedStakePolicy: null,
    blocker: "requires event_key, absent from the canonical export",
  };
}

// Fixed per-variant metrics covering positive, negative and zero cases.
const PER_VARIANT: Record<string, VariantMetrics> = {
  BASELINE_V1_CONTROL: metrics({ outputRows: 1850, wins: 900, losses: 850, flatUnitPnl: 10 }),
  PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: metrics({ outputRows: 317, wins: 180, losses: 130, flatUnitPnl: 26.7742 }),
  ALT1_CANONICAL_EVENT_GROUPING: metrics({ outputRows: 274, wins: 150, losses: 118, flatUnitPnl: 21.6841 }),
  ALT2_TS_SCORE_GE_65: metrics({ outputRows: 1110, wins: 560, losses: 520, flatUnitPnl: 57.6341 }),
  ALT2_PY_SCORE_GE_65_SM_LT_85: metrics({ outputRows: 800, wins: 390, losses: 400, flatUnitPnl: -5.5 }),
  ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL: metrics({ outputRows: 0, wins: 0, losses: 0, flatUnitPnl: 0 }),
  ALT3_PY_SCORE_GE_65: metrics({ outputRows: 620, wins: 300, losses: 310, flatUnitPnl: 3.2 }),
  ALT_SM_GUARD_ON_PRIMARY: metrics({ outputRows: 290, wins: 160, losses: 120, flatUnitPnl: 18 }),
  ALT_SM_GUARD_ON_PRIMARY_APPROX: metrics({ outputRows: 288, wins: 158, losses: 122, flatUnitPnl: 17.5 }),
};

function baseComparison(overrides: Partial<ComparisonResult> = {}): ComparisonWithHash {
  const executions: VariantExecution[] = LOCKED_EXECUTION_SET.map((id) => executed(id, PER_VARIANT[id]));
  const result: ComparisonWithHash = {
    corpus: {
      inputRows: 1850,
      firstResolvedAt: "2026-01-02T00:00:00.000Z",
      lastResolvedAt: "2026-07-10T00:00:00.000Z",
      coveredCalendarDays: 190,
    },
    comparisonEngineVersion: COMPARISON_ENGINE_VERSION,
    baselineVariantId: BASELINE_VARIANT_ID,
    executions,
    inputSha256: CORPUS_HASH,
    classifierSha256: CLASSIFIER_HASH,
    ...overrides,
  };
  return result;
}

const MANIFEST = {
  schemaVersion: 1 as const,
  runId: "run-deadbeef",
  gitCommit: "abc123",
  gitBranch: "feature",
  inputArtifactPath: "modeling/local_exports/generated_signal_pairs_export.json",
  inputSha256: CORPUS_HASH,
  inputRowCount: 1850,
  inputFirstResolvedAt: "2026-01-02T00:00:00.000Z",
  inputLastResolvedAt: "2026-07-10T00:00:00.000Z",
  dedupPolicy: "strict_latest_created_before_resolved",
  rawInputRowCount: 49400,
  deduplicatedInputRowCount: 1850,
  duplicateRowsRemoved: 47550,
  dedupApplied: true,
  dedupIdentityFields: ["condition_id", "token_id"],
  dedupOrderingField: "created_at",
  dedupResolutionBoundaryField: "resolved_at",
  classifierPath: "modeling/model_registry/executable_funnel_classifier.json",
  classifierSha256: CLASSIFIER_HASH,
  classifierSchemaVersion: 1,
  comparisonEngineVersion: COMPARISON_ENGINE_VERSION,
  requestedVariantIds: [...LOCKED_EXECUTION_SET],
  executedVariantIds: [...LOCKED_EXECUTION_SET],
  skippedVariantsAndReasons: [],
  normalizedStakePolicy: { unit: "FLAT_1_UNIT", plainLanguage: "1 unit" },
  roiContractSource: "lib/modeling/roiPnlContract.ts",
  eventIdentityPolicy: "MEDIUM",
  knownLimitations: [],
  commands: [],
  createdAt: "2026-07-14T00:00:00.000Z",
} as unknown as import("../../lib/modeling/evaluationRunManifest").EvaluationRunManifest;

// ---- Executive summary ----

test("E1: executive summary carries the locked no-champion / no-promotion policy", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.equal(s.executive.headline, "CANONICAL HISTORICAL MODEL COMPARISON");
  assert.equal(s.executive.championPolicy, "NO AUTOMATIC CHAMPION");
  assert.equal(s.executive.promotionPolicy, "NO LIVE PROMOTION");
});

test("E2: strict-dedup row count comes from the comparison corpus", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.equal(s.executive.strictDedupRowCount, 1850);
});

test("E3: raw row count is null without a manifest and 49400 with one", () => {
  const noManifest = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.equal(noManifest.executive.rawRowCount, null);
  const withManifest = buildHistoricalModelScorecard({ comparison: baseComparison(), manifest: MANIFEST });
  assert.equal(withManifest.executive.rawRowCount, 49400);
});

test("E4: corpus + classifier hashes and executed/blocked counts are exposed", () => {
  const c = baseComparison();
  c.executions[c.executions.length - 1] = blocked("ALT_SM_GUARD_ON_PRIMARY_APPROX");
  const s = buildHistoricalModelScorecard({ comparison: c });
  assert.equal(s.executive.corpusHash, CORPUS_HASH);
  assert.equal(s.executive.classifierHash, CLASSIFIER_HASH);
  assert.equal(s.executive.executedModelCount, LOCKED_EXECUTION_SET.length - 1);
  assert.equal(s.executive.blockedOrSkippedModelCount, 1);
});

// ---- Frozen comparators ----

test("F5: the three frozen comparators appear in fixed order with canonical metrics", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.deepEqual(
    s.frozenComparators.map((f) => f.variantId),
    ["PRIMARY_V1_AVOID_NBA_NHL_COV_CAP", "ALT2_TS_SCORE_GE_65", "ALT1_CANONICAL_EVENT_GROUPING"],
  );
  const primary = s.frozenComparators[0];
  assert.equal(primary.selectedN, 317);
  assert.equal(primary.totalPnlUnits, 26.7742);
  assert.equal(primary.wins, 180);
  assert.equal(primary.losses, 130);
});

test("F6: a missing frozen comparator fails closed", () => {
  const c = baseComparison();
  c.executions = c.executions.filter((e) => e.variantId !== "ALT2_TS_SCORE_GE_65");
  assert.throws(() => buildHistoricalModelScorecard({ comparison: c }), ScorecardValidationError);
});

// ---- All-model comparison ----

test("M7: all nine locked models are retained in locked order", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.deepEqual(s.models.map((m) => m.variantId), [...LOCKED_EXECUTION_SET]);
});

test("M8: blocked/skipped statuses are retained, not omitted", () => {
  const c = baseComparison();
  c.executions[5] = blocked("ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL");
  const s = buildHistoricalModelScorecard({ comparison: c });
  const blockedModel = s.models.find((m) => m.variantId === "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL");
  assert.ok(blockedModel);
  assert.equal(blockedModel!.executed, false);
  assert.equal(blockedModel!.status, "BLOCKED_MISSING_FIELD");
  assert.ok(blockedModel!.blocker && blockedModel!.blocker.length > 0);
});

test("M9: a blocked/skipped candidate disappearing entirely fails closed", () => {
  const c = baseComparison();
  c.executions = c.executions.filter((e) => e.variantId !== "ALT3_PY_SCORE_GE_65");
  assert.throws(() => buildHistoricalModelScorecard({ comparison: c }), ScorecardValidationError);
});

test("M10: duplicate model id fails closed", () => {
  const c = baseComparison();
  c.executions.push(executed("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"));
  assert.throws(() => buildHistoricalModelScorecard({ comparison: c }), ScorecardValidationError);
});

test("M11: executed model order diverging from the locked set fails closed", () => {
  const c = baseComparison();
  const tmp = c.executions[1];
  c.executions[1] = c.executions[2];
  c.executions[2] = tmp;
  assert.throws(() => buildHistoricalModelScorecard({ comparison: c }), ScorecardValidationError);
});

test("M12: negative selected count fails closed", () => {
  const c = baseComparison();
  c.executions[3] = executed("ALT2_TS_SCORE_GE_65", metrics({ outputRows: -1 }));
  assert.throws(() => buildHistoricalModelScorecard({ comparison: c }), ScorecardValidationError);
});

test("M13: a NaN/infinite metric fails closed", () => {
  const c = baseComparison();
  c.executions[3] = executed("ALT2_TS_SCORE_GE_65", metrics({ flatUnitPnl: Number.POSITIVE_INFINITY }));
  assert.throws(() => buildHistoricalModelScorecard({ comparison: c }), ScorecardValidationError);
});

test("M14: hash mismatch between comparison and manifest fails closed", () => {
  const badManifest = { ...MANIFEST, inputSha256: "c".repeat(64) } as typeof MANIFEST;
  assert.throws(() => buildHistoricalModelScorecard({ comparison: baseComparison(), manifest: badManifest }), ScorecardValidationError);
});

test("M15: current drawdown is peak minus ending PnL and negative PnL is preserved", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  const neg = s.models.find((m) => m.variantId === "ALT2_PY_SCORE_GE_65_SM_LT_85");
  assert.ok(neg);
  assert.equal(neg!.pnlUnits, -5.5);
  const primary = s.models.find((m) => m.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  // peakPnl (26.7742 + 8) - endingPnl (26.7742) = 8
  assert.equal(Math.round((primary.currentDrawdownUnits ?? 0) * 1000) / 1000, 8);
});

// ---- Charts ----

test("G16: all required chart series exist and use fixed model order", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  for (const id of [
    "volumeRoiFrontier",
    "volumePnlFrontier",
    "pnlBars",
    "roiBars",
    "volumeBars",
    "maxDrawdownBars",
    "cumulativePnlEnvelopes",
    "drawdownEnvelopes",
    "eventConcentration",
  ]) {
    assert.ok(s.charts[id as keyof typeof s.charts], `missing chart ${id}`);
  }
  // pnl bars only cover executed models, in locked order
  const executedOrder = LOCKED_EXECUTION_SET.filter((id) => PER_VARIANT[id]);
  assert.deepEqual(s.charts.pnlBars.points.map((p) => p.label), executedOrder);
});

test("G17: frontier handles zero-volume and negative-PnL executed models", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  const zero = s.charts.volumePnlFrontier.points.find((p) => p.label === "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL");
  assert.ok(zero);
  assert.equal(zero!.x, 0);
  const neg = s.charts.pnlBars.points.find((p) => p.label === "ALT2_PY_SCORE_GE_65_SM_LT_85");
  assert.equal(neg!.value, -5.5);
});

// ---- Decomposition ----

test("D18: without a performance slice the decomposition is null but flagged", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.equal(s.decomposition, null);
  assert.ok(s.hypothesisReadiness.blockedDimensions.includes("decomposition"));
});

// ---- Interpretation ----

test("I19: interpretation preserves roles and declares no champion / no promotion", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.equal(s.interpretation.champion, "none");
  assert.equal(s.interpretation.promotion, "no");
  assert.match(s.interpretation.primary, /quality/i);
  assert.match(s.interpretation.alt2, /volume/i);
  assert.match(s.interpretation.alt1, /concentration/i);
  // additional candidates = executed non-frozen models
  assert.ok(s.interpretation.additionalCandidates.includes("ALT3_PY_SCORE_GE_65"));
  assert.ok(!s.interpretation.additionalCandidates.includes("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"));
});

// ---- Hypothesis readiness ----

test("H20: hypothesis-readiness section is machine-readable with required keys", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  const h = s.hypothesisReadiness;
  for (const k of [
    "strongestPositiveSegments",
    "strongestNegativeSegments",
    "concentrationRisks",
    "lowSampleSegments",
    "candidateModelsForNextBatch",
    "blockedDimensions",
  ]) {
    assert.ok(k in h, `missing hypothesis key ${k}`);
  }
  assert.ok(Array.isArray(h.candidateModelsForNextBatch));
});

// ---- Determinism & hashing ----

test("T21: two builds of identical input are deep-equal", () => {
  const a = buildHistoricalModelScorecard({ comparison: baseComparison() });
  const b = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.deepEqual(a, b);
  assert.equal(a.contentHash, b.contentHash);
});

test("T22: JSON serialization is deterministic with exactly one trailing newline", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  const json = serializeScorecardJson(s);
  assert.ok(json.endsWith("}\n"));
  assert.ok(!json.endsWith("}\n\n"));
  assert.equal(serializeScorecardJson(buildHistoricalModelScorecard({ comparison: baseComparison() })), json);
});

test("T23: generator version constant is embedded", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  assert.equal(s.generatorVersion, SCORECARD_GENERATOR_VERSION);
});

// ---- HTML safety ----

test("H24: HTML is deterministic, self-contained, and references no remote resources", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  const html1 = renderHistoricalModelScorecardHtml(s);
  const html2 = renderHistoricalModelScorecardHtml(s);
  assert.equal(html1, html2);
  assert.ok(html1.endsWith(">\n") || html1.endsWith("html>\n"));
  assert.doesNotMatch(html1, /https?:\/\//);
  assert.doesNotMatch(html1, /<script/i);
  assert.doesNotMatch(html1, /@import|cdn|googleapis|unpkg|jsdelivr/i);
  assert.match(html1, /<svg/);
});

test("H25: HTML escapes injected model text", () => {
  const c = baseComparison();
  const evil = executed("ALT3_PY_SCORE_GE_65", PER_VARIANT.ALT3_PY_SCORE_GE_65);
  evil.blocker = '<img src=x onerror="alert(1)">';
  c.executions[6] = evil;
  const s = buildHistoricalModelScorecard({ comparison: c });
  const html = renderHistoricalModelScorecardHtml(s);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x/);
});

test("H26: HTML embeds no raw corpus (no per-row identity leak)", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison() });
  const html = renderHistoricalModelScorecardHtml(s);
  assert.doesNotMatch(html, /condition_id|token_id|resolved_at/);
});

// ---- Manifest ----

test("MF27: manifest ties json+html hashes to the corpus and policy", () => {
  const s = buildHistoricalModelScorecard({ comparison: baseComparison(), manifest: MANIFEST });
  const html = renderHistoricalModelScorecardHtml(s);
  const manifest = buildScorecardManifest(s, html);
  assert.equal(manifest.comparisonInputSha256, CORPUS_HASH);
  assert.equal(manifest.classifierSha256, CLASSIFIER_HASH);
  assert.equal(manifest.championPolicy, "NO AUTOMATIC CHAMPION");
  assert.equal(manifest.scorecardContentHash, s.contentHash);
  assert.equal(manifest.scorecardJsonSha256.length, 64);
  assert.equal(manifest.scorecardHtmlSha256.length, 64);
});

test("MF28: the artifact bundle exposes three serialized outputs with trailing newlines", () => {
  const bundle = buildHistoricalModelScorecardArtifacts({ comparison: baseComparison(), manifest: MANIFEST });
  assert.ok(bundle.jsonString.endsWith("\n"));
  assert.ok(bundle.htmlString.endsWith("\n"));
  assert.ok(bundle.manifestString.endsWith("\n"));
  assert.equal(bundle.scorecard.contentHash, buildHistoricalModelScorecard({ comparison: baseComparison(), manifest: MANIFEST }).contentHash);
});
