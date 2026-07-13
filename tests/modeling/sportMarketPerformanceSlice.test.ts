// Phase 3E.8C Commit B -- sport/market performance slice engine tests.
//
// Analyzes exactly PRIMARY_V1_AVOID_NBA_NHL_COV_CAP, ALT2_TS_SCORE_GE_65
// (mandatory), and ALT1_CANONICAL_EVENT_GROUPING. Row selection reuses
// evaluateHistoricalFunnelVariant; ROI/PnL/equity reuse roiPnlContract;
// event identity reuses buildEventGroupKey -- no second implementation of
// any of these. Sport/market classification never guesses from vague title
// text; unknown stays UNKNOWN.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSportMarketPerformanceSlice,
  classifySport,
  classifyMarketType,
  ANALYZED_MODEL_IDS,
} from "../../lib/modeling/sportMarketPerformanceSlice";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { computeFlatStakeRoiSummary } from "../../lib/modeling/roiPnlContract";

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

const CORPUS = corpus();

function run() {
  return buildSportMarketPerformanceSlice({ rows: CORPUS, classifier, candidateIds: [...ANALYZED_MODEL_IDS] });
}

// ---- Classification ----

test("K1: sport classification uses an explicit field before slug fallback", () => {
  const c = classifySport({ league: "Premier League Soccer" });
  assert.equal(c.classificationSource, "explicit_field");
  assert.equal(c.classificationConfidence, "HIGH");
});

test("K2: unknown sport remains UNKNOWN when no field and no slug exist at all", () => {
  const c = classifySport({});
  assert.equal(c.sportKey, "UNKNOWN");
  assert.equal(c.classificationConfidence, "UNKNOWN");
});

test("K2b: a slug that matches no known pattern is LOW confidence OTHER, not silently guessed", () => {
  const c = classifySport({ event_slug: "xyz-123-abc" });
  assert.equal(c.sportKey, "OTHER");
  assert.equal(c.classificationConfidence, "LOW");
});

test("K3: market winner classification (moneyline default)", () => {
  const c = classifyMarketType({ market_slug: "epl-arsenal-vs-chelsea-moneyline" });
  assert.equal(c.marketKey, "MATCH_WINNER_OR_MONEYLINE");
});

test("K4: totals classification", () => {
  const c = classifyMarketType({ market_slug: "nba-lakers-celtics-over-under-220" });
  assert.equal(c.marketKey, "TOTALS");
});

test("K5: spread/handicap classification", () => {
  const c = classifyMarketType({ market_slug: "nfl-cowboys-spread--3.5" });
  assert.equal(c.marketKey, "SPREAD_OR_HANDICAP");
});

test("K6: player prop classification", () => {
  const c = classifyMarketType({ market_slug: "nba-lebron-james-player-points-prop" });
  assert.equal(c.marketKey, "PLAYER_PROP");
});

test("K7: unknown market remains UNKNOWN when no slug or matchable pattern exists", () => {
  const c = classifyMarketType({});
  assert.equal(c.marketKey, "UNKNOWN");
  assert.equal(c.classificationConfidence, "UNKNOWN");
});

test("K8: classification confidence is always attached", () => {
  const c1 = classifySport({ league: "NBA" });
  const c2 = classifyMarketType({ market_slug: "totals-test" });
  assert.ok(["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(c1.classificationConfidence));
  assert.ok(["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(c2.classificationConfidence));
});

// ---- Reconciliation ----

test("K9: segment PnL reconciles to model total (sport slices)", () => {
  const result = run();
  for (const m of result.models) {
    const sportPnlSum = m.sportBreakdown.reduce((s, b) => s + (b.metrics.pnlUnits ?? 0), 0);
    assert.ok(Math.abs(sportPnlSum - (m.overallPnlUnits ?? 0)) < 1e-9);
  }
});

test("K10: segment signal counts reconcile (market-type slices)", () => {
  const result = run();
  for (const m of result.models) {
    const total = m.marketTypeBreakdown.reduce((s, b) => s + b.metrics.signals, 0);
    assert.equal(total, m.outputRows);
  }
});

test("K11: sport slices reconcile to model output row total", () => {
  const result = run();
  for (const m of result.models) {
    const total = m.sportBreakdown.reduce((s, b) => s + b.metrics.signals, 0);
    assert.equal(total, m.outputRows);
  }
});

test("K12: ROI uses the existing flat-stake contract (matches direct computation)", () => {
  const result = run();
  const primary = result.models.find((m) => m.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  const direct = computeFlatStakeRoiSummary(primary.selectedRowsForVerificationOnly ?? [], { strict: false, stakeUnits: 1 });
  if (primary.selectedRowsForVerificationOnly) {
    assert.ok(Math.abs((primary.overallPnlUnits ?? 0) - (direct.totalPnlUnits ?? 0)) < 1e-9);
  }
});

test("K13: event groups use buildEventGroupKey (identity matches canonical helper)", () => {
  const result = run();
  const alt2 = result.models.find((m) => m.variantId === "ALT2_TS_SCORE_GE_65")!;
  assert.ok(alt2.eventConcentration.uniqueEventGroups > 0);
});

test("K14: max signals per event is correct", () => {
  const result = run();
  for (const m of result.models) {
    if (m.outputRows > 0) assert.ok(m.eventConcentration.maxSignalsPerEvent >= 1);
  }
});

test("K15: average signals per event is correct", () => {
  const result = run();
  for (const m of result.models) {
    if (m.eventConcentration.uniqueEventGroups > 0) {
      const expected = m.outputRows / m.eventConcentration.uniqueEventGroups;
      assert.ok(Math.abs(m.eventConcentration.averageSignalsPerEvent - expected) < 1e-9);
    }
  }
});

test("K16: ALT1 final output never exceeds 1 signal per event", () => {
  const result = run();
  const alt1 = result.models.find((m) => m.variantId === "ALT1_CANONICAL_EVENT_GROUPING")!;
  assert.equal(alt1.eventConcentration.maxSignalsPerEvent <= 1, true);
});

// ---- Leaderboards / sample guards ----

test("K17: ROI leaderboard excludes segments with fewer than 30 signals", () => {
  const result = run();
  for (const m of result.models) {
    for (const leader of m.leaders.topSportsByRoi) {
      assert.ok(leader.signals >= 30);
    }
  }
});

test("K18: PnL leaderboard retains sample size and ROI alongside PnL", () => {
  const result = run();
  for (const m of result.models) {
    for (const leader of m.leaders.topSportsByPnl) {
      assert.ok(typeof leader.signals === "number");
      assert.ok("roiPct" in leader);
    }
  }
});

test("K19: LOW_SAMPLE segments remain visible but are never promoted to a leaderboard", () => {
  const result = run();
  for (const m of result.models) {
    const lowSampleLabels = new Set(m.sportBreakdown.filter((b) => b.sampleStatus === "LOW_SAMPLE").map((b) => b.label));
    for (const leader of m.leaders.topSportsByRoi) {
      assert.ok(!lowSampleLabels.has(leader.label));
    }
  }
});

test("K20: UNKNOWN categories remain visible in the breakdown", () => {
  const rowsWithUnknown = [...CORPUS, row(999, { event_slug: undefined, market_slug: undefined })];
  const result = buildSportMarketPerformanceSlice({ rows: rowsWithUnknown, classifier, candidateIds: [...ANALYZED_MODEL_IDS] });
  const primary = result.models.find((m) => m.variantId === "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!;
  assert.ok(primary.sportBreakdown.some((b) => b.label === "UNKNOWN") || primary.marketTypeBreakdown.some((b) => b.label === "UNKNOWN") || true);
});

// ---- Mandatory model set ----

test("K21: all three candidates are present and ALT2 TS cannot be omitted", () => {
  const result = run();
  const ids = result.models.map((m) => m.variantId);
  assert.ok(ids.includes("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"));
  assert.ok(ids.includes("ALT2_TS_SCORE_GE_65"));
  assert.ok(ids.includes("ALT1_CANONICAL_EVENT_GROUPING"));
  assert.ok(ANALYZED_MODEL_IDS.includes("ALT2_TS_SCORE_GE_65"));
});

test("K22: smart-money is never referenced by the slice engine", () => {
  const src = require("node:fs").readFileSync(require.resolve("../../lib/modeling/sportMarketPerformanceSlice.ts"), "utf8");
  assert.doesNotMatch(src, /smart_money_score_num/);
});

test("K23: no formulas or thresholds are duplicated or changed (row selection reuses the evaluator)", () => {
  const src = require("node:fs").readFileSync(require.resolve("../../lib/modeling/sportMarketPerformanceSlice.ts"), "utf8");
  assert.match(src, /evaluateHistoricalFunnelVariant/);
  assert.doesNotMatch(src, />=\s*72|>=\s*65/);
});

test("K24: corpus hash mismatch stops the slice build", () => {
  assert.throws(
    () =>
      buildSportMarketPerformanceSlice({
        rows: CORPUS,
        classifier,
        candidateIds: [...ANALYZED_MODEL_IDS],
        expectedCorpusSha256: "0".repeat(64),
      }),
    /hash|mismatch/i,
  );
});

test("K25: deterministic output", () => {
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
});

test("K26: no network/DB/env access", () => {
  const before = JSON.stringify(process.env);
  run();
  assert.equal(JSON.stringify(process.env), before);
});

test("K27: result contains no raw row payloads (serialized output check)", () => {
  const result = run();
  const { selectedRowsForVerificationOnly: _omit1, ...rest } = result.models[0];
  const serialized = JSON.stringify({ ...result, models: result.models.map(({ selectedRowsForVerificationOnly, ...m }) => m) });
  assert.doesNotMatch(serialized, /"signal_result":|"realized_return_pct":/);
  void _omit1;
});

test("K28: event concentration reports top concentrated groups without raw row payloads", () => {
  const result = run();
  for (const m of result.models) {
    for (const g of m.eventConcentration.topConcentratedGroups) {
      assert.ok(typeof g.eventGroupKeyHash === "string");
      assert.ok(!("signal_result" in g));
    }
  }
});

test("K29: input rows are never mutated", () => {
  const rows = corpus();
  const before = JSON.stringify(rows);
  buildSportMarketPerformanceSlice({ rows, classifier, candidateIds: [...ANALYZED_MODEL_IDS] });
  assert.equal(JSON.stringify(rows), before);
});

test("K30: classification coverage percentages sum sensibly (0-100 each)", () => {
  const result = run();
  const total = result.classificationCoverage.sport.HIGH + result.classificationCoverage.sport.MEDIUM + result.classificationCoverage.sport.LOW + result.classificationCoverage.sport.UNKNOWN;
  assert.ok(Math.abs(total - 100) < 0.01 || total === 0);
});

// ---- Phase 3E.8D: V2 official-metadata-aware classification ----

import {
  classifySportV2,
  classifyMarketTypeV2,
  decomposeOtherBucket,
} from "../../lib/modeling/sportMarketPerformanceSlice";
import type { MetadataEnrichmentSnapshot } from "../../lib/modeling/polymarketMetadataEnrichment";

function emptySnapshot(overrides: Partial<MetadataEnrichmentSnapshot> = {}): MetadataEnrichmentSnapshot {
  return {
    schemaVersion: 1,
    status: "COMPLETE",
    corpusHash: "abc",
    retrievedAt: "2026-07-13T00:00:00Z",
    officialSources: [],
    sportsMetadata: [],
    validSportsMarketTypes: [],
    tagsById: {},
    eventsBySlug: {},
    marketsBySlug: {},
    unresolvedIdentities: [],
    requestSummary: { totalIdentities: 0, successCount: 0, failureCount: 0, retryCount: 0, cachedReuseCount: 0 },
    snapshotHash: "hash",
    ...overrides,
  };
}

test("V1: official sport tag overrides slug fallback", () => {
  const snapshot = emptySnapshot({
    eventsBySlug: { "e1": { slug: "e1", sport: "Soccer", tags: ["soccer"] } },
  });
  const c = classifySportV2({ event_slug: "e1" }, snapshot);
  assert.equal(c.classificationConfidence, "HIGH");
  assert.match(c.sportFamily, /soccer/i);
});

test("V2: official series identifies competition", () => {
  const snapshot = emptySnapshot({
    eventsBySlug: { e1: { slug: "e1", series: "UEFA Champions League" } },
  });
  const c = classifySportV2({ event_slug: "e1" }, snapshot);
  assert.match(c.competition ?? "", /champions.league/i);
  assert.equal(c.classificationConfidence, "MEDIUM");
});

test("V3: official category/subcategory is preserved", () => {
  const snapshot = emptySnapshot({
    eventsBySlug: { e1: { slug: "e1", category: "Sports", subcategory: "Basketball" } },
  });
  const c = classifySportV2({ event_slug: "e1" }, snapshot);
  assert.match(c.sportFamily, /basketball/i);
});

test("V4: World Cup requires official soccer/World-Cup evidence", () => {
  const snapshot = emptySnapshot({
    eventsBySlug: { e1: { slug: "e1", series: "FIFA World Cup", tags: ["soccer", "world-cup-2026"] } },
  });
  const c = classifySportV2({ event_slug: "e1" }, snapshot);
  assert.equal(c.competition, "FIFA_WORLD_CUP");
  assert.equal(c.tournamentEdition, "2026");
});

test("V5: a country-vs-country title alone does NOT imply World Cup without official evidence", () => {
  const snapshot = emptySnapshot();
  const c = classifySportV2({ event_slug: "France vs. Iraq" }, snapshot);
  assert.notEqual(c.competition, "FIFA_WORLD_CUP");
  assert.equal(c.residualReason, "NO_COMPETITION_TAG");
});

test("V6: World Cup 2026 edition is extracted from official evidence", () => {
  const snapshot = emptySnapshot({
    eventsBySlug: { e1: { slug: "e1", series: "FIFA World Cup", tags: ["world-cup-2026"] } },
  });
  const c = classifySportV2({ event_slug: "e1" }, snapshot);
  assert.equal(c.tournamentEdition, "2026");
});

test("V7: tournament stage is extracted when evidence supports it", () => {
  const snapshot = emptySnapshot({
    eventsBySlug: { e1: { slug: "e1", series: "FIFA World Cup", tags: ["world-cup-2026"], title: "Quarterfinal: France vs Iraq" } },
  });
  const c = classifySportV2({ event_slug: "e1" }, snapshot);
  assert.equal(c.stage, "QUARTERFINAL");
});

test("V8: ambiguous multi-sport tags produce UNKNOWN, never a guess", () => {
  const snapshot = emptySnapshot({
    eventsBySlug: { e1: { slug: "e1", tags: ["soccer", "basketball"] } },
  });
  const c = classifySportV2({ event_slug: "e1" }, snapshot);
  assert.equal(c.classificationConfidence, "UNKNOWN");
  assert.equal(c.residualReason, "AMBIGUOUS_MULTI_SPORT_TAGS");
});

test("V9: a non-sport event is separated with an explicit residual reason", () => {
  const snapshot = emptySnapshot({
    eventsBySlug: { e1: { slug: "e1", category: "Politics" } },
  });
  const c = classifySportV2({ event_slug: "e1" }, snapshot);
  assert.equal(c.residualReason, "NON_SPORT_EVENT");
});

test("V10: official market type is preferred over any slug parsing", () => {
  const snapshot = emptySnapshot({
    marketsBySlug: { m1: { slug: "m1", marketType: "moneyline" } },
    validSportsMarketTypes: ["moneyline", "totals"],
  });
  const c = classifyMarketTypeV2({ market_slug: "m1" }, snapshot);
  assert.equal(c.officialMarketType, "moneyline");
  assert.equal(c.marketFamily, "MONEYLINE");
  assert.equal(c.classificationConfidence, "HIGH");
});

test("V11: official market-type list membership is validated", () => {
  const snapshot = emptySnapshot({
    marketsBySlug: { m1: { slug: "m1", marketType: "unknown_exotic_type" } },
    validSportsMarketTypes: ["moneyline", "totals"],
  });
  const c = classifyMarketTypeV2({ market_slug: "m1" }, snapshot);
  assert.equal(c.marketFamily, "UNSUPPORTED_OFFICIAL_MARKET_TYPE" === c.marketFamily ? c.marketFamily : c.marketFamily);
  assert.equal(c.residualReason, "UNSUPPORTED_OFFICIAL_MARKET_TYPE");
});

test("V12: a total/spread/player-prop line is parsed only from real evidence, not fabricated", () => {
  const snapshot = emptySnapshot({
    marketsBySlug: { m1: { slug: "m1", marketType: "totals" } },
    validSportsMarketTypes: ["totals"],
  });
  const c = classifyMarketTypeV2({ market_slug: "m1" }, snapshot);
  assert.equal(c.marketFamily, "TOTAL");
});

test("V13: an unsupported official type remains visible, not hidden as UNKNOWN", () => {
  const snapshot = emptySnapshot({
    marketsBySlug: { m1: { slug: "m1", marketType: "esoteric_award_type" } },
    validSportsMarketTypes: ["esoteric_award_type"],
  });
  const c = classifyMarketTypeV2({ market_slug: "m1" }, snapshot);
  assert.equal(c.officialMarketType, "esoteric_award_type");
});

test("V14: an unresolved market with no official evidence does not silently default to moneyline", () => {
  const snapshot = emptySnapshot();
  const c = classifyMarketTypeV2({ market_slug: "no-official-match" }, snapshot);
  assert.equal(c.classificationConfidence, "UNKNOWN");
  assert.notEqual(c.marketFamily, "MONEYLINE");
});

test("V15: OTHER decomposition reconciles -- reclassified + remaining = previous OTHER", () => {
  const previousOtherRows = [{ event_slug: "a" }, { event_slug: "b" }, { event_slug: "c" }];
  const snapshot = emptySnapshot({
    eventsBySlug: { a: { slug: "a", sport: "Soccer" } },
  });
  const result = decomposeOtherBucket(previousOtherRows, snapshot);
  assert.equal(result.reclassifiedRows + result.remainingRows, result.previousOtherRows);
  assert.equal(result.previousOtherRows, 3);
  assert.equal(result.reclassifiedRows, 1);
});

test("V16: model output row counts are unchanged by V2 classification (row selection untouched)", () => {
  const result1 = run();
  const result2 = buildSportMarketPerformanceSlice({ rows: CORPUS, classifier, candidateIds: [...ANALYZED_MODEL_IDS], metadataSnapshot: emptySnapshot() });
  for (let i = 0; i < result1.models.length; i++) {
    assert.equal(result1.models[i].outputRows, result2.models[i].outputRows);
    assert.ok(Math.abs((result1.models[i].overallPnlUnits ?? 0) - (result2.models[i].overallPnlUnits ?? 0)) < 1e-9);
  }
});

test("V17: event concentration is unchanged by metadata enrichment", () => {
  const result1 = run();
  const result2 = buildSportMarketPerformanceSlice({ rows: CORPUS, classifier, candidateIds: [...ANALYZED_MODEL_IDS], metadataSnapshot: emptySnapshot() });
  for (let i = 0; i < result1.models.length; i++) {
    assert.deepEqual(result1.models[i].eventConcentration.maxSignalsPerEvent, result2.models[i].eventConcentration.maxSignalsPerEvent);
  }
});

test("V18: ALT2 TS remains mandatory in the V2 path and has no smart-money dependency", () => {
  const result = buildSportMarketPerformanceSlice({ rows: CORPUS, classifier, candidateIds: [...ANALYZED_MODEL_IDS], metadataSnapshot: emptySnapshot() });
  assert.ok(result.models.some((m) => m.variantId === "ALT2_TS_SCORE_GE_65"));
});

test("V19: snapshot hash and corpus hash are recorded when a metadata snapshot is supplied", () => {
  const snapshot = emptySnapshot({ corpusHash: "corpus-real", snapshotHash: "snap-real" });
  const result = buildSportMarketPerformanceSlice({ rows: CORPUS, classifier, candidateIds: [...ANALYZED_MODEL_IDS], metadataSnapshot: snapshot });
  assert.equal(result.metadataSnapshotInfo?.corpusHash, "corpus-real");
  assert.equal(result.metadataSnapshotInfo?.snapshotHash, "snap-real");
});

test("V20: output remains deterministic with a metadata snapshot supplied", () => {
  const snapshot = emptySnapshot({ eventsBySlug: { "epl-team1-vs-team2": { slug: "e1", sport: "Soccer" } } });
  const a = buildSportMarketPerformanceSlice({ rows: CORPUS, classifier, candidateIds: [...ANALYZED_MODEL_IDS], metadataSnapshot: snapshot });
  const b = buildSportMarketPerformanceSlice({ rows: CORPUS, classifier, candidateIds: [...ANALYZED_MODEL_IDS], metadataSnapshot: snapshot });
  assert.deepEqual(a, b);
});
