/**
 * DETERMINISTIC_RICH_MODEL_SCORECARD_V1 — focused verification.
 *
 * Proves:
 *  - the frozen C0/C1/C4/C5 predicates + flat-1u settlement are REUSED, not redefined;
 *  - one physical economic event -> at most one selected bet (chronological first);
 *  - OPEN / NO_MATCH / VOID / unresolved-event / missing-eventStart rows are excluded
 *    from economics and reported explicitly;
 *  - populations are never pooled;
 *  - Score SERIES is never a predicate;
 *  - fixed Score LEVEL buckets are diagnostic only;
 *  - output is byte-identical across runs and independent of input order;
 *  - every cell is BACKWARD_LOOKING_DESCRIPTIVE, FORWARD_VALIDATED=false.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRollingManifest,
  buildScorecardRowView,
  resolveWindowDates,
  type DerivedSeries,
  type LoadedPartition,
  type RollingCompactRow,
} from "@/lib/modeling/research-corpus/rollingCorpus";
import { buildScorecard, SCORE_LEVEL_BUCKETS, type ScorecardInput } from "@/lib/modeling/scorecard/scorecardEvaluator";

const NOW = "2026-09-03T09:00:00.000Z"; // Minsk noon 09-03 -> D-1 = 09-02
const GEN_AT = "2026-09-03T00:00:00.000Z";
const NULL_SERIES: DerivedSeries = {
  observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null,
  lastEligibleValue: null, lastEligibleObservedAt: null, delta: null,
};

function row(p: Partial<RollingCompactRow> & Pick<RollingCompactRow, "populationId" | "conditionId" | "selectedTokenId" | "decisionAt">): RollingCompactRow {
  return {
    providerEventId: "evt-default", entryPrice: 0.55, eventStart: null, sportFamily: null,
    label: "OPEN", score: NULL_SERIES, selectedPrice: NULL_SERIES, volumeUsd: null, leadTimeHours: null,
    ...p,
  };
}
function partition(date: string, rows: RollingCompactRow[]): LoadedPartition {
  return { partitionDate: date, canonicalHash: `h-${date}`, labelEvidenceAsOf: null, sourceWindowStart: null, sourceWindowEnd: null, rows };
}

/** Build a ScorecardInput where all three periods share one partition set. */
function scInput(partitions: LoadedPartition[], nowUtc = NOW): ScorecardInput {
  const periods = {} as ScorecardInput["periods"];
  for (const [period, windowDays] of [["7d", 7], ["14d", 14], ["30d", 30]] as const) {
    periods[period] = {
      view: buildScorecardRowView({ windowDays, nowUtc, partitions }),
      manifestPopulations: buildRollingManifest({ windowDays, nowUtc, partitions }, GEN_AT).POPULATIONS,
    };
  }
  return { periods, generatedAt: GEN_AT };
}

test("frozen C0 price-band predicate is reused: in-band WIN selected, out-of-band ignored", () => {
  const d = resolveWindowDates(7, NOW).windowEnd;
  const p = partition(d, [
    row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "in", selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, providerEventId: "e-in", entryPrice: 0.55, eventStart: `${d}T12:00:00Z`, label: "WIN" }),
    row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "out", selectedTokenId: "t", decisionAt: `${d}T07:00:00Z`, providerEventId: "e-out", entryPrice: 0.65, eventStart: `${d}T12:00:00Z`, label: "WIN" }),
  ]);
  const sc = buildScorecard(scInput([p]));
  const cell = sc.CELLS.find((c) => c.PERIOD === "7d" && c.POPULATION_ID === "SEP_PUBLIC_RICH_V1")!;
  assert.equal(cell.MODELS.C0.SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(cell.MODELS.C0.WINS, 1);
  // flat-1u settlement reused: WIN pnl_u = 1/0.55 - 1
  assert.equal(cell.MODELS.C0.raw.pnlU, 1 / 0.55 - 1);
});

test("flat-1u settlement reused verbatim: WIN=1/p-1, LOSS=-1", () => {
  const d = resolveWindowDates(7, NOW).windowEnd;
  const p = partition(d, [
    row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "w", selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, providerEventId: "ew", entryPrice: 0.5, eventStart: `${d}T12:00:00Z`, label: "WIN" }),
    row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "l", selectedTokenId: "t", decisionAt: `${d}T07:00:00Z`, providerEventId: "el", entryPrice: 0.5, eventStart: `${d}T12:00:00Z`, label: "LOSS" }),
  ]);
  const cell = buildScorecard(scInput([p])).CELLS.find((c) => c.PERIOD === "7d")!;
  assert.equal(cell.MODELS.C0.WINS, 1);
  assert.equal(cell.MODELS.C0.LOSSES, 1);
  assert.equal(cell.MODELS.C0.PNL_U, 0); // (1/0.5 - 1) + (-1) = 0
});

test("one physical event -> at most one selected bet (chronological first)", () => {
  const d = resolveWindowDates(7, NOW).windowEnd;
  const p = partition(d, [
    row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "a", selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, providerEventId: "shared", entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "WIN" }),
    row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "b", selectedTokenId: "t", decisionAt: `${d}T09:00:00Z`, providerEventId: "shared", entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "LOSS" }),
  ]);
  const cell = buildScorecard(scInput([p])).CELLS.find((c) => c.PERIOD === "7d")!;
  assert.equal(cell.MODELS.C0.SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(cell.MODELS.C0.WINS, 1); // earliest decision (06:00) is the WIN
});

test("OPEN / NO_MATCH / VOID / unresolved-event / missing-eventStart are excluded and reported", () => {
  const d = resolveWindowDates(7, NOW).windowEnd;
  const base = { populationId: "SEP_PUBLIC_RICH_V1" as const, selectedTokenId: "t", entryPrice: 0.55, eventStart: `${d}T20:00:00Z` };
  const p = partition(d, [
    row({ ...base, conditionId: "open", decisionAt: `${d}T01:00:00Z`, providerEventId: "e1", label: "OPEN" }),
    row({ ...base, conditionId: "nm", decisionAt: `${d}T02:00:00Z`, providerEventId: "e2", label: "NO_MATCH" }),
    row({ ...base, conditionId: "void", decisionAt: `${d}T03:00:00Z`, providerEventId: "e3", label: "VOID" }),
    row({ ...base, conditionId: "noevt", decisionAt: `${d}T04:00:00Z`, providerEventId: null, label: "WIN" }),
    row({ ...base, conditionId: "nostart", decisionAt: `${d}T05:00:00Z`, providerEventId: "e5", eventStart: null, label: "LOSS" }),
    row({ ...base, conditionId: "good", decisionAt: `${d}T06:00:00Z`, providerEventId: "e6", label: "WIN" }),
  ]);
  const cell = buildScorecard(scInput([p])).CELLS.find((c) => c.PERIOD === "7d")!;
  const ex = cell.ENGINE_INPUT_ADAPTER;
  assert.equal(ex.OPEN_N, 1);
  assert.equal(ex.NO_MATCH_N, 1);
  assert.equal(ex.VOID_N, 1);
  assert.equal(ex.UNRESOLVED_PHYSICAL_EVENT_N, 1);
  assert.equal(ex.MISSING_EVENT_START_N, 1);
  assert.equal(ex.ECONOMIC_ELIGIBLE_ROW_N, 1);
  assert.equal(cell.MODELS.C0.SELECTED_PHYSICAL_EVENT_N, 1);
});

test("populations are never pooled — one cell per population per period", () => {
  const { dates } = resolveWindowDates(30, NOW);
  const partitions = dates.map((d) =>
    partition(d, [
      row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: `pr-${d}`, selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, providerEventId: `pr-e-${d}`, entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "WIN", scoreLevel: 62 }),
      row({ populationId: "SEP_SHADOW_STRATEGIC_V1", conditionId: `ss-${d}`, selectedTokenId: "t", decisionAt: `${d}T07:00:00Z`, providerEventId: `ss-e-${d}`, entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "LOSS", scoreLevel: null }),
    ]),
  );
  const sc = buildScorecard(scInput(partitions));
  assert.equal(sc.POPULATION_POOLING, "FORBIDDEN");
  assert.equal(sc.CELLS.length, 6); // 3 periods x 2 populations
  const prCell = sc.CELLS.find((c) => c.PERIOD === "30d" && c.POPULATION_ID === "SEP_PUBLIC_RICH_V1")!;
  const ssCell = sc.CELLS.find((c) => c.PERIOD === "30d" && c.POPULATION_ID === "SEP_SHADOW_STRATEGIC_V1")!;
  assert.equal(prCell.MODELS.C0.WINS, 30);
  assert.equal(prCell.MODELS.C0.LOSSES, 0);
  assert.equal(ssCell.MODELS.C0.WINS, 0);
  assert.equal(ssCell.MODELS.C0.LOSSES, 30);
});

test("Score SERIES is never a predicate: a present score series does not change selection", () => {
  const d = resolveWindowDates(7, NOW).windowEnd;
  const withSeries: DerivedSeries = { ...NULL_SERIES, observationCount: 5, firstEligibleValue: 1, lastEligibleValue: 3, delta: 2 };
  const p = partition(d, [
    row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "s", selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, providerEventId: "e", entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "WIN", score: withSeries }),
  ]);
  const sc = buildScorecard(scInput([p]));
  assert.equal(sc.SCORE_SERIES_USED_AS_PREDICATE, false);
  const cell = sc.CELLS.find((c) => c.PERIOD === "7d")!;
  assert.equal(cell.MODELS.C0.SELECTED_PHYSICAL_EVENT_N, 1); // selected purely on price band
  assert.equal(cell.DATA_QUALITY.SCORE_SERIES.STATUS, "DATA_QUALITY_ONLY");
});

test("fixed Score LEVEL buckets are diagnostic only and bucket edges are stable", () => {
  const d = resolveWindowDates(7, NOW).windowEnd;
  const mk = (c: string, sl: number | null) =>
    row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: c, selectedTokenId: "t", decisionAt: `${d}T0${c.length}:00:00Z`, providerEventId: `e-${c}`, entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "WIN", scoreLevel: sl });
  const p = partition(d, [mk("a", null), mk("bb", 54), mk("ccc", 55), mk("dddd", 74), mk("eeeee", 75)]);
  const cell = buildScorecard(scInput([p])).CELLS.find((c) => c.PERIOD === "7d")!;
  assert.deepEqual(cell.SCORE_LEVEL_DIAGNOSTIC.map((b) => b.BUCKET), [...SCORE_LEVEL_BUCKETS]);
  const byBucket = Object.fromEntries(cell.SCORE_LEVEL_DIAGNOSTIC.map((b) => [b.BUCKET, b.SETTLED_N]));
  assert.equal(byBucket["null"], 1);
  assert.equal(byBucket["<55"], 1);
  assert.equal(byBucket["55-59"], 1);
  assert.equal(byBucket["70-74"], 1);
  assert.equal(byBucket["75+"], 1);
});

test("scorecard output is deterministic and independent of partition input order", () => {
  const { dates } = resolveWindowDates(30, NOW);
  const build = () =>
    dates.map((d, i) =>
      partition(d, [
        row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: `c-${d}`, selectedTokenId: "t", decisionAt: `${d}T0${i % 10}:00:00Z`, providerEventId: `e-${d}`, entryPrice: 0.52 + (i % 5) / 100, eventStart: `${d}T20:00:00Z`, label: i % 3 === 0 ? "LOSS" : "WIN", scoreLevel: 55 + (i % 20) }),
      ]),
    );
  const a = buildScorecard(scInput(build()));
  const b = buildScorecard(scInput([...build()].reverse()));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("every cell is BACKWARD_LOOKING_DESCRIPTIVE and no forward-performance claim is made", () => {
  const d = resolveWindowDates(7, NOW).windowEnd;
  const p = partition(d, [row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: "x", selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, providerEventId: "e", entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "WIN" })]);
  const sc = buildScorecard(scInput([p]));
  assert.equal(sc.EVALUATION_MODE, "BACKWARD_LOOKING_DESCRIPTIVE");
  assert.equal(sc.FORWARD_VALIDATED, false);
  assert.equal(sc.THRESHOLD_SEARCH_PERFORMED, false);
  assert.match(sc.DISCLAIMER, /NOT a forward-performance claim/);
});

test("temporal stability surfaces a one-week burst vs a spread-out result", () => {
  const { dates } = resolveWindowDates(30, NOW);
  // burst: every win lands in a single 7-day bucket (days 7..13 from window start)
  const burst = dates.map((d, i) =>
    partition(d, i >= 7 && i < 14
      ? [row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: `c-${d}`, selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, providerEventId: `e-${d}`, entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "WIN" })]
      : []),
  );
  const burstCell = buildScorecard(scInput(burst)).CELLS.find((c) => c.PERIOD === "30d")!;
  assert.equal(burstCell.MODELS.C0.STABILITY.BURST_CONCENTRATION, 1);
  assert.equal(burstCell.MODELS.C0.STABILITY.POSITIVE_BUCKET_N, 1);

  // spread: one win per day across the whole window
  const spread = dates.map((d) =>
    partition(d, [row({ populationId: "SEP_PUBLIC_RICH_V1", conditionId: `c-${d}`, selectedTokenId: "t", decisionAt: `${d}T06:00:00Z`, providerEventId: `e-${d}`, entryPrice: 0.55, eventStart: `${d}T20:00:00Z`, label: "WIN" })]),
  );
  const spreadCell = buildScorecard(scInput(spread)).CELLS.find((c) => c.PERIOD === "30d")!;
  assert.ok((spreadCell.MODELS.C0.STABILITY.BURST_CONCENTRATION ?? 1) < 0.5);
  assert.ok(spreadCell.MODELS.C0.STABILITY.POSITIVE_BUCKET_N >= 4);
});
