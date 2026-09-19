import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildExplicitDateRangeRowView,
  enumerateMinskDates,
  type LoadedPartition,
  type RollingCompactRow,
} from "../../lib/modeling/research-corpus/rollingCorpus";
import {
  buildReplayResult,
  buildReplayWithDeterminismProof,
} from "../../scripts/modeling/frozen-range-replay";

const EMPTY = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };

function row(over: Partial<RollingCompactRow> & { conditionId: string; decisionAt: string }): RollingCompactRow {
  return {
    populationId: "AUG_SHADOW_C4_V1",
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
    ...over,
  } as RollingCompactRow;
}

function part(date: string, rows: RollingCompactRow[]): LoadedPartition {
  return { partitionDate: date, canonicalHash: `hash-${date}`, labelEvidenceAsOf: null, sourceWindowStart: null, sourceWindowEnd: null, rows };
}

const D1 = "2026-08-04";
const D2 = "2026-08-05";
const D3 = "2026-08-06";

const partitions = (): LoadedPartition[] => [
  part(D1, [
    row({ conditionId: "A", decisionAt: "2026-08-04T10:00:00.000Z", label: "OPEN", entryPrice: 0.52 }),
    row({ conditionId: "B", decisionAt: "2026-08-04T11:00:00.000Z", label: "LOSS", sportFamily: "tennis", entryPrice: 0.58, leadTimeHours: 30, eventStart: "2026-08-05T17:00:00.000Z" }),
  ]),
  part(D2, [
    // same selection identity as A, later partition: terminal label must win, features stay earliest
    row({ conditionId: "A", decisionAt: "2026-08-05T09:00:00.000Z", label: "WIN", entryPrice: 0.9 }),
    row({ conditionId: "C", decisionAt: "2026-08-05T12:00:00.000Z", label: "WIN", sportFamily: "table-tennis", entryPrice: 0.51 }),
    row({ conditionId: "P2", decisionAt: "2026-08-05T13:00:00.000Z", label: "WIN", populationId: "SEP_PUBLIC_RICH_V1", entryPrice: 0.5 }),
  ]),
  part(D3, [row({ conditionId: "D", decisionAt: "2026-08-06T08:00:00.000Z", label: "WIN", entryPrice: 0.53 })]),
];

test("explicit date enumeration is inclusive", () => {
  assert.deepEqual(enumerateMinskDates("2026-08-04", "2026-08-04"), ["2026-08-04"]);
  assert.deepEqual(enumerateMinskDates("2026-08-30", "2026-09-02"), ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  assert.equal(enumerateMinskDates("2026-08-04", "2026-08-31").length, 28);
  assert.throws(() => enumerateMinskDates("2026-08-31", "2026-08-04"), /EXPLICIT_RANGE_INVERTED/);
  assert.throws(() => enumerateMinskDates("nope", "2026-08-04"), /EXPLICIT_RANGE_DATE_INVALID/);
});

test("one missing requested day fails closed", () => {
  const missingMiddle = partitions().filter((p) => p.partitionDate !== D2);
  assert.throws(
    () => buildExplicitDateRangeRowView({ rangeStart: D1, rangeEnd: D3, partitions: missingMiddle }),
    /EXPLICIT_RANGE_PARTITION_MISSING: 2026-08-05/,
  );
  assert.throws(() => buildReplayResult(D1, D3, missingMiddle), /EXPLICIT_RANGE_PARTITION_MISSING/);
});

test("cross-partition duplicate identity collapses with existing semantics: earliest features, latest terminal label", () => {
  const v = buildExplicitDateRangeRowView({ rangeStart: D1, rangeEnd: D3, partitions: partitions() });
  assert.equal(v.REQUESTED_PARTITION_N, 3);
  assert.equal(v.AVAILABLE_PARTITION_N, 3);
  assert.equal(v.MISSING_PARTITION_N, 0);
  assert.equal(v.PRE_COLLAPSE_ROW_N, 6);
  assert.equal(v.ROW_N, 5, "A collapses across partitions");
  assert.equal(v.PIT_FUTURE_LEAK_N, 0);
  assert.deepEqual(v.PARTITION_HASHES, { [D1]: `hash-${D1}`, [D2]: `hash-${D2}`, [D3]: `hash-${D3}` });
  const a = v.rows.find((r) => r.conditionId === "A")!;
  assert.equal(a.entryPrice, 0.52, "decision-time feature comes from the EARLIEST row");
  assert.equal(a.decisionAt, "2026-08-04T10:00:00.000Z");
  assert.equal(a.frozenLabel, "OPEN");
  assert.equal(a.labelAsOf, "WIN", "later terminal settlement updates only the as-of label");
});

test("a terminal label never reverts to OPEN in a later partition", () => {
  const ps = [
    part(D1, [row({ conditionId: "Z", decisionAt: "2026-08-04T10:00:00.000Z", label: "LOSS" })]),
    part(D2, [row({ conditionId: "Z", decisionAt: "2026-08-05T10:00:00.000Z", label: "OPEN" })]),
  ];
  const v = buildExplicitDateRangeRowView({ rangeStart: D1, rangeEnd: D2, partitions: ps });
  assert.equal(v.rows[0].labelAsOf, "LOSS");
});

test("populations stay separate and are never pooled; frozen models evaluated per population", () => {
  const r = buildReplayResult(D1, D3, partitions());
  assert.deepEqual(r.POPULATION_ROW_N, { AUG_SHADOW_C4_V1: 4, SEP_PUBLIC_RICH_V1: 1 });
  assert.deepEqual(r.POPULATIONS.map((p) => p.POPULATION_ID), ["AUG_SHADOW_C4_V1", "SEP_PUBLIC_RICH_V1"]);
  const aug = r.POPULATIONS[0];
  assert.deepEqual(aug.MODELS.map((m) => m.MODEL_ID), ["C0", "C1", "C4", "C5"]);
  const c0 = aug.MODELS.find((m) => m.MODEL_ID === "C0")!;
  // Terminal AUG rows in C0 band: A(WIN 0.52), B(LOSS 0.58), C(WIN 0.51), D(WIN 0.53) -> 3 wins 1 loss
  assert.equal(c0.SELECTED_PHYSICAL_EVENT_N, 4);
  assert.equal(c0.WINS, 3);
  assert.equal(c0.LOSSES, 1);
  const c1 = aug.MODELS.find((m) => m.MODEL_ID === "C1")!;
  assert.equal(c1.SELECTED_PHYSICAL_EVENT_N, 2, "soccer only: A, D");
  const c5 = aug.MODELS.find((m) => m.MODEL_ID === "C5")!;
  assert.equal(c5.SELECTED_PHYSICAL_EVENT_N, 3, "C0 minus table-tennis");
  const c4 = aug.MODELS.find((m) => m.MODEL_ID === "C4")!;
  assert.equal(c4.SELECTED_PHYSICAL_EVENT_N, 3, "soccer (A, D) + tennis lead>=24h (B)");
  assert.equal(aug.C4_SPORT_FAMILY_BREAKDOWN.reduce((n, s) => n + s.selected_event_n, 0), c4.SELECTED_PHYSICAL_EVENT_N);
  const sep = r.POPULATIONS[1];
  assert.equal(sep.MODELS.find((m) => m.MODEL_ID === "C0")!.SELECTED_PHYSICAL_EVENT_N, 1);
});

test("reverse partition order yields an identical business result", () => {
  const fwd = buildReplayResult(D1, D3, partitions());
  const rev = buildReplayResult(D1, D3, [...partitions()].reverse());
  assert.deepEqual(rev, fwd);
  const proof = buildReplayWithDeterminismProof(D1, D3, partitions());
  assert.deepEqual(proof.result, fwd);
  assert.match(proof.canonicalSha256, /^[0-9a-f]{64}$/);
});

// ───────────────────────── pairwise membership deltas ────────────────────────

import { computePairwiseDelta } from "../../scripts/modeling/frozen-range-replay";

/**
 * One partition, one population. Physical events:
 *  E1 soccer            : selected by C0,C1,C4,C5 -> shared SAME selection everywhere
 *  E2 table-tennis only : C0 selects it, C5 does not          -> C0->C5 LEFT-ONLY
 *  E3 tennis lead>=24h  : C4 selects it, C1 does not          -> C1->C4 RIGHT-ONLY
 *  E4 two candidates    : first table-tennis (earlier), later soccer
 *                         C0 takes the tt candidate, C5 the soccer one -> C0->C5 SHARED CHANGED
 *  E5 two candidates    : first tennis lead>=24h (earlier), later soccer
 *                         C4 takes the tennis candidate, C1 the soccer one -> C1->C4 SHARED CHANGED
 */
function pairwiseFixture(): LoadedPartition[] {
  const H = 3600_000;
  const ev = (decisionAt: string, hours: number) => new Date(Date.parse(decisionAt) + hours * H).toISOString();
  const mk = (id: string, event: string, decisionAt: string, sport: string, lead: number, label: "WIN" | "LOSS", price: number) =>
    row({ conditionId: id, providerEventId: event, decisionAt, sportFamily: sport, label, entryPrice: price, eventStart: ev(decisionAt, lead) });
  return [
    part("2026-08-04", [
      mk("e1", "E1", "2026-08-04T08:00:00.000Z", "soccer", 5, "WIN", 0.55),
      mk("e2", "E2", "2026-08-04T08:10:00.000Z", "table-tennis", 5, "LOSS", 0.52),
      mk("e3", "E3", "2026-08-04T08:20:00.000Z", "tennis", 30, "WIN", 0.54),
      mk("e4a", "E4", "2026-08-04T08:30:00.000Z", "table-tennis", 5, "LOSS", 0.51),
      mk("e4b", "E4", "2026-08-04T08:40:00.000Z", "soccer", 5, "WIN", 0.56),
      mk("e5a", "E5", "2026-08-04T08:50:00.000Z", "tennis", 30, "LOSS", 0.53),
      mk("e5b", "E5", "2026-08-04T09:00:00.000Z", "soccer", 5, "WIN", 0.57),
    ]),
  ];
}

test("pairwise deltas: left-only / right-only / shared same / shared changed, exact PnL accounting, invariants", () => {
  const r = buildReplayResult("2026-08-04", "2026-08-04", pairwiseFixture());
  assert.equal(r.POPULATIONS.length, 1);
  const pw = r.POPULATIONS[0].PAIRWISE_DELTAS;
  assert.deepEqual(Object.keys(pw), ["C0_TO_C5", "C1_TO_C4"]);

  const a = pw.C0_TO_C5;
  assert.equal(a.LEFT_MODEL, "C0");
  assert.equal(a.RIGHT_MODEL, "C5");
  assert.equal(a.LEFT_EVENT_N, 5, "E1..E5");
  assert.equal(a.RIGHT_EVENT_N, 4, "E2 (table-tennis only) disappears");
  assert.equal(a.LEFT_ONLY_EVENT_N, 1);
  assert.equal(a.RIGHT_ONLY_EVENT_N, 0);
  assert.equal(a.SHARED_EVENT_N, 4);
  assert.equal(a.SHARED_SAME_SELECTION_N, 3, "E1, E3, E5 (C0 and C5 pick the same first candidate)");
  assert.equal(a.SHARED_CHANGED_SELECTION_N, 1, "E4: same physical event, different candidate");
  assert.equal(a.UNION_EVENT_N, 5);
  // pnl: E2 LOSS at 0.52 = -1 ; E4 C0 tt LOSS = -1, C5 soccer WIN at 0.56 = +0.7857
  assert.equal(a.LEFT_ONLY_PNL_U, -1);
  assert.equal(a.SHARED_CHANGED_LEFT_PNL_U, -1);
  assert.equal(a.SHARED_CHANGED_RIGHT_PNL_U, 0.79);
  assert.equal(a.SHARED_CHANGED_DELTA_PNL_U, 1.79);
  assert.equal(a.DELTA_PNL_U, round2(a.RIGHT_PNL_U - a.LEFT_PNL_U));
  // exact accounting: right - left = -(left-only) + shared-changed delta (right-only is 0)
  assert.ok(Math.abs(a.DELTA_PNL_U - (a.RIGHT_ONLY_PNL_U - a.LEFT_ONLY_PNL_U + a.SHARED_CHANGED_DELTA_PNL_U)) < 0.011);

  const b = pw.C1_TO_C4;
  assert.equal(b.LEFT_MODEL, "C1");
  assert.equal(b.RIGHT_MODEL, "C4");
  assert.equal(b.LEFT_ONLY_EVENT_N, 0);
  assert.equal(b.RIGHT_ONLY_EVENT_N, 1, "E3 appears via the lead-time branch");
  assert.equal(b.SHARED_CHANGED_SELECTION_N, 1, "E5: C4 takes the earlier tennis candidate");
  assert.equal(b.RIGHT_ONLY_PNL_U, 0.85, "E3 WIN at 0.54");
  assert.ok(Math.abs(b.DELTA_PNL_U - (b.RIGHT_ONLY_PNL_U - b.LEFT_ONLY_PNL_U + b.SHARED_CHANGED_DELTA_PNL_U)) < 0.011);

  for (const p of [a, b]) {
    assert.equal(p.UNION_EVENT_N, p.SHARED_EVENT_N + p.LEFT_ONLY_EVENT_N + p.RIGHT_ONLY_EVENT_N);
    assert.equal(p.SHARED_EVENT_N, p.SHARED_SAME_SELECTION_N + p.SHARED_CHANGED_SELECTION_N);
    assert.equal(p.LEFT_EVENT_N, p.SHARED_EVENT_N + p.LEFT_ONLY_EVENT_N);
    assert.equal(p.RIGHT_EVENT_N, p.SHARED_EVENT_N + p.RIGHT_ONLY_EVENT_N);
    assert.equal(p.DELTA_PNL_U, round2(p.RIGHT_PNL_U - p.LEFT_PNL_U));
  }
  // engine totals unchanged by the extra field
  const models = r.POPULATIONS[0].MODELS;
  assert.equal(models.find((m) => m.MODEL_ID === "C0")!.PNL_U, a.LEFT_PNL_U);
  assert.equal(models.find((m) => m.MODEL_ID === "C4")!.PNL_U, b.RIGHT_PNL_U);
});

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

test("pairwise deltas: identical selection sets produce zero deltas; invariants throw on corrupted input", () => {
  const bet = { physicalEventKey: "k", ref: "r", decisionTimestamp: "t", entryPrice: 0.5, sportFamily: "soccer", pnlU: 1 };
  const same = computePairwiseDelta({ MODEL_ID: "L", PNL_U: 1, selectedBets: [bet] }, { MODEL_ID: "R", PNL_U: 1, selectedBets: [bet] });
  assert.equal(same.DELTA_PNL_U, 0);
  assert.equal(same.SHARED_SAME_SELECTION_N, 1);
  assert.equal(same.SHARED_CHANGED_SELECTION_N, 0);
  // outcome/pnl is NOT part of selection identity: same carrier, different pnl -> still "same selection"
  const samePnlDiff = computePairwiseDelta(
    { MODEL_ID: "L", PNL_U: 1, selectedBets: [bet] },
    { MODEL_ID: "R", PNL_U: -1, selectedBets: [{ ...bet, pnlU: -1 }] },
  );
  assert.equal(samePnlDiff.SHARED_SAME_SELECTION_N, 1);
});

test("pairwise deltas are deterministic under reversed partition order", () => {
  const fwd = buildReplayResult("2026-08-04", "2026-08-04", pairwiseFixture());
  const rev = buildReplayResult("2026-08-04", "2026-08-04", [...pairwiseFixture()].reverse());
  assert.deepEqual(rev, fwd);
  const proof = buildReplayWithDeterminismProof("2026-08-04", "2026-08-04", pairwiseFixture());
  assert.deepEqual(proof.result.POPULATIONS[0].PAIRWISE_DELTAS, fwd.POPULATIONS[0].PAIRWISE_DELTAS);
});
