// FORWARD_RICH_CAPTURE_V1 — deterministic builder for the immutable score
// observation persisted on every research-eligible snapshot.
//
// Isolated from the public feed. Pure: no I/O, no wall-clock, no mutation of
// inputs. The strategic/fire-model score is ALREADY COMPUTED upstream; this
// helper only stamps it with exact lineage so repeated GSRS snapshots form a
// derivable score time-series (first/last/delta) without a dedicated poller.

import type { ResearchScoreObservation } from "./types";

export function buildResearchScoreObservation(input: {
  scoreValue: number | null;
  metricFormulaVersion: string | null;
  snapshotAt: string;
  snapshotRunId: string;
  conditionId: string;
  selectedTokenId: string;
  sourceLineage: ResearchScoreObservation["sourceLineage"];
}): ResearchScoreObservation {
  const scoreValue =
    typeof input.scoreValue === "number" && Number.isFinite(input.scoreValue)
      ? input.scoreValue
      : null;
  return {
    scoreValue,
    scoreKind: "FIRE_MODEL_FINAL_SIGNAL_V2",
    metricFormulaVersion: input.metricFormulaVersion ?? null,
    // snapshot_at is both the observation instant and the immutable source
    // creation instant — the GSRS row is the source of record.
    featureObservedAt: input.snapshotAt,
    sourceCreatedAt: input.snapshotAt,
    conditionId: input.conditionId,
    selectedTokenId: input.selectedTokenId,
    snapshotRunId: input.snapshotRunId,
    sourceLineage: input.sourceLineage,
  };
}
