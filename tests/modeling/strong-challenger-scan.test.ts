import { test } from "node:test";
import assert from "node:assert/strict";

import type { RollingCompactRow, LoadedPartition } from "../../lib/modeling/research-corpus/rollingCorpus";
import { evaluateRows } from "../../lib/research-clone/modelReady";
import {
  CHALLENGERS,
  WEEKS,
  canonicalJson,
  computeWeeklyForFrozenModel,
  computeWeeklyForPredicate,
  runChallenger,
  sha256,
  toChallengerInput,
} from "../../scripts/modeling/strong-challenger-scan";

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

function getChallenger(id: string) {
  const c = CHALLENGERS.find((x) => x.CHALLENGER_ID === id);
  if (!c) throw new Error(`missing challenger ${id}`);
  return c;
}

test("weekly slices are inclusive and non-overlapping and cover the full August range", () => {
  assert.equal(WEEKS.length, 4);
  assert.deepEqual(
    WEEKS.map((w) => [w.start, w.end]),
    [
      ["2026-08-04", "2026-08-10"],
      ["2026-08-11", "2026-08-17"],
      ["2026-08-18", "2026-08-24"],
      ["2026-08-25", "2026-08-31"],
    ],
  );
  for (let i = 1; i < WEEKS.length; i++) {
    assert.ok(WEEKS[i].start > WEEKS[i - 1].end, `week ${WEEKS[i].WEEK_ID} must start strictly after previous week ends`);
  }
});

test("one physical event is selected at most once even with duplicate candidate rows", () => {
  const rows = [
    row({ conditionId: "A1", decisionAt: "2026-08-04T09:00:00.000Z", providerEventId: "evt-X", entryPrice: 0.55, scoreLevel: 70 }),
    row({ conditionId: "A2", decisionAt: "2026-08-04T08:00:00.000Z", providerEventId: "evt-X", entryPrice: 0.51, scoreLevel: 70 }),
  ];
  const input = toChallengerInput(rows.map((r) => toScorecardRow(r)));
  const c0Score = getChallenger("C0_SCORE_GE50");
  const result = runChallenger(input, c0Score.predicate);
  assert.equal(result.SELECTED_PHYSICAL_EVENT_N, 1);
  // Chronological-first qualifying row wins: A2 (08:00) before A1 (09:00).
  assert.equal(result.selectedBets[0].entryPrice, 0.51);
});

test("missing score fails closed for every score-based challenger", () => {
  const rows = [
    row({ conditionId: "S1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.55, scoreLevel: null }),
  ];
  const input = toChallengerInput(rows.map((r) => toScorecardRow(r)));
  for (const id of ["C0_SCORE_GE50", "C0_SCORE_GE60", "C0_SCORE_GE65", "C0_SCORE_GE72", "SOCCER_SCORE_GE50"]) {
    const result = runChallenger(input, getChallenger(id).predicate);
    assert.equal(result.SELECTED_PHYSICAL_EVENT_N, 0, `${id} must fail closed on missing scoreLevel`);
  }
});

test("price interval boundaries are exact", () => {
  const rows = [
    row({ conditionId: "P1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.5399999999 }),
    row({ conditionId: "P2", decisionAt: "2026-08-04T09:01:00.000Z", entryPrice: 0.54 }),
    row({ conditionId: "P3", decisionAt: "2026-08-04T09:02:00.000Z", entryPrice: 0.5799999999 }),
    row({ conditionId: "P4", decisionAt: "2026-08-04T09:03:00.000Z", entryPrice: 0.58 }),
  ];
  const input = toChallengerInput(rows.map((r) => toScorecardRow(r)));
  assert.equal(runChallenger(input, getChallenger("PRICE_050_054").predicate).SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(runChallenger(input, getChallenger("PRICE_054_058").predicate).SELECTED_PHYSICAL_EVENT_N, 2);
  assert.equal(runChallenger(input, getChallenger("PRICE_058_060").predicate).SELECTED_PHYSICAL_EVENT_N, 1);
});

test("soccer + score interaction requires both conditions", () => {
  const rows = [
    row({ conditionId: "SC1", decisionAt: "2026-08-04T09:00:00.000Z", sportFamily: "soccer", scoreLevel: 60, entryPrice: 0.55 }),
    row({ conditionId: "SC2", decisionAt: "2026-08-04T09:01:00.000Z", sportFamily: "tennis", scoreLevel: 60, entryPrice: 0.55 }),
    row({ conditionId: "SC3", decisionAt: "2026-08-04T09:02:00.000Z", sportFamily: "soccer", scoreLevel: 40, entryPrice: 0.55 }),
  ];
  const input = toChallengerInput(rows.map((r) => toScorecardRow(r)));
  const result = runChallenger(input, getChallenger("SOCCER_SCORE_GE60").predicate);
  assert.equal(result.SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(result.selectedBets[0].physicalEventKey, "evt-SC1");
});

test("REF_C0 challenger parity with the existing frozen engine on a fixture", () => {
  const rows = [
    row({ conditionId: "R1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.5, label: "WIN" }),
    row({ conditionId: "R2", decisionAt: "2026-08-04T10:00:00.000Z", entryPrice: 0.65, label: "WIN" }),
    row({ conditionId: "R3", decisionAt: "2026-08-04T11:00:00.000Z", entryPrice: 0.59, label: "LOSS" }),
  ];
  const scorecardRows = rows.map((r) => toScorecardRow(r));
  const expected = evaluateRows(scorecardRows as any) as Record<string, any>;
  const input = toChallengerInput(scorecardRows);
  const c0Predicate = (e: { entryPrice: number }) => e.entryPrice >= 0.5 && e.entryPrice < 0.6;
  const actual = runChallenger(input, c0Predicate);
  assert.equal(actual.SELECTED_PHYSICAL_EVENT_N, expected.C0.SELECTED_PHYSICAL_EVENT_N);
  assert.equal(actual.WINS, expected.C0.WINS);
  assert.equal(actual.LOSSES, expected.C0.LOSSES);
  assert.equal(actual.PNL_U, expected.C0.PNL_U);
  assert.equal(actual.ROI_PCT, expected.C0.ROI_PCT);
  assert.equal(actual.MAX_DRAWDOWN_U, expected.C0.MAX_DRAWDOWN_U);
});

test("reversed partition order is deterministic for weekly challenger results", () => {
  const w1Rows = [
    row({ conditionId: "D1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.55, scoreLevel: 55, label: "WIN" }),
    row({ conditionId: "D2", decisionAt: "2026-08-05T09:00:00.000Z", entryPrice: 0.51, scoreLevel: 61, label: "LOSS" }),
  ];
  const w1Partitions = (): LoadedPartition[] => [part("2026-08-04", [w1Rows[0]]), part("2026-08-05", [w1Rows[1]])];
  const weeks = [{ WEEK_ID: "W1", start: "2026-08-04", end: "2026-08-05", partitions: w1Partitions() }];
  const weeksReversed = [{ WEEK_ID: "W1", start: "2026-08-04", end: "2026-08-05", partitions: [...w1Partitions()].reverse() }];

  const predicate = getChallenger("C0_SCORE_GE50").predicate;
  const forward = computeWeeklyForPredicate(weeks, "SEP_PUBLIC_RICH_V1", predicate);
  const reversed = computeWeeklyForPredicate(weeksReversed, "SEP_PUBLIC_RICH_V1", predicate);
  assert.equal(sha256(canonicalJson(forward)), sha256(canonicalJson(reversed)));
  assert.equal(forward.rows[0].event_n, 2);
});

test("weekly REF authority: frozen-engine per-week evaluation differs from a full-range key-membership replay", () => {
  // Same physicalEventKey ("evt-SHARED"), two occurrences: week1's own row fails
  // the C1 price-band predicate (0.65 is outside [0.5, 0.6)); week2's own row
  // qualifies. The full-range frozen engine therefore selects the week2 row.
  const rowA = row({ conditionId: "WA", providerEventId: "evt-SHARED", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.65, sportFamily: "soccer", label: "WIN" });
  const rowB = row({ conditionId: "WB", providerEventId: "evt-SHARED", decisionAt: "2026-08-11T09:00:00.000Z", entryPrice: 0.55, sportFamily: "soccer", label: "LOSS" });

  const fullRangeScorecardRows = [rowA, rowB].map((r) => toScorecardRow(r));
  const expectedFullRange = evaluateRows(fullRangeScorecardRows as any) as Record<string, any>;
  assert.equal(expectedFullRange.C1.SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(expectedFullRange.C1.selectedBets[0].entryPrice, 0.55);

  const weekPartitions = [
    { WEEK_ID: "W1", start: "2026-08-04", end: "2026-08-04", partitions: [part("2026-08-04", [rowA])] },
    { WEEK_ID: "W2", start: "2026-08-11", end: "2026-08-11", partitions: [part("2026-08-11", [rowB])] },
  ];

  // CORRECT (current implementation): authoritative weekly REF independently
  // re-runs the actual frozen engine (evaluateRows) on each week's own rows.
  const weeklyC1 = computeWeeklyForFrozenModel(weekPartitions, "SEP_PUBLIC_RICH_V1", "C1");
  assert.equal(weeklyC1.rows[0].event_n, 0, "week1's own row fails the C1 price-band predicate");
  assert.equal(weeklyC1.rows[1].event_n, 1, "week2's own row satisfies C1");

  // PROVEN DEFECT (now removed): replaying full-range SELECTED KEYS against a
  // week, instead of independently evaluating the frozen predicate on that
  // week's own rows, wrongly selects week1's non-qualifying row too.
  const fullRangeC1Keys = new Set(expectedFullRange.C1.selectedBets.map((b: { physicalEventKey: string }) => b.physicalEventKey));
  const keyMembershipReplay = runChallenger(toChallengerInput([toScorecardRow(rowA)]), (e) => fullRangeC1Keys.has(e.physicalEventKey));
  assert.equal(keyMembershipReplay.SELECTED_PHYSICAL_EVENT_N, 1, "key-membership-only replay incorrectly selects a non-qualifying row");
  assert.notEqual(
    keyMembershipReplay.SELECTED_PHYSICAL_EVENT_N,
    weeklyC1.rows[0].event_n,
    "the old key-membership proxy differs from the authoritative frozen-engine weekly result",
  );
});

// Minimal ScorecardReadyRow-shaped adapter carrying only the fields
// toChallengerInput() actually reads.
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
    frozenLabel: r.label,
    labelAsOf: r.label,
  } as any;
}
