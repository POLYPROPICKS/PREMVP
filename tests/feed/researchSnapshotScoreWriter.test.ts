import { test } from "node:test";
import assert from "node:assert/strict";

import { toResearchSnapshotRow } from "../../lib/feed/cacheResearchSnapshots";
import type { ResearchEligibleSignalSnapshot } from "../../lib/feed/types";

// FORWARD_RICH_CAPTURE_V1 — the strategic/fire-model score must survive the
// producer -> snapshot writer boundary as a non-null, lineage-stamped
// observation inside the append-only GSRS diagnostics JSONB.
//
// Run: node --import tsx --test tests/feed/researchSnapshotScoreWriter.test.ts

const SNAP_AT = "2026-09-02T12:00:00.000Z";

function baseSnapshot(
  overrides: Partial<ResearchEligibleSignalSnapshot> = {},
): ResearchEligibleSignalSnapshot {
  return {
    snapshotRunId: "run-1",
    snapshotAt: SNAP_AT,
    expiresAt: "2026-12-01T12:00:00.000Z",
    scope: "RESEARCH_ELIGIBLE_UNIVERSE",
    formulaVersion: "trusted-initial-formula-1.1",
    conditionId: "cond-1",
    selectedTokenId: "tok-1",
    opposingTokenId: "tok-2",
    selectedPriceNum: 0.4,
    selectedEuropeanOddsNum: 2.5,
    productRejectionReasons: [],
    diagnostics: {
      conditionId: "cond-1",
      selectedTokenId: "tok-1",
      rejectionReasons: [],
    } as unknown as ResearchEligibleSignalSnapshot["diagnostics"],
    publicFeedExposed: false,
    ...overrides,
  };
}

test("builder-supplied scoreObservation is persisted verbatim into diagnostics", () => {
  const row = toResearchSnapshotRow(
    baseSnapshot({
      scoreObservation: {
        scoreValue: 71.4,
        scoreKind: "FIRE_MODEL_FINAL_SIGNAL_V2",
        metricFormulaVersion: "trusted-initial-formula-1.1",
        featureObservedAt: SNAP_AT,
        sourceCreatedAt: SNAP_AT,
        conditionId: "cond-1",
        selectedTokenId: "tok-1",
        snapshotRunId: "run-1",
        sourceLineage: "PUBLIC_PATH_ENRICHMENT",
      },
    }),
  );
  const obs = (row.diagnostics as Record<string, any>).scoreObservation;
  assert.equal(obs.scoreValue, 71.4);
  assert.equal(obs.metricFormulaVersion, "trusted-initial-formula-1.1");
  assert.equal(obs.featureObservedAt, SNAP_AT);
  assert.equal(obs.sourceCreatedAt, SNAP_AT);
  assert.equal(obs.snapshotRunId, "run-1");
  assert.equal(obs.sourceLineage, "PUBLIC_PATH_ENRICHMENT");
});

test("writer synthesizes scoreObservation from diagnostics.formulaScore when builder omits it", () => {
  const snap = baseSnapshot();
  (snap.diagnostics as Record<string, any>).formulaScore = 66.0;
  const row = toResearchSnapshotRow(snap);
  const obs = (row.diagnostics as Record<string, any>).scoreObservation;
  assert.equal(obs.scoreValue, 66.0);
  assert.equal(obs.conditionId, "cond-1");
  assert.equal(obs.selectedTokenId, "tok-1");
  assert.equal(obs.featureObservedAt, SNAP_AT);
});

test("writer falls back to diagnostics.fireModel.modelCandidate.score", () => {
  const snap = baseSnapshot();
  (snap.diagnostics as Record<string, any>).fireModel = {
    version: "firemodel_capture_v1",
    capturedAt: SNAP_AT,
    formulaVersion: "trusted-initial-formula-1.1",
    modelCandidate: { score: 63.2 },
  };
  const row = toResearchSnapshotRow(snap);
  const obs = (row.diagnostics as Record<string, any>).scoreObservation;
  assert.equal(obs.scoreValue, 63.2);
  assert.equal(obs.metricFormulaVersion, "trusted-initial-formula-1.1");
});

test("unscored path yields an explicit null score with lineage, never an absent field", () => {
  const row = toResearchSnapshotRow(baseSnapshot());
  const obs = (row.diagnostics as Record<string, any>).scoreObservation;
  assert.equal(obs.scoreValue, null);
  assert.equal(obs.sourceLineage, "S2_DIRECT_UNSCORED");
  assert.equal(obs.scoreKind, "FIRE_MODEL_FINAL_SIGNAL_V2");
});

test("repeated snapshots of the same identity remain independent immutable rows", () => {
  const a = toResearchSnapshotRow(
    baseSnapshot({ snapshotRunId: "run-1", snapshotAt: "2026-09-02T12:00:00.000Z" }),
  );
  const b = toResearchSnapshotRow(
    baseSnapshot({ snapshotRunId: "run-2", snapshotAt: "2026-09-02T12:30:00.000Z" }),
  );
  assert.notEqual(a.snapshot_run_id, b.snapshot_run_id);
  assert.notEqual(a.snapshot_at, b.snapshot_at);
  assert.equal(a.condition_id, b.condition_id);
  assert.equal(a.selected_token_id, b.selected_token_id);
});
