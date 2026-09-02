import { test } from "node:test";
import assert from "node:assert/strict";

import {
  materializeForwardRichResearch,
  type ForwardRichSignalPair,
  type ForwardRichSnapshotObservation,
} from "../../../lib/modeling/forward-rich";

// Run: node --import tsx --test tests/modeling/forward-rich/materializeForwardRichResearch.test.ts

const CUTOFF = "2026-09-01T00:00:00.000Z";
const MAT_AT = "2026-09-03T06:00:00.000Z";

function pair(overrides: Partial<ForwardRichSignalPair> = {}): ForwardRichSignalPair {
  return {
    conditionId: "cond-A",
    selectedTokenId: "tok-A",
    decisionAt: "2026-09-02T12:00:00.000Z",
    sourceCreatedAt: "2026-09-02T12:00:00.000Z",
    entryPriceNum: 0.42,
    volumeUsd: 15000,
    eventStartIso: "2026-09-02T19:00:00.000Z",
    providerEventId: "evt-1",
    marketTypeRaw: "soccer_first_to_score",
    marketFamily: "soccer",
    providerSportCode: "uwcl",
    providerSportFamily: "soccer",
    formulaVersion: "shadow-strategic-sports-v1",
    ...overrides,
  };
}

function obs(
  snapshotAt: string,
  scoreValue: number | null,
  selectedPriceNum: number | null,
  overrides: Partial<ForwardRichSnapshotObservation> = {},
): ForwardRichSnapshotObservation {
  return {
    conditionId: "cond-A",
    selectedTokenId: "tok-A",
    snapshotAt,
    snapshotRunId: `run-${snapshotAt}`,
    scoreValue,
    scoreMetricFormulaVersion: "trusted-initial-formula-1.1",
    selectedPriceNum,
    opposingPriceNum: selectedPriceNum == null ? null : 1 - selectedPriceNum,
    providerEventId: "evt-1",
    gameStartIso: "2026-09-02T19:00:00.000Z",
    dataCoverageNum: 55,
    ...overrides,
  };
}

test("point-in-time: observations after DECISION_AT are excluded from every series", () => {
  const rows = materializeForwardRichResearch({
    signalPairs: [pair()],
    observations: [
      obs("2026-09-02T06:00:00.000Z", 60, 0.4), // pre-decision
      obs("2026-09-02T11:00:00.000Z", 64, 0.44), // pre-decision
      obs("2026-09-02T14:00:00.000Z", 71, 0.5), // POST-decision — must be ignored
    ],
    sinceCutoff: CUTOFF,
    materializedAt: MAT_AT,
  });

  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.totalObservationsSeen, 3);
  assert.equal(r.eligibleObservationsUsed, 2);
  assert.equal(r.score.observationCount, 2);
  assert.equal(r.score.firstEligibleValue, 60);
  assert.equal(r.score.lastEligibleValue, 64);
  assert.equal(r.score.delta, 4);
  assert.equal(r.score.lastEligibleObservedAt, "2026-09-02T11:00:00.000Z");
  assert.equal(r.selectedPrice.delta, 0.04);
  assert.equal(r.eligibleObservationWindowEnd, "2026-09-02T12:00:00.000Z");
});

test("delta is null with fewer than 2 eligible observations", () => {
  const rows = materializeForwardRichResearch({
    signalPairs: [pair()],
    observations: [obs("2026-09-02T06:00:00.000Z", 60, 0.4)],
    sinceCutoff: CUTOFF,
    materializedAt: MAT_AT,
  });
  assert.equal(rows[0].score.observationCount, 1);
  assert.equal(rows[0].score.delta, null);
  assert.equal(rows[0].selectedPrice.delta, null);
});

test("append/cutoff: decisions at or before the cutoff are never materialized", () => {
  const rows = materializeForwardRichResearch({
    signalPairs: [
      pair({ conditionId: "old", selectedTokenId: "old", decisionAt: "2026-08-30T00:00:00.000Z" }),
      pair({ conditionId: "new", selectedTokenId: "new", decisionAt: "2026-09-02T12:00:00.000Z" }),
    ],
    observations: [],
    sinceCutoff: CUTOFF,
    materializedAt: MAT_AT,
  });
  assert.deepEqual(rows.map((r) => r.conditionId), ["new"]);
});

test("volume uses the immutable GSP semantic verbatim, with source lineage", () => {
  const rows = materializeForwardRichResearch({
    signalPairs: [pair({ volumeUsd: 15000, sourceCreatedAt: "2026-09-02T12:00:00.000Z" })],
    observations: [obs("2026-09-02T06:00:00.000Z", 60, 0.4)],
    sinceCutoff: CUTOFF,
    materializedAt: MAT_AT,
  });
  assert.equal(rows[0].volumeUsd, 15000);
  assert.equal(rows[0].volumeSemantic, "generated_signal_pairs.diagnostics.volumeUsd");
  assert.equal(rows[0].volumeSourceCreatedAt, "2026-09-02T12:00:00.000Z");
});

test("classification keys are preserved verbatim for forward hypothesis evaluation", () => {
  const rows = materializeForwardRichResearch({
    signalPairs: [pair()],
    observations: [],
    sinceCutoff: CUTOFF,
    materializedAt: MAT_AT,
  });
  assert.equal(rows[0].marketTypeRaw, "soccer_first_to_score");
  assert.equal(rows[0].providerSportCode, "uwcl");
  assert.equal(rows[0].leadTimeHours, 7);
  assert.equal(rows[0].materializedAt, MAT_AT);
  assert.equal(rows[0].decisionAt, "2026-09-02T12:00:00.000Z");
});

test("deterministic: identical input yields byte-identical output across runs", () => {
  const build = () =>
    materializeForwardRichResearch({
      signalPairs: [
        pair({ conditionId: "b", selectedTokenId: "b", decisionAt: "2026-09-02T13:00:00.000Z" }),
        pair({ conditionId: "a", selectedTokenId: "a", decisionAt: "2026-09-02T12:00:00.000Z" }),
      ],
      observations: [
        obs("2026-09-02T06:00:00.000Z", 60, 0.4, { conditionId: "a", selectedTokenId: "a" }),
        obs("2026-09-02T05:00:00.000Z", 50, 0.3, { conditionId: "a", selectedTokenId: "a" }),
      ],
      sinceCutoff: CUTOFF,
      materializedAt: MAT_AT,
    });
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
  assert.deepEqual(build().map((r) => r.conditionId), ["a", "b"]);
});
