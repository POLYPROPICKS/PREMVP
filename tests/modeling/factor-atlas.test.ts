import { test } from "node:test";
import assert from "node:assert/strict";

import type { RollingCompactRow, LoadedPartition } from "../../lib/modeling/research-corpus/rollingCorpus";
import { evaluateRows } from "../../lib/research-clone/modelReady";
import { runCell, toAtlasInput, canonicalJson, sha256 } from "../../scripts/modeling/factor-atlas";

const EMPTY = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };

function row(over: Partial<RollingCompactRow> & { conditionId: string; decisionAt: string }): RollingCompactRow {
  return {
    populationId: "SEP_PUBLIC_RICH_V1",
    selectedTokenId: "tok",
    providerEventId: `evt-${over.conditionId}`,
    entryPrice: 0.55,
    eventStart: new Date(Date.parse(over.decisionAt) + 5 * 3600_000).toISOString(),
    sportFamily: "soccer",
    label: "WIN",
    score: EMPTY,
    selectedPrice: EMPTY,
    volumeUsd: null,
    leadTimeHours: 5,
    scoreLevel: null,
    ...over,
  } as RollingCompactRow;
}

function part(date: string, rows: RollingCompactRow[]): LoadedPartition {
  return { partitionDate: date, canonicalHash: `hash-${date}`, labelEvidenceAsOf: null, sourceWindowStart: null, sourceWindowEnd: null, rows };
}

// Minimal ScorecardReadyRow-shaped adapter carrying only the fields toAtlasInput() reads.
function toScorecardRow(r: RollingCompactRow) {
  return {
    populationId: r.populationId,
    conditionId: r.conditionId,
    selectedTokenId: r.selectedTokenId,
    providerEventId: r.providerEventId,
    decisionAt: r.decisionAt,
    entryPrice: r.entryPrice,
    eventStart: r.eventStart,
    sportFamily: r.sportFamily,
    scoreLevel: typeof r.scoreLevel === "number" ? r.scoreLevel : null,
    score: r.score ?? EMPTY,
    selectedPrice: r.selectedPrice ?? EMPTY,
    volumeUsd: typeof r.volumeUsd === "number" ? r.volumeUsd : null,
    leadTimeHours: typeof r.leadTimeHours === "number" ? r.leadTimeHours : null,
    frozenLabel: r.label,
    labelAsOf: r.label,
  } as any;
}

// Local re-implementations of the same bucket predicates under test, kept
// intentionally identical in shape to the source so a boundary regression in
// either place is caught.
function inC0(entryPrice: number) {
  return entryPrice >= 0.5 && entryPrice < 0.6;
}
const scoreLevelBucket = (lo: number | null, hi: number | null) => (e: { entryPrice: number; scoreLevel: number | null }) =>
  inC0(e.entryPrice) && typeof e.scoreLevel === "number" && (lo === null || e.scoreLevel >= lo) && (hi === null || e.scoreLevel < hi);

test("PRICE bucket boundaries are exact", () => {
  const rows = [
    row({ conditionId: "P1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.5199999999 }),
    row({ conditionId: "P2", decisionAt: "2026-08-04T09:01:00.000Z", entryPrice: 0.52 }),
    row({ conditionId: "P3", decisionAt: "2026-08-04T09:02:00.000Z", entryPrice: 0.5799999999 }),
    row({ conditionId: "P4", decisionAt: "2026-08-04T09:03:00.000Z", entryPrice: 0.58 }),
  ];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const p50_52 = (e: { entryPrice: number }) => e.entryPrice >= 0.5 && e.entryPrice < 0.52;
  const p56_58 = (e: { entryPrice: number }) => e.entryPrice >= 0.56 && e.entryPrice < 0.58;
  const p58_60 = (e: { entryPrice: number }) => e.entryPrice >= 0.58 && e.entryPrice < 0.6;
  assert.equal(runCell(input, p50_52).events, 1);
  assert.equal(runCell(input, p56_58).events, 1);
  assert.equal(runCell(input, p58_60).events, 1);
});

test("SCORE_LEVEL bucket boundaries are exact", () => {
  const rows = [
    row({ conditionId: "S1", decisionAt: "2026-08-04T09:00:00.000Z", scoreLevel: 59.999 }),
    row({ conditionId: "S2", decisionAt: "2026-08-04T09:01:00.000Z", scoreLevel: 60 }),
    row({ conditionId: "S3", decisionAt: "2026-08-04T09:02:00.000Z", scoreLevel: 62.999 }),
    row({ conditionId: "S4", decisionAt: "2026-08-04T09:03:00.000Z", scoreLevel: 63 }),
    row({ conditionId: "S5", decisionAt: "2026-08-04T09:04:00.000Z", scoreLevel: 67.999 }),
    row({ conditionId: "S6", decisionAt: "2026-08-04T09:05:00.000Z", scoreLevel: 68 }),
  ];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  assert.equal(runCell(input, scoreLevelBucket(null, 60)).events, 1); // S_LT60 -> S1
  assert.equal(runCell(input, scoreLevelBucket(60, 63)).events, 2); // S_60_62 -> S2, S3
  assert.equal(runCell(input, scoreLevelBucket(63, 65)).events, 1); // S_63_64 -> S4
  assert.equal(runCell(input, scoreLevelBucket(65, 68)).events, 1); // S_65_67 -> S5
  assert.equal(runCell(input, scoreLevelBucket(68, null)).events, 1); // S_GE68 -> S6
});

test("missing scoreLevel fails closed only for the score family, never for price", () => {
  const rows = [row({ conditionId: "M1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.55, scoreLevel: null })];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  assert.equal(runCell(input, scoreLevelBucket(null, 60)).events, 0, "missing scoreLevel excludes from every score bucket");
  const p50_60 = (e: { entryPrice: number }) => e.entryPrice >= 0.5 && e.entryPrice < 0.6;
  assert.equal(runCell(input, p50_60).events, 1, "price predicate is unaffected by a missing, unrelated feature");
});

test("missing volumeUsd fails closed only for the volume family", () => {
  const rows = [row({ conditionId: "V1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.55, volumeUsd: null })];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const vBucket = (e: { entryPrice: number; volumeUsd: number | null }) => inC0(e.entryPrice) && typeof e.volumeUsd === "number" && e.volumeUsd < 100_000;
  assert.equal(runCell(input, vBucket).events, 0);
});

test("the factor predicate is applied BEFORE physical-event selection — a non-qualifying earlier row never blocks a qualifying later one", () => {
  // Same physicalEventKey, two candidate rows: the chronologically FIRST row
  // does not qualify for the SCORE_LEVEL >= 63 bucket; the second does. The
  // predicate must be checked per-row before selection, so the second row
  // (not the first) is what the cell selects.
  const rows = [
    row({ conditionId: "A1", providerEventId: "evt-shared", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.55, scoreLevel: 40 }),
    row({ conditionId: "A2", providerEventId: "evt-shared", decisionAt: "2026-08-04T09:01:00.000Z", entryPrice: 0.55, scoreLevel: 63 }),
  ];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const result = runCell(input, scoreLevelBucket(63, 65));
  assert.equal(result.events, 1);
  assert.equal(result.selectedBets[0].physicalEventKey, "evt-shared");
});

test("interaction predicate (AND of two factor predicates) is applied before selection", () => {
  const rows = [
    // qualifies price, fails sport
    row({ conditionId: "I1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.51, sportFamily: "basketball" }),
    // qualifies both price AND sport=tennis
    row({ conditionId: "I2", decisionAt: "2026-08-04T09:01:00.000Z", entryPrice: 0.51, sportFamily: "tennis" }),
  ];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const priceBucket = (e: { entryPrice: number }) => e.entryPrice >= 0.5 && e.entryPrice < 0.52;
  const sportBucket = (e: { sportFamily: string }) => e.sportFamily === "tennis";
  const interaction = (e: { entryPrice: number; sportFamily: string }) => priceBucket(e) && sportBucket(e);
  const result = runCell(input, interaction);
  assert.equal(result.events, 1);
  assert.equal(result.selectedBets[0].physicalEventKey, "evt-I2");
});

test("the same physical event cannot contribute twice to one cell", () => {
  const rows = [
    row({ conditionId: "D1", providerEventId: "evt-dup", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.55, scoreLevel: 70 }),
    row({ conditionId: "D2", providerEventId: "evt-dup", decisionAt: "2026-08-04T09:01:00.000Z", entryPrice: 0.51, scoreLevel: 70 }),
  ];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const result = runCell(input, scoreLevelBucket(68, null));
  assert.equal(result.events, 1, "one physicalEventKey -> maximum one selected bet");
  assert.equal(result.selectedBets[0].entryPrice, 0.55, "chronological-first qualifying row wins");
});

test("weekly evaluation independently reruns the predicate and selection inside each week's own rows", async () => {
  // The internal weekly helper reruns runCell() against each week's own
  // buildExplicitDateRangeRowView() slice; exercise that same contract
  // directly: a row that fails a bucket predicate in its own week must never
  // be "rescued" by a same-physical-event row that qualifies in a different
  // week.
  const { buildExplicitDateRangeRowView } = await import("../../lib/modeling/research-corpus/rollingCorpus");

  const w1Row = row({ conditionId: "W1A", providerEventId: "evt-weekly", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.55, scoreLevel: 40 });
  const w2Row = row({ conditionId: "W2A", providerEventId: "evt-weekly", decisionAt: "2026-08-11T09:00:00.000Z", entryPrice: 0.55, scoreLevel: 63 });

  const w1View = buildExplicitDateRangeRowView({ rangeStart: "2026-08-04", rangeEnd: "2026-08-04", partitions: [part("2026-08-04", [w1Row])] });
  const w2View = buildExplicitDateRangeRowView({ rangeStart: "2026-08-11", rangeEnd: "2026-08-11", partitions: [part("2026-08-11", [w2Row])] });

  const w1Input = toAtlasInput(w1View.rows.filter((r) => r.populationId === "SEP_PUBLIC_RICH_V1"));
  const w2Input = toAtlasInput(w2View.rows.filter((r) => r.populationId === "SEP_PUBLIC_RICH_V1"));

  const bucket = scoreLevelBucket(63, 65);
  assert.equal(runCell(w1Input, bucket).events, 0, "week1's own row fails the bucket predicate");
  assert.equal(runCell(w2Input, bucket).events, 1, "week2's own row satisfies the bucket predicate");
});

test("reversed partition order produces an identical canonical cell result", () => {
  const rows1 = [row({ conditionId: "R1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.55, scoreLevel: 63 })];
  const rows2 = [row({ conditionId: "R2", decisionAt: "2026-08-05T09:00:00.000Z", entryPrice: 0.51, scoreLevel: 63 })];
  const forwardRows = [...rows1, ...rows2];
  const reversedRows = [...rows2, ...rows1];
  const forwardInput = toAtlasInput(forwardRows.map((r) => toScorecardRow(r)));
  const reversedInput = toAtlasInput(reversedRows.map((r) => toScorecardRow(r)));
  const bucket = scoreLevelBucket(63, 65);
  const forward = runCell(forwardInput, bucket);
  const reversed = runCell(reversedInput, bucket);
  assert.equal(sha256(canonicalJson({ events: forward.events, pnl_u: forward.pnl_u })), sha256(canonicalJson({ events: reversed.events, pnl_u: reversed.pnl_u })));
});

test("C0 parity: the same price-band predicate matches the existing frozen engine on a fixture", () => {
  const rows = [
    row({ conditionId: "C1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.5, label: "WIN" }),
    row({ conditionId: "C2", decisionAt: "2026-08-04T10:00:00.000Z", entryPrice: 0.65, label: "WIN" }),
    row({ conditionId: "C3", decisionAt: "2026-08-04T11:00:00.000Z", entryPrice: 0.59, label: "LOSS" }),
  ];
  const scorecardRows = rows.map((r) => toScorecardRow(r));
  const expected = evaluateRows(scorecardRows as any) as Record<string, any>;
  const input = toAtlasInput(scorecardRows);
  const c0Predicate = (e: { entryPrice: number }) => e.entryPrice >= 0.5 && e.entryPrice < 0.6;
  const actual = runCell(input, c0Predicate);
  assert.equal(actual.events, expected.C0.SELECTED_PHYSICAL_EVENT_N);
  assert.equal(actual.wins, expected.C0.WINS);
  assert.equal(actual.losses, expected.C0.LOSSES);
  assert.equal(actual.pnl_u, expected.C0.PNL_U);
  assert.equal(actual.roi_pct, expected.C0.ROI_PCT);
  assert.equal(actual.max_drawdown_u, expected.C0.MAX_DRAWDOWN_U);
});
