/**
 * FORWARD_RICH_CAPTURE_V1 — deterministic daily research materializer.
 *
 * Pure: no I/O, no wall-clock, no Map/Set iteration-order dependence. Given
 * immutable GSRS observations + immutable generated_signal_pairs decision rows,
 * it emits one forward-only feature row per (condition_id, selected_token_id)
 * decision whose DECISION_AT is strictly after `sinceCutoff`.
 *
 * Guarantees:
 *  - append/cutoff only — identities at/before the cutoff are never emitted;
 *  - point-in-time — only observations with FEATURE_OBSERVED_AT <= DECISION_AT
 *    contribute to score/price series (no post-decision leakage);
 *  - every derived value retains its source observation timestamp;
 *  - volume uses the immutable generated_signal_pairs.diagnostics.volumeUsd
 *    semantic verbatim and is never merged with rolling inventory volume.
 */

import type {
  DerivedSeries,
  ForwardRichResearchRow,
  ForwardRichSnapshotObservation,
  MaterializeForwardRichInput,
} from "./types";

const HOUR_MS = 3_600_000;

function identityKey(conditionId: string, selectedTokenId: string): string {
  return `${conditionId}::${selectedTokenId}`;
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  const r = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(r, -0) ? 0 : r;
}

/** Stable chronological order with a total tiebreak so runs are deterministic. */
function byObservedAt(
  a: ForwardRichSnapshotObservation,
  b: ForwardRichSnapshotObservation,
): number {
  if (a.snapshotAt !== b.snapshotAt) return a.snapshotAt < b.snapshotAt ? -1 : 1;
  const aRun = a.snapshotRunId ?? "";
  const bRun = b.snapshotRunId ?? "";
  if (aRun !== bRun) return aRun < bRun ? -1 : 1;
  return 0;
}

function deriveSeries(
  eligible: ForwardRichSnapshotObservation[],
  pick: (o: ForwardRichSnapshotObservation) => number | null,
): DerivedSeries {
  const points = eligible
    .map((o) => ({ observedAt: o.snapshotAt, value: pick(o) }))
    .filter((p): p is { observedAt: string; value: number } =>
      typeof p.value === "number" && Number.isFinite(p.value),
    );

  if (points.length === 0) {
    return {
      observationCount: 0,
      firstEligibleValue: null,
      firstEligibleObservedAt: null,
      lastEligibleValue: null,
      lastEligibleObservedAt: null,
      delta: null,
    };
  }

  const first = points[0];
  const last = points[points.length - 1];
  return {
    observationCount: points.length,
    firstEligibleValue: first.value,
    firstEligibleObservedAt: first.observedAt,
    lastEligibleValue: last.value,
    lastEligibleObservedAt: last.observedAt,
    delta: points.length >= 2 ? round(last.value - first.value, 6) : null,
  };
}

export function materializeForwardRichResearch(
  input: MaterializeForwardRichInput,
): ForwardRichResearchRow[] {
  const { observations, signalPairs, sinceCutoff, materializedAt } = input;

  // Group immutable observations by identity.
  const observationsByIdentity = new Map<string, ForwardRichSnapshotObservation[]>();
  for (const obs of observations) {
    const key = identityKey(obs.conditionId, obs.selectedTokenId);
    const bucket = observationsByIdentity.get(key);
    if (bucket) bucket.push(obs);
    else observationsByIdentity.set(key, [obs]);
  }

  const rows: ForwardRichResearchRow[] = [];

  for (const pair of signalPairs) {
    // Append/cutoff: forward rows only. Never rewrite accepted history.
    if (!(pair.decisionAt > sinceCutoff)) continue;

    const key = identityKey(pair.conditionId, pair.selectedTokenId);
    const allObs = [...(observationsByIdentity.get(key) ?? [])].sort(byObservedAt);

    // Point-in-time cut: FEATURE_OBSERVED_AT <= DECISION_AT.
    const windowEnd = pair.decisionAt;
    const eligible = allObs.filter((o) => o.snapshotAt <= windowEnd);

    const scoreMetricFormulaVersion =
      eligible.find((o) => o.scoreMetricFormulaVersion)?.scoreMetricFormulaVersion ??
      null;

    const eventStart = pair.eventStartIso ?? eligible.find((o) => o.gameStartIso)?.gameStartIso ?? null;
    const leadTimeHours =
      eventStart != null && Number.isFinite(Date.parse(eventStart))
        ? round((Date.parse(eventStart) - Date.parse(pair.decisionAt)) / HOUR_MS, 4)
        : null;

    const dataCoverage =
      eligible.find((o) => typeof o.dataCoverageNum === "number")?.dataCoverageNum ?? null;

    rows.push({
      conditionId: pair.conditionId,
      selectedTokenId: pair.selectedTokenId,
      providerEventId:
        pair.providerEventId ?? eligible.find((o) => o.providerEventId)?.providerEventId ?? null,

      decisionAt: pair.decisionAt,
      sourceCreatedAt: pair.sourceCreatedAt,
      materializedAt,

      entryPrice: pair.entryPriceNum ?? null,
      eventStart,
      leadTimeHours,
      sport: pair.providerSportCode ?? pair.providerSportFamily ?? null,
      formulaVersion: pair.formulaVersion ?? null,

      scoreMetricFormulaVersion,
      score: deriveSeries(eligible, (o) => o.scoreValue),

      volumeUsd: pair.volumeUsd ?? null,
      volumeSemantic: "generated_signal_pairs.diagnostics.volumeUsd",
      volumeSourceCreatedAt: pair.sourceCreatedAt,

      selectedPrice: deriveSeries(eligible, (o) => o.selectedPriceNum),

      marketTypeRaw: pair.marketTypeRaw ?? null,
      marketFamily: pair.marketFamily ?? null,
      providerSportCode: pair.providerSportCode ?? null,
      providerSportFamily: pair.providerSportFamily ?? null,
      dataCoverage: dataCoverage ?? null,

      eligibleObservationWindowEnd: windowEnd,
      totalObservationsSeen: allObs.length,
      eligibleObservationsUsed: eligible.length,
    });
  }

  // Deterministic output order.
  rows.sort((a, b) => {
    if (a.decisionAt !== b.decisionAt) return a.decisionAt < b.decisionAt ? -1 : 1;
    return identityKey(a.conditionId, a.selectedTokenId) <
      identityKey(b.conditionId, b.selectedTokenId)
      ? -1
      : 1;
  });

  return rows;
}
