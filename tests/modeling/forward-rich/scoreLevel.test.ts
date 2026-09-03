/**
 * RESEARCH_CORPUS_SCORE_LEVEL_CORRECTION_V1 — focused verification.
 *
 * Score LEVEL (generated_signal_pairs.pre_event_score_num) is an explicit
 * immutable decision-time scalar, DISTINCT from the GSRS-derived Score SERIES.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { materializeForwardRichResearch } from "@/lib/modeling/forward-rich/materializeForwardRichResearch";
import { buildCompactCorpus, type CompactCorpusSlice } from "@/lib/modeling/forward-rich/compactCorpus";
import type { ForwardRichSignalPair } from "@/lib/modeling/forward-rich/types";
import { buildRollingManifest, resolveWindowDates, type LoadedPartition, type RollingCompactRow } from "@/lib/modeling/research-corpus/rollingCorpus";

function pair(p: Partial<ForwardRichSignalPair> & Pick<ForwardRichSignalPair, "conditionId" | "selectedTokenId">): ForwardRichSignalPair {
  return {
    decisionAt: "2026-09-02T06:00:00.000Z",
    sourceCreatedAt: "2026-09-02T06:00:00.000Z",
    entryPriceNum: 0.5,
    volumeUsd: null,
    formulaVersion: "trusted-initial-formula-v1.1",
    ...p,
  };
}

test("materializer carries Score LEVEL from pre_event_score_num with an explicit source tag", () => {
  const [row] = materializeForwardRichResearch({
    signalPairs: [pair({ conditionId: "c1", selectedTokenId: "t1", preEventScoreNum: 65 })],
    observations: [],
    sinceCutoff: "2026-09-02T00:00:00.000Z",
    materializedAt: "2026-09-03T00:00:00.000Z",
  });
  assert.equal(row.scoreLevel, 65);
  assert.equal(row.scoreLevelSource, "generated_signal_pairs.pre_event_score_num");
});

test("Score LEVEL is null (never synthesized) when the producer wrote null", () => {
  const [row] = materializeForwardRichResearch({
    signalPairs: [pair({ conditionId: "c2", selectedTokenId: "t2", preEventScoreNum: null })],
    observations: [],
    sinceCutoff: "2026-09-02T00:00:00.000Z",
    materializedAt: "2026-09-03T00:00:00.000Z",
  });
  assert.equal(row.scoreLevel, null);
  assert.equal(row.scoreLevelSource, null);
});

test("Score LEVEL and Score SERIES are independent: LEVEL present while SERIES observationCount is 0", () => {
  const [row] = materializeForwardRichResearch({
    signalPairs: [pair({ conditionId: "c3", selectedTokenId: "t3", preEventScoreNum: 72 })],
    observations: [], // no GSRS score observations
    sinceCutoff: "2026-09-02T00:00:00.000Z",
    materializedAt: "2026-09-03T00:00:00.000Z",
  });
  assert.equal(row.scoreLevel, 72);
  assert.equal(row.score.observationCount, 0);
  assert.equal(row.score.firstEligibleValue, null);
});

test("compact collapse keeps the earliest-decision row's Score LEVEL", () => {
  const slice: CompactCorpusSlice = {
    sliceDateUtc: "2026-09-02",
    sinceCutoff: "2026-09-01T21:00:00.000Z",
    materializedAt: "2026-09-03T00:00:00.000Z",
    signalPairs: [
      pair({ conditionId: "c4", selectedTokenId: "t4", decisionAt: "2026-09-02T08:00:00.000Z", preEventScoreNum: 70 }),
      pair({ conditionId: "c4", selectedTokenId: "t4", decisionAt: "2026-09-02T06:00:00.000Z", preEventScoreNum: 55 }),
    ],
    observations: [],
  };
  const { rows } = buildCompactCorpus(slice);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scoreLevel, 55); // earliest decision
});

test("rolling manifest exposes a per-population SCORE_LEVEL block distinct from FEATURE_COVERAGE score series", () => {
  const now = "2026-09-03T09:00:00.000Z";
  const d = resolveWindowDates(7, now).windowEnd;
  const NULL_SERIES = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };
  const mk = (p: Partial<RollingCompactRow> & Pick<RollingCompactRow, "populationId" | "conditionId" | "selectedTokenId">): RollingCompactRow => ({
    providerEventId: null, entryPrice: null, eventStart: null, sportFamily: null, decisionAt: `${d}T06:00:00Z`, label: "OPEN", score: NULL_SERIES, selectedPrice: NULL_SERIES, volumeUsd: null, leadTimeHours: null, ...p,
  });
  const part: LoadedPartition = {
    partitionDate: d, canonicalHash: `h-${d}`, labelEvidenceAsOf: null, sourceWindowStart: null, sourceWindowEnd: null,
    rows: [
      mk({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "a", selectedTokenId: "t", scoreLevel: 53 }),
      mk({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "b", selectedTokenId: "t", scoreLevel: 78 }),
      mk({ populationId: "SEP_SHADOW_STRATEGIC_V1", conditionId: "s", selectedTokenId: "t", scoreLevel: undefined }),
    ],
  };
  const m = buildRollingManifest({ windowDays: 7, nowUtc: now, partitions: [part] }, now);
  const rich = m.POPULATIONS.find((p) => p.population_id === "SEP_PUBLIC_RICH_V1")!;
  assert.equal(rich.SCORE_LEVEL.SCORE_LEVEL_PRESENT_N, 2);
  assert.equal(rich.SCORE_LEVEL.SCORE_LEVEL_COVERAGE_PCT, 100);
  assert.equal(rich.SCORE_LEVEL.MIN, 53);
  assert.equal(rich.SCORE_LEVEL.MAX, 78);
  assert.equal(rich.FEATURE_COVERAGE.score_numeric_pct, 0); // GSRS series still empty
  const strat = m.POPULATIONS.find((p) => p.population_id === "SEP_SHADOW_STRATEGIC_V1")!;
  assert.equal(strat.SCORE_LEVEL.SCORE_LEVEL_PRESENT_N, 0); // structural absence preserved
});
